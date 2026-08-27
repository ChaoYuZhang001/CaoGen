#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { bindSourceEvidence, readSourceEvidenceState } from './lib/source-evidence-binding.mjs'

const repoRoot = process.cwd()
const sourceEvidenceAtStart = readSourceEvidenceState(repoRoot)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-usage-'))
const outDir = path.join(tempRoot, 'compiled')
const checks = []
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'provider-usage-smoke')
const reportDir = path.join(reportRoot, runId)
let finalStatus = 'failed'
let finalError

try {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    'src/main/provider/providerUsageSummary.ts'
  ], { cwd: repoRoot, stdio: 'inherit' })
  const api = await import(pathToFileURL(findCompiled(outDir, 'providerUsageSummary.js')).href)
  const now = 1_000_000
  const openAiKey = credentialFingerprint('openai', 'key-openai')
  const customKey = credentialFingerprint('custom', 'key-primary')
  const untrustedLabelKey = credentialFingerprint('unpriced', 'key-untrusted-label')
  const providers = [
    { id: 'openai', name: 'OpenAI', apiKeys: [{ id: 'key-openai', label: 'Primary' }] },
    {
      id: 'custom',
      name: 'Custom Anthropic',
      apiKeys: [{ id: 'key-primary', label: 'Production East' }],
      advancedConfig: {
        schemaVersion: 1,
        modelProfiles: [{
          model: 'claude-custom',
          pricing: {
            currency: 'USD',
            inputPerMillion: 1,
            outputPerMillion: 3,
            source: 'provider'
          }
        }]
      }
    },
    { id: 'unpriced', name: 'Unpriced Anthropic', apiKeys: [{ id: 'key-untrusted-label', label: 'sk-secret-canary-value' }] }
  ]
  const attempts = [
    attempt('builtin', 'openai', 'gpt-4o-mini', 'openai.responses', 900_000, 'succeeded', {
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      latencyMs: 200,
      keyLabel: openAiKey
    }),
    attempt('configured', 'custom', 'claude-custom', 'anthropic.messages', 800_000, 'succeeded', {
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      latencyMs: 400,
      keyLabel: customKey
    }),
    attempt('unpriced', 'unpriced', 'claude-unknown', 'anthropic.messages', 700_000, 'failed', {
      usage: { inputTokens: 100, outputTokens: 10 },
      keyLabel: untrustedLabelKey
    }),
    attempt('reported', 'custom', 'claude-custom', 'anthropic.messages', 600_000, 'cancelled', {
      costUsd: 0.5,
      keyLabel: customKey
    }),
    attempt('outside-window', 'openai', 'gpt-4o-mini', 'openai.responses', 100, 'succeeded', {
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    })
  ]
  const summary = api.summarizeProviderUsage(attempts, providers, { from: 500_000, to: now, limit: 2 }, now)
  equal(summary.requests, 4, 'time range filters requests')
  equal(summary.truncated, false, 'complete attempt scans remain explicitly untruncated')
  equal(summary.succeeded, 2, 'success count')
  equal(summary.failed, 2, 'failed and cancelled count')
  equal(summary.pricedRequests, 3, 'priced request count')
  equal(summary.unpricedRequests, 1, 'unpriced request count')
  equal(summary.costUsd, 5.25, 'reported, configured, and builtin costs aggregate')
  equal(summary.costSources.map((item) => `${item.source}:${item.requests}:${item.costUsd}`).join(','),
    'reported:1:0.5,provider-pricing:1:4,builtin-pricing:1:0.75,unpriced:1:0',
    'cost provenance separates reported, configured, builtin, and unpriced requests')
  equal(summary.latencySamples, 2, 'latency sample count')
  equal(summary.averageLatencyMs, 300, 'average latency covers the full filtered range')
  equal(summary.recentRequests.length, 2, 'recent request limit')
  equal(summary.recentOffset, 0, 'recent request offset defaults to zero')
  equal(summary.recentTotal, 4, 'recent request total covers full filtered range')
  equal(summary.recentHasMore, true, 'recent request page reports additional rows')
  equal(summary.buckets.length, 24, 'default trend bucket count')
  equal(summary.buckets.reduce((total, bucket) => total + bucket.requests, 0), summary.requests, 'trend buckets cover full filtered range')
  equal(summary.recentRequests[0].costSource, 'builtin-pricing', 'builtin OpenAI cost source')
  equal(summary.requestsByProvider[0].label, 'Custom Anthropic', 'provider aggregates use display names')
  equal(summary.requestsByCredential.length, 3, 'credential aggregates group requests by safe identity')
  equal(summary.requestsByCredential.find((item) => item.keyLabel === customKey)?.requests, 2,
    'credential aggregates combine repeated use of one key')
  equal(summary.requestsByCredential.find((item) => item.keyLabel === customKey)?.label,
    'Custom Anthropic / Production East', 'saved non-secret key names label credential billing')
  equal(summary.requestsByCredential.some((item) => item.label.includes('sk-secret-canary-value')), false,
    'credential-like saved labels are excluded from usage output')
  equal(summary.recentRequests[0].keyLabel, openAiKey, 'request ledger exposes only canonical credential identity')
  equal(summary.recentRequests[0].credentialName, 'Primary', 'request ledger resolves a safe saved key name')
  equal(summary.sources.join(','), 'anthropic.messages,openai.responses', 'sanitized request sources are listed')
  const filtered = api.summarizeProviderUsage(attempts, providers, {
    from: 0,
    to: now,
    providerId: 'custom',
    model: 'CLAUDE-CUSTOM'
  }, now)
  equal(filtered.requests, 2, 'provider and model filters compose')
  equal(filtered.buckets.reduce((total, bucket) => total + bucket.requests, 0), 2, 'filtered trend buckets compose with filters')
  const sourceFiltered = api.summarizeProviderUsage(attempts, providers, {
    from: 0,
    to: now,
    source: 'OPENAI.RESPONSES'
  }, now)
  equal(sourceFiltered.requests, 2, 'source filter is exact and case insensitive')
  const credentialFiltered = api.summarizeProviderUsage(attempts, providers, {
    from: 0,
    to: now,
    keyLabel: customKey
  }, now)
  equal(credentialFiltered.requests, 2, 'credential identity filter is exact')
  equal(credentialFiltered.costUsd, 4.5, 'credential filter preserves request-level billing totals')
  const page = api.summarizeProviderUsage(attempts, providers, { from: 500_000, to: now, limit: 2, offset: 2 }, now)
  equal(page.recentOffset, 2, 'recent request offset is applied')
  equal(page.recentRequests.length, 2, 'second request page is bounded')
  equal(page.recentHasMore, false, 'last request page reports no additional rows')
  const historical = [{
    sourceProviderId: 'a'.repeat(24),
    providerId: 'history',
    providerName: 'CC Switch History',
    source: 'cc-switch.codex',
    model: 'historical-model',
    dayStartedAt: 600_000,
    requestCount: 5,
    successCount: 4,
    inputTokens: 500,
    outputTokens: 100,
    cacheReadTokens: 50,
    cacheWriteTokens: 25,
    costUsd: 2,
    averageLatencyMs: 500
  }]
  const merged = api.summarizeProviderUsage(attempts, [...providers, { id: 'history', name: 'CC Switch History' }],
    { from: 500_000, to: now, limit: 10 }, now, historical)
  equal(merged.requests, 9, 'imported rollups merge into request totals')
  equal(merged.nativeRequests, 4, 'native request count remains explicit')
  equal(merged.historicalRequests, 5, 'imported historical request count remains explicit')
  equal(merged.recentTotal, 4, 'imported rollups do not impersonate recent native requests')
  equal(merged.succeeded, 6, 'imported rollup successes merge')
  equal(merged.failed, 3, 'imported rollup failures merge')
  equal(merged.costUsd, 7.25, 'imported rollup cost merges')
  equal(merged.costSources.find((item) => item.source === 'imported')?.requests, 5,
    'imported history remains a distinct cost source')
  equal(merged.costSources.find((item) => item.source === 'imported')?.costUsd, 2,
    'imported history preserves its aggregate amount')
  equal(merged.averageLatencyMs, 443, 'imported average latency is request-weighted')
  equal(merged.buckets.reduce((total, bucket) => total + bucket.requests, 0), 9,
    'trend buckets include imported rollups')
  equal(merged.sources.includes('cc-switch.codex'), true, 'imported source is filterable')
  const historicalCredentialFilter = api.summarizeProviderUsage(attempts, providers,
    { from: 0, to: now, keyLabel: customKey }, now, historical)
  equal(historicalCredentialFilter.historicalRequests, 0,
    'credential filters exclude rollups without verified credential attribution')
  const truncated = api.summarizeProviderUsage(attempts, providers, { from: 500_000, to: now }, now, [], true)
  equal(truncated.truncated, true, 'attempt scan truncation propagates to the public usage summary')
  assertThrows(() => api.summarizeProviderUsage([], providers, { from: 10, to: 9 }, now),
    'invalid time range is rejected')
  finalStatus = 'passed'
} catch (error) {
  finalError = error instanceof Error ? error.stack || error.message : String(error)
  process.exitCode = 1
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
  const report = {
    schemaVersion: 1,
    runId,
    gate: 'test:provider-usage:summary',
    status: finalStatus,
    ok: finalStatus === 'passed',
    generatedAt: new Date().toISOString(),
    pass: checks.filter((check) => check.status === 'pass').length,
    total: checks.length,
    checks,
    failures: finalError ? [{ message: finalError }] : [],
    warnings: []
  }
  const provenance = bindSourceEvidence(
    report,
    sourceEvidenceAtStart,
    readSourceEvidenceState(repoRoot),
    'Provider Usage summary'
  )
  if (provenance.status !== 'pass') {
    report.status = 'failed'
    report.ok = false
    report.failures.push({ message: report.error })
    process.exitCode = 1
  }
  mkdirSync(reportDir, { recursive: true })
  const body = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(reportDir, 'report.json'), body, 'utf8')
  writeFileSync(path.join(reportRoot, 'latest.json'), body, 'utf8')
}

if (finalStatus === 'passed' && !process.exitCode) {
  console.log(`provider usage smoke ok: ${checks.length}/${checks.length} checks passed`)
} else {
  console.error(`provider usage smoke failed: ${finalError ?? 'evidence provenance failed'}`)
}

function credentialFingerprint(providerId, keyId) {
  const payload = JSON.stringify({ material: keyId, providerId })
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`
}

function attempt(id, providerId, model, protocol, startedAt, status, overrides = {}) {
  return {
    schemaVersion: 1,
    id,
    runId: `run-${id}`,
    requestId: `request-${id}`,
    ordinal: 1,
    providerId,
    model,
    protocol,
    adapterVersion: '1',
    contextDigest: 'a'.repeat(64),
    routeReason: 'smoke',
    status,
    revision: status === 'started' ? 1 : 2,
    startedAt,
    workItemId: `work-${id}`,
    startCommandId: `start-${id}`,
    startPayloadDigest: 'b'.repeat(64),
    recordDigest: 'c'.repeat(64),
    ...overrides
  }
}

function findCompiled(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      try { return findCompiled(full, fileName) } catch { /* keep searching */ }
    } else if (entry.isFile() && entry.name === fileName) return full
  }
  throw new Error(`compiled ${fileName} not found`)
}

function equal(actual, expected, message) {
  const pass = actual === expected
  checks.push({ name: message, status: pass ? 'pass' : 'fail' })
  if (!pass) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assertThrows(action, message) {
  let thrown = false
  try { action() } catch { thrown = true }
  checks.push({ name: message, status: thrown ? 'pass' : 'fail' })
  if (!thrown) throw new Error(message)
}
