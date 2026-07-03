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

export function upsertHistory(entry: HistoryEntry): void {
  const list = listHistory().filter((e) => e.id !== entry.id)
  list.unshift(entry)
  cache = list.slice(0, MAX_ENTRIES)
  try {
    mkdirSync(dirname(historyFile()), { recursive: true })
    writeFileSync(historyFile(), JSON.stringify(cache, null, 2))
  } catch (err) {
    console.error('[agent-desk] 保存会话历史失败:', err)
  }
}
