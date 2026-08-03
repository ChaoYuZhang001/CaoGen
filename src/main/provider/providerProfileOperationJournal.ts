import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { withProviderStoreMutationLock } from './providerStoreMutationLock'

export {
  ProviderStoreMutationLockError,
  providerStoreMutationLockPaths,
  withProviderStoreMutationLock
} from './providerStoreMutationLock'
export type { ProviderStoreMutationLockErrorCode } from './providerStoreMutationLock'

const JOURNAL_KIND = 'caogen-provider-profile-operation-journal' as const
const JOURNAL_SCHEMA_VERSION = 2 as const
const JOURNAL_DIRECTORY_NAME = 'provider-profile-operations'
const JOURNAL_FILE_NAME = 'journal.json'
const MAX_JOURNAL_BYTES = 512 * 1024
const MAX_JOURNAL_ENTRIES = 256
const SHA256 = /^[0-9a-f]{64}$/
const SAFE_ID = /^[0-9A-Za-z._:-]{1,192}$/

export type ProviderProfileOperationKind = 'import' | 'rollback'
export type ProviderProfileOperationPhase = 'prepared' | 'waiting_reconciliation' | 'committed' | 'aborted'

export interface ProviderProfileOperationJournalEntry {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION
  operationId: string
  operation: ProviderProfileOperationKind
  phase: ProviderProfileOperationPhase
  beforeSnapshotDigest: string
  desiredSnapshotDigest: string
  safetyBackupId: string
  safetyBackupDigest: string
  sourceBackupId?: string
  sourceBackupDigest?: string
  createdAt: number
  updatedAt: number
}

export interface PrepareProviderProfileOperationInput {
  operationId?: string
  operation: ProviderProfileOperationKind
  beforeSnapshotDigest: string
  desiredSnapshotDigest: string
  safetyBackupId: string
  safetyBackupDigest: string
  sourceBackupId?: string
  sourceBackupDigest?: string
}

export interface ProviderProfileOperationReconciliation {
  operationId: string
  operation: ProviderProfileOperationKind
  phase: Extract<ProviderProfileOperationPhase, 'committed' | 'aborted'>
  classification: 'desired_snapshot_present' | 'before_snapshot_present'
}

export type ProviderProfileOperationJournalErrorCode =
  | 'INVALID_INPUT'
  | 'JOURNAL_CORRUPT'
  | 'JOURNAL_IO'
  | 'OPERATION_CONFLICT'
  | 'OPERATION_NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'RECONCILIATION_CONFLICT'

export class ProviderProfileOperationJournalError extends Error {
  constructor(
    readonly code: ProviderProfileOperationJournalErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'ProviderProfileOperationJournalError'
  }
}

interface ProviderProfileOperationJournalPayload {
  kind: typeof JOURNAL_KIND
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION
  revision: number
  entries: ProviderProfileOperationJournalEntry[]
}

interface ProviderProfileOperationJournalDocument extends ProviderProfileOperationJournalPayload {
  journalDigest: string
}

export function providerProfileOperationJournalPaths(userDataDirectory: string): {
  directoryPath: string
  filePath: string
} {
  if (typeof userDataDirectory !== 'string' || !userDataDirectory.trim() || userDataDirectory.includes('\0')) {
    invalidInput('Provider Profile operation journal root is invalid')
  }
  const directoryPath = join(resolve(userDataDirectory), JOURNAL_DIRECTORY_NAME)
  return { directoryPath, filePath: join(directoryPath, JOURNAL_FILE_NAME) }
}

export class ProviderProfileOperationJournal {
  readonly userDataDirectory: string
  readonly directoryPath: string
  readonly filePath: string

  constructor(userDataDirectory: string) {
    const paths = providerProfileOperationJournalPaths(userDataDirectory)
    this.userDataDirectory = resolve(userDataDirectory)
    this.directoryPath = paths.directoryPath
    this.filePath = paths.filePath
  }

  prepare(
    input: PrepareProviderProfileOperationInput,
    currentSnapshotDigest?: string | (() => string)
  ): ProviderProfileOperationJournalEntry {
    assertPrepareInput(input)
    return withProviderStoreMutationLock(this.userDataDirectory, () => {
      if (currentSnapshotDigest !== undefined
        && resolveCurrentSnapshotDigest(currentSnapshotDigest) !== input.beforeSnapshotDigest) {
        throw new ProviderProfileOperationJournalError(
          'OPERATION_CONFLICT',
          'Provider Store changed before the Provider Profile operation was prepared'
        )
      }
      return this.prepareLocked(input)
    })
  }

  private prepareLocked(input: PrepareProviderProfileOperationInput): ProviderProfileOperationJournalEntry {
    const document = readJournal(this.directoryPath, this.filePath)
    if (document.entries.some(isUnresolvedEntry)) {
      throw new ProviderProfileOperationJournalError(
        'OPERATION_CONFLICT',
        'Provider Profile operation journal already contains an unresolved operation'
      )
    }
    const now = Date.now()
    const entry: ProviderProfileOperationJournalEntry = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      operationId: input.operationId ?? randomUUID(),
      operation: input.operation,
      phase: 'prepared',
      beforeSnapshotDigest: input.beforeSnapshotDigest,
      desiredSnapshotDigest: input.desiredSnapshotDigest,
      safetyBackupId: input.safetyBackupId,
      safetyBackupDigest: input.safetyBackupDigest,
      ...(input.sourceBackupId === undefined ? {} : { sourceBackupId: input.sourceBackupId }),
      ...(input.sourceBackupDigest === undefined ? {} : { sourceBackupDigest: input.sourceBackupDigest }),
      createdAt: now,
      updatedAt: now
    }
    assertEntry(entry)
    if (document.entries.some((candidate) => candidate.operationId === entry.operationId)) {
      throw new ProviderProfileOperationJournalError(
        'OPERATION_CONFLICT',
        `Provider Profile operationId already exists: ${entry.operationId}`
      )
    }
    document.entries = retainRecentTerminalEntries(document.entries)
    document.entries.push(entry)
    persistJournal(this.directoryPath, this.filePath, document)
    return cloneEntry(entry)
  }

  markCommitted(
    operationId: string,
    currentSnapshotDigest: string | (() => string)
  ): ProviderProfileOperationJournalEntry {
    return withProviderStoreMutationLock(this.userDataDirectory, () =>
      this.finishLocked(operationId, 'committed', resolveCurrentSnapshotDigest(currentSnapshotDigest)))
  }

  markAborted(
    operationId: string,
    currentSnapshotDigest: string | (() => string)
  ): ProviderProfileOperationJournalEntry {
    return withProviderStoreMutationLock(this.userDataDirectory, () =>
      this.finishLocked(operationId, 'aborted', resolveCurrentSnapshotDigest(currentSnapshotDigest)))
  }

  markWaitingReconciliation(operationId: string): ProviderProfileOperationJournalEntry {
    return withProviderStoreMutationLock(this.userDataDirectory, () => {
      assertSafeId(operationId, 'operationId')
      const document = readJournal(this.directoryPath, this.filePath)
      const entry = document.entries.find((candidate) => candidate.operationId === operationId)
      if (!entry) {
        throw new ProviderProfileOperationJournalError(
          'OPERATION_NOT_FOUND',
          `Provider Profile operation not found: ${operationId}`
        )
      }
      if (entry.phase === 'committed' || entry.phase === 'aborted') {
        throw new ProviderProfileOperationJournalError(
          'INVALID_TRANSITION',
          `Provider Profile operation ${operationId} is already ${entry.phase}`
        )
      }
      if (entry.phase === 'waiting_reconciliation') return cloneEntry(entry)
      transitionToWaitingReconciliation(this.directoryPath, this.filePath, document, entry)
      return cloneEntry(entry)
    })
  }

  reconcile(
    currentSnapshotDigest: string | (() => string)
  ): ProviderProfileOperationReconciliation[] {
    return withProviderStoreMutationLock(this.userDataDirectory, () =>
      this.reconcileLocked(resolveCurrentSnapshotDigest(currentSnapshotDigest)))
  }

  private reconcileLocked(currentSnapshotDigest: string): ProviderProfileOperationReconciliation[] {
    assertSnapshotDigest(currentSnapshotDigest, 'currentSnapshotDigest')
    const document = readJournal(this.directoryPath, this.filePath)
    const unresolved = document.entries.filter(isUnresolvedEntry)
    if (unresolved.length === 0) return []
    if (unresolved.length !== 1) corrupt('Provider Profile operation journal contains multiple unresolved operations')
    const entry = unresolved[0]
    let phase: ProviderProfileOperationReconciliation['phase']
    let classification: ProviderProfileOperationReconciliation['classification']
    if (currentSnapshotDigest === entry.desiredSnapshotDigest) {
      phase = 'committed'
      classification = 'desired_snapshot_present'
    } else if (currentSnapshotDigest === entry.beforeSnapshotDigest) {
      phase = 'aborted'
      classification = 'before_snapshot_present'
    } else {
      if (entry.phase !== 'waiting_reconciliation') {
        transitionToWaitingReconciliation(this.directoryPath, this.filePath, document, entry)
      }
      throw new ProviderProfileOperationJournalError(
        'RECONCILIATION_CONFLICT',
        `Provider Profile operation ${entry.operationId} cannot be reconciled with the current store snapshot`
      )
    }
    entry.phase = phase
    entry.updatedAt = Math.max(Date.now(), entry.createdAt)
    persistJournal(this.directoryPath, this.filePath, document)
    return [{ operationId: entry.operationId, operation: entry.operation, phase, classification }]
  }

  assertStoreMutationAllowed(
    currentSnapshotDigest: string,
    operationId?: string,
    expectedWriteDigest?: string
  ): void {
    withProviderStoreMutationLock(this.userDataDirectory, () => {
      assertSnapshotDigest(currentSnapshotDigest, 'currentSnapshotDigest')
      if (operationId !== undefined) assertSafeId(operationId, 'operationId')
      if (expectedWriteDigest !== undefined) assertSnapshotDigest(expectedWriteDigest, 'expectedWriteDigest')
      const document = readJournal(this.directoryPath, this.filePath)
      const unresolved = document.entries.filter(isUnresolvedEntry)
      if (unresolved.length === 0) {
        if (operationId !== undefined) {
          throw new ProviderProfileOperationJournalError(
            'OPERATION_NOT_FOUND',
            `Provider Profile operation is not prepared: ${operationId}`
          )
        }
        return
      }
      if (unresolved.length !== 1) corrupt('Provider Profile operation journal contains multiple unresolved operations')
      const entry = unresolved[0]
      if (entry.phase === 'waiting_reconciliation') {
        throw new ProviderProfileOperationJournalError(
          'RECONCILIATION_CONFLICT',
          `Provider Profile operation ${entry.operationId} is waiting for reconciliation`
        )
      }
      if (currentSnapshotDigest !== entry.beforeSnapshotDigest
        && currentSnapshotDigest !== entry.desiredSnapshotDigest) {
        transitionToWaitingReconciliation(this.directoryPath, this.filePath, document, entry)
        throw new ProviderProfileOperationJournalError(
          'RECONCILIATION_CONFLICT',
          `Provider Profile operation ${entry.operationId} conflicts with the current store snapshot`
        )
      }
      if (!operationId || operationId !== entry.operationId) {
        throw new ProviderProfileOperationJournalError(
          'OPERATION_CONFLICT',
          `Provider Store mutation is blocked by prepared operation ${entry.operationId}`
        )
      }
      if (currentSnapshotDigest !== entry.beforeSnapshotDigest) {
        throw new ProviderProfileOperationJournalError(
          'OPERATION_CONFLICT',
          `Provider Profile operation ${entry.operationId} has already changed the Provider Store`
        )
      }
      if (expectedWriteDigest !== entry.desiredSnapshotDigest) {
        throw new ProviderProfileOperationJournalError(
          'OPERATION_CONFLICT',
          `Provider Profile operation ${entry.operationId} write digest does not match its desired snapshot`
        )
      }
    })
  }

  get(operationId: string): ProviderProfileOperationJournalEntry | null {
    assertSafeId(operationId, 'operationId')
    const entry = readJournal(this.directoryPath, this.filePath).entries
      .find((candidate) => candidate.operationId === operationId)
    return entry ? cloneEntry(entry) : null
  }

  list(): ProviderProfileOperationJournalEntry[] {
    return readJournal(this.directoryPath, this.filePath).entries.map(cloneEntry)
  }

  private finishLocked(
    operationId: string,
    phase: Extract<ProviderProfileOperationPhase, 'committed' | 'aborted'>,
    currentSnapshotDigest: string
  ): ProviderProfileOperationJournalEntry {
    assertSafeId(operationId, 'operationId')
    assertSnapshotDigest(currentSnapshotDigest, 'currentSnapshotDigest')
    const document = readJournal(this.directoryPath, this.filePath)
    const entry = document.entries.find((candidate) => candidate.operationId === operationId)
    if (!entry) {
      throw new ProviderProfileOperationJournalError(
        'OPERATION_NOT_FOUND',
        `Provider Profile operation not found: ${operationId}`
      )
    }
    if (entry.phase !== 'prepared' && entry.phase !== 'waiting_reconciliation') {
      if (entry.phase === phase) return cloneEntry(entry)
      throw new ProviderProfileOperationJournalError(
        'INVALID_TRANSITION',
        `Provider Profile operation ${operationId} is already ${entry.phase}`
      )
    }
    const expectedDigest = phase === 'committed'
      ? entry.desiredSnapshotDigest
      : entry.beforeSnapshotDigest
    if (currentSnapshotDigest !== expectedDigest) {
      if (currentSnapshotDigest !== entry.beforeSnapshotDigest
        && currentSnapshotDigest !== entry.desiredSnapshotDigest
        && entry.phase !== 'waiting_reconciliation') {
        transitionToWaitingReconciliation(this.directoryPath, this.filePath, document, entry)
      }
      throw new ProviderProfileOperationJournalError(
        'RECONCILIATION_CONFLICT',
        `Provider Profile operation ${operationId} does not match the ${phase} store snapshot`
      )
    }
    entry.phase = phase
    entry.updatedAt = Math.max(Date.now(), entry.createdAt)
    persistJournal(this.directoryPath, this.filePath, document)
    return cloneEntry(entry)
  }
}

function emptyJournal(): ProviderProfileOperationJournalDocument {
  const payload: ProviderProfileOperationJournalPayload = {
    kind: JOURNAL_KIND,
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    revision: 0,
    entries: []
  }
  return { ...payload, journalDigest: digestJournalPayload(payload) }
}

function readJournal(directoryPath: string, filePath: string): ProviderProfileOperationJournalDocument {
  const directoryInfo = lstatIfPresent(directoryPath)
  if (directoryInfo) assertPrivateDirectory(directoryPath, directoryInfo)
  const fileInfo = lstatIfPresent(filePath)
  if (!fileInfo) return emptyJournal()
  if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) corrupt('Provider Profile operation journal must be a regular file')

  let descriptor: number | undefined
  try {
    const defensiveFlags = process.platform === 'win32'
      ? 0
      : constants.O_NOFOLLOW | constants.O_NONBLOCK
    descriptor = openSync(filePath, constants.O_RDONLY | defensiveFlags)
    const openedInfo = fstatSync(descriptor)
    assertPrivateFile(openedInfo)
    const raw = readBoundedUtf8(descriptor, MAX_JOURNAL_BYTES)
    let value: unknown
    try {
      value = JSON.parse(raw) as unknown
    } catch (error) {
      throw new ProviderProfileOperationJournalError(
        'JOURNAL_CORRUPT',
        'Provider Profile operation journal is not valid JSON',
        { cause: error }
      )
    }
    assertJournalDocument(value)
    return cloneDocument(value)
  } catch (error) {
    if (error instanceof ProviderProfileOperationJournalError) throw error
    throw new ProviderProfileOperationJournalError(
      'JOURNAL_IO',
      `Unable to read Provider Profile operation journal: ${errorText(error)}`,
      { cause: error }
    )
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function persistJournal(
  directoryPath: string,
  filePath: string,
  document: ProviderProfileOperationJournalDocument
): void {
  document.revision += 1
  const payload = journalPayload(document)
  const next: ProviderProfileOperationJournalDocument = {
    ...payload,
    journalDigest: digestJournalPayload(payload)
  }
  assertJournalDocument(next)
  const content = `${JSON.stringify(next, null, 2)}\n`
  if (Buffer.byteLength(content, 'utf8') > MAX_JOURNAL_BYTES) {
    throw new ProviderProfileOperationJournalError('JOURNAL_IO', 'Provider Profile operation journal is too large')
  }

  ensurePrivateDirectory(directoryPath)
  const targetInfo = lstatIfPresent(filePath)
  if (targetInfo && (targetInfo.isSymbolicLink() || !targetInfo.isFile())) {
    corrupt('Refusing to replace a non-regular Provider Profile operation journal')
  }
  const temporaryPath = join(
    directoryPath,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  )
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600)
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporaryPath, filePath)
    if (process.platform !== 'win32') chmodSync(filePath, 0o600)
    syncDirectory(directoryPath)
    document.journalDigest = next.journalDigest
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch { /* best effort */ }
    }
    try { unlinkSync(temporaryPath) } catch { /* committed target, if any, remains authoritative */ }
    if (error instanceof ProviderProfileOperationJournalError) throw error
    throw new ProviderProfileOperationJournalError(
      'JOURNAL_IO',
      `Unable to persist Provider Profile operation journal: ${errorText(error)}`,
      { cause: error }
    )
  }
}

function ensurePrivateDirectory(directoryPath: string): void {
  const existing = lstatIfPresent(directoryPath)
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
    corrupt('Provider Profile operation journal directory must be a real directory')
  }
  try {
    if (!existing) mkdirSync(directoryPath, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') chmodSync(directoryPath, 0o700)
    const current = lstatSync(directoryPath)
    assertPrivateDirectory(directoryPath, current)
    if (!existing) syncDirectory(dirname(directoryPath))
  } catch (error) {
    if (error instanceof ProviderProfileOperationJournalError) throw error
    throw new ProviderProfileOperationJournalError(
      'JOURNAL_IO',
      `Unable to prepare Provider Profile operation journal directory: ${errorText(error)}`,
      { cause: error }
    )
  }
}

function assertPrivateDirectory(directoryPath: string, info: Stats): void {
  if (info.isSymbolicLink() || !info.isDirectory()) {
    corrupt('Provider Profile operation journal directory must be a real directory')
  }
  if (process.platform !== 'win32' && (info.mode & 0o777) !== 0o700) {
    corrupt(`Provider Profile operation journal directory permissions are not 0700: ${directoryPath}`)
  }
}

function assertPrivateFile(info: Stats): void {
  if (!info.isFile()) corrupt('Provider Profile operation journal must be a regular file')
  if (info.size > MAX_JOURNAL_BYTES) corrupt('Provider Profile operation journal exceeds its size limit')
  if (process.platform !== 'win32' && (info.mode & 0o777) !== 0o600) {
    corrupt('Provider Profile operation journal permissions are not 0600')
  }
}

function readBoundedUtf8(descriptor: number, maxBytes: number): string {
  const chunks: Buffer[] = []
  let total = 0
  while (total <= maxBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total))
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)
    if (bytesRead === 0) break
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
    total += bytesRead
  }
  if (total > maxBytes) corrupt('Provider Profile operation journal exceeds its size limit')
  return Buffer.concat(chunks, total).toString('utf8')
}

function syncDirectory(directoryPath: string): void {
  if (process.platform === 'win32') return
  const descriptor = openSync(directoryPath, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function assertJournalDocument(value: unknown): asserts value is ProviderProfileOperationJournalDocument {
  if (!isRecord(value)) corrupt('Provider Profile operation journal must be an object')
  assertExactKeys(value, ['kind', 'schemaVersion', 'revision', 'entries', 'journalDigest'], 'journal')
  if (value.kind !== JOURNAL_KIND || value.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
    corrupt('Provider Profile operation journal schema is unsupported')
  }
  if (!isNonNegativeSafeInteger(value.revision)) corrupt('Provider Profile operation journal revision is invalid')
  if (!Array.isArray(value.entries) || value.entries.length > MAX_JOURNAL_ENTRIES) {
    corrupt('Provider Profile operation journal entries are invalid')
  }
  const operationIds = new Set<string>()
  let unresolvedCount = 0
  for (const candidate of value.entries) {
    assertEntry(candidate)
    if (operationIds.has(candidate.operationId)) corrupt('Provider Profile operation journal has duplicate operationIds')
    operationIds.add(candidate.operationId)
    if (isUnresolvedEntry(candidate)) unresolvedCount += 1
  }
  if (unresolvedCount > 1) corrupt('Provider Profile operation journal contains multiple unresolved operations')
  if (typeof value.journalDigest !== 'string' || !SHA256.test(value.journalDigest)) {
    corrupt('Provider Profile operation journal digest is invalid')
  }
  const validated = value as unknown as ProviderProfileOperationJournalDocument
  if (digestJournalPayload(journalPayload(validated)) !== value.journalDigest) {
    corrupt('Provider Profile operation journal integrity check failed')
  }
}

function assertEntry(value: unknown): asserts value is ProviderProfileOperationJournalEntry {
  if (!isRecord(value)) corrupt('Provider Profile operation journal entry must be an object')
  assertExactKeys(value, entryKeys(value.operation), 'entry')
  assertEntryIdentity(value)
  assertEntryPhase(value.phase)
  assertEntrySnapshotDigests(value)
  assertEntrySafetyBackup(value)
  if (value.operation === 'rollback') assertEntryRollbackBackup(value)
  assertEntryTimestamps(value)
}

function entryKeys(operation: unknown): string[] {
  return [
    'schemaVersion',
    'operationId',
    'operation',
    'phase',
    'beforeSnapshotDigest',
    'desiredSnapshotDigest',
    'safetyBackupId',
    'safetyBackupDigest',
    ...(operation === 'rollback' ? ['sourceBackupId', 'sourceBackupDigest'] : []),
    'createdAt',
    'updatedAt'
  ]
}

function assertEntryIdentity(value: Record<string, unknown>): void {
  if (value.schemaVersion !== JOURNAL_SCHEMA_VERSION) corrupt('Provider Profile operation entry schema is unsupported')
  if (typeof value.operationId !== 'string' || !SAFE_ID.test(value.operationId)) corrupt('Provider Profile operationId is invalid')
  if (value.operation !== 'import' && value.operation !== 'rollback') corrupt('Provider Profile operation kind is invalid')
}

function assertEntryPhase(value: unknown): void {
  const phases: ProviderProfileOperationPhase[] = [
    'prepared',
    'waiting_reconciliation',
    'committed',
    'aborted'
  ]
  if (!phases.includes(value as ProviderProfileOperationPhase)) corrupt('Provider Profile operation phase is invalid')
}

function assertEntrySnapshotDigests(value: Record<string, unknown>): void {
  assertJournalDigest(value.beforeSnapshotDigest, 'Provider Profile before snapshot digest is invalid')
  assertJournalDigest(value.desiredSnapshotDigest, 'Provider Profile desired snapshot digest is invalid')
}

function assertEntrySafetyBackup(value: Record<string, unknown>): void {
  assertJournalSafeId(value.safetyBackupId, 'Provider Profile operation safety backup ID is invalid')
  assertJournalDigest(value.safetyBackupDigest, 'Provider Profile operation safety backup digest is invalid')
}

function assertEntryRollbackBackup(value: Record<string, unknown>): void {
  assertJournalSafeId(value.sourceBackupId, 'Provider Profile rollback source backup ID is invalid')
  assertJournalDigest(value.sourceBackupDigest, 'Provider Profile rollback source backup digest is invalid')
  if (value.sourceBackupId === value.safetyBackupId) corrupt('Provider Profile rollback backups must be distinct')
}

function assertEntryTimestamps(value: Record<string, unknown>): void {
  assertJournalTimestamp(value.createdAt)
  assertJournalTimestamp(value.updatedAt)
  if (value.updatedAt < value.createdAt) corrupt('Provider Profile operation timestamps are inconsistent')
}

function assertJournalSafeId(value: unknown, message: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) corrupt(message)
}

function assertJournalDigest(value: unknown, message: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256.test(value)) corrupt(message)
}

function assertJournalTimestamp(value: unknown): asserts value is number {
  if (!isNonNegativeSafeInteger(value)) corrupt('Provider Profile operation timestamps are invalid')
}

function assertPrepareInput(input: PrepareProviderProfileOperationInput): void {
  if (!input || typeof input !== 'object') invalidInput('Provider Profile operation input is invalid')
  if (input.operationId !== undefined) assertSafeId(input.operationId, 'operationId')
  if (input.operation !== 'import' && input.operation !== 'rollback') {
    invalidInput('Provider Profile operation must be import or rollback')
  }
  assertSnapshotDigest(input.beforeSnapshotDigest, 'beforeSnapshotDigest')
  assertSnapshotDigest(input.desiredSnapshotDigest, 'desiredSnapshotDigest')
  assertSafeId(input.safetyBackupId, 'safetyBackupId')
  assertSnapshotDigest(input.safetyBackupDigest, 'safetyBackupDigest')
  if (input.operation === 'rollback') {
    if (input.sourceBackupId === undefined || input.sourceBackupDigest === undefined) {
      invalidInput('Provider Profile rollback requires a source backup digest binding')
    }
    assertSafeId(input.sourceBackupId, 'sourceBackupId')
    assertSnapshotDigest(input.sourceBackupDigest, 'sourceBackupDigest')
    if (input.sourceBackupId === input.safetyBackupId) {
      invalidInput('Provider Profile rollback backups must be distinct')
    }
  } else if (input.sourceBackupId !== undefined || input.sourceBackupDigest !== undefined) {
    invalidInput('Provider Profile import must not include a source backup')
  }
}

function assertSafeId(value: string, field: string): void {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) invalidInput(`Provider Profile ${field} is invalid`)
}

function assertSnapshotDigest(value: string, field: string): void {
  if (typeof value !== 'string' || !SHA256.test(value)) invalidInput(`Provider Profile ${field} is invalid`)
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    corrupt(`Provider Profile operation ${label} contains unknown or missing fields`)
  }
}

function journalPayload(
  document: Pick<ProviderProfileOperationJournalDocument, 'kind' | 'schemaVersion' | 'revision' | 'entries'>
): ProviderProfileOperationJournalPayload {
  return {
    kind: JOURNAL_KIND,
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    revision: document.revision,
    entries: document.entries.map(cloneEntry)
  }
}

function digestJournalPayload(payload: ProviderProfileOperationJournalPayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function transitionToWaitingReconciliation(
  directoryPath: string,
  filePath: string,
  document: ProviderProfileOperationJournalDocument,
  entry: ProviderProfileOperationJournalEntry
): void {
  entry.phase = 'waiting_reconciliation'
  entry.updatedAt = Math.max(Date.now(), entry.createdAt)
  persistJournal(directoryPath, filePath, document)
}

function isUnresolvedEntry(entry: ProviderProfileOperationJournalEntry): boolean {
  return entry.phase === 'prepared' || entry.phase === 'waiting_reconciliation'
}

function resolveCurrentSnapshotDigest(value: string | (() => string)): string {
  const digest = typeof value === 'function' ? value() : value
  assertSnapshotDigest(digest, 'currentSnapshotDigest')
  return digest
}

function retainRecentTerminalEntries(
  entries: ProviderProfileOperationJournalEntry[]
): ProviderProfileOperationJournalEntry[] {
  return entries
    .filter((entry) => !isUnresolvedEntry(entry))
    .slice(-(MAX_JOURNAL_ENTRIES - 1))
    .map(cloneEntry)
}

function cloneEntry(entry: ProviderProfileOperationJournalEntry): ProviderProfileOperationJournalEntry {
  return { ...entry }
}

function cloneDocument(document: ProviderProfileOperationJournalDocument): ProviderProfileOperationJournalDocument {
  return { ...document, entries: document.entries.map(cloneEntry) }
}

function lstatIfPresent(filePath: string): Stats | null {
  try {
    return lstatSync(filePath)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function invalidInput(message: string): never {
  throw new ProviderProfileOperationJournalError('INVALID_INPUT', message)
}

function corrupt(message: string): never {
  throw new ProviderProfileOperationJournalError('JOURNAL_CORRUPT', message)
}
