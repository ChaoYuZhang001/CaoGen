import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat
} from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  ArtifactContentInput,
  PreparedArtifactContent
} from './artifact-lifecycle-types'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'

const SHA256_PATTERN = /^sha256:([a-f0-9]{64})$/

export function artifactBlobRoot(rootDir: string): string {
  return join(rootDir, 'artifact-blobs', 'sha256')
}

export function artifactBlobPath(rootDir: string, digest: string): string {
  return join(artifactBlobRoot(rootDir), assertSha256Digest(digest).slice('sha256:'.length))
}

export async function prepareArtifactContent(
  content: ArtifactContentInput,
  rootDir: string
): Promise<PreparedArtifactContent> {
  if (content.storageKind === 'blob') {
    if (!(content.bytes instanceof Uint8Array)) {
      throw new WorkflowLedgerCorruptionError('artifact blob bytes must be a Uint8Array')
    }
    const bytes = Uint8Array.from(content.bytes)
    const digest = contentDigest(bytes)
    assertExpectedDigest(content.expectedDigest, digest)
    const hex = digest.slice('sha256:'.length)
    return {
      storageKind: 'blob',
      digest,
      sizeBytes: bytes.byteLength,
      bytes,
      blobRef: `sha256/${hex}`,
      locationPath: join(artifactBlobRoot(rootDir), hex)
    }
  }
  const sourceRef = await canonicalSourceRef(content.sourceRef)
  const bytes = Uint8Array.from(await readFile(sourceRef))
  const digest = contentDigest(bytes)
  assertExpectedDigest(content.expectedDigest, digest)
  return {
    storageKind: 'source_ref',
    digest,
    sizeBytes: bytes.byteLength,
    bytes,
    sourceRef,
    locationPath: sourceRef
  }
}

export async function materializeArtifactBlob(content: PreparedArtifactContent): Promise<boolean> {
  if (content.storageKind !== 'blob') return false
  await mkdir(dirname(content.locationPath), { recursive: true, mode: 0o700 })
  if (await pathExists(content.locationPath)) {
    await assertRegularContent(content.locationPath, content.digest, content.sizeBytes)
    return false
  }
  const temporaryPath = `${content.locationPath}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(content.bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporaryPath, content.locationPath)
    await chmod(content.locationPath, 0o600)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    if (!(await pathExists(content.locationPath))) throw error
  }
  await assertRegularContent(content.locationPath, content.digest, content.sizeBytes)
  return true
}

export async function verifyPreparedContent(content: PreparedArtifactContent): Promise<void> {
  await assertRegularContent(content.locationPath, content.digest, content.sizeBytes)
}

export async function assertRegularContent(
  filePath: string,
  expectedDigest: string,
  expectedSize: number
): Promise<void> {
  const fileStat = await lstat(filePath)
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new WorkflowLedgerCorruptionError(`artifact content is not a regular file: ${filePath}`)
  }
  const bytes = await readFile(filePath)
  if (bytes.byteLength !== expectedSize || contentDigest(bytes) !== expectedDigest) {
    throw new WorkflowLedgerCorruptionError(`artifact content digest mismatch: ${filePath}`)
  }
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export function contentDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export function assertSha256Digest(value: string, label = 'artifact digest'): string {
  const normalized = value.trim().toLowerCase()
  if (!SHA256_PATTERN.test(normalized)) {
    throw new WorkflowLedgerCorruptionError(`${label} must use sha256:<64 lowercase hex>`)
  }
  return normalized
}

async function canonicalSourceRef(value: string): Promise<string> {
  const sourcePath = value.startsWith('file:') ? fileURLToPath(value) : value
  if (!isAbsolute(sourcePath)) {
    throw new WorkflowLedgerCorruptionError('artifact sourceRef must be an absolute path or file URL')
  }
  const directStat = await lstat(sourcePath)
  if (directStat.isSymbolicLink() || !directStat.isFile()) {
    throw new WorkflowLedgerCorruptionError('artifact sourceRef must name a regular non-symlink file')
  }
  const canonical = await realpath(sourcePath)
  if (!(await stat(canonical)).isFile()) {
    throw new WorkflowLedgerCorruptionError('artifact sourceRef must resolve to a regular file')
  }
  return canonical
}

function assertExpectedDigest(expected: string | undefined, actual: string): void {
  if (expected === undefined) return
  if (assertSha256Digest(expected, 'artifact expectedDigest') !== actual) {
    throw new WorkflowLedgerCorruptionError('artifact expectedDigest does not match content bytes')
  }
}
