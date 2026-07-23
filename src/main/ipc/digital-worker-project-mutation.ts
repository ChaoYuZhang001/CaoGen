import { DigitalWorkerStore } from '../digital-worker'
import {
  projectIdsFromMutationResult,
  verifyProductionProjectMutation
} from '../project-aggregate/project-mutation-ingress'

const PROJECT_OWNED_ACTIONS = new Set([
  'createDigitalWorker', 'updateDigitalWorker', 'activateDigitalWorker', 'pauseDigitalWorker',
  'resumeDigitalWorker', 'retireDigitalWorker', 'deleteDigitalWorker',
  'createDigitalWorkerAssignment', 'releaseDigitalWorkerAssignment', 'reassignDigitalWorkerAssignment',
  'coordinateDigitalWorkerAssignmentOwner', 'recoverDigitalWorkerAssignmentOwners',
  'acquireDigitalWorkerLease', 'heartbeatDigitalWorkerLease', 'releaseDigitalWorkerLease'
])

export function isProjectOwnedDigitalWorkerMutation(action: string): boolean {
  return PROJECT_OWNED_ACTIONS.has(action)
}

export function digitalWorkerMutationProjectIds(
  action: string,
  payload: Record<string, unknown>,
  rootDir: string
): string[] {
  if (!isProjectOwnedDigitalWorkerMutation(action)) return []
  const projectIds = new Set(projectIdsFromMutationResult(payload))
  const state = new DigitalWorkerStore(rootDir).read()
  if (action === 'recoverDigitalWorkerAssignmentOwners') {
    for (const record of [...state.workers, ...state.assignments, ...state.leases]) projectIds.add(record.projectId)
  }
  const id = typeof payload.id === 'string' ? payload.id.trim() : ''
  const record = id ? state.workers.find((entry) => entry.id === id) ??
    state.assignments.find((entry) => entry.id === id) ??
    state.leases.find((entry) => entry.id === id) : undefined
  if (record?.projectId) projectIds.add(record.projectId)
  return [...projectIds].sort()
}

export async function verifyDigitalWorkerMutation(
  rootDir: string,
  beforeProjectIds: string[],
  result: unknown
): Promise<void> {
  const projectIds = new Set([...beforeProjectIds, ...projectIdsFromMutationResult(result)])
  for (const projectId of [...projectIds].sort()) {
    await verifyProductionProjectMutation(rootDir, projectId)
  }
}
