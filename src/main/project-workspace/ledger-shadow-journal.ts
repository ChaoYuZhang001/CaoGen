import { readFile, readdir } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { digest } from './codec'
import { ProjectWorkspaceError } from './errors'
import { atomicWrite } from './persistence'
import {
  PROJECT_WORKSPACE_LEDGER_SHADOW_JOURNAL_FORMAT,
  type ProjectWorkspaceLedgerShadowCommand,
  type ProjectWorkspaceLedgerShadowErrorRecord,
  type ProjectWorkspaceLedgerShadowJournal,
  type ProjectWorkspaceLedgerShadowJournalEntry,
  type ProjectWorkspaceLedgerShadowJournalState
} from './ledger-shadow-types'

const COMMANDS = new Set<ProjectWorkspaceLedgerShadowCommand>([
  'goal.create',
  'goal.update',
  'goal.acceptance.set',
  'goal.transition',
  'goal.archive',
  'goal.restore',
  'work_item.create',
  'work_item.update',
  'work_item.reorder',
  'work_item.acceptance.set',
  'work_item.transition',
  'work_item.lease.acquire',
  'work_item.lease.renew',
  'work_item.lease.release'
])

export async function listShadowJournals(
  journalDir: string
): Promise<ProjectWorkspaceLedgerShadowJournalEntry[]> {
  let entries
  try {
    entries = await readdir(journalDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const result: ProjectWorkspaceLedgerShadowJournalEntry[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const path = resolve(journalDir, entry.name)
    result.push({ path, journal: parseShadowJournal(path, await readFile(path, 'utf8')) })
  }
  return result.sort(compareJournals)
}

export function compareJournals(
  left: ProjectWorkspaceLedgerShadowJournalEntry,
  right: ProjectWorkspaceLedgerShadowJournalEntry
): number {
  return left.journal.createdAt - right.journal.createdAt ||
    left.journal.operationId.localeCompare(right.journal.operationId)
}

export function writeShadowJournal(
  path: string,
  journal: ProjectWorkspaceLedgerShadowJournal
): Promise<void> {
  return atomicWrite(path, journal)
}

export function parseShadowJournal(path: string, raw: string): ProjectWorkspaceLedgerShadowJournal {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new ProjectWorkspaceError('ledger_shadow_journal_invalid', `cannot parse ${path}: ${safeMessage(error)}`)
  }
  if (!isShadowJournal(value) || basename(path) !== `${value.operationId}.json`) {
    throw new ProjectWorkspaceError('ledger_shadow_journal_invalid', `invalid or path-unbound shadow journal ${path}`)
  }
  return value
}

export function sealShadowJournal(
  value: Omit<ProjectWorkspaceLedgerShadowJournal, 'journalDigest'>
): ProjectWorkspaceLedgerShadowJournal {
  return { ...value, journalDigest: digest(value) }
}

export function updateShadowJournal(
  current: ProjectWorkspaceLedgerShadowJournal,
  patch: Partial<Omit<ProjectWorkspaceLedgerShadowJournal,
    'schemaVersion' | 'format' | 'operationId' | 'journalDigest'>>
): ProjectWorkspaceLedgerShadowJournal {
  const { journalDigest: _journalDigest, ...unsealed } = current
  return sealShadowJournal({ ...unsealed, ...patch })
}

export function shadowErrorRecord(error: unknown, at: number): ProjectWorkspaceLedgerShadowErrorRecord {
  const item = isRecord(error) ? error : undefined
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: safeMessage(error),
    code: typeof item?.code === 'string' ? item.code : undefined,
    at
  }
}

export function projectWorkspaceLedgerShadowError(input: {
  code: string
  message: string
  journalPath: string
  journal: ProjectWorkspaceLedgerShadowJournal
  sourceCommitted: boolean
  reconciliationRequired: boolean
  cause?: unknown
}): ProjectWorkspaceError {
  const causeRecord = isRecord(input.cause) ? input.cause : undefined
  const error = new ProjectWorkspaceError(input.code, input.message, {
    sourceCommitted: input.sourceCommitted,
    reconciliationRequired: input.reconciliationRequired,
    operationId: input.journal.operationId,
    journalPath: input.journalPath,
    workspaceId: input.journal.workspaceId,
    entityType: input.journal.entityType,
    entityId: input.journal.entityId,
    causeCode: typeof causeRecord?.code === 'string' ? causeRecord.code : undefined
  })
  if (input.cause !== undefined) Object.defineProperty(error, 'cause', { value: input.cause })
  return error
}

function isShadowJournal(value: unknown): value is ProjectWorkspaceLedgerShadowJournal {
  if (!hasJournalEnvelope(value) || !hasSourceState(value.source)) return false
  if (value.projection !== undefined && !hasProjectionState(value.projection)) return false
  if (value.lastError !== undefined && !hasErrorRecord(value.lastError)) return false
  if (!hasStateConsistency(value)) return false
  const { journalDigest, ...unsealed } = value
  return digest(unsealed) === journalDigest
}

function hasJournalEnvelope(value: unknown): value is ProjectWorkspaceLedgerShadowJournal {
  if (!isRecord(value)) return false
  return hasJournalIdentity(value) && hasJournalTarget(value) && hasJournalLifecycle(value)
}

function hasJournalIdentity(value: Record<string, unknown>): boolean {
  return value.schemaVersion === 1 && value.format === PROJECT_WORKSPACE_LEDGER_SHADOW_JOURNAL_FORMAT &&
    isId(value.operationId) && typeof value.command === 'string' &&
    COMMANDS.has(value.command as ProjectWorkspaceLedgerShadowCommand)
}

function hasJournalTarget(value: Record<string, unknown>): boolean {
  return (value.entityType === 'goal' || value.entityType === 'work_item') && isId(value.entityId) &&
    (value.workspaceId === undefined || isId(value.workspaceId)) && isJournalState(value.state) && isRecord(value.source)
}

function hasJournalLifecycle(value: Record<string, unknown>): boolean {
  return isNonNegativeInteger(value.attempts) && isTimestamp(value.createdAt) && isTimestamp(value.updatedAt) &&
    value.updatedAt >= value.createdAt && isDigest(value.journalDigest)
}

function hasSourceState(value: unknown): boolean {
  if (!isRecord(value)) return false
  return isNonNegativeInteger(value.storeRevisionBefore) &&
    optionalPositiveInteger(value.entityRevisionBefore) && optionalDigest(value.entityDigestBefore) &&
    optionalNonNegativeInteger(value.storeRevisionAfter) && optionalPositiveInteger(value.entityRevisionAfter) &&
    optionalDigest(value.entityDigestAfter)
}

function hasProjectionState(value: unknown): boolean {
  if (!isRecord(value)) return false
  return hasProjectionIdentity(value) && hasProjectionMigration(value)
}

function hasProjectionIdentity(value: Record<string, unknown>): boolean {
  return (value.status === 'migrated' || value.status === 'already_current') &&
    isNonNegativeInteger(value.stateRevision) && isPositiveInteger(value.workspaceRevision) &&
    isDigest(value.projectionDigest) && isDigest(value.sourceSha256)
}

function hasProjectionMigration(value: Record<string, unknown>): boolean {
  return (value.migrationId === undefined || isId(value.migrationId)) &&
    (value.migrationJournalPath === undefined || isId(value.migrationJournalPath))
}

function hasErrorRecord(value: unknown): boolean {
  if (!isRecord(value)) return false
  return isId(value.name) && typeof value.message === 'string' &&
    (value.code === undefined || typeof value.code === 'string') && isTimestamp(value.at)
}

function hasStateConsistency(journal: ProjectWorkspaceLedgerShadowJournal): boolean {
  const sourceCommitted = journal.state === 'source_committed' || journal.state === 'projection_committed'
  if (sourceCommitted && (!journal.workspaceId || journal.source.storeRevisionAfter === undefined ||
      journal.source.entityRevisionAfter === undefined || journal.source.entityDigestAfter === undefined)) {
    return false
  }
  return journal.state === 'projection_committed' ? journal.projection !== undefined : journal.projection === undefined
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_000)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\0-\x1f\x7f]/.test(value)
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function optionalDigest(value: unknown): boolean {
  return value === undefined || isDigest(value)
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function optionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value)
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function optionalPositiveInteger(value: unknown): boolean {
  return value === undefined || isPositiveInteger(value)
}

function isJournalState(value: unknown): value is ProjectWorkspaceLedgerShadowJournalState {
  return value === 'prepared' || value === 'source_committed' ||
    value === 'projection_committed' || value === 'aborted'
}
