export const HISTORY_STORE_SCHEMA_VERSION = 1

export interface HistoryStoreDocument<T = unknown> {
  schemaVersion: 1
  entries: T[]
}

export class HistoryStoreFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HistoryStoreFormatError'
  }
}

export function historyEntriesFromDocument<T>(value: unknown, source = 'History Store'): T[] {
  if (Array.isArray(value)) return value as T[]
  if (!isRecord(value) || !('schemaVersion' in value)) {
    throw new HistoryStoreFormatError(`${source} document is invalid`)
  }
  if (value.schemaVersion !== HISTORY_STORE_SCHEMA_VERSION) {
    throw new HistoryStoreFormatError(
      `Unsupported History Store schema version: ${String(value.schemaVersion)}`
    )
  }
  if (!Array.isArray(value.entries)) {
    throw new HistoryStoreFormatError(`${source} entries are invalid`)
  }
  return value.entries as T[]
}

export function historyStoreDocument<T>(entries: readonly T[]): HistoryStoreDocument<T> {
  return {
    schemaVersion: HISTORY_STORE_SCHEMA_VERSION,
    entries: [...entries]
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
