import type { AppSettings, HistoryEntry, SessionMeta } from '../../shared/types'

export interface MonthlyBudgetSnapshot {
  monthKey: string
  limitUsd: number
  spentUsd: number
  remainingUsd?: number
  exceeded: boolean
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

export function monthKeyFor(timestamp: number): string {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  return `${year}-${month}`
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
