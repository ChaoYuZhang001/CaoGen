import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  ProviderBillingStatementInput,
  ProviderBillingStatementSource,
  ProviderBillingStatementView
} from '../../shared/provider-billing-types'

interface ProviderBillingStoreDocument {
  schemaVersion: 1
  revision: number
  statements: ProviderBillingStatementView[]
}

const MAX_STORE_BYTES = 2 * 1024 * 1024
const MAX_STATEMENTS = 2_000
const MAX_PERIOD_MS = 366 * 24 * 60 * 60 * 1000
let cache: ProviderBillingStoreDocument | null = null

export function listStoredProviderBillingStatements(providerId?: string): ProviderBillingStatementView[] {
  const normalizedProviderId = providerId?.trim()
  return load().statements
    .filter((statement) => !normalizedProviderId || statement.providerId === normalizedProviderId)
    .map(cloneStatement)
    .sort((left, right) => right.periodEnd - left.periodEnd || right.updatedAt - left.updatedAt)
}

export function saveStoredProviderBillingStatement(
  input: ProviderBillingStatementInput,
  now = Date.now()
): ProviderBillingStatementView {
  const normalized = normalizeInput(input, now)
  const current = cloneDocument(load())
  const existing = current.statements.find((statement) =>
    statement.providerId === normalized.providerId
      && statement.periodStart === normalized.periodStart
      && statement.periodEnd === normalized.periodEnd
      && statement.source === normalized.source)
  const base = {
    schemaVersion: 1 as const,
    id: existing?.id ?? randomUUID(),
    ...normalized,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
  const statement: ProviderBillingStatementView = { ...base, digest: statementDigest(base) }
  if (existing) current.statements[current.statements.indexOf(existing)] = statement
  else current.statements.push(statement)
  if (current.statements.length > MAX_STATEMENTS) throw new Error('Provider billing statement limit was reached')
  current.revision += 1
  persist(current)
  return cloneStatement(statement)
}

export function removeStoredProviderBillingStatement(providerId: string, statementId: string): boolean {
  const normalizedProviderId = validId(providerId, 'provider id')
  const normalizedStatementId = validId(statementId, 'statement id')
  const current = cloneDocument(load())
  const next = current.statements.filter((statement) =>
    statement.providerId !== normalizedProviderId || statement.id !== normalizedStatementId)
  if (next.length === current.statements.length) return false
  current.statements = next
  current.revision += 1
  persist(current)
  return true
}

function load(): ProviderBillingStoreDocument {
  if (cache) return cache
  const file = storeFile()
  if (!existsSync(file)) return (cache = emptyDocument())
  const info = lstatSync(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_STORE_BYTES) {
    throw new Error('Provider billing store is invalid')
  }
  if (process.platform !== 'win32') chmodSync(file, 0o600)
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
  if (!isStoreDocument(parsed)) throw new Error('Provider billing store is corrupted')
  cache = cloneDocument(parsed)
  return cache
}

function persist(document: ProviderBillingStoreDocument): void {
  if (!isStoreDocument(document)) throw new Error('Provider billing store value is invalid')
  const file = storeFile()
  const directory = dirname(file)
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  try {
    const descriptor = openSync(temp, 'wx', 0o600)
    try {
      writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    renameSync(temp, file)
    if (process.platform !== 'win32') {
      chmodSync(file, 0o600)
      const directoryDescriptor = openSync(directory, 'r')
      try { fsyncSync(directoryDescriptor) } finally { closeSync(directoryDescriptor) }
    }
  } catch (error) {
    try { unlinkSync(temp) } catch { /* best effort */ }
    throw error
  }
  cache = cloneDocument(document)
}

function normalizeInput(input: ProviderBillingStatementInput, now: number): ProviderBillingStatementInput {
  const providerId = validId(input.providerId, 'provider id')
  const periodStart = validTimestamp(input.periodStart, 'period start')
  const periodEnd = validTimestamp(input.periodEnd, 'period end')
  if (periodEnd <= periodStart || periodEnd - periodStart > MAX_PERIOD_MS || periodEnd > now + 5 * 60 * 1000) {
    throw new Error('Provider billing statement period is invalid')
  }
  if (!Number.isFinite(input.billedCostUsd) || input.billedCostUsd < 0 || input.billedCostUsd > 1_000_000_000) {
    throw new Error('Provider billing statement amount is invalid')
  }
  return {
    providerId,
    periodStart,
    periodEnd,
    billedCostUsd: round(input.billedCostUsd),
    source: validSource(input.source)
  }
}

function isStoreDocument(value: unknown): value is ProviderBillingStoreDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const document = value as Partial<ProviderBillingStoreDocument>
  return document.schemaVersion === 1
    && Number.isSafeInteger(document.revision)
    && (document.revision ?? -1) >= 0
    && Array.isArray(document.statements)
    && document.statements.length <= MAX_STATEMENTS
    && document.statements.every(isStoredStatement)
}

function isStoredStatement(value: unknown): value is ProviderBillingStatementView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const statement = value as Partial<ProviderBillingStatementView>
  if (statement.schemaVersion !== 1
    || typeof statement.id !== 'string'
    || typeof statement.providerId !== 'string'
    || typeof statement.periodStart !== 'number'
    || typeof statement.periodEnd !== 'number'
    || typeof statement.billedCostUsd !== 'number'
    || typeof statement.createdAt !== 'number'
    || typeof statement.updatedAt !== 'number'
    || typeof statement.digest !== 'string'
    || !isSource(statement.source)) return false
  try {
    validId(statement.id, 'statement id')
    normalizeInput(statement as ProviderBillingStatementInput, Math.max(Date.now(), statement.periodEnd))
    validTimestamp(statement.createdAt, 'created at')
    validTimestamp(statement.updatedAt, 'updated at')
  } catch {
    return false
  }
  const { digest: _digest, ...base } = statement as ProviderBillingStatementView
  return statement.digest === statementDigest(base)
}

function statementDigest(value: Omit<ProviderBillingStatementView, 'digest'>): string {
  return createHash('sha256').update(JSON.stringify([
    value.schemaVersion,
    value.id,
    value.providerId,
    value.periodStart,
    value.periodEnd,
    value.billedCostUsd,
    value.source,
    value.createdAt,
    value.updatedAt
  ])).digest('hex')
}

function validId(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 512 || /[\0-\x1f\x7f]/.test(normalized)) {
    throw new Error(`Provider billing ${label} is invalid`)
  }
  return normalized
}

function validTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Provider billing ${label} is invalid`)
  return value
}

function validSource(value: ProviderBillingStatementSource): ProviderBillingStatementSource {
  if (!isSource(value)) throw new Error('Provider billing statement source is invalid')
  return value
}

function isSource(value: unknown): value is ProviderBillingStatementSource {
  return value === 'provider-api' || value === 'provider-console' || value === 'invoice'
    || value === 'balance-export' || value === 'other'
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function emptyDocument(): ProviderBillingStoreDocument {
  return { schemaVersion: 1, revision: 0, statements: [] }
}

function storeFile(): string {
  return join(app.getPath('userData'), 'provider-billing-statements.json')
}

function cloneStatement(statement: ProviderBillingStatementView): ProviderBillingStatementView {
  return { ...statement }
}

function cloneDocument(document: ProviderBillingStoreDocument): ProviderBillingStoreDocument {
  return { ...document, statements: document.statements.map(cloneStatement) }
}
