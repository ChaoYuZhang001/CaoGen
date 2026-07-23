import type {
  ModelRoutePlanView,
  ModelRoutingDecisionView,
  SessionMeta
} from '../../shared/types'
import type { StableMessagePayload } from '../stable-message-payload'
import { listHistory } from '../history'
import { listProviders } from '../providers'
import { getSettings } from '../settings'
import { settingsForCaoGenDrive } from './drive'
import { calculateMonthlyBudgetSnapshot } from './monthly-budget'
import { createLegacyRoutingDecisionView, resolveSessionModelRoute } from './session-routing'
import { pickModelAcrossProviders } from '../scheduler'

export interface ClaudeAutoRouteDecision {
  model: string
  reason: string
  providerId: string
  providerName?: string
  switchedProvider: boolean
  decision: ModelRoutingDecisionView
  crossValidationPlan?: ModelRoutePlanView
}

export function resolveClaudeAutoRoute(
  meta: SessionMeta,
  payload: StableMessagePayload
): ClaudeAutoRouteDecision | null {
  const settings = settingsForCaoGenDrive(getSettings(), meta.driveMode)
  const providers = listProviders()
  if (settings.smartModelRoutingEnabled || meta.routingScope === 'provider' || meta.routingScope === 'global') {
    const monthlyBudget = calculateMonthlyBudgetSnapshot({
      settings,
      history: listHistory(),
      currentSession: meta
    })
    const smart = resolveSessionModelRoute({
      enabled: true,
      currentModel: meta.model,
      providerId: meta.providerId,
      providers: meta.routingScope === 'provider'
        ? providers.filter((provider) => provider.id === meta.providerId)
        : providers,
      engine: meta.engine,
      driveMode: meta.driveMode,
      payload,
      strategy: settings.schedulerStrategy,
      sessionCostUsd: meta.costUsd,
      sessionBudgetUsd: meta.budgetUsd,
      settingsBudgetUsd: settings.budgetUsdPerSession,
      monthlyBudgetRemainingUsd: monthlyBudget.remainingUsd,
      fallbackProviderId: settings.fallbackProviderId,
      fallbackModel: settings.fallbackModel,
      lowCostProviderId: settings.lowCostProviderId,
      lowCostModel: settings.lowCostModel,
      strongReasoningProviderId: settings.strongReasoningProviderId,
      strongReasoningModel: settings.strongReasoningModel,
      reviewProviderId: settings.reviewProviderId,
      reviewModel: settings.reviewModel,
      researchProviderId: settings.researchProviderId,
      researchModel: settings.researchModel,
      planningProviderId: settings.planningProviderId,
      planningModel: settings.planningModel,
      codingProviderId: settings.codingProviderId,
      codingModel: settings.codingModel,
      testingProviderId: settings.testingProviderId,
      testingModel: settings.testingModel,
      documentationProviderId: settings.documentationProviderId,
      documentationModel: settings.documentationModel,
      modelRoutingRules: settings.modelRoutingRules,
      projectPath: meta.sourceCwd ?? meta.cwd
    })
    if (smart.kind === 'routed') return smart
  }

  const candidates = providers
    .filter((provider) => provider.hasToken)
    .map((provider) => ({ id: provider.id, name: provider.name, models: provider.models }))
  const decision = pickModelAcrossProviders({
    candidates,
    text: payload.text || (payload.images.length > 0 ? `图片输入 (${payload.images.length} 张)` : ''),
    strategy: settings.schedulerStrategy,
    currentProviderId: meta.providerId
  })
  if (!decision) return null
  return {
    ...decision,
    decision: createLegacyRoutingDecisionView({
      providerId: decision.providerId,
      providerName: decision.providerName,
      model: decision.model,
      strategy: settings.schedulerStrategy,
      complexity: decision.complexity,
      candidateCount: candidates.reduce(
        (count, candidate) => count + candidate.models.filter(Boolean).length,
        0
      ),
      switchedProvider: decision.switchedProvider,
      reason: decision.reason
    })
  }
}
