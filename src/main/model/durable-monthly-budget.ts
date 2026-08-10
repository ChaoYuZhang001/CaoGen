import type { AppSettings, HistoryEntry, SessionMeta } from '../../shared/types'
import {
  calculateMonthlyBudgetSnapshot,
  monthKeyFor,
  type MonthlyBudgetSnapshot
} from '../../shared/budget'
import { readBillableUsageLedger } from '../task/billable-usage-ledger'

type CurrentSessionCost = Pick<SessionMeta, 'id' | 'sdkSessionId' | 'costUsd' | 'createdAt'>

export interface DurableMonthlyBudgetSnapshot extends MonthlyBudgetSnapshot {
  source: 'billable-usage-ledger' | 'legacy-history'
  attemptCount: number
  legacyFloorApplied: boolean
}

export class MonthlyBudgetAuditError extends Error {
  constructor(readonly code: 'LEDGER_UNAVAILABLE' | 'UNPRICED_SUCCESS') {
    super(code === 'LEDGER_UNAVAILABLE'
      ? 'Monthly budget ledger is unavailable'
      : 'Monthly budget contains an unpriced successful request')
    this.name = 'MonthlyBudgetAuditError'
  }
}

export function calculateDurableMonthlyBudgetSnapshot(input: {
  rootDir: string
  settings: Pick<AppSettings, 'budgetUsdPerMonth'>
  history: HistoryEntry[]
  currentSession?: CurrentSessionCost
  now?: number
}): DurableMonthlyBudgetSnapshot {
  let entries
  try {
    entries = readBillableUsageLedger(input.rootDir)
  } catch {
    throw new MonthlyBudgetAuditError('LEDGER_UNAVAILABLE')
  }
  if (entries.length === 0) {
    return {
      ...calculateMonthlyBudgetSnapshot(input),
      source: 'legacy-history',
      attemptCount: 0,
      legacyFloorApplied: true
    }
  }

  const now = input.now ?? Date.now()
  const monthKey = monthKeyFor(now)
  const current = entries.filter((entry) => monthKeyFor(entry.completedAt) === monthKey)
  if (current.some((entry) => entry.status === 'succeeded' && !entry.billable)) {
    throw new MonthlyBudgetAuditError('UNPRICED_SUCCESS')
  }
  const limit = calculateMonthlyBudgetSnapshot({
    settings: input.settings,
    history: input.history,
    currentSession: input.currentSession,
    now
  })
  const ledgerSpentUsd = roundUsd(current.reduce(
    (total, entry) => total + (entry.billable ? entry.costUsd ?? 0 : 0), 0))
  // Existing installs can have same-month spend from before this append-only ledger existed.
  // A max floor preserves that spend without adding overlapping Session summaries twice.
  const spentUsd = Math.max(ledgerSpentUsd, limit.spentUsd)
  return {
    monthKey,
    limitUsd: limit.limitUsd,
    spentUsd,
    remainingUsd: limit.limitUsd > 0 ? roundUsd(Math.max(0, limit.limitUsd - spentUsd)) : undefined,
    exceeded: limit.limitUsd > 0 && spentUsd >= limit.limitUsd,
    source: 'billable-usage-ledger',
    attemptCount: current.length,
    legacyFloorApplied: limit.spentUsd > ledgerSpentUsd
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
