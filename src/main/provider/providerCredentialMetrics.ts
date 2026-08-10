import type { ModelAttemptRecord } from '../../shared/model-attempt-types'
import type { ProviderApiKey } from '../../shared/types'
import { queryPersistedModelAttempts } from '../task/model-attempt-api'
import type { ProviderCredentialMetrics } from '../providerKeyRouting'
import { credentialFingerprint } from './providerCredentialIdentity'

const MAX_ATTEMPTS = 10_000
let monthlySpendByFingerprint = new Map<string, number>()
const balanceByCredential = new Map<string, number>()
let refreshPromise: Promise<void> | undefined

export function providerCredentialMetrics(
  providerId: string,
  keys: ProviderApiKey[]
): ReadonlyMap<string, ProviderCredentialMetrics> {
  return new Map(keys.map((key) => [key.id, {
    monthlySpendUsd: monthlySpendByFingerprint.get(credentialFingerprint(providerId, key.id)) ?? 0,
    ...(balanceByCredential.has(metricKey(providerId, key.id))
      ? { balanceRemainingUsd: balanceByCredential.get(metricKey(providerId, key.id)) }
      : {})
  }]))
}

export function recordProviderCredentialBalance(
  providerId: string,
  keyId: string | undefined,
  remainingUsd: number | undefined
): void {
  if (!keyId || remainingUsd === undefined || !Number.isFinite(remainingUsd) || remainingUsd < 0) return
  balanceByCredential.set(metricKey(providerId, keyId), remainingUsd)
}

export function refreshProviderCredentialMetrics(now = Date.now()): Promise<void> {
  if (refreshPromise) return refreshPromise
  refreshPromise = readMonthlyAttempts(now)
    .then((attempts) => {
      const next = new Map<string, number>()
      for (const attempt of attempts) {
        if (!attempt.keyLabel || !Number.isFinite(attempt.costUsd) || (attempt.costUsd ?? 0) < 0) continue
        next.set(attempt.keyLabel, round((next.get(attempt.keyLabel) ?? 0) + (attempt.costUsd ?? 0)))
      }
      monthlySpendByFingerprint = next
    })
    .finally(() => { refreshPromise = undefined })
  return refreshPromise
}

export function replaceProviderCredentialMetricsForTest(
  spendByFingerprint: ReadonlyMap<string, number>,
  balances: ReadonlyMap<string, number> = new Map()
): void {
  monthlySpendByFingerprint = new Map(spendByFingerprint)
  balanceByCredential.clear()
  for (const [key, value] of balances) balanceByCredential.set(key, value)
}

function metricKey(providerId: string, keyId: string): string {
  return `${providerId}\0${keyId}`
}

async function readMonthlyAttempts(now: number): Promise<ModelAttemptRecord[]> {
  const from = new Date(now)
  from.setUTCDate(1)
  from.setUTCHours(0, 0, 0, 0)
  const attempts: ModelAttemptRecord[] = []
  let cursor: string | undefined
  do {
    const page = await queryPersistedModelAttempts({ limit: 500, ...(cursor ? { cursor } : {}) })
    attempts.push(...page.attempts.filter((attempt) => attempt.startedAt >= from.getTime() && attempt.startedAt <= now))
    if (attempts.length >= MAX_ATTEMPTS || !page.hasMore) break
    cursor = page.nextCursor
  } while (cursor)
  return attempts.slice(0, MAX_ATTEMPTS)
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
