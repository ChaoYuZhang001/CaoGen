import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import type {
  ProviderAuthorizationPollResult, ProviderAuthorizationQuotaView, ProviderAuthorizationService,
  ProviderDeviceAuthorizationView, ProviderQuickAuthorizationPollResult, ProviderQuickDeviceAuthorizationView
} from '../../shared/provider-authorization-types'
import type { Provider, ProviderView } from '../../shared/types'
import {
  createProvider,
  deleteProvider,
  getProvider,
  issueDirectProviderCredentialLease,
  toView,
  updateProvider
} from '../providers'
import type { ProviderCredentialLeaseScope } from '../providerCredentialBroker'
import {
  CodexOAuthError,
  codexOAuthIdentity,
  fetchCodexOAuthModels,
  fetchCodexOAuthQuota,
  pollCodexDeviceAuthorization,
  refreshCodexOAuthTokens,
  startCodexDeviceAuthorization,
  type CodexOAuthTokens
} from './codexOAuthClient'
import {
  COPILOT_API_VERSION,
  COPILOT_EDITOR_VERSION,
  COPILOT_INTEGRATION_ID,
  COPILOT_PLUGIN_VERSION,
  COPILOT_USER_AGENT,
  fetchGitHubCopilotModels,
  fetchGitHubCopilotQuota,
  GITHUB_COPILOT_API_BASE,
  GitHubCopilotOAuthError,
  pollGitHubCopilotDeviceAuthorization,
  refreshGitHubCopilotToken,
  startGitHubCopilotDeviceAuthorization,
  type GitHubCopilotTokens
} from './githubCopilotOAuthClient'
import {
  fetchXaiOAuthModels,
  fetchXaiOAuthQuota,
  pollXaiDeviceAuthorization,
  refreshXaiOAuthTokens,
  startXaiDeviceAuthorization,
  XAI_API_BASE,
  XaiOAuthError,
  type XaiOAuthTokens
} from './xaiOAuthClient'
import {
  listProviderAuthorizationAccountsFromStore,
  removeAllProviderAuthorizationAccounts,
  removeProviderAuthorizationAccount,
  resolveProviderAuthorizationRefreshToken,
  storeProviderAuthorizationAccount
} from './providerAuthorizationStore'
import {
  markProviderAuthorizationAccountFailure,
  markProviderAuthorizationError,
  recordProviderAuthorizationQuota,
  removeProviderAuthorizationRoutingState,
  resolveProviderAuthorizationAccountSelection
} from './providerAuthorizationAccountService'
import type { ProviderAuthorizationRoutingDecision } from './providerAuthorizationRouting'
import { providerAuthorizationAccountFetch, providerCredentialFetch } from './providerAuthorizationCredentialFetch'

const CODEX_RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
const CODEX_MODEL_FALLBACK = 'gpt-5.4'
const COPILOT_MODEL_FALLBACK = 'gpt-4.1'
const XAI_MODEL_FALLBACK = 'grok-4'
const REFRESH_BUFFER_MS = 60_000

interface PendingAuthorization {
  flowId: string
  mode: 'provider' | 'quick-setup'
  service: ProviderAuthorizationService
  providerId?: string
  deviceAuthId: string
  userCode: string
  verificationUri: string
  expiresAt: number
  intervalSeconds: number
  nextPollAt: number
  tokenEndpoint?: string
}

type AuthorizationTokens =
  | { service: 'codex-oauth'; tokens: CodexOAuthTokens }
  | { service: 'github-copilot'; tokens: GitHubCopilotTokens }
  | { service: 'xai-oauth'; tokens: XaiOAuthTokens }

const pending = new Map<string, PendingAuthorization>()
const refreshes = new Map<string, Promise<ProviderView>>()
const runtimeAccountTokens = new Map<string, AuthorizationTokens>()

export interface ProviderAuthorizationAccountLease {
  accountId: string
  keyId: string
  keyLabel: string
  credentialProvider: Pick<Provider, 'authMode' | 'baseUrl' | 'credentialMigrationRequired' | 'customHeaders' | 'credentialHeaderNames'>
  lease: NonNullable<ReturnType<typeof issueDirectProviderCredentialLease>['lease']>
}

export async function startProviderAuthorization(
  providerId: string,
  serviceOrFetch: ProviderAuthorizationService | typeof fetch = 'codex-oauth',
  fetchOrNow: typeof fetch | number = fetch,
  requestedNow = Date.now()
): Promise<ProviderDeviceAuthorizationView> {
  const { service, fetchImpl, now } = authorizationStartArguments(serviceOrFetch, fetchOrNow, requestedNow)
  const provider = requireOpenAiProvider(providerId, service)
  prunePending(now)
  for (const [flowId, flow] of pending) {
    if (flow.providerId === providerId) pending.delete(flowId)
  }
  const flow = await createPendingFlow('provider', service, fetchImpl, now, providerId)
  pending.set(flow.flowId, flow)
  updateProvider(providerId, {
    authorization: {
      schemaVersion: 1,
      method: 'device-code',
      status: 'unconfigured',
      provider: service,
      accountRoutingMode: provider.authorization?.accountRoutingMode ?? 'preferred'
    }
  })
  return publicFlow(flow)
}

export async function pollProviderAuthorization(
  providerId: string,
  flowId: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now()
): Promise<ProviderAuthorizationPollResult> {
  const flow = pending.get(flowId)
  if (!flow || flow.mode !== 'provider' || flow.providerId !== providerId) {
    throw new Error('Provider authorization flow was not found')
  }
  if (now >= flow.expiresAt) {
    pending.delete(flowId)
    markProviderAuthorizationError(providerId, flow.service, 'expired', 'device_code_expired')
    throw new Error('Provider authorization flow expired')
  }
  if (now < flow.nextPollAt) return { status: 'pending', nextPollAt: flow.nextPollAt }
  flow.nextPollAt = now + flow.intervalSeconds * 1000
  try {
    const tokens = await pollAuthorization(flow, fetchImpl, now)
    pending.delete(flowId)
    return completeAuthorization(providerId, tokens, fetchImpl, now)
  } catch (error) {
    if (authorizationErrorCode(error) === 'authorization_pending') {
      return { status: 'pending', nextPollAt: flow.nextPollAt }
    }
    pending.delete(flowId)
    markProviderAuthorizationError(
      providerId,
      flow.service,
      authorizationErrorCode(error) === 'expired' ? 'expired' : 'error',
      authorizationErrorCode(error) ?? 'authorization_failed'
    )
    throw error
  }
}

export async function startQuickProviderAuthorization(
  serviceOrFetch: ProviderAuthorizationService | typeof fetch = 'codex-oauth',
  fetchOrNow: typeof fetch | number = fetch,
  requestedNow = Date.now()
): Promise<ProviderQuickDeviceAuthorizationView> {
  const { service, fetchImpl, now } = authorizationStartArguments(serviceOrFetch, fetchOrNow, requestedNow)
  prunePending(now)
  for (const [flowId, flow] of pending) {
    if (flow.mode === 'quick-setup' && flow.service === service) pending.delete(flowId)
  }
  const flow = await createPendingFlow('quick-setup', service, fetchImpl, now)
  pending.set(flow.flowId, flow)
  return publicQuickFlow(flow)
}

export async function pollQuickProviderAuthorization(
  flowId: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now()
): Promise<ProviderQuickAuthorizationPollResult> {
  const flow = pending.get(flowId)
  if (!flow || flow.mode !== 'quick-setup') throw new Error('Quick Provider authorization flow was not found')
  if (now >= flow.expiresAt) {
    pending.delete(flowId)
    throw new Error('Quick Provider authorization flow expired')
  }
  if (now < flow.nextPollAt) return { status: 'pending', nextPollAt: flow.nextPollAt }
  flow.nextPollAt = now + flow.intervalSeconds * 1000
  let tokens: AuthorizationTokens
  try {
    tokens = await pollAuthorization(flow, fetchImpl, now)
  } catch (error) {
    if (authorizationErrorCode(error) === 'authorization_pending') {
      return { status: 'pending', nextPollAt: flow.nextPollAt }
    }
    pending.delete(flowId)
    throw error
  }
  pending.delete(flowId)
  let created: ProviderView | undefined
  try {
    created = createProvider(quickProviderInput(flow.service))
    return await completeAuthorization(created.id, tokens, fetchImpl, now)
  } catch (error) {
    if (created) {
      removeAllProviderAuthorizationAccounts(created.id)
      deleteProvider(created.id)
    }
    throw error
  }
}

export async function bindProviderAuthorizationAccount(
  providerId: string,
  accountId: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now()
): Promise<ProviderView> {
  const provider = requireOpenAiProvider(providerId)
  const service = requireAuthorizationService(provider)
  const tokens = await refreshAccountTokens(providerId, accountId, service, fetchImpl, now)
  return configureProvider(providerId, accountId, accountLabel(providerId, accountId, service), tokens, fetchImpl, now)
}

export function refreshProviderAuthorization(
  providerId: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now()
): Promise<ProviderView> {
  const existing = refreshes.get(providerId)
  if (existing) return existing
  const task = refreshBoundProvider(providerId, fetchImpl, now).finally(() => refreshes.delete(providerId))
  refreshes.set(providerId, task)
  return task
}

export async function ensureProviderAuthorizationFresh(
  providerId: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now()
): Promise<ProviderView | undefined> {
  const provider = getProvider(providerId)
  if (!provider?.authorization?.provider || provider.authorization.status !== 'authorized') {
    return provider ? toView(provider) : undefined
  }
  if ((provider.authorization.expiresAt ?? 0) - now > REFRESH_BUFFER_MS) return toView(provider)
  return refreshProviderAuthorization(providerId, fetchImpl, now)
}

/**
 * Select an OAuth account for one runtime request without mutating the Provider's
 * persisted active account or serializing an access token into configuration.
 */
export async function issueProviderAuthorizationAccountLease(
  provider: Provider,
  accountId: string,
  scope: ProviderCredentialLeaseScope,
  fetchImpl: typeof fetch = fetch,
  now = Date.now()
): Promise<ProviderAuthorizationAccountLease> {
  const service = requireAuthorizationService(provider)
  const normalizedAccountId = accountId.trim()
  if (!normalizedAccountId) throw new Error('Provider authorization account was not found')
  const credentials = await runtimeAccountCredentials(provider.id, normalizedAccountId, service, fetchImpl, now)
  const token = runtimeAccessToken(credentials)
  const keyId = runtimeAccountKeyId(provider.id, service, normalizedAccountId)
  const selection = issueDirectProviderCredentialLease(provider.id, keyId, token, scope)
  if (!selection.lease) throw new Error('Provider authorization credential lease is unavailable')
  return {
    accountId: normalizedAccountId,
    keyId,
    keyLabel: 'OAuth app binding',
    credentialProvider: {
      authMode: 'api-key',
      baseUrl: provider.baseUrl,
      credentialMigrationRequired: false,
      customHeaders: runtimeAuthorizationHeaders(provider, service, normalizedAccountId),
      credentialHeaderNames: ['authorization']
    },
    lease: selection.lease
  }
}

export function recordProviderAuthorizationAccountFailure(
  providerId: string,
  accountId: string,
  failedAt = Date.now()
): ProviderAuthorizationRoutingDecision {
  const provider = requireOpenAiProvider(providerId)
  const service = requireAuthorizationService(provider)
  const decision = markProviderAuthorizationAccountFailure(provider, accountId, failedAt)
  clearRuntimeAccountToken(providerId, accountId, service)
  return decision
}

export function revokeProviderAuthorization(providerId: string, accountId?: string): ProviderView {
  const provider = requireOpenAiProvider(providerId)
  const service = requireAuthorizationService(provider)
  const targetId = accountId?.trim() || provider.authorization?.accountId
  if (!targetId) throw new Error('Provider authorization account was not found')
  clearRuntimeAccountToken(providerId, targetId, service)
  removeProviderAuthorizationAccount(providerId, targetId, service)
  const bound = provider.authorization?.accountId === targetId
  if (!bound) return toView(provider)
  const removeKeyIds = provider.activeKeyId ? [provider.activeKeyId] : []
  return updateProvider(providerId, {
    removeKeyIds,
    authorization: {
      schemaVersion: 1,
      method: 'device-code',
      status: 'revoked',
      provider: service,
      accountId: targetId,
      accountLabel: provider.authorization?.accountLabel,
      accountRoutingMode: provider.authorization?.accountRoutingMode ?? 'preferred'
    }
  })
}

export async function queryProviderAuthorizationQuota(
  providerId: string,
  accountOrFetch: string | typeof fetch = fetch,
  fetchOrNow: typeof fetch | number = fetch,
  requestedNow = Date.now()
): Promise<ProviderAuthorizationQuotaView> {
  const provider = requireOpenAiProvider(providerId)
  const service = requireAuthorizationService(provider)
  const accountId = typeof accountOrFetch === 'string'
    ? accountOrFetch.trim()
    : provider.authorization?.accountId
  const fetchImpl = typeof accountOrFetch === 'function'
    ? accountOrFetch
    : typeof fetchOrNow === 'function' ? fetchOrNow : fetch
  const now = typeof accountOrFetch === 'function'
    ? typeof fetchOrNow === 'number' ? fetchOrNow : requestedNow
    : typeof fetchOrNow === 'number' ? fetchOrNow : requestedNow
  if (provider.authorization?.status !== 'authorized' || !accountId) {
    throw new Error('Provider does not have an active authorization')
  }
  let quota: ProviderAuthorizationQuotaView
  if (service === 'github-copilot') {
    const githubToken = resolveProviderAuthorizationRefreshToken(provider.id, accountId, service)
    quota = await fetchGitHubCopilotQuota(provider.id, accountId, githubToken, fetchImpl, now)
  } else {
    const credentialFetch = accountId === provider.authorization?.accountId
      ? providerCredentialFetch(provider, fetchImpl)
      : await accountCredentialFetch(provider, accountId, service, fetchImpl, now)
    quota = service === 'codex-oauth'
      ? await fetchCodexOAuthQuota(provider.id, accountId, credentialFetch, now)
      : await fetchXaiOAuthQuota(provider.id, accountId, 'lease-managed', credentialFetch, now)
  }
  recordProviderAuthorizationQuota(quota, service)
  if (quota.status === 'expired') {
    const next = markProviderAuthorizationAccountFailure(provider, accountId, now)
    if (provider.authorization?.accountId === accountId
      && !next.account) {
      markProviderAuthorizationError(provider.id, service, 'expired', 'quota_authorization_expired')
    }
  }
  return quota
}

export function removeProviderAuthorizations(providerId: string): void {
  for (const [flowId, flow] of pending) {
    if (flow.providerId === providerId) pending.delete(flowId)
  }
  removeAllProviderAuthorizationAccounts(providerId)
  for (const key of runtimeAccountTokens.keys()) {
    if (key.startsWith(`${providerId}:`)) runtimeAccountTokens.delete(key)
  }
  removeProviderAuthorizationRoutingState(providerId)
}

async function createPendingFlow(
  mode: PendingAuthorization['mode'],
  service: ProviderAuthorizationService,
  fetchImpl: typeof fetch,
  now: number,
  providerId?: string
): Promise<PendingAuthorization> {
  const started = service === 'codex-oauth'
    ? await startCodexDeviceAuthorization(fetchImpl)
    : service === 'github-copilot'
      ? await startGitHubCopilotDeviceAuthorization(fetchImpl)
      : await startXaiDeviceAuthorization(fetchImpl)
  return {
    flowId: randomUUID(),
    mode,
    service,
    providerId,
    deviceAuthId: started.deviceAuthId,
    userCode: started.userCode,
    verificationUri: 'verificationUri' in started
      ? started.verificationUri
      : 'https://auth.openai.com/codex/device',
    expiresAt: now + started.expiresInSeconds * 1000,
    intervalSeconds: started.intervalSeconds,
    nextPollAt: now,
    ...('tokenEndpoint' in started && typeof started.tokenEndpoint === 'string'
      ? { tokenEndpoint: started.tokenEndpoint }
      : {})
  }
}

async function pollAuthorization(
  flow: PendingAuthorization,
  fetchImpl: typeof fetch,
  now: number
): Promise<AuthorizationTokens> {
  if (flow.service === 'codex-oauth') {
    return {
      service: flow.service,
      tokens: await pollCodexDeviceAuthorization(flow.deviceAuthId, flow.userCode, fetchImpl, now)
    }
  }
  if (flow.service === 'github-copilot') {
    return {
      service: flow.service,
      tokens: await pollGitHubCopilotDeviceAuthorization(flow.deviceAuthId, fetchImpl, now)
    }
  }
  if (!flow.tokenEndpoint) throw new Error('xAI authorization flow was invalid')
  return {
    service: flow.service,
    tokens: await pollXaiDeviceAuthorization(flow.deviceAuthId, flow.tokenEndpoint, fetchImpl, now)
  }
}

async function completeAuthorization(
  providerId: string,
  credentials: AuthorizationTokens,
  fetchImpl: typeof fetch,
  now: number
): Promise<Extract<ProviderAuthorizationPollResult, { status: 'authorized' }>> {
  const identity = authorizationIdentity(credentials)
  storeProviderAuthorizationAccount({
    id: identity.accountId,
    providerId,
    service: credentials.service,
    label: identity.label,
    refreshToken: authorizationStoredCredential(credentials),
    authenticatedAt: now
  })
  const provider = await configureProvider(
    providerId,
    identity.accountId,
    identity.label,
    credentials,
    fetchImpl,
    now
  )
  const account = listProviderAuthorizationAccountsFromStore(
    providerId,
    identity.accountId,
    credentials.service
  ).find((item) => item.id === identity.accountId)
  if (!account) throw new Error('Provider authorization account could not be loaded')
  return { status: 'authorized', account, provider }
}

async function refreshBoundProvider(
  providerId: string,
  fetchImpl: typeof fetch,
  now: number
): Promise<ProviderView> {
  const provider = requireOpenAiProvider(providerId)
  const service = requireAuthorizationService(provider)
  const accountId = provider.authorization?.accountId
  if (!accountId) throw new Error('Provider is not bound to an authorization account')
  try {
    const tokens = await refreshAccountTokens(providerId, accountId, service, fetchImpl, now)
    return configureProvider(
      providerId,
      accountId,
      provider.authorization?.accountLabel ?? accountLabel(providerId, accountId, service),
      tokens,
      fetchImpl,
      now
    )
  } catch (error) {
    markProviderAuthorizationError(
      providerId,
      service,
      authorizationErrorCode(error) === 'refresh_rejected' ? 'expired' : 'error',
      authorizationErrorCode(error) ?? 'refresh_failed'
    )
    throw error
  }
}

async function refreshAccountTokens(
  providerId: string,
  accountId: string,
  service: ProviderAuthorizationService,
  fetchImpl: typeof fetch,
  now: number
): Promise<AuthorizationTokens> {
  const stored = resolveProviderAuthorizationRefreshToken(providerId, accountId, service)
  let credentials: AuthorizationTokens
  if (service === 'codex-oauth') {
    credentials = { service, tokens: await refreshCodexOAuthTokens(stored, fetchImpl, now) }
  } else if (service === 'github-copilot') {
    credentials = { service, tokens: await refreshGitHubCopilotToken(stored, accountId, fetchImpl, now) }
  } else {
    credentials = { service, tokens: await refreshXaiOAuthTokens(stored, fetchImpl, now) }
  }
  storeProviderAuthorizationAccount({
    id: accountId,
    providerId,
    service,
    label: accountLabel(providerId, accountId, service),
    refreshToken: authorizationStoredCredential(credentials),
    authenticatedAt: authorizationAuthenticatedAt(providerId, accountId, service) ?? now
  })
  return credentials
}

async function runtimeAccountCredentials(
  providerId: string,
  accountId: string,
  service: ProviderAuthorizationService,
  fetchImpl: typeof fetch,
  now: number
): Promise<AuthorizationTokens> {
  const cacheKey = `${providerId}:${service}:${accountId}`
  const cached = runtimeAccountTokens.get(cacheKey)
  if (cached && authorizationExpiresAt(cached) - now > REFRESH_BUFFER_MS) return cached
  const credentials = await refreshAccountTokens(providerId, accountId, service, fetchImpl, now)
  runtimeAccountTokens.set(cacheKey, credentials)
  return credentials
}

function runtimeAccessToken(credentials: AuthorizationTokens): string {
  return credentials.tokens.accessToken
}

function authorizationExpiresAt(credentials: AuthorizationTokens): number {
  return credentials.tokens.expiresAt
}

function runtimeAccountKeyId(
  providerId: string,
  service: ProviderAuthorizationService,
  accountId: string
): string {
  const digest = createHash('sha256').update(`${providerId}:${service}:${accountId}`).digest('hex')
  return `oauth-app-binding:${service}:${digest}`
}

function clearRuntimeAccountToken(
  providerId: string,
  accountId: string,
  service: ProviderAuthorizationService
): void {
  runtimeAccountTokens.delete(`${providerId}:${service}:${accountId}`)
}

function runtimeAuthorizationHeaders(
  provider: Provider,
  service: ProviderAuthorizationService,
  accountId: string
): string {
  if (service === 'codex-oauth') {
    return [
      stripManagedHeaders(provider.customHeaders, ['chatgpt-account-id', 'originator', 'version']),
      `chatgpt-account-id: ${accountId}`,
      'originator: codex_cli_rs',
      `version: ${safeAppVersion()}`
    ].filter(Boolean).join('\n')
  }
  if (service === 'github-copilot') {
    return [
      stripManagedHeaders(provider.customHeaders, [
        'copilot-integration-id', 'editor-version', 'editor-plugin-version', 'user-agent', 'x-github-api-version'
      ]),
      `copilot-integration-id: ${COPILOT_INTEGRATION_ID}`,
      `editor-version: ${COPILOT_EDITOR_VERSION}`,
      `editor-plugin-version: ${COPILOT_PLUGIN_VERSION}`,
      `user-agent: ${COPILOT_USER_AGENT}`,
      `x-github-api-version: ${COPILOT_API_VERSION}`
    ].filter(Boolean).join('\n')
  }
  return provider.customHeaders ?? ''
}

async function configureProvider(
  providerId: string,
  accountId: string,
  label: string,
  credentials: AuthorizationTokens,
  fetchImpl: typeof fetch,
  now: number
): Promise<ProviderView> {
  if (credentials.service === 'codex-oauth') {
    return configureProviderForCodex(providerId, accountId, label, credentials.tokens, fetchImpl, now)
  }
  if (credentials.service === 'github-copilot') {
    return configureProviderForCopilot(providerId, accountId, label, credentials.tokens, fetchImpl, now)
  }
  return configureProviderForXai(providerId, accountId, label, credentials.tokens, fetchImpl, now)
}

async function configureProviderForCodex(
  providerId: string,
  accountId: string,
  label: string,
  tokens: CodexOAuthTokens,
  fetchImpl: typeof fetch,
  now: number
): Promise<ProviderView> {
  const previous = requireOpenAiProvider(providerId, 'codex-oauth')
  const models = await fetchCodexOAuthModels(tokens.accessToken, accountId, fetchImpl).catch(() => [])
  const customHeaders = [
    stripManagedHeaders(previous.customHeaders, ['chatgpt-account-id', 'originator', 'version']),
    `chatgpt-account-id: ${accountId}`,
    'originator: codex_cli_rs',
    `version: ${safeAppVersion()}`
  ].filter(Boolean).join('\n')
  return updateAuthorizedProvider(previous, {
    service: 'codex-oauth',
    baseUrl: CODEX_RESPONSES_ENDPOINT,
    protocol: 'responses',
    token: tokens.accessToken,
    tokenLabel: `ChatGPT OAuth - ${label}`,
    expiresAt: tokens.expiresAt,
    models,
    customHeaders,
    accountId,
    label,
    now
  })
}

async function configureProviderForCopilot(
  providerId: string,
  accountId: string,
  label: string,
  tokens: GitHubCopilotTokens,
  fetchImpl: typeof fetch,
  now: number
): Promise<ProviderView> {
  const previous = requireOpenAiProvider(providerId, 'github-copilot')
  const models = await fetchGitHubCopilotModels(tokens.accessToken, tokens.apiBaseUrl, fetchImpl).catch(() => [])
  const customHeaders = [
    stripManagedHeaders(previous.customHeaders, [
      'copilot-integration-id', 'editor-version', 'editor-plugin-version', 'user-agent', 'x-github-api-version'
    ]),
    `copilot-integration-id: ${COPILOT_INTEGRATION_ID}`,
    `editor-version: ${COPILOT_EDITOR_VERSION}`,
    `editor-plugin-version: ${COPILOT_PLUGIN_VERSION}`,
    `user-agent: ${COPILOT_USER_AGENT}`,
    `x-github-api-version: ${COPILOT_API_VERSION}`
  ].filter(Boolean).join('\n')
  return updateAuthorizedProvider(previous, {
    service: 'github-copilot',
    baseUrl: tokens.apiBaseUrl || GITHUB_COPILOT_API_BASE,
    protocol: 'chat',
    token: tokens.accessToken,
    tokenLabel: `GitHub Copilot - ${label}`,
    expiresAt: tokens.expiresAt,
    models,
    customHeaders,
    accountId,
    label,
    now
  })
}

async function configureProviderForXai(
  providerId: string,
  accountId: string,
  label: string,
  tokens: XaiOAuthTokens,
  fetchImpl: typeof fetch,
  now: number
): Promise<ProviderView> {
  const previous = requireOpenAiProvider(providerId, 'xai-oauth')
  const models = await fetchXaiOAuthModels(tokens.accessToken, fetchImpl).catch(() => [])
  return updateAuthorizedProvider(previous, {
    service: 'xai-oauth',
    baseUrl: XAI_API_BASE,
    protocol: 'chat',
    token: tokens.accessToken,
    tokenLabel: `xAI OAuth - ${label}`,
    expiresAt: tokens.expiresAt,
    models,
    customHeaders: previous.customHeaders,
    accountId,
    label,
    now
  })
}

function updateAuthorizedProvider(
  previous: Provider,
  input: {
    service: ProviderAuthorizationService
    baseUrl: string
    protocol: 'responses' | 'chat'
    token: string
    tokenLabel: string
    expiresAt: number
    models: string[]
    customHeaders?: string
    accountId: string
    label: string
    now: number
  }
): ProviderView {
  return updateProvider(previous.id, {
    baseUrl: input.baseUrl,
    engine: 'openai',
    openaiProtocol: input.protocol,
    credentialHeaderNames: ['authorization'],
    customHeaders: input.customHeaders,
    token: input.token,
    tokenLabel: input.tokenLabel,
    removeKeyIds: (previous.apiKeys ?? []).map((key) => key.id).filter((keyId) => keyId !== previous.activeKeyId),
    ...(input.models.length > 0 ? { models: input.models } : {}),
    authorization: {
      schemaVersion: 1,
      method: 'device-code',
      status: 'authorized',
      provider: input.service,
      accountId: input.accountId,
      accountLabel: input.label,
      expiresAt: input.expiresAt,
      lastAuthenticatedAt: input.now,
      accountRoutingMode: previous.authorization?.accountRoutingMode ?? 'preferred'
    }
  })
}

async function accountCredentialFetch(
  provider: Provider,
  accountId: string,
  service: ProviderAuthorizationService,
  fetchImpl: typeof fetch,
  now: number
): Promise<typeof fetch> {
  const credentials = await runtimeAccountCredentials(provider.id, accountId, service, fetchImpl, now)
  return providerAuthorizationAccountFetch(
    provider,
    accountId,
    runtimeAccountKeyId(provider.id, service, accountId),
    runtimeAccessToken(credentials),
    runtimeAuthorizationHeaders(provider, service, accountId),
    fetchImpl
  )
}

function requireOpenAiProvider(providerId: string, service?: ProviderAuthorizationService): Provider {
  const id = providerId.trim()
  const provider = id ? getProvider(id) : undefined
  if (!provider) throw new Error('Provider was not found')
  if (provider.engine !== 'openai') throw new Error(`${serviceLabel(service)} authorization requires an OpenAI-compatible Provider`)
  return provider
}

function requireAuthorizationService(provider: Provider): ProviderAuthorizationService {
  const service = provider.authorization?.provider
  if (!service) throw new Error('Provider authorization service is not configured')
  return service
}

function authorizationIdentity(credentials: AuthorizationTokens): { accountId: string; label: string } {
  if (credentials.service === 'codex-oauth') return codexOAuthIdentity(credentials.tokens)
  return { accountId: credentials.tokens.accountId, label: credentials.tokens.label }
}

function authorizationStoredCredential(credentials: AuthorizationTokens): string {
  return credentials.service === 'github-copilot'
    ? credentials.tokens.githubToken
    : credentials.tokens.refreshToken
}

function authorizationErrorCode(error: unknown): string | undefined {
  return error instanceof CodexOAuthError || error instanceof GitHubCopilotOAuthError || error instanceof XaiOAuthError
    ? error.code
    : undefined
}

function accountLabel(providerId: string, accountId: string, service: ProviderAuthorizationService): string {
  return listProviderAuthorizationAccountsFromStore(providerId, accountId, service)
    .find((account) => account.id === accountId)?.label ?? `${serviceLabel(service)} (${accountId.slice(0, 12)})`
}

function authorizationAuthenticatedAt(
  providerId: string,
  accountId: string,
  service: ProviderAuthorizationService
): number | undefined {
  return listProviderAuthorizationAccountsFromStore(providerId, accountId, service)
    .find((account) => account.id === accountId)?.authenticatedAt
}

function stripManagedHeaders(value: string | undefined, names: string[]): string {
  const managed = new Set(names.map((name) => name.toLowerCase()))
  return (value ?? '').split(/\r?\n/)
    .filter((line) => !managed.has(line.split(':', 1)[0]?.trim().toLowerCase()))
    .join('\n')
    .trim()
}

function quickProviderInput(service: ProviderAuthorizationService): Parameters<typeof createProvider>[0] {
  const config = service === 'codex-oauth'
    ? { name: 'ChatGPT Codex', baseUrl: CODEX_RESPONSES_ENDPOINT, models: [CODEX_MODEL_FALLBACK], protocol: 'responses' as const }
    : service === 'github-copilot'
      ? { name: 'GitHub Copilot', baseUrl: GITHUB_COPILOT_API_BASE, models: [COPILOT_MODEL_FALLBACK], protocol: 'chat' as const }
      : { name: 'xAI OAuth', baseUrl: XAI_API_BASE, models: [XAI_MODEL_FALLBACK], protocol: 'chat' as const }
  return {
    name: config.name,
    baseUrl: config.baseUrl,
    models: config.models,
    authMode: 'api-key',
    engine: 'openai',
    openaiProtocol: config.protocol,
    credentialHeaderNames: ['authorization'],
    authorization: {
      schemaVersion: 1,
      method: 'device-code',
      status: 'unconfigured',
      provider: service,
      accountRoutingMode: 'preferred'
    }
  }
}

function publicFlow(flow: PendingAuthorization): ProviderDeviceAuthorizationView {
  if (!flow.providerId) throw new Error('Provider authorization flow was invalid')
  return {
    flowId: flow.flowId,
    providerId: flow.providerId,
    service: flow.service,
    userCode: flow.userCode,
    verificationUri: flow.verificationUri,
    expiresAt: flow.expiresAt,
    intervalSeconds: flow.intervalSeconds
  }
}

function publicQuickFlow(flow: PendingAuthorization): ProviderQuickDeviceAuthorizationView {
  return {
    flowId: flow.flowId,
    service: flow.service,
    userCode: flow.userCode,
    verificationUri: flow.verificationUri,
    expiresAt: flow.expiresAt,
    intervalSeconds: flow.intervalSeconds
  }
}

function prunePending(now: number): void {
  for (const [flowId, flow] of pending) {
    if (now >= flow.expiresAt) pending.delete(flowId)
  }
}

function serviceLabel(service: ProviderAuthorizationService | undefined): string {
  if (service === 'github-copilot') return 'GitHub Copilot'
  if (service === 'xai-oauth') return 'xAI'
  return 'Codex OAuth'
}

function authorizationStartArguments(
  serviceOrFetch: ProviderAuthorizationService | typeof fetch,
  fetchOrNow: typeof fetch | number,
  requestedNow: number
): { service: ProviderAuthorizationService; fetchImpl: typeof fetch; now: number } {
  if (typeof serviceOrFetch === 'function') {
    return {
      service: 'codex-oauth',
      fetchImpl: serviceOrFetch,
      now: typeof fetchOrNow === 'number' ? fetchOrNow : requestedNow
    }
  }
  return {
    service: serviceOrFetch,
    fetchImpl: typeof fetchOrNow === 'function' ? fetchOrNow : fetch,
    now: typeof fetchOrNow === 'number' ? fetchOrNow : requestedNow
  }
}

function safeAppVersion(): string {
  try {
    const version = app.getVersion().trim()
    return /^\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/.test(version) ? version : '0.1.8'
  } catch {
    return '0.1.8'
  }
}
