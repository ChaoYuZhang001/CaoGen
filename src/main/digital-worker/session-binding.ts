import type {
  DigitalWorker,
  DigitalWorkerAssignment,
  DigitalWorkerBinding,
  DigitalWorkerStoreDocument
} from '../../shared/digital-worker-types'
import type { SessionMeta, TaskRunRecord } from '../../shared/types'
import { DigitalWorkerStore } from './domain-store'

export type DigitalWorkerBindingErrorCode =
  | 'policy_store_unavailable'
  | 'assignment_conflict'
  | 'worker_unavailable'

export class DigitalWorkerBindingError extends Error {
  constructor(
    readonly code: DigitalWorkerBindingErrorCode,
    message: string,
    readonly binding?: DigitalWorkerBinding
  ) {
    super(message)
    this.name = 'DigitalWorkerBindingError'
  }
}

export interface DigitalWorkerAssignedScope {
  scoped: true
  binding: Extract<DigitalWorkerBinding, { kind: 'assigned' }>
  document: DigitalWorkerStoreDocument
  worker: DigitalWorker
  assignment: DigitalWorkerAssignment
}

export type DigitalWorkerSessionScope =
  | { scoped: false; binding: Extract<DigitalWorkerBinding, { kind: 'unscoped' }> }
  | DigitalWorkerAssignedScope

type SessionBindingClaim = Pick<
  SessionMeta,
  'projectId' | 'workspaceId' | 'workItemId' | 'unassigned' | 'createdAt' | 'digitalWorkerBinding'
>

/** Resolve once for a brand-new Session; later lifecycle stages only validate. */
export function createDigitalWorkerSessionBinding(
  meta: SessionBindingClaim,
  rootDir: string
): DigitalWorkerBinding {
  if (meta.digitalWorkerBinding !== undefined) {
    throw bindingError('assignment_conflict', '新会话不得预置 DigitalWorker 身份绑定')
  }
  const identity = sessionIdentity(meta)
  if (!identity) return { kind: 'unscoped' }
  const document = readStore(rootDir)
  const assignment = activeAssignment(document, identity.projectId, identity.workItemId)
  if (!assignment || assignment.assigneeKind !== 'digital_worker') return { kind: 'unscoped' }
  const binding = assignedBinding(assignment.assigneeId, assignment.id)
  assertAssignedScope(meta, document, identity, binding)
  return binding
}

/** Validate a durable binding during activation, restart, recovery and action preflight. */
export function resolveDigitalWorkerSessionScope(
  meta: SessionBindingClaim,
  rootDir: string | undefined,
  options: { allowLegacyUnscoped?: boolean } = {}
): DigitalWorkerSessionScope {
  const identity = sessionIdentity(meta)
  const binding = parseBinding(meta.digitalWorkerBinding)
  if (!binding) {
    if (options.allowLegacyUnscoped === true && isStructurallyUnscoped(meta, identity)) {
      return { scoped: false, binding: { kind: 'unscoped' } }
    }
    throw bindingError('assignment_conflict', 'Session 缺少不可变 DigitalWorker 身份绑定')
  }
  if (!identity) {
    if (binding.kind === 'assigned') {
      throw bindingError('assignment_conflict', 'DigitalWorker 绑定缺少 Project/WorkItem 所有权', binding)
    }
    return { scoped: false, binding }
  }
  const document = readStore(rootDir)
  if (binding.kind === 'unscoped') {
    const current = activeAssignment(document, identity.projectId, identity.workItemId)
    if (current?.assigneeKind === 'digital_worker') {
      throw bindingError(
        'assignment_conflict',
        `原始 unscoped Session 不能采用 Assignment ${current.id} 的 DigitalWorker 策略`,
        binding
      )
    }
    return { scoped: false, binding }
  }
  return assertAssignedScope(meta, document, identity, binding)
}

export function bindLegacyUnscopedSessionForRecovery(meta: SessionMeta): SessionMeta {
  if (meta.digitalWorkerBinding !== undefined) return meta
  if (!isStructurallyUnscoped(meta, sessionIdentity(meta))) {
    throw bindingError('assignment_conflict', 'Scoped Session 的 DigitalWorker 身份绑定缺失，拒绝恢复')
  }
  return { ...meta, digitalWorkerBinding: { kind: 'unscoped' } }
}

export function bindAndValidateTaskRun(
  meta: SessionMeta,
  run: TaskRunRecord | undefined,
  options: { allowLegacyUnscoped?: boolean } = {}
): TaskRunRecord | undefined {
  if (!run) return undefined
  const sessionBinding = requireBinding(meta.digitalWorkerBinding, 'Session')
  const runBinding = parseBinding(run.digitalWorkerBinding)
  if (!runBinding) {
    if (options.allowLegacyUnscoped === true && sessionBinding.kind === 'unscoped' &&
      isStructurallyUnscoped(meta, sessionIdentity(meta))) {
      return { ...run, digitalWorkerBinding: { kind: 'unscoped' } }
    }
    throw bindingError('assignment_conflict', `TaskRun ${run.id} 缺少不可变 DigitalWorker 身份绑定`, sessionBinding)
  }
  assertDigitalWorkerTaskRunBinding(sessionBinding, run.id, runBinding)
  return run
}

export function assertDigitalWorkerTaskRunBinding(
  sessionBindingValue: unknown,
  runId: string,
  runBindingValue: unknown
): void {
  const sessionBinding = requireBinding(sessionBindingValue, 'Session')
  const runBinding = requireBinding(runBindingValue, `TaskRun ${runId}`)
  if (!sameDigitalWorkerBinding(sessionBinding, runBinding)) {
    throw bindingError('assignment_conflict', `TaskRun ${runId} 与 Session 的 DigitalWorker 身份绑定不一致`, sessionBinding)
  }
}

export function sameDigitalWorkerBinding(
  left: DigitalWorkerBinding,
  right: DigitalWorkerBinding
): boolean {
  return left.kind === right.kind && (left.kind === 'unscoped' || (
    right.kind === 'assigned' && left.workerId === right.workerId && left.assignmentId === right.assignmentId
  ))
}

export function parseBinding(value: unknown): DigitalWorkerBinding | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw bindingError('assignment_conflict', 'DigitalWorker 身份绑定格式无效')
  }
  const record = value as Record<string, unknown>
  if (record.kind === 'unscoped' && Object.keys(record).length === 1) return { kind: 'unscoped' }
  if (record.kind === 'assigned' && Object.keys(record).length === 3) {
    return assignedBinding(requiredId(record.workerId, 'workerId'), requiredId(record.assignmentId, 'assignmentId'))
  }
  throw bindingError('assignment_conflict', 'DigitalWorker 身份绑定格式无效')
}

function assertAssignedScope(
  meta: SessionBindingClaim,
  document: DigitalWorkerStoreDocument,
  identity: { projectId: string; workItemId: string },
  binding: Extract<DigitalWorkerBinding, { kind: 'assigned' }>
): DigitalWorkerAssignedScope {
  const assignment = document.assignments.find((candidate) => candidate.id === binding.assignmentId)
  if (!assignment || assignment.status !== 'active' || assignment.assigneeKind !== 'digital_worker' ||
    assignment.assigneeId !== binding.workerId || assignment.projectId !== identity.projectId ||
    assignment.workItemId !== identity.workItemId || assignment.assignedAt > meta.createdAt) {
    throw bindingError(
      'assignment_conflict',
      `原始 Assignment ${binding.assignmentId} 已释放、缺失或与 Session 身份不一致`,
      binding
    )
  }
  const current = activeAssignment(document, identity.projectId, identity.workItemId)
  if (!current || current.id !== assignment.id) {
    throw bindingError('assignment_conflict', 'WorkItem 当前 Assignment 与 Session 原始绑定不一致', binding)
  }
  const worker = document.workers.find((candidate) => candidate.id === binding.workerId)
  if (!worker || worker.projectId !== identity.projectId || worker.status !== 'active') {
    throw bindingError('worker_unavailable', `原始 DigitalWorker ${binding.workerId} 已不可用`, binding)
  }
  return { scoped: true, binding, document, worker, assignment }
}

function activeAssignment(
  document: DigitalWorkerStoreDocument,
  projectId: string,
  workItemId: string
): DigitalWorkerAssignment | undefined {
  const matches = document.assignments.filter((candidate) =>
    candidate.projectId === projectId && candidate.workItemId === workItemId && candidate.status === 'active'
  )
  if (matches.length > 1) {
    throw bindingError('assignment_conflict', `WorkItem ${workItemId} 存在多个 active Assignment`)
  }
  return matches[0]
}

function readStore(rootDir: string | undefined): DigitalWorkerStoreDocument {
  if (!rootDir?.trim()) {
    throw bindingError('policy_store_unavailable', 'DigitalWorker 策略根目录未配置')
  }
  try {
    return new DigitalWorkerStore(rootDir).read()
  } catch (error) {
    if (error instanceof DigitalWorkerBindingError) throw error
    throw bindingError(
      'policy_store_unavailable',
      `DigitalWorker 策略存储不可用：${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function sessionIdentity(
  meta: SessionBindingClaim
): { projectId: string; workItemId: string } | undefined {
  const projectId = optionalId(meta.workspaceId ?? meta.projectId, 'projectId')
  const workItemId = optionalId(meta.workItemId, 'workItemId')
  if (!projectId || !workItemId) return undefined
  return { projectId, workItemId }
}

function isStructurallyUnscoped(
  meta: Pick<SessionMeta, 'unassigned'>,
  identity: { projectId: string; workItemId: string } | undefined
): boolean {
  return meta.unassigned === true || identity === undefined
}

function requireBinding(value: unknown, label: string): DigitalWorkerBinding {
  const binding = parseBinding(value)
  if (!binding) throw bindingError('assignment_conflict', `${label} 缺少不可变 DigitalWorker 身份绑定`)
  return binding
}

function assignedBinding(workerId: string, assignmentId: string): Extract<DigitalWorkerBinding, { kind: 'assigned' }> {
  return { kind: 'assigned', workerId, assignmentId }
}

function optionalId(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  return requiredId(value, label)
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\0-\x1f\x7f]/.test(value)) {
    throw bindingError('assignment_conflict', `${label} 无效`)
  }
  return value.trim()
}

function bindingError(
  code: DigitalWorkerBindingErrorCode,
  message: string,
  binding?: DigitalWorkerBinding
): DigitalWorkerBindingError {
  return new DigitalWorkerBindingError(code, message, binding)
}
