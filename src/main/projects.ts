import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { Project, ProjectUpdate } from '../shared/types'

const MAX_PROJECTS = 50
const PROJECT_STORE_SCHEMA_VERSION = 1

interface ProjectStoreDocument {
  schemaVersion: 1
  projects: Project[]
}

let cache: Project[] | null = null

function projectsFile(): string {
  return join(app.getPath('userData'), 'projects.json')
}

function load(): Project[] {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(projectsFile(), 'utf8')) as unknown
    if (Array.isArray(raw)) cache = raw as Project[]
    else if (isProjectStoreDocument(raw)) cache = raw.projects
    else if (isVersionedRecord(raw)) throw new UnsupportedProjectStoreSchemaError(raw.schemaVersion)
    else cache = []
  } catch (error) {
    if (error instanceof UnsupportedProjectStoreSchemaError) throw error
    cache = []
  }
  return cache
}

function persist(next: Project[]): void {
  const file = projectsFile()
  const directory = dirname(file)
  const temporary = join(directory, `.projects.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    mkdirSync(directory, { recursive: true })
    descriptor = openSync(temporary, 'wx', 0o600)
    const document: ProjectStoreDocument = {
      schemaVersion: PROJECT_STORE_SCHEMA_VERSION,
      projects: next
    }
    writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, file)
    syncProjectStoreDirectory(directory)
  } catch (err) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch { /* best effort */ }
    }
    if (existsSync(temporary)) {
      try { unlinkSync(temporary) } catch { /* canonical Project Store remains authoritative */ }
    }
    console.error('[caogen] 保存项目失败:', err)
    throw err
  }
  cache = next
}

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || p
}

/** 最近使用在前 */
export function listProjects(): Project[] {
  return [...load()].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

/** 建会话时自动收藏/更新项目目录 */
export function touchProject(path: string): Project {
  const list = load()
  const existing = list.find((p) => p.path === path)
  if (existing) {
    const updated = { ...existing, lastUsedAt: Date.now(), archived: false }
    persist(list.map((project) => project.id === existing.id ? updated : project))
    return updated
  } else {
    const project = { id: randomUUID(), name: baseName(path), path, lastUsedAt: Date.now() }
    persist([...list, project].slice(-MAX_PROJECTS))
    return project
  }
}

export function getProject(id: string): Project | undefined {
  return load().find((project) => project.id === id)
}

export function updateProject(id: string, patch: ProjectUpdate): Project | null {
  const list = load()
  const proj = list.find((p) => p.id === id)
  if (!proj) return null
  const updated = {
    ...proj,
    ...(patch.name !== undefined ? { name: patch.name.trim() || baseName(proj.path) } : {}),
    ...(patch.archived !== undefined ? { archived: patch.archived } : {})
  }
  persist(list.map((project) => project.id === id ? updated : project))
  return updated
}

export function deleteProject(id: string): void {
  persist(load().filter((project) => project.id !== id))
}

class UnsupportedProjectStoreSchemaError extends Error {
  constructor(version: unknown) {
    super(`Unsupported Project Store schema version: ${String(version)}`)
    this.name = 'UnsupportedProjectStoreSchemaError'
  }
}

function isProjectStoreDocument(value: unknown): value is ProjectStoreDocument {
  return isVersionedRecord(value) &&
    value.schemaVersion === PROJECT_STORE_SCHEMA_VERSION &&
    Array.isArray(value.projects)
}

function isVersionedRecord(value: unknown): value is Record<string, unknown> & { schemaVersion: unknown } {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && 'schemaVersion' in value
}

function syncProjectStoreDirectory(directory: string): void {
  if (process.platform === 'win32') return
  try {
    const descriptor = openSync(directory, 'r')
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
  } catch {
    // The file is fsynced; some filesystems reject directory fsync.
  }
}
