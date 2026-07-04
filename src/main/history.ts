import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { HistoryEntry } from '../shared/types'

const MAX_ENTRIES = 100

let cache: HistoryEntry[] | null = null

function historyFile(): string {
  return join(app.getPath('userData'), 'sessions.json')
}

export function listHistory(): HistoryEntry[] {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(historyFile(), 'utf8'))
    cache = Array.isArray(raw) ? (raw as HistoryEntry[]) : []
  } catch {
    cache = []
  }
  return cache
}

function persist(): void {
  try {
    mkdirSync(dirname(historyFile()), { recursive: true })
    writeFileSync(historyFile(), JSON.stringify(cache ?? [], null, 2))
  } catch (err) {
    console.error('[agent-desk] 保存会话历史失败:', err)
  }
}

function truncate(list: HistoryEntry[]): HistoryEntry[] {
  if (list.length <= MAX_ENTRIES) return list
  const kept: HistoryEntry[] = []
  const normal: HistoryEntry[] = []
  for (const entry of list) {
    if (entry.pinned || entry.archived) kept.push(entry)
    else normal.push(entry)
  }
  return [...kept, ...normal].slice(0, Math.max(MAX_ENTRIES, kept.length))
}

export function upsertHistory(entry: HistoryEntry): void {
  const prev = listHistory().find((e) => e.id === entry.id || e.sdkSessionId === entry.sdkSessionId)
  // 恢复的会话是新 id + 同一 sdkSessionId,两个维度都要去重,否则同一对话反复出现
  const list = listHistory().filter(
    (e) => e.id !== entry.id && e.sdkSessionId !== entry.sdkSessionId
  )
  list.unshift({ ...entry, archived: entry.archived ?? prev?.archived, pinned: entry.pinned ?? prev?.pinned })
  cache = truncate(list)
  persist()
}

export function setHistoryArchived(id: string, archived: boolean): void {
  const item = listHistory().find((entry) => entry.id === id)
  if (!item) return
  item.archived = archived
  persist()
}

export function setHistoryPinned(id: string, pinned: boolean): void {
  const item = listHistory().find((entry) => entry.id === id)
  if (!item) return
  item.pinned = pinned
  persist()
}

export function renameHistory(id: string, title: string): void {
  const item = listHistory().find((entry) => entry.id === id)
  const nextTitle = title.trim()
  if (!item || !nextTitle) return
  item.title = nextTitle
  persist()
}

export function deleteHistory(id: string): void {
  cache = listHistory().filter((entry) => entry.id !== id)
  persist()
}
