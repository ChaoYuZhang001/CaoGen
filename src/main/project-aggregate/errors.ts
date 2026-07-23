export type ProjectAggregateErrorCode =
  | 'INVALID_INPUT'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_NOT_SEALED'
  | 'PROJECT_SCOPE_CONFLICT'
  | 'REVISION_CONFLICT'
  | 'AGGREGATE_INTEGRITY_FAILED'
  | 'STORE_CORRUPT'
  | 'STORE_LOCKED'

export class ProjectAggregateError extends Error {
  readonly code: ProjectAggregateErrorCode
  readonly details?: Record<string, unknown>

  constructor(
    code: ProjectAggregateErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'ProjectAggregateError'
    this.code = code
    this.details = details
  }
}

export function aggregateIntegrityError(
  message: string,
  details?: Record<string, unknown>
): ProjectAggregateError {
  return new ProjectAggregateError('AGGREGATE_INTEGRITY_FAILED', message, details)
}

export function requiredProjectId(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new ProjectAggregateError('INVALID_INPUT', 'projectId is required')
  }
  return value.trim()
}

export function requiredObjectId(value: string, label = 'object id'): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new ProjectAggregateError('INVALID_INPUT', `${label} is required`)
  }
  return value.trim()
}
