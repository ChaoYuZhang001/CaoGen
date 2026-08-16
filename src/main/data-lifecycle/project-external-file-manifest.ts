import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type {
  ProjectAggregateArtifactSourceFile,
  ProjectAggregateExportBundle,
  ProjectAggregateExternalFileManifest,
  ProjectAggregatePortableRuntime,
  ProjectAggregateSnapshot
} from '../../shared/project-aggregate-types'
import type { ProjectResource } from '../../shared/project-workspace-types'
import type { ArtifactLifecycleRecord } from '../task/artifact-lifecycle-types'

const MAX_SKILL_BYTES = 4 * 1024 * 1024
const MAX_SKILL_FILES = 1_000
const MAX_SKILL_ENTRIES = 10_000
const SHA256 = /^sha256:[a-f0-9]{64}$/

export async function collectProjectExternalFileManifests(
  aggregate: ProjectAggregateSnapshot,
  lifecycles: readonly ArtifactLifecycleRecord[]
): Promise<ProjectAggregateExternalFileManifest[]> {
  const records = [
    ...officeArtifactManifests(aggregate, lifecycles),
    ...await learningSkillManifests(aggregate.resources)
  ]
  return records.sort(byIdentity)
}

export function validateProjectExternalFileManifests(
  bundle: Pick<ProjectAggregateExportBundle, 'aggregate'>,
  runtime: ProjectAggregatePortableRuntime
): ProjectAggregateExternalFileManifest[] {
  if (runtime.externalFiles === undefined) return []
  if (!Array.isArray(runtime.externalFiles)) throw new Error('Project import external file manifest is invalid')
  const resources = new Map(bundle.aggregate.resources.map((resource) => [resource.id, resource]))
  const artifacts = new Set(bundle.aggregate.workflow.artifacts.map((artifact) => artifact.id))
  const sources = new Map((runtime.artifactSourceFiles ?? []).map((source) => [source.artifactId, source]))
  const records = new Map<string, ProjectAggregateExternalFileManifest>()
  for (const value of runtime.externalFiles) {
    const record = requireManifest(value)
    const key = manifestIdentity(record)
    if (records.has(key)) throw new Error(`Project import contains duplicate external file manifest: ${key}`)
    if (record.kind === 'learning_skill') assertLearningSkillManifest(record, resources)
    else assertOfficeArtifactManifest(record, artifacts, sources)
    records.set(key, record)
  }
  assertOfficeManifestClosure(bundle.aggregate, records)
  return [...records.values()].sort(byIdentity)
}

function officeArtifactManifests(
  aggregate: ProjectAggregateSnapshot,
  lifecycles: readonly ArtifactLifecycleRecord[]
): ProjectAggregateExternalFileManifest[] {
  const lifecycleByArtifact = new Map(lifecycles.map((record) => [record.artifactId, record]))
  return aggregate.workflow.artifacts.filter(isOfficeArtifact).map((artifact) => {
    const lifecycle = lifecycleByArtifact.get(artifact.id)
    if (!lifecycle || lifecycle.storageKind !== 'source_ref' || !lifecycle.sourceRef) {
      throw new Error(`Project Office artifact lacks its canonical source reference: ${artifact.id}`)
    }
    return {
      kind: 'office_artifact',
      ownerId: lifecycle.artifactId,
      relativePath: safeOfficeRelativePath(lifecycle),
      digest: lifecycle.digest,
      sizeBytes: lifecycle.sizeBytes,
      content: 'artifact_source_bytes'
    }
  })
}

function isOfficeArtifact(value: unknown): value is ProjectAggregateSnapshot['workflow']['artifacts'][number] {
  return isRecord(value) && isRecord(value.metadata) && value.metadata.producer === 'office_delivery'
}

function safeOfficeRelativePath(record: ArtifactLifecycleRecord): string {
  const extension = typeof record.sourceRef === 'string' ? record.sourceRef.match(/\.[a-zA-Z0-9]{1,16}$/)?.[0] : undefined
  return normalizeRelativePath(`office-output/${encodeURIComponent(record.artifactId)}${extension?.toLowerCase() ?? ''}`)
}

async function learningSkillManifests(resources: readonly ProjectResource[]): Promise<ProjectAggregateExternalFileManifest[]> {
  const records: ProjectAggregateExternalFileManifest[] = []
  for (const resource of resources.filter(isDirectoryResource).sort((left, right) => left.id.localeCompare(right.id))) {
    const root = resolve(resource.path as string)
    const resourceState = await optionalLstat(root)
    if (!resourceState || resourceState.isSymbolicLink() || !resourceState.isDirectory()) {
      throw new Error(`Project Resource root must be a real directory: ${resource.id}`)
    }
    const canonicalRoot = await realpath(root)
    const skillRoot = join(canonicalRoot, '.caogen', 'skills')
    const rootState = await optionalLstat(skillRoot)
    if (!rootState) continue
    if (rootState.isSymbolicLink() || !rootState.isDirectory()) {
      throw new Error(`Project Skill root must be a real directory: ${resource.id}`)
    }
    const canonicalSkillRoot = await realpath(skillRoot)
    assertInside(canonicalRoot, canonicalSkillRoot)
    for (const file of await skillFiles(canonicalSkillRoot)) {
      const { canonicalPath, bytes } = await readStableSkillFile(canonicalSkillRoot, file)
      const relativePath = normalizeRelativePath(relative(canonicalRoot, canonicalPath).replaceAll('\\', '/'))
      records.push({
        kind: 'learning_skill',
        ownerId: resource.id,
        resourceId: resource.id,
        relativePath,
        digest: sha256(bytes),
        sizeBytes: bytes.byteLength,
        content: 'external_manifest_only'
      })
    }
  }
  return records
}

async function skillFiles(root: string): Promise<string[]> {
  const pending = [root]
  const files: string[] = []
  let entries = 0
  while (pending.length > 0) {
    const directory = pending.pop() as string
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entries += 1
      if (entries > MAX_SKILL_ENTRIES) throw new Error('Project Skill manifest exceeds its entry limit')
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Project Skill manifest rejects symlink: ${path}`)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile() && entry.name === 'SKILL.md') {
        const state = await lstat(path)
        if (!state.isFile() || state.isSymbolicLink() || state.size <= 0 || state.size > MAX_SKILL_BYTES) {
          throw new Error(`Project Skill file size is invalid: ${path}`)
        }
        const canonicalPath = await realpath(path)
        assertInside(root, canonicalPath)
        files.push(canonicalPath)
        if (files.length > MAX_SKILL_FILES) throw new Error('Project Skill manifest exceeds its file limit')
      }
    }
  }
  return files.sort()
}

async function readStableSkillFile(
  root: string,
  file: string
): Promise<{ canonicalPath: string; bytes: Buffer }> {
  const canonicalPath = await realpath(file)
  assertInside(root, canonicalPath)
  const before = await lstat(canonicalPath)
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > MAX_SKILL_BYTES) {
    throw new Error(`Project Skill file is not a bounded regular file: ${file}`)
  }
  const bytes = await readFile(canonicalPath)
  const [after, currentPath] = await Promise.all([lstat(canonicalPath), realpath(file)])
  if (!after.isFile() || after.isSymbolicLink() || currentPath !== canonicalPath ||
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      bytes.byteLength !== after.size) {
    throw new Error(`Project Skill file changed while being inventoried: ${file}`)
  }
  return { canonicalPath, bytes }
}

function requireManifest(value: unknown): ProjectAggregateExternalFileManifest {
  if (!isRecord(value)) invalidManifest()
  assertManifestIdentity(value)
  assertManifestPath(value)
  assertManifestContent(value)
  return value as unknown as ProjectAggregateExternalFileManifest
}

function assertManifestIdentity(value: Record<string, unknown>): void {
  if ((value.kind !== 'learning_skill' && value.kind !== 'office_artifact') ||
      typeof value.ownerId !== 'string' || !value.ownerId.trim() ||
      (value.resourceId !== undefined && (typeof value.resourceId !== 'string' || !value.resourceId.trim()))) {
    invalidManifest()
  }
}

function assertManifestPath(value: Record<string, unknown>): void {
  if (typeof value.relativePath !== 'string' || normalizeRelativePath(value.relativePath) !== value.relativePath ||
      typeof value.digest !== 'string' || !SHA256.test(value.digest)) {
    invalidManifest()
  }
}

function assertManifestContent(value: Record<string, unknown>): void {
  if (!Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) <= 0 ||
      (value.content !== 'external_manifest_only' && value.content !== 'artifact_source_bytes')) {
    invalidManifest()
  }
}

function invalidManifest(): never {
  throw new Error('Project import external file manifest entry is invalid')
}

function assertLearningSkillManifest(
  record: ProjectAggregateExternalFileManifest,
  resources: ReadonlyMap<string, ProjectResource>
): void {
  const resource = record.resourceId ? resources.get(record.resourceId) : undefined
  if (!resource || record.ownerId !== resource.id || !isDirectoryResource(resource) ||
      record.content !== 'external_manifest_only' ||
      !record.relativePath.startsWith('.caogen/skills/') || !record.relativePath.endsWith('/SKILL.md')) {
    throw new Error(`Project import Learning Skill manifest crosses Resource ownership: ${record.ownerId}`)
  }
}

function assertOfficeArtifactManifest(
  record: ProjectAggregateExternalFileManifest,
  artifactIds: ReadonlySet<string>,
  sources: ReadonlyMap<string, ProjectAggregateArtifactSourceFile>
): void {
  const source = sources.get(record.ownerId)
  if (!artifactIds.has(record.ownerId) || record.resourceId !== undefined ||
      record.content !== 'artifact_source_bytes' || !record.relativePath.startsWith('office-output/') ||
      !source || source.digest !== record.digest || source.sizeBytes !== record.sizeBytes) {
    throw new Error(`Project import Office artifact manifest crosses Artifact ownership: ${record.ownerId}`)
  }
}

function assertOfficeManifestClosure(
  aggregate: ProjectAggregateSnapshot,
  records: ReadonlyMap<string, ProjectAggregateExternalFileManifest>
): void {
  const expected = aggregate.workflow.artifacts.filter(isOfficeArtifact)
    .map((artifact) => `office_artifact:${artifact.id}`)
    .sort()
  const actual = [...records.values()].filter((record) => record.kind === 'office_artifact')
    .map((record) => `office_artifact:${record.ownerId}`)
    .sort()
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error('Project import Office artifact manifest closure is incomplete')
  }
}

function isDirectoryResource(resource: ProjectResource): boolean {
  return (resource.kind === 'directory' || resource.kind === 'repository') &&
    typeof resource.path === 'string' && isAbsolute(resource.path)
}

function normalizeRelativePath(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/')
  if (!normalized || normalized.length > 1_024 || normalized.startsWith('/') || normalized.includes('\0') ||
      normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Project external file relative path is invalid')
  }
  return normalized
}

function manifestIdentity(record: ProjectAggregateExternalFileManifest): string {
  return `${record.kind}:${record.ownerId}:${record.relativePath}`
}

function byIdentity(left: ProjectAggregateExternalFileManifest, right: ProjectAggregateExternalFileManifest): number {
  return manifestIdentity(left).localeCompare(manifestIdentity(right))
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function optionalLstat(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function assertInside(root: string, target: string): void {
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error('Project external file escapes its Resource root')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
