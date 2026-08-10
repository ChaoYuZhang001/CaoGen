import type {
  ProviderAuthorizationQuotaTierView,
  ProviderAuthorizationQuotaView
} from '../../shared/provider-authorization-types'

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const DEVICE_AUTH_USERCODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode'
const DEVICE_AUTH_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token'
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const DEVICE_VERIFICATION_URI = 'https://auth.openai.com/codex/device'
const DEVICE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback'
const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models'
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const REQUEST_TIMEOUT_MS = 20_000

export type CodexOAuthErrorCode =
  | 'network_error'
  | 'invalid_response'
  | 'authorization_pending'
  | 'access_denied'
  | 'expired'
  | 'refresh_rejected'

export class CodexOAuthError extends Error {
  readonly name = 'CodexOAuthError'

  constructor(readonly code: CodexOAuthErrorCode, message: string) {
    super(message)
  }
}

export interface CodexDeviceAuthorization {
  deviceAuthId: string
  userCode: string
  verificationUri: string
  expiresInSeconds: number
  intervalSeconds: number
}

export interface CodexOAuthTokens {
  accessToken: string
  refreshToken: string
  idToken?: string
  expiresAt: number
}

export interface CodexOAuthIdentity {
  accountId: string
  label: string
}

export async function startCodexDeviceAuthorization(
  fetchImpl: typeof fetch = fetch
): Promise<CodexDeviceAuthorization> {
  const response = await request(fetchImpl, DEVICE_AUTH_USERCODE_URL, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID })
  })
  if (!response.ok) throw new CodexOAuthError('network_error', `Codex device authorization failed (${response.status})`)
  const body = record(await response.json().catch(() => null))
  const deviceAuthId = requiredText(body?.device_auth_id, 'device authorization id')
  const userCode = requiredText(body?.user_code, 'device user code')
  return {
    deviceAuthId,
    userCode,
    verificationUri: DEVICE_VERIFICATION_URI,
    expiresInSeconds: boundedSeconds(body?.expires_in, 900, 60, 1800),
    intervalSeconds: boundedSeconds(body?.interval, 5, 1, 60)
  }
}

export async function pollCodexDeviceAuthorization(
  deviceAuthId: string,
  userCode: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now()
): Promise<CodexOAuthTokens> {
  const poll = await request(fetchImpl, DEVICE_AUTH_TOKEN_URL, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode })
  })
  if (poll.status === 403 || poll.status === 404) {
    throw new CodexOAuthError('authorization_pending', 'Waiting for ChatGPT authorization')
  }
  if (poll.status === 410) throw new CodexOAuthError('expired', 'Codex device authorization expired')
  if (!poll.ok) throw new CodexOAuthError('network_error', `Codex authorization polling failed (${poll.status})`)
  const pollBody = record(await poll.json().catch(() => null))
  const authorizationCode = requiredText(pollBody?.authorization_code, 'authorization code')
  const codeVerifier = requiredText(pollBody?.code_verifier, 'code verifier')
  const tokenBody = await tokenRequest(fetchImpl, new URLSearchParams({
    grant_type: 'authorization_code',
    code: authorizationCode,
    redirect_uri: DEVICE_REDIRECT_URI,
    client_id: CODEX_CLIENT_ID,
    code_verifier: codeVerifier
  }))
  return parseTokenResponse(tokenBody, now)
}

export async function refreshCodexOAuthTokens(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now()
): Promise<CodexOAuthTokens> {
  const body = await tokenRequest(fetchImpl, new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CODEX_CLIENT_ID,
    scope: 'openid profile email'
  }), true)
  return parseTokenResponse(body, now, refreshToken)
}

export function codexOAuthIdentity(tokens: Pick<CodexOAuthTokens, 'accessToken' | 'idToken'>): CodexOAuthIdentity {
  const claims = [tokens.idToken, tokens.accessToken]
    .filter((token): token is string => Boolean(token))
    .map(decodeJwtClaims)
    .filter((value): value is Record<string, unknown> => value !== null)
  for (const claim of claims) {
    const auth = record(claim['https://api.openai.com/auth'])
    const organizations = Array.isArray(claim.organizations) ? claim.organizations : []
    const organization = organizations.map(record).find(Boolean)
    const accountId = firstText(
      claim.chatgpt_account_id,
      auth?.chatgpt_account_id,
      organization?.id
    )
    if (!accountId) continue
    const email = firstText(claim.email)
    return { accountId, label: email ?? `ChatGPT (${accountId.slice(0, 12)})` }
  }
  throw new CodexOAuthError('invalid_response', 'Codex token did not contain an account identifier')
}

export async function fetchCodexOAuthModels(
  accessToken: string,
  accountId: string,
  fetchImpl: typeof fetch = fetch
): Promise<string[]> {
  const response = await request(fetchImpl, CODEX_MODELS_URL, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      originator: 'caogen',
      'chatgpt-account-id': accountId
    }
  })
  if (!response.ok) return []
  const body = await response.json().catch(() => null)
  return parseModelIds(body)
}

export async function fetchCodexOAuthQuota(
  providerId: string,
  accountId: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now()
): Promise<ProviderAuthorizationQuotaView> {
  const response = await request(fetchImpl, CODEX_USAGE_URL, {
    headers: {
      accept: 'application/json',
      'chatgpt-account-id': accountId,
      'user-agent': 'codex-cli'
    }
  })
  if (response.status === 401 || response.status === 403) {
    return quotaView(providerId, accountId, 'expired', now, [], 'authorization_expired')
  }
  if (!response.ok) {
    return quotaView(providerId, accountId, 'unavailable', now, [], `http_${response.status}`)
  }
  const root = record(await response.json().catch(() => null))
  const rateLimit = record(root?.rate_limit)
  if (!root || !rateLimit) {
    return quotaView(providerId, accountId, 'unavailable', now, [], 'invalid_response')
  }
  const tiers = [rateLimit.primary_window, rateLimit.secondary_window]
    .map(parseQuotaTier)
    .filter((tier): tier is ProviderAuthorizationQuotaTierView => tier !== null)
  return quotaView(providerId, accountId, 'ready', now, tiers)
}

function parseTokenResponse(
  body: Record<string, unknown>,
  now: number,
  fallbackRefreshToken?: string
): CodexOAuthTokens {
  const accessToken = requiredText(body.access_token, 'access token')
  const refreshToken = optionalText(body.refresh_token) ?? fallbackRefreshToken
  if (!refreshToken) throw new CodexOAuthError('invalid_response', 'Codex token response did not contain a refresh token')
  const expiresIn = boundedSeconds(body.expires_in, 3600, 60, 86_400)
  return {
    accessToken,
    refreshToken,
    idToken: optionalText(body.id_token),
    expiresAt: now + expiresIn * 1000
  }
}

async function tokenRequest(
  fetchImpl: typeof fetch,
  body: URLSearchParams,
  refreshing = false
): Promise<Record<string, unknown>> {
  const response = await request(fetchImpl, OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'caogen-codex-oauth'
    },
    body
  })
  if (refreshing && (response.status === 401 || response.status === 403)) {
    throw new CodexOAuthError('refresh_rejected', 'ChatGPT authorization must be renewed')
  }
  if (!response.ok) throw new CodexOAuthError('network_error', `Codex token exchange failed (${response.status})`)
  const parsed = record(await response.json().catch(() => null))
  if (!parsed) throw new CodexOAuthError('invalid_response', 'Codex token response was invalid')
  return parsed
}

async function request(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'user-agent': 'caogen-codex-oauth', ...(init.headers ?? {}) }
    })
  } catch {
    throw new CodexOAuthError('network_error', 'Codex authorization network request failed')
  }
}

function jsonHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', 'user-agent': 'caogen-codex-oauth' }
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    return record(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
  } catch {
    return null
  }
}

function parseModelIds(value: unknown): string[] {
  const root = record(value)
  const entries = Array.isArray(value)
    ? value
    : Array.isArray(root?.data)
      ? root.data
      : Array.isArray(root?.models)
        ? root.models
        : Array.isArray(root?.items) ? root.items : []
  const ids = entries.flatMap((item) => {
    if (typeof item === 'string') return [item.trim()]
    const model = record(item)
    return [firstText(model?.slug, model?.id, model?.model, model?.name) ?? '']
  }).filter(Boolean)
  return [...new Set(ids)].sort()
}

function parseQuotaTier(value: unknown): ProviderAuthorizationQuotaTierView | null {
  const window = record(value)
  const utilization = finiteNumber(window?.used_percent)
  if (!window || utilization === undefined) return null
  const windowSeconds = positiveInteger(window.limit_window_seconds, 10 * 365 * 24 * 60 * 60)
  const resetSeconds = positiveInteger(window.reset_at, Math.floor(Number.MAX_SAFE_INTEGER / 1000))
  return {
    name: quotaTierName(windowSeconds),
    utilization: Math.max(0, Math.min(100, utilization)),
    ...(windowSeconds === undefined ? {} : { windowSeconds }),
    ...(resetSeconds === undefined ? {} : { resetsAt: resetSeconds * 1000 })
  }
}

function quotaTierName(windowSeconds: number | undefined): string {
  if (windowSeconds === 18_000) return 'five_hour'
  if (windowSeconds === 604_800) return 'seven_day'
  if (windowSeconds === 2_592_000) return 'thirty_day'
  if (!windowSeconds) return 'unknown'
  const hours = Math.floor(windowSeconds / 3600)
  return hours >= 24 ? `${Math.floor(hours / 24)}_day` : `${hours}_hour`
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

function requiredText(value: unknown, label: string): string {
  const text = optionalText(value)
  if (!text || text.length > 16_384 || /[\0\r\n]/.test(text)) {
    throw new CodexOAuthError('invalid_response', `Codex ${label} was invalid`)
  }
  return text
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function firstText(...values: unknown[]): string | undefined {
  return values.map(optionalText).find(Boolean)
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined
}

function positiveInteger(value: unknown, maximum: number): number | undefined {
  const parsed = finiteNumber(value)
  return parsed !== undefined && parsed > 0 && parsed <= maximum
    ? Math.floor(parsed)
    : undefined
}

function boundedSeconds(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, Math.floor(parsed)))
    : fallback
}
