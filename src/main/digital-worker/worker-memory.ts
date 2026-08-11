import { join } from 'node:path'
import type {
  DigitalWorkerMemoryDraftInput,
  DigitalWorkerMemorySnapshot
} from '../../shared/digital-worker-types'
import type { SessionMeta } from '../../shared/types'
import type { LearningRecord, MemoryLearningPayload } from '../../shared/learning-types'
import {
  approveLearningDraft,
  createLearningDraft,
  deleteLearningRecord,
  getLearningRecord,
  listLearningProject,
  rejectLearningDraft,
  revokeLearningRecord
} from '../learning/learning-lifecycle'
import {
  createTrustedUserLearningDecision,
  type TrustedLearningDecision
} from '../learning/learning-security'
import { projectLearningNamespace } from '../project-aggregate/project-memory-adapter'
import { DigitalWorkerStore } from './domain-store'

type WorkerMemoryDecision = 'approve' | 'reject' | 'revoke' | 'delete'

export async function listDigitalWorkerMemory(
  store: DigitalWorkerStore,
  rootDir: string,
  workerId: string
): Promise<DigitalWorkerMemorySnapshot> {
  const worker = await store.getDigitalWorker(workerId)
  if (!worker) throw new Error(`DigitalWorker not found: ${workerId}`)
  const role = await store.getRoleTemplate(worker.roleTemplateId)
  const projectMemoryReadAllowed = role?.memoryPolicy.projectRead !== false
  const snapshot = await listLearningProject(projectLearningNamespace(worker.projectId), join(rootDir, 'learning'))
  const projectMemories = snapshot.active.filter((record) =>
    projectMemoryReadAllowed && record.scope === 'project' && isMemoryRecord(record))
  const workerRecords = snapshot.records.filter((record) =>
    record.scope === 'worker' && record.workerId === worker.id &&
    record.memoryNamespace === worker.memoryNamespace && isMemoryRecord(record))
  const workerMemories = workerRecords.filter((record) => record.status === 'active')
  const drafts = workerRecords.filter((record) => record.status === 'draft')
  const history = workerRecords.filter((record) => record.status !== 'active' && record.status !== 'draft')
  return {
    schemaVersion: 1,
    projectId: worker.projectId,
    workerId: worker.id,
    memoryNamespace: worker.memoryNamespace,
    workerStatus: worker.status,
    projectMemoryReadAllowed,
    projectMemories,
    workerMemories,
    drafts,
    history,
    effective: worker.status === 'active' ? [...projectMemories, ...workerMemories] : []
  }
}

/**
 * Render only the active memory owned by the frozen Worker binding. Project
 * memory is rendered by the shared retriever; keeping this block separate
 * prevents a retired or reassigned Worker namespace from leaking into a turn.
 */
export async function buildDigitalWorkerMemoryPrompt(
  rootDir: string,
  meta: Pick<SessionMeta, 'projectId' | 'workspaceId' | 'digitalWorkerBinding'>
): Promise<string> {
  const binding = meta.digitalWorkerBinding
  if (binding?.kind !== 'assigned') return ''
  const snapshot = await listDigitalWorkerMemory(
    new DigitalWorkerStore(rootDir),
    rootDir,
    binding.workerId
  )
  if (snapshot.projectId !== (meta.workspaceId ?? meta.projectId)) {
    throw new Error(`DigitalWorker memory Project mismatch: ${binding.workerId}`)
  }
  if (snapshot.workerStatus !== 'active') {
    throw new Error(`DigitalWorker memory is unavailable for non-active Worker: ${binding.workerId}`)
  }
  if (snapshot.workerMemories.length === 0) return ''
  const blocks = snapshot.workerMemories.map((record) => {
    if (!isMemoryRecord(record)) throw new Error(`Invalid Worker Memory record: ${record.id}`)
    return [`### ${record.payload.title}`, record.payload.body].filter(Boolean).join('\n')
  })
  return `## DigitalWorker Memory\n\n以下是当前绑定员工已获用户确认的工作记忆,仅适用于本员工和本项目:\n\n${blocks.join('\n\n')}\n`
}

export async function proposeDigitalWorkerMemory(
  store: DigitalWorkerStore,
  rootDir: string,
  workerId: string,
  input: DigitalWorkerMemoryDraftInput
): Promise<DigitalWorkerMemorySnapshot> {
  const worker = await requireLearningWorker(store, workerId)
  await createLearningDraft(
    projectLearningNamespace(worker.projectId),
    join(rootDir, 'learning'),
    {
      kind: 'memory',
      source: 'digital-worker:user-proposal',
      confidence: input.confidence,
      workerId: worker.id,
      memoryNamespace: worker.memoryNamespace,
      payload: {
        type: 'memory',
        memoryKind: input.memoryKind,
        title: input.title,
        body: input.body,
        reason: input.reason
      }
    },
    { actor: { type: 'user', id: 'desktop-user', source: 'ipc:digital-worker-memory:propose' } }
  )
  return listDigitalWorkerMemory(store, rootDir, worker.id)
}

export async function decideDigitalWorkerMemory(
  store: DigitalWorkerStore,
  rootDir: string,
  workerId: string,
  recordId: string,
  action: WorkerMemoryDecision
): Promise<DigitalWorkerMemorySnapshot> {
  const worker = action === 'delete'
    ? await requireExistingWorker(store, workerId)
    : await requireLearningWorker(store, workerId)
  const projectRoot = projectLearningNamespace(worker.projectId)
  const learningRoot = join(rootDir, 'learning')
  const record = await getLearningRecord(projectRoot, learningRoot, recordId)
  if (!record || record.scope !== 'worker' || record.workerId !== worker.id ||
    record.memoryNamespace !== worker.memoryNamespace || !isMemoryRecord(record)) {
    throw new Error(`Worker Memory record not found in namespace: ${recordId}`)
  }
  const authority = decision(action)
  if (action === 'approve') await approveLearningDraft(projectRoot, learningRoot, record.id, authority)
  else if (action === 'reject') await rejectLearningDraft(projectRoot, learningRoot, record.id, authority)
  else if (action === 'revoke') await revokeLearningRecord(projectRoot, learningRoot, record.id, authority)
  else await deleteLearningRecord(projectRoot, learningRoot, record.id, authority)
  return listDigitalWorkerMemory(store, rootDir, worker.id)
}

async function requireLearningWorker(store: DigitalWorkerStore, workerId: string) {
  const worker = await requireExistingWorker(store, workerId)
  if (worker.status !== 'active') {
    throw new Error(`Only active DigitalWorkers may learn: ${worker.id}`)
  }
  return worker
}

async function requireExistingWorker(store: DigitalWorkerStore, workerId: string) {
  const worker = await store.getDigitalWorker(workerId)
  if (!worker) throw new Error(`DigitalWorker not found: ${workerId}`)
  return worker
}

function isMemoryRecord(record: LearningRecord): record is LearningRecord & { payload: MemoryLearningPayload } {
  return record.kind === 'memory' && record.payload.type === 'memory'
}

function decision(action: WorkerMemoryDecision): TrustedLearningDecision {
  return createTrustedUserLearningDecision(`ipc:digital-worker-memory:${action}`)
}
