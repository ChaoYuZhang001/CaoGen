import type { SessionState, ToolResultInfo } from '../../store'

export type OfficeTaskKind = 'subtask' | 'tool'
export type OfficeTaskStatus = 'pending' | 'running' | 'awaiting' | 'done' | 'error'

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

export interface OfficeSessionModel {
  sessionId: string
  tasks: OfficeTask[]
  taskStats: OfficeTaskStats
  currentTask?: OfficeTask
}

export interface OfficeModel {
  tasks: OfficeTask[]
  packets: OfficePacket[]
  taskStats: OfficeTaskStats
  currentTask?: OfficeTask
  sessions: Record<string, OfficeSessionModel>
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

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
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

  return tasks
}

function statsFor(tasks: OfficeTask[]): OfficeTaskStats {
  const stats = newStats()
  for (const task of tasks) countTask(stats, task)
  return stats
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

export function buildOfficeModel(ids: string[], sessions: Record<string, SessionState>): OfficeModel {
  const bySession: Record<string, OfficeSessionModel> = {}
  const allTasks: OfficeTask[] = []
  const packets: OfficePacket[] = []
  const totalStats = newStats()

  ids.forEach((sessionId, stationIndex) => {
    const session = sessions[sessionId]
    if (!session) return
    const tasks = collectSessionTasks(sessionId, session)
    const taskStats = statsFor(tasks)
    const active = currentTask(tasks)
    bySession[sessionId] = { sessionId, tasks, taskStats, currentTask: active }
    allTasks.push(...tasks)
    mergeStats(totalStats, taskStats)
    for (const task of tasks) {
      const packet = packetFor(task, stationIndex)
      if (packet) packets.push(packet)
    }
  })

  return {
    tasks: allTasks,
    packets,
    taskStats: totalStats,
    currentTask: currentTask(allTasks),
    sessions: bySession
  }
}
