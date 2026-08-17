import type { SessionMeta, TaskDagExecutionView } from '../../shared/types'
import {
  MAX_ACTIVE_AGENT_COUNT,
  MAX_ACTIVE_CHILD_AGENTS,
  MAX_ACTIVE_CHILD_AGENTS_PER_PRIMARY,
  MAX_ACTIVE_PRIMARY_AGENTS
} from '../../shared/agent-capacity-policy'

interface CapacityScheduler {
  view(): TaskDagExecutionView
  resume(): Promise<unknown>
}

interface CapacityOrchestrationState {
  parentSessionId: string
  pending: ReadonlySet<string>
}

interface AgentCapacityDependencies {
  schedulers(): Iterable<CapacityScheduler>
  orchestrations(): Iterable<CapacityOrchestrationState>
  sessions(): Iterable<SessionMeta>
}

interface AgentCapacitySnapshot {
  total: number
  byParent: Map<string, number>
}

export type AgentCapacityRelease = (count?: number) => void

/** Owns the desktop 3-primary + 6-child admission boundary across every DAG and direct dispatch. */
export class AgentCapacityCoordinator {
  private readonly directReservations = new Map<string, number>()
  private drain: Promise<void> | undefined

  constructor(private readonly dependencies: AgentCapacityDependencies) {}

  has(parentSessionId: string, count = 1): boolean {
    const capacity = this.snapshot()
    const parentActive = (capacity.byParent.get(parentSessionId) ?? 0) > 0
    return (parentActive || capacity.byParent.size < MAX_ACTIVE_PRIMARY_AGENTS) &&
      capacity.total + count <= MAX_ACTIVE_CHILD_AGENTS &&
      (capacity.byParent.get(parentSessionId) ?? 0) + count <= MAX_ACTIVE_CHILD_AGENTS_PER_PRIMARY
  }

  tryReserve(parentSessionId: string, count = 1): AgentCapacityRelease | undefined {
    if (!this.has(parentSessionId, count)) return undefined
    this.directReservations.set(parentSessionId, (this.directReservations.get(parentSessionId) ?? 0) + count)
    let remaining = count
    return (requested = remaining): void => {
      const released = Math.min(remaining, Math.max(0, requested))
      if (released === 0) return
      remaining -= released
      this.releaseDirect(parentSessionId, released)
    }
  }

  reserveDirect(parentSessionId: string, count: number): AgentCapacityRelease {
    const release = this.tryReserve(parentSessionId, count)
    if (!release) {
      throw new Error(
        `Agent 活跃席位已满（${MAX_ACTIVE_PRIMARY_AGENTS} 个主 Agent + ` +
        `${MAX_ACTIVE_CHILD_AGENTS} 个子 Agent = ${MAX_ACTIVE_AGENT_COUNT} 个）；` +
        '更多任务请使用 DAG 排队'
      )
    }
    return release
  }

  private releaseDirect(parentSessionId: string, count: number): void {
    if (count <= 0) return
    const next = Math.max(0, (this.directReservations.get(parentSessionId) ?? 0) - count)
    if (next === 0) this.directReservations.delete(parentSessionId)
    else this.directReservations.set(parentSessionId, next)
  }

  scheduleDrain(): Promise<void> {
    if (this.drain) return this.drain
    this.drain = Promise.resolve()
      .then(async () => {
        for (const scheduler of this.dependencies.schedulers()) {
          if (this.snapshot().total >= MAX_ACTIVE_CHILD_AGENTS) break
          await scheduler.resume()
        }
      })
      .catch((error) => {
        console.error('[caogen] queued DAG capacity drain failed:', error)
      })
      .finally(() => {
        this.drain = undefined
      })
    return this.drain
  }

  clear(): void {
    this.directReservations.clear()
    this.drain = undefined
  }

  private snapshot(): AgentCapacitySnapshot {
    const owners = new Map<string, string>()
    const add = (key: string, parentSessionId: string): void => {
      if (!owners.has(key)) owners.set(key, parentSessionId)
    }

    for (const scheduler of this.dependencies.schedulers()) {
      const execution = scheduler.view()
      for (const task of execution.tasks) {
        if (task.status !== 'running') continue
        const sessionId = task.sessionIds[task.sessionIds.length - 1]
        add(sessionId ? `session:${sessionId}` : `dag:${execution.id}:${task.task.id}`, execution.parentSessionId)
      }
    }
    for (const state of this.dependencies.orchestrations()) {
      for (const sessionId of state.pending) add(`session:${sessionId}`, state.parentSessionId)
    }
    for (const session of this.dependencies.sessions()) {
      if (!session.parentSessionId || (session.status !== 'starting' && session.status !== 'running')) continue
      add(`session:${session.id}`, session.parentSessionId)
    }

    const byParent = new Map<string, number>()
    for (const parentSessionId of owners.values()) {
      byParent.set(parentSessionId, (byParent.get(parentSessionId) ?? 0) + 1)
    }
    let total = owners.size
    for (const [parentSessionId, count] of this.directReservations) {
      total += count
      byParent.set(parentSessionId, (byParent.get(parentSessionId) ?? 0) + count)
    }
    return { total, byParent }
  }
}
