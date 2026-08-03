export const ACTIVE_SESSION_REGISTRY_SCHEMA_VERSION = 1

export interface ActiveSessionRegistryDocument<T = unknown> {
  schemaVersion: 1
  sessions: T[]
}

export class ActiveSessionRegistryFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ActiveSessionRegistryFormatError'
  }
}

export function activeSessionRecordsFromDocument<T>(
  value: unknown,
  source = 'Active Session Registry'
): T[] {
  if (Array.isArray(value)) return value as T[]
  if (!isRecord(value) || !('schemaVersion' in value)) {
    throw new ActiveSessionRegistryFormatError(`${source} document is invalid`)
  }
  if (value.schemaVersion !== ACTIVE_SESSION_REGISTRY_SCHEMA_VERSION) {
    throw new ActiveSessionRegistryFormatError(
      `Unsupported Active Session Registry schema version: ${String(value.schemaVersion)}`
    )
  }
  if (!Array.isArray(value.sessions)) {
    throw new ActiveSessionRegistryFormatError(`${source} sessions are invalid`)
  }
  return value.sessions as T[]
}

export function activeSessionRegistryDocument<T>(
  sessions: readonly T[]
): ActiveSessionRegistryDocument<T> {
  return {
    schemaVersion: ACTIVE_SESSION_REGISTRY_SCHEMA_VERSION,
    sessions: [...sessions]
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
