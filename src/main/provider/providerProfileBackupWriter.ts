import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Provider, ProviderProfileBackupReason } from '../../shared/types'

const BACKUP_KIND = 'caogen-provider-profile-backup'
const BACKUP_VERSION = 1

export interface ProviderProfileBackupSnapshot {
  providers: Provider[]
  nonPersistentCredentialCount: number
  excludedCredentialCount: number
}

export interface WrittenProviderProfileBackup {
  id: string
  createdAt: string
  payloadDigest: string
}

export function writeProviderProfileBackup(
  userDataDirectory: string,
  reason: ProviderProfileBackupReason,
  snapshot: ProviderProfileBackupSnapshot
): WrittenProviderProfileBackup {
  assertCredentialFreeSnapshot(snapshot)
  const createdAt = new Date().toISOString()
  const id = `${createdAt.replace(/[:.]/g, '-')}-${randomUUID()}`
  const payload = {
    kind: BACKUP_KIND,
    schemaVersion: BACKUP_VERSION,
    id,
    createdAt,
    reason,
    providerCount: snapshot.providers.length,
    nonPersistentCredentialCount: snapshot.nonPersistentCredentialCount,
    excludedCredentialCount: snapshot.excludedCredentialCount,
    providers: snapshot.providers
  }
  const document = {
    ...payload,
    payloadDigest: createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  }
  const root = join(userDataDirectory, 'provider-profile-backups')
  ensurePrivateDirectory(root)
  const filePath = join(root, `${id}.json`)
  writeAtomic(filePath, `${JSON.stringify(document, null, 2)}\n`)
  return { id, createdAt, payloadDigest: document.payloadDigest }
}

function assertCredentialFreeSnapshot(snapshot: ProviderProfileBackupSnapshot): void {
  if (!Array.isArray(snapshot.providers)
    || !isNonNegativeInteger(snapshot.nonPersistentCredentialCount)
    || !isNonNegativeInteger(snapshot.excludedCredentialCount)) {
    throw new Error('Provider Profile backup snapshot is invalid')
  }
  for (const provider of snapshot.providers) {
    if (provider.encryptedToken || (provider.apiKeys?.length ?? 0) > 0 || provider.activeKeyId) {
      throw new Error('Provider Profile backup snapshot contains credentials')
    }
  }
}

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Provider Profile backup directory is invalid')
  }
  if (process.platform !== 'win32') {
    chmodSync(directory, 0o700)
    if ((lstatSync(directory).mode & 0o077) !== 0) {
      throw new Error('Provider Profile backup directory is not private')
    }
  }
}

function writeAtomic(filePath: string, content: string): void {
  if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) {
    throw new Error('Refusing to replace a Provider Profile backup symbolic link')
  }
  const directory = dirname(filePath)
  const temporary = join(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, filePath)
    if (process.platform !== 'win32') chmodSync(filePath, 0o600)
    fsyncDirectory(directory)
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch { /* best effort */ }
    }
    try { unlinkSync(temporary) } catch { /* best effort */ }
    throw error
  }
}

function fsyncDirectory(directory: string): void {
  if (process.platform === 'win32') return
  let descriptor: number | undefined
  try {
    descriptor = openSync(directory, 'r')
    fsyncSync(descriptor)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0
}
