import type {
  ProviderAuthorizationQuotaTierView,
  ProviderAuthorizationQuotaView
} from '../../shared/provider-authorization-types'

const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98'
const GITHUB_DEVICE_URL = 'https://github.com/login/device/code'
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GITHUB_API_BASE = 'https://api.github.com'
export const GITHUB_COPILOT_API_BASE = 'https://api.githubcopilot.com'
const REQUEST_TIMEOUT_MS = 20_000
const MAX_RESPONSE_BYTES = 512 * 1024

export const COPILOT_EDITOR_VERSION = 'vscode/1.110.1'
export const COPILOT_PLUGIN_VERSION = 'copilot-chat/0.38.2'
export const COPILOT_USER_AGENT = 'GitHubCopilotChat/0.38.2'
export const COPILOT_API_VERSION = '2025-10-01'
export const COPILOT_INTEGRATION_ID = 'vscode-chat'

export interface GitHubCopilotDeviceAuthorization {
  deviceAuthId: string
  userCode: string
  verificationUri: string
  expiresInSeconds: number
  intervalSeconds: number
}

export interface GitHubCopilotTokens {
  githubToken: string
  accessToken: string
  expiresAt: number
  accountId: string
  label: string
  apiBaseUrl: string
}

export class GitHubCopilotOAuthError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'GitHubCopilotOAuthError'
  }
}

export async function startGitHubCopilotDeviceAuthorization(
  fetchImpl: typeof fetch = fetch
): Promise<GitHubCopilotDeviceAuthorization> {
  const response = await request(fetchImpl, GITHUB_DEVICE_URL, {
    method: 'POST',
    headers: jsonHeaders(),
    body: new URLSearchParams({ client_id: GITHUB_CLIENT_ID, scope: 'read:user' })
  })
  const body = await responseJson(response)
  if (!response.ok) throw oauthFailure('network_error', response.status, body)
  return {
    deviceAuthId: requiredText(body.device_code, 'device code'),
    userCode: requiredText(body.user_code, 'user code'),
    verificationUri: secureUrl(body.verification_uri, 'verification URI', ['github.com']),
    expiresInSeconds: boundedSeconds(body.expires_in, 900, 60, 86_400),
    intervalSeconds: boundedSeconds(body.interval, 5, 1, 60)
  }
}

export async function pollGitHubCopilotDeviceAuthorization(
  deviceAuthId: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now()
): Promise<GitHubCopilotTokens> {
  const response = await request(fetchImpl, GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: jsonHeaders(),
    body: new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      device_code: requiredText(deviceAuthId, 'device code'),
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    })
  })
  const body = await responseJson(response)
  const error = optionalText(body.error)
  if (error === 'authorization_pending' || error === 'slow_down') {
    throw new GitHubCopilotOAuthError('authorization_pending', 'Waiting for GitHub authorization')
  }
  if (error === 'expired_token') throw new GitHubCopilotOAuthError('expired', 'GitHub device authorization expired')
  if (error === 'access_denied') throw new GitHubCopilotOAuthError('access_denied', 'GitHub authorization was denied')
  if (!response.ok || error) throw oauthFailure(safeCode(error) || 'network_error', response.status, body)
  const githubToken = requiredText(body.access_token, 'access token')
  const identity = await fetchGitHubIdentity(githubToken, fetchImpl)
  const access = await exchangeGitHubCopilotToken(githubToken, fetchImpl, now)
  return { githubToken, accountId: identity.accountId, label: identity.label, ...access }
}

export async function refreshGitHubCopilotToken(
  githubToken: string,
  accountId: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now()
): Promise<GitHubCopilotTokens> {
  const token = requiredText(githubToken, 'stored credential')
  const access = await exchangeGitHubCopilotToken(token, fetchImpl, now)
  return {
    githubToken: token,
    accountId: requiredText(accountId, 'account id'),
    label: `GitHub (${accountId.slice(0, 12)})`,
    ...access
  }
}

export async function fetchGitHubCopilotModels(
  accessToken: string,
  apiBaseUrl = GITHUB_COPILOT_API_BASE,
  fetchImpl: typeof fetch = fetch
): Promise<string[]> {
  const response = await request(fetchImpl, `${trustedCopilotBase(apiBaseUrl)}/models`, {
    headers: copilotHeaders(accessToken)
  })
  if (!response.ok) return []
  const root = await responseJson(response)
  const entries = Array.isArray(root.data) ? root.data : []
  return [...new Set(entries.flatMap((entry) => {
    const model = record(entry)
    if (!model || model.model_picker_enabled === false) return []
    return optionalText(model.id) ? [optionalText(model.id)!] : []
  }))].sort()
}

export async function fetchGitHubCopilotQuota(
  providerId: string,
  accountId: string,
  githubToken: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now()
): Promise<ProviderAuthorizationQuotaView> {
  const response = await request(fetchImpl, `${GITHUB_API_BASE}/copilot_internal/user`, {
    headers: {
      ...copilotMetadataHeaders(),
      authorization: `token ${requiredText(githubToken, 'stored credential')}`
    }
  })
  if (response.status === 401 || response.status === 403) {
    return quotaView(providerId, accountId, 'expired', now, [], 'authorization_expired')
  }
  if (!response.ok) return quotaView(providerId, accountId, 'unavailable', now, [], `http_${response.status}`)
  const root = await responseJson(response)
  const snapshots = record(root.quota_snapshots)
  if (!snapshots) return quotaView(providerId, accountId, 'unavailable', now, [], 'invalid_response')
  const resetsAt = parseTimestamp(root.quota_reset_date)
  const tiers = ['premium_interactions', 'chat', 'completions'].flatMap((name) => {
    const detail = record(snapshots[name])
    if (!detail) return []
    const remainingPercent = finiteNumber(detail.percent_remaining)
    const entitlement = finiteNumber(detail.entitlement)
    const remaining = finiteNumber(detail.remaining)
    const utilization = remainingPercent !== undefined
      ? 100 - remainingPercent
      : entitlement !== undefined && entitlement > 0 && remaining !== undefined
        ? ((entitlement - remaining) / entitlement) * 100
        : detail.unlimited === true ? 0 : undefined
    if (utilization === undefined) return []
    return [{
      name,
      utilization: clampPercent(utilization),
      ...(resetsAt === undefined ? {} : { resetsAt })
    } satisfies ProviderAuthorizationQuotaTierView]
  })
  return quotaView(providerId, accountId, 'ready', now, tiers)
}

async function fetchGitHubIdentity(
  githubToken: string,
  fetchImpl: typeof fetch
): Promise<{ accountId: string; label: string }> {
  const response = await request(fetchImpl, `${GITHUB_API_BASE}/user`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${githubToken}`,
      'user-agent': COPILOT_USER_AGENT,
      'x-github-api-version': '2022-11-28'
    }
  })
  const body = await responseJson(response)
  if (!response.ok) throw new GitHubCopilotOAuthError('identity_failed', `GitHub identity request failed (${response.status})`)
  const id = finiteNumber(body.id)
  if (!Number.isSafeInteger(id) || id! < 1) throw new GitHubCopilotOAuthError('invalid_response', 'GitHub identity was invalid')
  return { accountId: String(id), label: optionalText(body.login) ?? `GitHub (${id})` }
}

async function exchangeGitHubCopilotToken(
  githubToken: string,
  fetchImpl: typeof fetch,
  now: number
): Promise<Pick<GitHubCopilotTokens, 'accessToken' | 'expiresAt' | 'apiBaseUrl'>> {
  const response = await request(fetchImpl, `${GITHUB_API_BASE}/copilot_internal/v2/token`, {
    headers: {
      ...copilotMetadataHeaders(),
      authorization: `token ${requiredText(githubToken, 'stored credential')}`
    }
  })
  const body = await responseJson(response)
  if (response.status === 401 || response.status === 403) {
    throw new GitHubCopilotOAuthError('refresh_rejected', 'GitHub Copilot authorization must be renewed')
  }
  if (!response.ok) throw new GitHubCopilotOAuthError('subscription_unavailable', `GitHub Copilot token request failed (${response.status})`)
  const expiresAtRaw = finiteNumber(body.expires_at)
  const expiresAt = expiresAtRaw === undefined
    ? now + 25 * 60 * 1000
    : expiresAtRaw > 10_000_000_000 ? Math.floor(expiresAtRaw) : Math.floor(expiresAtRaw * 1000)
  const endpoints = record(body.endpoints)
  const apiBaseUrl = optionalText(endpoints?.api)
    ? trustedCopilotBase(optionalText(endpoints?.api)!)
    : GITHUB_COPILOT_API_BASE
  return { accessToken: requiredText(body.token, 'Copilot token'), expiresAt, apiBaseUrl }
}

function copilotHeaders(accessToken: string): Record<string, string> {
  return { ...copilotMetadataHeaders(), authorization: `Bearer ${requiredText(accessToken, 'Copilot token')}` }
}

function copilotMetadataHeaders(): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    'copilot-integration-id': COPILOT_INTEGRATION_ID,
    'editor-version': COPILOT_EDITOR_VERSION,
    'editor-plugin-version': COPILOT_PLUGIN_VERSION,
    'user-agent': COPILOT_USER_AGENT,
    'x-github-api-version': COPILOT_API_VERSION
  }
}

function trustedCopilotBase(value: string): string {
  const url = new URL(value)
  const hostname = url.hostname.toLowerCase()
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || (hostname !== 'githubcopilot.com' && !hostname.endsWith('.githubcopilot.com'))
  ) {
    throw new GitHubCopilotOAuthError('invalid_response', 'GitHub Copilot API endpoint was not trusted')
  }
  return url.href.replace(/\/+$/, '')
}

async function request(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'user-agent': COPILOT_USER_AGENT, ...(init.headers ?? {}) }
    })
  } catch {
    throw new GitHubCopilotOAuthError('network_error', 'GitHub Copilot authorization network request failed')
  }
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const size = finiteNumber(response.headers.get('content-length'))
  if (size !== undefined && size > MAX_RESPONSE_BYTES) {
    throw new GitHubCopilotOAuthError('invalid_response', 'GitHub OAuth response was too large')
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new GitHubCopilotOAuthError('invalid_response', 'GitHub OAuth response was too large')
  }
  const parsed = text ? record(JSON.parse(text)) : null
  if (!parsed) throw new GitHubCopilotOAuthError('invalid_response', 'GitHub OAuth response was invalid')
  return parsed
}

function oauthFailure(code: string, status: number, _body: Record<string, unknown>): GitHubCopilotOAuthError {
  return new GitHubCopilotOAuthError(code, `GitHub OAuth request failed (${status})`)
}

function jsonHeaders(): Record<string, string> {
  return { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': COPILOT_USER_AGENT }
}

function secureUrl(value: unknown, label: string, hosts: string[]): string {
  const url = new URL(requiredText(value, label))
  if (url.protocol !== 'https:' || url.username || url.password || !hosts.includes(url.hostname.toLowerCase())) {
    throw new GitHubCopilotOAuthError('invalid_response', `GitHub ${label} was not trusted`)
  }
  return url.href
}

function requiredText(value: unknown, label: string): string {
  const text = optionalText(value)
  if (!text || text.length > 16_384 || /[\0\r\n]/.test(text)) {
    throw new GitHubCopilotOAuthError('invalid_response', `GitHub ${label} was invalid`)
  }
  return text
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function safeCode(value: string | undefined): string | undefined {
  const code = value?.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64)
  return code || undefined
}

function boundedSeconds(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = finiteNumber(value)
  return parsed === undefined ? fallback : Math.min(maximum, Math.max(minimum, Math.floor(parsed)))
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined
}

function parseTimestamp(value: unknown): number | undefined {
  const numeric = finiteNumber(value)
  if (numeric !== undefined && numeric > 0) return numeric > 10_000_000_000 ? numeric : numeric * 1000
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 100) / 100))
}

function quotaView(
  providerId: string,
  accountId: string,
  status: ProviderAuthorizationQuotaView['status'],
  queriedAt: number,
  tiers: ProviderAuthorizationQuotaTierView[],
  errorCode?: string
): ProviderAuthorizationQuotaView {
  return { providerId, accountId, status, tiers, queriedAt, ...(errorCode ? { errorCode } : {}) }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
