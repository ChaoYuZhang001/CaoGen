import { AUTO_MODEL } from '../../shared/types'
import type {
  CaoGenDriveMode,
  ModelRoutePlanView,
  EngineKind,
  ProviderView,
  SchedulerStrategy,
  SendMessagePayload
} from '../../shared/types'
import { routeModel } from './model-router'
import type { ManualModelOverride } from './model-router'
import { driveModeLabel, driveRiskAtLeast, driveRouteTuning } from './drive'

export interface SessionRouteInput {
  enabled: boolean
  currentModel: string
  providerId: string
  providers: ProviderView[]
  engine?: EngineKind
  driveMode?: CaoGenDriveMode
  payload: SendMessagePayload
  strategy: SchedulerStrategy
  sessionCostUsd: number
  sessionBudgetUsd?: number
  settingsBudgetUsd: number
  monthlyBudgetRemainingUsd?: number
  manualOverride?: ManualModelOverride
}

export type SessionRouteResult =
  | { kind: 'disabled' }
  | {
      kind: 'routed'
      providerId: string
      model: string
      reason: string
      switchedProvider: boolean
      crossValidationPlan: ModelRoutePlanView
    }

export function resolveSessionModelRoute(input: SessionRouteInput): SessionRouteResult {
  if (!input.enabled || input.currentModel !== AUTO_MODEL) return { kind: 'disabled' }
  const providers = routeableProviders(input.providers, input.engine)
  if (providers.length === 0) return { kind: 'disabled' }
  const prompt = input.payload.text
  const drive = driveRouteTuning(input.driveMode)
  const decision = routeModel({
    providers,
    prompt,
    attachments: input.payload.images?.map((image) => ({ mime: image.mime })),
    requestedTasks: drive.requestedTasks,
    expectedOutputTokens: drive.expectedOutputTokens,
    strategy: drive.strategy,
    manualOverride: input.manualOverride,
    budget: budgetForRoute(input),
    crossValidation: drive.crossValidation,
    riskLevel: driveRiskAtLeast(inferRouteRisk(prompt), drive.riskFloor),
    requiresTools: true
  })
  const selected = decision.selected.profile
  return {
    kind: 'routed',
    providerId: selected.providerId,
    model: selected.model,
    switchedProvider: selected.providerId !== input.providerId,
    crossValidationPlan: decision.crossValidationPlan,
    reason: formatRouteReason(decision, drive.mode)
  }
}

function routeableProviders(providers: ProviderView[], engine: EngineKind | undefined): ProviderView[] {
  return providers.filter((provider) => {
    if (provider.baseUrl.trim().length === 0 || !provider.hasToken || provider.models.length === 0) return false
    if (engine === 'openai') return provider.openaiProtocol === 'chat' || provider.openaiProtocol === 'responses'
    if (engine === undefined || engine === 'claude') return provider.openaiProtocol === undefined
    return false
  })
}

function budgetForRoute(input: SessionRouteInput): { remainingUsd?: number; hardLimit: boolean } | undefined {
  const remainingLimits: number[] = []
  const sessionLimit = input.sessionBudgetUsd && input.sessionBudgetUsd > 0 ? input.sessionBudgetUsd : input.settingsBudgetUsd
  if (sessionLimit && sessionLimit > 0) remainingLimits.push(Math.max(0, sessionLimit - input.sessionCostUsd))
  if (typeof input.monthlyBudgetRemainingUsd === 'number' && Number.isFinite(input.monthlyBudgetRemainingUsd)) {
    remainingLimits.push(Math.max(0, input.monthlyBudgetRemainingUsd))
  }
  if (remainingLimits.length === 0) return undefined
  return { remainingUsd: Math.min(...remainingLimits), hardLimit: true }
}

function inferRouteRisk(prompt: string): 'low' | 'medium' | 'high' {
  const lower = prompt.toLowerCase()
  if (hasAny(lower, ['security', 'auth', 'payment', 'release', 'deploy', 'production', 'database', 'migration'])) return 'high'
  if (hasAny(lower, ['安全', '鉴权', '支付', '发布', '部署', '生产', '数据库', '迁移'])) return 'high'
  if (hasAny(lower, ['code', 'typescript', 'bug', 'refactor', 'test', 'review'])) return 'medium'
  if (hasAny(lower, ['代码', '修复', '实现', '重构', '测试', '审查'])) return 'medium'
  return 'low'
}

function formatRouteReason(decision: ReturnType<typeof routeModel>, driveMode: CaoGenDriveMode): string {
  const selected = decision.selected.profile
  const parts = [
    `Drive=${driveModeLabel(driveMode)}`,
    `智能调度选择 ${selected.providerName ?? selected.providerId}/${selected.model}`,
    `任务=${decision.task.taskKinds.join('+')}`,
    `策略=${decision.task.strategy}`,
    `估算=$${decision.selected.estimatedCostUsd.toFixed(4)}`
  ]
  if (decision.manualOverrideApplied) parts.push('手动覆盖')
  if (decision.budgetDowngraded) parts.push('预算降级')
  if (decision.crossValidationPlan.enabled) {
    const validators = decision.crossValidationPlan.validators.map((item) => `${item.providerName ?? item.providerId}/${item.model}`)
    parts.push(`复核=${validators.join(',')}`)
  }
  for (const warning of decision.warnings) parts.push(warning)
  return parts.join('；')
}

function hasAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle))
}
