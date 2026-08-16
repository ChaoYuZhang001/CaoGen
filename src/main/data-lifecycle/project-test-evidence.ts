import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const EVIDENCE_KIND = 'caogen-project-test-evidence'
const EVIDENCE_SCHEMA_VERSION = 2
const MAX_EVIDENCE_BYTES = 256 * 1024

export interface ProjectTestEvidenceOwnership {
  evidenceId: string
  workspaceDigest: string
  sessionId: string
  projectId?: string
}

export function collectOwnedProjectTestEvidencePaths(
  rootDir: string,
  projectId: string,
  sessionIds: ReadonlySet<string>
): string[] {
  const root = resolve(rootDir)
  const project = requiredId(projectId, 'projectId')
  return evidenceFiles(root).filter((file) => {
    const owner = readOwnership(file)
    if (owner) assertEvidencePath(relative(root, file).replaceAll('\\', '/'), owner)
    return owner ? belongsToProject(owner, project, sessionIds) : false
  })
}

export function assertPortableProjectTestEvidence(
  portablePath: string,
  bytes: Uint8Array,
  projectId: string,
  sessionIds: ReadonlySet<string>
): void {
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_EVIDENCE_BYTES) {
    throw new Error(`Project import test evidence size is invalid: ${portablePath}`)
  }
  const owner = parseOwnership(Buffer.from(bytes), portablePath)
  if (!owner || !belongsToProject(owner, requiredId(projectId, 'projectId'), sessionIds)) {
    throw new Error(`Project import test evidence crosses Project ownership: ${portablePath}`)
  }
  assertEvidencePath(portablePath, owner)
}

export function purgeOwnedProjectTestEvidence(
  rootDir: string,
  projectId: string,
  sessionIds: ReadonlySet<string>
): string[] {
  const root = resolve(rootDir)
  const files = collectOwnedProjectTestEvidencePaths(root, projectId, sessionIds)
  const removed: string[] = []
  for (const file of files) {
    rmSync(file, { force: true })
    removed.push(relative(root, file).replaceAll('\\', '/'))
    removeEmptyDirectory(dirname(file), join(root, 'project-test-evidence'))
  }
  removeEmptyDirectory(join(root, 'project-test-evidence'), root)
  return removed.sort()
}

export function countOwnedProjectTestEvidence(
  rootDir: string,
  projectId: string,
  sessionIds: ReadonlySet<string>
): number {
  return collectOwnedProjectTestEvidencePaths(rootDir, projectId, sessionIds).length
}

function evidenceFiles(root: string): string[] {
  const base = join(root, 'project-test-evidence')
  if (!existsSync(base)) return []
  assertDirectory(base, 'Project test evidence root')
  const files: string[] = []
  for (const directory of readdirSync(base, { withFileTypes: true })) {
    if (!directory.isDirectory() || !/^[a-f0-9]{24}$/.test(directory.name)) continue
    const child = join(base, directory.name)
    assertDirectory(child, 'Project test evidence workspace')
    for (const entry of readdirSync(child, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const file = join(child, entry.name)
      const info = lstatSync(file)
      if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_EVIDENCE_BYTES) {
        throw new Error(`Project test evidence file is invalid: ${file}`)
      }
      files.push(file)
    }
  }
  return files.sort()
}

function readOwnership(file: string): ProjectTestEvidenceOwnership | undefined {
  return parseOwnership(readFileSync(file), file)
}

function parseOwnership(bytes: Uint8Array, label: string): ProjectTestEvidenceOwnership | undefined {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    throw new Error(`Project test evidence JSON is invalid: ${label}`)
  }
  if (!isRecord(value) || value.kind !== EVIDENCE_KIND) return undefined
  if (value.schemaVersion === 1) return undefined
  if (value.schemaVersion !== EVIDENCE_SCHEMA_VERSION ||
      !validId(value.evidenceId) || !validId(value.sessionId) ||
      typeof value.workspaceDigest !== 'string' || !/^[a-f0-9]{24}$/.test(value.workspaceDigest) ||
      (value.projectId !== undefined && !validId(value.projectId))) {
    throw new Error(`Project test evidence owner is invalid: ${label}`)
  }
  return {
    evidenceId: value.evidenceId,
    workspaceDigest: value.workspaceDigest,
    sessionId: value.sessionId,
    ...(typeof value.projectId === 'string' ? { projectId: value.projectId } : {})
  }
}

function belongsToProject(
  owner: ProjectTestEvidenceOwnership,
  projectId: string,
  sessionIds: ReadonlySet<string>
): boolean {
  if (owner.projectId !== undefined && owner.projectId !== projectId) return false
  return owner.projectId === projectId || sessionIds.has(owner.sessionId)
}

function assertEvidencePath(path: string, owner: ProjectTestEvidenceOwnership): void {
  const expected = `project-test-evidence/${owner.workspaceDigest}/${owner.evidenceId}.json`
  if (path !== expected) throw new Error(`Project test evidence path is invalid: ${path}`)
}

function assertDirectory(path: string, label: string): void {
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} is invalid`)
}

function removeEmptyDirectory(directory: string, boundary: string): void {
  if (resolve(directory) === resolve(boundary) || !existsSync(directory)) return
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || readdirSync(directory).length > 0) return
  rmdirSync(directory)
}

function requiredId(value: unknown, label: string): string {
  if (!validId(value)) throw new Error(`${label} is required`)
  return value.trim()
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 512 && !/[\0-\x1f\x7f]/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
