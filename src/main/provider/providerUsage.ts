import type { ModelAttemptRecord } from '../../shared/model-attempt-types'
import type {
  ImportedProviderUsageRollup,
  ProviderUsageQuery,
  ProviderUsageSummary,
  ResolvedImportedProviderUsageRollup
} from '../../shared/provider-usage-types'
import { listProviders } from '../providers'
import { queryPersistedModelAttempts } from '../task/model-attempt-api'
import { summarizeProviderUsage } from './providerUsageSummary'
import { refreshProviderCredentialMetrics } from './providerCredentialMetrics'
import { readImportedProviderUsage } from './providerImportedUsage'
import { readProviderGatewayUsage } from './providerGatewayStore'

const MAX_ATTEMPTS = 10_000

export async function queryProviderUsage(query: ProviderUsageQuery = {}): Promise<ProviderUsageSummary> {
  await refreshProviderCredentialMetrics()
  const attemptResult = await readAllAttempts(query.providerId)
  const gatewayAttempts = readProviderGatewayUsage()
    .filter((record) => !query.providerId?.trim() || record.providerId === query.providerId.trim())
    .map((record): ModelAttemptRecord => ({
      schemaVersion: 1,
      id: record.id,
      runId: 'gateway',
      requestId: record.requestId ?? record.id,
      workItemId: 'gateway',
      ordinal: record.ordinal ?? 0,
      providerId: record.providerId,
      model: record.model,
      protocol: record.protocol,
      adapterVersion: 'provider-gateway-v1',
      contextDigest: 'sha256:gateway-request-content-not-persisted',
      routeReason: record.routeReason ?? 'Explicit local gateway model route',
      keyLabel: record.keyLabel,
      failoverFromAttemptId: record.failoverFromAttemptId,
      status: record.status,
      revision: 2,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      latencyMs: record.latencyMs,
      usage: record.usage,
      outcome: record.outcome,
      startCommandId: `gateway:start:${record.id}`,
      startPayloadDigest: 'sha256:gateway-request-content-not-persisted',
      completionCommandId: `gateway:complete:${record.id}`,
      completionPayloadDigest: 'sha256:gateway-response-content-not-persisted',
      recordDigest: 'sha256:provider-gateway-usage-record'
    }))
  const providers = listProviders()
  const imported = resolveImportedUsage(readImportedProviderUsage(), providers)
  const knownProviderIds = new Set(providers.map((provider) => provider.id))
  const historicalProviders = imported
    .filter((row) => !knownProviderIds.has(row.providerId))
    .map((row) => ({ id: row.providerId, name: row.providerName }))
  const uniqueHistorical = [...new Map(historicalProviders.map((provider) => [provider.id, provider])).values()]
  return summarizeProviderUsage(
    [...attemptResult.attempts, ...gatewayAttempts],
    [...providers, ...uniqueHistorical],
    query,
    Date.now(),
    imported,
    attemptResult.truncated
  )
}

function resolveImportedUsage(
  rows: ImportedProviderUsageRollup[],
  providers: ReturnType<typeof listProviders>
): ResolvedImportedProviderUsageRollup[] {
  const mapped = new Map(providers.flatMap((provider) => {
    const sourceId = provider.advancedConfig?.metadata?.sourceProviderId
    return sourceId ? [[sourceId, provider.id] as const] : []
  }))
  return rows.map((row) => ({
    ...row,
    providerId: mapped.get(row.sourceProviderId) ?? `cc-switch:${row.sourceProviderId}`
  }))
}

async function readAllAttempts(providerId: string | undefined): Promise<{
  attempts: ModelAttemptRecord[]
  truncated: boolean
}> {
  const attempts: ModelAttemptRecord[] = []
  let cursor: string | undefined
  let truncated = false
  do {
    const page = await queryPersistedModelAttempts({
      providerId: providerId?.trim() || undefined,
      limit: 500,
      ...(cursor ? { cursor } : {})
    })
    attempts.push(...page.attempts)
    if (attempts.length >= MAX_ATTEMPTS) {
      truncated = page.hasMore || attempts.length > MAX_ATTEMPTS
      break
    }
    if (!page.hasMore) break
    cursor = page.nextCursor
  } while (cursor)
  return { attempts: attempts.slice(0, MAX_ATTEMPTS), truncated }
}
