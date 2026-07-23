import { resolve } from 'node:path'
import { AssignmentOwnerCoordinator } from './coordinator'
import { AssignmentOwnerCoordinatorError } from './errors'
import type { AssignmentOwnerRecoveryResult } from '../../shared/digital-worker-types'

interface AssignmentOwnerReadinessState {
  promise: Promise<AssignmentOwnerCoordinator>
}

const readinessByRoot = new Map<string, AssignmentOwnerReadinessState>()
const operationTailByRoot = new Map<string, Promise<void>>()

export function startAssignmentOwnerReadiness(rootDir: string): Promise<AssignmentOwnerCoordinator> {
  const root = resolve(rootDir)
  const existing = readinessByRoot.get(root)
  if (existing) return existing.promise
  const promise = recoverAssignmentOwners(root).then((result) => result.coordinator)
  readinessByRoot.set(root, { promise })
  void promise.catch(() => undefined)
  return promise
}

export function retryAssignmentOwnerReadiness(rootDir: string): Promise<AssignmentOwnerRecoveryResult[]> {
  const root = resolve(rootDir)
  const attempt = recoverAssignmentOwners(root)
  const promise = attempt.then((result) => result.coordinator)
  readinessByRoot.set(root, { promise })
  void promise.catch(() => undefined)
  return attempt.then((result) => result.outcomes)
}

export function awaitAssignmentOwnerReadiness(rootDir: string): Promise<AssignmentOwnerCoordinator> {
  return startAssignmentOwnerReadiness(rootDir)
}

export async function withAssignmentOwnerReadiness<T>(
  rootDir: string,
  operation: () => Promise<T> | T
): Promise<T> {
  const root = resolve(rootDir)
  const previous = operationTailByRoot.get(root) ?? Promise.resolve()
  let release = (): void => undefined
  const slot = new Promise<void>((resolveSlot) => { release = resolveSlot })
  const tail = previous.then(() => slot, () => slot)
  operationTailByRoot.set(root, tail)
  await previous.catch(() => undefined)
  try {
    await awaitAssignmentOwnerReadiness(root)
    return await operation()
  } finally {
    release()
    if (operationTailByRoot.get(root) === tail) operationTailByRoot.delete(root)
  }
}

export function failAssignmentOwnerReadiness(rootDir: string, cause: unknown): void {
  const root = resolve(rootDir)
  const error = cause instanceof AssignmentOwnerCoordinatorError
    ? cause
    : new AssignmentOwnerCoordinatorError(
      'RECOVERY_PENDING',
      `Assignment owner coordination is unavailable: ${errorText(cause)}`
    )
  const promise = Promise.reject<AssignmentOwnerCoordinator>(error)
  readinessByRoot.set(root, { promise })
  void promise.catch(() => undefined)
}

async function recoverAssignmentOwners(rootDir: string): Promise<{
  coordinator: AssignmentOwnerCoordinator
  outcomes: AssignmentOwnerRecoveryResult[]
}> {
  const coordinator = await new AssignmentOwnerCoordinator({ rootDir }).initialize()
  const outcomes = await coordinator.recoverPending()
  const unresolved = outcomes.filter((outcome) => !outcome.recovered)
  if (unresolved.length > 0) {
    throw new AssignmentOwnerCoordinatorError(
      'RECOVERY_PENDING',
      `${unresolved.length} Assignment owner operation(s) remain unresolved`,
      { requestIds: unresolved.map((outcome) => outcome.requestId) }
    )
  }
  return { coordinator, outcomes }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
