import type { SessionState, ToolResultInfo } from '../../store'
import type { GitStatus, SchedulerStrategy, TaskDagAutoMergeStatus, TaskDagTaskStatus } from '../../../../shared/types'

export type OfficeTaskKind = 'subtask' | 'tool'
export type OfficeTaskStatus = 'pending' | 'running' | 'awaiting' | 'done' | 'error'
export type OfficeSessionActivity = 'idle' | 'working' | 'awaiting' | 'completed' | 'error'

export interface OfficeTask {
  id: string
  sessionId: string
  itemId?: string
  toolUseId?: string
  kind: OfficeTaskKind
  toolName: string
  title: string
  status: OfficeTaskStatus
  order: number
}

export interface OfficeTaskStats {
  total: number
  subtasks: number
  tools: number
  pending: number
  running: number
  awaiting: number
  done: number
  error: number
}

export interface OfficePacket {
  id: string
  sessionId: string
  from: number
  to: number
  kind: OfficeTaskKind
  status: OfficeTaskStatus
  label: string
  toolName: string
}

export interface OfficeRoutingSignal {
  providerId: string
  providerName?: string
  model: string
  reason: string
  basis?: string
  strategy?: SchedulerStrategy
  taskKinds: string[]
  riskLevel?: 'low' | 'medium' | 'high'
  budgetDowngraded: boolean
  validators: number
  crossValidationEnabled: boolean
}

export interface OfficeFailoverSignal {
  fromName: string
  toName: string
  model?: string
  reason: string
}

export interface OfficeProviderKeyFailoverSignal {
  providerName: string
  fromKeyLabel: string
  toKeyLabel: string
  reason: string
}

export interface OfficeBudgetSignal {
  costUsd: number
  budgetUsd?: number
  remainingUsd?: number
  ratio?: number
  overBudget: boolean
  latestDurationMs?: number
}

export interface OfficeWorkspaceSignal {
  isolated: boolean
  branch?: string
  worktreeState?: 'active' | 'removed'
  worktreePath?: string
  sourceCwd?: string
  changedFiles: number
  insertions: number
  deletions: number
  latestEvent?: 'checkpoint-restore'
  gitOk?: boolean
  gitBranch?: string
  gitFiles?: number
  gitStaged?: number
  gitUnstaged?: number
  gitUntracked?: number
  gitError?: string
}

export interface OfficeSessionSignal {
  routing?: OfficeRoutingSignal
  failover?: OfficeFailoverSignal
  keyFailover?: OfficeProviderKeyFailoverSignal
  budget: OfficeBudgetSignal
  workspace: OfficeWorkspaceSignal
}

export interface OfficeRealtimeSummary {
  routedSessions: number
  failoverSessions: number
  budgetedSessions: number
  overBudgetSessions: number
  totalCostUsd: number
  totalBudgetUsd: number
  totalDurationMs: number
  crossValidationValidators: number
  isolatedSessions: number
  removedWorktrees: number
  workspaceChangedFiles: number
  workspaceInsertions: number
  workspaceDeletions: number
  gitTrackedSessions: number
  gitDirtySessions: number
  gitErroredSessions: number
  gitFiles: number
  gitStaged: number
  gitUnstaged: number
  gitUntracked: number
}

function childStatus(status: string): OfficeTaskStatus {
  if (status === 'error') return 'error'
  if (status === 'running' || status === 'starting') return 'running'
  return 'done'
}

function dagStatus(status: TaskDagTaskStatus): OfficeTaskStatus {
  if (status === 'failed') return 'error'
  if (status === 'running') return 'running'
  if (status === 'success') return 'done'
  return 'pending'
}

function autoMergeStatus(status: TaskDagAutoMergeStatus): OfficeTaskStatus {
  if (status === 'running') return 'running'
  if (status === 'success') return 'done'
  if (status === 'partial') return 'awaiting'
  return 'error'
}

export function officeActivityOf(session: SessionState): OfficeSessionActivity {
  if (session.pendingPermissions.length > 0) return 'awaiting'
  if (session.meta.status === 'running' || session.meta.status === 'starting') return 'working'
  if (session.meta.status === 'error') return 'error'
  const latestTurn = [...session.items].reverse().find((item) => item.kind === 'turn-result')
  if (latestTurn?.kind === 'turn-result') return latestTurn.isError ? 'error' : 'completed'
  return 'idle'
}

export interface OfficeSessionModel {
  sessionId: string
  tasks: OfficeTask[]
  taskStats: OfficeTaskStats
  currentTask?: OfficeTask
  signal: OfficeSessionSignal
}

export interface OfficeModel {
  tasks: OfficeTask[]
  packets: OfficePacket[]
  taskStats: OfficeTaskStats
  currentTask?: OfficeTask
  sessions: Record<string, OfficeSessionModel>
  realtime: OfficeRealtimeSummary
}

const EMPTY_STATS: OfficeTaskStats = {
  total: 0,
  subtasks: 0,
  tools: 0,
  pending: 0,
  running: 0,
  awaiting: 0,
  done: 0,
  error: 0
}

const EMPTY_REALTIME: OfficeRealtimeSummary = {
  routedSessions: 0,
  failoverSessions: 0,
  budgetedSessions: 0,
  overBudgetSessions: 0,
  totalCostUsd: 0,
  totalBudgetUsd: 0,
  totalDurationMs: 0,
  crossValidationValidators: 0,
  isolatedSessions: 0,
  removedWorktrees: 0,
  workspaceChangedFiles: 0,
  workspaceInsertions: 0,
  workspaceDeletions: 0,
  gitTrackedSessions: 0,
  gitDirtySessions: 0,
  gitErroredSessions: 0,
  gitFiles: 0,
  gitStaged: 0,
  gitUnstaged: 0,
  gitUntracked: 0
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function firstLine(v: string): string {
  return v.split(/\r?\n/, 1)[0]?.trim() ?? ''
}

function truncate(v: string, max = 54): string {
  const s = v.trim()
  return s.length <= max ? s : `${s.slice(0, max - 1)}...`
}

function jsonSummary(input: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(input)
    return json && json !== '{}' ? truncate(json, 64) : ''
  } catch {
    return ''
  }
}

function taskKind(name: string): OfficeTaskKind {
  return name === 'Task' || name === 'Agent' ? 'subtask' : 'tool'
}

function taskTitle(name: string, rawInput: unknown): string {
  const input = asRecord(rawInput)
  const lowerName = name.toLowerCase()
  if (lowerName === 'write_file' || lowerName === 'read_file' || lowerName === 'edit_file') {
    return truncate(str(input.path) || str(input.file_path), 72) || name
  }
  if (lowerName === 'bash' || lowerName === 'shell') {
    return truncate(firstLine(str(input.command)), 72) || name
  }
  if (lowerName === 'grep' || lowerName === 'glob') {
    return truncate(str(input.pattern), 72) || name
  }
  switch (name) {
    case 'Task':
    case 'Agent':
      return (
        truncate(str(input.description) || str(input.prompt) || str(input.task) || str(input.subject), 72) ||
        name
      )
    case 'Bash':
      return truncate(firstLine(str(input.command)), 72) || 'Bash'
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return truncate(str(input.file_path) || str(input.notebook_path), 72) || name
    case 'Glob':
    case 'Grep':
      return truncate(str(input.pattern), 72) || name
    case 'WebFetch':
    case 'WebSearch':
      return truncate(str(input.url) || str(input.query), 72) || name
    case 'TodoWrite':
      return '更新待办'
    default:
      return jsonSummary(input) || name
  }
}

function taskStatus(
  toolUseId: string,
  result: ToolResultInfo | undefined,
  runningTools: Record<string, true>,
  awaitingToolUseIds: Set<string>
): OfficeTaskStatus {
  if (awaitingToolUseIds.has(toolUseId)) return 'awaiting'
  if (runningTools[toolUseId]) return 'running'
  if (result) return result.isError ? 'error' : 'done'
  return 'pending'
}

function newStats(): OfficeTaskStats {
  return { ...EMPTY_STATS }
}

function countTask(stats: OfficeTaskStats, task: OfficeTask): void {
  stats.total += 1
  if (task.kind === 'subtask') stats.subtasks += 1
  else stats.tools += 1
  stats[task.status] += 1
}

function mergeStats(into: OfficeTaskStats, from: OfficeTaskStats): void {
  into.total += from.total
  into.subtasks += from.subtasks
  into.tools += from.tools
  into.pending += from.pending
  into.running += from.running
  into.awaiting += from.awaiting
  into.done += from.done
  into.error += from.error
}

function currentTask(tasks: OfficeTask[]): OfficeTask | undefined {
  const score: Record<OfficeTaskStatus, number> = {
    awaiting: 5,
    running: 4,
    pending: 3,
    error: 2,
    done: 1
  }
  return [...tasks].sort((a, b) => score[b.status] - score[a.status] || b.order - a.order)[0]
}

function collectSessionTasks(sessionId: string, session: SessionState): OfficeTask[] {
  const awaitingToolUseIds = new Set(
    session.pendingPermissions.map((p) => p.toolUseId).filter((id): id is string => Boolean(id))
  )
  const tasks: OfficeTask[] = []
  const seenToolUseIds = new Set<string>()
  let order = 0

  for (const item of session.items) {
    if (item.kind !== 'assistant') continue
    for (const block of item.blocks) {
      if (block.type !== 'tool_use') continue
      const result = session.toolResults[block.id]
      const task: OfficeTask = {
        id: `${sessionId}:${block.id}`,
        sessionId,
        itemId: item.id,
        toolUseId: block.id,
        kind: taskKind(block.name),
        toolName: block.name,
        title: taskTitle(block.name, block.input),
        status: taskStatus(block.id, result, session.runningTools, awaitingToolUseIds),
        order: order++
      }
      tasks.push(task)
      seenToolUseIds.add(block.id)
    }
  }

  for (const toolUseId of Object.keys(session.runningTools)) {
    if (seenToolUseIds.has(toolUseId)) continue
    tasks.push({
      id: `${sessionId}:${toolUseId}`,
      sessionId,
      toolUseId,
      kind: 'tool',
      toolName: 'Tool',
      title: `Tool ${toolUseId.slice(0, 8)}`,
      status: awaitingToolUseIds.has(toolUseId) ? 'awaiting' : 'running',
      order: order++
    })
    seenToolUseIds.add(toolUseId)
  }

  for (const [toolUseId, result] of Object.entries(session.toolResults)) {
    if (seenToolUseIds.has(toolUseId)) continue
    tasks.push({
      id: `${sessionId}:${toolUseId}`,
      sessionId,
      toolUseId,
      kind: 'tool',
      toolName: 'Tool',
      title: `Tool ${toolUseId.slice(0, 8)}`,
      status: result.isError ? 'error' : 'done',
      order: order++
    })
    seenToolUseIds.add(toolUseId)
  }

  for (const permission of session.pendingPermissions) {
    if (permission.toolUseId && seenToolUseIds.has(permission.toolUseId)) continue
    tasks.push({
      id: `${sessionId}:permission:${permission.requestId}`,
      sessionId,
      toolUseId: permission.toolUseId,
      kind: taskKind(permission.toolName),
      toolName: permission.toolName,
      title: taskTitle(permission.toolName, permission.input),
      status: 'awaiting',
      order: order++
    })
  }

  if (session.taskDagExecution) {
    for (const dagTask of session.taskDagExecution.tasks) {
      tasks.push({
        id: `${sessionId}:dag:${session.taskDagExecution.id}:${dagTask.task.id}:${dagTask.status}`,
        sessionId,
        kind: 'subtask',
        toolName: 'DAG',
        title: dagTask.task.title,
        status: dagStatus(dagTask.status),
        order: order++
      })
    }

    const autoMerge = session.taskDagExecution.autoMerge
    if (autoMerge) {
      tasks.push({
        id: `${sessionId}:dag:${session.taskDagExecution.id}:auto-merge:${autoMerge.status}`,
        sessionId,
        kind: 'subtask',
        toolName: 'AutoMerge',
        title: autoMerge.summary || 'DAG 自动合并',
        status: autoMergeStatus(autoMerge.status),
        order: order++
      })
    }
  }

  return tasks
}

function statsFor(tasks: OfficeTask[]): OfficeTaskStats {
  const stats = newStats()
  for (const task of tasks) countTask(stats, task)
  return stats
}

function latestRoutingSignal(session: SessionState): OfficeRoutingSignal | undefined {
  for (let i = session.items.length - 1; i >= 0; i--) {
    const item = session.items[i]
    if (item.kind !== 'routing') continue
    return {
      providerId: item.providerId,
      providerName: item.providerName ?? item.decision?.providerName,
      model: item.model,
      reason: item.reason,
      basis: item.decision?.selectionReason,
      strategy: item.decision?.strategy,
      taskKinds: item.decision?.taskKinds ?? [],
      riskLevel: item.decision?.riskLevel,
      budgetDowngraded: Boolean(item.decision?.budgetDowngraded),
      validators: item.crossValidationPlan?.validators.length ?? 0,
      crossValidationEnabled: Boolean(item.crossValidationPlan?.enabled)
    }
  }
  return undefined
}

function latestFailoverSignal(session: SessionState): OfficeFailoverSignal | undefined {
  for (let i = session.items.length - 1; i >= 0; i--) {
    const item = session.items[i]
    if (item.kind !== 'failover') continue
    return {
      fromName: item.fromName,
      toName: item.toName,
      model: item.model,
      reason: item.reason
    }
  }
  return undefined
}

function latestProviderKeyFailoverSignal(session: SessionState): OfficeProviderKeyFailoverSignal | undefined {
  for (let i = session.items.length - 1; i >= 0; i--) {
    const item = session.items[i]
    if (item.kind !== 'provider-key-failover') continue
    return {
      providerName: item.providerName,
      fromKeyLabel: item.fromKeyLabel,
      toKeyLabel: item.toKeyLabel,
      reason: item.reason
    }
  }
  return undefined
}

function latestTurnDurationMs(session: SessionState): number | undefined {
  for (let i = session.items.length - 1; i >= 0; i--) {
    const item = session.items[i]
    if (item.kind !== 'turn-result') continue
    return item.durationMs
  }
  return undefined
}

function latestWorkspaceSignal(session: SessionState, gitStatus?: GitStatus): OfficeWorkspaceSignal {
  let changedFiles = 0
  let insertions = 0
  let deletions = 0
  let latestEvent: OfficeWorkspaceSignal['latestEvent']
  for (let i = session.items.length - 1; i >= 0; i--) {
    const item = session.items[i]
    if (item.kind !== 'workspace') continue
    changedFiles = item.filesChanged.length
    insertions = item.insertions ?? 0
    deletions = item.deletions ?? 0
    latestEvent = item.event
    break
  }
  const gitFiles = gitStatus?.ok ? gitStatus.files.length : undefined
  const gitStaged = gitStatus?.ok ? gitStatus.staged : undefined
  const gitUnstaged = gitStatus?.ok ? gitStatus.unstaged : undefined
  const gitUntracked = gitStatus?.ok ? gitStatus.untracked : undefined
  return {
    isolated: Boolean(session.meta.isolated),
    branch: session.meta.branch,
    worktreeState: session.meta.worktreeState,
    worktreePath: session.meta.worktreePath,
    sourceCwd: session.meta.sourceCwd,
    changedFiles: gitFiles ?? changedFiles,
    insertions,
    deletions,
    latestEvent,
    gitOk: gitStatus ? gitStatus.ok : undefined,
    gitBranch: gitStatus?.ok ? gitStatus.branch : undefined,
    gitFiles,
    gitStaged,
    gitUnstaged,
    gitUntracked,
    gitError: gitStatus && !gitStatus.ok ? gitStatus.error : undefined
  }
}

function sessionSignal(session: SessionState, gitStatus?: GitStatus): OfficeSessionSignal {
  const costUsd = Math.max(0, num(session.meta.costUsd) ?? 0)
  const budgetUsd = num(session.meta.budgetUsd)
  const hasBudget = budgetUsd !== undefined && budgetUsd > 0
  const remainingUsd = hasBudget ? Math.max(0, budgetUsd - costUsd) : undefined
  const ratio = hasBudget ? Math.min(1, costUsd / budgetUsd) : undefined
  return {
    routing: latestRoutingSignal(session),
    failover: latestFailoverSignal(session),
    keyFailover: latestProviderKeyFailoverSignal(session),
    budget: {
      costUsd,
      budgetUsd: hasBudget ? budgetUsd : undefined,
      remainingUsd,
      ratio,
      overBudget: Boolean(hasBudget && costUsd >= budgetUsd),
      latestDurationMs: latestTurnDurationMs(session)
    },
    workspace: latestWorkspaceSignal(session, gitStatus)
  }
}

function mergeRealtime(into: OfficeRealtimeSummary, signal: OfficeSessionSignal): void {
  if (signal.routing) {
    into.routedSessions += 1
    into.crossValidationValidators += signal.routing.validators
  }
  if (signal.failover) into.failoverSessions += 1
  if (signal.budget.budgetUsd && signal.budget.budgetUsd > 0) {
    into.budgetedSessions += 1
    into.totalBudgetUsd += signal.budget.budgetUsd
  }
  if (signal.budget.overBudget) into.overBudgetSessions += 1
  into.totalCostUsd += signal.budget.costUsd
  into.totalDurationMs += signal.budget.latestDurationMs ?? 0
  if (signal.workspace.isolated) into.isolatedSessions += 1
  if (signal.workspace.worktreeState === 'removed') into.removedWorktrees += 1
  into.workspaceChangedFiles += signal.workspace.changedFiles
  into.workspaceInsertions += signal.workspace.insertions
  into.workspaceDeletions += signal.workspace.deletions
  if (signal.workspace.gitOk === true) {
    into.gitTrackedSessions += 1
    into.gitFiles += signal.workspace.gitFiles ?? 0
    into.gitStaged += signal.workspace.gitStaged ?? 0
    into.gitUnstaged += signal.workspace.gitUnstaged ?? 0
    into.gitUntracked += signal.workspace.gitUntracked ?? 0
    if ((signal.workspace.gitFiles ?? 0) > 0) into.gitDirtySessions += 1
  } else if (signal.workspace.gitOk === false) {
    into.gitErroredSessions += 1
  }
}

function packetFor(task: OfficeTask, stationIndex: number): OfficePacket | undefined {
  if (task.status !== 'running' && task.status !== 'awaiting') return undefined
  return {
    id: task.id,
    sessionId: task.sessionId,
    from: stationIndex,
    to: stationIndex,
    kind: task.kind,
    status: task.status,
    label: task.title,
    toolName: task.toolName
  }
}

export function buildOfficeModel(
  ids: string[],
  sessions: Record<string, SessionState>,
  gitStatuses: Record<string, GitStatus | undefined> = {}
): OfficeModel {
  const bySession: Record<string, OfficeSessionModel> = {}
  const allTasks: OfficeTask[] = []
  const packets: OfficePacket[] = []
  const totalStats = newStats()
  const realtime: OfficeRealtimeSummary = { ...EMPTY_REALTIME }
  const stationBySession = new Map(ids.map((id, index) => [id, index] as const))

  ids.forEach((sessionId, stationIndex) => {
    const session = sessions[sessionId]
    if (!session) return
    const tasks = collectSessionTasks(sessionId, session)
    const taskStats = statsFor(tasks)
    const active = currentTask(tasks)
    const signal = sessionSignal(session, gitStatuses[sessionId])
    bySession[sessionId] = { sessionId, tasks, taskStats, currentTask: active, signal }
    allTasks.push(...tasks)
    mergeStats(totalStats, taskStats)
    mergeRealtime(realtime, signal)
    for (const task of tasks) {
      const packet = packetFor(task, stationIndex)
      if (packet) packets.push(packet)
    }
  })

  ids.forEach((sessionId) => {
    const session = sessions[sessionId]
    const parentId = session?.meta.parentSessionId
    if (!session || !parentId) return
    const from = stationBySession.get(parentId)
    const to = stationBySession.get(sessionId)
    if (from === undefined || to === undefined) return
    packets.push({
      id: `subagent:${parentId}:${sessionId}:${session.meta.status}`,
      sessionId,
      from,
      to,
      kind: 'subtask',
      status: childStatus(session.meta.status),
      label: session.meta.childRole || session.meta.childTaskId || session.meta.title,
      toolName: 'Subagent'
    })
  })

  return {
    tasks: allTasks,
    packets,
    taskStats: totalStats,
    currentTask: currentTask(allTasks),
    sessions: bySession,
    realtime
  }
}
