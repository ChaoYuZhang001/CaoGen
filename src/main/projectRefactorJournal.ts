import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'

const JOURNAL_VERSION = 1
const JOURNAL_DIRECTORY = 'project-refactor-journal'
const MAX_RECORDS = 50
const MAX_RECORD_BYTES = 45_000_000
const MAX_TOTAL_JOURNAL_BYTES = 250_000_000
const STALE_TEMPORARY_MS = 24 * 60 * 60_000
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/
const TEMPORARY_RECORD = /^\.[0-9a-f-]{36}\.\d+\.[0-9a-f-]{36}\.tmp$/i

export type ProjectRefactorJournalStage = 'applying' | 'applied' | 'rolling_back' | 'recovered' | 'superseded' | 'blocked'

export interface ProjectRefactorJournalScan {
  records: ProjectRefactorJournalRecord[]
  corruptCount: number
}

export interface ProjectRefactorJournalSnapshot {
  path: string
  before: string
  after: string
  beforeDigest: string
  afterDigest: string
}

export interface ProjectRefactorJournalRecord {
  version: typeof JOURNAL_VERSION
  operationId: string
  sessionId: string
  root: string
  kind: 'typescript-rename'
  stage: ProjectRefactorJournalStage
  snapshots: ProjectRefactorJournalSnapshot[]
  createdAt: string
  updatedAt: string
  appliedAt?: string
  recoveredAt?: string
  blockedReason?: string
  integrity: string
}

let configuredRoot = ''

export function configureProjectRefactorJournal(userDataRoot: string): void {
  if (typeof userDataRoot !== 'string' || !userDataRoot.trim() || userDataRoot.includes('\0')) {
    throw new Error('Project refactor journal root is invalid')
  }
  configuredRoot = path.resolve(userDataRoot)
}

export function createProjectRefactorJournalRecord(input: Omit<ProjectRefactorJournalRecord, 'version' | 'integrity'>): ProjectRefactorJournalRecord {
  return seal({ version: JOURNAL_VERSION, ...input })
}

export async function writeProjectRefactorJournal(record: ProjectRefactorJournalRecord): Promise<ProjectRefactorJournalRecord> {
  const sealed = seal({ ...record, version: JOURNAL_VERSION })
  validateRecord(sealed)
  const directory = await ensureJournalDirectory()
  const target = recordPath(directory, sealed.operationId)
  const temporary = path.join(directory, `.${sealed.operationId}.${process.pid}.${randomUUID()}.tmp`)
  const body = `${JSON.stringify(sealed)}\n`
  const bodyBytes = Buffer.byteLength(body, 'utf8')
  if (bodyBytes > MAX_RECORD_BYTES) throw new Error('Project refactor journal exceeds its size limit')
  await ensureJournalCapacity(directory, sealed.operationId, bodyBytes)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(body, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  return sealed
}

export async function scanProjectRefactorJournals(): Promise<ProjectRefactorJournalScan> {
  const directory = journalDirectory()
  await cleanupStaleTemporaryFiles(directory)
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const journalNames = names.filter((name) => name.endsWith('.json')).sort()
  const records: ProjectRefactorJournalRecord[] = []
  let corruptCount = 0
  for (const name of journalNames) {
    if (!OPERATION_ID.test(path.basename(name, '.json')) || records.length >= MAX_RECORDS) {
      corruptCount += 1
      continue
    }
    try {
      records.push(await readRecord(path.join(directory, name)))
    } catch {
      corruptCount += 1
    }
  }
  return {
    records: records.sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    corruptCount
  }
}

export async function removeProjectRefactorJournal(operationId: string): Promise<void> {
  requiredOperationId(operationId)
  await rm(recordPath(journalDirectory(), operationId), { force: true })
}

function journalDirectory(): string {
  const root = configuredRoot || process.env.CAOGEN_USER_DATA_DIR
  if (!root) throw new Error('Project refactor journal is not configured')
  return path.join(path.resolve(root), JOURNAL_DIRECTORY)
}

async function ensureJournalDirectory(): Promise<string> {
  const directory = journalDirectory()
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await stat(directory)
  if (!info.isDirectory()) throw new Error('Project refactor journal root is not a directory')
  await cleanupStaleTemporaryFiles(directory)
  return directory
}

function recordPath(directory: string, operationId: string): string {
  requiredOperationId(operationId)
  return path.join(directory, `${operationId}.json`)
}

async function readRecord(filePath: string): Promise<ProjectRefactorJournalRecord> {
  const info = await stat(filePath)
  if (!info.isFile() || info.size > MAX_RECORD_BYTES) throw new Error('Project refactor journal record is invalid or too large')
  const raw = JSON.parse(await readFile(filePath, 'utf8')) as unknown
  validateRecord(raw)
  const record = raw as ProjectRefactorJournalRecord
  if (seal(withoutIntegrity(record)).integrity !== record.integrity) {
    throw new Error('Project refactor journal integrity check failed')
  }
  return record
}

async function ensureJournalCapacity(directory: string, operationId: string, bodyBytes: number): Promise<void> {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith('.json') && name !== `${operationId}.json`)
  let existingBytes = 0
  const disposable: Array<{ name: string; updatedAt: string; priority: number; bytes: number }> = []
  for (const name of names) {
    const bytes = await stat(path.join(directory, name)).then((info) => info.size).catch(() => MAX_RECORD_BYTES)
    existingBytes += bytes
    try {
      const record = await readRecord(path.join(directory, name))
      if (record.stage === 'recovered' || record.stage === 'superseded' || record.stage === 'applied') {
        disposable.push({
          name,
          updatedAt: record.updatedAt,
          priority: record.stage === 'applied' ? 1 : 0,
          bytes
        })
      }
    } catch {
      // Corrupt records are never deleted automatically.
    }
  }
  disposable.sort((left, right) => left.priority - right.priority || left.updatedAt.localeCompare(right.updatedAt))
  while ((names.length >= MAX_RECORDS || existingBytes + bodyBytes > MAX_TOTAL_JOURNAL_BYTES) && disposable.length > 0) {
    const oldest = disposable.shift()
    if (!oldest) break
    await rm(path.join(directory, oldest.name), { force: true })
    names.splice(names.indexOf(oldest.name), 1)
    existingBytes -= oldest.bytes
  }
  if (names.length >= MAX_RECORDS || existingBytes + bodyBytes > MAX_TOTAL_JOURNAL_BYTES) {
    throw new Error('Project refactor journal is full; resolve or roll back an earlier refactor first')
  }
}

async function cleanupStaleTemporaryFiles(directory: string): Promise<void> {
  const cutoff = Date.now() - STALE_TEMPORARY_MS
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const name of names) {
    if (!TEMPORARY_RECORD.test(name)) continue
    const filePath = path.join(directory, name)
    const info = await stat(filePath).catch(() => null)
    if (info?.isFile() && info.mtimeMs < cutoff) await rm(filePath, { force: true }).catch(() => undefined)
  }
}

function seal(record: Omit<ProjectRefactorJournalRecord, 'integrity'> | ProjectRefactorJournalRecord): ProjectRefactorJournalRecord {
  const body = withoutIntegrity(record)
  return { ...body, integrity: createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex') }
}

function withoutIntegrity(record: Omit<ProjectRefactorJournalRecord, 'integrity'> | ProjectRefactorJournalRecord): Omit<ProjectRefactorJournalRecord, 'integrity'> {
  const { integrity: _integrity, ...body } = record as ProjectRefactorJournalRecord
  return body
}

function validateRecord(value: unknown): asserts value is ProjectRefactorJournalRecord {
  if (!isRecord(value) || value.version !== JOURNAL_VERSION || value.kind !== 'typescript-rename' ||
    !OPERATION_ID.test(String(value.operationId)) || typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 512 ||
    typeof value.root !== 'string' || !path.isAbsolute(value.root) || value.root.includes('\0') ||
    !['applying', 'applied', 'rolling_back', 'recovered', 'superseded', 'blocked'].includes(String(value.stage)) ||
    !Array.isArray(value.snapshots) || value.snapshots.length === 0 || value.snapshots.length > 200 ||
    !validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt) || !SHA256.test(String(value.integrity))) {
    throw new Error('Project refactor journal record is invalid')
  }
  for (const snapshot of value.snapshots) validateSnapshot(snapshot)
  if (value.appliedAt !== undefined && !validTimestamp(value.appliedAt)) throw new Error('Project refactor journal appliedAt is invalid')
  if (value.recoveredAt !== undefined && !validTimestamp(value.recoveredAt)) throw new Error('Project refactor journal recoveredAt is invalid')
  if (value.blockedReason !== undefined && (typeof value.blockedReason !== 'string' || value.blockedReason.length > 1_000)) {
    throw new Error('Project refactor journal blocked reason is invalid')
  }
}

function validateSnapshot(value: unknown): void {
  if (!isRecord(value) || typeof value.path !== 'string' || !value.path || value.path.length > 4_096 ||
    path.isAbsolute(value.path) || value.path.includes('\0') || typeof value.before !== 'string' || typeof value.after !== 'string' ||
    !SHA256.test(String(value.beforeDigest)) || !SHA256.test(String(value.afterDigest))) {
    throw new Error('Project refactor journal snapshot is invalid')
  }
  if (Buffer.byteLength(value.before, 'utf8') > 1_000_000 || Buffer.byteLength(value.after, 'utf8') > 1_000_000) {
    throw new Error('Project refactor journal snapshot exceeds its size limit')
  }
  const normalized = path.normalize(value.path)
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error('Project refactor journal snapshot escapes the workspace')
  }
}

function requiredOperationId(value: string): void {
  if (!OPERATION_ID.test(value)) throw new Error('Project refactor operation ID is invalid')
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 20 && value.length <= 40 && Number.isFinite(Date.parse(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
