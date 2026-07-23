import type { AssignmentOwnerCoordinatorOptions } from './contracts'
import { AssignmentOwnerCoordinator } from './coordinator'

export * from './contracts'
export * from './coordinator'
export * from './errors'
export * from './readiness'
export { assignmentOwnerJournalPath } from './journal'
export { normalizeAssignmentOwnerInput } from './validation'

export async function openAssignmentOwnerCoordinator(
  rootDirOrOptions: string | AssignmentOwnerCoordinatorOptions,
  recover = true
): Promise<AssignmentOwnerCoordinator> {
  const options = typeof rootDirOrOptions === 'string'
    ? { rootDir: rootDirOrOptions }
    : rootDirOrOptions
  const coordinator = await new AssignmentOwnerCoordinator(options).initialize()
  if (recover) await coordinator.recoverPending()
  return coordinator
}
