import type { JsonObject } from '../../shared/digital-worker-types'

/** Stable error codes let IPC/runtime callers fail closed without string matching. */
export type DigitalWorkerErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'REVISION_CONFLICT'
  | 'PROJECT_SCOPE_CONFLICT'
  | 'POLICY_DENIED'
  | 'LEASE_CONFLICT'
  | 'STALE_FENCE'
  | 'STORE_LOCKED'
  | 'SCHEMA_UNSUPPORTED'
  | 'STORE_CORRUPT'
  | 'IMMUTABLE_HISTORY'

export class DigitalWorkerStoreError extends Error {
  readonly code: DigitalWorkerErrorCode
  readonly details?: JsonObject

  constructor(code: DigitalWorkerErrorCode, message: string, details?: JsonObject) {
    super(message)
    this.name = 'DigitalWorkerStoreError'
    this.code = code
    this.details = details
  }
}

export class DigitalWorkerValidationError extends DigitalWorkerStoreError {
  constructor(message: string, details?: JsonObject) {
    super('VALIDATION_ERROR', message, details)
    this.name = 'DigitalWorkerValidationError'
  }
}

export class DigitalWorkerConflictError extends DigitalWorkerStoreError {
  constructor(message: string, details?: JsonObject, code: DigitalWorkerErrorCode = 'CONFLICT') {
    super(code, message, details)
    this.name = 'DigitalWorkerConflictError'
  }
}

export class DigitalWorkerPersistenceError extends DigitalWorkerStoreError {
  constructor(message: string, details?: JsonObject, code: DigitalWorkerErrorCode = 'STORE_CORRUPT') {
    super(code, message, details)
    this.name = 'DigitalWorkerPersistenceError'
  }
}

export function notFound(message: string): DigitalWorkerStoreError {
  return new DigitalWorkerStoreError('NOT_FOUND', message)
}
