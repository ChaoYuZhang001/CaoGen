import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { writeDurableFile } from '../durable-file'

export type MemoryLayer = 'working' | 'project' | 'user'

export interface LayeredMemoryEntry {
  id: string
  revision: number
  layer: MemoryLayer
  projectHash?: string
  title: string
  body: string
  source: string
  tags: string[]
  createdAt: string
  updatedAt: string
  lastUsedAt: string
  archivedAt?: string
  vector: Record<string, number>
}

export interface MemoryWriteInput {
  id?: string
  layer: MemoryLayer
  projectRoot?: string
  title: string
  body: string
  source: string
  tags?: string[]
}

export interface MemoryUpdateInput {
  expectedRevision?: number
  title?: string
  body?: string
  tags?: string[]
  archivedAt?: string | null
}

export interface MemorySearchInput {
  query: string
  projectRoot?: string
  layers?: MemoryLayer[]
  includeArchived?: boolean
  limit?: number
}

export interface MemorySearchHit {
  entry: LayeredMemoryEntry
  score: number
}

interface MemoryFile {
  version: 2
  revision: number
  entries: LayeredMemoryEntry[]
}

const STORE_FILE = 'memory-index.json'
const HASH_NAMESPACE = 'caogen-layered-memory-v1'
const memoryStoreWriteQueues = new Map<string, Promise<void>>()

export function memoryProjectHash(projectRoot: string): string {
  return createHash('sha256').update(`${HASH_NAMESPACE}\0${path.resolve(projectRoot)}`).digest('hex')
}

export async function addMemory(rootDir: string, input: MemoryWriteInput): Promise<LayeredMemoryEntry> {
  return mutateStore(rootDir, (file) => {
    const id = input.id === undefined ? randomUUID() : requireText(input.id, 'id')
    const existing = file.entries.find((entry) => entry.id === id)
    const entry = normalizeCreatedMemory(input, id, existing)
    if (existing) {
      if (isDeepStrictEqual(existing, entry)) return { result: existing, changed: false }
      throw new Error(`Memory entry already exists with different content: ${id}`)
    }
    file.entries.push(entry)
    return { result: entry, changed: true }
  })
}

export async function searchMemories(rootDir: string, input: MemorySearchInput): Promise<MemorySearchHit[]> {
  const file = await readStore(rootDir)
  const queryVector = vectorize(input.query)
  const layers = new Set(input.layers ?? ['working', 'project', 'user'])
  const projectHash = input.projectRoot ? memoryProjectHash(input.projectRoot) : undefined
  const limit = clampLimit(input.limit)
  const hits = file.entries
    .filter((entry) => layers.has(entry.layer))
    .filter((entry) => input.includeArchived || !entry.archivedAt)
    .filter((entry) => entry.layer === 'user' || !projectHash || entry.projectHash === projectHash)
    .map((entry) => ({ entry, score: cosine(queryVector, entry.vector) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
    .slice(0, limit)

  if (hits.length > 0) await touchMemories(rootDir, hits.map((hit) => hit.entry.id))
  return hits
}

export async function listMemories(rootDir: string): Promise<LayeredMemoryEntry[]> {
  return (await readStore(rootDir)).entries
}

export async function deleteMemory(rootDir: string, entryId: string, expectedRevision?: number): Promise<boolean> {
  return mutateStore(rootDir, (file) => {
    const entry = file.entries.find((candidate) => candidate.id === entryId)
    if (!entry) return { result: false, changed: false }
    assertExpectedRevision(entry, expectedRevision)
    file.entries = file.entries.filter((candidate) => candidate.id !== entryId)
    return { result: true, changed: true }
  })
}

export async function updateMemory(
  rootDir: string,
  entryId: string,
  patch: MemoryUpdateInput
): Promise<LayeredMemoryEntry | null> {
  return mutateStore(rootDir, (file) => {
    const index = file.entries.findIndex((entry) => entry.id === entryId)
    if (index === -1) return { result: null, changed: false }
    const current = file.entries[index]
    assertExpectedRevision(current, patch.expectedRevision)
    const next = updatedMemory(current, patch)
    file.entries[index] = next
    return { result: next, changed: true }
  })
}

export async function archiveStaleMemories(rootDir: string, olderThanDays = 90, now = Date.now()): Promise<number> {
  const cutoff = now - olderThanDays * 24 * 60 * 60 * 1000
  return mutateStore(rootDir, (file) => {
    let archived = 0
    file.entries = file.entries.map((entry) => {
      if (entry.archivedAt) return entry
      const lastUsed = Date.parse(entry.lastUsedAt)
      if (!Number.isFinite(lastUsed) || lastUsed >= cutoff) return entry
      archived++
      return { ...entry, revision: entry.revision + 1, archivedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }
    })
    return { result: archived, changed: archived > 0 }
  })
}

export async function exportMemories(rootDir: string): Promise<string> {
  return JSON.stringify(await readStore(rootDir), null, 2)
}

async function touchMemories(rootDir: string, ids: string[]): Promise<void> {
  const wanted = new Set(ids)
  await mutateStore(rootDir, (file) => {
    const now = new Date().toISOString()
    let touched = 0
    file.entries = file.entries.map((entry) => {
      if (!wanted.has(entry.id)) return entry
      touched++
      return { ...entry, revision: entry.revision + 1, lastUsedAt: now }
    })
    return { result: undefined, changed: touched > 0 }
  })
}

async function readStore(rootDir: string): Promise<MemoryFile> {
  const filePath = storePath(rootDir)
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return normalizeStore(parsed)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, revision: 0, entries: [] }
    throw new Error(`Memory store is unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function writeStore(rootDir: string, file: MemoryFile): Promise<void> {
  await writeDurableFile(storePath(rootDir), `${JSON.stringify(file, null, 2)}\n`)
}

function normalizeStore(value: unknown): MemoryFile {
  if (!isRecord(value) || !Array.isArray(value.entries) || (value.version !== 1 && value.version !== 2)) {
    throw new Error('Memory store schema is unsupported')
  }
  if (!value.entries.every(isMemoryEntry)) throw new Error('Memory store contains an invalid entry')
  return {
    version: 2,
    revision: value.version === 2 ? normalizeStoreRevision(value.revision) : 0,
    entries: value.entries.map((entry) => ({ ...entry, revision: normalizeEntryRevision(entry.revision) }))
  }
}

function isMemoryEntry(value: unknown): value is Omit<LayeredMemoryEntry, 'revision'> & { revision?: number } {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    (value.layer === 'working' || value.layer === 'project' || value.layer === 'user') &&
    typeof value.title === 'string' &&
    typeof value.body === 'string' &&
    typeof value.source === 'string' &&
    (value.revision === undefined || isPositiveInteger(value.revision)) &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === 'string') &&
    isRecord(value.vector)
  )
}

async function mutateStore<T>(
  rootDir: string,
  operation: (file: MemoryFile) => { result: T; changed: boolean }
): Promise<T> {
  return withMemoryStoreWriteLock(rootDir, async () => {
    const file = await readStore(rootDir)
    const mutation = operation(file)
    if (mutation.changed) {
      file.revision += 1
      await writeStore(rootDir, file)
    }
    return mutation.result
  })
}

async function withMemoryStoreWriteLock<T>(rootDir: string, operation: () => Promise<T>): Promise<T> {
  const key = storePath(rootDir)
  const previous = memoryStoreWriteQueues.get(key) ?? Promise.resolve()
  let value!: T
  const operationPromise = previous.catch(() => undefined).then(async () => { value = await operation() })
  const tail = operationPromise.then(() => undefined, () => undefined)
  memoryStoreWriteQueues.set(key, tail)
  try {
    await operationPromise
    return value
  } finally {
    if (memoryStoreWriteQueues.get(key) === tail) memoryStoreWriteQueues.delete(key)
  }
}

function normalizeCreatedMemory(input: MemoryWriteInput, id: string, existing?: LayeredMemoryEntry): LayeredMemoryEntry {
  const now = existing?.createdAt ?? new Date().toISOString()
  const title = requireText(input.title, 'title')
  const body = requireText(input.body, 'body')
  const tags = normalizeTags(input.tags ?? [])
  return {
    id,
    revision: 1,
    layer: input.layer,
    ...(input.projectRoot ? { projectHash: memoryProjectHash(input.projectRoot) } : {}),
    title,
    body,
    source: requireText(input.source, 'source'),
    tags,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
    vector: vectorize(`${title}\n${body}\n${tags.join(' ')}`)
  }
}

function updatedMemory(current: LayeredMemoryEntry, patch: MemoryUpdateInput): LayeredMemoryEntry {
  const title = patch.title === undefined ? current.title : requireText(patch.title, 'title')
  const body = patch.body === undefined ? current.body : requireText(patch.body, 'body')
  const tags = patch.tags === undefined ? current.tags : normalizeTags(patch.tags)
  const next: LayeredMemoryEntry = {
    ...current,
    revision: current.revision + 1,
    title,
    body,
    tags,
    updatedAt: new Date().toISOString(),
    vector: vectorize(`${title}\n${body}\n${tags.join(' ')}`)
  }
  if (patch.archivedAt !== undefined) {
    if (patch.archivedAt === null || patch.archivedAt.trim() === '') delete next.archivedAt
    else next.archivedAt = patch.archivedAt
  }
  return next
}

function assertExpectedRevision(entry: LayeredMemoryEntry, value: unknown): void {
  if (value === undefined || value === null) return
  if (!isPositiveInteger(value)) throw new Error('expectedRevision 必须是正整数')
  if (value !== entry.revision) throw new Error(`Memory revision conflict: expected ${value}, got ${entry.revision}`)
}

function normalizeEntryRevision(value: unknown): number {
  return isPositiveInteger(value) ? value : 1
}

function normalizeStoreRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Memory store revision is invalid')
  return value
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

export function vectorize(text: string): Record<string, number> {
  const tokens = tokenize(text)
  const vector: Record<string, number> = {}
  for (const token of tokens) vector[token] = (vector[token] ?? 0) + 1
  const length = Math.sqrt(Object.values(vector).reduce((sum, value) => sum + value * value, 0)) || 1
  for (const key of Object.keys(vector)) vector[key] = Number((vector[key] / length).toFixed(6))
  return vector
}

function normalizeTags(value: string[]): string[] {
  if (!Array.isArray(value)) throw new Error('tags 必须是字符串数组')
  return [...new Set(value.map((tag) => requireText(tag, 'tag')).filter(Boolean))].slice(0, 20)
}

export function cosine(left: Record<string, number>, right: Record<string, number>): number {
  let score = 0
  const keys = Object.keys(left)
  for (const key of keys) score += (left[key] ?? 0) * (right[key] ?? 0)
  return Number(score.toFixed(6))
}

function tokenize(value: string): string[] {
  const normalized = value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  if (!normalized) return []
  const words = normalized.split(/\s+/).filter((token) => token.length > 1)
  const chinese = Array.from(normalized.matchAll(/[\u4e00-\u9fa5]{2,}/g)).flatMap((match) => {
    const text = match[0]
    const out: string[] = []
    for (let size = 2; size <= 4; size++) {
      for (let i = 0; i + size <= text.length; i++) out.push(text.slice(i, i + size))
    }
    return out
  })
  return [...words, ...chinese]
}

function storePath(rootDir: string): string {
  return path.join(path.resolve(requireText(rootDir, 'rootDir')), STORE_FILE)
}

function requireText(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 不能为空`)
  if (value.includes('\0')) throw new Error(`${field} 包含非法字符`)
  return value.trim()
}

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) return 8
  return Math.max(1, Math.min(50, Math.floor(value)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
