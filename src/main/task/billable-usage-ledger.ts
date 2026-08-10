import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { DigitalWorkerBinding } from '../../shared/digital-worker-types'
import type { ModelAttemptRecord, ModelAttemptUsage } from '../../shared/model-attempt-types'

const SCHEMA_VERSION = 1 as const
const GENESIS_DIGEST = '0'.repeat(64)

export interface BillableUsageLedgerEntry {
  schemaVersion: typeof SCHEMA_VERSION
  seq: number
  attemptId: string
  runId: string
  sessionId: string
  providerId: string
  model: string
  status: ModelAttemptRecord['status']
  startedAt: number
  completedAt: number
  usage?: ModelAttemptUsage
  /** false means the request had no auditable USD price and cannot consume a USD budget. */
  billable: boolean
  costUsd?: number
  digitalWorkerBinding?: DigitalWorkerBinding
  prevDigest: string
  digest: string
}

export function billableUsageLedgerPath(rootDir: string): string {
  const normalized = rootDir.trim()
  if (!normalized) throw new Error('billable usage ledger rootDir is required')
  return join(normalized, 'billable-usage-ledger.jsonl')
}

export function appendBillableUsageLedger(
  rootDir: string,
  input: { sessionId: string; attempt: ModelAttemptRecord; digitalWorkerBinding?: DigitalWorkerBinding }
): BillableUsageLedgerEntry | undefined {
  const attempt = input.attempt
  if (attempt.status === 'started' || attempt.completedAt === undefined) return undefined
  const existing = readBillableUsageLedger(rootDir)
  const duplicate = existing.find((entry) => entry.attemptId === attempt.id)
  if (duplicate) {
    const candidate = buildEntry(input, duplicate.seq, duplicate.prevDigest)
    if (candidate.digest !== duplicate.digest) throw new Error(`billable usage attempt ${attempt.id} conflicts with ledger history`)
    return duplicate
  }
  const candidate = buildEntry(input, existing.length + 1, existing.at(-1)?.digest ?? GENESIS_DIGEST)
  const path = billableUsageLedgerPath(rootDir)
  const descriptor = openSync(path, 'a')
  try {
    appendFileSync(descriptor, `${JSON.stringify(candidate)}\n`, 'utf8')
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  return candidate
}

export function readBillableUsageLedger(rootDir: string): BillableUsageLedgerEntry[] {
  const path = billableUsageLedgerPath(rootDir)
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  if (!text.trim()) return []
  const entries: BillableUsageLedgerEntry[] = []
  let previousDigest = GENESIS_DIGEST
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    let value: unknown
    try { value = JSON.parse(line) } catch { throw new Error(`billable usage ledger line ${index + 1} is invalid JSON`) }
    const entry = normalizeEntry(value, index + 1)
    if (entry.seq !== entries.length + 1 || entry.prevDigest !== previousDigest) {
      throw new Error(`billable usage ledger chain is invalid at line ${index + 1}`)
    }
    const expected = entryDigest(entry)
    if (entry.digest !== expected) throw new Error(`billable usage ledger digest is invalid at line ${index + 1}`)
    entries.push(entry)
    previousDigest = entry.digest
  }
  return entries
}

function buildEntry(
  input: { sessionId: string; attempt: ModelAttemptRecord; digitalWorkerBinding?: DigitalWorkerBinding },
  seq: number,
  prevDigest: string
): BillableUsageLedgerEntry {
  const attempt = input.attempt
  const costUsd = validCost(attempt.costUsd)
  const entry: BillableUsageLedgerEntry = {
    schemaVersion: SCHEMA_VERSION,
    seq,
    attemptId: attempt.id,
    runId: attempt.runId,
    sessionId: input.sessionId.trim(),
    providerId: attempt.providerId,
    model: attempt.model,
    status: attempt.status,
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt as number,
    ...(attempt.usage ? { usage: attempt.usage } : {}),
    billable: costUsd !== undefined,
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(input.digitalWorkerBinding ? { digitalWorkerBinding: input.digitalWorkerBinding } : {}),
    prevDigest,
    digest: ''
  }
  entry.digest = entryDigest(entry)
  return entry
}


function entryDigest(entry: BillableUsageLedgerEntry): string {
  const { digest: _digest, ...withoutDigest } = entry
  return createHash('sha256').update(JSON.stringify(withoutDigest)).digest('hex')
}

function normalizeEntry(value: unknown, line: number): BillableUsageLedgerEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`billable usage ledger line ${line} is not an object`)
  const entry = value as Partial<BillableUsageLedgerEntry>
  const required = ['attemptId', 'runId', 'sessionId', 'providerId', 'model', 'prevDigest', 'digest'] as const
  for (const field of required) if (typeof entry[field] !== 'string' || !entry[field]) throw new Error(`billable usage ledger ${field} is invalid`)
  if (entry.schemaVersion !== SCHEMA_VERSION || !Number.isSafeInteger(entry.seq) || (entry.seq as number) < 1) throw new Error(`billable usage ledger line ${line} has invalid schema/sequence`)
  if (!Number.isFinite(entry.startedAt) || !Number.isFinite(entry.completedAt) || typeof entry.billable !== 'boolean') throw new Error(`billable usage ledger line ${line} has invalid timing/billing fields`)
  if (entry.billable && validCost(entry.costUsd) === undefined) throw new Error(`billable usage ledger line ${line} has invalid cost`)
  return entry as BillableUsageLedgerEntry
}

function validCost(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value * 1_000_000) / 1_000_000 : undefined
}
