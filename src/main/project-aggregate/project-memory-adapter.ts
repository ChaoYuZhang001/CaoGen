import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type {
  LearningActor,
  LearningAuditEvent,
  LearningRecord,
  MemoryLearningPayload
} from '../../shared/learning-types'
import { createLearningDraft } from '../learning/learning-lifecycle'
import {
  learningProjectHash,
  readLearningState,
  type LearningPersistedState
} from '../learning/learning-store'
import { aggregateIntegrityError, requiredProjectId } from './errors'

const PROJECT_ID_NAMESPACE = 'caogen-project-learning-v1'

export interface ProjectMemoryDraftInput {
  id?: string
  logicalId?: string
  source: string
  confidence?: number
  actor?: LearningActor
  payload: Omit<MemoryLearningPayload, 'type'>
}

export interface ProjectMemoryNamespaceState {
  namespace: 'project_id' | 'legacy_path'
  namespaceDigest: string
  state: LearningPersistedState
}

/**
 * Learning APIs remain path-compatible, while this synthetic path gives a
 * directory-free Project a stable namespace that depends only on Project ID.
 * It is an identity input and is never created as a resource directory.
 */
export function projectLearningNamespace(projectId: string): string {
  const id = requiredProjectId(projectId)
  const digest = createHash('sha256').update(`${PROJECT_ID_NAMESPACE}\0${id}`).digest('hex')
  return resolve('/', '.caogen-project-identities', digest)
}

export function projectLearningNamespaceDigest(projectId: string): string {
  return learningProjectHash(projectLearningNamespace(projectId))
}

export async function createProjectMemoryDraft(
  projectId: string,
  learningRoot: string,
  input: ProjectMemoryDraftInput
): Promise<LearningRecord> {
  const namespace = projectLearningNamespace(projectId)
  return createLearningDraft(namespace, learningRoot, {
    kind: 'memory',
    source: input.source,
    confidence: input.confidence,
    payload: { type: 'memory', ...input.payload }
  }, {
    actor: input.actor,
    requestedId: input.id,
    requestedLogicalId: input.logicalId
  })
}

export async function readProjectMemoryNamespaces(
  projectId: string,
  learningRoot: string,
  legacyProjectRoots: string[] = []
): Promise<ProjectMemoryNamespaceState[]> {
  const currentRoot = projectLearningNamespace(projectId)
  const current = await readLearningState(learningRoot, currentRoot)
  const result: ProjectMemoryNamespaceState[] = [{
    namespace: 'project_id',
    namespaceDigest: learningProjectHash(currentRoot),
    state: current
  }]
  const seenNamespaces = new Set([result[0].namespaceDigest])
  for (const legacyRoot of [...new Set(legacyProjectRoots)].sort()) {
    const namespaceDigest = learningProjectHash(legacyRoot)
    if (seenNamespaces.has(namespaceDigest)) continue
    seenNamespaces.add(namespaceDigest)
    result.push({
      namespace: 'legacy_path',
      namespaceDigest,
      state: await readLearningState(learningRoot, legacyRoot)
    })
  }
  assertMemoryNamespaceUniqueness(projectId, result)
  return result
}

export function memoryRecords(
  projectId: string,
  states: readonly ProjectMemoryNamespaceState[]
): Array<{
  id: string
  projectId: string
  namespace: ProjectMemoryNamespaceState['namespace']
  namespaceDigest: string
  record: LearningRecord
}> {
  return states.flatMap(({ namespace, namespaceDigest, state }) =>
    state.records
      .filter((record) => record.kind === 'memory')
      .map((record) => ({ id: record.id, projectId, namespace, namespaceDigest, record }))
  )
}

export function memoryAuditEvents(
  projectId: string,
  states: readonly ProjectMemoryNamespaceState[]
): Array<{
  id: string
  projectId: string
  namespace: ProjectMemoryNamespaceState['namespace']
  event: LearningAuditEvent
}> {
  return states.flatMap(({ namespace, namespaceDigest, state }) => {
    const memoryIds = new Set(state.records.filter((record) => record.kind === 'memory').map((record) => record.id))
    return state.audit
      .filter((event) => memoryIds.has(event.recordId))
      .map((event) => ({
        id: `${namespaceDigest}:${event.id}`,
        projectId,
        namespace,
        event
      }))
  })
}

function assertMemoryNamespaceUniqueness(
  projectId: string,
  states: readonly ProjectMemoryNamespaceState[]
): void {
  const ids = new Set<string>()
  const logicalIds = new Map<string, string>()
  for (const { namespaceDigest, state } of states) {
    const records = new Map(state.records.map((record) => [record.id, record]))
    const auditedMemoryIds = new Set<string>()
    for (const event of state.audit) {
      const record = records.get(event.recordId)
      if (!record || record.logicalId !== event.logicalId) {
        throw aggregateIntegrityError(
          `Learning Audit ${event.id} has no matching record in Project namespace`,
          { projectId }
        )
      }
      if (record.kind === 'memory') auditedMemoryIds.add(record.id)
    }
    for (const record of state.records.filter((candidate) => candidate.kind === 'memory')) {
      if (ids.has(record.id)) {
        throw aggregateIntegrityError(`Memory ${record.id} is duplicated across Project namespaces`, { projectId })
      }
      ids.add(record.id)
      const owner = logicalIds.get(record.logicalId)
      if (owner && owner !== namespaceDigest) {
        throw aggregateIntegrityError(
          `Memory logicalId ${record.logicalId} is ambiguous across Project namespaces`,
          { projectId }
        )
      }
      logicalIds.set(record.logicalId, namespaceDigest)
      if (!auditedMemoryIds.has(record.id)) {
        throw aggregateIntegrityError(`Memory ${record.id} is missing its Learning Audit`, { projectId })
      }
    }
  }
}
