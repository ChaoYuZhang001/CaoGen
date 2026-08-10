#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-billing-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
const storeFile = path.join(userData, 'provider-billing-statements.json')
const checks = []
const require = createRequire(import.meta.url)

try {
  compile()
  installElectronStub()
  const storeModule = findCompiled(outDir, 'providerBillingStore.js')
  const reconciliationModule = findCompiled(outDir, 'providerBillingReconciliation.js')
  const queryModule = findCompiled(outDir, 'providerBillingQuery.js')
  const store = await importFresh(storeModule)
  const reconciliation = await import(pathToFileURL(reconciliationModule).href)
  const query = await import(pathToFileURL(queryModule).href)

  const getRequest = query.buildProviderBillingRequest('https://api.example.test/v1', {
    path: '/billing/usage',
    method: 'GET',
    query: { granularity: 'day' },
    periodStart: { target: 'query', name: 'start', format: 'unix-seconds' },
    periodEnd: { target: 'query', name: 'end', format: 'unix-ms' },
    response: { amountPath: '/amount', currency: 'USD' }
  }, { periodStart: 1_700_000_000_123, periodEnd: 1_700_086_400_456 })
  equal(getRequest?.url.toString(),
    'https://api.example.test/billing/usage?granularity=day&start=1700000000&end=1700086400456',
    'GET billing query injects Unix-second and Unix-millisecond periods')
  equal(getRequest?.init.redirect, 'manual', 'billing query disables automatic redirects')

  const postRequest = query.buildProviderBillingRequest('https://api.example.test/v1', {
    path: '/billing/export',
    method: 'POST',
    body: { period: { timezone: 'UTC' } },
    periodStart: { target: 'body', path: '/period/start', format: 'iso' },
    periodEnd: { target: 'body', path: '/period/end', format: 'iso' },
    response: { itemsPath: '/items', amountPath: '/cost', currencyPath: '/currency' }
  }, { periodStart: 0, periodEnd: 1_000 })
  equal(postRequest?.init.method, 'POST', 'POST billing query retains its request method')
  equal(postRequest?.init.headers['content-type'], 'application/json', 'POST JSON body gets a content type')
  equal(postRequest?.init.body, JSON.stringify({
    period: { timezone: 'UTC', start: '1970-01-01T00:00:00.000Z', end: '1970-01-01T00:00:01.000Z' }
  }), 'POST billing query writes ISO periods through nested JSON Pointers')
  equal(query.buildProviderBillingRequest('https://api.example.test/v1', {
    path: 'https://evil.example.test/billing',
    periodStart: { target: 'query', name: 'start', format: 'unix-ms' },
    periodEnd: { target: 'query', name: 'end', format: 'unix-ms' },
    response: { amountPath: '/amount', currency: 'USD' }
  }, { periodStart: 1, periodEnd: 2 }), undefined, 'cross-origin billing endpoint is rejected')

  equal(query.extractProviderBilledCostUsd({ data: { items: [
    { amount: '1.25', currency: 'USD' },
    { amount: 275, currency: 'usd' }
  ] } }, { itemsPath: '/data/items', amountPath: '/amount', currencyPath: '/currency', scale: 0.01 }),
  2.7625, 'multiple USD billing items are scaled and summed')
  equal(query.extractProviderBilledCostUsd({ amount: 8, currency: 'CNY' }, {
    amountPath: '/amount', currencyPath: '/currency'
  }), undefined, 'non-USD billing payload fails closed')
  equal(query.extractProviderBilledCostUsd({ amount: -1 }, {
    amountPath: '/amount', currency: 'USD'
  }), undefined, 'negative billing amount fails closed')
  const keySet = { apiKeys: [
    { id: 'key-primary', label: 'billing', encryptedValue: 'not-read-by-selector' },
    { id: 'key-disabled', label: 'disabled', encryptedValue: 'not-read-by-selector', disabled: true }
  ] }
  equal(query.resolveProviderBillingKeyId(keySet, 'billing'), 'key-primary',
    'billing query selects the exact enabled key label')
  equal(query.resolveProviderBillingKeyId(keySet, 'disabled'), undefined,
    'billing query refuses a disabled key label')
  equal(query.resolveProviderBillingKeyId({ apiKeys: [
    { id: 'key-a', label: 'duplicate', encryptedValue: 'not-read' },
    { id: 'key-b', label: 'duplicate', encryptedValue: 'not-read' }
  ] }, 'duplicate'), undefined, 'billing query refuses an ambiguous key label')

  const readyFetch = await query.executeProviderBillingRequest(getRequest, {
    amountPath: '/amount', currency: 'USD'
  }, async () => jsonResponse({ amount: 4.25 }))
  equal(readyFetch.status, 'ready', 'valid official JSON response is accepted')
  equal(readyFetch.billedCostUsd, 4.25, 'accepted official JSON response returns only normalized USD')

  for (const status of [401, 403]) {
    const expired = await query.executeProviderBillingRequest(getRequest, {
      amountPath: '/amount', currency: 'USD'
    }, async () => new Response('', { status }))
    equal(expired.status, 'expired', `${status} billing response marks authorization expired`)
    equal(expired.errorCode, 'authorization_expired', `${status} response has a bounded error code`)
  }

  const redirected = await query.executeProviderBillingRequest(getRequest, {
    amountPath: '/amount', currency: 'USD'
  }, async () => new Response('', { status: 302, headers: { location: 'https://evil.example.test' } }))
  equal(redirected.errorCode, 'redirect_blocked', 'billing redirect fails closed')
  const followedRedirect = jsonResponse({ amount: 1 })
  Object.defineProperty(followedRedirect, 'redirected', { value: true })
  const followed = await query.executeProviderBillingRequest(getRequest, {
    amountPath: '/amount', currency: 'USD'
  }, async () => followedRedirect)
  equal(followed.errorCode, 'redirect_blocked', 'already-followed billing redirect also fails closed')

  const crossOriginResponse = jsonResponse({ amount: 1 })
  Object.defineProperty(crossOriginResponse, 'url', { value: 'https://evil.example.test/billing' })
  const crossOrigin = await query.executeProviderBillingRequest(getRequest, {
    amountPath: '/amount', currency: 'USD'
  }, async () => crossOriginResponse)
  equal(crossOrigin.errorCode, 'cross_origin_response_blocked', 'cross-origin final response fails closed')

  const oversizedHeader = await query.executeProviderBillingRequest(getRequest, {
    amountPath: '/amount', currency: 'USD'
  }, async () => new Response('{}', { headers: { 'content-length': String(512 * 1024 + 1) } }))
  equal(oversizedHeader.errorCode, 'response_too_large', 'declared oversized billing response is rejected')
  const oversizedBody = await query.executeProviderBillingRequest(getRequest, {
    amountPath: '/amount', currency: 'USD'
  }, async () => new Response(JSON.stringify({ amount: 1, padding: 'x'.repeat(512 * 1024) })))
  equal(oversizedBody.errorCode, 'response_too_large', 'streamed oversized billing response is rejected')

  const invalidJson = await query.executeProviderBillingRequest(getRequest, {
    amountPath: '/amount', currency: 'USD'
  }, async () => new Response('{invalid'))
  equal(invalidJson.errorCode, 'invalid_json', 'invalid billing JSON is rejected')
  const invalidCurrency = await query.executeProviderBillingRequest(getRequest, {
    amountPath: '/amount', currencyPath: '/currency'
  }, async () => jsonResponse({ amount: 9, currency: 'EUR' }))
  equal(invalidCurrency.errorCode, 'invalid_response', 'non-USD fetched billing response is rejected')
  const networkFailure = await query.executeProviderBillingRequest(getRequest, {
    amountPath: '/amount', currency: 'USD'
  }, async () => { throw new Error('private endpoint details') })
  equal(networkFailure.errorCode, 'network_error', 'network failure returns a bounded error code')
  assert(!JSON.stringify(networkFailure).includes('private endpoint details')
    && !JSON.stringify(readyFetch).includes('https://'),
  'billing fetch results exclude response bodies, endpoint URLs, and thrown details')

  const first = store.saveStoredProviderBillingStatement({
    providerId: 'provider-smoke',
    periodStart: 10_000,
    periodEnd: 20_000,
    billedCostUsd: 12,
    source: 'invoice'
  }, 50_000)
  equal(store.listStoredProviderBillingStatements('provider-smoke').length, 1,
    'billing statement persists and lists by Provider')
  equal(first.billedCostUsd, 12, 'billing amount remains numeric USD')
  assert(/^[a-f0-9]{64}$/.test(first.digest), 'billing statement is digest-bound')

  const updated = store.saveStoredProviderBillingStatement({
    providerId: 'provider-smoke',
    periodStart: 10_000,
    periodEnd: 20_000,
    billedCostUsd: 13,
    source: 'invoice'
  }, 51_000)
  equal(updated.id, first.id, 'same Provider, period, and source updates idempotently')
  equal(updated.createdAt, first.createdAt, 'idempotent update preserves creation time')
  equal(store.listStoredProviderBillingStatements('provider-smoke').length, 1,
    'idempotent update does not duplicate statements')
  equal(updated.billedCostUsd, 13, 'idempotent update replaces the official amount')
  assert(!readdirSync(userData).some((name) => name.includes('.tmp-')),
    'successful atomic publication leaves no temporary file')

  const apiStatement = store.saveStoredProviderBillingStatement({
    providerId: 'provider-api-smoke',
    periodStart: 30_000,
    periodEnd: 40_000,
    billedCostUsd: 7.5,
    source: 'provider-api'
  }, 52_000)
  const apiStatementUpdated = store.saveStoredProviderBillingStatement({
    providerId: 'provider-api-smoke',
    periodStart: 30_000,
    periodEnd: 40_000,
    billedCostUsd: 8,
    source: 'provider-api'
  }, 53_000)
  equal(apiStatementUpdated.id, apiStatement.id, 'same-period Provider API sync upserts idempotently')

  const canonical = readFileSync(storeFile, 'utf8')
  const parsed = JSON.parse(canonical)
  equal(parsed.schemaVersion, 1, 'billing store has an explicit schema version')
  equal(parsed.revision, 4, 'billing store revision advances on each mutation')
  assert(!canonical.toLowerCase().includes('apikey') && !canonical.toLowerCase().includes('baseurl'),
    'billing store excludes credential and endpoint fields')

  parsed.statements[0].digest = '0'.repeat(64)
  writeFileSync(storeFile, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  const corruptedStore = await importFresh(storeModule)
  assertThrows(() => corruptedStore.listStoredProviderBillingStatements('provider-smoke'),
    'digest corruption is rejected instead of being silently accepted')
  equal(readFileSync(storeFile, 'utf8'), `${JSON.stringify(parsed, null, 2)}\n`,
    'corrupted evidence is not overwritten during rejection')

  writeFileSync(storeFile, canonical, 'utf8')
  const removalStore = await importFresh(storeModule)
  equal(removalStore.removeStoredProviderBillingStatement('provider-smoke', updated.id), true,
    'saved billing statement can be removed')
  equal(removalStore.listStoredProviderBillingStatements('provider-smoke').length, 0,
    'removed billing statement no longer lists')
  equal(removalStore.removeStoredProviderBillingStatement('provider-smoke', updated.id), false,
    'repeated removal is idempotent')

  const symlinkTarget = path.join(tempRoot, 'symlink-target.json')
  writeFileSync(symlinkTarget, canonical, 'utf8')
  rmSync(storeFile, { force: true })
  let symlinkCreated = false
  try {
    symlinkSync(symlinkTarget, storeFile, 'file')
    symlinkCreated = true
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
  }
  if (symlinkCreated) {
    const linkedStore = await importFresh(storeModule)
    assertThrows(() => linkedStore.listStoredProviderBillingStatements('provider-smoke'),
      'symbolic-link billing stores are rejected')
  } else {
    const source = readFileSync(path.join(repoRoot, 'src/main/provider/providerBillingStore.ts'), 'utf8')
    assert(source.includes('info.isSymbolicLink()'),
      'symbolic-link rejection guard is present when the host cannot create test links')
  }

  const statement = { ...updated, billedCostUsd: 10 }
  const matched = reconciliation.reconcileProviderBillingStatement(statement, usage({
    costUsd: 10.04,
    costSources: [{ source: 'reported', requests: 2, costUsd: 10.04 }]
  }), 60_000)
  equal(matched.status, 'matched', 'fully reported cost within tolerance matches')
  equal(matched.toleranceUsd, 0.05, 'comparison tolerance is 0.5 percent with a one-cent floor')

  const mismatch = reconciliation.reconcileProviderBillingStatement(statement, usage({
    costUsd: 8,
    costSources: [{ source: 'reported', requests: 2, costUsd: 8 }]
  }), 60_001)
  equal(mismatch.status, 'mismatch', 'fully reported cost outside tolerance mismatches')
  equal(mismatch.differenceUsd, 2, 'billing difference is official minus local cost')

  const noData = reconciliation.reconcileProviderBillingStatement(statement, usage({
    requests: 0,
    pricedRequests: 0,
    costUsd: 0,
    costSources: []
  }))
  equal(noData.status, 'incomplete', 'missing local usage cannot produce a false match')
  assert(noData.incompleteReasons.includes('no-local-data'), 'missing local usage has an explicit reason')

  const truncated = reconciliation.reconcileProviderBillingStatement(statement, usage({ truncated: true }))
  equal(truncated.status, 'incomplete', 'truncated usage cannot produce a match or mismatch')
  assert(truncated.incompleteReasons.includes('usage-truncated'), 'truncated usage has an explicit reason')

  const unpriced = reconciliation.reconcileProviderBillingStatement(statement, usage({
    pricedRequests: 1,
    unpricedRequests: 1,
    costSources: [
      { source: 'reported', requests: 1, costUsd: 5 },
      { source: 'unpriced', requests: 1, costUsd: 0 }
    ]
  }))
  equal(unpriced.status, 'incomplete', 'unpriced requests cannot produce a false comparison')
  assert(unpriced.incompleteReasons.includes('unpriced-requests'), 'unpriced usage has an explicit reason')

  for (const source of ['provider-pricing', 'builtin-pricing', 'imported']) {
    const estimated = reconciliation.reconcileProviderBillingStatement(statement, usage({
      costSources: [{ source, requests: 2, costUsd: 10 }]
    }))
    equal(estimated.status, 'incomplete', `${source} cost cannot impersonate Provider-reported billing`)
    assert(estimated.incompleteReasons.includes('non-reported-costs'),
      `${source} cost has an explicit non-reported reason`)
  }

  const missingProvenance = reconciliation.reconcileProviderBillingStatement(statement, usage({ costSources: [] }))
  equal(missingProvenance.status, 'incomplete', 'missing cost provenance fails closed')
  console.log(`provider billing smoke ok: ${checks.length}/${checks.length} checks passed`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function usage(overrides = {}) {
  return {
    from: 10_000,
    to: 20_000,
    truncated: false,
    requests: 2,
    nativeRequests: 2,
    historicalRequests: 0,
    succeeded: 2,
    failed: 0,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 10,
    latencySamples: 0,
    pricedRequests: 2,
    unpricedRequests: 0,
    costSources: [{ source: 'reported', requests: 2, costUsd: 10 }],
    requestsByProvider: [],
    requestsByModel: [],
    requestsByCredential: [],
    sources: [],
    buckets: [],
    recentOffset: 0,
    recentTotal: 2,
    recentHasMore: false,
    recentRequests: [],
    ...overrides
  }
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
}

function compile() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    'src/main/provider/providerBillingStore.ts',
    'src/main/provider/providerBillingReconciliation.ts',
    'src/main/provider/providerBillingQuery.ts'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronStub() {
  const root = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(root, { recursive: true })
  mkdirSync(userData, { recursive: true })
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'electron', version: '0.0.0', main: 'index.js' }))
  writeFileSync(path.join(root, 'index.js'), `'use strict'\nmodule.exports = { app: { getPath() { return ${JSON.stringify(userData)} } } }\n`)
}

function importFresh(file) {
  const resolved = require.resolve(file)
  delete require.cache[resolved]
  return Promise.resolve(require(resolved))
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

function assert(value, message) {
  checks.push({ name: message, status: value ? 'pass' : 'fail' })
  if (!value) throw new Error(message)
}

function assertThrows(action, message) {
  let thrown = false
  try { action() } catch { thrown = true }
  assert(thrown, message)
}
