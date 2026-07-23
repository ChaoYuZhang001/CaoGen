import type { ModelAttemptRecord } from '../../shared/model-attempt-types'
import type { UsageTotals } from '../../shared/types'
import {
  beginPersistedModelAttempt,
  classifyRuntimeModelFailure,
  modelAttemptUsage,
  ModelAttemptPersistenceError,
  type PersistedModelAttemptHandle,
  type RuntimeModelAttemptDependencies,
  type RuntimeModelKeyIdentity,
  type RuntimeModelAttemptFailure
} from './model-attempt-runtime'

export const CLAUDE_MODEL_ATTEMPT_PROTOCOL = 'claude-agent-sdk.turn'
export const CLAUDE_MODEL_ATTEMPT_ADAPTER_VERSION = 'claude-agent-sdk-v1'

export interface ClaudeModelAttemptBeginInput {
  runId?: string
  stepId?: string
  generation: number
  providerId: string
  model: string
  context: unknown
  routeReason: string
  keyIdentity?: RuntimeModelKeyIdentity
  rootDir?: string
}

export interface ClaudeModelAttemptCompletionInput {
  generation: number
  usage?: UsageTotals
  totalCostUsd?: number
}

export interface ClaudeModelAttemptFailureInput extends ClaudeModelAttemptCompletionInput {
  error: unknown
  timedOut?: boolean
}

export interface ClaudeModelAttemptCancellationInput {
  generation: number
  cause?: unknown
}

interface ActiveClaudeModelAttempt {
  generation: number
  logicalKey: string
  handle: PersistedModelAttemptHandle
  interrupted: boolean
  settling: boolean
}

interface ClaudeModelAttemptPredecessor {
  attemptId: string
  requestId: string
}

export class ClaudeModelAttemptTracker {
  private active?: ActiveClaudeModelAttempt
  private readonly predecessors = new Map<string, ClaudeModelAttemptPredecessor>()
  private readonly abandoned = new Map<string, ModelAttemptRecord>()
  private cumulativeCostUsd?: number

  constructor(private readonly dependencies?: Partial<RuntimeModelAttemptDependencies>) {}

  get activeAttempt(): ModelAttemptRecord | undefined {
    return this.active?.handle.attempt
  }

  async beginTurn(input: ClaudeModelAttemptBeginInput): Promise<ModelAttemptRecord> {
    const runId = requiredIdentity(input.runId, 'active TaskRun is missing for Claude turn')
    const stepId = requiredIdentity(input.stepId, 'active TaskStep is missing for Claude turn')
    const generation = requiredGeneration(input.generation)
    const logicalKey = claudeLogicalKey(runId, stepId)
    if (this.active) {
      throw startStateError(
        `Claude turn ${this.active.handle.attempt.id} is still active; concurrent turns are not allowed`,
        this.active.handle.attempt.id
      )
    }
    const unresolved = this.abandoned.get(logicalKey)
    if (unresolved) {
      throw startStateError(
        `Claude turn ${unresolved.id} has an unknown result and requires reconciliation`,
        unresolved.id
      )
    }

    const predecessor = this.predecessors.get(logicalKey)
    const requestId = predecessor?.requestId ?? `model-request:${runId}:${stepId}`
    const handle = await beginPersistedModelAttempt({
      runId,
      requestId,
      stepId,
      providerId: input.providerId,
      model: input.model,
      protocol: CLAUDE_MODEL_ATTEMPT_PROTOCOL,
      adapterVersion: CLAUDE_MODEL_ATTEMPT_ADAPTER_VERSION,
      context: input.context,
      routeReason: predecessor
        ? `${input.routeReason}; retry/failover predecessor recorded`
        : input.routeReason,
      keyIdentity: input.keyIdentity,
      failoverFromAttemptId: predecessor?.attemptId,
      rootDir: input.rootDir
    }, { dependencies: this.dependencies })

    this.active = { generation, logicalKey, handle, interrupted: false, settling: false }
    if (predecessor) this.predecessors.delete(logicalKey)
    return handle.attempt
  }

  markInterrupted(generation: number): void {
    if (this.active?.generation === generation) this.active.interrupted = true
  }

  async completeTurn(
    input: ClaudeModelAttemptCompletionInput
  ): Promise<ModelAttemptRecord | undefined> {
    const active = this.current(input.generation)
    if (!active) return undefined
    active.settling = true
    const cost = this.costCompletion(input.totalCostUsd)
    const completion = {
      usage: claudeModelAttemptUsage(input.usage),
      costUsd: cost.delta
    }
    const record = active.interrupted
      ? await active.handle.fail({ status: 'cancelled', outcome: 'cancelled', ...completion })
      : await active.handle.succeed(completion)
    this.finish(active, cost.total)
    return record
  }

  async failTurn(input: ClaudeModelAttemptFailureInput): Promise<ModelAttemptRecord | undefined> {
    const active = this.current(input.generation)
    if (!active) return undefined
    active.settling = true
    const cost = this.costCompletion(input.totalCostUsd)
    const classified: RuntimeModelAttemptFailure = active.interrupted
      ? { status: 'cancelled', outcome: 'cancelled' }
      : classifyRuntimeModelFailure(input.error, { timedOut: input.timedOut })
    const failure: RuntimeModelAttemptFailure = {
      ...classified,
      usage: claudeModelAttemptUsage(input.usage),
      costUsd: cost.delta
    }
    const record = await active.handle.fail(failure, input.error)
    this.finish(active, cost.total, failure.status === 'failed')
    return record
  }

  async cancelTurn(
    input: ClaudeModelAttemptCancellationInput
  ): Promise<ModelAttemptRecord | undefined> {
    const active = this.current(input.generation)
    if (!active) return undefined
    active.interrupted = true
    active.settling = true
    const record = await active.handle.cancel(input.cause)
    this.finish(active, undefined)
    return record
  }

  abandonGeneration(generation: number): ModelAttemptRecord | undefined {
    const active = this.current(generation)
    if (!active) return undefined
    if (active.settling) return undefined
    const attempt = active.handle.attempt
    this.active = undefined
    this.abandoned.set(active.logicalKey, attempt)
    return attempt
  }

  private current(generation: number): ActiveClaudeModelAttempt | undefined {
    return this.active?.generation === generation ? this.active : undefined
  }

  private costCompletion(totalCostUsd: number | undefined): {
    delta?: number
    total?: number
  } {
    const total = nonNegativeFinite(totalCostUsd)
    return {
      delta: claudeModelAttemptCostDelta(this.cumulativeCostUsd, total),
      total
    }
  }

  private finish(
    active: ActiveClaudeModelAttempt,
    cumulativeCostUsd: number | undefined,
    rememberPredecessor = false
  ): void {
    if (this.active !== active) return
    this.active = undefined
    if (cumulativeCostUsd !== undefined) this.cumulativeCostUsd = cumulativeCostUsd
    if (rememberPredecessor) {
      this.predecessors.set(active.logicalKey, {
        attemptId: active.handle.attempt.id,
        requestId: active.handle.attempt.requestId
      })
    }
  }
}

export function claudeModelAttemptUsage(input: UsageTotals | undefined) {
  return modelAttemptUsage(input === undefined ? undefined : {
    input: input.input,
    output: input.output,
    cacheRead: input.cacheRead,
    cacheWrite: input.cacheCreation
  })
}

export function claudeModelAttemptCostDelta(
  previousCumulativeUsd: number | undefined,
  currentCumulativeUsd: number | undefined
): number | undefined {
  const current = nonNegativeFinite(currentCumulativeUsd)
  if (current === undefined) return undefined
  const previous = nonNegativeFinite(previousCumulativeUsd)
  if (previous === undefined || current < previous) return current
  return current - previous
}

function requiredIdentity(value: string | undefined, message: string): string {
  const normalized = value?.trim()
  if (normalized) return normalized
  throw startStateError(message)
}

function requiredGeneration(value: number): number {
  if (Number.isSafeInteger(value) && value >= 0) return value
  throw startStateError('Claude engine generation is invalid')
}

function claudeLogicalKey(runId: string, stepId: string): string {
  return `${runId}\u0000${stepId}`
}

function startStateError(message: string, attemptId?: string): ModelAttemptPersistenceError {
  return new ModelAttemptPersistenceError('start', false, attemptId, new Error(message))
}

function nonNegativeFinite(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
