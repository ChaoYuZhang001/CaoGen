import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  WorkflowArtifactExportResult,
  WorkflowArtifactCompareResult,
  WorkflowArtifactLocationRecord,
  WorkflowArtifactRecord
} from '../../shared/workflow-types'
import { readTaskSnapshotDatabase } from './task-snapshot'
import {
  assertArtifactScopeCompatibility,
  assertLocationProjectCompatibility,
  assertScopeReferences
} from './workflow-ledger-artifact-graph-codec'
import {
  readArtifactLocations,
  verifyWorkflowArtifactGraph
} from './workflow-ledger-artifact-graph-query'
import { setupWorkflowArtifactGraphSchema } from './workflow-ledger-artifact-graph-types'
import { findWorkflowArtifact, readArtifacts } from './workflow-ledger-query'
import { setupWorkflowLedgerSchema } from './workflow-ledger-store'

const SHA256_PATTERN = /^(?:sha256:)?([a-f0-9]{64})$/i

export interface WorkflowArtifactExportSource {
  artifactId: string
  projectId: string
  version: number
  title: string
  mediaType?: string
  sourcePath: string
  suggestedFileName: string
  digest: string
  sizeBytes: number
  lineageArtifactIds: string[]
}

/** Resolve only a canonical, byte-verifiable local Location owned by the Artifact's Project. */
export async function resolveWorkflowArtifactExportSource(
  rawArtifactId: string,
  rootDir?: string
): Promise<WorkflowArtifactExportSource> {
  const artifactId = rawArtifactId.trim()
  if (!artifactId) throw new Error('Artifact ID is required')
  const resolved = await readTaskSnapshotDatabase(rootDir, (db) => {
    setupWorkflowLedgerSchema(db)
    setupWorkflowArtifactGraphSchema(db)
    verifyWorkflowArtifactGraph(db)
    const artifact = findWorkflowArtifact(db, artifactId)
    if (!artifact) throw new Error(`workflow artifact ${artifactId} was not found`)
    if (!artifact.projectId) throw new Error(`workflow artifact ${artifactId} has no Project ownership`)
    const digest = normalizeDigest(artifact.digest, 'Artifact digest')
    const candidates = readArtifactLocations(db)
      .filter((location) => location.artifactId === artifact.id && location.availability === 'available')
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    for (const location of candidates) {
      assertLocationProjectCompatibility(location, artifact)
      assertArtifactScopeCompatibility(location, artifact)
      assertScopeReferences(db, location, location.projectId, `location ${location.id}`)
    }
    const artifacts = readArtifacts(db).filter((candidate) => candidate.projectId === artifact.projectId)
    return { artifact, digest, candidates, lineageArtifactIds: connectedLineageIds(artifacts, artifact.id) }
  })

  let lastError: unknown
  for (const location of resolved.candidates) {
    try {
      return await inspectExportCandidate(resolved.artifact, location, resolved.digest, resolved.lineageArtifactIds)
    } catch (error) {
      lastError = error
    }
  }
  const reason = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(`Artifact ${artifactId} has no byte-verified local Location${reason}`)
}

export async function compareWorkflowArtifactSources(
  rawBaseArtifactId: string,
  rawTargetArtifactId: string,
  rootDir?: string
): Promise<WorkflowArtifactCompareResult> {
  const [base, target] = await Promise.all([
    resolveWorkflowArtifactExportSource(rawBaseArtifactId, rootDir),
    resolveWorkflowArtifactExportSource(rawTargetArtifactId, rootDir)
  ])
  if (base.artifactId === target.artifactId) throw new Error('Artifact comparison requires two different versions')
  if (base.projectId !== target.projectId || !base.lineageArtifactIds.includes(target.artifactId)) {
    throw new Error('Artifact comparison requires versions from the same Project lineage')
  }
  const baseSide = comparisonSide(base)
  const targetSide = comparisonSide(target)
  if (base.digest === target.digest && base.sizeBytes === target.sizeBytes) {
    return {
      base: baseSide,
      target: targetSide,
      comparison: 'identical',
      sizeDeltaBytes: 0,
      addedLines: 0,
      removedLines: 0,
      changes: [],
      truncated: false
    }
  }
  if (!isTextArtifact(base) || !isTextArtifact(target)) {
    return binaryComparison(baseSide, targetSide)
  }
  const [baseText, targetText] = await Promise.all([readVerifiedText(base), readVerifiedText(target)])
  if (baseText === undefined || targetText === undefined) return binaryComparison(baseSide, targetSide)
  return textComparison(baseSide, targetSide, baseText, targetText)
}

/** Copy verified bytes to a user-selected path and publish them atomically. */
export async function exportWorkflowArtifactToPath(
  source: WorkflowArtifactExportSource,
  rawTargetPath: string
): Promise<Exclude<WorkflowArtifactExportResult, { canceled: true }>> {
  const targetPath = resolve(rawTargetPath)
  if (targetPath === resolve(source.sourcePath)) {
    throw new Error('Artifact export destination must differ from its canonical source')
  }
  const parent = dirname(targetPath)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const temporaryPath = join(parent, `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`)
  let sourceHandle: FileHandle | undefined
  let targetHandle: FileHandle | undefined
  try {
    const pathBefore = await lstat(source.sourcePath, { bigint: true })
    assertRegularFile(pathBefore, source.sourcePath)
    sourceHandle = await open(source.sourcePath, constants.O_RDONLY)
    const openedBefore = await sourceHandle.stat({ bigint: true })
    if (!openedBefore.isFile() || !sameFile(pathBefore, openedBefore)) {
      throw new Error('Artifact source changed before export')
    }
    targetHandle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    const observed = await copyAndHash(sourceHandle, targetHandle)
    await targetHandle.sync()
    const openedAfter = await sourceHandle.stat({ bigint: true })
    const pathAfter = await lstat(source.sourcePath, { bigint: true })
    assertRegularFile(pathAfter, source.sourcePath)
    if (!sameSnapshot(openedBefore, openedAfter) || !sameFile(openedAfter, pathAfter)) {
      throw new Error('Artifact source changed during export')
    }
    assertObservedContent(observed, source)
    await sourceHandle.close()
    sourceHandle = undefined
    await targetHandle.close()
    targetHandle = undefined
    if (process.platform !== 'win32') await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, targetPath)
    await syncDirectory(parent)
    const exported = await inspectStableFile(targetPath)
    assertObservedContent(exported, source)
    return {
      canceled: false,
      artifactId: source.artifactId,
      fileName: basename(targetPath),
      sizeBytes: exported.sizeBytes,
      digest: `sha256:${exported.digest}`
    }
  } catch (error) {
    await sourceHandle?.close().catch(() => undefined)
    await targetHandle?.close().catch(() => undefined)
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

/** Stream canonical Artifact bytes while revalidating identity and digest around the complete read. */
export function createVerifiedWorkflowArtifactStream(
  source: WorkflowArtifactExportSource
): Readable {
  return Readable.from(readVerifiedArtifactChunks(source))
}

async function* readVerifiedArtifactChunks(
  source: WorkflowArtifactExportSource
): AsyncGenerator<Buffer> {
  const pathBefore = await lstat(source.sourcePath, { bigint: true })
  assertRegularFile(pathBefore, source.sourcePath)
  const handle = await open(source.sourcePath, constants.O_RDONLY)
  const hash = createHash('sha256')
  let sizeBytes = 0
  try {
    const openedBefore = await handle.stat({ bigint: true })
    if (!openedBefore.isFile() || !sameFile(pathBefore, openedBefore)) {
      throw new Error('Artifact source changed before package export')
    }
    const buffer = Buffer.allocUnsafe(256 * 1024)
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null)
      if (bytesRead === 0) break
      const chunk = Buffer.from(buffer.subarray(0, bytesRead))
      hash.update(chunk)
      sizeBytes += bytesRead
      if (!Number.isSafeInteger(sizeBytes)) throw new Error('Artifact is too large to package safely')
      yield chunk
    }
    const openedAfter = await handle.stat({ bigint: true })
    const pathAfter = await lstat(source.sourcePath, { bigint: true })
    assertRegularFile(pathAfter, source.sourcePath)
    if (!sameSnapshot(openedBefore, openedAfter) || !sameFile(openedAfter, pathAfter)) {
      throw new Error('Artifact source changed during package export')
    }
    assertObservedContent({ digest: hash.digest('hex'), sizeBytes }, source)
  } finally {
    await handle.close()
  }
}

async function inspectExportCandidate(
  artifact: WorkflowArtifactRecord,
  location: WorkflowArtifactLocationRecord,
  digest: string,
  lineageArtifactIds: string[]
): Promise<WorkflowArtifactExportSource> {
  const sourcePath = localLocationPath(location)
  if (!sourcePath) throw new Error(`Location ${location.id} is not a local file`)
  if (!Number.isSafeInteger(location.sizeBytes) || Number(location.sizeBytes) < 0) {
    throw new Error(`Location ${location.id} has no valid size declaration`)
  }
  if (!location.checksum || normalizeDigest(location.checksum, `Location ${location.id} checksum`) !== digest) {
    throw new Error(`Location ${location.id} checksum does not match its Artifact`)
  }
  const observed = await inspectStableFile(sourcePath)
  const expectedSize = Number(location.sizeBytes)
  if (observed.sizeBytes !== expectedSize || observed.digest !== digest) {
    throw new Error(`Location ${location.id} bytes do not match its Artifact`)
  }
  const extension = safeExtension(sourcePath)
  return {
    artifactId: artifact.id,
    projectId: artifact.projectId!,
    version: artifact.version,
    title: artifact.title,
    ...(artifact.mediaType ? { mediaType: artifact.mediaType } : {}),
    sourcePath,
    suggestedFileName: `${safeFileStem(artifact.title)}${extension}`,
    digest,
    sizeBytes: expectedSize,
    lineageArtifactIds
  }
}

function connectedLineageIds(artifacts: readonly WorkflowArtifactRecord[], artifactId: string): string[] {
  const neighbors = new Map<string, Set<string>>()
  const add = (left: string, right: string): void => {
    const values = neighbors.get(left) ?? new Set<string>()
    values.add(right)
    neighbors.set(left, values)
  }
  for (const artifact of artifacts) {
    if (!artifact.supersedesId) continue
    add(artifact.id, artifact.supersedesId)
    add(artifact.supersedesId, artifact.id)
  }
  const result: string[] = []
  const pending = [artifactId]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const id = pending.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    result.push(id)
    pending.push(...[...(neighbors.get(id) ?? [])].sort())
  }
  return result.sort()
}

function comparisonSide(source: WorkflowArtifactExportSource) {
  return {
    artifactId: source.artifactId,
    title: source.title,
    version: source.version,
    digest: `sha256:${source.digest}`,
    sizeBytes: source.sizeBytes
  }
}

function binaryComparison(
  base: WorkflowArtifactCompareResult['base'],
  target: WorkflowArtifactCompareResult['target']
): WorkflowArtifactCompareResult {
  return {
    base,
    target,
    comparison: 'binary',
    sizeDeltaBytes: target.sizeBytes - base.sizeBytes,
    addedLines: 0,
    removedLines: 0,
    changes: [],
    truncated: false
  }
}

const TEXT_COMPARE_MAX_BYTES = 2 * 1024 * 1024
const TEXT_COMPARE_MAX_LINES = 2_000
const TEXT_COMPARE_MAX_CHANGES = 500
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.xml', '.html', '.css', '.js', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.c', '.cc', '.cpp', '.h', '.hpp', '.sh', '.zsh', '.yaml', '.yml', '.toml', '.ini', '.sql', '.diff', '.patch'])

function isTextArtifact(source: WorkflowArtifactExportSource): boolean {
  const mediaType = source.mediaType?.split(';', 1)[0].trim().toLowerCase()
  return Boolean(mediaType?.startsWith('text/') || mediaType === 'application/json' || mediaType === 'application/xml' ||
    TEXT_EXTENSIONS.has(extname(source.sourcePath).toLowerCase()))
}

async function readVerifiedText(source: WorkflowArtifactExportSource): Promise<string | undefined> {
  if (source.sizeBytes > TEXT_COMPARE_MAX_BYTES) return undefined
  const pathBefore = await lstat(source.sourcePath, { bigint: true })
  assertRegularFile(pathBefore, source.sourcePath)
  const handle = await open(source.sourcePath, constants.O_RDONLY)
  try {
    const openedBefore = await handle.stat({ bigint: true })
    if (!openedBefore.isFile() || !sameFile(pathBefore, openedBefore)) {
      throw new Error('Artifact changed before preparing text comparison')
    }
    const bytes = Buffer.alloc(source.sizeBytes)
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (bytesRead === 0) throw new Error('Artifact changed while preparing text comparison')
      offset += bytesRead
    }
    const observed = { digest: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength }
    const openedAfter = await handle.stat({ bigint: true })
    const pathAfter = await lstat(source.sourcePath, { bigint: true })
    assertRegularFile(pathAfter, source.sourcePath)
    if (!sameSnapshot(openedBefore, openedAfter) || !sameFile(openedAfter, pathAfter)) {
      throw new Error('Artifact changed while preparing text comparison')
    }
    assertObservedContent(observed, source)
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return undefined
    }
  } finally {
    await handle.close()
  }
}

function textComparison(
  base: WorkflowArtifactCompareResult['base'],
  target: WorkflowArtifactCompareResult['target'],
  baseText: string,
  targetText: string
): WorkflowArtifactCompareResult {
  const baseLines = baseText.replace(/\r\n?/g, '\n').split('\n')
  const targetLines = targetText.replace(/\r\n?/g, '\n').split('\n')
  if (baseLines.length > TEXT_COMPARE_MAX_LINES || targetLines.length > TEXT_COMPARE_MAX_LINES) {
    return { ...binaryComparison(base, target), comparison: 'text', truncated: true }
  }
  const width = targetLines.length + 1
  const matrix = new Uint32Array((baseLines.length + 1) * width)
  for (let left = baseLines.length - 1; left >= 0; left -= 1) {
    for (let right = targetLines.length - 1; right >= 0; right -= 1) {
      matrix[left * width + right] = baseLines[left] === targetLines[right]
        ? matrix[(left + 1) * width + right + 1] + 1
        : Math.max(matrix[(left + 1) * width + right], matrix[left * width + right + 1])
    }
  }
  const changes: WorkflowArtifactCompareResult['changes'] = []
  let left = 0
  let right = 0
  let addedLines = 0
  let removedLines = 0
  let truncated = false
  const append = (kind: 'context' | 'added' | 'removed', text: string): void => {
    if (changes.length >= TEXT_COMPARE_MAX_CHANGES) {
      truncated = true
      return
    }
    changes.push({ kind, text: text.slice(0, 4_096) })
    if (text.length > 4_096) truncated = true
  }
  while (left < baseLines.length || right < targetLines.length) {
    if (left < baseLines.length && right < targetLines.length && baseLines[left] === targetLines[right]) {
      left += 1
      right += 1
    } else if (right < targetLines.length && (left === baseLines.length ||
        matrix[left * width + right + 1] >= matrix[(left + 1) * width + right])) {
      append('added', targetLines[right])
      addedLines += 1
      right += 1
    } else {
      append('removed', baseLines[left])
      removedLines += 1
      left += 1
    }
  }
  return {
    base,
    target,
    comparison: 'text',
    sizeDeltaBytes: target.sizeBytes - base.sizeBytes,
    addedLines,
    removedLines,
    changes,
    truncated
  }
}

function localLocationPath(location: WorkflowArtifactLocationRecord): string | undefined {
  if (location.path) {
    if (!isAbsolute(location.path)) throw new Error(`Location ${location.id} path is not absolute`)
    return resolve(location.path)
  }
  if (!location.uri?.toLowerCase().startsWith('file:')) return undefined
  try {
    return resolve(fileURLToPath(new URL(location.uri)))
  } catch {
    throw new Error(`Location ${location.id} file URI is invalid`)
  }
}

async function inspectStableFile(filePath: string): Promise<{ digest: string; sizeBytes: number }> {
  const pathBefore = await lstat(filePath, { bigint: true })
  assertRegularFile(pathBefore, filePath)
  const handle = await open(filePath, constants.O_RDONLY)
  try {
    const openedBefore = await handle.stat({ bigint: true })
    if (!openedBefore.isFile() || !sameFile(pathBefore, openedBefore)) {
      throw new Error(`Artifact file identity changed: ${filePath}`)
    }
    const observed = await hashFile(handle)
    const openedAfter = await handle.stat({ bigint: true })
    const pathAfter = await lstat(filePath, { bigint: true })
    assertRegularFile(pathAfter, filePath)
    if (!sameSnapshot(openedBefore, openedAfter) || !sameFile(openedAfter, pathAfter)) {
      throw new Error(`Artifact file changed while being read: ${filePath}`)
    }
    return observed
  } finally {
    await handle.close()
  }
}

async function copyAndHash(source: FileHandle, target: FileHandle): Promise<{ digest: string; sizeBytes: number }> {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(256 * 1024)
  let sizeBytes = 0
  while (true) {
    const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, null)
    if (bytesRead === 0) break
    const chunk = buffer.subarray(0, bytesRead)
    await writeAll(target, chunk)
    hash.update(chunk)
    sizeBytes += bytesRead
    if (!Number.isSafeInteger(sizeBytes)) throw new Error('Artifact is too large to export safely')
  }
  return { digest: hash.digest('hex'), sizeBytes }
}

async function writeAll(target: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await target.write(bytes, offset, bytes.byteLength - offset, null)
    if (bytesWritten <= 0) throw new Error('Artifact export write made no progress')
    offset += bytesWritten
  }
}

async function hashFile(handle: FileHandle): Promise<{ digest: string; sizeBytes: number }> {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(256 * 1024)
  let position = 0
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position)
    if (bytesRead === 0) break
    hash.update(buffer.subarray(0, bytesRead))
    position += bytesRead
    if (!Number.isSafeInteger(position)) throw new Error('Artifact is too large to verify safely')
  }
  return { digest: hash.digest('hex'), sizeBytes: position }
}

function assertObservedContent(
  observed: { digest: string; sizeBytes: number },
  source: Pick<WorkflowArtifactExportSource, 'digest' | 'sizeBytes'>
): void {
  if (observed.digest !== source.digest || observed.sizeBytes !== source.sizeBytes) {
    throw new Error('Exported Artifact bytes do not match the canonical digest and size')
  }
}

function normalizeDigest(value: string, label: string): string {
  const match = SHA256_PATTERN.exec(value.trim())
  if (!match) throw new Error(`${label} must be a SHA-256 digest`)
  return match[1].toLowerCase()
}

function assertRegularFile(stats: BigIntStats, filePath: string): void {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Artifact content is not a regular file: ${filePath}`)
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameFile(left, right) && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function safeFileStem(value: string): string {
  const stem = value.normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim()
  return (stem || 'artifact').slice(0, 100).replace(/[. ]+$/g, '') || 'artifact'
}

function safeExtension(filePath: string): string {
  const extension = extname(filePath).toLowerCase()
  return /^\.[a-z0-9]{1,16}$/.test(extension) ? extension : ''
}
