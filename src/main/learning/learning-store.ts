import { createHash, randomUUID } from 'node:crypto'
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
  writeFileSync
} from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { LearningAuditEvent, LearningRecord } from '../../shared/learning-types'

export type LearningMaterializationStatus = 'pending' | 'failed' | 'clean'

export interface LearningMaterializationJournal {
  generation: number
  status: LearningMaterializationStatus
  updatedAt: string
  lastError?: string
}

export interface LearningPersistedState {
  schemaVersion: 1
  project: string
  records: LearningRecord[]
  audit: LearningAuditEvent[]
  materialization?: LearningMaterializationJournal
}

const HASH_NAMESPACE = 'agent-desk-project-memory-v1'
const mutationTails = new Map<string, Promise<void>>()
let configuredUserDataRoot: string | undefined

export function configureLearningUserDataRoot(userDataRoot: string): void {
  configuredUserDataRoot = normalizeRequiredPath(userDataRoot, 'userDataRoot')
}

export function learningProjectHash(projectRoot: string): string {
  const normalized = normalizeRequiredPath(projectRoot, 'projectRoot')
  return createHash('sha256').update(`${HASH_NAMESPACE}\0${normalized}`).digest('hex')
}

export function learningStatePath(learningRoot: string, projectRoot: string): string {
  return join(normalizeRequiredPath(learningRoot, 'learningRoot'), 'projects', learningProjectHash(projectRoot), 'learning.json')
}

export async function readLearningState(
  learningRoot: string,
  projectRoot: string
): Promise<LearningPersistedState> {
  const project = learningProjectHash(projectRoot)
  const filePath = learningStatePath(learningRoot, projectRoot)
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState(project)
    throw error
  }
  return parseState(raw, filePath, project)
}

export function learningStateExistsSync(learningRoot: string, projectRoot: string): boolean {
  return existsSync(learningStatePath(learningRoot, projectRoot))
}

export function readLearningStateSync(
  learningRoot: string,
  projectRoot: string
): LearningPersistedState {
  const project = learningProjectHash(projectRoot)
  const filePath = learningStatePath(learningRoot, projectRoot)
  try {
    return parseState(readFileSync(filePath, 'utf8'), filePath, project)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState(project)
    throw error
  }
}

export async function mutateLearningState<T>(
  learningRoot: string,
  projectRoot: string,
  mutation: (state: LearningPersistedState) => T | Promise<T>
): Promise<T> {
  const filePath = learningStatePath(learningRoot, projectRoot)
  const previous = mutationTails.get(filePath) ?? Promise.resolve()
  let releaseTail: (() => void) | undefined
  const tail = new Promise<void>((resolveTail) => {
    releaseTail = resolveTail
  })
  const queued = previous.catch(() => undefined).then(() => tail)
  mutationTails.set(filePath, queued)

  await previous.catch(() => undefined)
  try {
    const state = await readLearningState(learningRoot, projectRoot)
    const result = await mutation(state)
    await writeLearningState(filePath, state)
    return result
  } finally {
    releaseTail?.()
    if (mutationTails.get(filePath) === queued) mutationTails.delete(filePath)
  }
}

export function mutateLearningStateSync<T>(
  learningRoot: string,
  projectRoot: string,
  mutation: (state: LearningPersistedState) => T
): T {
  const filePath = learningStatePath(learningRoot, projectRoot)
  if (mutationTails.has(filePath)) {
    throw new Error(`Learning state mutation is in progress: ${filePath}`)
  }
  const state = readLearningStateSync(learningRoot, projectRoot)
  const result = mutation(state)
  writeLearningStateSync(filePath, state)
  return result
}

export async function resolveDefaultLearningRoot(projectRoot: string, explicitRoot?: string): Promise<string> {
  if (explicitRoot) return normalizeRequiredPath(explicitRoot, 'learningRoot')
  const envRoot = process.env.CAOGEN_USER_DATA_DIR
  if (envRoot) return join(normalizeRequiredPath(envRoot, 'CAOGEN_USER_DATA_DIR'), 'learning')
  if (configuredUserDataRoot) return join(configuredUserDataRoot, 'learning')

  if (process.type === 'browser') {
    try {
      const electron = await import('electron')
      if (electron.app?.getPath) return join(electron.app.getPath('userData'), 'learning')
    } catch {
      // Non-Electron smoke tests fall through to a project-local state root.
    }
  }
  return join(normalizeRequiredPath(projectRoot, 'projectRoot'), '.caogen', 'learning-state')
}

export function resolveDefaultLearningRootSync(projectRoot: string, explicitRoot?: string): string {
  if (explicitRoot) return normalizeRequiredPath(explicitRoot, 'learningRoot')
  const envRoot = process.env.CAOGEN_USER_DATA_DIR
  if (envRoot) return join(normalizeRequiredPath(envRoot, 'CAOGEN_USER_DATA_DIR'), 'learning')
  if (configuredUserDataRoot) return join(configuredUserDataRoot, 'learning')
  return join(normalizeRequiredPath(projectRoot, 'projectRoot'), '.caogen', 'learning-state')
}

function emptyState(project: string): LearningPersistedState {
  return { schemaVersion: 1, project, records: [], audit: [] }
}

async function writeLearningState(filePath: string, state: LearningPersistedState): Promise<void> {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true })
  const temp = join(dir, `.${randomUUID()}.learning.tmp`)
  try {
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    fsyncFileSync(temp)
    await rename(temp, filePath)
    fsyncDirectorySync(dir)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

function writeLearningStateSync(filePath: string, state: LearningPersistedState): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const temp = join(dir, `.${randomUUID()}.learning.tmp`)
  try {
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    fsyncFileSync(temp)
    renameSync(temp, filePath)
    fsyncDirectorySync(dir)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

function fsyncFileSync(filePath: string): void {
  fsyncPathSync(filePath, constants.O_RDONLY | noFollowFlag())
}

function fsyncDirectorySync(directory: string): void {
  if (process.platform === 'win32') return
  fsyncPathSync(directory, constants.O_RDONLY | noFollowFlag())
}

function fsyncPathSync(target: string, flags: number): void {
  let descriptor: number | undefined
  try {
    descriptor = openSync(target, flags)
    fsyncSync(descriptor)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function noFollowFlag(): number {
  return process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
}

function parseState(raw: string, filePath: string, expectedProject: string): LearningPersistedState {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Learning state JSON is invalid: ${filePath}: ${message(error)}`)
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || value.project !== expectedProject) {
    throw new Error(`Learning state identity is invalid: ${filePath}`)
  }
  if (!Array.isArray(value.records) || !Array.isArray(value.audit)) {
    throw new Error(`Learning state collections are invalid: ${filePath}`)
  }
  for (const record of value.records) validateRecord(record, expectedProject, filePath)
  for (const event of value.audit) validateAudit(event, filePath)
  if (value.materialization !== undefined) validateMaterialization(value.materialization, filePath)
  return value as unknown as LearningPersistedState
}

function validateRecord(value: unknown, project: string, filePath: string): void {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.project !== project) {
    throw new Error(`Learning record identity is invalid: ${filePath}`)
  }
  for (const key of ['id', 'logicalId', 'kind', 'scope', 'source', 'digest', 'status', 'createdAt', 'updatedAt']) {
    if (typeof value[key] !== 'string' || !(value[key] as string).trim()) {
      throw new Error(`Learning record field ${key} is invalid: ${filePath}`)
    }
  }
  if (!Number.isInteger(value.version) || (value.version as number) < 1) {
    throw new Error(`Learning record version is invalid: ${filePath}`)
  }
  if (typeof value.confidence !== 'number' || value.confidence < 0 || value.confidence > 1) {
    throw new Error(`Learning record confidence is invalid: ${filePath}`)
  }
  if (!isRecord(value.actor) || !isRecord(value.diff) || !isRecord(value.payload)) {
    throw new Error(`Learning record structured fields are invalid: ${filePath}`)
  }
}

function validateAudit(value: unknown, filePath: string): void {
  if (!isRecord(value)) throw new Error(`Learning audit event is invalid: ${filePath}`)
  for (const key of ['id', 'recordId', 'logicalId', 'action', 'at', 'toStatus']) {
    if (typeof value[key] !== 'string' || !(value[key] as string).trim()) {
      throw new Error(`Learning audit field ${key} is invalid: ${filePath}`)
    }
  }
  if (!isRecord(value.actor)) throw new Error(`Learning audit actor is invalid: ${filePath}`)
}

function validateMaterialization(value: unknown, filePath: string): void {
  if (!isRecord(value) || !Number.isInteger(value.generation) || (value.generation as number) < 0) {
    throw new Error(`Learning materialization generation is invalid: ${filePath}`)
  }
  if (value.status !== 'pending' && value.status !== 'failed' && value.status !== 'clean') {
    throw new Error(`Learning materialization status is invalid: ${filePath}`)
  }
  if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error(`Learning materialization timestamp is invalid: ${filePath}`)
  }
  if (value.lastError !== undefined && typeof value.lastError !== 'string') {
    throw new Error(`Learning materialization error is invalid: ${filePath}`)
  }
}

function normalizeRequiredPath(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`${label} must be a non-empty path`)
  }
  return resolve(value.trim())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
