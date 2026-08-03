import type {
  AgentEvent,
  SessionMeta,
  SubagentDispatchItem
} from '../../shared/types'

interface SubagentOrchestrationResult {
  taskId?: string
  role?: string
  sessionId: string
  ok: boolean
  resultText?: string
  costUsd?: number
  branch?: string
  worktreePath?: string
}

export interface SubagentOrchestrationState {
  parentSessionId: string
  acceptingChildren: boolean
  pending: Set<string>
  results: SubagentOrchestrationResult[]
  startedAt: number
  summaryText?: string
  delivering: boolean
  retryScheduled: boolean
  synchronousFailure?: string
}

interface SubagentOrchestrationDependencies {
  send(sessionId: string, prompt: string): Promise<boolean>
  getMeta(sessionId: string): SessionMeta | undefined
  emit(sessionId: string, event: AgentEvent): void
  acknowledgeSessionCreation(sessionId: string): void
  schedule?(callback: () => void): void
  now?(): number
}

/** Coordinates legacy free-form subagents without losing rejected prompts or parent summaries. */
export class SubagentOrchestrationCoordinator {
  private readonly plans = new Map<string, SubagentOrchestrationState>()

  constructor(private readonly dependencies: SubagentOrchestrationDependencies) {}

  begin(orchestrationId: string, parentSessionId: string): void {
    if (this.plans.has(orchestrationId)) throw new Error(`子代理编排已存在: ${orchestrationId}`)
    this.plans.set(orchestrationId, {
      parentSessionId,
      acceptingChildren: true,
      pending: new Set(),
      results: [],
      startedAt: this.now(),
      delivering: false,
      retryScheduled: false
    })
  }

  addChild(orchestrationId: string, childSessionId: string): void {
    const state = this.requirePlan(orchestrationId)
    if (!state.acceptingChildren) throw new Error(`子代理编排已结束创建阶段: ${orchestrationId}`)
    state.pending.add(childSessionId)
  }

  cancel(orchestrationId: string): void {
    this.plans.delete(orchestrationId)
  }

  async finishProvisioning(orchestrationId: string, children: SubagentDispatchItem[]): Promise<void> {
    const state = this.requirePlan(orchestrationId)
    state.acceptingChildren = false
    for (const child of children) await this.dispatchChild(orchestrationId, state, child)
    await this.tryDeliver(orchestrationId, state)
  }

  recordChildResult(
    childMeta: SessionMeta,
    event: Extract<AgentEvent, { kind: 'turn-result' }>
  ): void {
    const orchestrationId = childMeta.orchestrationId
    if (!orchestrationId) return
    const state = this.plans.get(orchestrationId)
    if (!state || !state.pending.has(childMeta.id)) return
    void this.completeChild(orchestrationId, state, childMeta, {
      taskId: childMeta.childTaskId,
      role: childMeta.childRole,
      sessionId: childMeta.id,
      ok: !event.isError,
      resultText: event.resultText,
      costUsd: childMeta.costUsd,
      branch: childMeta.branch,
      worktreePath: childMeta.worktreePath
    })
  }

  handleEvent(sessionId: string, event: AgentEvent): void {
    for (const [orchestrationId, state] of this.plans) {
      if (state.parentSessionId !== sessionId || event.kind !== 'status') continue
      if (event.status === 'closed') {
        this.plans.delete(orchestrationId)
        continue
      }
      if (state.delivering) {
        if (event.status === 'error') {
          state.synchronousFailure = event.error ?? '父会话执行引擎同步拒绝汇总消息'
        }
        continue
      }
      if (event.status === 'idle' || event.status === 'error') {
        this.scheduleRetry(orchestrationId, state)
      }
    }
  }

  hasPendingChild(orchestrationId: string, childSessionId: string): boolean {
    return this.plans.get(orchestrationId)?.pending.has(childSessionId) ?? false
  }

  states(): SubagentOrchestrationState[] {
    return [...this.plans.values()]
  }

  clear(): void {
    this.plans.clear()
  }

  private async dispatchChild(
    orchestrationId: string,
    state: SubagentOrchestrationState,
    child: SubagentDispatchItem
  ): Promise<void> {
    let accepted = false
    let thrown: unknown
    try {
      accepted = await this.dependencies.send(child.meta.id, child.prompt)
    } catch (error) {
      thrown = error
    }
    if (accepted) return

    const reason = thrown
      ? errorText(thrown)
      : this.dependencies.getMeta(child.meta.id)?.lastError ?? 'SessionManager 拒绝了子任务首条指令'
    const resultText = `子任务首条指令未被接受: ${cleanOneLine(reason)}`
    this.dependencies.emit(state.parentSessionId, {
      kind: 'subagent-result',
      orchestrationId,
      childTaskId: child.meta.childTaskId,
      childSessionId: child.meta.id,
      childRole: child.meta.childRole,
      status: 'error',
      resultText
    })
    this.dependencies.emit(state.parentSessionId, {
      kind: 'hook-event',
      event: 'subagent-dispatch-rejected',
      detail: `子任务 ${child.taskId} 首条指令未被接受,已记为失败并继续收口。原因:${cleanOneLine(reason)}`
    })
    await this.completeChild(orchestrationId, state, child.meta, {
      taskId: child.meta.childTaskId ?? child.taskId,
      role: child.meta.childRole,
      sessionId: child.meta.id,
      ok: false,
      resultText,
      costUsd: child.meta.costUsd,
      branch: child.meta.branch,
      worktreePath: child.meta.worktreePath
    })
  }

  private async completeChild(
    orchestrationId: string,
    state: SubagentOrchestrationState,
    childMeta: SessionMeta,
    result: SubagentOrchestrationResult
  ): Promise<void> {
    if (!state.pending.delete(childMeta.id)) return
    state.results.push(result)
    this.dependencies.acknowledgeSessionCreation(childMeta.id)
    await this.tryDeliver(orchestrationId, state)
  }

  private async tryDeliver(orchestrationId: string, state: SubagentOrchestrationState): Promise<void> {
    if (this.plans.get(orchestrationId) !== state || state.acceptingChildren || state.pending.size > 0 || state.delivering) return
    const parent = this.dependencies.getMeta(state.parentSessionId)
    if (!parent || parent.status === 'closed') {
      this.plans.delete(orchestrationId)
      return
    }
    if (parent.status === 'running' || parent.status === 'starting') return

    state.summaryText ??= buildSummary(state, this.now())
    state.delivering = true
    state.synchronousFailure = undefined
    let accepted = false
    let thrown: unknown
    try {
      accepted = await this.dependencies.send(state.parentSessionId, state.summaryText)
    } catch (error) {
      thrown = error
    } finally {
      state.delivering = false
    }
    if (accepted && !state.synchronousFailure) {
      this.plans.delete(orchestrationId)
      return
    }

    const reason = thrown
      ? errorText(thrown)
      : state.synchronousFailure ?? this.dependencies.getMeta(state.parentSessionId)?.lastError ?? 'SessionManager 拒绝了编排汇总消息'
    this.dependencies.emit(state.parentSessionId, {
      kind: 'hook-event',
      event: 'subagent-summary-delivery-rejected',
      detail: `子代理编排 ${orchestrationId} 汇总未送达,已保留并等待父会话恢复后重试。原因:${cleanOneLine(reason)}`
    })
  }

  private scheduleRetry(orchestrationId: string, state: SubagentOrchestrationState): void {
    if (state.retryScheduled || state.pending.size > 0 || state.acceptingChildren) return
    state.retryScheduled = true
    const run = () => {
      state.retryScheduled = false
      void this.tryDeliver(orchestrationId, state)
    }
    if (this.dependencies.schedule) this.dependencies.schedule(run)
    else queueMicrotask(run)
  }

  private requirePlan(orchestrationId: string): SubagentOrchestrationState {
    const state = this.plans.get(orchestrationId)
    if (!state) throw new Error(`子代理编排不存在: ${orchestrationId}`)
    return state
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now()
  }
}

function buildSummary(state: SubagentOrchestrationState, completedAt: number): string {
  const okCount = state.results.filter((result) => result.ok).length
  const lines: string[] = [
    `[子代理编排完成] ${okCount}/${state.results.length} 成功,耗时 ${Math.round((completedAt - state.startedAt) / 1000)}s。各任务结果:`,
    ''
  ]
  for (const result of state.results) {
    lines.push(`## ${result.taskId ?? result.sessionId}${result.role ? `(${result.role})` : ''} — ${result.ok ? '成功' : '失败'}`)
    if (result.branch) lines.push(`分支: ${result.branch}`)
    if (result.worktreePath) lines.push(`worktree: ${result.worktreePath}`)
    if (result.resultText) lines.push(`结果摘要:\n${result.resultText.slice(0, 1500)}`)
    lines.push('')
  }
  lines.push('请汇总以上子任务结果:指出成功/失败与冲突风险,给出合并顺序建议;如需修复失败项或追加任务,说明具体做法。')
  return lines.join('\n')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function cleanOneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 240)
}
