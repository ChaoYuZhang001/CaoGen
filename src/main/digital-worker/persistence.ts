import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DigitalWorkerStoreDocument } from '../../shared/digital-worker-types'
import type { DigitalWorkerStoreOptions } from './contracts'
import { emptyDocument, normalizeDocument } from './codec'
import {
  DigitalWorkerConflictError,
  DigitalWorkerPersistenceError,
  DigitalWorkerValidationError
} from './errors'

const STORE_FILE_NAME = 'digital-workers.json'
export const LOCK_FILE_SUFFIX = '.lock'
const LOCK_STALE_MS = 30_000
const mutationQueues = new Map<string, Promise<void>>()

export function resolveStorePath(options: DigitalWorkerStoreOptions): string {
  if (options.filePath !== undefined) {
    if (typeof options.filePath !== 'string' || options.filePath.trim() === '') {
      throw new DigitalWorkerValidationError('filePath is required')
    }
    return path.resolve(options.filePath)
  }
  if (typeof options.rootDir !== 'string' || options.rootDir.trim() === '') {
    throw new DigitalWorkerValidationError('rootDir is required')
  }
  return path.join(path.resolve(options.rootDir), STORE_FILE_NAME)
}

export function readDocument(filePath: string): DigitalWorkerStoreDocument {
  if (!existsSync(filePath)) return emptyDocument()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
  } catch (error) {
    throw new DigitalWorkerPersistenceError(`DigitalWorker store is not valid JSON: ${String(error)}`)
  }
  try {
    return normalizeDocument(parsed)
  } catch (error) {
    if (error instanceof DigitalWorkerPersistenceError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new DigitalWorkerPersistenceError(`DigitalWorker store is invalid: ${message}`)
  }
}

export function writeDocument(filePath: string, document: DigitalWorkerStoreDocument): void {
  const directory = path.dirname(filePath)
  mkdirSync(directory, { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  const payload = `${JSON.stringify(document, null, 2)}\n`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600)
    writeSync(descriptor, payload, undefined, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporaryPath, filePath)
    syncDirectory(directory)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    removeTemporaryFile(temporaryPath)
    throw new DigitalWorkerPersistenceError(`Unable to atomically persist DigitalWorker store: ${String(error)}`)
  }
}

function removeTemporaryFile(filePath: string): void {
  try {
    unlinkSync(filePath)
  } catch {
    // The old committed document remains untouched when cleanup is unavailable.
  }
}

function syncDirectory(directory: string): void {
  try {
    const descriptor = openSync(directory, 'r')
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  } catch {
    // Some filesystems reject directory fsync after the file itself was synced.
  }
}

export function acquireFileLock(lockPath: string): number {
  mkdirSync(path.dirname(lockPath), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return createLockFile(lockPath)
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw new DigitalWorkerPersistenceError(`Unable to acquire DigitalWorker store lock: ${String(error)}`)
      }
      recoverOrRejectLock(lockPath)
    }
  }
  throw new DigitalWorkerConflictError(
    `DigitalWorker store lock could not be acquired: ${lockPath}`,
    undefined,
    'STORE_LOCKED'
  )
}

function createLockFile(lockPath: string): number {
  const descriptor = openSync(lockPath, 'wx', 0o600)
  writeFileSync(descriptor, `${process.pid}\n${randomUUID()}\n`, { encoding: 'utf8' })
  fsyncSync(descriptor)
  return descriptor
}

function recoverOrRejectLock(lockPath: string): void {
  if (!isStaleLock(lockPath)) {
    throw new DigitalWorkerConflictError(
      `DigitalWorker store is locked by another writer: ${lockPath}`,
      undefined,
      'STORE_LOCKED'
    )
  }
  try {
    unlinkSync(lockPath)
  } catch {
    throw new DigitalWorkerConflictError(
      `DigitalWorker store lock changed while recovering: ${lockPath}`,
      undefined,
      'STORE_LOCKED'
    )
  }
}

export function releaseFileLock(lockPath: string, descriptor: number): void {
  try {
    fsyncSync(descriptor)
  } catch {
    // Closing remains required when a platform rejects fsync.
  }
  closeSync(descriptor)
  try {
    unlinkSync(lockPath)
  } catch {
    // Another process may have recovered a stale lock after a crash.
  }
}

function isStaleLock(lockPath: string): boolean {
  const metadata = readLockMetadata(lockPath)
  if (!metadata) return true
  const ownerPid = readLockOwner(lockPath)
  if (ownerPid !== undefined) {
    const alive = processIsAlive(ownerPid)
    if (alive !== undefined) return !alive
  }
  return Date.now() - metadata.mtimeMs > LOCK_STALE_MS
}

function readLockMetadata(lockPath: string): { mtimeMs: number } | undefined {
  try {
    return { mtimeMs: statSync(lockPath).mtimeMs }
  } catch {
    return undefined
  }
}

function readLockOwner(lockPath: string): number | undefined {
  try {
    const bytes = Buffer.alloc(128)
    const descriptor = openSync(lockPath, 'r')
    try {
      const length = readSync(descriptor, bytes, 0, bytes.length, 0)
      const value = Number.parseInt(bytes.subarray(0, length).toString('utf8').split(/\s+/)[0] ?? '', 10)
      return Number.isInteger(value) ? value : undefined
    } finally {
      closeSync(descriptor)
    }
  } catch {
    return undefined
  }
}

function processIsAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM') return true
    if (code === 'ESRCH') return false
    return undefined
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST'
}

export function enqueueMutation<T>(storePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(storePath) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => undefined).then(() => current)
  mutationQueues.set(storePath, tail)
  return previous
    .catch(() => undefined)
    .then(operation)
    .finally(() => {
      release()
      if (mutationQueues.get(storePath) === tail) mutationQueues.delete(storePath)
    })
}
