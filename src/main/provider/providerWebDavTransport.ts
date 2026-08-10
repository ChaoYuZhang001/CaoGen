import {
  authorizeMcpNetworkUrl,
  mcpNetworkErrorMessage,
  requestAuthorizedMcpUrl,
  type AuthorizedMcpNetworkTarget,
  type McpNetworkRequestInit
} from '../mcp/mcp-network-policy'
import { XMLParser } from 'fast-xml-parser'
import {
  MAX_PROVIDER_SYNC_BYTES,
  parseProviderProfileSyncEnvelope,
  providerProfileSyncTextDigest,
  serializeProviderProfileSyncEnvelope,
  type SyncEnvelope
} from './providerProfileSync'

const PROTOCOL_SEGMENTS = ['provider-profile', 'v1']
const CURRENT_FILE = 'current.json'
const HISTORY_DIRECTORY = 'history'
const REQUEST_TIMEOUT_MS = 30_000

export interface ProviderWebDavTransportConfig {
  baseUrl: string
  username: string
  password: string
  remotePath: string
}

export interface ProviderWebDavRemoteSnapshot {
  envelope: SyncEnvelope
  raw: string
  fileDigest: string
  etag?: string
}

export async function testProviderWebDavTransport(config: ProviderWebDavTransportConfig): Promise<void> {
  const context = await transportContext(config)
  const response = await request(context, [], { method: 'PROPFIND', headers: { Depth: '0' } })
  if (!response.ok && response.status !== 207) throw statusError('PROPFIND', response.status)
  await discard(response)
  await ensureRemoteDirectories(context)
}

export async function readProviderWebDavRemote(
  config: ProviderWebDavTransportConfig
): Promise<ProviderWebDavRemoteSnapshot | undefined> {
  const context = await transportContext(config)
  return readRemoteWithContext(context, currentSegments(context))
}

export async function listProviderWebDavHistory(
  config: ProviderWebDavTransportConfig
): Promise<ProviderWebDavRemoteSnapshot[]> {
  const context = await transportContext(config)
  const segments = [...context.remoteSegments, HISTORY_DIRECTORY]
  const response = await request(context, segments, { method: 'PROPFIND', headers: { Depth: '1' } })
  if (!response.ok && response.status !== 207) throw statusError('PROPFIND history', response.status)
  const xml = await boundedResponseText(response, 'WebDAV history response')
  const revisionIds = historyRevisionIds(xml, context.target.url)
  const history: ProviderWebDavRemoteSnapshot[] = []
  for (const revisionId of revisionIds.slice(0, 20)) {
    const snapshot = await readRemoteWithContext(context, [...segments, `${revisionId}.json`])
    if (snapshot) history.push(snapshot)
  }
  return history.sort((left, right) => right.envelope.createdAt.localeCompare(left.envelope.createdAt))
}

export async function readProviderWebDavHistory(
  config: ProviderWebDavTransportConfig,
  revisionId: string
): Promise<ProviderWebDavRemoteSnapshot | undefined> {
  const context = await transportContext(config)
  return readRemoteWithContext(context, [
    ...context.remoteSegments,
    HISTORY_DIRECTORY,
    `${safeRevisionId(revisionId)}.json`
  ])
}

export async function publishProviderWebDavRemote(
  config: ProviderWebDavTransportConfig,
  envelope: SyncEnvelope,
  expected: ProviderWebDavRemoteSnapshot | undefined
): Promise<ProviderWebDavRemoteSnapshot> {
  const context = await transportContext(config)
  await ensureRemoteDirectories(context)
  const raw = serializeProviderProfileSyncEnvelope(envelope)
  await putImmutableHistory(context, envelope.revisionId, raw)
  if (expected && !expected.etag) throw new Error('WebDAV server did not provide an ETag; refusing to overwrite remote configuration')
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    ...(expected ? { 'If-Match': expected.etag as string } : { 'If-None-Match': '*' })
  }
  const response = await request(context, currentSegments(context), { method: 'PUT', headers, body: raw })
  if (response.status === 412) throw new Error('WebDAV remote configuration changed after preview')
  if (!response.ok) throw statusError('PUT', response.status)
  await discard(response)
  const verified = await readRemoteWithContext(context, currentSegments(context))
  if (!verified || verified.envelope.revisionId !== envelope.revisionId
    || verified.envelope.payloadDigest !== envelope.payloadDigest) {
    throw new Error('WebDAV publish verification failed')
  }
  return verified
}

export function normalizeProviderWebDavConfig(input: ProviderWebDavTransportConfig): ProviderWebDavTransportConfig {
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const username = boundedText(input.username, 512, 'WebDAV username', true).trim()
  const password = boundedText(input.password, 8_192, 'WebDAV password', true)
  if (!username && password) throw new Error('WebDAV username is required when a password is provided')
  return { baseUrl, username, password, remotePath: normalizeRemotePath(input.remotePath) }
}

export function providerWebDavEndpointLabel(baseUrl: string): string {
  const url = new URL(normalizeBaseUrl(baseUrl))
  return url.port ? `${url.hostname}:${url.port}` : url.hostname
}

interface TransportContext {
  target: AuthorizedMcpNetworkTarget
  authHeader?: string
  remoteSegments: string[]
}

async function transportContext(config: ProviderWebDavTransportConfig): Promise<TransportContext> {
  const normalized = normalizeProviderWebDavConfig(config)
  let target: AuthorizedMcpNetworkTarget
  try {
    target = await authorizeMcpNetworkUrl(normalized.baseUrl)
  } catch (error) {
    throw new Error(`WebDAV endpoint rejected: ${mcpNetworkErrorMessage(error)}`)
  }
  return {
    target,
    authHeader: normalized.username
      ? `Basic ${Buffer.from(`${normalized.username}:${normalized.password}`, 'utf8').toString('base64')}`
      : undefined,
    remoteSegments: [...pathSegments(normalized.remotePath), ...PROTOCOL_SEGMENTS]
  }
}

async function ensureRemoteDirectories(context: TransportContext): Promise<void> {
  for (let index = 1; index <= context.remoteSegments.length; index += 1) {
    const response = await request(context, context.remoteSegments.slice(0, index), { method: 'MKCOL' })
    if (!response.ok && response.status !== 405) throw statusError('MKCOL', response.status)
    await discard(response)
  }
  const history = await request(context, [...context.remoteSegments, HISTORY_DIRECTORY], { method: 'MKCOL' })
  if (!history.ok && history.status !== 405) throw statusError('MKCOL', history.status)
  await discard(history)
}

async function putImmutableHistory(context: TransportContext, revisionId: string, raw: string): Promise<void> {
  const segments = [...context.remoteSegments, HISTORY_DIRECTORY, `${safeRevisionId(revisionId)}.json`]
  const response = await request(context, segments, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'If-None-Match': '*' },
    body: raw
  })
  if (response.ok) {
    await discard(response)
    return
  }
  if (response.status !== 412) throw statusError('PUT history', response.status)
  await discard(response)
  const existing = await readRemoteWithContext(context, segments)
  if (!existing || existing.fileDigest !== providerProfileSyncTextDigest(raw)) {
    throw new Error('WebDAV history revision already exists with different content')
  }
}

async function readRemoteWithContext(
  context: TransportContext,
  segments: string[]
): Promise<ProviderWebDavRemoteSnapshot | undefined> {
  const response = await request(context, segments, { method: 'GET' })
  if (response.status === 404) {
    await discard(response)
    return undefined
  }
  if (!response.ok) throw statusError('GET', response.status)
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_SYNC_BYTES) {
    throw new Error('WebDAV Provider sync response exceeds 4 MB')
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_PROVIDER_SYNC_BYTES) throw new Error('WebDAV Provider sync response exceeds 4 MB')
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const envelope = parseProviderProfileSyncEnvelope(raw)
  return {
    envelope,
    raw,
    fileDigest: providerProfileSyncTextDigest(raw),
    etag: normalizedEtag(response.headers.get('etag'))
  }
}

function request(context: TransportContext, relativeSegments: string[], init: McpNetworkRequestInit): Promise<Response> {
  const url = buildUrl(context.target.url, relativeSegments)
  const headers = new Headers(init.headers)
  if (context.authHeader) headers.set('Authorization', context.authHeader)
  return requestAuthorizedMcpUrl(context.target, url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    maxRedirects: 2
  }).then((result) => result.response).catch((error) => {
    throw new Error(`WebDAV request failed: ${mcpNetworkErrorMessage(error)}`)
  })
}

function buildUrl(baseUrl: URL, segments: string[]): URL {
  const url = new URL(baseUrl.toString())
  const basePath = url.pathname.replace(/\/+$/, '')
  const appended = segments.map((segment) => encodeURIComponent(segment)).join('/')
  url.pathname = appended ? `${basePath}/${appended}` : `${basePath}/`
  return url
}

function currentSegments(context: TransportContext): string[] {
  return [...context.remoteSegments, CURRENT_FILE]
}

function pathSegments(value: string): string[] {
  return value.split('/').filter(Boolean)
}

function historyRevisionIds(xml: string, baseUrl: URL): string[] {
  let parsed: unknown
  try {
    parsed = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false }).parse(xml)
  } catch {
    throw new Error('WebDAV history response is invalid XML')
  }
  const responses = (parsed as { multistatus?: { response?: unknown } })?.multistatus?.response
  const items = Array.isArray(responses) ? responses : responses ? [responses] : []
  const revisions = new Set<string>()
  for (const item of items) {
    const href = (item as { href?: unknown })?.href
    if (typeof href !== 'string') continue
    let name = ''
    try { name = decodeURIComponent(new URL(href, baseUrl).pathname.split('/').filter(Boolean).pop() ?? '') } catch { continue }
    if (!name.endsWith('.json')) continue
    const revisionId = name.slice(0, -5)
    try { revisions.add(safeRevisionId(revisionId)) } catch { /* ignore unrelated objects */ }
  }
  return [...revisions]
}

async function boundedResponseText(response: Response, label: string): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_SYNC_BYTES) throw new Error(`${label} exceeds 4 MB`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_PROVIDER_SYNC_BYTES) throw new Error(`${label} exceeds 4 MB`)
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function normalizeBaseUrl(value: string): string {
  const raw = boundedText(value, 2_048, 'WebDAV URL')
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('WebDAV URL is invalid') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('WebDAV URL must use HTTP(S) without credentials, query, or fragment')
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString()
}

function normalizeRemotePath(value: string): string {
  const raw = boundedText(value || 'caogen-sync', 512, 'WebDAV remote path')
  const segments = raw.replace(/\\/g, '/').split('/').filter(Boolean)
  if (segments.length === 0 || segments.length > 12
    || segments.some((segment) => segment === '.' || segment === '..' || /[\0-\x1f\x7f]/.test(segment))) {
    throw new Error('WebDAV remote path is invalid')
  }
  return segments.join('/')
}

function boundedText(value: string, maxLength: number, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maxLength || /[\0\r\n]/.test(value)) throw new Error(`${label} is invalid`)
  const normalized = allowEmpty ? value : value.trim()
  if (!allowEmpty && !normalized) throw new Error(`${label} is required`)
  return normalized
}

function safeRevisionId(value: string): string {
  if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(value)) throw new Error('Provider sync revision is invalid')
  return value
}

function normalizedEtag(value: string | null): string | undefined {
  if (!value || value.length > 512 || /[\0\r\n]/.test(value)) return undefined
  return value
}

function statusError(operation: string, status: number): Error {
  if (status === 401 || status === 403) return new Error('WebDAV authentication or write permission failed')
  if (status === 412) return new Error('WebDAV remote configuration changed')
  return new Error(`WebDAV ${operation} failed with HTTP ${status}`)
}

async function discard(response: Response): Promise<void> {
  try { await response.arrayBuffer() } catch { /* best effort */ }
}
