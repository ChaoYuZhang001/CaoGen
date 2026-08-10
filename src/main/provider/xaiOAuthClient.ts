import type {
  ProviderAuthorizationQuotaTierView,
  ProviderAuthorizationQuotaView
} from '../../shared/provider-authorization-types'

const XAI_ISSUER = 'https://auth.x.ai'
const XAI_DISCOVERY_URL = `${XAI_ISSUER}/.well-known/openid-configuration`
const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const XAI_SCOPE = 'openid profile email offline_access grok-cli:access api:access'
export const XAI_API_BASE = 'https://api.x.ai/v1'
const XAI_BILLING_URL = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig'
const REQUEST_TIMEOUT_MS = 20_000
const MAX_RESPONSE_BYTES = 512 * 1024

interface XaiDiscoveryDocument {
  tokenEndpoint: string
  deviceAuthorizationEndpoint: string
}

export interface XaiDeviceAuthorization {
  deviceAuthId: string
  userCode: string
  verificationUri: string
  expiresInSeconds: number
  intervalSeconds: number
  tokenEndpoint: string
}

export interface XaiOAuthTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId: string
  label: string
}

export class XaiOAuthError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'XaiOAuthError'
  }
}

export async function startXaiDeviceAuthorization(
  fetchImpl: typeof fetch = fetch
): Promise<XaiDeviceAuthorization> {
  const discovery = await discover(fetchImpl)
  const response = await request(fetchImpl, discovery.deviceAuthorizationEndpoint, {
    method: 'POST',
    headers: formHeaders(),
    body: new URLSearchParams({ client_id: XAI_CLIENT_ID, scope: XAI_SCOPE })
  })
  const body = await responseJson(response)
  if (!response.ok) throw oauthFailure(response.status, body)
  return {
    deviceAuthId: requiredText(body.device_code, 'device code'),
    userCode: requiredText(body.user_code, 'user code'),
    verificationUri: trustedVerificationUrl(body.verification_uri_complete ?? body.verification_uri),
    expiresInSeconds: boundedSeconds(body.expires_in, 900, 60, 86_400),
    intervalSeconds: Math.min(60, boundedSeconds(body.interval, 5, 1, 60) + 3),
    tokenEndpoint: discovery.tokenEndpoint
  }
}

export async function pollXaiDeviceAuthorization(
  deviceAuthId: string,
  tokenEndpoint: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now()
): Promise<XaiOAuthTokens> {
  const response = await request(fetchImpl, trustedAuthEndpoint(tokenEndpoint), {
    method: 'POST',
    headers: formHeaders(),
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: XAI_CLIENT_ID,
      device_code: requiredText(deviceAuthId, 'device code')
    })
  })
  const body = await responseJson(response)
  const error = optionalText(body.error)
  if (error === 'authorization_pending' || error === 'slow_down') {
    throw new XaiOAuthError('authorization_pending', 'Waiting for xAI authorization')
  }
  if (error === 'expired_token') throw new XaiOAuthError('expired', 'xAI device authorization expired')
  if (error === 'access_denied') throw new XaiOAuthError('access_denied', 'xAI authorization was denied')
  if (!response.ok || error) throw oauthFailure(response.status, body)
  return parseTokens(body, now)
}

export async function refreshXaiOAuthTokens(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now()
): Promise<XaiOAuthTokens> {
  const discovery = await discover(fetchImpl)
  const response = await request(fetchImpl, discovery.tokenEndpoint, {
    method: 'POST',
    headers: formHeaders(),
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: XAI_CLIENT_ID,
      refresh_token: requiredText(refreshToken, 'refresh token'),
      scope: XAI_SCOPE
    })
  })
  if (response.status === 401 || response.status === 403) {
    throw new XaiOAuthError('refresh_rejected', 'xAI authorization must be renewed')
  }
  const body = await responseJson(response)
  const error = optionalText(body.error)
  if (error === 'invalid_grant' || error === 'invalid_token') {
    throw new XaiOAuthError('refresh_rejected', 'xAI authorization must be renewed')
  }
  if (!response.ok || error) throw oauthFailure(response.status, body)
  return parseTokens(body, now, refreshToken)
}

export async function fetchXaiOAuthModels(
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<string[]> {
  const response = await request(fetchImpl, `${XAI_API_BASE}/models`, {
    headers: { accept: 'application/json', authorization: `Bearer ${requiredText(accessToken, 'access token')}` }
  })
  if (!response.ok) return []
  const root = await responseJson(response)
  const entries = Array.isArray(root.data) ? root.data : []
  return [...new Set(entries.flatMap((entry) => {
    const model = record(entry)
    const id = optionalText(model?.id)
    return id ? [id] : []
  }))].sort()
}

export async function fetchXaiOAuthQuota(
  providerId: string,
  accountId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now()
): Promise<ProviderAuthorizationQuotaView> {
  const response = await request(fetchImpl, XAI_BILLING_URL, {
    method: 'POST',
    headers: {
      accept: '*/*',
      authorization: `Bearer ${requiredText(accessToken, 'access token')}`,
      'content-type': 'application/grpc-web+proto',
      origin: 'https://grok.com',
      referer: 'https://grok.com/?_s=usage',
      'x-grpc-web': '1',
      'x-user-agent': 'connect-es/2.1.1'
    },
    body: new Uint8Array(5)
  })
  if (response.status === 401 || response.status === 403) {
    return quotaView(providerId, accountId, 'expired', now, [], 'authorization_expired')
  }
  if (!response.ok) return quotaView(providerId, accountId, 'unavailable', now, [], `http_${response.status}`)
  const headerStatus = integerText(response.headers.get('grpc-status'))
  if (headerStatus !== undefined && headerStatus !== 0) {
    return quotaView(providerId, accountId, headerStatus === 16 ? 'expired' : 'unavailable', now, [], `grpc_${headerStatus}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    return quotaView(providerId, accountId, 'unavailable', now, [], 'response_too_large')
  }
  const snapshot = parseBilling(bytes, now)
  if (!snapshot) return quotaView(providerId, accountId, 'unavailable', now, [], 'invalid_response')
  const tier: ProviderAuthorizationQuotaTierView = {
    name: quotaTierName(snapshot.resetsAt, now),
    utilization: snapshot.utilization,
    ...(snapshot.resetsAt === undefined ? {} : { resetsAt: snapshot.resetsAt })
  }
  return quotaView(providerId, accountId, 'ready', now, [tier])
}

async function discover(fetchImpl: typeof fetch): Promise<XaiDiscoveryDocument> {
  const response = await request(fetchImpl, XAI_DISCOVERY_URL, { headers: { accept: 'application/json' } })
  const body = await responseJson(response)
  if (!response.ok || optionalText(body.issuer)?.replace(/\/+$/, '') !== XAI_ISSUER) {
    throw new XaiOAuthError('invalid_response', 'xAI authorization discovery was invalid')
  }
  return {
    tokenEndpoint: trustedAuthEndpoint(body.token_endpoint),
    deviceAuthorizationEndpoint: trustedAuthEndpoint(body.device_authorization_endpoint)
  }
}

function parseTokens(body: Record<string, unknown>, now: number, fallbackRefresh?: string): XaiOAuthTokens {
  const accessToken = requiredText(body.access_token, 'access token')
  const refreshToken = optionalText(body.refresh_token) ?? fallbackRefresh
  if (!refreshToken) throw new XaiOAuthError('invalid_response', 'xAI token response did not contain a refresh token')
  const claims = decodeClaims(optionalText(body.id_token)) ?? decodeClaims(accessToken)
  const accountId = optionalText(claims?.sub)
  if (!accountId) throw new XaiOAuthError('invalid_response', 'xAI token did not contain an account identity')
  const label = optionalText(claims?.email)
    ?? optionalText(claims?.preferred_username)
    ?? optionalText(claims?.name)
    ?? `xAI (${accountId.slice(0, 12)})`
  return {
    accessToken,
    refreshToken: requiredText(refreshToken, 'refresh token'),
    expiresAt: now + boundedSeconds(body.expires_in, 3600, 60, 86_400) * 1000,
    accountId,
    label
  }
}

function parseBilling(bytes: Uint8Array, now: number): { utilization: number; resetsAt?: number } | null {
  const payloads = grpcDataFrames(bytes)
  if (payloads.length === 0 && looksLikeProtobuf(bytes)) payloads.push(bytes)
  const scan: ProtoScan = { fixed32: [], varints: [], order: 0 }
  for (const payload of payloads) scanProto(payload, [], 0, scan)
  const percent = scan.fixed32
    .filter((item) => item.path.at(-1) === 1 && Number.isFinite(item.value) && item.value >= 0 && item.value <= 100)
    .sort((left, right) => left.path.length - right.path.length || left.order - right.order)[0]?.value
  const nowSeconds = Math.floor(now / 1000)
  const resetCandidates = scan.varints
    .filter((item) => item.value >= 1_700_000_000 && item.value <= 2_100_000_000 && item.value > nowSeconds)
  const exact = resetCandidates.filter((item) => samePath(item.path, [1, 5, 1]))
  const resetSeconds = (exact.length > 0 ? exact : resetCandidates)
    .sort((left, right) => left.value - right.value)[0]?.value
  const hasUsagePeriod = scan.varints.some((item) =>
    startsWithPath(item.path, [1, 6]) || (samePath(item.path, [1, 8, 1]) && (item.value === 1 || item.value === 2)))
  const utilization = percent ?? (scan.fixed32.length === 0 && resetSeconds && hasUsagePeriod ? 0 : undefined)
  return utilization === undefined
    ? null
    : { utilization: clampPercent(utilization), ...(resetSeconds ? { resetsAt: resetSeconds * 1000 } : {}) }
}

interface ProtoScan {
  fixed32: Array<{ path: number[]; value: number; order: number }>
  varints: Array<{ path: number[]; value: number }>
  order: number
}

function scanProto(bytes: Uint8Array, path: number[], depth: number, scan: ProtoScan): void {
  if (depth > 8 || bytes.length > MAX_RESPONSE_BYTES) return
  let offset = 0
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset)
    if (!tag || tag.value === 0) return
    offset = tag.next
    const field = tag.value >>> 3
    const wire = tag.value & 7
    const fieldPath = [...path, field]
    if (wire === 0) {
      const value = readVarint(bytes, offset)
      if (!value) return
      scan.varints.push({ path: fieldPath, value: value.value })
      offset = value.next
    } else if (wire === 2) {
      const length = readVarint(bytes, offset)
      if (!length || length.value < 0 || length.next + length.value > bytes.length) return
      const nested = bytes.subarray(length.next, length.next + length.value)
      if (looksLikeProtobuf(nested)) scanProto(nested, fieldPath, depth + 1, scan)
      offset = length.next + length.value
    } else if (wire === 5) {
      if (offset + 4 > bytes.length) return
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4)
      scan.fixed32.push({ path: fieldPath, value: view.getFloat32(0, true), order: scan.order++ })
      offset += 4
    } else if (wire === 1) {
      offset += 8
    } else return
  }
}

function grpcDataFrames(bytes: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = []
  let offset = 0
  while (offset + 5 <= bytes.length) {
    const flags = bytes[offset]
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0, false)
    offset += 5
    if (offset + length > bytes.length) break
    if ((flags & 0x80) === 0 && length > 0) frames.push(bytes.subarray(offset, offset + length))
    offset += length
  }
  return frames
}

function readVarint(bytes: Uint8Array, offset: number): { value: number; next: number } | null {
  let value = 0
  let shift = 0
  for (let index = offset; index < bytes.length && shift <= 49; index += 1, shift += 7) {
    const byte = bytes[index]
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return Number.isSafeInteger(value) ? { value, next: index + 1 } : null
  }
  return null
}

function looksLikeProtobuf(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false
  const tag = readVarint(bytes, 0)
  return Boolean(tag && (tag.value >>> 3) > 0 && [0, 1, 2, 5].includes(tag!.value & 7))
}

function decodeClaims(token: string | undefined): Record<string, unknown> | null {
  const payload = token?.split('.')[1]
  if (!payload) return null
  try {
    return record(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
  } catch {
    return null
  }
}

function trustedAuthEndpoint(value: unknown): string {
  const url = new URL(requiredText(value, 'authorization endpoint'))
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'auth.x.ai' || url.username || url.password) {
    throw new XaiOAuthError('invalid_response', 'xAI discovery returned an untrusted endpoint')
  }
  return url.href
}

function trustedVerificationUrl(value: unknown): string {
  const url = new URL(requiredText(value, 'verification URI'))
  if (url.protocol !== 'https:' || !['auth.x.ai', 'x.ai'].includes(url.hostname.toLowerCase()) || url.username || url.password) {
    throw new XaiOAuthError('invalid_response', 'xAI verification URI was not trusted')
  }
  return url.href
}

async function request(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'user-agent': 'caogen-xai-oauth', ...(init.headers ?? {}) }
    })
  } catch {
    throw new XaiOAuthError('network_error', 'xAI authorization network request failed')
  }
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const length = finiteNumber(response.headers.get('content-length'))
  if (length !== undefined && length > MAX_RESPONSE_BYTES) throw new XaiOAuthError('invalid_response', 'xAI OAuth response was too large')
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new XaiOAuthError('invalid_response', 'xAI OAuth response was too large')
  try {
    const parsed = text ? record(JSON.parse(text)) : null
    if (!parsed) throw new Error('invalid')
    return parsed
  } catch {
    throw new XaiOAuthError('invalid_response', 'xAI OAuth response was invalid')
  }
}

function oauthFailure(status: number, body: Record<string, unknown>): XaiOAuthError {
  return new XaiOAuthError(safeCode(optionalText(body.error)) ?? 'network_error', `xAI OAuth request failed (${status})`)
}

function formHeaders(): Record<string, string> {
  return { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }
}

function requiredText(value: unknown, label: string): string {
  const text = optionalText(value)
  if (!text || text.length > 16_384 || /[\0\r\n]/.test(text)) throw new XaiOAuthError('invalid_response', `xAI ${label} was invalid`)
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

function integerText(value: string | null): number | undefined {
  if (!value || !/^-?\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 100) / 100))
}

function quotaTierName(resetsAt: number | undefined, now: number): string {
  if (!resetsAt) return 'credits'
  const days = Math.round((resetsAt - now) / 86_400_000)
  if (days >= 4 && days <= 12) return 'seven_day'
  if (days >= 20 && days <= 45) return 'thirty_day'
  return 'credits'
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

function samePath(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function startsWithPath(value: number[], prefix: number[]): boolean {
  return value.length >= prefix.length && prefix.every((entry, index) => value[index] === entry)
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
