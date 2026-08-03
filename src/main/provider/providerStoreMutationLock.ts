import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { basename, join, resolve } from 'node:path'

const LOCK_DIRECTORY_NAME = '.provider-store-mutation.lock'
const LOCK_OWNER_FILE_NAME = 'owner.json'
const LOCK_SCHEMA_VERSION = 1 as const
const MAX_LOCK_OWNER_BYTES = 8 * 1024
const LOCK_ARTIFACT_GRACE_MS = 5 * 60 * 1_000
const MAX_LOCK_ARTIFACTS = 64
const SHA256 = /^[0-9a-f]{64}$/
const SAFE_ID = /^[0-9A-Za-z._:-]{1,192}$/

export type ProviderStoreMutationLockErrorCode =
  | 'LOCK_INVALID_INPUT'
  | 'LOCK_HELD'
  | 'LOCK_CORRUPT'
  | 'LOCK_IO'

export class ProviderStoreMutationLockError extends Error {
  constructor(
    readonly code: ProviderStoreMutationLockErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'ProviderStoreMutationLockError'
  }
}

interface LockOwnerPayload {
  schemaVersion: typeof LOCK_SCHEMA_VERSION
  ownerId: string
  pid: number
  createdAt: number
}

interface LockOwner extends LockOwnerPayload {
  ownerDigest: string
}

interface LockLease {
  rootDirectory: string
  lockDirectory: string
  owner: LockOwner
}

interface HeldLock {
  lease: LockLease
  depth: number
}

const heldLocks = new Map<string, HeldLock>()

export function providerStoreMutationLockPaths(userDataDirectory: string): {
  rootDirectory: string
  lockDirectory: string
  ownerFile: string
} {
  if (typeof userDataDirectory !== 'string' || !userDataDirectory.trim() || userDataDirectory.includes('\0')) {
    throw new ProviderStoreMutationLockError('LOCK_INVALID_INPUT', 'Provider Store mutation lock root is invalid')
  }
  const rootDirectory = resolve(userDataDirectory)
  const lockDirectory = join(rootDirectory, LOCK_DIRECTORY_NAME)
  return {
    rootDirectory,
    lockDirectory,
    ownerFile: join(lockDirectory, LOCK_OWNER_FILE_NAME)
  }
}

export function withProviderStoreMutationLock<T>(
  userDataDirectory: string,
  operation: () => T
): T {
  if (typeof operation !== 'function') {
    throw new ProviderStoreMutationLockError('LOCK_INVALID_INPUT', 'Provider Store mutation callback is invalid')
  }
  const paths = providerStoreMutationLockPaths(userDataDirectory)
  const held = heldLocks.get(paths.lockDirectory)
  if (held) return runReentrant(held, operation)

  const lease = acquireLease(paths)
  heldLocks.set(paths.lockDirectory, { lease, depth: 1 })
  let value: T | undefined
  let operationError: unknown
  let operationFailed = false
  try {
    value = operation()
  } catch (error) {
    operationFailed = true
    operationError = error
  }
  heldLocks.delete(paths.lockDirectory)

  let releaseError: unknown
  let releaseFailed = false
  try {
    releaseLease(lease)
  } catch (error) {
    releaseFailed = true
    releaseError = error
  }
  if (operationFailed && releaseFailed) {
    throw new AggregateError([operationError, releaseError], 'Provider Store mutation and lock release both failed')
  }
  if (operationFailed) throw operationError
  if (releaseFailed) throw releaseError
  return value as T
}

function runReentrant<T>(held: HeldLock, operation: () => T): T {
  held.depth += 1
  try {
    return operation()
  } finally {
    held.depth -= 1
  }
}

function acquireLease(paths: ReturnType<typeof providerStoreMutationLockPaths>): LockLease {
  ensureLockRoot(paths.rootDirectory)
  pruneLockArtifacts(paths.rootDirectory, paths.lockDirectory)
  const owner = buildLockOwner()
  const candidateDirectory = `${paths.lockDirectory}.candidate-${owner.ownerId}`
  const candidateOwnerFile = join(candidateDirectory, LOCK_OWNER_FILE_NAME)
  createLockCandidate(paths.rootDirectory, candidateDirectory, candidateOwnerFile, owner)
  let acquired = false
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (tryAcquireCandidate(paths, candidateDirectory)) {
        acquired = true
        return { rootDirectory: paths.rootDirectory, lockDirectory: paths.lockDirectory, owner }
      }
    }
    throw new ProviderStoreMutationLockError('LOCK_HELD', 'Provider Store mutation lock could not be acquired')
  } finally {
    if (!acquired) removeLockDirectory(candidateDirectory, candidateOwnerFile)
  }
}

function tryAcquireCandidate(
  paths: ReturnType<typeof providerStoreMutationLockPaths>,
  candidateDirectory: string
): boolean {
  try {
    renameSync(candidateDirectory, paths.lockDirectory)
    syncDirectory(paths.rootDirectory)
    return true
  } catch (error) {
    const existing = readContendedLockOwner(paths.lockDirectory)
    if (!existing) {
      if (isRenameContentionError(error)) return false
      throw lockIo('Unable to acquire Provider Store mutation lock', error)
    }
    if (lockOwnerIsAlive(existing)) {
      throw new ProviderStoreMutationLockError(
        'LOCK_HELD',
        `Provider Store mutation lock is held by live pid ${existing.pid}`
      )
    }
    recoverDeadLock(paths, existing)
    return false
  }
}

function readContendedLockOwner(lockDirectory: string): LockOwner | undefined {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!lstatIfPresent(lockDirectory)) return undefined
    try {
      return readLockOwner(lockDirectory)
    } catch (error) {
      if (!lstatIfPresent(lockDirectory)) return undefined
      if (attempt > 0) throw error
    }
  }
  return undefined
}

function isRenameContentionError(error: unknown): boolean {
  return isNodeError(error)
    && typeof error.code === 'string'
    && ['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)
}

function buildLockOwner(): LockOwner {
  const payload: LockOwnerPayload = {
    schemaVersion: LOCK_SCHEMA_VERSION,
    ownerId: randomUUID(),
    pid: process.pid,
    createdAt: Date.now()
  }
  return { ...payload, ownerDigest: digestLockOwner(payload) }
}

function createLockCandidate(
  rootDirectory: string,
  candidateDirectory: string,
  candidateOwnerFile: string,
  owner: LockOwner
): void {
  let descriptor: number | undefined
  try {
    mkdirSync(candidateDirectory, { mode: 0o700 })
    if (process.platform !== 'win32') chmodSync(candidateDirectory, 0o700)
    descriptor = openSync(candidateOwnerFile, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    if (process.platform !== 'win32') chmodSync(candidateOwnerFile, 0o600)
    syncDirectory(candidateDirectory)
    syncDirectory(rootDirectory)
  } catch (error) {
    if (descriptor !== undefined) closeBestEffort(descriptor)
    removeLockDirectory(candidateDirectory, candidateOwnerFile)
    throw lockIo('Unable to create Provider Store mutation lock candidate', error)
  }
}

function readLockOwner(lockDirectory: string): LockOwner {
  const ownerFile = validatedOwnerFile(lockDirectory)
  const raw = readOwnerFile(ownerFile)
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch (error) {
    throw lockCorrupt('Provider Store mutation lock owner is not valid JSON', error)
  }
  assertLockOwner(value)
  return value
}

function validatedOwnerFile(lockDirectory: string): string {
  assertPrivateLockDirectory(lockDirectory, lstatIfPresent(lockDirectory))
  const ownerFile = join(lockDirectory, LOCK_OWNER_FILE_NAME)
  const ownerInfo = lstatIfPresent(ownerFile)
  if (!ownerInfo || ownerInfo.isSymbolicLink() || !ownerInfo.isFile()) {
    throw lockCorrupt('Provider Store mutation lock owner file is invalid')
  }
  return ownerFile
}

function assertPrivateLockDirectory(lockDirectory: string, info: Stats | undefined): void {
  if (!info || info.isSymbolicLink() || !info.isDirectory()) {
    throw lockCorrupt('Provider Store mutation lock must be a real directory')
  }
  if (process.platform !== 'win32' && (info.mode & 0o777) !== 0o700) {
    throw lockCorrupt(`Provider Store mutation lock directory permissions are not 0700: ${lockDirectory}`)
  }
}

function readOwnerFile(ownerFile: string): string {
  let descriptor: number | undefined
  try {
    const defensiveFlags = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK
    descriptor = openSync(ownerFile, constants.O_RDONLY | defensiveFlags)
    assertPrivateOwnerFile(fstatSync(descriptor))
    return readBoundedUtf8(descriptor, MAX_LOCK_OWNER_BYTES)
  } catch (error) {
    if (error instanceof ProviderStoreMutationLockError) throw error
    throw lockIo('Unable to read Provider Store mutation lock owner', error)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function assertPrivateOwnerFile(info: Stats): void {
  if (!info.isFile() || info.size > MAX_LOCK_OWNER_BYTES) {
    throw lockCorrupt('Provider Store mutation lock owner file is invalid')
  }
  if (process.platform !== 'win32' && (info.mode & 0o777) !== 0o600) {
    throw lockCorrupt('Provider Store mutation lock owner permissions are not 0600')
  }
}

function assertLockOwner(value: unknown): asserts value is LockOwner {
  if (!isRecord(value)) throw lockCorrupt('Provider Store mutation lock owner must be an object')
  assertExactOwnerKeys(value)
  assertLockOwnerFields(value)
  const owner = value as unknown as LockOwner
  if (digestLockOwner(lockOwnerPayload(owner)) !== owner.ownerDigest) {
    throw lockCorrupt('Provider Store mutation lock owner integrity check failed')
  }
}

function assertExactOwnerKeys(value: Record<string, unknown>): void {
  const actual = Object.keys(value).sort()
  const expected = ['schemaVersion', 'ownerId', 'pid', 'createdAt', 'ownerDigest'].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw lockCorrupt('Provider Store mutation lock owner contains unknown or missing fields')
  }
}

function assertLockOwnerFields(value: Record<string, unknown>): void {
  const identityValid = value.schemaVersion === LOCK_SCHEMA_VERSION
    && typeof value.ownerId === 'string'
    && SAFE_ID.test(value.ownerId)
    && Number.isSafeInteger(value.pid)
    && Number(value.pid) > 0
  const metadataValid = isNonNegativeSafeInteger(value.createdAt)
    && typeof value.ownerDigest === 'string'
    && SHA256.test(value.ownerDigest)
  if (!identityValid || !metadataValid) throw lockCorrupt('Provider Store mutation lock owner format is invalid')
}

function lockOwnerPayload(owner: LockOwner): LockOwnerPayload {
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    ownerId: owner.ownerId,
    pid: owner.pid,
    createdAt: owner.createdAt
  }
}

function lockOwnerIsAlive(owner: LockOwner): boolean {
  if (owner.pid === process.pid) return true
  try {
    process.kill(owner.pid, 0)
    return true
  } catch (error) {
    return !(isNodeError(error) && error.code === 'ESRCH')
  }
}

function recoverDeadLock(
  paths: ReturnType<typeof providerStoreMutationLockPaths>,
  owner: LockOwner
): void {
  const recoveredDirectory = `${paths.lockDirectory}.recovered-${owner.ownerId}`
  if (lstatIfPresent(recoveredDirectory)) {
    throw lockCorrupt(`Recovered Provider Store lock tombstone already exists for ${owner.ownerId}`)
  }
  try {
    renameSync(paths.lockDirectory, recoveredDirectory)
    syncDirectory(paths.rootDirectory)
  } catch (error) {
    if (!lstatIfPresent(paths.lockDirectory)) return
    throw lockIo('Unable to recover dead Provider Store mutation lock', error)
  }
}

function releaseLease(lease: LockLease): void {
  const current = readLockOwner(lease.lockDirectory)
  if (current.ownerId !== lease.owner.ownerId || current.pid !== lease.owner.pid) {
    throw lockCorrupt('Provider Store mutation lock ownership changed before release')
  }
  const releasedDirectory = `${lease.lockDirectory}.released-${lease.owner.ownerId}`
  try {
    renameSync(lease.lockDirectory, releasedDirectory)
    syncDirectory(lease.rootDirectory)
    removeLockDirectory(releasedDirectory, join(releasedDirectory, LOCK_OWNER_FILE_NAME))
  } catch (error) {
    throw lockIo('Unable to release Provider Store mutation lock', error)
  }
}

function ensureLockRoot(rootDirectory: string): void {
  try {
    mkdirSync(rootDirectory, { recursive: true })
    const info = lstatSync(rootDirectory)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw lockCorrupt('Provider Store mutation lock root must be a real directory')
    }
  } catch (error) {
    if (error instanceof ProviderStoreMutationLockError) throw error
    throw lockIo('Unable to prepare Provider Store mutation lock root', error)
  }
}

function pruneLockArtifacts(rootDirectory: string, lockDirectory: string): void {
  const lockName = basename(lockDirectory)
  const prefixes = lockArtifactPrefixes(lockName)
  const now = Date.now()
  for (const name of matchingLockArtifacts(rootDirectory, prefixes)) {
    pruneLockArtifact(rootDirectory, lockName, name, now)
  }
  if (matchingLockArtifacts(rootDirectory, prefixes).length >= MAX_LOCK_ARTIFACTS) {
    throw lockCorrupt('Provider Store mutation lock artifact limit reached')
  }
}

function lockArtifactPrefixes(lockName: string): string[] {
  return [
    `${lockName}.candidate-`,
    `${lockName}.released-`,
    `${lockName}.recovered-`
  ]
}

function matchingLockArtifacts(rootDirectory: string, prefixes: string[]): string[] {
  return readdirSync(rootDirectory)
    .filter((name) => prefixes.some((prefix) => name.startsWith(prefix)))
    .sort()
}

function pruneLockArtifact(rootDirectory: string, lockName: string, name: string, now: number): void {
  const directory = join(rootDirectory, name)
  const info = lstatIfPresent(directory)
  if (!info || info.isSymbolicLink() || !info.isDirectory()) return
  const age = Math.max(0, now - info.mtimeMs)
  if (!lockArtifactIsRemovable(directory, lockName, name, age)) return
  removeLockDirectory(directory, join(directory, LOCK_OWNER_FILE_NAME))
}

function lockArtifactIsRemovable(directory: string, lockName: string, name: string, age: number): boolean {
  if (name.startsWith(`${lockName}.released-`)) return true
  if (name.startsWith(`${lockName}.recovered-`)) return age >= LOCK_ARTIFACT_GRACE_MS
  if (age < LOCK_ARTIFACT_GRACE_MS) return false
  try {
    return !lockOwnerIsAlive(readLockOwner(directory))
  } catch {
    return true
  }
}

function removeLockDirectory(directory: string, ownerFile: string): void {
  try { unlinkSync(ownerFile) } catch { /* best effort */ }
  try { rmdirSync(directory) } catch { /* a later bounded cleanup pass will retry */ }
}

function readBoundedUtf8(descriptor: number, maxBytes: number): string {
  const chunks: Buffer[] = []
  let total = 0
  while (total <= maxBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total))
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)
    if (bytesRead === 0) break
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
    total += bytesRead
  }
  if (total > maxBytes) throw lockCorrupt('Provider Store mutation lock owner exceeds its size limit')
  return Buffer.concat(chunks, total).toString('utf8')
}

function syncDirectory(directoryPath: string): void {
  if (process.platform === 'win32') return
  const descriptor = openSync(directoryPath, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function lstatIfPresent(filePath: string): Stats | undefined {
  try {
    return lstatSync(filePath)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    throw error
  }
}

function closeBestEffort(descriptor: number): void {
  try { closeSync(descriptor) } catch { /* best effort */ }
}

function digestLockOwner(payload: LockOwnerPayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function isNonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}

function lockCorrupt(message: string, cause?: unknown): ProviderStoreMutationLockError {
  return new ProviderStoreMutationLockError('LOCK_CORRUPT', message, cause === undefined ? undefined : { cause })
}

function lockIo(message: string, cause: unknown): ProviderStoreMutationLockError {
  return new ProviderStoreMutationLockError('LOCK_IO', `${message}: ${errorText(cause)}`, { cause })
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
