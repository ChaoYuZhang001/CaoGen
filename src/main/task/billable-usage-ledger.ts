import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { DigitalWorkerBinding } from '../../shared/digital-worker-types'
import type { ModelAttemptRecord, ModelAttemptUsage } from '../../shared/model-attempt-types'

const SCHEMA_VERSION = 1 as const
const GENESIS_DIGEST = '0'.repeat(64)
const LOCK_RETRY_MS = 10
const LOCK_TIMEOUT_MS = 5_000
const ABANDONED_LOCK_MS = 30_000

interface LedgerLockOwner {
  pid: number
  token: string
  acquiredAt: number
}

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
  const normalizedRoot = requiredRoot(rootDir)
  mkdirSync(normalizedRoot, { recursive: true })
  const lockPath = join(normalizedRoot, 'billable-usage-ledger.lock')
  const lock = acquireLedgerLock(lockPath)
  try {
    const existing = readBillableUsageLedger(normalizedRoot)
    const duplicate = existing.find((entry) => entry.attemptId === attempt.id)
    if (duplicate) {
      const candidate = buildEntry(input, duplicate.seq, duplicate.prevDigest)
      if (candidate.digest !== duplicate.digest) throw new Error(`billable usage attempt ${attempt.id} conflicts with ledger history`)
      return duplicate
    }
    const candidate = buildEntry(input, existing.length + 1, existing.at(-1)?.digest ?? GENESIS_DIGEST)
    const descriptor = openSync(billableUsageLedgerPath(normalizedRoot), 'a', 0o600)
    try {
      appendFileSync(descriptor, `${JSON.stringify(candidate)}\n`, 'utf8')
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    return candidate
  } finally {
    releaseLedgerLock(lockPath, lock)
  }
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
  const sessionId = input.sessionId.trim()
  if (!sessionId) throw new Error('billable usage ledger sessionId is required')
  const costUsd = validCost(attempt.costUsd)
  const entry: BillableUsageLedgerEntry = {
    schemaVersion: SCHEMA_VERSION,
    seq,
    attemptId: attempt.id,
    runId: attempt.runId,
    sessionId,
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
  if (entry.status !== 'succeeded' && entry.status !== 'failed' && entry.status !== 'cancelled') throw new Error(`billable usage ledger line ${line} has invalid terminal status`)
  if (entry.billable && validCost(entry.costUsd) === undefined) throw new Error(`billable usage ledger line ${line} has invalid cost`)
  if (!entry.billable && entry.costUsd !== undefined) throw new Error(`billable usage ledger line ${line} has contradictory billing fields`)
  if (!/^[0-9a-f]{64}$/.test(entry.prevDigest as string) || !/^[0-9a-f]{64}$/.test(entry.digest as string)) throw new Error(`billable usage ledger line ${line} has invalid digest fields`)
  return entry as BillableUsageLedgerEntry
}

function validCost(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value * 1_000_000) / 1_000_000 : undefined
}

function requiredRoot(rootDir: string): string {
  const normalized = rootDir.trim()
  if (!normalized) throw new Error('billable usage ledger rootDir is required')
  return normalized
}

function acquireLedgerLock(lockPath: string): { descriptor: number; owner: LedgerLockOwner } {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  while (true) {
    const owner = { pid: process.pid, token: randomUUID(), acquiredAt: Date.now() }
    try {
      const descriptor = openSync(lockPath, 'wx', 0o600)
      writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, 'utf8')
      fsyncSync(descriptor)
      return { descriptor, owner }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      recoverAbandonedLedgerLock(lockPath)
      if (Date.now() >= deadline) throw new Error('billable usage ledger is locked by another writer')
      synchronousWait(LOCK_RETRY_MS)
    }
  }
}

function recoverAbandonedLedgerLock(lockPath: string): void {
  let owner: LedgerLockOwner | undefined
  try {
    const value = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LedgerLockOwner>
    if (Number.isSafeInteger(value.pid) && (value.pid as number) > 0 && typeof value.token === 'string') {
      owner = value as LedgerLockOwner
    }
  } catch {
    // A malformed lock cannot identify a live owner and is recoverable.
  }
  if (owner && processIsAlive(owner.pid)) return
  if (!owner) {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs <= ABANDONED_LOCK_MS) return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
  try { unlinkSync(lockPath) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function releaseLedgerLock(lockPath: string, lock: { descriptor: number; owner: LedgerLockOwner }): void {
  try { fsyncSync(lock.descriptor) } catch { /* close remains mandatory */ }
  closeSync(lock.descriptor)
  try {
    const current = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LedgerLockOwner>
    if (current.token === lock.owner.token && current.pid === lock.owner.pid) unlinkSync(lockPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function synchronousWait(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}
