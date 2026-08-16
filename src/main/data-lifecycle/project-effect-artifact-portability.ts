import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type {
  ProjectAggregateEffectArtifact,
  ProjectAggregateExportBundle,
  ProjectAggregatePortableRuntime,
  ProjectAggregateSnapshot,
  ProjectAggregatePortableFile
} from '../../shared/project-aggregate-types'
import type { EffectRecord, EffectTarget, TaskSnapshotRecord } from '../../shared/types'
import { readRuns } from '../task/workflow-ledger-query'
import { listTaskSnapshots, readTaskSnapshotDatabase } from '../task/task-snapshot'

type GitIndexTarget = Extract<EffectTarget, { kind: 'git_index_update' }>

interface EffectArtifactReference {
  effectId: string
  runId: string
  sessionId: string
  artifactRef: string
  target: GitIndexTarget
}

interface GitIndexManifest {
  schemaVersion: 1
  expectedIndexEntriesDigest: string
  indexSha256: string
  indexBytes: number
  objects: Array<{ path: string; sha256: string; bytes: number }>
}

const MAX_FILE_BYTES = 256 * 1024 * 1024
const MAX_TOTAL_BYTES = 320 * 1024 * 1024
const MAX_OBJECTS = 100_000

export function collectProjectEffectArtifacts(
  rootDir: string,
  aggregate: ProjectAggregateSnapshot,
  snapshots: readonly TaskSnapshotRecord[]
): ProjectAggregateEffectArtifact[] {
  const references = projectEffectArtifactReferences(aggregate, snapshots)
  const grouped = groupReferences(references)
  const records: ProjectAggregateEffectArtifact[] = []
  for (const [artifactRef, owned] of [...grouped].sort(([left], [right]) => left.localeCompare(right))) {
    const files = readEffectArtifactFiles(rootDir, owned[0].target, artifactRef)
    const record = {
      artifactRef,
      effectIds: owned.map((item) => item.effectId).sort(),
      files
    }
    validateEffectArtifactRecord(record, owned)
    records.push(record)
  }
  return records
}

export function validateProjectEffectArtifacts(
  bundle: Pick<ProjectAggregateExportBundle, 'aggregate'>,
  runtime: ProjectAggregatePortableRuntime
): ProjectAggregateEffectArtifact[] {
  const references = projectEffectArtifactReferences(bundle.aggregate, runtime.taskSnapshots)
  if (runtime.effectArtifacts === undefined) {
    if (references.length > 0) throw new Error('Project import Effect artifact closure is incomplete')
    return []
  }
  if (!Array.isArray(runtime.effectArtifacts)) throw new Error('Project import Effect artifacts are invalid')
  const grouped = groupReferences(references)
  const records = new Map<string, ProjectAggregateEffectArtifact>()
  for (const value of runtime.effectArtifacts) {
    if (!isRecord(value) || typeof value.artifactRef !== 'string' ||
        !Array.isArray(value.effectIds) || !Array.isArray(value.files)) {
      throw new Error('Project import Effect artifact is invalid')
    }
    const artifactRef = requireArtifactRef(value.artifactRef)
    if (records.has(artifactRef)) throw new Error(`Project import contains duplicate Effect artifact: ${artifactRef}`)
    const owned = grouped.get(artifactRef)
    if (!owned) throw new Error(`Project import contains orphan Effect artifact: ${artifactRef}`)
    const record = value as unknown as ProjectAggregateEffectArtifact
    validateEffectArtifactRecord(record, owned)
    records.set(artifactRef, record)
  }
  const missing = [...grouped.keys()].filter((artifactRef) => !records.has(artifactRef))
  if (missing.length > 0) throw new Error(`Project import Effect artifact closure is incomplete: ${missing.sort().join(', ')}`)
  return [...records.values()].sort((left, right) => left.artifactRef.localeCompare(right.artifactRef))
}

export function importProjectEffectArtifacts(
  bundle: Pick<ProjectAggregateExportBundle, 'aggregate'>,
  runtime: ProjectAggregatePortableRuntime,
  rootDir: string
): number {
  const records = validateProjectEffectArtifacts(bundle, runtime)
  for (const record of records) materializeEffectArtifact(rootDir, record)
  return records.length
}

export function assertProjectEffectArtifactsImportable(
  bundle: Pick<ProjectAggregateExportBundle, 'aggregate'>,
  runtime: ProjectAggregatePortableRuntime,
  rootDir: string
): void {
  for (const record of validateProjectEffectArtifacts(bundle, runtime)) {
    const destination = effectArtifactPath(rootDir, record.artifactRef)
    if (existsSync(destination)) verifyMaterializedEffectArtifact(rootDir, record)
  }
}

export function verifyProjectEffectArtifacts(
  bundle: Pick<ProjectAggregateExportBundle, 'aggregate'>,
  runtime: ProjectAggregatePortableRuntime,
  rootDir: string
): number {
  const records = validateProjectEffectArtifacts(bundle, runtime)
  for (const record of records) verifyMaterializedEffectArtifact(rootDir, record)
  return records.length
}

export async function purgeProjectEffectArtifacts(
  rootDir: string,
  artifactRefs: readonly string[]
): Promise<number> {
  const retained = await referencedEffectArtifactRefs(rootDir)
  let deleted = 0
  for (const artifactRef of normalizedArtifactRefs(artifactRefs)) {
    if (retained.has(artifactRef)) continue
    const destination = effectArtifactPath(rootDir, artifactRef)
    if (!existsSync(destination)) continue
    assertAppOwnedArtifactDirectory(rootDir, artifactRef, destination)
    rmSync(destination, { recursive: true, force: false })
    fsyncDirectory(dirname(destination))
    deleted += 1
  }
  return deleted
}

export async function countProjectEffectArtifactResiduals(
  rootDir: string,
  artifactRefs: readonly string[]
): Promise<number> {
  const retained = await referencedEffectArtifactRefs(rootDir)
  return normalizedArtifactRefs(artifactRefs).filter((artifactRef) =>
    !retained.has(artifactRef) && existsSync(effectArtifactPath(rootDir, artifactRef))).length
}

function projectEffectArtifactReferences(
  aggregate: ProjectAggregateSnapshot,
  snapshots: readonly TaskSnapshotRecord[]
): EffectArtifactReference[] {
  const effects: EffectRecord[] = [
    ...aggregate.workflow.runs.flatMap((run) => run.taskRun.effects ?? []),
    ...snapshots.flatMap((snapshot) => snapshot.run?.effects ?? [])
  ]
  const references = new Map<string, EffectArtifactReference>()
  for (const effect of effects) {
    if (effect.target.kind !== 'git_index_update') continue
    const candidate = {
      effectId: requiredId(effect.id, 'Effect id'),
      runId: requiredId(effect.runId, 'Effect runId'),
      sessionId: requiredId(effect.sessionId, 'Effect sessionId'),
      artifactRef: artifactRefForTarget(effect.target),
      target: effect.target
    }
    const prior = references.get(candidate.effectId)
    if (prior && (prior.artifactRef !== candidate.artifactRef ||
        prior.target.indexArtifactSha256 !== candidate.target.indexArtifactSha256 ||
        prior.target.objectManifestSha256 !== candidate.target.objectManifestSha256)) {
      throw new Error(`Project Effect artifact identity differs across projections: ${candidate.effectId}`)
    }
    references.set(candidate.effectId, candidate)
  }
  return [...references.values()].sort((left, right) => left.effectId.localeCompare(right.effectId))
}

function groupReferences(
  references: readonly EffectArtifactReference[]
): Map<string, EffectArtifactReference[]> {
  const grouped = new Map<string, EffectArtifactReference[]>()
  for (const reference of references) {
    const values = grouped.get(reference.artifactRef) ?? []
    values.push(reference)
    grouped.set(reference.artifactRef, values)
  }
  return grouped
}

function artifactRefForTarget(target: GitIndexTarget): string {
  if (target.artifactRef !== undefined) return requireArtifactRef(target.artifactRef)
  const key = basename(resolve(target.artifactRoot))
  return requireArtifactRef(`git-index/${key}`)
}

function readEffectArtifactFiles(
  rootDir: string,
  target: GitIndexTarget,
  artifactRef: string
): ProjectAggregatePortableFile[] {
  const root = assertSourceArtifactRoot(rootDir, target, artifactRef)
  const index = readPortableFile(root, 'index')
  const manifestFile = readPortableFile(root, 'manifest.json')
  const manifest = parseManifest(decodePortableFile(manifestFile))
  if (manifest.objects.length > MAX_OBJECTS) throw new Error('Project Effect artifact object count exceeds limit')
  const files = [index, manifestFile]
  for (const object of manifest.objects) files.push(readPortableFile(root, `objects/${object.path}`))
  const total = files.reduce((sum, file) => sum + file.sizeBytes, 0)
  if (total > MAX_TOTAL_BYTES) throw new Error('Project Effect artifact total bytes exceed limit')
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

function validateEffectArtifactRecord(
  record: ProjectAggregateEffectArtifact,
  references: readonly EffectArtifactReference[]
): void {
  const artifactRef = requireArtifactRef(record.artifactRef)
  assertEffectArtifactOwners(record, references, artifactRef)
  const files = validateEffectArtifactFiles(record.files, artifactRef)
  const index = requiredFile(files, 'index', artifactRef)
  const manifestBytes = requiredFile(files, 'manifest.json', artifactRef)
  const manifest = parseManifest(manifestBytes)
  assertEffectArtifactFileClosure(files, manifest, artifactRef)
  assertEffectArtifactTargetBindings(references, artifactRef, index, manifestBytes, manifest)
}

function assertEffectArtifactOwners(
  record: ProjectAggregateEffectArtifact,
  references: readonly EffectArtifactReference[],
  artifactRef: string
): void {
  const effectIds = normalizedIds(record.effectIds, 'Effect artifact effectId')
  const expectedIds = references.map((item) => item.effectId).sort()
  if (JSON.stringify(effectIds) !== JSON.stringify(expectedIds)) {
    throw new Error(`Project Effect artifact owner closure differs: ${artifactRef}`)
  }
}

function validateEffectArtifactFiles(
  values: readonly ProjectAggregatePortableFile[],
  artifactRef: string
): Map<string, { file: ProjectAggregatePortableFile; bytes: Buffer }> {
  const files = new Map<string, { file: ProjectAggregatePortableFile; bytes: Buffer }>()
  let total = 0
  for (const value of values) {
    const file = requireEffectArtifactFile(value, artifactRef)
    const path = requirePortablePath(file.path)
    if (files.has(path)) throw new Error(`Project Effect artifact contains duplicate file: ${path}`)
    const bytes = decodeCanonicalBase64(file.data)
    if (bytes.byteLength !== file.sizeBytes || sha256Digest(bytes) !== file.digest) {
      throw new Error(`Project Effect artifact file digest mismatch: ${path}`)
    }
    total += bytes.byteLength
    if (total > MAX_TOTAL_BYTES) throw new Error('Project Effect artifact total bytes exceed limit')
    files.set(path, { file, bytes })
  }
  return files
}

function requireEffectArtifactFile(
  value: unknown,
  artifactRef: string
): ProjectAggregatePortableFile {
  if (!isRecord(value) || typeof value.path !== 'string' || typeof value.digest !== 'string' ||
      value.encoding !== 'base64' || typeof value.data !== 'string' ||
      !Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) < 0 ||
      Number(value.sizeBytes) > MAX_FILE_BYTES) {
    throw new Error(`Project Effect artifact file is invalid: ${artifactRef}`)
  }
  return value as unknown as ProjectAggregatePortableFile
}

function assertEffectArtifactFileClosure(
  files: ReadonlyMap<string, { bytes: Buffer }>,
  manifest: GitIndexManifest,
  artifactRef: string
): void {
  if (manifest.objects.length > MAX_OBJECTS) throw new Error('Project Effect artifact object count exceeds limit')
  const expectedPaths = ['index', 'manifest.json', ...manifest.objects.map((item) => `objects/${item.path}`)].sort()
  if (JSON.stringify([...files.keys()].sort()) !== JSON.stringify(expectedPaths)) {
    throw new Error(`Project Effect artifact file closure is incomplete: ${artifactRef}`)
  }
  for (const object of manifest.objects) {
    const bytes = requiredFile(files, `objects/${object.path}`, artifactRef)
    if (bytes.byteLength !== object.bytes || rawSha256(bytes) !== object.sha256) {
      throw new Error(`Project Effect artifact object digest mismatch: ${object.path}`)
    }
  }
}

function assertEffectArtifactTargetBindings(
  references: readonly EffectArtifactReference[],
  artifactRef: string,
  index: Buffer,
  manifestBytes: Buffer,
  manifest: GitIndexManifest
): void {
  for (const reference of references) {
    const target = reference.target
    if (!effectArtifactTargetMatches(target, artifactRef, index, manifestBytes, manifest)) {
      throw new Error(`Project Effect artifact differs from Effect target: ${reference.effectId}`)
    }
  }
}

function effectArtifactTargetMatches(
  target: GitIndexTarget,
  artifactRef: string,
  index: Buffer,
  manifestBytes: Buffer,
  manifest: GitIndexManifest
): boolean {
  return artifactRefForTarget(target) === artifactRef && rawSha256(index) === target.indexArtifactSha256 &&
    index.byteLength === target.indexArtifactBytes && rawSha256(manifestBytes) === target.objectManifestSha256 &&
    manifest.expectedIndexEntriesDigest === target.expectedIndexEntriesDigest &&
    manifest.indexSha256 === target.indexArtifactSha256 && manifest.indexBytes === target.indexArtifactBytes &&
    manifest.objects.length === target.objectCount
}

function materializeEffectArtifact(rootDir: string, record: ProjectAggregateEffectArtifact): void {
  const destination = effectArtifactPath(rootDir, record.artifactRef)
  if (existsSync(destination)) {
    verifyMaterializedEffectArtifact(rootDir, record)
    return
  }
  const base = ensurePrivateDirectory(resolve(rootDir, 'effect-artifacts', 'git-index'))
  const temporary = join(base, `.${basename(destination)}-${randomUUID()}.tmp`)
  try {
    mkdirSync(temporary, { recursive: false, mode: 0o700 })
    for (const file of record.files) writePrivateFile(temporary, file.path, decodeCanonicalBase64(file.data))
    fsyncDirectoryTree(temporary)
    renameSync(temporary, destination)
    fsyncDirectory(base)
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    if (!existsSync(destination)) throw error
  }
  verifyMaterializedEffectArtifact(rootDir, record)
}

function verifyMaterializedEffectArtifact(rootDir: string, record: ProjectAggregateEffectArtifact): void {
  const destination = effectArtifactPath(rootDir, record.artifactRef)
  assertAppOwnedArtifactDirectory(rootDir, record.artifactRef, destination)
  const expected = new Map(record.files.map((file) => [file.path, file]))
  const actualPaths = listArtifactFiles(destination)
  if (JSON.stringify(actualPaths) !== JSON.stringify([...expected.keys()].sort())) {
    throw new Error(`Project Effect artifact destination closure differs: ${record.artifactRef}`)
  }
  for (const path of actualPaths) {
    const file = expected.get(path) as ProjectAggregatePortableFile
    const bytes = readRegularFile(join(destination, path), MAX_FILE_BYTES)
    if (bytes.byteLength !== file.sizeBytes || sha256Digest(bytes) !== file.digest) {
      throw new Error(`Project Effect artifact destination digest mismatch: ${path}`)
    }
  }
}

async function referencedEffectArtifactRefs(rootDir: string): Promise<Set<string>> {
  const [snapshots, runs] = await Promise.all([
    listTaskSnapshots(rootDir),
    readTaskSnapshotDatabase(rootDir, (db) => readRuns(db))
  ])
  const refs = new Set<string>()
  const effects = [
    ...snapshots.flatMap((snapshot) => snapshot.run?.effects ?? []),
    ...runs.flatMap((run) => run.taskRun.effects ?? [])
  ]
  for (const effect of effects) {
    if (effect.target.kind === 'git_index_update') refs.add(artifactRefForTarget(effect.target))
  }
  return refs
}

function assertSourceArtifactRoot(rootDir: string, target: GitIndexTarget, artifactRef: string): string {
  const expected = effectArtifactPath(rootDir, artifactRef)
  const actual = realpathSync(target.artifactRoot)
  if (actual !== realpathSync(expected)) throw new Error('Project Effect artifact crosses the app-private root')
  if (realpathSync(target.indexArtifactPath) !== realpathSync(resolve(actual, 'index')) ||
      realpathSync(target.objectManifestPath) !== realpathSync(resolve(actual, 'manifest.json'))) {
    throw new Error('Project Effect artifact target paths are inconsistent')
  }
  assertAppOwnedArtifactDirectory(rootDir, artifactRef, actual)
  return actual
}

function assertAppOwnedArtifactDirectory(rootDir: string, artifactRef: string, value: string): void {
  const expected = effectArtifactPath(rootDir, artifactRef)
  const stat = lstatSync(value)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(value) !== realpathSync(expected)) {
    throw new Error('Project Effect artifact directory is not app-owned')
  }
}

function effectArtifactPath(rootDir: string, artifactRef: string): string {
  const normalized = requireArtifactRef(artifactRef)
  return resolve(rootDir, 'effect-artifacts', ...normalized.split('/'))
}

function readPortableFile(root: string, relativePath: string): ProjectAggregatePortableFile {
  const path = requirePortablePath(relativePath)
  const bytes = readRegularFile(join(root, path), MAX_FILE_BYTES)
  return {
    path,
    digest: sha256Digest(bytes),
    sizeBytes: bytes.byteLength,
    encoding: 'base64',
    data: bytes.toString('base64')
  }
}

function readRegularFile(path: string, limit: number): Buffer {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) {
    throw new Error(`Project Effect artifact file is not a bounded regular file: ${path}`)
  }
  return readFileSync(path)
}

function listArtifactFiles(root: string): string[] {
  const files: string[] = []
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Project Effect artifact destination contains a symbolic link')
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) visit(path, relativePath)
      else if (entry.isFile()) files.push(requirePortablePath(relativePath))
      else throw new Error('Project Effect artifact destination contains an unsupported entry')
    }
  }
  visit(root, '')
  return files.sort()
}

function parseManifest(bytes: Buffer): GitIndexManifest {
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('Project Effect artifact manifest is invalid JSON') }
  if (!isManifestHeader(value)) throw new Error('Project Effect artifact manifest is invalid')
  const paths = new Set<string>()
  for (const object of value.objects) {
    if (!isManifestObject(object) || paths.has(object.path)) {
      throw new Error('Project Effect artifact manifest object is invalid')
    }
    paths.add(object.path)
  }
  return value as unknown as GitIndexManifest
}

function isManifestHeader(value: unknown): value is Record<string, unknown> & { objects: unknown[] } {
  return isRecord(value) && value.schemaVersion === 1 && typeof value.expectedIndexEntriesDigest === 'string' &&
    typeof value.indexSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.indexSha256) &&
    Number.isSafeInteger(value.indexBytes) && Number(value.indexBytes) >= 0 && Array.isArray(value.objects)
}

function isManifestObject(value: unknown): value is { path: string; sha256: string; bytes: number } {
  return isRecord(value) && typeof value.path === 'string' && /^[a-f0-9]{2}\/[a-f0-9]+$/.test(value.path) &&
    typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) && Number(value.bytes) >= 0 && Number(value.bytes) <= MAX_FILE_BYTES
}

function requiredFile(
  files: ReadonlyMap<string, { bytes: Buffer }>,
  path: string,
  artifactRef: string
): Buffer {
  const value = files.get(path)?.bytes
  if (!value) throw new Error(`Project Effect artifact ${artifactRef} is missing ${path}`)
  return value
}

function decodePortableFile(file: ProjectAggregatePortableFile): Buffer {
  const bytes = decodeCanonicalBase64(file.data)
  if (bytes.byteLength !== file.sizeBytes || sha256Digest(bytes) !== file.digest) {
    throw new Error(`Project Effect artifact file digest mismatch: ${file.path}`)
  }
  return bytes
}

function decodeCanonicalBase64(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new Error('Project Effect artifact base64 is not canonical')
  return bytes
}

function writePrivateFile(root: string, relativePath: string, bytes: Buffer): void {
  const path = resolve(root, requirePortablePath(relativePath))
  const relative = path.slice(resolve(root).length + 1)
  if (!relative || relative.startsWith('..')) throw new Error('Project Effect artifact destination path escapes its root')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const descriptor = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(descriptor, bytes)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function ensurePrivateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Project Effect artifact root is not a safe directory')
  return realpathSync(path)
}

function fsyncDirectoryTree(root: string): void {
  const directories: string[] = []
  const visit = (directory: string): void => {
    directories.push(directory)
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(join(directory, entry.name))
    }
  }
  visit(root)
  for (const directory of directories.reverse()) fsyncDirectory(directory)
}

function fsyncDirectory(directory: string): void {
  if (process.platform === 'win32') return
  const descriptor = openSync(directory, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function requireArtifactRef(value: string): string {
  const match = /^git-index\/([a-f0-9]{64})$/.exec(value)
  if (!match) throw new Error('Project Effect artifactRef is invalid')
  return `git-index/${match[1]}`
}

function requirePortablePath(value: string): string {
  if (value === 'index' || value === 'manifest.json' || /^objects\/[a-f0-9]{2}\/[a-f0-9]+$/.test(value)) return value
  throw new Error('Project Effect artifact portable path is invalid')
}

function normalizedArtifactRefs(values: readonly string[]): string[] {
  return [...new Set(values.map(requireArtifactRef))].sort()
}

function normalizedIds(values: readonly unknown[], label: string): string[] {
  const result = values.map((value) => requiredId(value, label))
  if (new Set(result).size !== result.length || JSON.stringify(result) !== JSON.stringify([...result].sort())) {
    throw new Error(`${label} list is not unique and sorted`)
  }
  return result
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\0-\x1f\x7f]/.test(value)) throw new Error(`${label} is required`)
  return value.trim()
}

function rawSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha256Digest(bytes: Uint8Array): string {
  return `sha256:${rawSha256(bytes)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
