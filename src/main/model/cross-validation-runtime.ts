import type {
  AgentEvent,
  AgentEventIdentity,
  CreateSessionOptions,
  ModelRoutePlanView,
  SessionMeta,
  TaskRunRecord,
  TranscriptEntry
} from '../../shared/types'
import { settingsForCaoGenDrive } from './drive'
import { getSettings } from '../settings'
import { cleanOneLine } from '../session-manager-support'
import { ingestWorkflowAcceptanceFailure } from '../task/workflow-acceptance-failure-ingress'
import {
  arbitrationCrossValidationTarget,
  buildCrossValidationArbitrationPrompt,
  buildCrossValidationReviewPrompt,
  firstCrossValidationTarget,
  parseCrossValidationReviewConclusion,
  type CrossValidationReviewConclusion
} from './cross-validation'
import { planCrossValidationFailureIngress } from './cross-validation-failure'

interface CrossValidationRuntimeDependencies {
  create(options: CreateSessionOptions): Promise<SessionMeta>
  getMeta(sessionId: string): SessionMeta | undefined
  getTranscript(sessionId: string): TranscriptEntry[]
  getRun(sessionId: string): TaskRunRecord | undefined
  send(sessionId: string, prompt: string): boolean
  dispatch(sessionId: string, event: AgentEvent): void
}

interface ReviewContext {
  parentSessionId: string
  parentMeta: SessionMeta
  routePlan: ModelRoutePlanView
  primaryResultText: string
  transcript: TranscriptEntry[]
  turnSeq: number
  parentRunId?: string
}

interface ArbitrationContext {
  parentMeta: SessionMeta
  reviewerConclusion: CrossValidationReviewConclusion
  verifier: string
  parentRunId?: string
}

export class ModelCrossValidationRuntime {
  private readonly routePlans = new Map<string, ModelRoutePlanView>()
  private readonly started = new Set<string>()
  private readonly reviews = new Map<string, ReviewContext>()
  private readonly arbitrations = new Map<string, ArbitrationContext>()

  constructor(private readonly dependencies: CrossValidationRuntimeDependencies) {}

  async handleEvent(sessionId: string, event: AgentEvent, identity: AgentEventIdentity): Promise<void> {
    if (this.handleLifecycleEvent(sessionId, event)) return
    if (event.kind !== 'turn-result') return

    const arbitration = this.arbitrations.get(sessionId)
    if (arbitration) {
      this.arbitrations.delete(sessionId)
      await this.finishArbitration(sessionId, event, identity, arbitration)
      return
    }
    const review = this.reviews.get(sessionId)
    if (review) {
      this.reviews.delete(sessionId)
      await this.finishReview(event, identity, review)
      return
    }
    await this.startReview(sessionId, event, identity.seq)
  }

  private handleLifecycleEvent(sessionId: string, event: AgentEvent): boolean {
    if (event.kind === 'status' && event.status === 'closed') {
      this.routePlans.delete(sessionId)
      this.deleteStartedKeys(sessionId)
      this.reviews.delete(sessionId)
      this.arbitrations.delete(sessionId)
      for (const [childId, review] of this.reviews) {
        if (review.parentSessionId === sessionId) this.reviews.delete(childId)
      }
      for (const [childId, arbitration] of this.arbitrations) {
        if (arbitration.parentMeta.id === sessionId) this.arbitrations.delete(childId)
      }
      return true
    }
    if (event.kind !== 'routing') return false
    if (event.crossValidationPlan?.enabled) this.routePlans.set(sessionId, event.crossValidationPlan)
    else this.routePlans.delete(sessionId)
    return true
  }

  private async startReview(sessionId: string, event: Extract<AgentEvent, { kind: 'turn-result' }>, seq: number): Promise<void> {
    if (event.isError) return
    const meta = this.dependencies.getMeta(sessionId)
    if (!meta || meta.parentSessionId || meta.childRole) return
    const settings = settingsForCaoGenDrive(getSettings(), meta.driveMode)
    if (!settings.smartModelRoutingEnabled || !settings.modelCrossValidationAutoRunEnabled) return
    const routePlan = this.routePlans.get(sessionId)
    const validator = routePlan?.enabled ? firstCrossValidationTarget(routePlan) : null
    const resultText = event.resultText?.trim()
    if (!routePlan || !validator || !resultText) return

    const key = `${sessionId}:${seq}:${validator.providerId}:${validator.model}`
    if (this.started.has(key)) return
    this.started.add(key)
    const transcript = this.dependencies.getTranscript(sessionId)
    const parentRunId = this.dependencies.getRun(sessionId)?.id
    const reviewMeta = await this.dependencies.create({
      cwd: meta.sourceCwd ?? meta.cwd,
      isolated: false,
      model: validator.model,
      providerId: validator.providerId,
      engine: meta.engine,
      permissionMode: 'plan',
      parentSessionId: sessionId,
      childTaskId: `cross-validation-${seq}`,
      childRole: 'model-review',
      title: `模型复核: ${cleanOneLine(meta.title, meta.id, 48)}`
    })
    this.reviews.set(reviewMeta.id, {
      parentSessionId: sessionId,
      parentMeta: { ...meta },
      routePlan,
      primaryResultText: resultText,
      transcript,
      turnSeq: seq,
      parentRunId
    })
    this.dependencies.dispatch(sessionId, {
      kind: 'hook-event',
      event: 'model-cross-validation',
      detail: `已启动第二模型复核: ${validator.providerName ?? validator.providerId}/${validator.model}`
    })
    this.dependencies.send(reviewMeta.id, buildCrossValidationReviewPrompt({
      parentMeta: { ...meta }, routePlan, resultText, transcript, turnSeq: seq
    }))
  }

  private async finishReview(
    event: Extract<AgentEvent, { kind: 'turn-result' }>,
    identity: AgentEventIdentity,
    review: ReviewContext
  ): Promise<void> {
    if (event.isError) return
    const reviewerResultText = event.resultText ?? ''
    const reviewerConclusion = parseCrossValidationReviewConclusion(reviewerResultText)
    if (!reviewerConclusion || reviewerConclusion === 'PASS') return
    const parentMeta = this.dependencies.getMeta(review.parentSessionId)
    const target = arbitrationCrossValidationTarget(review.routePlan)
    if (!parentMeta || !target) {
      this.dependencies.dispatch(review.parentSessionId, {
        kind: 'hook-event',
        event: 'model-cross-validation-arbitration-required',
        detail: '第二模型复核要求仲裁，但当前复核计划没有可用第三模型；需要人工仲裁。'
      })
      return
    }
    const arbitrationMeta = await this.dependencies.create({
      cwd: parentMeta.sourceCwd ?? parentMeta.cwd,
      isolated: false,
      model: target.model,
      providerId: target.providerId,
      engine: parentMeta.engine,
      permissionMode: 'plan',
      parentSessionId: review.parentSessionId,
      childTaskId: `cross-validation-arbitration-${review.turnSeq}`,
      childRole: 'model-arbitration',
      title: `模型仲裁: ${cleanOneLine(parentMeta.title, parentMeta.id, 48)}`
    })
    this.arbitrations.set(arbitrationMeta.id, {
      parentMeta: review.parentMeta,
      reviewerConclusion,
      verifier: `model-arbitration:${target.providerId}/${target.model}`,
      parentRunId: review.parentRunId
    })
    this.dependencies.dispatch(review.parentSessionId, {
      kind: 'hook-event',
      event: 'model-cross-validation-arbitration',
      detail: `第二模型复核存在分歧，已启动仲裁模型: ${target.providerName ?? target.providerId}/${target.model}`
    })
    this.dependencies.send(arbitrationMeta.id, buildCrossValidationArbitrationPrompt({
      parentMeta: review.parentMeta,
      routePlan: review.routePlan,
      primaryResultText: review.primaryResultText,
      reviewerResultText,
      transcript: review.transcript,
      turnSeq: identity.seq
    }))
  }

  private async finishArbitration(
    sessionId: string,
    event: Extract<AgentEvent, { kind: 'turn-result' }>,
    identity: AgentEventIdentity,
    context: ArbitrationContext
  ): Promise<void> {
    if (event.isError) return
    const plan = planCrossValidationFailureIngress({
      arbitrationSessionId: sessionId,
      parentRunId: context.parentRunId,
      eventId: identity.eventId,
      observedAt: identity.occurredAt,
      resultText: event.resultText ?? '',
      reviewerConclusion: context.reviewerConclusion,
      parentMeta: context.parentMeta,
      verifier: context.verifier
    })
    if (plan.disposition === 'ignore') return
    if (plan.disposition === 'unowned') {
      console.warn('[caogen] structured cross-validation failure skipped: parent session lacks Workspace/WorkItem ownership')
      return
    }
    try {
      await ingestWorkflowAcceptanceFailure(plan.input)
    } catch (error) {
      console.error('[caogen] structured cross-validation failure ingress rejected:', error)
    }
  }

  private deleteStartedKeys(sessionId: string): void {
    const prefix = `${sessionId}:`
    for (const key of this.started) {
      if (key.startsWith(prefix)) this.started.delete(key)
    }
  }
}
