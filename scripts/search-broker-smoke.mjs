import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const brokerSource = path.join(repoRoot, 'src/main/search/search-broker.ts')
const adapterSource = path.join(repoRoot, 'src/main/search/search-adapter.ts')
const openaiToolsSource = readFileSync(path.join(repoRoot, 'src/main/openaiTools.ts'), 'utf8')
const p2ToolsSource = readFileSync(path.join(repoRoot, 'src/main/agent/tools/p2-tools.ts'), 'utf8')
const searchResultSource = readFileSync(path.join(repoRoot, 'src/renderer/src/components/SearchToolResult.tsx'), 'utf8')
assert.match(p2ToolsSource, /name: 'web_search'/, 'canonical P2 tool schema must expose web_search')
assert.match(openaiToolsSource, /\.\.\.P2_TOOLS/, 'OpenAI tool registry must derive web_search from P2_TOOLS')
assert.doesNotMatch(openaiToolsSource, /name: ['"]web_search['"]/, 'web_search must not have a duplicate direct schema')
assert.match(p2ToolsSource, /if \(name === 'web_search'\)/, 'canonical P2 dispatch must execute web_search')
assert.match(p2ToolsSource, /searchBroker\?: SearchBroker/, 'P2 execution must expose the broker injection seam')
assert.match(searchResultSource, /parsed\.ok === true && declaredStatus === 'success'/, 'search result UI must require an explicit success status')
assert.match(searchResultSource, /return \{ ok: false, status: 'unknown_result' \}/, 'search result UI must fail closed for contradictory status')
const typescript = loadTypeScript(repoRoot)
const compiledDir = mkdtempSync(path.join(os.tmpdir(), 'caogen-search-broker-'))
const compiledPath = path.join(compiledDir, 'search-broker.cjs')
const compiled = typescript.transpileModule(readFileSync(brokerSource, 'utf8'), {
  compilerOptions: {
    target: typescript.ScriptTarget.ES2022,
    module: typescript.ModuleKind.CommonJS,
    esModuleInterop: true,
    isolatedModules: true
  },
  fileName: brokerSource
})
writeFileSync(compiledPath, compiled.outputText)
const { SearchBroker } = createRequire(compiledPath)(compiledPath)
const adapterCompiled = typescript.transpileModule(readFileSync(adapterSource, 'utf8'), {
  compilerOptions: {
    target: typescript.ScriptTarget.ES2022,
    module: typescript.ModuleKind.CommonJS,
    esModuleInterop: true,
    isolatedModules: true
  },
  fileName: adapterSource
})
const adapterPath = path.join(compiledDir, 'search-adapter.cjs')
writeFileSync(adapterPath, adapterCompiled.outputText)
const { configuredSearchAdapter } = createRequire(adapterPath)(adapterPath)
const rendererCompiled = typescript.transpileModule(searchResultSource, {
  compilerOptions: {
    target: typescript.ScriptTarget.ES2022,
    module: typescript.ModuleKind.CommonJS,
    jsx: typescript.JsxEmit.ReactJSX,
    esModuleInterop: true,
    isolatedModules: true
  },
  fileName: path.join(repoRoot, 'src/renderer/src/components/SearchToolResult.tsx')
})
const rendererPath = path.join(compiledDir, 'SearchToolResult.cjs')
writeFileSync(rendererPath, rendererCompiled.outputText)
const previousNodePath = process.env.NODE_PATH
process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), previousNodePath].filter(Boolean).join(path.delimiter)
Module._initPaths()
const { searchResultViewState } = createRequire(rendererPath)(rendererPath)

const sourceBody = '<html><title>Verified source</title><body>Fetched material is the only citation source.</body></html>'
const sourceSha = createHash('sha256').update(sourceBody).digest('hex')
let fetchCalls = 0
const fetchImpl = async (url) => {
  fetchCalls += 1
  assert.equal(url.toString(), 'https://example.com/source')
  return new Response(sourceBody, { status: 200, headers: { 'content-type': 'text/html' } })
}
const endpointPolicy = () => undefined

const evidence = []
let evidenceBatchWrites = 0
const native = new SearchBroker({
  modelNative: {
    async search(input) {
      assert.equal(input.query, 'CaoGen search')
      assert.equal(input.projectId, undefined)
      return { status: 'success', results: [{ url: 'https://example.com/source', summary: 'UNTRUSTED MODEL SUMMARY' }] }
    }
  },
  fetchImpl,
  publicEndpointChecker: endpointPolicy,
  now: () => 1_700_000_000_000,
  evidenceWriter: (records) => {
    evidenceBatchWrites += 1
    evidence.push(...records)
  }
})
const nativeResult = await native.search({ mode: 'model_native', query: 'CaoGen search', operationId: 'native-success', runId: 'run-1', artifactId: 'artifact-1' })
assert.equal(nativeResult.ok, true)
assert.equal(nativeResult.status, 'success')
assert.equal(nativeResult.projectId, null)
assert.equal(nativeResult.runId, 'run-1')
assert.equal(nativeResult.artifactId, 'artifact-1')
assert.equal(nativeResult.url, 'https://example.com/source')
assert.equal(nativeResult.fetchedAt, 1_700_000_000_000)
assert.equal(nativeResult.contentSha256, sourceSha)
assert.equal(nativeResult.summary, 'Verified source Fetched material is the only citation source.')
assert.notEqual(nativeResult.summary, 'UNTRUSTED MODEL SUMMARY')
assert.match(nativeResult.citation, new RegExp(sourceSha))
assert.equal(nativeResult.evidenceId, nativeResult.results[0].evidenceId)
assert.equal(evidence.length, 1)
assert.equal(evidence[0].contentDigest, sourceSha)
assert.equal(evidence[0].uri, nativeResult.url)
assert.equal(evidence[0].artifactId, 'artifact-1')
assert.equal(evidenceBatchWrites, 1)
assert.equal(fetchCalls, 1)

let invalidModeAdapterCalls = 0
const invalidModeResult = await new SearchBroker({
  modelNative: { async search() { invalidModeAdapterCalls += 1; return { status: 'success', results: [] } } },
  publicEndpointChecker: endpointPolicy
}).search({ mode: 'unsupported_mode', query: 'invalid mode', operationId: 'invalid-mode' })
assert.equal(invalidModeResult.ok, false)
assert.equal(invalidModeResult.status, 'unknown_result')
assert.match(invalidModeResult.message, /model_native or byok_search_adapter/)
assert.equal(invalidModeAdapterCalls, 0)

const validRendererCitation = {
  url: 'https://example.com/source',
  fetchedAt: 1_700_000_000_000,
  summary: 'verified source',
  contentSha256: 'a'.repeat(64),
  citation: '[https://example.com/source] (sha256:' + 'a'.repeat(64) + ')',
  evidenceId: 'evidence-1'
}
assert.deepEqual(searchResultViewState({
  ok: true,
  status: 'success',
  url: validRendererCitation.url,
  fetchedAt: validRendererCitation.fetchedAt,
  summary: validRendererCitation.summary,
  contentSha256: validRendererCitation.contentSha256,
  citation: validRendererCitation.citation,
  evidenceId: validRendererCitation.evidenceId,
  results: [validRendererCitation]
}), { ok: true, status: 'success' })
assert.deepEqual(searchResultViewState({ ok: true, status: 'success' }), { ok: false, status: 'unknown_result' })
assert.deepEqual(searchResultViewState({ ok: true, status: 'timeout' }), { ok: false, status: 'timeout' })
assert.deepEqual(searchResultViewState({ ok: false, status: 'success' }), { ok: false, status: 'unknown_result' })
assert.deepEqual(searchResultViewState({ ok: true }), { ok: false, status: 'unknown_result' })
assert.deepEqual(searchResultViewState({ ok: true, status: 'untrusted' }), { ok: false, status: 'unknown_result' })

const evidenceFailure = new SearchBroker({
  modelNative: { async search() { return { status: 'success', results: [{ url: 'https://example.com/source' }] } } },
  fetchImpl,
  publicEndpointChecker: endpointPolicy,
  evidenceWriter: () => { throw new Error('ledger unavailable') }
})
const evidenceFailureResult = await evidenceFailure.search({
  mode: 'model_native',
  query: 'evidence fail-closed',
  operationId: 'evidence-fail-closed'
})
assert.equal(evidenceFailureResult.ok, false)
assert.equal(evidenceFailureResult.status, 'provider_failure')

const partialFailureEvidence = []
const partialFailureResult = await new SearchBroker({
  modelNative: {
    async search() {
      return {
        status: 'success',
        results: [
          { url: 'https://example.com/source' },
          { url: 'https://example.com/unavailable' }
        ]
      }
    }
  },
  fetchImpl: async (url) => url.pathname === '/source'
    ? new Response(sourceBody, { status: 200, headers: { 'content-type': 'text/html' } })
    : new Response('unavailable', { status: 503, headers: { 'content-type': 'text/plain' } }),
  publicEndpointChecker: endpointPolicy,
  evidenceWriter: (records) => { partialFailureEvidence.push(...records) }
}).search({
  mode: 'model_native',
  query: 'partial failure must not persist evidence',
  operationId: 'partial-evidence-failure',
  limit: 2
})
assert.equal(partialFailureResult.ok, false)
assert.equal(partialFailureResult.status, 'provider_failure')
assert.equal(partialFailureEvidence.length, 0)

const byok = new SearchBroker({
  byokSearchAdapter: {
    available: true,
    async search() { return { status: 'success', results: [{ url: 'https://example.com/source' }] } }
  },
  fetchImpl,
  publicEndpointChecker: endpointPolicy
})
const byokResult = await byok.search({ mode: 'byok_search_adapter', query: 'BYOK', operationId: 'byok-success', projectId: 'project-1', runId: 'run-2' })
assert.equal(byokResult.ok, true)
assert.equal(byokResult.projectId, 'project-1')
assert.equal(byokResult.runId, 'run-2')

async function failureFor(mode, adapter, operationId, expected, options = {}) {
  const broker = new SearchBroker({
    ...(mode === 'model_native' ? { modelNative: adapter } : { byokSearchAdapter: adapter }),
    fetchImpl: options.fetchImpl ?? fetchImpl,
    publicEndpointChecker: endpointPolicy,
    timeoutMs: options.timeoutMs ?? 20
  })
  const result = await broker.search({ mode, query: 'failure test', operationId })
  assert.equal(result.ok, false)
  assert.equal(result.status, expected)
  assert.equal(result.results.length, 0)
  return result
}

await failureFor('model_native', { async search() { return { status: 'success', results: [] } } }, 'no-results', 'no_results')
await failureFor('byok_search_adapter', undefined, 'no-credentials', 'no_credentials')
await failureFor('model_native', { async search() { return new Promise(() => {}) } }, 'provider-timeout', 'timeout', { timeoutMs: 5 })
await failureFor('model_native', { async search() { return { status: 'success', results: [{ url: 'http://example.com/source' }] } } }, 'egress-denied', 'egress_denied')
await failureFor('model_native', { async search() { throw new Error('upstream unavailable') } }, 'provider-failure', 'provider_failure')
await failureFor('model_native', { async search() { return {} } }, 'unknown-result', 'unknown_result')
await failureFor('model_native', { async search() { return { status: 'unexpected_provider_state', results: [] } } }, 'unknown-status', 'unknown_result')
await failureFor('byok_search_adapter', { available: false, async search() { throw new Error('must not run') } }, 'credentials-disabled', 'no_credentials')

const previousEndpoint = process.env.CAOGEN_SEARCH_ADAPTER_SMOKE_URL
const previousKey = process.env.CAOGEN_SEARCH_ADAPTER_SMOKE_KEY
const previousFetch = globalThis.fetch
try {
  process.env.CAOGEN_SEARCH_ADAPTER_SMOKE_URL = 'http://127.0.0.1:9/search'
  delete process.env.CAOGEN_SEARCH_ADAPTER_SMOKE_KEY
  let adapterBody = { status: 'success', results: [{ url: 'https://example.com/source' }] }
  globalThis.fetch = async () => new Response(JSON.stringify(adapterBody), { status: 200, headers: { 'content-type': 'application/json' } })
  const adapter = configuredSearchAdapter('CAOGEN_SEARCH_ADAPTER_SMOKE_URL', 'CAOGEN_SEARCH_ADAPTER_SMOKE_KEY')
  assert(adapter)
  assert.equal(await adapter.available?.(), false)
  assert.equal((await adapter.search({ query: 'missing credentials', mode: 'byok_search_adapter', operationId: 'adapter-no-key', limit: 1 })).status, 'no_credentials')

  process.env.CAOGEN_SEARCH_ADAPTER_SMOKE_KEY = 'test-only-key'
  assert.equal(await adapter.available?.(), true)
  adapterBody = { status: 'unexpected', results: [] }
  assert.equal((await adapter.search({ query: 'unknown status', mode: 'byok_search_adapter', operationId: 'adapter-unknown-status', limit: 1 })).status, 'unknown_result')
  adapterBody = { status: 'success' }
  assert.equal((await adapter.search({ query: 'missing results', mode: 'byok_search_adapter', operationId: 'adapter-missing-results', limit: 1 })).status, 'unknown_result')
  adapterBody = { status: 'success', results: [{}] }
  assert.equal((await adapter.search({ query: 'invalid item', mode: 'byok_search_adapter', operationId: 'adapter-invalid-item', limit: 1 })).status, 'unknown_result')
  adapterBody = { status: 'no_results', message: 'none' }
  assert.equal((await adapter.search({ query: 'none', mode: 'byok_search_adapter', operationId: 'adapter-no-results', limit: 1 })).status, 'no_results')
  adapterBody = null
  assert.equal((await adapter.search({ query: 'null body', mode: 'byok_search_adapter', operationId: 'adapter-null-body', limit: 1 })).status, 'unknown_result')
} finally {
  globalThis.fetch = previousFetch
  if (previousEndpoint === undefined) delete process.env.CAOGEN_SEARCH_ADAPTER_SMOKE_URL
  else process.env.CAOGEN_SEARCH_ADAPTER_SMOKE_URL = previousEndpoint
  if (previousKey === undefined) delete process.env.CAOGEN_SEARCH_ADAPTER_SMOKE_KEY
  else process.env.CAOGEN_SEARCH_ADAPTER_SMOKE_KEY = previousKey
}

let concurrentProviderCalls = 0
let releaseConcurrentProvider
let markConcurrentProviderStarted
const concurrentProviderStarted = new Promise((resolve) => { markConcurrentProviderStarted = resolve })
const concurrentProviderRelease = new Promise((resolve) => { releaseConcurrentProvider = resolve })
const concurrentBroker = new SearchBroker({
  modelNative: {
    async search() {
      concurrentProviderCalls += 1
      markConcurrentProviderStarted()
      await concurrentProviderRelease
      return { status: 'success', results: [{ url: 'https://example.com/source' }] }
    }
  },
  fetchImpl,
  publicEndpointChecker: endpointPolicy
})
const concurrentFirst = concurrentBroker.search({ mode: 'model_native', query: 'concurrent', operationId: 'concurrent-operation' })
await concurrentProviderStarted
const concurrentSecond = concurrentBroker.search({ mode: 'model_native', query: 'concurrent', operationId: 'concurrent-operation' })
assert.equal(concurrentProviderCalls, 1)
releaseConcurrentProvider()
const [concurrentFirstResult, concurrentSecondResult] = await Promise.all([concurrentFirst, concurrentSecond])
assert.equal(concurrentFirstResult.ok, true)
assert.equal(concurrentSecondResult.ok, true)
assert.equal(concurrentFirstResult.idempotentReplay, false)
assert.equal(concurrentSecondResult.idempotentReplay, true)
assert.equal(concurrentSecondResult.evidenceId, concurrentFirstResult.evidenceId)
assert.equal(concurrentProviderCalls, 1)

const restartStore = new Map()
const idempotencyStore = {
  async get(operationId) { return restartStore.get(operationId) },
  async put(operationId, result) { restartStore.set(operationId, result) }
}
let restartFetchCalls = 0
const restartBrokerOptions = {
  modelNative: { async search() { return { status: 'success', results: [{ url: 'https://example.com/source' }] } } },
  fetchImpl: async (...args) => { restartFetchCalls += 1; return fetchImpl(...args) },
  publicEndpointChecker: endpointPolicy,
  idempotencyStore
}
const firstRun = await new SearchBroker(restartBrokerOptions).search({ mode: 'model_native', query: 'restart', operationId: 'restart-duplicate' })
const replay = await new SearchBroker(restartBrokerOptions).search({ mode: 'model_native', query: 'restart', operationId: 'restart-duplicate' })
assert.equal(firstRun.ok, true)
assert.equal(replay.ok, true)
assert.equal(replay.idempotentReplay, true)
assert.equal(replay.evidenceId, firstRun.evidenceId)
assert.equal(restartFetchCalls, 1)

console.log('search-broker smoke: PASS')

function loadTypeScript(root) {
  const candidateRoots = [
    path.join(root, 'node_modules'),
    path.join(path.dirname(root), 'agent-desk', 'node_modules')
  ]
  for (const modulesRoot of candidateRoots) {
    if (!existsSync(path.join(modulesRoot, 'typescript'))) continue
    return createRequire(path.join(modulesRoot, 'package.json'))('typescript')
  }
  throw new Error('TypeScript dependency is required for search-broker smoke')
}
