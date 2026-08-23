#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-authorization-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
const checks = []
const require = createRequire(import.meta.url)
const refreshCanary = ['refresh', 'credential', 'canary'].join('-')
const expectedAppVersion = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version

const openaiEngineSource = readFileSync(path.join(repoRoot, 'src/main/openaiEngine.ts'), 'utf8')
if (!openaiEngineSource.includes('issueProviderAuthorizationAccountLease')
  || !openaiEngineSource.includes('auth.authorizationAccountId')) {
  throw new Error('OpenAI runtime must redeem routed OAuth accounts through the lease service')
}

try {
  compile()
  installElectronStub()
  const client = await import(pathToFileURL(findCompiled(outDir, 'codexOAuthClient.js')).href)
  const github = await import(pathToFileURL(findCompiled(outDir, 'githubCopilotOAuthClient.js')).href)
  const xai = await import(pathToFileURL(findCompiled(outDir, 'xaiOAuthClient.js')).href)
  const store = await import(pathToFileURL(findCompiled(outDir, 'providerAuthorizationStore.js')).href)
  const providers = await import(pathToFileURL(findCompiled(outDir, 'providers.js')).href)
  const service = await import(pathToFileURL(findCompiled(outDir, 'providerAuthorizationService.js')).href)
  const accountService = await import(pathToFileURL(findCompiled(outDir, 'providerAuthorizationAccountService.js')).href)
  const started = await client.startCodexDeviceAuthorization(queueFetch([
    jsonResponse(200, { device_auth_id: 'server-device-id', user_code: 'ABCD-EFGH', interval: '4', expires_in: 900 })
  ]))
  equal(started.userCode, 'ABCD-EFGH', 'device flow returns the user code')
  equal(started.intervalSeconds, 4, 'device flow normalizes the polling interval')
  await expectCode(
    () => client.pollCodexDeviceAuthorization('server-device-id', 'ABCD-EFGH', queueFetch([new Response('', { status: 403 })])),
    'authorization_pending',
    'pending device flow is explicit'
  )

  const idToken = jwt({ chatgpt_account_id: 'acct-smoke', email: 'owner@example.test' })
  const tokens = await client.pollCodexDeviceAuthorization(
    'server-device-id',
    'ABCD-EFGH',
    queueFetch([
      jsonResponse(200, { authorization_code: 'authorization-code', code_verifier: 'code-verifier' }),
      jsonResponse(200, {
        access_token: 'access-token-value',
        refresh_token: refreshCanary,
        id_token: idToken,
        expires_in: 3600
      })
    ]),
    1_000
  )
  equal(tokens.expiresAt, 3_601_000, 'token expiry is absolute')
  const identity = client.codexOAuthIdentity(tokens)
  equal(identity.accountId, 'acct-smoke', 'account id is parsed from the signed-token payload')
  equal(identity.label, 'owner@example.test', 'account label uses email metadata')

  const rotated = await client.refreshCodexOAuthTokens(refreshCanary, queueFetch([
    jsonResponse(200, { access_token: 'access-token-rotated', expires_in: 600 })
  ]), 2_000)
  equal(rotated.refreshToken, refreshCanary, 'refresh retains the existing token when rotation is omitted')
  const models = await client.fetchCodexOAuthModels('access-token-value', 'acct-smoke', queueFetch([
    jsonResponse(200, { models: [{ slug: 'gpt-smoke' }, { id: 'gpt-smoke-mini' }] })
  ]))
  equal(models.join(','), 'gpt-smoke,gpt-smoke-mini', 'Codex model response is normalized')
  const clientQuota = await client.fetchCodexOAuthQuota('provider-smoke', 'acct-smoke', queueFetch([
    jsonResponse(200, {
      rate_limit: {
        primary_window: { used_percent: 21.5, limit_window_seconds: 18_000, reset_at: 100 },
        secondary_window: { used_percent: 120, limit_window_seconds: 604_800, reset_at: 200 }
      }
    })
  ]), 5_000)
  equal(clientQuota.status, 'ready', 'Codex quota response reaches ready state')
  equal(clientQuota.tiers[0]?.name, 'five_hour', 'Codex primary window maps to five-hour quota')
  equal(clientQuota.tiers[1]?.name, 'seven_day', 'Codex secondary window maps to seven-day quota')
  equal(clientQuota.tiers[1]?.utilization, 100, 'Codex quota utilization is clamped to the public range')
  equal(clientQuota.tiers[0]?.resetsAt, 100_000, 'Codex quota reset timestamp is normalized to milliseconds')
  const expiredQuota = await client.fetchCodexOAuthQuota('provider-smoke', 'acct-smoke', queueFetch([
    new Response('', { status: 401 })
  ]), 6_000)
  equal(expiredQuota.status, 'expired', 'Codex quota maps rejected authorization without response-body exposure')
  const quotaErrorCanary = 'remote-quota-error-canary'
  const unavailableQuota = await client.fetchCodexOAuthQuota('provider-smoke', 'acct-smoke', queueFetch([
    new Response(quotaErrorCanary, { status: 503 })
  ]), 7_000)
  equal(unavailableQuota.status, 'unavailable', 'Codex quota maps non-success responses to a stable state')
  assert(!JSON.stringify(unavailableQuota).includes(quotaErrorCanary), 'Codex quota view excludes remote response bodies')

  const githubStarted = await github.startGitHubCopilotDeviceAuthorization(queueFetch([
    jsonResponse(200, {
      device_code: 'github-private-device-id',
      user_code: 'GHUB-1234',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5
    })
  ]))
  equal(githubStarted.userCode, 'GHUB-1234', 'GitHub device flow returns the user code')
  equal(githubStarted.verificationUri, 'https://github.com/login/device',
    'GitHub device flow accepts only its trusted verification host')
  await expectCode(
    () => github.pollGitHubCopilotDeviceAuthorization('github-private-device-id', queueFetch([
      jsonResponse(200, { error: 'authorization_pending' })
    ])),
    'authorization_pending',
    'GitHub device flow preserves the pending state'
  )
  const githubCalls = []
  const githubTokens = await github.pollGitHubCopilotDeviceAuthorization(
    'github-private-device-id',
    captureQueueFetch([
      jsonResponse(200, { access_token: 'github-long-lived-token' }),
      jsonResponse(200, { id: 4242, login: 'copilot-owner' }),
      jsonResponse(200, {
        token: ['copilot', 'short-lived', 'token'].join('-'),
        expires_at: 4_000,
        endpoints: { api: 'https://api.githubcopilot.com/' }
      })
    ], githubCalls),
    1_000
  )
  equal(githubTokens.accountId, '4242', 'GitHub identity becomes the stable account id')
  equal(githubTokens.label, 'copilot-owner', 'GitHub login becomes the account label')
  equal(githubTokens.expiresAt, 4_000_000, 'Copilot token expiry is normalized to milliseconds')
  equal(githubCalls.length, 3, 'GitHub approval performs token, identity, and Copilot exchange requests')
  const githubExchangeHeaders = new Headers(githubCalls[2].init?.headers)
  equal(githubExchangeHeaders.get('authorization'), 'token github-long-lived-token',
    'Copilot exchange uses the long-lived GitHub credential only in the main process')
  equal(githubExchangeHeaders.get('copilot-integration-id'), 'vscode-chat',
    'Copilot exchange sends the required integration metadata')
  const githubModels = await github.fetchGitHubCopilotModels(
    'copilot-short-lived-token',
    githubTokens.apiBaseUrl,
    queueFetch([jsonResponse(200, {
      data: [
        { id: 'gpt-4.1', model_picker_enabled: true },
        { id: 'hidden-model', model_picker_enabled: false },
        { id: 'gpt-4.1', model_picker_enabled: true }
      ]
    })])
  )
  equal(githubModels.join(','), 'gpt-4.1', 'Copilot models are filtered and deduplicated')
  const githubQuota = await github.fetchGitHubCopilotQuota(
    'provider-github',
    '4242',
    'github-long-lived-token',
    queueFetch([jsonResponse(200, {
      quota_reset_date: '2030-01-02T00:00:00.000Z',
      quota_snapshots: {
        premium_interactions: { percent_remaining: 72.5 },
        chat: { entitlement: 100, remaining: 25 },
        completions: { unlimited: true }
      }
    })]),
    2_000
  )
  equal(githubQuota.status, 'ready', 'Copilot quota response reaches ready state')
  equal(githubQuota.tiers[0]?.utilization, 27.5, 'Copilot remaining percentage maps to utilization')
  equal(githubQuota.tiers[1]?.utilization, 75, 'Copilot entitlement maps to utilization')
  equal(githubQuota.tiers[2]?.utilization, 0, 'Copilot unlimited quota maps to zero utilization')
  await expectCode(
    () => github.refreshGitHubCopilotToken('github-long-lived-token', '4242', queueFetch([
      jsonResponse(200, {
        token: ['untrusted', 'endpoint', 'token'].join('-'),
        endpoints: { api: 'https://evilgithubcopilot.com' }
      })
    ])),
    'invalid_response',
    'Copilot rejects lookalike endpoint hosts'
  )

  const xaiDiscovery = {
    issuer: 'https://auth.x.ai',
    token_endpoint: 'https://auth.x.ai/oauth/token',
    device_authorization_endpoint: 'https://auth.x.ai/oauth/device/code'
  }
  const xaiStarted = await xai.startXaiDeviceAuthorization(queueFetch([
    jsonResponse(200, xaiDiscovery),
    jsonResponse(200, {
      device_code: 'xai-private-device-id',
      user_code: 'XAI-1234',
      verification_uri_complete: 'https://auth.x.ai/device?user_code=XAI-1234',
      expires_in: 900,
      interval: 2
    })
  ]))
  equal(xaiStarted.userCode, 'XAI-1234', 'xAI discovery-backed device flow returns the user code')
  equal(xaiStarted.intervalSeconds, 5, 'xAI device polling includes the service safety delay')
  await expectCode(
    () => xai.startXaiDeviceAuthorization(queueFetch([
      jsonResponse(200, {
        ...xaiDiscovery,
        token_endpoint: 'https://auth.x.ai.evil.test/oauth/token'
      })
    ])),
    'invalid_response',
    'xAI rejects discovery endpoints outside the exact issuer host'
  )
  await expectCode(
    () => xai.pollXaiDeviceAuthorization(
      'xai-private-device-id',
      xaiStarted.tokenEndpoint,
      queueFetch([jsonResponse(200, { error: 'authorization_pending' })])
    ),
    'authorization_pending',
    'xAI device flow preserves the pending state'
  )
  const xaiTokens = await xai.pollXaiDeviceAuthorization(
    'xai-private-device-id',
    xaiStarted.tokenEndpoint,
    queueFetch([jsonResponse(200, {
      access_token: 'xai-access-token',
      refresh_token: 'xai-refresh-token',
      id_token: jwt({ sub: 'xai-account', email: 'xai-owner@example.test' }),
      expires_in: 1800
    })]),
    3_000
  )
  equal(xaiTokens.accountId, 'xai-account', 'xAI token identity is parsed from JWT claims')
  equal(xaiTokens.label, 'xai-owner@example.test', 'xAI email becomes the account label')
  equal(xaiTokens.expiresAt, 1_803_000, 'xAI access expiry is absolute')
  const xaiRotated = await xai.refreshXaiOAuthTokens('xai-refresh-token', queueFetch([
    jsonResponse(200, xaiDiscovery),
    jsonResponse(200, {
      access_token: 'xai-access-rotated',
      id_token: jwt({ sub: 'xai-account' }),
      expires_in: 600
    })
  ]), 4_000)
  equal(xaiRotated.refreshToken, 'xai-refresh-token', 'xAI refresh retains the stored token when rotation is omitted')
  const xaiModels = await xai.fetchXaiOAuthModels('xai-access-token', queueFetch([
    jsonResponse(200, { data: [{ id: 'grok-4' }, { id: 'grok-4-mini' }, { id: 'grok-4' }] })
  ]))
  equal(xaiModels.join(','), 'grok-4,grok-4-mini', 'xAI models are normalized and deduplicated')
  const xaiQuotaNow = 1_800_000_000_000
  const xaiResetSeconds = Math.floor(xaiQuotaNow / 1000) + 7 * 24 * 60 * 60
  const xaiQuota = await xai.fetchXaiOAuthQuota(
    'provider-xai',
    'xai-account',
    'xai-access-token',
    queueFetch([binaryResponse(200, grpcFrame(xaiBillingProto(37.5, xaiResetSeconds)))]),
    xaiQuotaNow
  )
  equal(xaiQuota.status, 'ready', 'xAI gRPC-web billing response reaches ready state')
  equal(xaiQuota.tiers[0]?.utilization, 37.5, 'xAI protobuf usage percentage is decoded')
  equal(xaiQuota.tiers[0]?.name, 'seven_day', 'xAI reset timestamp maps to a seven-day tier')
  equal(xaiQuota.tiers[0]?.resetsAt, xaiResetSeconds * 1000, 'xAI protobuf reset timestamp is decoded')
  const xaiExpiredQuota = await xai.fetchXaiOAuthQuota(
    'provider-xai',
    'xai-account',
    'xai-access-token',
    queueFetch([binaryResponse(200, new Uint8Array(), { 'grpc-status': '16' })]),
    xaiQuotaNow
  )
  equal(xaiExpiredQuota.status, 'expired', 'xAI gRPC authentication failure maps to expired')

  const view = store.storeProviderAuthorizationAccount({
    id: identity.accountId,
    providerId: 'provider-smoke',
    label: identity.label,
    refreshToken: refreshCanary,
    authenticatedAt: 10
  })
  equal(view.credentialStorage, 'encrypted', 'refresh token uses secure storage')
  const persisted = readFileSync(path.join(userData, 'provider-authorizations.json'), 'utf8')
  assert(!persisted.includes(refreshCanary), 'refresh token plaintext is absent from the authorization store')
  assert(persisted.includes('enc:'), 'authorization store persists an encrypted envelope')
  equal(
    store.resolveProviderAuthorizationRefreshToken('provider-smoke', 'acct-smoke'),
    refreshCanary,
    'main process can resolve the stored refresh token'
  )
  const serializedView = JSON.stringify(store.listProviderAuthorizationAccountsFromStore('provider-smoke', 'acct-smoke'))
  assert(!serializedView.includes(refreshCanary), 'renderer account view never contains refresh token material')
  store.storeProviderAuthorizationAccount({
    id: 'shared-account',
    providerId: 'provider-isolation',
    service: 'github-copilot',
    label: 'GitHub account',
    refreshToken: 'github-isolation-token',
    authenticatedAt: 20
  })
  store.storeProviderAuthorizationAccount({
    id: 'shared-account',
    providerId: 'provider-isolation',
    service: 'xai-oauth',
    label: 'xAI account',
    refreshToken: 'xai-isolation-token',
    authenticatedAt: 30
  })
  equal(
    store.listProviderAuthorizationAccountsFromStore('provider-isolation', undefined, 'github-copilot').length,
    1,
    'authorization store filters accounts by service'
  )
  equal(
    store.resolveProviderAuthorizationRefreshToken('provider-isolation', 'shared-account', 'github-copilot'),
    'github-isolation-token',
    'GitHub stored credential resolves only in its service namespace'
  )
  equal(
    store.resolveProviderAuthorizationRefreshToken('provider-isolation', 'shared-account', 'xai-oauth'),
    'xai-isolation-token',
    'xAI stored credential resolves only in its service namespace'
  )
  const isolatedPersisted = readFileSync(path.join(userData, 'provider-authorizations.json'), 'utf8')
  assert(!isolatedPersisted.includes('github-isolation-token'), 'GitHub credential plaintext is absent from the store')
  assert(!isolatedPersisted.includes('xai-isolation-token'), 'xAI credential plaintext is absent from the store')
  assert(isolatedPersisted.includes('github-copilot') && isolatedPersisted.includes('xai-oauth'),
    'authorization store records service identity without exposing credentials')

  const provider = providers.createProvider({
    name: 'Codex OAuth smoke',
    baseUrl: 'https://api.openai.com',
    models: [],
    engine: 'openai',
    openaiProtocol: 'responses'
  })
  const serviceFlow = await service.startProviderAuthorization(provider.id, queueFetch([
    jsonResponse(200, { device_auth_id: 'private-device-id', user_code: 'WXYZ-1234', interval: 1, expires_in: 900 })
  ]), 10_000)
  assert(!JSON.stringify(serviceFlow).includes('private-device-id'), 'device authorization id stays in the main process')
  const serviceResult = await service.pollProviderAuthorization(provider.id, serviceFlow.flowId, queueFetch([
    jsonResponse(200, { authorization_code: 'authorization-code', code_verifier: 'code-verifier' }),
    jsonResponse(200, {
      access_token: 'service-access-token',
      refresh_token: 'service-refresh-token',
      id_token: jwt({ chatgpt_account_id: 'acct-service', email: 'service@example.test' }),
      expires_in: 3600
    }),
    jsonResponse(200, { models: [{ slug: 'gpt-service' }] })
  ]), 10_000)
  equal(serviceResult.status, 'authorized', 'provider authorization flow reaches authorized state')
  const authorizedProvider = serviceResult.provider
  equal(authorizedProvider.baseUrl, 'https://chatgpt.com/backend-api/codex/responses',
    'authorized Provider uses the Codex responses endpoint')
  equal(authorizedProvider.authorization?.accountId, 'acct-service', 'Provider binds the authorized account')
  equal(authorizedProvider.models[0], 'gpt-service', 'Provider receives the Codex model list')
  equal(authorizedProvider.credentialHeaderNames[0], 'authorization', 'Provider uses a managed bearer header')
  assert(authorizedProvider.customHeaders.includes(`version: ${expectedAppVersion}`),
    'Codex Provider identifies the current CaoGen package version')
  assert(authorizedProvider.ready, 'authorized Provider is ready')
  assert(!JSON.stringify(serviceResult).includes('service-access-token'), 'access token never enters the renderer result')
  assert(!JSON.stringify(serviceResult).includes('service-refresh-token'), 'refresh token never enters the renderer result')
  const quotaRequests = []
  const providerQuota = await service.queryProviderAuthorizationQuota(provider.id, captureFetch(
    jsonResponse(200, {
      rate_limit: {
        primary_window: { used_percent: 35, limit_window_seconds: 18_000, reset_at: 300 },
        secondary_window: { used_percent: 72, limit_window_seconds: 2_592_000, reset_at: 400 }
      }
    }),
    quotaRequests
  ), 11_000)
  equal(providerQuota.tiers[1]?.name, 'thirty_day', 'bound Provider quota maps the free-plan 30-day window')
  equal(quotaRequests.length, 1, 'bound Provider quota performs exactly one remote request')
  const quotaHeaders = new Headers(quotaRequests[0].init?.headers)
  equal(quotaHeaders.get('authorization'), 'Bearer service-access-token',
    'bound Provider quota redeems its access credential only in the main-process request')
  equal(quotaHeaders.get('chatgpt-account-id'), 'acct-service',
    'bound Provider quota sends the selected ChatGPT account identifier')
  assert(!JSON.stringify(providerQuota).includes('service-access-token'), 'quota IPC view excludes access token material')
  const restartedStoreFile = findCompiled(outDir, 'providerAuthorizationStore.js')
  delete require.cache[require.resolve(restartedStoreFile)]
  const restartedAuthorizationStore = require(restartedStoreFile)
  const restartedAccount = restartedAuthorizationStore
    .listProviderAuthorizationAccountsFromStore(provider.id, 'acct-service', 'codex-oauth')
    .find((account) => account.id === 'acct-service')
  equal(restartedAccount?.lastQuota?.queriedAt, 11_000,
    'last verified quota observation survives a fresh store module after restart')
  equal(restartedAccount?.lastQuota?.tiers[0]?.utilization, 35,
    'restarted account view restores non-secret quota tier values')
  const authorizationStoreText = readFileSync(path.join(userData, 'provider-authorizations.json'), 'utf8')
  assert(!authorizationStoreText.includes('service-access-token'),
    'persisted quota observation never includes the redeemed access credential')
  const revoked = service.revokeProviderAuthorization(provider.id)
  equal(revoked.authorization?.status, 'revoked', 'revocation updates Provider authorization state')
  assert(!revoked.ready, 'revocation removes the active OAuth access credential')

  const copilotProvider = providers.createProvider({
    name: 'Copilot OAuth smoke',
    baseUrl: 'https://api.openai.com',
    models: [],
    engine: 'openai',
    openaiProtocol: 'chat'
  })
  const firstCopilotFlow = await service.startProviderAuthorization(
    copilotProvider.id,
    'github-copilot',
    queueFetch([jsonResponse(200, {
      device_code: 'copilot-device-one',
      user_code: 'COPY-0001',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 1
    })]),
    40_000
  )
  equal(firstCopilotFlow.service, 'github-copilot', 'Provider authorization flow exposes its GitHub service identity')
  assert(!JSON.stringify(firstCopilotFlow).includes('copilot-device-one'),
    'GitHub device credential stays in the main process')
  const firstCopilotResult = await service.pollProviderAuthorization(
    copilotProvider.id,
    firstCopilotFlow.flowId,
    queueFetch([
      jsonResponse(200, { access_token: 'github-provider-token-one' }),
      jsonResponse(200, { id: 7001, login: 'copilot-one' }),
      jsonResponse(200, {
        token: ['copilot', 'provider', 'access', 'one'].join('-'),
        expires_at: 4000,
        endpoints: { api: 'https://api.githubcopilot.com' }
      }),
      jsonResponse(200, { data: [{ id: 'gpt-4.1', model_picker_enabled: true }] })
    ]),
    40_000
  )
  equal(firstCopilotResult.provider.authorization?.provider, 'github-copilot',
    'GitHub approval binds the correct authorization service')
  equal(firstCopilotResult.provider.baseUrl, 'https://api.githubcopilot.com',
    'GitHub approval configures the trusted Copilot API endpoint')
  equal(firstCopilotResult.provider.openaiProtocol, 'chat',
    'GitHub approval configures the chat-completions protocol')
  equal(firstCopilotResult.provider.models[0], 'gpt-4.1',
    'GitHub approval adopts the Copilot model catalog')
  assert(!JSON.stringify(firstCopilotResult).includes('github-provider-token-one'),
    'GitHub OAuth token never enters the renderer result')
  assert(!JSON.stringify(firstCopilotResult).includes('copilot-provider-access-one'),
    'Copilot access token never enters the renderer result')

  const secondCopilotFlow = await service.startProviderAuthorization(
    copilotProvider.id,
    'github-copilot',
    queueFetch([jsonResponse(200, {
      device_code: 'copilot-device-two',
      user_code: 'COPY-0002',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 1
    })]),
    50_000
  )
  const secondCopilotResult = await service.pollProviderAuthorization(
    copilotProvider.id,
    secondCopilotFlow.flowId,
    queueFetch([
      jsonResponse(200, { access_token: 'github-provider-token-two' }),
      jsonResponse(200, { id: 7002, login: 'copilot-two' }),
      jsonResponse(200, {
        token: ['copilot', 'provider', 'access', 'two'].join('-'),
        expires_at: 5000,
        endpoints: { api: 'https://api.githubcopilot.com' }
      }),
      jsonResponse(200, { data: [{ id: 'gpt-4.1' }] })
    ]),
    50_000
  )
  equal(secondCopilotResult.provider.authorization?.accountId, '7002',
    'a second GitHub account becomes the active binding')
  const copilotAccounts = accountService.listProviderAuthorizationAccounts(copilotProvider.id)
  equal(copilotAccounts.length, 2, 'multiple GitHub accounts are retained for one Provider')
  equal(copilotAccounts.filter((account) => account.bound).length, 1,
    'exactly one GitHub account is marked as bound')
  const routedCopilot = accountService.updateProviderAuthorizationRoutingMode(copilotProvider.id, 'automatic')
  equal(routedCopilot.authorization?.accountRoutingMode, 'automatic',
    'OAuth account routing mode persists on the Provider')
  accountService.updateProviderAuthorizationAccountPolicy(copilotProvider.id, {
    accountId: '7002',
    policy: { priority: 7, minimumQuotaRemainingPercent: 15, requireKnownQuota: true, failureCooldownMinutes: 12 }
  })
  const policyAccounts = accountService.listProviderAuthorizationAccounts(copilotProvider.id)
  const policyAccount = policyAccounts.find((account) => account.id === '7002')
  equal(policyAccount?.policy.priority, 7, 'OAuth account priority persists in the encrypted account store')
  equal(policyAccount?.policy.minimumQuotaRemainingPercent, 15, 'OAuth account quota reserve persists')
  equal(policyAccount?.policy.requireKnownQuota, true, 'OAuth account known-quota policy persists')
  equal(policyAccount?.policy.failureCooldownMinutes, 12, 'OAuth account cooldown persists')
  const reboundCopilot = await service.bindProviderAuthorizationAccount(
    copilotProvider.id,
    '7001',
    queueFetch([
      jsonResponse(200, {
        token: ['copilot', 'provider', 'access', 'rebound'].join('-'),
        expires_at: 6000,
        endpoints: { api: 'https://api.githubcopilot.com' }
      }),
      jsonResponse(200, { data: [{ id: 'gpt-4.1' }, { id: 'claude-sonnet-4.5' }] })
    ]),
    60_000
  )
  equal(reboundCopilot.authorization?.accountId, '7001', 'GitHub account switching updates the active binding')
  equal(reboundCopilot.models.join(','), 'claude-sonnet-4.5,gpt-4.1',
    'GitHub account switching refreshes the model catalog')
  const copilotProviderQuota = await service.queryProviderAuthorizationQuota(
    copilotProvider.id,
    queueFetch([jsonResponse(200, {
      quota_reset_date: 2_000_000_000,
      quota_snapshots: { premium_interactions: { percent_remaining: 60 } }
    })]),
    61_000
  )
  equal(copilotProviderQuota.tiers[0]?.utilization, 40,
    'bound GitHub Provider queries quota with its stored GitHub credential')
  const appBoundLease = await service.issueProviderAuthorizationAccountLease(
    providers.getProvider(copilotProvider.id),
    '7002',
    { providerId: copilotProvider.id, projectId: 'smoke-project', sessionId: 'smoke-session', operationId: 'app-account' },
    queueFetch([jsonResponse(200, {
      token: ['copilot', 'app', 'bound', 'access'].join('-'),
      expires_at: 7000,
      endpoints: { api: 'https://api.githubcopilot.com' }
    })]),
    62_000
  )
  equal(appBoundLease.accountId, '7002', 'app binding can select a non-active OAuth account')
  assert(appBoundLease.lease, 'app-bound OAuth account receives a one-request credential lease')
  assert(!JSON.stringify(appBoundLease).includes('copilot-app-bound-access'),
    'app-bound OAuth lease result does not expose the access token')
  const cachedAppBoundLease = await service.issueProviderAuthorizationAccountLease(
    providers.getProvider(copilotProvider.id),
    '7002',
    { providerId: copilotProvider.id, projectId: 'smoke-project', sessionId: 'smoke-session', operationId: 'app-account-cached' },
    queueFetch([]),
    63_000
  )
  equal(cachedAppBoundLease.accountId, '7002', 'valid app-bound OAuth tokens are reused only from process memory')

  const xaiProvider = providers.createProvider({
    name: 'xAI OAuth smoke',
    baseUrl: 'https://api.openai.com',
    models: [],
    engine: 'openai',
    openaiProtocol: 'chat'
  })
  const xaiProviderFlow = await service.startProviderAuthorization(
    xaiProvider.id,
    'xai-oauth',
    queueFetch([
      jsonResponse(200, xaiDiscovery),
      jsonResponse(200, {
        device_code: 'xai-provider-device',
        user_code: 'XAIP-0001',
        verification_uri: 'https://x.ai/device',
        expires_in: 900,
        interval: 1
      })
    ]),
    xaiQuotaNow
  )
  equal(xaiProviderFlow.service, 'xai-oauth', 'Provider authorization flow exposes its xAI service identity')
  const xaiProviderResult = await service.pollProviderAuthorization(
    xaiProvider.id,
    xaiProviderFlow.flowId,
    queueFetch([
      jsonResponse(200, {
        access_token: 'xai-provider-access',
        refresh_token: 'xai-provider-refresh',
        id_token: jwt({ sub: 'xai-provider-account', email: 'xai-provider@example.test' }),
        expires_in: 3600
      }),
      jsonResponse(200, { data: [{ id: 'grok-4' }] })
    ]),
    xaiQuotaNow
  )
  equal(xaiProviderResult.provider.authorization?.provider, 'xai-oauth',
    'xAI approval binds the correct authorization service')
  equal(xaiProviderResult.provider.baseUrl, 'https://api.x.ai/v1',
    'xAI approval configures the official API endpoint')
  equal(xaiProviderResult.provider.models[0], 'grok-4', 'xAI approval adopts the model catalog')
  assert(!JSON.stringify(xaiProviderResult).includes('xai-provider-access'),
    'xAI access token never enters the renderer result')
  assert(!JSON.stringify(xaiProviderResult).includes('xai-provider-refresh'),
    'xAI refresh token never enters the renderer result')
  const xaiQuotaCalls = []
  const xaiProviderQuota = await service.queryProviderAuthorizationQuota(
    xaiProvider.id,
    captureFetch(binaryResponse(200, grpcFrame(xaiBillingProto(54, xaiResetSeconds))), xaiQuotaCalls),
    xaiQuotaNow
  )
  equal(xaiProviderQuota.tiers[0]?.utilization, 54,
    'bound xAI Provider decodes its subscription quota')
  const xaiProviderQuotaHeaders = new Headers(xaiQuotaCalls[0].init?.headers)
  equal(xaiProviderQuotaHeaders.get('authorization'), 'Bearer xai-provider-access',
    'xAI quota request redeems its access credential only in the main process')
  const refreshedXai = await service.refreshProviderAuthorization(
    xaiProvider.id,
    queueFetch([
      jsonResponse(200, xaiDiscovery),
      jsonResponse(200, {
        access_token: 'xai-provider-access-rotated',
        refresh_token: 'xai-provider-refresh-rotated',
        id_token: jwt({ sub: 'xai-provider-account' }),
        expires_in: 7200
      }),
      jsonResponse(200, { data: [{ id: 'grok-4-fast' }] })
    ]),
    xaiQuotaNow + 1_000
  )
  equal(refreshedXai.models[0], 'grok-4-fast', 'xAI refresh updates the model catalog')
  equal(
    store.resolveProviderAuthorizationRefreshToken(xaiProvider.id, 'xai-provider-account', 'xai-oauth'),
    'xai-provider-refresh-rotated',
    'xAI refresh rotation replaces the encrypted stored credential'
  )

  const providerCountBeforeQuick = providers.listProviders().length
  const quickFlow = await service.startQuickProviderAuthorization(queueFetch([
    jsonResponse(200, { device_auth_id: 'quick-private-device-id', user_code: 'QUICK-1234', interval: 1, expires_in: 900 })
  ]), 20_000)
  equal(providers.listProviders().length, providerCountBeforeQuick,
    'quick authorization does not create a Provider before account approval')
  assert(!JSON.stringify(quickFlow).includes('quick-private-device-id'),
    'quick authorization keeps the device authorization id in the main process')
  assert(!('providerId' in quickFlow), 'quick authorization does not expose a placeholder Provider id')
  const quickPending = await service.pollQuickProviderAuthorization(quickFlow.flowId, queueFetch([
    new Response('', { status: 403 })
  ]), 20_000)
  equal(quickPending.status, 'pending', 'quick authorization preserves the pending state')
  const quickResult = await service.pollQuickProviderAuthorization(quickFlow.flowId, queueFetch([
    jsonResponse(200, { authorization_code: 'quick-code', code_verifier: 'quick-verifier' }),
    jsonResponse(200, {
      access_token: 'quick-access-token',
      refresh_token: 'quick-refresh-token',
      id_token: jwt({ chatgpt_account_id: 'acct-quick', email: 'quick@example.test' }),
      expires_in: 3600
    }),
    jsonResponse(200, { models: [{ slug: 'gpt-quick' }] })
  ]), 21_001)
  equal(quickResult.status, 'authorized', 'quick authorization reaches its authorized state')
  equal(providers.listProviders().length, providerCountBeforeQuick + 1,
    'quick authorization creates exactly one Provider after account approval')
  equal(quickResult.provider.name, 'ChatGPT Codex', 'quick authorization creates the dedicated Codex Provider')
  equal(quickResult.provider.models[0], 'gpt-quick', 'quick authorization adopts the remote Codex model catalog')
  assert(quickResult.provider.ready, 'quick authorization returns a ready Provider')
  assert(!JSON.stringify(quickResult).includes('quick-access-token'), 'quick authorization result excludes access token material')
  assert(!JSON.stringify(quickResult).includes('quick-refresh-token'), 'quick authorization result excludes refresh token material')

  const quickCopilotCount = providers.listProviders().length
  const quickCopilotFlow = await service.startQuickProviderAuthorization(
    'github-copilot',
    queueFetch([jsonResponse(200, {
      device_code: 'quick-copilot-private-device',
      user_code: 'QGIT-1234',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 1
    })]),
    25_000
  )
  equal(quickCopilotFlow.service, 'github-copilot', 'quick authorization preserves the selected service')
  const quickCopilotResult = await service.pollQuickProviderAuthorization(
    quickCopilotFlow.flowId,
    queueFetch([
      jsonResponse(200, { access_token: 'quick-github-token' }),
      jsonResponse(200, { id: 8001, login: 'quick-copilot' }),
      jsonResponse(200, {
        token: ['quick', 'copilot', 'access'].join('-'),
        expires_at: 8000,
        endpoints: { api: 'https://api.githubcopilot.com' }
      }),
      jsonResponse(200, { data: [{ id: 'gpt-4.1' }] })
    ]),
    25_000
  )
  equal(providers.listProviders().length, quickCopilotCount + 1,
    'quick GitHub approval creates exactly one Provider')
  equal(quickCopilotResult.provider.name, 'GitHub Copilot',
    'quick GitHub approval creates the dedicated Copilot Provider')
  equal(quickCopilotResult.provider.authorization?.provider, 'github-copilot',
    'quick GitHub Provider remains bound to the selected service')
  assert(!JSON.stringify(quickCopilotResult).includes('quick-github-token'),
    'quick GitHub result excludes the long-lived OAuth credential')

  const countBeforeRollback = providers.listProviders().length
  const rollbackFlow = await service.startQuickProviderAuthorization(queueFetch([
    jsonResponse(200, { device_auth_id: 'rollback-device-id', user_code: 'ROLL-1234', interval: 1, expires_in: 900 })
  ]), 30_000)
  await expectReject(() => service.pollQuickProviderAuthorization(rollbackFlow.flowId, queueFetch([
    jsonResponse(200, { authorization_code: 'rollback-code', code_verifier: 'rollback-verifier' }),
    jsonResponse(200, {
      access_token: 'rollback-access-token',
      refresh_token: 'rollback-refresh-token',
      id_token: jwt({ chatgpt_account_id: 'x'.repeat(600), email: 'rollback@example.test' }),
      expires_in: 3600
    })
  ]), 30_000), 'quick authorization rejects an account identity outside the storage contract')
  equal(providers.listProviders().length, countBeforeRollback,
    'quick authorization rolls back its newly created Provider when completion fails')
  const providerListSource = readFileSync(path.join(repoRoot, 'src/renderer/src/components/settings/ProviderList.tsx'), 'utf8')
  assert(providerListSource.includes('data-provider-authorization-overview'),
    'Provider account overview exposes multi-account authorization state')
  assert(providerListSource.includes('listProviderAuthorizationAccounts')
      && providerListSource.includes('bindProviderAuthorizationAccount'),
    'multi-account overview lists and switches accounts through brokered IPC')
  assert(!providerListSource.includes('refreshToken') && !providerListSource.includes('accessToken'),
    'multi-account overview never references OAuth token material')
  console.log(`provider authorization smoke ok: ${checks.length}/${checks.length} checks passed`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compile() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    'src/main/provider/codexOAuthClient.ts',
    'src/main/provider/githubCopilotOAuthClient.ts',
    'src/main/provider/xaiOAuthClient.ts',
    'src/main/provider/providerAuthorizationStore.ts',
    'src/main/provider/providerAuthorizationService.ts'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronStub() {
  const modulesRoot = path.join(outDir, 'node_modules')
  const root = path.join(modulesRoot, 'electron')
  mkdirSync(root, { recursive: true })
  symlinkSync(
    path.join(repoRoot, 'node_modules', 'sql.js'),
    path.join(modulesRoot, 'sql.js'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  mkdirSync(userData, { recursive: true })
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'electron', version: '0.0.0', main: 'index.js' }))
  writeFileSync(path.join(root, 'index.js'), `'use strict'
module.exports = {
  app: { getPath() { return ${JSON.stringify(userData)} }, getVersion() { return ${JSON.stringify(expectedAppVersion)} } },
  safeStorage: {
    isEncryptionAvailable() { return true },
    encryptString(value) { return Buffer.from('sealed:' + value, 'utf8') },
    decryptString(value) { return Buffer.from(value).toString('utf8').slice(7) },
    getSelectedStorageBackend() { return 'keychain' }
  }
}
`)
}

function queueFetch(responses) {
  return async () => {
    const response = responses.shift()
    if (!response) throw new Error('unexpected fetch')
    return response
  }
}

function captureQueueFetch(responses, calls) {
  return async (input, init) => {
    calls.push({ input, init })
    const response = responses.shift()
    if (!response) throw new Error('unexpected fetch')
    return response
  }
}

function captureFetch(response, calls) {
  return async (input, init) => {
    calls.push({ input, init })
    return response
  }
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function binaryResponse(status, body, headers = {}) {
  return new Response(body, { status, headers: { 'content-type': 'application/grpc-web+proto', ...headers } })
}

function grpcFrame(payload) {
  const frame = new Uint8Array(5 + payload.length)
  new DataView(frame.buffer).setUint32(1, payload.length, false)
  frame.set(payload, 5)
  return frame
}

function xaiBillingProto(utilization, resetSeconds) {
  const usage = new Uint8Array(5)
  usage[0] = (1 << 3) | 5
  new DataView(usage.buffer).setFloat32(1, utilization, true)
  const reset = Uint8Array.from([(1 << 3) | 0, ...encodeVarint(resetSeconds)])
  const resetMessage = Uint8Array.from([(5 << 3) | 2, ...encodeVarint(reset.length), ...reset])
  const nested = Uint8Array.from([...usage, ...resetMessage])
  return Uint8Array.from([(1 << 3) | 2, ...encodeVarint(nested.length), ...nested])
}

function encodeVarint(value) {
  const bytes = []
  let remaining = value
  while (remaining >= 0x80) {
    bytes.push((remaining % 0x80) | 0x80)
    remaining = Math.floor(remaining / 0x80)
  }
  bytes.push(remaining)
  return bytes
}

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`
}

function findCompiled(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      try { return findCompiled(full, fileName) } catch { /* keep searching */ }
    } else if (entry.isFile() && entry.name === fileName) return full
  }
  throw new Error(`compiled ${fileName} not found`)
}

async function expectCode(action, expected, message) {
  let actual = ''
  try { await action() } catch (error) { actual = error?.code ?? '' }
  equal(actual, expected, message)
}

async function expectReject(action, message) {
  let rejected = false
  try { await action() } catch { rejected = true }
  assert(rejected, message)
}

function equal(actual, expected, message) {
  const pass = actual === expected
  checks.push({ name: message, status: pass ? 'pass' : 'fail' })
  if (!pass) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message) {
  checks.push({ name: message, status: condition ? 'pass' : 'fail' })
  if (!condition) throw new Error(message)
}
