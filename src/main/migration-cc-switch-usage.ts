import { existsSync, lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { MigrationAsset, MigrationScan } from '../shared/types'
import { containsSensitiveText, sha256, targetFingerprint } from './migration-safety'
import type { InternalMigrationAsset } from './migration-scan-store'
import { ccSwitchSourceProviderId } from './provider/ccSwitchIdentity'
import { createCcSwitchUsageDocument, type CcSwitchUsageDocument } from './provider/ccSwitchUsageDocument'

type MigrationDiagnostic = MigrationScan['diagnostics'][number]

interface UsageScanContext {
  home: string
  assets: InternalMigrationAsset[]
  diagnostics: MigrationDiagnostic[]
}

interface UsageRow {
  date: string
  appType: string
  providerId: string
  providerName: string
  model: string
  requestCount: number
  successCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  averageLatencyMs?: number
}

const MAX_DATABASE_BYTES = 512 * 1024 * 1024
const MAX_USAGE_ROWS = 50_000

export function addCcSwitchUsageAsset(
  context: UsageScanContext,
  databasePath: string,
  database: DatabaseSync
): void {
  if (!tableExists(database, 'usage_daily_rollups')) return
  try {
    const document = readUsageDocument(database)
    if (document.rows.length === 0) return
    const targetPath = join(context.home, '.caogen', 'usage', 'cc-switch-daily-rollups.json')
    const targetBytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8')
    const fingerprint = targetFingerprint(targetPath)
    const conflict = usageConflict(fingerprint, sha256(targetBytes))
    const blocked = conflict === 'unsupported'
    const asset: MigrationAsset = {
      id: `cc-switch:usage:${document.payloadDigest.slice(0, 24)}`,
      agent: 'CC Switch',
      kind: 'usage',
      scope: 'user',
      path: 'CC Switch / Usage / Daily rollups',
      name: 'CC Switch historical usage',
      sourceDigest: document.payloadDigest,
      sizeBytes: targetBytes.length,
      preview: `${document.rows.length} daily Provider/model rollups; request content, errors, sessions, URLs and credentials are excluded.`,
      targetPath,
      conflict,
      ...(conflict === 'replace_required' ? { conflictDetail: 'Existing imported history will be replaced after confirmation.' } : {}),
      ignoredFields: ['error_message', 'input_token_semantics', 'request_id', 'session_id'],
      risk: blocked ? 'blocked' : 'review',
      riskReasons: [
        'Imported history affects Provider usage totals and trends.',
        ...(blocked ? ['The target is not a regular JSON file.'] : [])
      ],
      importable: !blocked && conflict !== 'duplicate',
      recommended: false,
      supportedActions: blocked || conflict === 'duplicate'
        ? ['skip']
        : conflict === 'replace_required' ? ['replace', 'skip'] : ['import', 'skip']
    }
    context.assets.push({
      asset,
      sourceRoot: resolve(databasePath, '..'),
      sourcePath: databasePath,
      targetRoot: context.home,
      targetPath,
      targetFingerprint: fingerprint,
      targetBytes,
      readSourceDigest: () => readUsageDocumentFromPath(databasePath).payloadDigest
    })
  } catch (error) {
    context.diagnostics.push({ code: publicError(error), message: 'CC Switch historical usage could not be mapped safely.' })
  }
}

function readUsageDocument(database: DatabaseSync): CcSwitchUsageDocument {
  const names = readProviderNames(database)
  const rawRows = database.prepare(`
    SELECT date, app_type, provider_id, model, request_model, pricing_model,
      request_count, success_count, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, total_cost_usd, avg_latency_ms
    FROM usage_daily_rollups
    WHERE app_type IN ('claude', 'codex')
    ORDER BY date, app_type, provider_id, model
    LIMIT ${MAX_USAGE_ROWS + 1}
  `).all() as Record<string, unknown>[]
  if (rawRows.length > MAX_USAGE_ROWS) throw new Error('cc_switch_usage_row_limit')
  const rows = rawRows.map((row) => usageRow(row, names)).filter((row) => row.requestCount > 0)
  return createCcSwitchUsageDocument(rows.map((row) => {
    const sourceProviderId = ccSwitchSourceProviderId(row.appType, row.providerId)
    return {
      sourceProviderId,
      providerName: safeLabel(row.providerName, `CC Switch Provider ${sourceProviderId.slice(0, 8)}`, 120),
      source: `cc-switch.${row.appType}`,
      model: safeLabel(row.model, 'unknown', 200),
      dayStartedAt: parseDate(row.date),
      requestCount: row.requestCount,
      successCount: row.successCount,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      costUsd: row.costUsd,
      ...(row.averageLatencyMs === undefined ? {} : { averageLatencyMs: row.averageLatencyMs })
    }
  }))
}

function readProviderNames(database: DatabaseSync): Map<string, string> {
  if (!tableExists(database, 'providers')) return new Map()
  const rows = database.prepare(`
    SELECT id, app_type, name FROM providers
    WHERE app_type IN ('claude', 'codex') ORDER BY app_type, id
  `).all() as Record<string, unknown>[]
  return new Map(rows.map((row) => [providerKey(requiredText(row.app_type), requiredText(row.id)), requiredText(row.name)]))
}

function usageRow(row: Record<string, unknown>, names: Map<string, string>): UsageRow {
  const appType = requiredText(row.app_type)
  const providerId = requiredText(row.provider_id)
  const requestCount = integer(row.request_count)
  const successCount = integer(row.success_count)
  if (successCount > requestCount) throw new Error('cc_switch_usage_success_invalid')
  return {
    date: requiredText(row.date),
    appType,
    providerId,
    providerName: names.get(providerKey(appType, providerId)) ?? '',
    model: text(row.model) || text(row.request_model) || text(row.pricing_model) || 'unknown',
    requestCount,
    successCount,
    inputTokens: integer(row.input_tokens),
    outputTokens: integer(row.output_tokens),
    cacheReadTokens: integer(row.cache_read_tokens),
    cacheWriteTokens: integer(row.cache_creation_tokens),
    costUsd: number(row.total_cost_usd),
    averageLatencyMs: optionalNumber(row.avg_latency_ms)
  }
}

function readUsageDocumentFromPath(databasePath: string): CcSwitchUsageDocument {
  assertDatabase(databasePath)
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    database.exec('PRAGMA query_only = ON')
    if (!tableExists(database, 'usage_daily_rollups')) throw new Error('migration_source_changed')
    return readUsageDocument(database)
  } finally {
    database.close()
  }
}

function usageConflict(fingerprint: string, targetDigest: string): MigrationAsset['conflict'] {
  if (fingerprint === 'missing') return 'none'
  if (fingerprint === `file:${targetDigest}`) return 'duplicate'
  if (fingerprint.startsWith('file:')) return 'replace_required'
  return 'unsupported'
}

function tableExists(database: DatabaseSync, name: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
}

function parseDate(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new Error('cc_switch_usage_date_invalid')
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error('cc_switch_usage_date_invalid')
  }
  return date.getTime()
}

function safeLabel(value: string, fallback: string, maxLength: number): string {
  const label = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
  return label && !containsSensitiveText(label) ? label : fallback
}

function providerKey(appType: string, providerId: string): string {
  return `${appType}\0${providerId}`
}

function requiredText(value: unknown): string {
  const valueText = text(value)
  if (!valueText || valueText.length > 500) throw new Error('cc_switch_usage_text_invalid')
  return valueText
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function integer(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('cc_switch_usage_integer_invalid')
  return parsed
}

function number(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('cc_switch_usage_number_invalid')
  return parsed
}

function optionalNumber(value: unknown): number | undefined {
  return value === null || value === undefined || value === '' ? undefined : number(value)
}

function assertDatabase(databasePath: string): void {
  if (!existsSync(databasePath)) throw new Error('migration_source_changed')
  const info = lstatSync(databasePath)
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_DATABASE_BYTES) {
    throw new Error('cc_switch_database_invalid')
  }
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return /^[a-z0-9_]+$/i.test(message) ? message : 'cc_switch_usage_invalid'
}
