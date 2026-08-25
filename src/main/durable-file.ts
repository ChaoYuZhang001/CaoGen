import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { chmod, link, mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

export interface DurableFileWriteOptions {
  mode?: number
  replace?: boolean
}

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
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await cleanupOrphanedTemporaryFiles(parent, basename(target))
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
    await publishFile(temporary, target, replace)
    await syncDirectory(parent)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export function writeDurableFileSync(
  targetPath: string,
  content: string | Uint8Array,
  options: DurableFileWriteOptions = {}
): void {
  const target = resolve(targetPath)
  const parent = dirname(target)
  const mode = options.mode ?? 0o600
  const replace = options.replace ?? true
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  cleanupOrphanedTemporaryFilesSync(parent, basename(target))
  const temporary = join(parent, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode)
    writeFileSync(descriptor, content)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    if (process.platform !== 'win32') chmodSync(temporary, mode)
    if (!replace) {
      linkSync(temporary, target)
      unlinkSync(temporary)
      syncDirectorySync(parent)
      return
    }
    renameSync(temporary, target)
    syncDirectorySync(parent)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    rmSync(temporary, { force: true })
    throw error
  }
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

async function cleanupOrphanedTemporaryFiles(parent: string, targetName: string): Promise<void> {
  const prefix = `.${targetName}.`
  const entries = await readdir(parent, { withFileTypes: true })
  await Promise.all(entries.map(async (entry) => {
    const ownerPid = temporaryOwnerPid(entry.name, prefix)
    if (!entry.isFile() || ownerPid === undefined || processIsAlive(ownerPid)) return
    await rm(join(parent, entry.name), { force: true }).catch(() => undefined)
  }))
}

function cleanupOrphanedTemporaryFilesSync(parent: string, targetName: string): void {
  const prefix = `.${targetName}.`
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    const ownerPid = temporaryOwnerPid(entry.name, prefix)
    if (!entry.isFile() || ownerPid === undefined || processIsAlive(ownerPid)) continue
    try { rmSync(join(parent, entry.name), { force: true }) } catch { /* next write remains safe */ }
  }
}

function temporaryOwnerPid(name: string, prefix: string): number | undefined {
  if (!name.startsWith(prefix) || !name.endsWith('.tmp')) return undefined
  const pid = Number.parseInt(name.slice(prefix.length).split('.', 1)[0] ?? '', 10)
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
