import { createHash } from 'node:crypto'
import type { ImportedProviderUsageRollup } from '../../shared/provider-usage-types'

const DOCUMENT_KIND = 'caogen-cc-switch-usage-rollups'
const DOCUMENT_VERSION = 1
const SOURCE_ID = /^[a-f0-9]{24}$/
const MAX_ROWS = 50_000

export interface CcSwitchUsageDocument {
  kind: typeof DOCUMENT_KIND
  schemaVersion: typeof DOCUMENT_VERSION
  rows: ImportedProviderUsageRollup[]
  payloadDigest: string
}

export function createCcSwitchUsageDocument(rows: ImportedProviderUsageRollup[]): CcSwitchUsageDocument {
  const payload: Omit<CcSwitchUsageDocument, 'payloadDigest'> = {
    kind: DOCUMENT_KIND,
    schemaVersion: DOCUMENT_VERSION,
    rows
  }
  return { ...payload, payloadDigest: digest(payload) }
}

export function parseCcSwitchUsageDocument(value: unknown): CcSwitchUsageDocument {
  if (!isObject(value) || value.kind !== DOCUMENT_KIND || value.schemaVersion !== DOCUMENT_VERSION
    || !Array.isArray(value.rows) || value.rows.length > MAX_ROWS || typeof value.payloadDigest !== 'string') {
    throw new Error('cc_switch_usage_document_invalid')
  }
  const rows = value.rows.map(parseRollup)
  const document = createCcSwitchUsageDocument(rows)
  if (document.payloadDigest !== value.payloadDigest) throw new Error('cc_switch_usage_document_digest_invalid')
  return document
}

function parseRollup(value: unknown): ImportedProviderUsageRollup {
  if (!isObject(value)) throw new Error('cc_switch_usage_row_invalid')
  const sourceProviderId = requiredText(value.sourceProviderId, 24)
  if (!SOURCE_ID.test(sourceProviderId)) throw new Error('cc_switch_usage_provider_invalid')
  const averageLatencyMs = optionalNumber(value.averageLatencyMs)
  return {
    sourceProviderId,
    providerName: requiredText(value.providerName, 120),
    source: requiredText(value.source, 80),
    model: requiredText(value.model, 200),
    dayStartedAt: nonNegativeInteger(value.dayStartedAt),
    requestCount: nonNegativeInteger(value.requestCount),
    successCount: nonNegativeInteger(value.successCount),
    inputTokens: nonNegativeInteger(value.inputTokens),
    outputTokens: nonNegativeInteger(value.outputTokens),
    cacheReadTokens: nonNegativeInteger(value.cacheReadTokens),
    cacheWriteTokens: nonNegativeInteger(value.cacheWriteTokens),
    costUsd: nonNegativeNumber(value.costUsd),
    ...(averageLatencyMs === undefined ? {} : { averageLatencyMs })
  }
}

function requiredText(value: unknown, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error('cc_switch_usage_text_invalid')
  }
  return text
}

function nonNegativeInteger(value: unknown): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('cc_switch_usage_integer_invalid')
  return number
}

function nonNegativeNumber(value: unknown): number {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) throw new Error('cc_switch_usage_number_invalid')
  return number
}

function optionalNumber(value: unknown): number | undefined {
  return value === undefined ? undefined : nonNegativeNumber(value)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
