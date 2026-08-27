import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants, fsyncSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { chmod, link, lstat, mkdir, open, readdir, readFile, rename, rm, unlink } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { basename, dirname, join, resolve } from 'node:path'

export interface DurableFileWriteOptions {
  mode?: number
  replace?: boolean
  /** Digest of the target observed before work began; null means the target must be absent. */
  expectedTargetDigest?: string | null
  /** Runs while the target publication lock is held, immediately before rename/link. */
  beforePublish?: () => Promise<void>
}

export interface DurableFileSyncWriteOptions {
  mode?: number
  replace?: boolean
  expectedTargetDigest?: string | null
}

interface PublicationLock {
  path: string
  owner: string
  handle: Awaited<ReturnType<typeof open>>
}

interface SyncPublicationLock {
  path: string
  owner: string
  descriptor: number
}

const PUBLICATION_LOCK_SUFFIX = '.caogen-publish.lock'
const PUBLICATION_LOCK_WAIT_MS = 15
const PUBLICATION_LOCK_TIMEOUT_MS = 15_000
const PUBLICATION_LOCK_STALE_MS = 120_000

/** Publish one complete file only after its bytes and parent directory are durable. */
export async function writeDurableFile(
  targetPath: string,
  content: string | Uint8Array,
  options: DurableFileWriteOptions = {}
): Promise<void> {
  const target = resolve(targetPath)
  const parent = dirname(target)
  const mode = options.mode ?? 0o600
  const replace = options.replace ?? true
  validateExpectedTargetDigest(options.expectedTargetDigest)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await cleanupDurableFileOrphans(target)
  const temporary = join(parent, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (process.platform !== 'win32') await chmod(temporary, mode)
    await withPublicationLock(target, async () => {
      await assertExpectedTarget(target, options.expectedTargetDigest)
      await options.beforePublish?.()
      await publishFile(temporary, target, replace)
      await syncDirectory(parent)
    })
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export function writeDurableFileSync(
  targetPath: string,
  content: string | Uint8Array,
  options: DurableFileSyncWriteOptions = {}
): void {
  const target = resolve(targetPath)
  const parent = dirname(target)
  const mode = options.mode ?? 0o600
  const replace = options.replace ?? true
  validateExpectedTargetDigest(options.expectedTargetDigest)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  cleanupDurableFileOrphansSync(target)
  const temporary = join(parent, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode)
    writeFileSync(descriptor, content)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    if (process.platform !== 'win32') chmodSync(temporary, mode)
    withPublicationLockSync(target, () => {
      assertExpectedTargetSync(target, options.expectedTargetDigest)
      if (!replace) {
        linkSync(temporary, target)
        unlinkSync(temporary)
        syncDirectorySync(parent)
        return
      }
      renameSync(temporary, target)
      syncDirectorySync(parent)
    })
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    rmSync(temporary, { force: true })
    throw error
  }
}

/** Return a stable SHA-256 snapshot for a regular target, or null when absent. */
export async function readDurableFileDigest(targetPath: string): Promise<string | null> {
  const target = resolve(targetPath)
  let before
  try {
    before = await lstat(target, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  assertRegularTarget(before, target)
  const handle = await open(target, 'r')
  try {
    const opened = await handle.stat({ bigint: true })
    if (!sameFileIdentity(before, opened)) throw staleTargetError(target, 'changed before digest read')
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(256 * 1024)
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = await lstat(target, { bigint: true })
    if (!sameFileIdentity(opened, after)) throw staleTargetError(target, 'changed during digest read')
    return `sha256:${hash.digest('hex')}`
  } finally {
    await handle.close()
  }
}

function readDurableFileDigestSync(targetPath: string): string | null {
  const target = resolve(targetPath)
  let before
  try {
    before = lstatSync(target, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  assertRegularTarget(before, target)
  const descriptor = openSync(target, constants.O_RDONLY)
  try {
    const opened = statSync(target, { bigint: true })
    if (!sameFileIdentity(before, opened)) throw staleTargetError(target, 'changed before digest read')
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(256 * 1024)
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = lstatSync(target, { bigint: true })
    if (!sameFileIdentity(opened, after)) throw staleTargetError(target, 'changed during digest read')
    return `sha256:${hash.digest('hex')}`
  } finally {
    closeSync(descriptor)
  }
}

function assertRegularTarget(stat: { isFile(): boolean; isSymbolicLink(): boolean }, target: string): void {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Durable file target is not a regular file: ${target}`)
}

function sameFileIdentity(
  left: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint },
  right: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint }
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs
}

function validateExpectedTargetDigest(value: string | null | undefined): void {
  if (value !== undefined && value !== null && !/^sha256:[0-9a-f]{64}$/i.test(value)) {
    throw new Error('expectedTargetDigest must be sha256:<64 hex characters> or null')
  }
}

async function assertExpectedTarget(target: string, expected: string | null | undefined): Promise<void> {
  if (expected === undefined) return
  const actual = await readDurableFileDigest(target)
  if (actual?.toLowerCase() !== expected?.toLowerCase()) throw staleTargetError(target, 'expected target digest no longer matches')
}

function assertExpectedTargetSync(target: string, expected: string | null | undefined): void {
  if (expected === undefined) return
  const actual = readDurableFileDigestSync(target)
  if (actual?.toLowerCase() !== expected?.toLowerCase()) throw staleTargetError(target, 'expected target digest no longer matches')
}

function staleTargetError(target: string, reason: string): Error & { code: string } {
  return Object.assign(new Error(`Stale durable publication for ${target}: ${reason}`), {
    code: 'ESTALEPUBLICATION'
  })
}

async function withPublicationLock<T>(target: string, operation: () => Promise<T>): Promise<T> {
  const lock = await acquirePublicationLock(target)
  try {
    return await operation()
  } finally {
    await releasePublicationLock(lock)
  }
}

async function acquirePublicationLock(target: string): Promise<PublicationLock> {
  const lockPath = `${target}${PUBLICATION_LOCK_SUFFIX}`
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
  const startedAt = performance.now()
  while (performance.now() - startedAt < PUBLICATION_LOCK_TIMEOUT_MS) {
    const owner = `${process.pid}:${randomUUID()}\n`
    try {
      const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      try {
        await handle.writeFile(owner, 'utf8')
        await handle.sync()
        return { path: lockPath, owner, handle }
      } catch (error) {
        await handle.close().catch(() => undefined)
        await unlinkIfPresent(lockPath)
        throw error
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await reapPublicationLock(lockPath)) continue
      await sleep(PUBLICATION_LOCK_WAIT_MS)
    }
  }
  throw Object.assign(new Error(`Timed out waiting for durable publication lock: ${lockPath}`), { code: 'ELOCKTIMEOUT' })
}

async function releasePublicationLock(lock: PublicationLock): Promise<void> {
  await lock.handle.close().catch(() => undefined)
  const current = await readFile(lock.path, 'utf8').catch(() => undefined)
  if (current === lock.owner) await unlinkIfPresent(lock.path)
}

async function reapPublicationLock(lockPath: string): Promise<boolean> {
  const info = await lstat(lockPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (!info) return true
  const owner = await readFile(lockPath, 'utf8').catch(() => undefined)
  const pid = Number.parseInt(owner?.split(':', 1)[0] ?? '', 10)
  const stale = Number.isSafeInteger(pid) && pid > 0
    ? !processIsAlive(pid)
    : Date.now() - info.mtimeMs > PUBLICATION_LOCK_STALE_MS
  if (!stale) return false
  const current = await readFile(lockPath, 'utf8').catch(() => undefined)
  if (current === owner) await unlinkIfPresent(lockPath)
  return true
}

function withPublicationLockSync<T>(target: string, operation: () => T): T {
  const lockPath = `${target}${PUBLICATION_LOCK_SUFFIX}`
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
  const startedAt = performance.now()
  while (performance.now() - startedAt < PUBLICATION_LOCK_TIMEOUT_MS) {
    const lock = tryAcquirePublicationLockSync(lockPath)
    if (lock) {
      try {
        return operation()
      } finally {
        releasePublicationLockSync(lock)
      }
    }
    // A writer killed after publication can leave a lock behind. Reap it and
    // retry acquisition instead of surfacing a transient ELOCKED failure.
    if (reapPublicationLockSync(lockPath)) continue
    syncSleep(PUBLICATION_LOCK_WAIT_MS)
  }
  throw Object.assign(new Error(`Timed out waiting for durable publication lock: ${lockPath}`), { code: 'ELOCKTIMEOUT' })
}

function tryAcquirePublicationLockSync(lockPath: string): SyncPublicationLock | undefined {
  const owner = `${process.pid}:${randomUUID()}\n`
  let descriptor: number
  try {
    descriptor = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined
    throw error
  }
  try {
    writeFileSync(descriptor, owner, 'utf8')
    fsyncSync(descriptor)
    return { path: lockPath, owner, descriptor }
  } catch (error) {
    try { closeSync(descriptor) } catch { /* preserve the original write error */ }
    descriptor = -1
    // Only remove the lock if its contents still identify this acquisition.
    try {
      if (readFileSync(lockPath, 'utf8') === owner) unlinkSync(lockPath)
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError
    }
    throw error
  }
}

function reapPublicationLockSync(lockPath: string): boolean {
  try {
    const info = lstatSync(lockPath, { bigint: true })
    const owner = readFileSync(lockPath, 'utf8')
    const pid = Number.parseInt(owner.split(':', 1)[0] ?? '', 10)
    const stale = Number.isSafeInteger(pid) && pid > 0
      ? !processIsAlive(pid)
      : Date.now() - Number(info.mtimeMs) > PUBLICATION_LOCK_STALE_MS
    if (!stale) return false
    const current = lstatSync(lockPath, { bigint: true })
    if (current.dev !== info.dev || current.ino !== info.ino || current.mtimeNs !== info.mtimeNs) return false
    if (readFileSync(lockPath, 'utf8') === owner) unlinkSync(lockPath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

function syncSleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function releasePublicationLockSync(lock: SyncPublicationLock): void {
  try { fsyncSync(lock.descriptor) } catch { /* closing remains required */ }
  closeSync(lock.descriptor)
  try {
    if (readFileSync(lock.path, 'utf8') === lock.owner) unlinkSync(lock.path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  await unlink(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

async function publishFile(temporary: string, target: string, replace: boolean): Promise<void> {
  if (replace) {
    await rename(temporary, target)
    return
  }
  await link(temporary, target)
  await unlink(temporary)
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(directory, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function syncDirectorySync(directory: string): void {
  if (process.platform === 'win32') return
  const descriptor = openSync(directory, constants.O_RDONLY)
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

export async function cleanupDurableFileOrphans(targetPath: string): Promise<void> {
  const target = resolve(targetPath)
  const parent = dirname(target)
  const targetName = basename(target)
  let entries
  try {
    entries = await readdir(parent, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const prefix = `.${targetName}.`
  await Promise.all(entries.map(async (entry) => {
    const ownerPid = temporaryOwnerPid(entry.name, prefix)
    if (!entry.isFile() || ownerPid === undefined || processIsAlive(ownerPid)) return
    await rm(join(parent, entry.name), { force: true }).catch(() => undefined)
  }))
}

export function cleanupDurableFileOrphansSync(targetPath: string): void {
  const target = resolve(targetPath)
  const parent = dirname(target)
  const targetName = basename(target)
  let entries
  try {
    entries = readdirSync(parent, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const prefix = `.${targetName}.`
  for (const entry of entries) {
    const ownerPid = temporaryOwnerPid(entry.name, prefix)
    if (!entry.isFile() || ownerPid === undefined || processIsAlive(ownerPid)) continue
    try { rmSync(join(parent, entry.name), { force: true }) } catch { /* next write remains safe */ }
  }
}

function temporaryOwnerPid(name: string, prefix: string): number | undefined {
  if (!name.startsWith(prefix) || !name.endsWith('.tmp')) return undefined
  const identity = name.slice(prefix.length, -'.tmp'.length)
  const owner = /^(\d+)\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(identity)
  if (!owner) return undefined
  const pid = Number(owner[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
