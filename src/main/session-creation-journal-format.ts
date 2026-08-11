export const SESSION_CREATION_JOURNAL_SCHEMA_VERSION = 1 as const
export const SESSION_CREATION_JOURNAL_FORMAT = 'caogen.session-creation-journal.v1' as const

export interface SessionCreationJournalDocument<T = unknown> {
  schemaVersion: typeof SESSION_CREATION_JOURNAL_SCHEMA_VERSION
  format: typeof SESSION_CREATION_JOURNAL_FORMAT
  records: T[]
}

export function sessionCreationJournalRecordsFromDocument<T>(
  value: unknown,
  source = 'session creation journal'
): T[] {
  if (Array.isArray(value)) return value as T[]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source} document is invalid`)
  }
  const document = value as Partial<SessionCreationJournalDocument<T>>
  if (document.schemaVersion !== SESSION_CREATION_JOURNAL_SCHEMA_VERSION ||
    document.format !== SESSION_CREATION_JOURNAL_FORMAT || !Array.isArray(document.records)) {
    throw new Error(`${source} schema version is unsupported`)
  }
  return document.records
}

export function sessionCreationJournalDocument<T>(
  records: readonly T[]
): SessionCreationJournalDocument<T> {
  return {
    schemaVersion: SESSION_CREATION_JOURNAL_SCHEMA_VERSION,
    format: SESSION_CREATION_JOURNAL_FORMAT,
    records: [...records]
  }
}
