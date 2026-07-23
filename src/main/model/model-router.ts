import { getModelStat, reliabilityScore } from '../modelStats'
import type { ProviderView, SchedulerStrategy } from '../../shared/types'
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

export interface ModelRouteRequest extends TaskProfileInput {
  providers: ProviderView[]
  strategy?: SchedulerStrategy
  manualOverride?: ManualModelOverride
  budget?: ModelRouterBudget
  excludedModels?: string[]
  crossValidation?: CrossValidationRequest
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
  const candidates = sourceProfiles.map((profile) => scoreCandidate(profile, task))
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

function scoreCandidate(profile: ModelProfile, task: TaskProfile): ModelRouteCandidate {
  const reliability = reliabilityScore(profile.model)
  const stat = getModelStat(profile.model)
  const estimatedCostUsd = estimateCostUsd(profile, task.expectedInputTokens, task.expectedOutputTokens)
  const score = Math.round(scoreProfileForTask(profile, task) + reliability * 20 - estimatedCostUsd * 10)
  const reasons = [
    `能力匹配 ${scoreProfileForTask(profile, task).toFixed(1)}`,
    `可靠性 ${reliability.toFixed(2)}`,
    `估算成本 $${estimatedCostUsd.toFixed(4)}`,
    `延迟档 ${profile.latency}`
  ]
  if (stat?.latencyEmaMs) reasons.push(`历史延迟 EMA ${stat.latencyEmaMs}ms`)
  return {
    profile,
    score,
    reliability,
    estimatedCostUsd,
    latencyEmaMs: stat?.latencyEmaMs,
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
    warnings: input.warnings
  }
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
