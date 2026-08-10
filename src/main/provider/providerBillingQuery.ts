import type {
  ProviderBillingPeriodFormat,
  ProviderBillingPeriodParameter,
  ProviderBillingQueryConfig,
  ProviderBillingQueryResponseConfig,
  ProviderBillingSyncInput
} from '../../shared/provider-billing-query-types'
import type { Provider } from '../../shared/types'

const MAX_BILLING_ITEMS = 2_000
const MAX_RESPONSE_BYTES = 512 * 1024
const REQUEST_TIMEOUT_MS = 20_000

export type ProviderBillingFetchResult =
  | { status: 'ready'; billedCostUsd: number }
  | { status: 'expired' | 'unavailable'; errorCode: string }

export function buildProviderBillingRequest(
  baseUrl: string,
  config: ProviderBillingQueryConfig,
  period: Pick<ProviderBillingSyncInput, 'periodStart' | 'periodEnd'>
): { url: URL; init: RequestInit & { headers: Record<string, string> } } | undefined {
  try {
    const base = new URL(baseUrl)
    const url = new URL(config.path, base)
    if (url.origin !== base.origin || url.username || url.password || url.hash) return undefined
    for (const [key, value] of Object.entries(config.query ?? {})) url.searchParams.set(key, value)
    const body = cloneBody(config.body)
    injectPeriod(url, body, config.periodStart, period.periodStart)
    injectPeriod(url, body, config.periodEnd, period.periodEnd)
    const headers = { ...(config.headers ?? {}) }
    const hasBody = Object.keys(body).length > 0
    if (hasBody && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json'
    }
    return {
      url,
      init: {
        method: config.method ?? 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(hasBody ? { body: JSON.stringify(body) } : {})
      }
    }
  } catch {
    return undefined
  }
}

export function extractProviderBilledCostUsd(
  root: unknown,
  config: ProviderBillingQueryResponseConfig
): number | undefined {
  const itemRoot = readPointer(root, config.itemsPath)
  if (itemRoot === undefined) return undefined
  const entries = Array.isArray(itemRoot) ? itemRoot : [itemRoot]
  if (entries.length === 0 || entries.length > MAX_BILLING_ITEMS) return undefined
  let total = 0
  for (const entry of entries) {
    const amount = finiteNumber(readPointer(entry, config.amountPath))
    if (amount === undefined || amount < 0) return undefined
    const rawCurrency = config.currency ?? textValue(readPointer(entry, config.currencyPath))
    if (rawCurrency?.toUpperCase() !== 'USD') return undefined
    total += amount * (config.scale ?? 1)
    if (!Number.isFinite(total) || total > 1_000_000_000) return undefined
  }
  return round(total)
}

export function resolveProviderBillingKeyId(
  provider: Pick<Provider, 'apiKeys'>,
  label: string | undefined
): string | undefined {
  if (!label) return undefined
  const matches = (provider.apiKeys ?? []).filter((key) => !key.disabled && key.label === label)
  return matches.length === 1 ? matches[0].id : undefined
}

export async function executeProviderBillingRequest(
  request: { url: URL; init: RequestInit & { headers: Record<string, string> } },
  responseConfig: ProviderBillingQueryResponseConfig,
  fetchImpl: (url: string, init: RequestInit & { headers: Record<string, string> }) => Promise<Response>
): Promise<ProviderBillingFetchResult> {
  try {
    const response = await fetchImpl(request.url.toString(), request.init)
    if (response.redirected) return { status: 'unavailable', errorCode: 'redirect_blocked' }
    if (response.url) {
      const responseUrl = new URL(response.url)
      if (responseUrl.origin !== request.url.origin) {
        return { status: 'unavailable', errorCode: 'cross_origin_response_blocked' }
      }
    }
    if (response.status === 401 || response.status === 403) {
      return { status: 'expired', errorCode: 'authorization_expired' }
    }
    if (response.status >= 300 && response.status < 400) {
      return { status: 'unavailable', errorCode: 'redirect_blocked' }
    }
    if (!response.ok) return { status: 'unavailable', errorCode: `http_${response.status}` }
    const length = finiteNumber(response.headers.get('content-length'))
    if (length !== undefined && length > MAX_RESPONSE_BYTES) {
      return { status: 'unavailable', errorCode: 'response_too_large' }
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_RESPONSE_BYTES) {
      return { status: 'unavailable', errorCode: 'response_too_large' }
    }
    let root: unknown
    try {
      root = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      return { status: 'unavailable', errorCode: 'invalid_json' }
    }
    const billedCostUsd = extractProviderBilledCostUsd(root, responseConfig)
    return billedCostUsd === undefined
      ? { status: 'unavailable', errorCode: 'invalid_response' }
      : { status: 'ready', billedCostUsd }
  } catch {
    return { status: 'unavailable', errorCode: 'network_error' }
  }
}

function injectPeriod(
  url: URL,
  body: Record<string, unknown>,
  parameter: ProviderBillingPeriodParameter,
  value: number
): void {
  const formatted = formatPeriod(value, parameter.format)
  if (parameter.target === 'query') url.searchParams.set(parameter.name, String(formatted))
  else writePointer(body, parameter.path, formatted)
}

function writePointer(root: Record<string, unknown>, pointer: string, value: string | number): void {
  const segments = pointer.slice(1).split('/').map((segment) =>
    segment.replace(/~1/g, '/').replace(/~0/g, '~'))
  let current = root
  for (const [index, segment] of segments.entries()) {
    if (!segment || ['__proto__', 'prototype', 'constructor'].includes(segment.toLowerCase())) {
      throw new Error('Provider billing period body path is unsafe')
    }
    if (index === segments.length - 1) {
      current[segment] = value
      return
    }
    const child = current[segment]
    if (child === undefined) current[segment] = {}
    else if (!child || typeof child !== 'object' || Array.isArray(child)) {
      throw new Error('Provider billing period body path conflicts with the static request body')
    }
    current = current[segment] as Record<string, unknown>
  }
}

function formatPeriod(value: number, format: ProviderBillingPeriodFormat): string | number {
  if (format === 'unix-seconds') return Math.floor(value / 1_000)
  if (format === 'unix-ms') return value
  return new Date(value).toISOString()
}

function cloneBody(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return value ? JSON.parse(JSON.stringify(value)) as Record<string, unknown> : {}
}

function readPointer(root: unknown, pointer: string | undefined): unknown {
  if (!pointer) return root
  let current = root
  for (const rawSegment of pointer.slice(1).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) return undefined
      current = current[index]
    } else if (current && typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment]
    } else return undefined
  }
  return current
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) ? number : undefined
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 32) : undefined
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
