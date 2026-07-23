export class ProjectWorkspaceLedgerMigrationError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ProjectWorkspaceLedgerMigrationError'
    this.code = code
  }
}

export function migrationError(code: string, message: string): ProjectWorkspaceLedgerMigrationError {
  return new ProjectWorkspaceLedgerMigrationError(code, message)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function isId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

export function positiveRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function nonNegativeRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function finiteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function requiredId(value: unknown, label: string): string {
  if (!isId(value)) throw migrationError('INVALID_INPUT', `${label} is required`)
  return value.trim()
}

export function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
