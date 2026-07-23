import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ProjectWorkspaceError } from './errors'

const LOCK_WAIT_MS = 20
const LOCK_TIMEOUT_MS = 60_000
const MALFORMED_LOCK_STALE_MS = 120_000

interface LockOwner {
  schemaVersion: 1
  pid: number
  token: string
  createdAt: number
}

export async function withProjectWorkspaceLedgerShadowLock<T>(
  lockPath: string,
  now: () => number,
  callback: () => Promise<T>
): Promise<T> {
  const owner = await acquireLock(lockPath, now)
  try {
    return await callback()
  } finally {
    await releaseLock(lockPath, owner).catch(() => undefined)
  }
}

async function acquireLock(lockPath: string, now: () => number): Promise<LockOwner> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
  const startedAt = Date.now()
  while (Date.now() - startedAt < LOCK_TIMEOUT_MS) {
    const owner = newLockOwner(now)
    try {
      await persistLockOwner(lockPath, owner)
      return owner
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await reapAbandonedLock(lockPath)) continue
      await sleep(LOCK_WAIT_MS)
    }
  }
  throw new ProjectWorkspaceError('ledger_shadow_lock_timeout', 'timed out waiting for Ledger shadow command lock')
}

function newLockOwner(now: () => number): LockOwner {
  return { schemaVersion: 1, pid: process.pid, token: randomUUID(), createdAt: now() }
}

async function persistLockOwner(lockPath: string, owner: LockOwner): Promise<void> {
  const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(dirname(lockPath))
}

async function releaseLock(lockPath: string, owner: LockOwner): Promise<void> {
  const current = await readLockOwner(lockPath).catch(() => undefined)
  if (!current || current.token !== owner.token || current.pid !== owner.pid) return
  await unlinkIfPresent(lockPath)
  await syncDirectory(dirname(lockPath))
}

async function reapAbandonedLock(lockPath: string): Promise<boolean> {
  const info = await lstat(lockPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (!info) return true
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new ProjectWorkspaceError('ledger_shadow_lock_invalid', `shadow lock is not a regular file: ${lockPath}`)
  }
  const owner = await readLockOwner(lockPath).catch(() => undefined)
  const abandoned = owner ? !processIsAlive(owner.pid) : Date.now() - info.mtimeMs > MALFORMED_LOCK_STALE_MS
  if (!abandoned || owner && !(await sameLockOwner(lockPath, owner))) return false
  await unlinkIfPresent(lockPath)
  await syncDirectory(dirname(lockPath))
  return true
}

async function sameLockOwner(lockPath: string, expected: LockOwner): Promise<boolean> {
  const current = await readLockOwner(lockPath).catch(() => undefined)
  return Boolean(current && current.token === expected.token && current.pid === expected.pid)
}

async function readLockOwner(lockPath: string): Promise<LockOwner> {
  const value: unknown = JSON.parse(await readFile(lockPath, 'utf8'))
  if (!isLockOwner(value)) {
    throw new ProjectWorkspaceError('ledger_shadow_lock_invalid', `invalid shadow lock owner: ${lockPath}`)
  }
  return value
}

function isLockOwner(value: unknown): value is LockOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<LockOwner>
  return hasLockIdentity(item) && hasLockTimestamp(item.createdAt)
}

function hasLockIdentity(item: Partial<LockOwner>): boolean {
  return item.schemaVersion === 1 && Number.isSafeInteger(item.pid) && (item.pid ?? 0) > 0 &&
    typeof item.token === 'string' && item.token.length > 0
}

function hasLockTimestamp(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  await unlink(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}
