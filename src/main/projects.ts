import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Project } from '../shared/types'

const MAX_PROJECTS = 50

let cache: Project[] | null = null

function projectsFile(): string {
  return join(app.getPath('userData'), 'projects.json')
}

function load(): Project[] {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(projectsFile(), 'utf8'))
    cache = Array.isArray(raw) ? (raw as Project[]) : []
  } catch {
    cache = []
  }
  return cache
}

function persist(): void {
  try {
    mkdirSync(dirname(projectsFile()), { recursive: true })
    writeFileSync(projectsFile(), JSON.stringify(cache ?? [], null, 2))
  } catch (err) {
    console.error('[caogen] 保存项目失败:', err)
  }
}

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || p
}

/** 最近使用在前 */
export function listProjects(): Project[] {
  return [...load()].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

/** 建会话时自动收藏/更新项目目录 */
export function touchProject(path: string): void {
  if (!path) return
  const list = load()
  const existing = list.find((p) => p.path === path)
  if (existing) {
    existing.lastUsedAt = Date.now()
  } else {
    list.push({ id: randomUUID(), name: baseName(path), path, lastUsedAt: Date.now() })
  }
  cache = list.slice(-MAX_PROJECTS)
  persist()
}

export function updateProject(id: string, patch: { name?: string }): Project | null {
  const list = load()
  const proj = list.find((p) => p.id === id)
  if (!proj) return null
  if (patch.name !== undefined) proj.name = patch.name.trim() || baseName(proj.path)
  persist()
  return proj
}

export function deleteProject(id: string): void {
  cache = load().filter((p) => p.id !== id)
  persist()
}
