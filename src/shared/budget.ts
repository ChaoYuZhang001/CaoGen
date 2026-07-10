import type { AppSettings, HistoryEntry, ProviderView, SessionMeta } from './types'

export interface MonthlyBudgetSnapshot {
  monthKey: string
  limitUsd: number
  spentUsd: number
  remainingUsd?: number
  exceeded: boolean
}

export interface BudgetReportSession {
  id: string
  title: string
  providerId: string
  providerName: string
  model: string
  costUsd: number
  active: boolean
  status?: SessionMeta['status']
  sessionLimitUsd?: number
  remainingUsd?: number
  ratio?: number
  overBudget: boolean
}

export interface BudgetReportProvider {
  providerId: string
  providerName: string
  spentUsd: number
  sessionCount: number
  activeSessions: number
  currentSessionLimitUsd?: number
}

export interface BudgetReportSnapshot {
  monthKey: string
  monthlyLimitUsd: number
  monthlySpentUsd: number
  monthlyRemainingUsd?: number
  monthlyRatio?: number
  monthlyExceeded: boolean
  defaultSessionLimitUsd: number
  activeCostUsd: number
  historicalCostUsd: number
  activeSessions: BudgetReportSession[]
  topSessions: BudgetReportSession[]
  providers: BudgetReportProvider[]
}

type CurrentSessionCost = Pick<SessionMeta, 'id' | 'sdkSessionId' | 'costUsd' | 'createdAt'>

export function calculateMonthlyBudgetSnapshot(input: {
  settings: Pick<AppSettings, 'budgetUsdPerMonth'>
  history: HistoryEntry[]
  currentSession?: CurrentSessionCost
  now?: number
}): MonthlyBudgetSnapshot {
  const now = input.now ?? Date.now()
  const monthKey = monthKeyFor(now)
  const limitUsd = normalizePositiveNumber(input.settings.budgetUsdPerMonth) ?? 0
  const currentSession = input.currentSession
  const historyCost = input.history
    .filter((entry) => historyEntryInMonth(entry, monthKey))
    .filter((entry) => !sameSession(entry, currentSession))
    .reduce((total, entry) => total + (normalizePositiveNumber(entry.costUsd) ?? 0), 0)
  const currentCost = normalizePositiveNumber(currentSession?.costUsd) ?? 0
  const spentUsd = roundUsd(historyCost + currentCost)
  const remainingUsd = limitUsd > 0 ? roundUsd(Math.max(0, limitUsd - spentUsd)) : undefined

  return {
    monthKey,
    limitUsd,
    spentUsd,
    remainingUsd,
    exceeded: limitUsd > 0 && spentUsd >= limitUsd
  }
}

export function calculateBudgetReport(input: {
  settings: Pick<AppSettings, 'budgetUsdPerSession' | 'budgetUsdPerMonth'>
  providers: ProviderView[]
  history: HistoryEntry[]
  activeSessions: SessionMeta[]
  now?: number
}): BudgetReportSnapshot {
  const now = input.now ?? Date.now()
  const monthKey = monthKeyFor(now)
  const providerById = new Map(input.providers.map((provider) => [provider.id, provider]))
  const activeIdentity = new Set<string>()
  for (const session of input.activeSessions) {
    activeIdentity.add(`id:${session.id}`)
    if (session.sdkSessionId) activeIdentity.add(`sdk:${session.sdkSessionId}`)
  }

  const historicalSessions = input.history
    .filter((entry) => historyEntryInMonth(entry, monthKey))
    .filter((entry) => !activeIdentity.has(`id:${entry.id}`) && !activeIdentity.has(`sdk:${entry.sdkSessionId}`))
    .map((entry) => reportHistorySession(entry, providerById))
  const activeSessions = input.activeSessions.map((session) =>
    reportActiveSession(session, providerById, input.settings.budgetUsdPerSession)
  )
  const activeCostUsd = roundUsd(activeSessions.reduce((total, session) => total + session.costUsd, 0))
  const historicalCostUsd = roundUsd(historicalSessions.reduce((total, session) => total + session.costUsd, 0))
  const monthlySpentUsd = roundUsd(activeCostUsd + historicalCostUsd)
  const monthlyLimitUsd = normalizePositiveNumber(input.settings.budgetUsdPerMonth) ?? 0
  const monthlyRemainingUsd = monthlyLimitUsd > 0 ? roundUsd(Math.max(0, monthlyLimitUsd - monthlySpentUsd)) : undefined
  const allSessions = [...activeSessions, ...historicalSessions]

  return {
    monthKey,
    monthlyLimitUsd,
    monthlySpentUsd,
    monthlyRemainingUsd,
    monthlyRatio: monthlyLimitUsd > 0 ? Math.min(1, monthlySpentUsd / monthlyLimitUsd) : undefined,
    monthlyExceeded: monthlyLimitUsd > 0 && monthlySpentUsd >= monthlyLimitUsd,
    defaultSessionLimitUsd: normalizePositiveNumber(input.settings.budgetUsdPerSession) ?? 0,
    activeCostUsd,
    historicalCostUsd,
    activeSessions: [...activeSessions].sort((a, b) => b.costUsd - a.costUsd),
    topSessions: [...allSessions].sort((a, b) => b.costUsd - a.costUsd).slice(0, 8),
    providers: aggregateProviders(allSessions, providerById)
  }
}

export function monthKeyFor(timestamp: number): string {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  return `${year}-${month}`
}

function reportActiveSession(
  session: SessionMeta,
  providerById: Map<string, ProviderView>,
  defaultSessionLimitUsd: number
): BudgetReportSession {
  const provider = providerById.get(session.providerId)
  const sessionLimitUsd =
    normalizePositiveNumber(session.budgetUsd) ??
    normalizePositiveNumber(provider?.budgetUsd) ??
    normalizePositiveNumber(defaultSessionLimitUsd)
  const costUsd = roundUsd(normalizePositiveNumber(session.costUsd) ?? 0)
  return {
    id: session.id,
    title: session.title,
    providerId: session.providerId,
    providerName: provider?.name ?? (session.providerId || '未选择 Provider'),
    model: session.model,
    costUsd,
    active: true,
    status: session.status,
    sessionLimitUsd,
    remainingUsd: sessionLimitUsd ? roundUsd(Math.max(0, sessionLimitUsd - costUsd)) : undefined,
    ratio: sessionLimitUsd ? Math.min(1, costUsd / sessionLimitUsd) : undefined,
    overBudget: Boolean(sessionLimitUsd && costUsd >= sessionLimitUsd)
  }
}

function reportHistorySession(
  entry: HistoryEntry,
  providerById: Map<string, ProviderView>
): BudgetReportSession {
  const provider = providerById.get(entry.providerId)
  return {
    id: entry.id,
    title: entry.title,
    providerId: entry.providerId,
    providerName: provider?.name ?? (entry.providerId || '未选择 Provider'),
    model: entry.model,
    costUsd: roundUsd(normalizePositiveNumber(entry.costUsd) ?? 0),
    active: false,
    overBudget: false
  }
}

function aggregateProviders(
  sessions: BudgetReportSession[],
  providerById: Map<string, ProviderView>
): BudgetReportProvider[] {
  const aggregates = new Map<string, BudgetReportProvider>()
  for (const session of sessions) {
    const id = session.providerId || 'unassigned'
    const provider = providerById.get(session.providerId)
    const current = aggregates.get(id) ?? {
      providerId: id,
      providerName: provider?.name ?? session.providerName,
      spentUsd: 0,
      sessionCount: 0,
      activeSessions: 0,
      currentSessionLimitUsd: normalizePositiveNumber(provider?.budgetUsd)
    }
    current.spentUsd = roundUsd(current.spentUsd + session.costUsd)
    current.sessionCount += 1
    if (session.active) current.activeSessions += 1
    aggregates.set(id, current)
  }
  return [...aggregates.values()].sort((a, b) => b.spentUsd - a.spentUsd)
}

function historyEntryInMonth(entry: HistoryEntry, monthKey: string): boolean {
  const timestamp = normalizePositiveNumber(entry.updatedAt) ?? normalizePositiveNumber(entry.createdAt)
  return timestamp !== undefined && monthKeyFor(timestamp) === monthKey
}

function sameSession(entry: HistoryEntry, currentSession: CurrentSessionCost | undefined): boolean {
  if (!currentSession) return false
  return entry.id === currentSession.id || Boolean(currentSession.sdkSessionId && entry.sdkSessionId === currentSession.sdkSessionId)
}

function normalizePositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
