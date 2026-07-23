import type { ModelAttemptRecord } from '../../shared/model-attempt-types'
import type { StableMessagePayload } from '../stable-message-payload'
import { ClaudeModelAttemptTracker } from './claude-model-attempt-runtime'

export const DEFAULT_CLAUDE_ROUTE_REASON = 'Session uses the configured Claude provider and model'

interface InterruptSettlement {
  generation: number
  promise: Promise<void>
  resolve: () => void
}

export class ClaudeAgentSessionTurnRuntime {
  private settlementQueue: Promise<unknown> = Promise.resolve()
  private routeReason = DEFAULT_CLAUDE_ROUTE_REASON
  private activeSdkModel = ''
  private routedModel = ''
  private currentPayload: StableMessagePayload | null = null
  private readonly queuedPayloads: StableMessagePayload[] = []
  private interruptedGeneration?: number
  private interruptSettlement?: InterruptSettlement

  constructor(readonly attempts: ClaudeModelAttemptTracker) {}

  get activePayload(): StableMessagePayload | null {
    return this.currentPayload
  }

  get activeInterruptGeneration(): number | undefined {
    return this.interruptedGeneration
  }

  get activeModelForStats(): string {
    return this.routedModel
  }

  get attemptRouteReason(): string {
    return this.routeReason
  }

  get queuedCount(): number {
    return this.queuedPayloads.length
  }

  canReplay(payload: StableMessagePayload): boolean {
    return this.currentPayload === payload && this.interruptedGeneration === undefined
  }

  beginPayload(payload: StableMessagePayload, autoModel: boolean): void {
    this.currentPayload = payload
    this.routeReason = DEFAULT_CLAUDE_ROUTE_REASON
    if (autoModel) this.clearVerifiedModel()
  }

  enqueue(payload: StableMessagePayload): void {
    this.queuedPayloads.push(payload)
  }

  takeNextQueued(): StableMessagePayload | undefined {
    return this.queuedPayloads.shift()
  }

  cancelQueued(): StableMessagePayload[] {
    return this.queuedPayloads.splice(0)
  }

  clearCurrent(): StableMessagePayload | null {
    const payload = this.currentPayload
    this.currentPayload = null
    return payload
  }

  appendRouteReason(reason: string): void {
    const normalized = reason.trim()
    if (!normalized) return
    this.routeReason = this.routeReason === DEFAULT_CLAUDE_ROUTE_REASON
      ? normalized
      : `${this.routeReason}; ${normalized}`
  }

  rememberVerifiedModel(model: string): void {
    this.activeSdkModel = model
    this.routedModel = model
  }

  modelForAttempt(configuredModel: string, autoModel: string): string {
    const model = configuredModel && configuredModel !== autoModel
      ? configuredModel
      : this.routedModel || this.activeSdkModel
    if (!model.trim()) throw new Error('active Claude model is missing for durable ModelAttempt')
    return model
  }

  advanceGeneration(generation: number): number {
    this.attempts.abandonGeneration(generation)
    if (this.interruptedGeneration === generation) this.interruptedGeneration = undefined
    this.resolveInterrupt(generation)
    this.clearVerifiedModel()
    return generation + 1
  }

  settle<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.settlementQueue.then(operation, operation)
    this.settlementQueue = task.then(() => undefined, () => undefined)
    return task
  }

  beginInterrupt(generation: number): Promise<void> {
    this.interruptedGeneration = generation
    this.attempts.markInterrupted(generation)
    if (this.interruptSettlement?.generation === generation) return this.interruptSettlement.promise
    this.interruptSettlement?.resolve()
    let resolve = (): void => undefined
    const promise = new Promise<void>((done) => { resolve = done })
    this.interruptSettlement = { generation, promise, resolve }
    return promise
  }

  isInterrupted(generation: number): boolean {
    return this.interruptedGeneration === generation
  }

  clearInterrupt(generation: number): void {
    if (this.interruptedGeneration === generation) this.interruptedGeneration = undefined
  }

  resolveInterrupt(generation: number): void {
    if (this.interruptSettlement?.generation !== generation) return
    const settlement = this.interruptSettlement
    this.interruptSettlement = undefined
    settlement.resolve()
  }

  async completeTurn(input: Parameters<ClaudeModelAttemptTracker['completeTurn']>[0]): Promise<ModelAttemptRecord | undefined> {
    return this.settle(() => this.attempts.completeTurn(input))
  }

  async failTurn(input: Parameters<ClaudeModelAttemptTracker['failTurn']>[0]): Promise<ModelAttemptRecord | undefined> {
    return this.settle(() => this.attempts.failTurn(input))
  }

  async cancelTurn(input: Parameters<ClaudeModelAttemptTracker['cancelTurn']>[0]): Promise<ModelAttemptRecord | undefined> {
    return this.settle(() => this.attempts.cancelTurn(input))
  }

  private clearVerifiedModel(): void {
    this.activeSdkModel = ''
    this.routedModel = ''
  }
}
