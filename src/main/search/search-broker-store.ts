import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeDurableFile } from '../durable-file'
import type { SearchBrokerResult, SearchBrokerIdempotencyStore } from './search-broker'

export function createDurableSearchStore(rootDir: string, projectId: string): SearchBrokerIdempotencyStore {
  const filePath = join(rootDir, 'search-broker', createHash('sha256').update(projectId).digest('hex'), 'operations.json')
  let loaded = false
  let entries: Record<string, SearchBrokerResult> = {}
  const load = (): void => {
    if (loaded) return
    loaded = true
    if (!existsSync(filePath)) return
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) entries = parsed as Record<string, SearchBrokerResult>
    } catch {
      entries = {}
    }
  }
  return {
    get(operationId: string): SearchBrokerResult | undefined {
      load()
      return entries[operationId]
    },
    async put(operationId: string, result: SearchBrokerResult): Promise<void> {
      load()
      entries[operationId] = result
      await writeDurableFile(filePath, `${JSON.stringify(entries)}\n`, { mode: 0o600 })
    }
  }
}
