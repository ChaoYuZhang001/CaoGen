import { lookup } from 'node:dns/promises'
import { request as httpRequest, type ClientRequest, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { Readable } from 'node:stream'

export type McpNetworkMode = 'public' | 'loopback'

export interface McpResolvedAddress {
  address: string
  family: 4 | 6
}

export type McpDnsResolver = (hostname: string) => Promise<McpResolvedAddress[]>

export interface McpNetworkPolicyOptions {
  resolve?: McpDnsResolver
}

export interface AuthorizedMcpNetworkTarget {
  url: URL
  origin: string
  hostname: string
  mode: McpNetworkMode
  addresses: readonly McpResolvedAddress[]
}

export interface McpNetworkRequestInit {
  method?: string
  headers?: ConstructorParameters<typeof Headers>[0]
  body?: string | Uint8Array
  signal?: AbortSignal
  maxRedirects?: number
}

export interface McpNetworkResponse {
  response: Response
  finalUrl: URL
}

type McpNetworkErrorCode =
  | 'invalid_url'
  | 'invalid_scheme'
  | 'embedded_credentials'
  | 'fragment_not_allowed'
  | 'noncanonical_ipv4'
  | 'ipv6_zone_not_allowed'
  | 'public_https_required'
  | 'dns_failed'
  | 'address_not_allowed'
  | 'redirect_cross_origin'
  | 'redirect_limit'
  | 'redirect_method'
  | 'sse_endpoint_cross_origin'
  | 'invalid_headers'
  | 'request_aborted'
  | 'request_failed'

const ERROR_MESSAGES: Record<McpNetworkErrorCode, string> = {
  invalid_url: 'MCP network URL is invalid',
  invalid_scheme: 'MCP network URL scheme is not allowed',
  embedded_credentials: 'MCP network URL credentials are not allowed',
  fragment_not_allowed: 'MCP network URL fragments are not allowed',
  noncanonical_ipv4: 'MCP network URL uses a noncanonical IPv4 address',
  ipv6_zone_not_allowed: 'MCP network URL IPv6 zone identifiers are not allowed',
  public_https_required: 'Public MCP network URLs must use HTTPS',
  dns_failed: 'MCP network DNS validation failed',
  address_not_allowed: 'MCP network target address is not allowed',
  redirect_cross_origin: 'MCP network redirect crossed the authorized origin',
  redirect_limit: 'MCP network redirect limit exceeded',
  redirect_method: 'MCP network redirect method change is not allowed',
  sse_endpoint_cross_origin: 'MCP SSE endpoint crossed the authorized origin',
  invalid_headers: 'MCP network request headers are invalid',
  request_aborted: 'MCP network request was aborted',
  request_failed: 'MCP network request failed'
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const FORBIDDEN_REQUEST_HEADERS = [
  'accept-encoding',
  'connection',
  'content-length',
  'expect',
  'host',
  'proxy-authorization',
  'proxy-connection',
  'transfer-encoding',
  'upgrade'
]
const MAX_RESOLVED_ADDRESSES = 16
const DEFAULT_MAX_REDIRECTS = 3
const NON_PUBLIC_IPV4_CIDRS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const

class McpNetworkPolicyError extends Error {
  readonly code: McpNetworkErrorCode

  constructor(code: McpNetworkErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'McpNetworkPolicyError'
    this.code = code
  }
}

export async function authorizeMcpNetworkUrl(
  input: string | URL,
  options: McpNetworkPolicyOptions = {}
): Promise<AuthorizedMcpNetworkTarget> {
  const url = parseMcpUrl(input)
  const hostname = normalizedHostname(url)
  const policyHostname = hostname.replace(/\.$/, '')
  const family = isIP(policyHostname)
  const mode = explicitLoopbackHost(policyHostname, family) ? 'loopback' : 'public'
  if (mode === 'public' && url.protocol !== 'https:') throw networkError('public_https_required')

  const addresses = family === 4 || family === 6
    ? [{ address: policyHostname, family } as McpResolvedAddress]
    : await resolveHost(hostname, options.resolve ?? defaultResolver)
  assertAddressesAllowed(mode, addresses)
  const ordered = orderAddresses(addresses)
  return Object.freeze({
    url,
    origin: url.origin,
    hostname,
    mode,
    addresses: Object.freeze(ordered)
  })
}

export function resolveMcpSseEndpoint(
  target: AuthorizedMcpNetworkTarget,
  baseUrl: URL,
  endpointValue: string
): URL {
  const endpoint = parseMcpUrl(endpointValue, baseUrl)
  if (endpoint.origin !== target.origin) throw networkError('sse_endpoint_cross_origin')
  return endpoint
}

export async function requestMcpNetworkUrl(
  input: string | URL,
  init: McpNetworkRequestInit = {},
  options: McpNetworkPolicyOptions = {}
): Promise<McpNetworkResponse> {
  const target = await authorizeMcpNetworkUrl(input, options)
  return requestAuthorizedMcpUrl(target, target.url, init)
}

export async function requestAuthorizedMcpUrl(
  target: AuthorizedMcpNetworkTarget,
  input: string | URL,
  init: McpNetworkRequestInit = {}
): Promise<McpNetworkResponse> {
  let url = parseMcpUrl(input, target.url)
  if (url.origin !== target.origin) throw networkError('redirect_cross_origin')
  const maxRedirects = normalizedRedirectLimit(init.maxRedirects)
  const method = (init.method ?? 'GET').toUpperCase()
  const body = normalizeBody(init.body)

  for (let redirects = 0; ; redirects += 1) {
    const response = await requestOnce(target, url, { ...init, method, body })
    if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: url }
    const location = response.headers.get('location')
    if (!location) return { response, finalUrl: url }
    await discardResponseBody(response)
    if (redirects >= maxRedirects) throw networkError('redirect_limit')
    if (method !== 'GET' && method !== 'HEAD' && response.status !== 307 && response.status !== 308) {
      throw networkError('redirect_method')
    }
    const next = parseMcpUrl(location, url)
    if (next.origin !== target.origin) throw networkError('redirect_cross_origin')
    url = next
  }
}

export function mcpNetworkErrorMessage(error: unknown): string {
  return error instanceof McpNetworkPolicyError ? error.message : ERROR_MESSAGES.request_failed
}

function parseMcpUrl(input: string | URL, base?: URL): URL {
  const raw = normalizedUrlInput(input)
  const rawHost = rawAuthorityHost(raw)
  assertNoIpv6Zone(rawHost)
  const url = constructMcpUrl(raw, base)
  assertMcpUrlShape(url, rawHost)
  return url
}

function normalizedUrlInput(input: string | URL): string {
  const raw = input instanceof URL ? input.toString() : input
  if (typeof raw !== 'string' || raw !== raw.trim() || /[\0\r\n]/.test(raw)) {
    throw networkError('invalid_url')
  }
  return raw
}

function assertNoIpv6Zone(rawHost: string | undefined): void {
  if (rawHost?.includes('%')) throw networkError('ipv6_zone_not_allowed')
}

function constructMcpUrl(raw: string, base?: URL): URL {
  try {
    return base ? new URL(raw, base) : new URL(raw)
  } catch {
    throw networkError('invalid_url')
  }
}

function assertMcpUrlShape(url: URL, rawHost: string | undefined): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw networkError('invalid_scheme')
  if (url.username || url.password) throw networkError('embedded_credentials')
  if (url.hash) throw networkError('fragment_not_allowed')
  const hostname = normalizedHostname(url)
  if (!hostname) throw networkError('invalid_url')
  if (isIP(hostname) === 4 && rawHost && rawHost.toLowerCase() !== hostname.toLowerCase()) {
    throw networkError('noncanonical_ipv4')
  }
}

function rawAuthorityHost(raw: string): string | undefined {
  const match = /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/([^/?#]*)/.exec(raw)
  if (!match) return undefined
  const authority = match[1].slice(match[1].lastIndexOf('@') + 1)
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']')
    return close >= 0 ? authority.slice(0, close + 1) : authority
  }
  const colon = authority.lastIndexOf(':')
  return colon >= 0 ? authority.slice(0, colon) : authority
}

function normalizedHostname(url: URL): string {
  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname
  return hostname.toLowerCase()
}

function explicitLoopbackHost(hostname: string, family: number): boolean {
  if (family === 4 || family === 6) return isLoopbackAddress(hostname)
  return hostname === 'localhost' || hostname.endsWith('.localhost')
}

async function defaultResolver(hostname: string): Promise<McpResolvedAddress[]> {
  const resolved = await lookup(hostname, { all: true, verbatim: true })
  return resolved.flatMap((item) => item.family === 4 || item.family === 6
    ? [{ address: item.address, family: item.family }]
    : [])
}

async function resolveHost(hostname: string, resolver: McpDnsResolver): Promise<McpResolvedAddress[]> {
  let resolved: McpResolvedAddress[]
  try {
    resolved = await resolver(hostname)
  } catch {
    throw networkError('dns_failed')
  }
  if (!Array.isArray(resolved) || resolved.length === 0 || resolved.length > MAX_RESOLVED_ADDRESSES) {
    throw networkError('dns_failed')
  }
  const unique = new Map<string, McpResolvedAddress>()
  for (const item of resolved) {
    if (!item || (item.family !== 4 && item.family !== 6) || isIP(item.address) !== item.family || item.address.includes('%')) {
      throw networkError('dns_failed')
    }
    unique.set(`${item.family}:${item.address}`, { address: item.address, family: item.family })
  }
  return [...unique.values()]
}

function assertAddressesAllowed(mode: McpNetworkMode, addresses: McpResolvedAddress[]): void {
  const allowed = mode === 'loopback'
    ? addresses.every((item) => isLoopbackAddress(item.address))
    : addresses.every((item) => isPublicAddress(item.address))
  if (!allowed) throw networkError('address_not_allowed')
}

function orderAddresses(addresses: McpResolvedAddress[]): McpResolvedAddress[] {
  return [...addresses].sort((left, right) => left.family - right.family)
}

function isLoopbackAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return ipv4Bytes(address)?.[0] === 127
  if (family !== 6) return false
  const bytes = ipv6Bytes(address)
  if (!bytes) return false
  if (bytes.slice(0, 15).every((value) => value === 0) && bytes[15] === 1) return true
  const mapped = mappedIpv4Bytes(bytes)
  return mapped?.[0] === 127
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isPublicIpv4(ipv4Bytes(address))
  if (family !== 6) return false
  const bytes = ipv6Bytes(address)
  if (!bytes) return false
  const mapped = mappedIpv4Bytes(bytes)
  if (mapped) return isPublicIpv4(mapped)
  if ((bytes[0] & 0xe0) !== 0x20) return false
  if (hasPrefix(bytes, [0x20, 0x01, 0x00, 0x00], 32)) return false
  if (hasPrefix(bytes, [0x20, 0x01, 0x00, 0x02, 0x00, 0x00], 48)) return false
  if (hasPrefix(bytes, [0x20, 0x01, 0x00, 0x10], 28)) return false
  if (hasPrefix(bytes, [0x20, 0x01, 0x00, 0x20], 28)) return false
  if (hasPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) return false
  if (hasPrefix(bytes, [0x3f, 0xff, 0x00], 20)) return false
  if (hasPrefix(bytes, [0x20, 0x02], 16)) return isPublicIpv4(bytes.slice(2, 6))
  return true
}

function isPublicIpv4(bytes: number[] | null): boolean {
  if (!bytes) return false
  return !NON_PUBLIC_IPV4_CIDRS.some(([network, prefix]) => ipv4MatchesCidr(bytes, network, prefix))
}

function ipv4MatchesCidr(bytes: number[], network: string, prefix: number): boolean {
  const networkBytes = ipv4Bytes(network)
  if (!networkBytes) return false
  const mask = (0xffffffff << (32 - prefix)) >>> 0
  return (ipv4Number(bytes) & mask) === (ipv4Number(networkBytes) & mask)
}

function ipv4Number(bytes: number[]): number {
  return (((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3]) >>> 0
}

function ipv4Bytes(address: string): number[] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const bytes = parts.map((part) => Number(part))
  return bytes.every((value) => Number.isInteger(value) && value >= 0 && value <= 255) ? bytes : null
}

function ipv6Bytes(address: string): number[] | null {
  if (address.includes('%') || isIP(address) !== 6) return null
  let normalized = address.toLowerCase()
  if (normalized.includes('.')) {
    const colon = normalized.lastIndexOf(':')
    const tail = ipv4Bytes(normalized.slice(colon + 1))
    if (!tail) return null
    normalized = `${normalized.slice(0, colon)}:${((tail[0] << 8) | tail[1]).toString(16)}:${((tail[2] << 8) | tail[3]).toString(16)}`
  }
  const halves = normalized.split('::')
  if (halves.length > 2) return null
  const head = wordList(halves[0])
  const tail = halves.length === 2 ? wordList(halves[1]) : []
  if (!head || !tail) return null
  const missing = 8 - head.length - tail.length
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null
  const words = [...head, ...Array.from({ length: missing }, () => 0), ...tail]
  return words.flatMap((word) => [word >> 8, word & 0xff])
}

function wordList(value: string): number[] | null {
  if (!value) return []
  const words = value.split(':').map((word) => Number.parseInt(word, 16))
  return words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff) ? words : null
}

function mappedIpv4Bytes(bytes: number[]): number[] | null {
  if (bytes.length !== 16 || !bytes.slice(0, 10).every((value) => value === 0)) return null
  return bytes[10] === 0xff && bytes[11] === 0xff ? bytes.slice(12, 16) : null
}

function hasPrefix(bytes: number[], prefix: number[], bits: number): boolean {
  const fullBytes = Math.floor(bits / 8)
  const remainingBits = bits % 8
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== prefix[index]) return false
  }
  if (remainingBits === 0) return true
  const mask = 0xff << (8 - remainingBits)
  return (bytes[fullBytes] & mask) === (prefix[fullBytes] & mask)
}

function normalizedRedirectLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_REDIRECTS
  return Math.max(0, Math.min(5, Math.floor(value as number)))
}

function normalizeBody(value: string | Uint8Array | undefined): Buffer | undefined {
  if (typeof value === 'string') return Buffer.from(value)
  if (value instanceof Uint8Array) return Buffer.from(value)
  return undefined
}

async function requestOnce(
  target: AuthorizedMcpNetworkTarget,
  url: URL,
  init: McpNetworkRequestInit & { method: string; body?: Buffer }
): Promise<Response> {
  if (init.signal?.aborted) throw networkError('request_aborted')
  const address = target.addresses[0]
  const headers = requestHeaders(url, init.headers, init.body)
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest
  const options = requestOptions(target, url, init.method, headers, address)

  return await new Promise<Response>((resolvePromise, rejectPromise) => {
    let settled = false
    let req: ClientRequest
    try {
      req = request(options, (incoming) => {
        if (settled) return
        try {
          const response = responseFromIncoming(incoming, init.method)
          settled = true
          const abort = (): void => {
            incoming.destroy()
          }
          init.signal?.addEventListener('abort', abort, { once: true })
          incoming.once('close', () => init.signal?.removeEventListener('abort', abort))
          resolvePromise(response)
        } catch {
          incoming.destroy()
          settled = true
          rejectPromise(networkError('request_failed'))
        }
      })
    } catch {
      rejectPromise(networkError('request_failed'))
      return
    }
    const abort = (): void => {
      req.destroy()
    }
    init.signal?.addEventListener('abort', abort, { once: true })
    req.once('error', () => {
      init.signal?.removeEventListener('abort', abort)
      if (settled) return
      settled = true
      rejectPromise(networkError(init.signal?.aborted ? 'request_aborted' : 'request_failed'))
    })
    req.once('close', () => init.signal?.removeEventListener('abort', abort))
    try {
      if (init.body) req.write(init.body)
      req.end()
    } catch {
      req.destroy()
      if (!settled) {
        settled = true
        rejectPromise(networkError('request_failed'))
      }
    }
  })
}

function requestHeaders(
  url: URL,
  input: ConstructorParameters<typeof Headers>[0] | undefined,
  body: Buffer | undefined
): Record<string, string> {
  let headers: Headers
  try {
    headers = new Headers(input)
  } catch {
    throw networkError('invalid_headers')
  }
  for (const name of FORBIDDEN_REQUEST_HEADERS) headers.delete(name)
  headers.set('accept-encoding', 'identity')
  headers.set('host', url.host)
  if (body) headers.set('content-length', String(body.byteLength))
  return Object.fromEntries(headers.entries())
}

function requestOptions(
  target: AuthorizedMcpNetworkTarget,
  url: URL,
  method: string,
  headers: Record<string, string>,
  address: McpResolvedAddress
): RequestOptions {
  const lookupPinned: LookupFunction = (_hostname, _options, callback) => {
    callback(null, address.address, address.family)
  }
  const options: RequestOptions = {
    protocol: url.protocol,
    hostname: target.hostname,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    method,
    headers,
    family: address.family,
    lookup: lookupPinned
  }
  if (url.protocol === 'https:') {
    Object.assign(options, {
      rejectUnauthorized: true,
      ...(isIP(target.hostname) === 0 ? { servername: target.hostname } : {})
    })
  }
  return options
}

function responseFromIncoming(incoming: import('node:http').IncomingMessage, method: string): Response {
  const status = incoming.statusCode ?? 500
  const headers = new Headers()
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item)
    else if (typeof value === 'string') headers.set(name, value)
  }
  const noBody = method === 'HEAD' || status === 204 || status === 205 || status === 304
  if (noBody) incoming.resume()
  const body = noBody ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>
  try {
    return new Response(body, { status, headers })
  } catch {
    incoming.destroy()
    throw networkError('request_failed')
  }
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The response is being discarded after a validated redirect.
  }
}

function networkError(code: McpNetworkErrorCode): McpNetworkPolicyError {
  return new McpNetworkPolicyError(code)
}
