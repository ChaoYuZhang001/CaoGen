#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const dashboard = readFileSync('src/renderer/src/components/settings/ProviderUsageDashboard.tsx', 'utf8')
const billing = readFileSync('src/renderer/src/components/settings/ProviderBillingReconciliation.tsx', 'utf8')
const billingService = readFileSync('src/main/provider/providerBillingReconciliation.ts', 'utf8')
const settings = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf8')
const summary = readFileSync('src/main/provider/providerUsageSummary.ts', 'utf8')
const styles = readFileSync('src/renderer/src/styles.css', 'utf8')
const translations = readFileSync('src/renderer/src/i18n/providerSetupTranslations.ts', 'utf8')
const checks = []

check('dashboard is a dedicated Provider settings surface',
  settings.includes('<ProviderUsageDashboard providers={providers} />')
    && dashboard.includes('data-provider-usage-dashboard'))
check('dashboard defaults to today and exposes rolling 24 hour, 7 day, and 30 day ranges',
  dashboard.includes("type UsageRange = 'today' | '24h' | '7d' | '30d'")
    && dashboard.includes("useState<UsageRange>('today')")
    && dashboard.includes('usageRangeStart(range, to)')
    && ['providerUsageRange_today', 'providerUsageRange_24h', 'providerUsageRange_7d', 'providerUsageRange_30d']
      .every((key) => translations.includes(key)))
check('Provider settings exposes configuration and billing as peer views',
  settings.includes('data-provider-surface={value}')
    && settings.includes("surface === 'configuration'")
    && settings.includes("surface === 'usage'"))
check('Provider and model filters are sent to the main-process query',
  dashboard.includes('providerId: providerId || undefined')
    && dashboard.includes('model: model || undefined')
    && dashboard.includes('source: source || undefined')
    && dashboard.includes('keyLabel: keyLabel || undefined'))
check('credential billing uses canonical safe IDs across filter, aggregate, and export surfaces',
  dashboard.includes('scopeUsage?.requestsByCredential')
    && dashboard.includes("request.keyLabel ?? ''")
    && dashboard.includes("request.credentialName ?? ''")
    && dashboard.includes("view === 'credentials'")
    && summary.includes('credentialNameForAttempt')
    && summary.includes('requestsByCredential'))
check('usage dashboard exposes sanitized source filtering and bounded auto refresh',
  dashboard.includes('scopeUsage?.sources')
    && dashboard.includes('providerUsageAllSources')
    && dashboard.includes('DEFAULT_REFRESH_INTERVAL')
    && dashboard.includes('window.setInterval(() => void reload(), refreshInterval)')
    && translations.includes('providerUsageAutoRefreshSeconds'))
check('model choices are scoped by the selected Provider',
  dashboard.includes('window.agentDesk.queryProviderUsage({ ...baseQuery, limit: 1, offset: 0 })')
    && dashboard.includes('scopeUsage?.requestsByModel'))
check('dashboard shows success, latency, cost, and pricing coverage',
  ['providerUsageSuccessRate', 'providerUsageAverageLatency', 'providerUsageCost', 'providerUsagePricingCoverage']
    .every((key) => dashboard.includes(key)))
check('dashboard separates reported, configured, builtin, imported, and unpriced cost provenance',
  dashboard.includes('data-provider-usage-cost-provenance')
    && dashboard.includes('usage.costSources')
    && summary.includes('summarizeCostSources')
    && ['providerUsageCostSource_reported', 'providerUsageCostSource_provider-pricing',
      'providerUsageCostSource_builtin-pricing', 'providerUsageCostSource_imported', 'providerUsageCostSource_unpriced']
      .every((key) => translations.includes(key)))
check('unpriced requests visibly warn that the total can be lower than the invoice',
  dashboard.includes("item.source === 'unpriced'")
    && dashboard.includes("t('providerUsageCostUnpricedWarning'")
    && translations.includes('providerUsageCostProvenanceHint'))
check('truncated usage visibly blocks silent full-ledger interpretation',
  dashboard.includes('usage.truncated')
    && dashboard.includes('data-provider-usage-truncated')
    && translations.includes('providerUsageTruncatedWarning'))
check('billing reconciliation is scoped to an explicitly selected Provider',
    dashboard.includes('<ProviderBillingReconciliation')
    && dashboard.includes('providerId={providerId}')
    && billing.includes('disabled={!providerId || data.loading}')
    && billing.includes('providerBillingSelectProvider'))
check('billing statements capture only period, USD amount, and a fixed source enum',
  billing.includes("type=\"datetime-local\"")
    && billing.includes("type=\"number\"")
    && billing.includes("['provider-api', 'provider-console', 'invoice', 'balance-export', 'other']")
    && !/(apiKey|baseUrl|responseBody|invoiceFile|statementUrl)/.test(billing))
check('billing reconciliation can sync a configured official API for the selected period',
    billing.includes('inspectProviderBillingQuery')
    && billing.includes('syncProviderBillingStatement')
    && billing.includes('periodStart: period.from')
    && billing.includes('periodEnd: syncEnd')
    && billing.includes("result.status === 'ready'"))
check('billing sync exposes bounded failure states without rendering response payloads',
  ['providerBillingSyncExpired', 'providerBillingSyncInvalidResponse',
    'providerBillingSyncBlocked', 'providerBillingSyncInvalidPayload']
    .every((key) => billing.includes(key) && translations.includes(key))
    && !/(responseBody|responseText|requestUrl)/.test(billing))
check('billing reconciliation renders matched, mismatch, and incomplete outcomes with reasons',
  billing.includes('data-provider-billing-status={row.status}')
    && billing.includes('row.incompleteReasons.map')
    && ['providerBillingStatus_matched', 'providerBillingStatus_mismatch', 'providerBillingStatus_incomplete']
      .every((key) => translations.includes(key)))
check('billing comparison fails closed for missing, truncated, unpriced, or estimated usage',
  ['no-local-data', 'usage-truncated', 'unpriced-requests', 'non-reported-costs']
    .every((reason) => billingService.includes(reason))
    && billingService.includes("source.source === 'reported'")
    && billingService.includes('reportedRequests !== usage.requests'))
check('dashboard promotes total tokens and cache hit rate',
  dashboard.includes("t('providerUsageTotalTokens')")
    && dashboard.includes("t('providerUsageCacheHitRate')")
    && dashboard.includes('totalTokens(usage)')
    && dashboard.includes('usage.inputTokens + usage.cacheReadTokens'))
check('dashboard renders the full-range trend contract',
  dashboard.includes('usage?.buckets?.map(toTrendPoint)')
    && dashboard.includes('bucketCount: 24')
    && summary.includes('buildBuckets(requests, historical, from, to')
    && translations.includes('providerUsageTrendTitle'))
check('trend compares cost and all four token classes',
  ['is-cost', 'is-cache-write', 'is-cache-read', 'is-input', 'is-output']
    .every((series) => dashboard.includes(`provider-usage-series ${series}`))
    && dashboard.includes('trendPolyline'))
check('dashboard offers a bounded, secret-free credential-attributed CSV export',
  dashboard.includes("limit: 10_000")
    && summary.includes('MAX_USAGE_ROWS = 10_000')
    && dashboard.includes('providerUsageExport')
    && dashboard.includes('price_source')
    && dashboard.includes('credential_id')
    && dashboard.includes('credential_name')
    && !dashboard.includes('apiKey'))
check('dashboard exposes request, Provider, model, and credential billing views',
  dashboard.includes("type UsageView = 'requests' | 'providers' | 'models' | 'credentials'")
    && dashboard.includes('data-provider-usage-view={value}')
    && ['providerUsageViewRequests', 'providerUsageViewProviders', 'providerUsageViewModels', 'providerUsageViewCredentials']
      .every((key) => translations.includes(key)))
check('dashboard shows all four token classes',
  ['usage.inputTokens', 'usage.outputTokens', 'usage.cacheReadTokens', 'usage.cacheWriteTokens']
    .every((field) => dashboard.includes(field)))
check('recent request detail is capped and excludes content fields',
  dashboard.includes('REQUEST_PAGE_SIZE = 25')
    && dashboard.includes('offset: requestPage * REQUEST_PAGE_SIZE')
    && dashboard.includes('usage.recentRequests')
    && !/(requestBody|requestText|prompt|messages|apiKey|baseUrl)/.test(dashboard))
check('recent request table exposes operational, not content, columns',
  ['providerUsageTime', 'providerUsageStatus', 'providerUsageLatency', 'providerUsageSource', 'providerUsagePriceSource']
    .every((key) => dashboard.includes(key)))
check('request rows expose input, output, and cache billing without expansion',
  dashboard.includes('request.usage.inputTokens')
    && dashboard.includes('request.usage.outputTokens')
    && dashboard.includes('request.usage.cacheReadTokens'))
check('request rows expand into credential-free token and outcome detail',
  dashboard.includes('expandedAttemptId')
    && dashboard.includes('provider-usage-request-detail')
    && dashboard.includes('request.source')
    && dashboard.includes('request.keyLabel')
    && !dashboard.includes('requestBody'))
check('request log pagination is backed by the main-process summary contract',
  dashboard.includes('usage.recentHasMore')
    && dashboard.includes('provider-usage-pagination')
    && summary.includes('recentOffset')
    && summary.includes('recentHasMore'))
check('average latency is aggregated across the full filtered range',
  summary.includes('averageLatencyMs: totals.latencySamples > 0')
    && summary.includes('totals.latencySamples += 1'))
check('stale asynchronous responses cannot replace newer filters',
  dashboard.includes('requestId.current !== currentRequest'))
check('query failures render a credential-free generic error',
  dashboard.includes('catch {')
    && dashboard.includes("t('providerUsageUnavailable')"))
check('request table has bounded horizontal scrolling',
  styles.includes('.provider-usage-request-table')
    && styles.includes('min-width: 980px')
    && styles.includes('overflow-x: auto'))
check('compact layout stacks filters and aggregate tables',
  styles.includes('@media (max-width: 720px)')
    && styles.includes('.provider-usage-toolbar,')
    && styles.includes('grid-template-columns: 1fr'))
check('refresh motion respects reduced-motion preference',
  styles.includes('@media (prefers-reduced-motion: reduce)')
    && styles.includes('animation: none'))

console.log(`provider usage dashboard smoke ok: ${checks.length}/${checks.length} checks passed`)

function check(name, condition) {
  assert.equal(Boolean(condition), true, name)
  checks.push(name)
}
