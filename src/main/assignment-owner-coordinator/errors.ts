export type AssignmentOwnerCoordinatorErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'PROJECT_SCOPE_CONFLICT'
  | 'REVISION_CONFLICT'
  | 'REQUEST_CONFLICT'
  | 'INVARIANT_VIOLATION'
  | 'COMPENSATED'
  | 'RECOVERY_PENDING'
  | 'JOURNAL_CORRUPT'

export class AssignmentOwnerCoordinatorError extends Error {
  readonly code: AssignmentOwnerCoordinatorErrorCode
  readonly details?: Record<string, unknown>

  constructor(
    code: AssignmentOwnerCoordinatorErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'AssignmentOwnerCoordinatorError'
    this.code = code
    this.details = details
  }
}

export class AssignmentOwnerCrashSimulationError extends Error {
  readonly point: AssignmentOwnerCrashPoint
  readonly causeValue?: unknown

  constructor(point: AssignmentOwnerCrashPoint, causeValue?: unknown) {
    super(`simulated assignment-owner coordinator crash at ${point}`)
    this.name = 'AssignmentOwnerCrashSimulationError'
    this.point = point
    this.causeValue = causeValue
  }
}

export type AssignmentOwnerCrashPoint =
  | 'after_prepare'
  | 'after_assignment_write'
  | 'after_owner_write'
  | 'after_owner_clear'
  | 'after_assignment_release'
  | 'after_reassignment_write'
  | 'before_compensation'
