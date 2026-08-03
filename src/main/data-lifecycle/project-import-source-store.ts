import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { ProjectAggregateExportBundle } from '../../shared/project-aggregate-types'
import { projectAggregateCanonicalJson, projectAggregateDigest } from '../project-aggregate/codec'
import { parseProjectAggregateImport } from './project-import-validation'

const SOURCE_FORMAT = 'caogen.project-import-source.v1' as const

interface ProjectImportSource {
  schemaVersion: 1
  format: typeof SOURCE_FORMAT
  operationId: string
  projectId: string
  createdAt: number
  bundle: ProjectAggregateExportBundle
  sourceDigest: string
}

export interface ProjectImportSourceReceipt {
  path: string
  sourceDigest: string
  exportDigest: string
}

export class ProjectImportSourceStore {
  readonly rootDir: string

  constructor(userDataRoot: string) {
    this.rootDir = join(requiredRoot(userDataRoot), 'private', 'project-import-sources')
  }

  write(operationId: string, bundle: ProjectAggregateExportBundle): ProjectImportSourceReceipt {
    const file = this.pathFor(operationId, bundle.projectId)
    if (existsSync(file)) return this.verify(file, operationId, bundle.projectId)
    parseProjectAggregateImport(bundle)
    const body = {
      schemaVersion: 1 as const,
      format: SOURCE_FORMAT,
      operationId: requiredId(operationId, 'operationId'),
      projectId: requiredId(bundle.projectId, 'projectId'),
      createdAt: Date.now(),
      bundle
    }
    const source: ProjectImportSource = { ...body, sourceDigest: projectAggregateDigest(body) }
    atomicPrivateWrite(file, `${projectAggregateCanonicalJson(source)}\n`)
    return this.verify(file, operationId, bundle.projectId)
  }

  read(file: string, operationId: string, projectId: string): ProjectImportSource {
    const expected = this.pathFor(operationId, projectId)
    if (resolve(file) !== expected) throw new Error('Project import source path does not match its operation')
    const stat = lstatSync(expected)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Project import source is not a regular file')
    const value = JSON.parse(readFileSync(expected, 'utf8')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Project import source is invalid')
    const source = value as Partial<ProjectImportSource>
    if (source.schemaVersion !== 1 || source.format !== SOURCE_FORMAT || source.operationId !== operationId ||
        source.projectId !== projectId || typeof source.createdAt !== 'number' || !source.bundle ||
        typeof source.sourceDigest !== 'string') throw new Error('Project import source identity is invalid')
    const { sourceDigest, ...body } = source as ProjectImportSource
    if (projectAggregateDigest(body) !== sourceDigest) throw new Error('Project import source digest mismatch')
    parseProjectAggregateImport(source.bundle)
    return structuredClone(source as ProjectImportSource)
  }

  verify(file: string, operationId: string, projectId: string): ProjectImportSourceReceipt {
    const source = this.read(file, operationId, projectId)
    return { path: resolve(file), sourceDigest: source.sourceDigest, exportDigest: source.bundle.exportDigest }
  }

  private pathFor(operationId: string, projectId: string): string {
    const project = projectAggregateDigest({ projectId: requiredId(projectId, 'projectId') }).slice(0, 24)
    const operation = projectAggregateDigest({ operationId: requiredId(operationId, 'operationId') }).slice(0, 32)
    return resolve(this.rootDir, project, `${operation}.json`)
  }
}

function atomicPrivateWrite(file: string, content: string): void {
  const directory = dirname(file)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(directory, 0o700)
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, file)
    if (process.platform !== 'win32') chmodSync(file, 0o600)
    const directoryHandle = process.platform === 'win32' ? undefined : openSync(directory, 'r')
    if (directoryHandle !== undefined) {
      try { fsyncSync(directoryHandle) } finally { closeSync(directoryHandle) }
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    rmSync(temporary, { force: true })
    throw error
  }
}

function requiredRoot(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('userDataRoot is required')
  return resolve(value)
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\0-\x1f\x7f]/.test(value)) throw new Error(`${label} is required`)
  return value.trim()
}
