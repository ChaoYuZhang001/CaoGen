import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  PROJECT_AGGREGATE_OBJECT_KINDS,
  PROJECT_AGGREGATE_SCHEMA_VERSION,
  type ProjectAggregateSeal
} from '../../shared/project-aggregate-types'
import { projectAggregateDigest } from './codec'
import { ProjectAggregateError, requiredProjectId } from './errors'

const STORE_FORMAT = 'caogen.project-aggregate-seals.v1' as const
const STORE_FILE = 'project-aggregate-seals.json'

interface ProjectAggregateSealDocument {
  schemaVersion: typeof PROJECT_AGGREGATE_SCHEMA_VERSION
  format: typeof STORE_FORMAT
  revision: number
  projects: ProjectAggregateSeal[]
  documentDigest: string
}

export class ProjectAggregateSealStore {
  readonly filePath: string
  readonly lockPath: string

  constructor(rootDir: string) {
    if (typeof rootDir !== 'string' || !rootDir.trim() || rootDir.includes('\0')) {
      throw new ProjectAggregateError('INVALID_INPUT', 'aggregateRoot is required')
    }
    this.filePath = join(resolve(rootDir), STORE_FILE)
    this.lockPath = `${this.filePath}.lock`
  }

  readProject(projectId: string): ProjectAggregateSeal | undefined {
    const id = requiredProjectId(projectId)
    return clone(this.readDocument().projects.find((project) => project.projectId === id))
  }

  readRevision(): number {
    return this.readDocument().revision
  }

  writeProject(
    seal: Omit<ProjectAggregateSeal, 'aggregateRevision'>,
    expectedAggregateRevision?: number
  ): ProjectAggregateSeal {
    const lock = acquireLock(this.lockPath)
    try {
      const document = this.readDocument()
      const index = document.projects.findIndex((project) => project.projectId === seal.projectId)
      const current = index < 0 ? undefined : document.projects[index]
      const currentRevision = current?.aggregateRevision ?? 0
      if (expectedAggregateRevision !== undefined && expectedAggregateRevision !== currentRevision) {
        throw new ProjectAggregateError(
          'REVISION_CONFLICT',
          `stale_revision: Project aggregate ${seal.projectId} is at ${currentRevision}`,
          { projectId: seal.projectId, expectedAggregateRevision, actualAggregateRevision: currentRevision }
        )
      }
      const next: ProjectAggregateSeal = {
        ...clone(seal),
        aggregateRevision: currentRevision + 1
      }
      validateSeal(next, this.filePath)
      if (index < 0) document.projects.push(next)
      else document.projects[index] = next
      document.projects.sort((left, right) => left.projectId.localeCompare(right.projectId))
      document.revision += 1
      this.writeDocument(document)
      return clone(next)
    } finally {
      releaseLock(this.lockPath, lock)
    }
  }

  private readDocument(): ProjectAggregateSealDocument {
    if (!existsSync(this.filePath)) return emptyDocument()
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
    } catch (error) {
      throw new ProjectAggregateError(
        'STORE_CORRUPT',
        `Project aggregate seal store is not valid JSON: ${message(error)}`
      )
    }
    return validateDocument(parsed, this.filePath)
  }

  private writeDocument(document: ProjectAggregateSealDocument): void {
    const directory = dirname(this.filePath)
    mkdirSync(directory, { recursive: true })
    const candidate = withDocumentDigest(document)
    const temporary = join(directory, `.${randomUUID()}.project-aggregate.tmp`)
    let descriptor: number | undefined
    try {
      descriptor = openSync(temporary, 'wx', 0o600)
      writeFileSync(descriptor, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporary, this.filePath)
      fsyncDirectory(directory)
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor)
      rmSync(temporary, { force: true })
      throw error
    }
  }
}

function emptyDocument(): ProjectAggregateSealDocument {
  return withDocumentDigest({
    schemaVersion: PROJECT_AGGREGATE_SCHEMA_VERSION,
    format: STORE_FORMAT,
    revision: 0,
    projects: [],
    documentDigest: ''
  })
}

function withDocumentDigest(document: ProjectAggregateSealDocument): ProjectAggregateSealDocument {
  const { documentDigest: _ignored, ...payload } = document
  return { ...payload, documentDigest: projectAggregateDigest(payload) }
}

function validateDocument(value: unknown, filePath: string): ProjectAggregateSealDocument {
  if (!isRecord(value) || value.schemaVersion !== PROJECT_AGGREGATE_SCHEMA_VERSION || value.format !== STORE_FORMAT) {
    throw new ProjectAggregateError('STORE_CORRUPT', `Project aggregate seal identity is invalid: ${filePath}`)
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !Array.isArray(value.projects)) {
    throw new ProjectAggregateError('STORE_CORRUPT', `Project aggregate seal structure is invalid: ${filePath}`)
  }
  const document = value as unknown as ProjectAggregateSealDocument
  const expected = withDocumentDigest(document).documentDigest
  if (document.documentDigest !== expected) {
    throw new ProjectAggregateError('STORE_CORRUPT', `Project aggregate seal digest mismatch: ${filePath}`)
  }
  const ids = new Set<string>()
  for (const seal of document.projects) {
    validateSeal(seal, filePath)
    if (ids.has(seal.projectId)) {
      throw new ProjectAggregateError('STORE_CORRUPT', `Duplicate Project aggregate seal: ${seal.projectId}`)
    }
    ids.add(seal.projectId)
  }
  return clone(document)
}

function validateSeal(seal: ProjectAggregateSeal, filePath: string): void {
  if (!isRecord(seal) || seal.schemaVersion !== PROJECT_AGGREGATE_SCHEMA_VERSION) {
    throw new ProjectAggregateError('STORE_CORRUPT', `Project aggregate seal schema is invalid: ${filePath}`)
  }
  requiredProjectId(seal.projectId)
  validateSealCounters(seal, filePath)
  for (const digest of [seal.identityDigest, seal.aggregateDigest]) assertDigest(digest, filePath)
  validateSealObjects(seal, filePath)
}

function validateSealCounters(seal: ProjectAggregateSeal, filePath: string): void {
  for (const [key, value] of [
    ['aggregateRevision', seal.aggregateRevision],
    ['projectRevision', seal.projectRevision],
    ['sealedAt', seal.sealedAt]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < (key === 'aggregateRevision' ? 1 : 0)) {
      throw new ProjectAggregateError('STORE_CORRUPT', `Project aggregate seal ${key} is invalid: ${filePath}`)
    }
  }
}

function validateSealObjects(seal: ProjectAggregateSeal, filePath: string): void {
  if (!isRecord(seal.objectCounts) || !isRecord(seal.objectDigests)) {
    throw new ProjectAggregateError('STORE_CORRUPT', `Project aggregate object seal is invalid: ${filePath}`)
  }
  for (const kind of PROJECT_AGGREGATE_OBJECT_KINDS) {
    if (!Number.isSafeInteger(seal.objectCounts[kind]) || seal.objectCounts[kind] < 0) {
      throw new ProjectAggregateError('STORE_CORRUPT', `Project aggregate ${kind} count is invalid: ${filePath}`)
    }
    const digests = seal.objectDigests[kind]
    if (!isRecord(digests) || Object.keys(digests).length !== seal.objectCounts[kind]) {
      throw new ProjectAggregateError('STORE_CORRUPT', `Project aggregate ${kind} digest set is invalid: ${filePath}`)
    }
    for (const digest of Object.values(digests)) assertDigest(digest, filePath)
  }
}

function assertDigest(value: unknown, filePath: string): void {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new ProjectAggregateError('STORE_CORRUPT', `Project aggregate digest is invalid: ${filePath}`)
  }
}

function acquireLock(lockPath: string): number {
  mkdirSync(dirname(lockPath), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, 'wx', 0o600)
      writeFileSync(descriptor, `${process.pid}\n`, 'utf8')
      fsyncSync(descriptor)
      return descriptor
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!recoverAbandonedLock(lockPath)) {
        throw new ProjectAggregateError('STORE_LOCKED', `Project aggregate seal store is locked: ${lockPath}`)
      }
    }
  }
  throw new ProjectAggregateError('STORE_LOCKED', `Project aggregate seal store is locked: ${lockPath}`)
}

function recoverAbandonedLock(lockPath: string): boolean {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
    if (Number.isSafeInteger(pid) && pid > 0 && processAlive(pid)) return false
    unlinkSync(lockPath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    return false
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function releaseLock(lockPath: string, descriptor: number): void {
  try {
    fsyncSync(descriptor)
  } catch {
    // The descriptor still has to be closed on filesystems that reject fsync.
  }
  closeSync(descriptor)
  try {
    unlinkSync(lockPath)
  } catch {
    // A recovered lock is already absent.
  }
}

function fsyncDirectory(directory: string): void {
  if (process.platform === 'win32') return
  let descriptor: number | undefined
  try {
    descriptor = openSync(directory, constants.O_RDONLY)
    fsyncSync(descriptor)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
