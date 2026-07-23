import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  DigitalWorker,
  DigitalWorkerAssignment,
  DigitalWorkerBinding,
  DigitalWorkerStoreDocument
} from '../../shared/digital-worker-types'
import type { SessionMeta, TaskRunStatus } from '../../shared/types'
import { monthKeyFor } from '../../shared/budget'
import {
  digitalWorkerPolicyContract,
  evaluateDigitalWorkerToolPolicy,
  type DigitalWorkerPolicyContract
} from './action-policy-contract'
import {
  assertDigitalWorkerTaskRunBinding,
  DigitalWorkerBindingError,
  resolveDigitalWorkerSessionScope
} from './session-binding'

export type DigitalWorkerPolicyAction =
  | 'provider_send'
  | 'tool_call'
  | 'supervisor_resume'
  | 'supervisor_retry'

export type DigitalWorkerActionPolicyCode =
  | 'policy_store_unavailable'
  | 'assignment_conflict'
  | 'worker_unavailable'
  | 'policy_invalid'
  | 'tool_denied'
  | 'budget_untrackable'
  | 'budget_exhausted'
  | 'concurrency_exhausted'
  | 'escalation_required'

export interface DigitalWorkerActionPolicyInput {
  meta: Pick<
    SessionMeta,
    'id' | 'projectId' | 'workspaceId' | 'workItemId' | 'unassigned' | 'digitalWorkerBinding' |
    'engine' | 'status' | 'costUsd' | 'createdAt'
  >
  action: DigitalWorkerPolicyAction
  rootDir?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  runId?: string
  runStatus?: TaskRunStatus
  runBinding?: DigitalWorkerBinding
  failureCount?: number
  escalationApproved?: boolean
  activeSessions?: readonly SessionMeta[]
  now?: number
}

export type DigitalWorkerActionPolicyDecision =
  | { allowed: true; scoped: false }
  | {
      allowed: true
      scoped: true
      workerId: string
      assignmentId: string
      monthlySpentUsd: number
      activeActions: number
    }
  | {
      allowed: false
      scoped: boolean
      code: DigitalWorkerActionPolicyCode
      message: string
      workerId?: string
      assignmentId?: string
    }

interface PolicyScope {
  document: DigitalWorkerStoreDocument
  worker: DigitalWorker
  assignment: DigitalWorkerAssignment
}

interface SessionCostRecord {
  id: string
  projectId?: string
  workspaceId?: string
  workItemId?: string
  digitalWorkerBinding?: DigitalWorkerBinding
  status?: SessionMeta['status']
  engine?: SessionMeta['engine']
  costUsd: number
  createdAt: number
  updatedAt?: number
}

interface SupervisorPolicyRecord {
  id: string
  status: string
  retryCount: number
}

type PreparedPolicyScope =
  | { ready: false; decision: DigitalWorkerActionPolicyDecision }
  | { ready: true; rootDir: string; scope: PolicyScope; contract: DigitalWorkerPolicyContract }

type ActionState =
  | { ready: false; decision: DigitalWorkerActionPolicyDecision }
  | { ready: true; records: SessionCostRecord[]; now: number; activeActions: number }

let configuredRootDir: string | undefined

export function configureDigitalWorkerActionPolicyRoot(rootDir: string): void {
  const normalized = rootDir.trim()
  if (!normalized) throw new Error('DigitalWorker action policy rootDir is required')
  configuredRootDir = normalized
}

export function preflightDigitalWorkerAction(
  input: DigitalWorkerActionPolicyInput
): DigitalWorkerActionPolicyDecision {
  const prepared = preparePolicyScope(input)
  if ('decision' in prepared) return prepared.decision
  const { rootDir, scope, contract } = prepared
  const toolDecision = toolPolicyDecision(input, scope)
  if (toolDecision) return toolDecision
  const state = prepareActionState(input, rootDir, scope, contract)
  if ('decision' in state) return state.decision
  const budgetDecision = workerBudgetDecision(input, scope, contract, state)
  if (budgetDecision) return budgetDecision
  const escalationDecision = workerEscalationDecision(input, rootDir, scope, contract)
  if (escalationDecision) return escalationDecision
  return allowedScope(scope, state, contract)
}

function preparePolicyScope(input: DigitalWorkerActionPolicyInput): PreparedPolicyScope {
  const rootDir = input.rootDir ?? configuredRootDir
  let scope: ReturnType<typeof resolveDigitalWorkerSessionScope>
  try {
    scope = resolveDigitalWorkerSessionScope(input.meta, rootDir, { allowLegacyUnscoped: true })
    if (input.runId) {
      assertDigitalWorkerTaskRunBinding(scope.binding, input.runId, input.runBinding)
    }
  } catch (error) {
    if (error instanceof DigitalWorkerBindingError) {
      return { ready: false, decision: deniedBinding(error) }
    }
    return {
      ready: false,
      decision: denied(false, 'policy_store_unavailable', `数字员工策略读取失败：${errorText(error)}`)
    }
  }
  if (!scope.scoped) return { ready: false, decision: { allowed: true, scoped: false } }
  if (!rootDir) {
    return {
      ready: false,
      decision: deniedBinding(new DigitalWorkerBindingError(
        'policy_store_unavailable', '数字员工策略根目录未配置，已阻止执行', scope.binding
      ))
    }
  }
  try {
    return { ready: true, rootDir, scope, contract: digitalWorkerPolicyContract(scope.worker) }
  } catch (error) {
    return {
      ready: false,
      decision: deniedScope('policy_invalid', `数字员工 ${scope.worker.id} 策略无效：${errorText(error)}`, scope)
    }
  }
}

function toolPolicyDecision(
  input: DigitalWorkerActionPolicyInput,
  scope: PolicyScope
): DigitalWorkerActionPolicyDecision | null {
  if (input.action !== 'tool_call') return null
  if (!input.toolName) return deniedScope('tool_denied', '数字员工工具动作缺少 toolName', scope)
  const tool = evaluateDigitalWorkerToolPolicy(scope.worker.toolPolicy, input.toolName, input.toolInput ?? {})
  return 'reason' in tool
    ? deniedScope('tool_denied', `数字员工 ${scope.worker.id} ${tool.reason}`, scope)
    : null
}

function prepareActionState(
  input: DigitalWorkerActionPolicyInput,
  rootDir: string,
  scope: PolicyScope,
  contract: DigitalWorkerPolicyContract
): ActionState {
  let records: SessionCostRecord[]
  try {
    records = loadSessionRecords(rootDir, input)
  } catch (error) {
    return {
      ready: false,
      decision: deniedScope('policy_store_unavailable', `数字员工执行状态读取失败：${errorText(error)}`, scope)
    }
  }
  const now = input.now ?? Date.now()
  const activeActions = activeWorkerActions(
    records, scope.document, scope.worker.id, input.meta.id, input.action, now)
  if (activeActions > contract.concurrencyLimit) {
    return {
      ready: false,
      decision: deniedScope(
        'concurrency_exhausted',
        `数字员工 ${scope.worker.id} 并发上限为 ${contract.concurrencyLimit}，当前动作将达到 ${activeActions}`,
        scope
      )
    }
  }
  return { ready: true, records, now, activeActions }
}

function workerBudgetDecision(
  input: DigitalWorkerActionPolicyInput,
  scope: PolicyScope,
  contract: DigitalWorkerPolicyContract,
  state: Extract<ActionState, { ready: true }>
): DigitalWorkerActionPolicyDecision | null {
  if (contract.monthlyBudgetUsd === undefined) return null
  if (!canTrackCost(input.meta.engine)) {
    return deniedScope(
      'budget_untrackable',
      `数字员工 ${scope.worker.id} 配置了月度预算，但当前引擎无法可靠回传费用`,
      scope
    )
  }
  const spent = workerMonthlySpend(
    state.records, scope.document.assignments, scope.worker.id, state.now)
  if (spent < contract.monthlyBudgetUsd) return null
  return deniedScope(
    'budget_exhausted',
    `数字员工 ${scope.worker.id} 已达到月度预算 $${contract.monthlyBudgetUsd.toFixed(2)}`,
    scope
  )
}

function workerEscalationDecision(
  input: DigitalWorkerActionPolicyInput,
  rootDir: string,
  scope: PolicyScope,
  contract: DigitalWorkerPolicyContract
): DigitalWorkerActionPolicyDecision | null {
  if (!contract.escalation) return null
  let escalation
  try {
    escalation = escalationState(rootDir, input)
  } catch (error) {
    return deniedScope('policy_store_unavailable', `数字员工升级状态读取失败：${errorText(error)}`, scope)
  }
  if (!escalation.required || escalation.failures < contract.escalation.afterFailures) return null
  if (input.escalationApproved === true) return null
  return deniedScope(
    'escalation_required',
    `数字员工 ${scope.worker.id} 已连续失败 ${escalation.failures} 次，必须升级给 ${contract.escalation.target}`,
    scope
  )
}

function allowedScope(
  scope: PolicyScope,
  state: Extract<ActionState, { ready: true }>,
  contract: DigitalWorkerPolicyContract
): DigitalWorkerActionPolicyDecision {
  const monthlySpentUsd = contract.monthlyBudgetUsd === undefined
    ? 0
    : workerMonthlySpend(state.records, scope.document.assignments, scope.worker.id, state.now)
  return {
    allowed: true,
    scoped: true,
    workerId: scope.worker.id,
    assignmentId: scope.assignment.id,
    monthlySpentUsd,
    activeActions: state.activeActions
  }
}

function loadSessionRecords(
  rootDir: string,
  input: DigitalWorkerActionPolicyInput
): SessionCostRecord[] {
  const records = new Map<string, SessionCostRecord>()
  for (const record of readSessionFile(join(rootDir, 'sessions.json'))) records.set(record.id, record)
  for (const record of readSessionFile(join(rootDir, 'active-sessions.json'))) records.set(record.id, record)
  for (const record of input.activeSessions ?? []) records.set(record.id, normalizeSessionRecord(record))
  records.set(input.meta.id, normalizeSessionRecord(input.meta))
  return [...records.values()]
}

function readSessionFile(filePath: string): SessionCostRecord[] {
  if (!existsSync(filePath)) return []
  const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error(`${filePath} must contain an array`)
  return parsed.map(normalizeSessionRecord)
}

function normalizeSessionRecord(value: unknown): SessionCostRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('session policy record is invalid')
  const record = value as Record<string, unknown>
  const normalized = requiredSessionRecord(record)
  copySessionText(record, normalized, 'projectId')
  copySessionText(record, normalized, 'workspaceId')
  copySessionText(record, normalized, 'workItemId')
  copySessionText(record, normalized, 'status')
  copySessionText(record, normalized, 'engine')
  if (typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)) {
    normalized.updatedAt = record.updatedAt
  }
  if (record.digitalWorkerBinding !== undefined) {
    normalized.digitalWorkerBinding = normalizeCostBinding(record.digitalWorkerBinding)
  }
  return normalized
}

function requiredSessionRecord(record: Record<string, unknown>): SessionCostRecord {
  const id = optionalText(record.id)
  if (!id) throw new Error('session policy record id is invalid')
  const costUsd = record.costUsd === undefined ? 0 : record.costUsd
  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0) {
    throw new Error(`session ${id} costUsd is invalid`)
  }
  if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) {
    throw new Error(`session ${id} createdAt is invalid`)
  }
  return { id, costUsd, createdAt: record.createdAt }
}

function copySessionText(
  source: Record<string, unknown>,
  target: SessionCostRecord,
  field: 'projectId' | 'workspaceId' | 'workItemId' | 'status' | 'engine'
): void {
  const value = optionalText(source[field])
  if (value) Object.assign(target, { [field]: value })
}

function activeWorkerActions(
  records: readonly SessionCostRecord[],
  document: DigitalWorkerStoreDocument,
  workerId: string,
  currentSessionId: string,
  action: DigitalWorkerPolicyAction,
  now: number
): number {
  const activeAssignments = document.assignments.filter((assignment) =>
    assignment.status === 'active' && assignment.assigneeKind === 'digital_worker' && assignment.assigneeId === workerId
  )
  const active = new Set(
    records
      .filter((record) => record.status === 'starting' || record.status === 'running')
      .filter((record) => activeAssignments.some((assignment) => sessionMatchesAssignment(record, assignment, now)))
      .map((record) => record.id)
  )
  if (action === 'tool_call') return active.size
  active.delete(currentSessionId)
  return active.size + 1
}

function workerMonthlySpend(
  records: readonly SessionCostRecord[],
  assignments: readonly DigitalWorkerAssignment[],
  workerId: string,
  now: number
): number {
  const monthKey = monthKeyFor(now)
  const ownedAssignments = assignments.filter((assignment) =>
    assignment.assigneeKind === 'digital_worker' && assignment.assigneeId === workerId
  )
  const total = records
    .filter((record) => monthKeyFor(record.updatedAt ?? record.createdAt) === monthKey)
    .filter((record) => ownedAssignments.some((assignment) => sessionMatchesAssignment(record, assignment, record.updatedAt ?? now)))
    .reduce((sum, record) => sum + record.costUsd, 0)
  return Math.round(total * 1_000_000) / 1_000_000
}

function sessionMatchesAssignment(
  record: SessionCostRecord,
  assignment: DigitalWorkerAssignment,
  timestamp: number
): boolean {
  if (record.digitalWorkerBinding?.kind === 'unscoped') return false
  if (record.digitalWorkerBinding?.kind === 'assigned') {
    return record.digitalWorkerBinding.workerId === assignment.assigneeId &&
      record.digitalWorkerBinding.assignmentId === assignment.id
  }
  const projectId = record.workspaceId ?? record.projectId
  if (projectId !== assignment.projectId || record.workItemId !== assignment.workItemId) return false
  if (timestamp < assignment.assignedAt) return false
  return assignment.releasedAt === undefined || timestamp <= assignment.releasedAt
}

function escalationState(
  rootDir: string,
  input: DigitalWorkerActionPolicyInput
): { required: boolean; failures: number } {
  let failures = normalizeFailureCount(input.failureCount)
  let required = input.runStatus === 'failed' || input.runStatus === 'waiting_reconciliation'
  if (!input.runId) return { required, failures }
  const filePath = join(rootDir, 'supervisor-state.json')
  if (!existsSync(filePath)) return { required, failures }
  const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { runs?: unknown }).runs)) {
    throw new Error('supervisor-state.json is invalid')
  }
  const run = (parsed as { runs: unknown[] }).runs
    .map(normalizeSupervisorRecord)
    .find((candidate) => candidate.id === input.runId)
  if (!run) return { required, failures }
  const failedState = run.status === 'failed' || run.status === 'blocked' || run.status === 'waiting_reconciliation'
  failures = Math.max(failures, run.retryCount + (failedState ? 1 : 0))
  return { required: required || failedState, failures }
}

function normalizeSupervisorRecord(value: unknown): SupervisorPolicyRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Supervisor policy record is invalid')
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.status !== 'string' || !Number.isSafeInteger(record.retryCount)) {
    throw new Error('Supervisor policy record is invalid')
  }
  return { id: record.id, status: record.status, retryCount: record.retryCount as number }
}

function canTrackCost(engine: SessionMeta['engine']): boolean {
  return engine === 'claude' || engine === 'openai'
}

function normalizeFailureCount(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function denied(
  scoped: boolean,
  code: DigitalWorkerActionPolicyCode,
  message: string
): DigitalWorkerActionPolicyDecision {
  return { allowed: false, scoped, code, message }
}

function deniedScope(
  code: DigitalWorkerActionPolicyCode,
  message: string,
  scope: PolicyScope
): DigitalWorkerActionPolicyDecision {
  return {
    allowed: false,
    scoped: true,
    code,
    message,
    workerId: scope.worker.id,
    assignmentId: scope.assignment.id
  }
}

function deniedBinding(error: DigitalWorkerBindingError): DigitalWorkerActionPolicyDecision {
  const binding = error.binding
  return {
    allowed: false,
    scoped: binding?.kind === 'assigned',
    code: error.code,
    message: error.message,
    ...(binding?.kind === 'assigned'
      ? { workerId: binding.workerId, assignmentId: binding.assignmentId }
      : {})
  }
}

function normalizeCostBinding(value: unknown): DigitalWorkerBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('session DigitalWorker binding is invalid')
  }
  const record = value as Record<string, unknown>
  if (record.kind === 'unscoped' && Object.keys(record).length === 1) return { kind: 'unscoped' }
  if (record.kind === 'assigned' && Object.keys(record).length === 3 &&
    optionalText(record.workerId) && optionalText(record.assignmentId)) {
    return {
      kind: 'assigned',
      workerId: optionalText(record.workerId) as string,
      assignmentId: optionalText(record.assignmentId) as string
    }
  }
  throw new Error('session DigitalWorker binding is invalid')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
