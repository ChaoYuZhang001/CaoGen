#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'search-broker-runtime')
const runDir = path.join(reportRoot, runId)
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'caogen-search-broker-runtime-'))
const compiledPath = path.join(tempRoot, 'search-broker.cjs')
const storeRoot = path.join(tempRoot, 'idempotency')
const evidencePath = path.join(tempRoot, 'evidence.jsonl')
mkdirSync(runDir, { recursive: true })
mkdirSync(storeRoot, { recursive: true })

const typescript = createRequire(path.join(repoRoot, 'package.json'))('typescript')
const source = readFileSync(path.join(repoRoot, 'src/main/search/search-broker.ts'), 'utf8')
const compiled = typescript.transpileModule(source, {
  compilerOptions: {
    target: typescript.ScriptTarget.ES2022,
    module: typescript.ModuleKind.CommonJS,
    esModuleInterop: true,
    isolatedModules: true
  },
  fileName: path.join(repoRoot, 'src/main/search/search-broker.ts')
})
writeFileSync(compiledPath, compiled.outputText)
const { SearchBroker } = createRequire(compiledPath)(compiledPath)

const checks = []
const check = (name, fn) => {
  try {
    fn()
    checks.push({ name, status: 'pass' })
  } catch (error) {
    checks.push({ name, status: 'fail', error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

const body = '<html><title>Durable CaoGen source</title><body>Evidence must survive a process restart.</body></html>'
const bodySha = createHash('sha256').update(body).digest('hex')
let fetchCalls = 0
const fetchImpl = async (url) => {
  fetchCalls += 1
  assert.equal(url.toString(), 'https://example.com/caogen-source')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })
}
const publicEndpointChecker = () => undefined
const evidence = []
const idempotencyStore = diskStore(storeRoot)
const provider = {
  async search() {
    return { status: 'success', results: [{ url: 'https://example.com/caogen-source', summary: 'untrusted snippet' }] }
  }
}

const first = await new SearchBroker({
  modelNative: provider,
  fetchImpl,
  publicEndpointChecker,
  now: () => 1_700_000_000_000,
  idempotencyStore,
  evidenceWriter: (records) => {
    evidence.push(...records)
    for (const record of records) writeFileSync(evidencePath, `${JSON.stringify(record)}\n`, { flag: 'a' })
  }
}).search({
  mode: 'model_native',
  query: 'durable search',
  operationId: 'durable-success',
  projectId: 'project-1',
  goalId: 'goal-1',
  workItemId: 'work-1',
  runId: 'run-1',
  artifactId: 'artifact-1'
})

check('success persists fetched evidence and canonical bindings', () => {
  assert.equal(first.ok, true)
  assert.equal(first.contentSha256, bodySha)
  assert.equal(first.projectId, 'project-1')
  assert.equal(first.runId, 'run-1')
  assert.equal(first.artifactId, 'artifact-1')
  assert.equal(first.evidenceId, first.results[0].evidenceId)
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0].artifactId, 'artifact-1')
  assert.equal(evidence[0].contentDigest, bodySha)
  assert.equal(evidence[0].uri, 'https://example.com/caogen-source')
  assert.equal(readdirSync(storeRoot).length, 1)
  assert.equal(fetchCalls, 1)
})

const replay = await new SearchBroker({
  modelNative: {
    async search() {
      throw new Error('provider must not run during durable replay')
    }
  },
  fetchImpl: async () => {
    throw new Error('source fetch must not run during durable replay')
  },
  publicEndpointChecker,
  idempotencyStore: diskStore(storeRoot)
}).search({
  mode: 'model_native',
  query: 'durable search',
  operationId: 'durable-success',
  projectId: 'project-1',
  goalId: 'goal-1',
  workItemId: 'work-1',
  runId: 'run-1',
  artifactId: 'artifact-1'
})

check('a fresh Broker instance replays the same success without network or duplicate evidence', () => {
  assert.equal(replay.ok, true)
  assert.equal(replay.idempotentReplay, true)
  assert.equal(replay.evidenceId, first.evidenceId)
  assert.equal(replay.contentSha256, bodySha)
  assert.equal(fetchCalls, 1)
  assert.equal(readFileSync(evidencePath, 'utf8').trim().split('\n').length, 1)
})

const failureStore = diskStore(path.join(tempRoot, 'failure-idempotency'))
const noResult = await new SearchBroker({
  modelNative: { async search() { return { status: 'success', results: [] } } },
  idempotencyStore: failureStore
}).search({ mode: 'model_native', query: 'sticky failure', operationId: 'durable-no-results' })
const failureReplay = await new SearchBroker({
  modelNative: { async search() { throw new Error('failure replay must not call provider') } },
  idempotencyStore: diskStore(path.join(tempRoot, 'failure-idempotency'))
}).search({ mode: 'model_native', query: 'sticky failure', operationId: 'durable-no-results' })

check('failed search states are durable and cannot be replaced by a later provider result', () => {
  assert.equal(noResult.ok, false)
  assert.equal(noResult.status, 'no_results')
  assert.equal(failureReplay.ok, false)
  assert.equal(failureReplay.status, 'no_results')
  assert.equal(failureReplay.idempotentReplay, true)
})

const failureMatrix = await Promise.all([
  new SearchBroker({
    byokSearchAdapter: { available: false, async search() { throw new Error('unreachable') } }
  }).search({ mode: 'byok_search_adapter', query: 'missing key', operationId: 'failure-no-credentials' }),
  new SearchBroker({
    timeoutMs: 5,
    modelNative: { async search() { await new Promise((resolve) => setTimeout(resolve, 50)); return { results: [] } } }
  }).search({ mode: 'model_native', query: 'slow provider', operationId: 'failure-timeout' }),
  new SearchBroker({
    modelNative: { async search() { return { results: [{ url: 'http://127.0.0.1/private' }] } } },
    publicEndpointChecker: () => { throw new Error('private endpoint') }
  }).search({ mode: 'model_native', query: 'private source', operationId: 'failure-egress' }),
  new SearchBroker({
    modelNative: { async search() { throw new Error('upstream unavailable') } }
  }).search({ mode: 'model_native', query: 'provider outage', operationId: 'failure-provider' }),
  new SearchBroker({
    modelNative: { async search() { return { status: 'success', results: [{ url: '' }] } } }
  }).search({ mode: 'model_native', query: 'malformed source', operationId: 'failure-unknown' })
])

check('all required failure states remain explicit and fail closed', () => {
  assert.deepEqual(
    failureMatrix.map((result) => result.status),
    ['no_credentials', 'timeout', 'egress_denied', 'provider_failure', 'unknown_result']
  )
  for (const result of failureMatrix) {
    assert.equal(result.ok, false)
    assert.equal(result.results.length, 0)
    assert.equal(result.citations.length, 0)
  }
})

const partialEvidence = []
const partialFailure = await new SearchBroker({
  modelNative: {
    async search() {
      return {
        status: 'success',
        results: [
          { url: 'https://example.com/caogen-source' },
          { url: 'https://example.com/unavailable' }
        ]
      }
    }
  },
  fetchImpl: async (url) => url.pathname === '/caogen-source'
    ? new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })
    : new Response('unavailable', { status: 503, headers: { 'content-type': 'text/plain' } }),
  publicEndpointChecker,
  evidenceWriter: (records) => { partialEvidence.push(...records) }
}).search({
  mode: 'model_native',
  query: 'multi-source atomic evidence',
  operationId: 'multi-source-atomic-evidence',
  limit: 2
})

check('a later source failure leaves no partial Evidence batch', () => {
  assert.equal(partialFailure.ok, false)
  assert.equal(partialFailure.status, 'provider_failure')
  assert.equal(partialEvidence.length, 0)
})

const report = {
  schemaVersion: 1,
  gate: 'test:search-broker:runtime',
  runId,
  status: 'passed',
  classification: 'local_targeted_verified',
  sourceRevision: gitOutput(['rev-parse', 'HEAD']),
  worktreeStatusCount: gitStatusCount(),
  checks,
    evidence: {
    sourceSha256: bodySha,
    evidenceId: first.evidenceId,
    artifactId: first.artifactId,
    fetchedAt: first.fetchedAt,
    durableReplay: replay.idempotentReplay,
    networkFetches: fetchCalls,
    failureStates: ['no_results', ...failureMatrix.map((result) => result.status)]
  },
  explicitlyNotVerified: [
    'a real commercial search account or external web-search provider',
    'five-user timed acceptance and clean release SHA binding'
  ]
}
writeFileSync(path.join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(`search broker runtime e2e: PASS (${checks.length}/${checks.length})`)
console.log(path.join(runDir, 'report.json'))

function gitOutput(args) {
  try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim() } catch { return '' }
}

function gitStatusCount() {
  return gitOutput(['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean).length
}

function diskStore(root) {
  mkdirSync(root, { recursive: true })
  return {
    get(operationId) {
      const file = operationFile(root, operationId)
      if (!existsSync(file)) return undefined
      return JSON.parse(readFileSync(file, 'utf8'))
    },
    put(operationId, result) {
      const file = operationFile(root, operationId)
      const temporary = `${file}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify(result)}\n`)
      renameSync(temporary, file)
    }
  }
}

function operationFile(root, operationId) {
  const digest = createHash('sha256').update(operationId).digest('hex')
  return path.join(root, `${digest}.json`)
}
