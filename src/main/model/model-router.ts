import { createHash } from 'node:crypto'
import { getModelStat, reliabilityScore } from '../modelStats'
import type { ProviderView, SchedulerStrategy } from '../../shared/types'
import { getAcceptanceQualitySignal } from './acceptance-quality-signal'
import {
  buildModelProfiles,
  estimateCostUsd,
  inferTaskProfile,
  scoreProfileForTask,
  type ModelProfile,
  type ModelTaskKind,
  type TaskProfile,
  type TaskProfileInput
} from './model-profile'

export interface ManualModelOverride {
  providerId?: string
  model?: string
  reason?: string
  allowBudgetOverflow?: boolean
}

export interface ModelRouterBudget {
  /** 本轮或本会话剩余预算；0/undefined 表示不限制。 */
  remainingUsd?: number
  /** true 时预算超限必须降级；false 时仅降低分数并给出原因。 */
  hardLimit?: boolean
}

export interface ModelRouteHealthInput {
  healthy: boolean
  circuitState?: 'closed' | 'open' | 'half_open'
  latencyEmaMs?: number
}

/** Component scores are bounded 0..100 and contain no Provider credentials or response data. */
export interface ModelRouteScoreBreakdown {
  capability: number
  quality: number
  acceptanceQuality: number
  acceptanceSamples: number
  speed: number
  cost: number
  health: number
  composite: number
}

export interface ModelRouteRequest extends TaskProfileInput {
  providers: ProviderView[]
  strategy?: SchedulerStrategy
  manualOverride?: ManualModelOverride
  budget?: ModelRouterBudget
  excludedModels?: string[]
  crossValidation?: CrossValidationRequest
  providerHealth?: Record<string, ModelRouteHealthInput>
}

export interface CrossValidationRequest {
  enabled: boolean
  /** 参与复核的最大附加模型数，不含主模型。 */
  maxValidators?: number
  minRiskLevel?: 'low' | 'medium' | 'high'
}

export interface ModelRouteCandidate {
  profile: ModelProfile
  score: number
  reliability: number
  estimatedCostUsd: number
  latencyEmaMs?: number
  scoreBreakdown: ModelRouteScoreBreakdown
  reasons: string[]
}

export interface CrossValidationPlan {
  enabled: boolean
  primary: Pick<ModelProfile, 'providerId' | 'providerName' | 'model'>
  validators: Array<Pick<ModelProfile, 'providerId' | 'providerName' | 'model'>>
  policy: 'compare-answer' | 'review-primary' | 'skip'
  reason: string
}

export interface ModelRouteDecision {
  selected: ModelRouteCandidate
  candidates: ModelRouteCandidate[]
  task: TaskProfile
  manualOverrideApplied: boolean
  manualOverrideReason?: string
  budgetDowngraded: boolean
  crossValidationPlan: CrossValidationPlan
  decisionDigest: string
  warnings: string[]
}

export function routeModel(request: ModelRouteRequest): ModelRouteDecision {
  const task = inferTaskProfile({ ...request, strategy: request.strategy })
  const excluded = new Set(request.excludedModels ?? [])
  const profiles = request.providers.flatMap((provider) =>
    buildModelProfiles({
      providerId: provider.id,
      providerName: provider.name,
      models: provider.models
    })
  )
  const viable = profiles.filter((profile) => isProfileViable(profile, task) && !excluded.has(profile.model))
  const sourceProfiles = viable.length > 0 ? viable : profiles.filter((profile) => !excluded.has(profile.model))
  const candidates = sourceProfiles.map((profile) => scoreCandidate(profile, task, request.providerHealth?.[profile.providerId]))
  if (candidates.length === 0) throw new Error('没有可路由的模型候选')
  const rankedCandidates = rankCandidates(candidates, task.strategy)

  const warnings: string[] = []
  const manual = applyManualOverride(rankedCandidates, request.manualOverride)
  if (manual) {
    const overBudget = isOverBudget(manual, request.budget)
    if (!overBudget || request.manualOverride?.allowBudgetOverflow) {
      return buildDecision({
        selected: manual,
        candidates: rankedCandidates,
        task,
        manualOverrideApplied: true,
        manualOverrideReason: request.manualOverride?.reason,
        budgetDowngraded: false,
        crossValidation: request.crossValidation,
        warnings: overBudget ? ['手动覆盖命中预算上限，但调用方允许越过预算。'] : []
      })
    }
    warnings.push('手动覆盖命中预算上限，已按硬预算尝试降级。')
  }

  const primary = rankedCandidates[0]
  const budgetSafe = chooseBudgetSafeCandidate(rankedCandidates, request.budget)
  const selected = budgetSafe ?? primary
  const budgetDowngraded = selected.profile.model !== primary.profile.model || selected.profile.providerId !== primary.profile.providerId
  if (isOverBudget(selected, request.budget) && request.budget?.hardLimit) {
    warnings.push('所有候选均超过硬预算，返回最低估算成本候选供调用方显式处理。')
  }

  return buildDecision({
    selected,
    candidates: rankedCandidates,
    task,
    manualOverrideApplied: false,
    manualOverrideReason: manual ? request.manualOverride?.reason : undefined,
    budgetDowngraded,
    crossValidation: request.crossValidation,
    warnings
  })
}

export function planCrossValidation(
  selected: ModelRouteCandidate,
  candidates: ModelRouteCandidate[],
  task: TaskProfile,
  request?: CrossValidationRequest
): CrossValidationPlan {
  if (!request?.enabled) {
    return {
      enabled: false,
      primary: toPlanModel(selected.profile),
      validators: [],
      policy: 'skip',
      reason: '未显式开启交叉验证。'
    }
  }
  const threshold = riskRank(request.minRiskLevel ?? 'high')
  if (riskRank(task.riskLevel) < threshold) {
    return {
      enabled: false,
      primary: toPlanModel(selected.profile),
      validators: [],
      policy: 'skip',
      reason: '任务风险低于交叉验证阈值。'
    }
  }
  const maxValidators = Math.max(1, request.maxValidators ?? 1)
  const validators = candidates
    .filter((candidate) => candidate.profile.model !== selected.profile.model || candidate.profile.providerId !== selected.profile.providerId)
    .filter((candidate) => candidate.profile.providerId !== selected.profile.providerId || candidate.profile.cost.tier !== selected.profile.cost.tier)
    .slice(0, maxValidators)
    .map((candidate) => toPlanModel(candidate.profile))
  return {
    enabled: validators.length > 0,
    primary: toPlanModel(selected.profile),
    validators,
    policy: validators.length > 0 ? 'review-primary' : 'skip',
    reason: validators.length > 0 ? '高风险任务已生成异质模型复核计划。' : '没有可用的异质复核模型。'
  }
}

function scoreCandidate(
  profile: ModelProfile,
  task: TaskProfile,
  providerHealth?: ModelRouteHealthInput
): ModelRouteCandidate {
  const reliability = reliabilityScore(profile.model)
  const stat = getModelStat(profile.model)
  const acceptanceQuality = getAcceptanceQualitySignal(profile.providerId, profile.model)
  const acceptanceConfidence = Math.min(1, (acceptanceQuality?.samples ?? 0) / 5)
  const estimatedCostUsd = estimateCostUsd(profile, task.expectedInputTokens, task.expectedOutputTokens)
  const capability = boundedScore(scoreProfileForTask(profile, { ...task, strategy: 'balanced' }), 0, 100)
  const acceptanceAdjustment = ((acceptanceQuality?.score ?? 0.5) - 0.5) * 40 * acceptanceConfidence
  const quality = boundedScore(
    reliability * 70 + strengthScore(profile, task) * 30 + acceptanceAdjustment,
    0,
    100
  )
  const latencyEmaMs = stat?.latencyEmaMs ?? providerHealth?.latencyEmaMs
  const speed = speedScore(profile.latency, latencyEmaMs)
  const cost = costScore(profile.cost.tier, estimatedCostUsd)
  const health = healthScore(providerHealth)
  const composite = weightedComposite(task.strategy, { capability, quality, speed, cost, health })
  // Keep the historic score scale for compatibility while making the new
  // component score the canonical explanation and tie-break signal.
  const score = Math.round(
    scoreProfileForTask(profile, task) + reliability * 20 - estimatedCostUsd * 10 +
    composite / 20 + acceptanceAdjustment / 2
  )
  const reasons = [
    `能力 ${capability.toFixed(1)}`,
    `质量 ${quality.toFixed(1)}（可靠性 ${reliability.toFixed(2)}）`,
    `验收质量 ${(acceptanceQuality?.score ?? 0.5).toFixed(2)}（${acceptanceQuality?.samples ?? 0} 个终态样本）`,
    `速度 ${speed.toFixed(1)}（延迟档 ${profile.latency}）`,
    `成本 ${cost.toFixed(1)}（估算 $${estimatedCostUsd.toFixed(4)}）`,
    `健康 ${health.toFixed(1)}`
  ]
  if (latencyEmaMs) reasons.push(`历史延迟 EMA ${latencyEmaMs}ms`)
  return {
    profile,
    score,
    reliability,
    estimatedCostUsd,
    latencyEmaMs,
    scoreBreakdown: {
      capability,
      quality,
      acceptanceQuality: Math.round((acceptanceQuality?.score ?? 0.5) * 1000) / 10,
      acceptanceSamples: acceptanceQuality?.samples ?? 0,
      speed,
      cost,
      health,
      composite
    },
    reasons
  }
}

function applyManualOverride(
  candidates: ModelRouteCandidate[],
  override?: ManualModelOverride
): ModelRouteCandidate | undefined {
  if (!override?.providerId && !override?.model) return undefined
  return candidates
    .filter((candidate) => {
      const providerMatches = !override.providerId || candidate.profile.providerId === override.providerId
      const modelMatches = !override.model || candidate.profile.model === override.model
      return providerMatches && modelMatches
    })
    .sort(compareCandidateIdentity)[0]
}

function rankCandidates(candidates: ModelRouteCandidate[], strategy: SchedulerStrategy): ModelRouteCandidate[] {
  const comparators: CandidateComparator[] = strategy === 'speed'
    ? [compareLatencyClass, compareMeasuredLatency, compareScore, compareCandidateIdentity]
    : [compareScore, strategyTieComparator(strategy), compareCandidateIdentity]
  return [...candidates].sort((a, b) => firstComparison(comparators, a, b))
}

type CandidateComparator = (a: ModelRouteCandidate, b: ModelRouteCandidate) => number

function firstComparison(
  comparators: CandidateComparator[],
  a: ModelRouteCandidate,
  b: ModelRouteCandidate
): number {
  for (const compare of comparators) {
    const result = compare(a, b)
    if (result !== 0) return result
  }
  return 0
}

function strategyTieComparator(strategy: SchedulerStrategy): CandidateComparator {
  if (strategy === 'cost') return compareEstimatedCost
  if (strategy === 'quality') return compareReliability
  return compareMeasuredLatency
}

function compareLatencyClass(a: ModelRouteCandidate, b: ModelRouteCandidate): number {
  return latencyClassRank(b.profile.latency) - latencyClassRank(a.profile.latency)
}

function compareMeasuredLatency(a: ModelRouteCandidate, b: ModelRouteCandidate): number {
  return (a.latencyEmaMs ?? Number.MAX_SAFE_INTEGER) - (b.latencyEmaMs ?? Number.MAX_SAFE_INTEGER)
}

function compareScore(a: ModelRouteCandidate, b: ModelRouteCandidate): number {
  return b.score - a.score
}

function compareEstimatedCost(a: ModelRouteCandidate, b: ModelRouteCandidate): number {
  return a.estimatedCostUsd - b.estimatedCostUsd
}

function compareReliability(a: ModelRouteCandidate, b: ModelRouteCandidate): number {
  return b.reliability - a.reliability
}

function compareCandidateIdentity(a: ModelRouteCandidate, b: ModelRouteCandidate): number {
  const providerDelta = a.profile.providerId.localeCompare(b.profile.providerId)
  return providerDelta !== 0 ? providerDelta : a.profile.model.localeCompare(b.profile.model)
}

function latencyClassRank(latency: ModelProfile['latency']): number {
  if (latency === 'fast') return 3
  if (latency === 'balanced') return 2
  return 1
}

function chooseBudgetSafeCandidate(
  candidates: ModelRouteCandidate[],
  budget?: ModelRouterBudget
): ModelRouteCandidate | undefined {
  if (!budget) return candidates[0]
  const remainingUsd = budget.remainingUsd
  if (!remainingUsd || remainingUsd <= 0) return candidates[0]
  const affordable = candidates.filter((candidate) => candidate.estimatedCostUsd <= remainingUsd)
  if (affordable.length > 0) return affordable[0]
  if (!budget.hardLimit) return candidates[0]
  return [...candidates].sort((a, b) => {
    const costDelta = a.estimatedCostUsd - b.estimatedCostUsd
    return costDelta !== 0 ? costDelta : compareCandidateIdentity(a, b)
  })[0]
}

function isOverBudget(candidate: ModelRouteCandidate, budget?: ModelRouterBudget): boolean {
  if (budget?.remainingUsd === undefined || budget.remainingUsd <= 0) return false
  return candidate.estimatedCostUsd > budget.remainingUsd
}

function isProfileViable(profile: ModelProfile, task: TaskProfile): boolean {
  if (task.requiresTools && !profile.supportsTools) return false
  if (task.requiresVision && !profile.supportsVision) return false
  return profile.contextWindowTokens >= task.minContextTokens
}

function buildDecision(input: {
  selected: ModelRouteCandidate
  candidates: ModelRouteCandidate[]
  task: TaskProfile
  manualOverrideApplied: boolean
  manualOverrideReason?: string
  budgetDowngraded: boolean
  crossValidation?: CrossValidationRequest
  warnings: string[]
}): ModelRouteDecision {
  return {
    selected: input.selected,
    candidates: input.candidates,
    task: input.task,
    manualOverrideApplied: input.manualOverrideApplied,
    manualOverrideReason: input.manualOverrideReason,
    budgetDowngraded: input.budgetDowngraded,
    crossValidationPlan: planCrossValidation(input.selected, input.candidates, input.task, input.crossValidation),
    decisionDigest: routeDecisionDigest(input),
    warnings: input.warnings
  }
}

function routeDecisionDigest(input: {
  selected: ModelRouteCandidate
  candidates: ModelRouteCandidate[]
  task: TaskProfile
  manualOverrideApplied: boolean
  manualOverrideReason?: string
  budgetDowngraded: boolean
}): string {
  const canonical = {
    task: input.task,
    selected: candidateDigestValue(input.selected),
    candidates: input.candidates.map(candidateDigestValue).sort((left, right) =>
      `${left.providerId}\0${left.model}`.localeCompare(`${right.providerId}\0${right.model}`)),
    manualOverrideApplied: input.manualOverrideApplied,
    manualOverrideReason: input.manualOverrideReason ?? '',
    budgetDowngraded: input.budgetDowngraded
  }
  return `sha256:${createHash('sha256').update(stableJson(canonical)).digest('hex')}`
}

function candidateDigestValue(candidate: ModelRouteCandidate): Record<string, unknown> {
  return {
    providerId: candidate.profile.providerId,
    model: candidate.profile.model,
    score: candidate.score,
    estimatedCostUsd: candidate.estimatedCostUsd,
    latencyEmaMs: candidate.latencyEmaMs ?? null,
    scoreBreakdown: candidate.scoreBreakdown
  }
}

function boundedScore(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}

function strengthScore(profile: ModelProfile, task: TaskProfile): number {
  const strengths = task.taskKinds.map((kind) => {
    if (kind === 'coding') return profile.capabilities.coding
    if (kind === 'reasoning' || kind === 'planning' || kind === 'review') return profile.capabilities.reasoning
    if (kind === 'toolUse' || kind === 'testing') return profile.capabilities.toolUse
    if (kind === 'vision') return profile.capabilities.vision
    if (kind === 'longContext' || kind === 'research') return profile.capabilities.longContext
    return profile.capabilities.summarization
  })
  if (strengths.length === 0) return 0.5
  const values = strengths.map((value) => value === 'high' ? 1 : value === 'medium' ? 0.65 : 0.3)
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function speedScore(latency: ModelProfile['latency'], latencyEmaMs?: number): number {
  const classScore = latency === 'fast' ? 90 : latency === 'balanced' ? 65 : 40
  if (latencyEmaMs === undefined || latencyEmaMs <= 0) return classScore
  const measured = boundedScore(100 - latencyEmaMs / 40, 0, 100)
  return Math.round((classScore * 0.4 + measured * 0.6) * 10) / 10
}

function costScore(tier: ModelRouteCandidate['profile']['cost']['tier'], estimatedCostUsd: number): number {
  const tierScore = tier === 'low' ? 90 : tier === 'medium' ? 65 : 40
  return Math.round(boundedScore(tierScore - Math.min(30, Math.max(0, estimatedCostUsd) * 100), 0, 100) * 10) / 10
}

function healthScore(input?: ModelRouteHealthInput): number {
  if (!input) return 50
  if (!input.healthy || input.circuitState === 'open') return 0
  if (input.circuitState === 'half_open') return 50
  return 100
}

function weightedComposite(
  strategy: SchedulerStrategy,
  scores: Pick<ModelRouteScoreBreakdown, 'capability' | 'quality' | 'speed' | 'cost' | 'health'>
): number {
  const weights = strategy === 'cost'
    ? [0.25, 0.15, 0.15, 0.35, 0.1]
    : strategy === 'quality'
      ? [0.3, 0.35, 0.1, 0.1, 0.15]
      : strategy === 'speed'
        ? [0.25, 0.1, 0.4, 0.15, 0.1]
        : [0.3, 0.25, 0.2, 0.15, 0.1]
  return Math.round((scores.capability * weights[0] + scores.quality * weights[1] + scores.speed * weights[2] + scores.cost * weights[3] + scores.health * weights[4]) * 10) / 10
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function toPlanModel(profile: ModelProfile): Pick<ModelProfile, 'providerId' | 'providerName' | 'model'> {
  return {
    providerId: profile.providerId,
    providerName: profile.providerName,
    model: profile.model
  }
}

function riskRank(level: 'low' | 'medium' | 'high'): number {
  if (level === 'high') return 3
  if (level === 'medium') return 2
  return 1
}
