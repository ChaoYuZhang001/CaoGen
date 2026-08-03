import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { acquireFileLock, enqueueMutation, releaseFileLock } from '../digital-worker/persistence'
import type { ProjectDeletionExternalResourceBoundary } from './project-deletion-proof-store'

export const PROJECT_DELETION_PHASES = [
  'prepared',
  'backup_written',
  'workflow_purged',
  'project_stores_purged',
  'automation_purged',
  'session_data_purged',
  'learning_purged',
  'workspace_purged',
  'verified',
  'proof_written',
  'completed'
] as const

export type ProjectDeletionPhase = typeof PROJECT_DELETION_PHASES[number]

export interface ProjectDeletionJournalEntry {
  schemaVersion: 1
  operationId: string
  projectId: string
  expectedWorkspaceRevision: number
  phase: ProjectDeletionPhase
  sessionIds: string[]
  sdkSessionIds: string[]
  artifactBlobDigests: string[]
  externalResources?: ProjectDeletionExternalResourceBoundary[]
  backupPath?: string
  backupDigest?: string
  exportDigest?: string
  proofPath?: string
  proofDigest?: string
  createdAt: number
  updatedAt: number
  completedAt?: number
}

interface JournalDocument {
  schemaVersion: 1
  revision: number
  entries: ProjectDeletionJournalEntry[]
}

export class ProjectDeletionJournal {
  readonly filePath: string
  private readonly lockPath: string

  constructor(userDataRoot: string) {
    this.filePath = join(requiredRoot(userDataRoot), 'private', 'project-deletion-journal.json')
    this.lockPath = `${this.filePath}.lock`
  }

  listPending(): ProjectDeletionJournalEntry[] {
    return readDocument(this.filePath).entries.filter((entry) => entry.phase !== 'completed').map(clone)
  }

  getPendingProject(projectId: string): ProjectDeletionJournalEntry | undefined {
    const id = requiredId(projectId, 'projectId')
    return clone(readDocument(this.filePath).entries.find((entry) => entry.projectId === id && entry.phase !== 'completed'))
  }

  getOperation(operationId: string): ProjectDeletionJournalEntry | undefined {
    const id = requiredId(operationId, 'operationId')
    return clone(readDocument(this.filePath).entries.find((entry) => entry.operationId === id))
  }

  async begin(input: Omit<ProjectDeletionJournalEntry, 'schemaVersion' | 'operationId' | 'phase' | 'createdAt' | 'updatedAt'>): Promise<ProjectDeletionJournalEntry> {
    const projectId = requiredId(input.projectId, 'projectId')
    return this.mutate((document) => {
      const pending = document.entries.find((entry) => entry.projectId === projectId && entry.phase !== 'completed')
      if (pending) return pending
      const now = Date.now()
      const entry: ProjectDeletionJournalEntry = {
        schemaVersion: 1,
        operationId: randomUUID(),
        projectId,
        expectedWorkspaceRevision: input.expectedWorkspaceRevision,
        phase: 'prepared',
        sessionIds: normalizedIds(input.sessionIds),
        sdkSessionIds: normalizedIds(input.sdkSessionIds),
        artifactBlobDigests: normalizedDigests(input.artifactBlobDigests),
        ...(input.externalResources
          ? { externalResources: normalizedExternalResources(input.externalResources) }
          : {}),
        createdAt: now,
        updatedAt: now
      }
      document.entries.push(entry)
      return entry
    })
  }

  async advance(
    operationId: string,
    phase: ProjectDeletionPhase,
    patch: Partial<Pick<ProjectDeletionJournalEntry,
      'backupPath' | 'backupDigest' | 'exportDigest' | 'proofPath' | 'proofDigest'>> = {}
  ): Promise<ProjectDeletionJournalEntry> {
    const id = requiredId(operationId, 'operationId')
    const targetIndex = PROJECT_DELETION_PHASES.indexOf(phase)
    if (targetIndex < 0) throw new Error('project deletion phase is invalid')
    return this.mutate((document) => {
      const entry = document.entries.find((candidate) => candidate.operationId === id)
      if (!entry) throw new Error(`project deletion operation not found: ${id}`)
      const currentIndex = PROJECT_DELETION_PHASES.indexOf(entry.phase)
      if (targetIndex < currentIndex) return entry
      if (targetIndex > currentIndex + 1) throw new Error(`project deletion phase cannot skip ${entry.phase} -> ${phase}`)
      entry.phase = phase
      entry.updatedAt = Date.now()
      Object.assign(entry, patch)
      if (phase === 'completed') entry.completedAt = entry.updatedAt
      return entry
    })
  }

  private async mutate<T>(operation: (document: JournalDocument) => T): Promise<T> {
    return enqueueMutation(this.filePath, async () => {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
      const lock = acquireFileLock(this.lockPath)
      try {
        const document = readDocument(this.filePath)
        const result = operation(document)
        document.revision += 1
        writeDocument(this.filePath, document)
        return clone(result)
      } finally {
        releaseFileLock(this.lockPath, lock)
      }
    })
  }
}

function readDocument(file: string): JournalDocument {
  if (!existsSync(file)) return { schemaVersion: 1, revision: 0, entries: [] }
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
  assertDocument(parsed)
  return clone(parsed)
}

function writeDocument(file: string, document: JournalDocument): void {
  const directory = dirname(file)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, file)
    if (process.platform !== 'win32') {
      const directoryHandle = openSync(directory, 'r')
      try { fsyncSync(directoryHandle) } finally { closeSync(directoryHandle) }
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    rmSync(temporary, { force: true })
    throw error
  }
}

function assertDocument(value: unknown): asserts value is JournalDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('project deletion journal is invalid')
  const document = value as Partial<JournalDocument>
  if (document.schemaVersion !== 1 || !Number.isSafeInteger(document.revision) || !Array.isArray(document.entries)) {
    throw new Error('project deletion journal is invalid')
  }
  const operations = new Set<string>()
  for (const entry of document.entries) {
    assertJournalEntry(entry)
    if (operations.has(entry.operationId)) throw new Error('project deletion journal contains duplicate operations')
    assertPhaseReceipts(entry)
    operations.add(entry.operationId)
  }
}

function assertJournalEntry(entry: ProjectDeletionJournalEntry): void {
  const fieldsValid = [
    entry.schemaVersion === 1,
    Boolean(requiredId(entry.operationId, 'operationId')),
    Boolean(requiredId(entry.projectId, 'projectId')),
    Number.isSafeInteger(entry.expectedWorkspaceRevision),
    entry.expectedWorkspaceRevision >= 0,
    PROJECT_DELETION_PHASES.includes(entry.phase),
    Array.isArray(entry.sessionIds),
    Array.isArray(entry.sdkSessionIds),
    Array.isArray(entry.artifactBlobDigests),
    entry.artifactBlobDigests.every(isDigest),
    optionalExternalResources(entry.externalResources),
    typeof entry.createdAt === 'number',
    typeof entry.updatedAt === 'number'
  ].every(Boolean)
  if (!fieldsValid) throw new Error('project deletion journal entry is invalid')
}

function assertPhaseReceipts(entry: ProjectDeletionJournalEntry): void {
  const phase = PROJECT_DELETION_PHASES.indexOf(entry.phase)
  if (phase >= PROJECT_DELETION_PHASES.indexOf('backup_written') && !hasBackupReceipt(entry)) {
    throw new Error('project deletion journal backup receipt is invalid')
  }
  if (entry.externalResources && phase >= PROJECT_DELETION_PHASES.indexOf('proof_written') && !hasProofReceipt(entry)) {
    throw new Error('project deletion journal proof receipt is invalid')
  }
  if (entry.phase === 'completed' && !hasCompletionTimestamp(entry)) {
    throw new Error('project deletion journal completion timestamp is invalid')
  }
}

function hasBackupReceipt(entry: ProjectDeletionJournalEntry): boolean {
  return [isPath(entry.backupPath), isHexDigest(entry.backupDigest), isHexDigest(entry.exportDigest)].every(Boolean)
}

function hasProofReceipt(entry: ProjectDeletionJournalEntry): boolean {
  return [isPath(entry.proofPath), isHexDigest(entry.proofDigest)].every(Boolean)
}

function hasCompletionTimestamp(entry: ProjectDeletionJournalEntry): boolean {
  return Number.isSafeInteger(entry.completedAt) && Number(entry.completedAt) >= entry.updatedAt
}

function optionalExternalResources(value: unknown): boolean {
  return value === undefined ? true : isExternalResources(value)
}

function normalizedExternalResources(
  values: readonly ProjectDeletionExternalResourceBoundary[]
): ProjectDeletionExternalResourceBoundary[] {
  if (!isExternalResources(values)) throw new Error('project deletion external resource inventory is invalid')
  return structuredClone(values).sort((left, right) => left.id.localeCompare(right.id))
}

function isExternalResources(value: unknown): value is ProjectDeletionExternalResourceBoundary[] {
  if (!Array.isArray(value)) return false
  const ids = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id) ||
        typeof item.kind !== 'string' || typeof item.locationDigest !== 'string' || !/^[a-f0-9]{64}$/.test(item.locationDigest) ||
        !['not_local', 'missing', 'file', 'directory', 'symlink', 'other'].includes(item.state)) return false
    ids.add(item.id)
  }
  return true
}

function normalizedIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => requiredId(value, 'session id')))].sort()
}

function normalizedDigests(values: readonly string[]): string[] {
  if (!values.every(isDigest)) throw new Error('artifact blob digest is invalid')
  return [...new Set(values)].sort()
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}

function isHexDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isPath(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && !value.includes('\0')
}

function requiredRoot(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('userDataRoot is required')
  return resolve(value)
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\0-\x1f\x7f]/.test(value)) throw new Error(`${label} is required`)
  return value.trim()
}

function clone<T>(value: T): T {
  return structuredClone(value)
}
