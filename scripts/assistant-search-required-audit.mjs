#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { bindSourceEvidence, readSourceEvidenceState } from './lib/source-evidence-binding.mjs'

const repoRoot = process.cwd()
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'assistant-search-required')
const runDir = path.join(reportRoot, runId)
const sourceEvidenceStart = readSourceEvidenceState(repoRoot)
const sourceRevision = sourceEvidenceStart.commit
const contract = readJson('scripts/contracts/product-1.0-acceptance-contract.json')
const packageJson = readJson('package.json')
const golden = readJson('test-results/assistant-search-golden/latest.json')
const runtime = readJson('test-results/search-broker-runtime/latest.json')
const recovery = readJson('test-results/search-broker-store-recovery/latest.json')
const expectedGates = [
  'assistant_first_task_without_project',
  'search_broker_success_citation',
  'search_broker_explicit_failure_states',
  'search_broker_restart_duplicate_recovery',
  'search_broker_artifact_evidence_binding'
]
const expectedFailures = ['no_results', 'timeout', 'no_credentials', 'egress_denied', 'provider_failure', 'unknown_result']
const expectedFailureLabels = {
  no_results: '没有找到来源',
  timeout: '搜索超时',
  no_credentials: '没有可用的搜索凭据',
  egress_denied: '外发请求被安全策略拒绝',
  provider_failure: '搜索服务失败',
  unknown_result: '搜索结果无法确认'
}
const searchRequirement = contract.additionalReleaseBlockingScope?.items?.find((item) => item.id === 'SEARCH-001')

assert(searchRequirement, 'SEARCH-001 is missing from the canonical product contract')
assert.deepEqual(searchRequirement.requiredGates, expectedGates)
assert.deepEqual(searchRequirement.failureStates, expectedFailures)
assert(contract.closurePolicy?.requiredPackageScripts?.includes('test:assistant-search-golden:required'),
  'SEARCH-001 required gate is not registered in the global closure policy')
assert.equal(typeof packageJson.scripts?.['test:assistant-search-golden:required'], 'string',
  'SEARCH-001 required package script is missing')
for (const [name, report] of [['golden', golden], ['runtime', runtime], ['recovery', recovery]]) {
  assert.equal(report.status, 'passed', `${name} report is not passed`)
  assert.equal(report.sourceRevision, sourceRevision, `${name} report is bound to ${report.sourceRevision}, not ${sourceRevision}`)
}
assert.equal(golden.sourceRevisionAtEnd, sourceRevision)
assert.equal(golden.sourceCheckoutDigest, sourceEvidenceStart.checkoutDigest,
  'Electron Golden was produced from a different source checkout')
assert.equal(golden.sourceCheckoutDigestAtEnd, sourceEvidenceStart.checkoutDigest,
  'Electron Golden source changed during its run')
assert.equal(golden.provenance?.status, 'pass')
assert.deepEqual(golden.provenance?.drift, [])
assert.deepEqual(Object.keys(golden.requiredGates), expectedGates)
for (const gate of expectedGates) assert.equal(golden.requiredGates[gate]?.status, 'passed', `${gate} is not passed in Electron Golden`)
assert.deepEqual([...runtime.evidence.failureStates].sort(), [...expectedFailures].sort())
assert.equal(runtime.evidence.durableReplay, true)
assert.equal(runtime.evidence.networkFetches, 1)
assert(runtime.evidence.artifactId && runtime.evidence.evidenceId, 'Broker runtime Artifact/Evidence binding is missing')
for (const fault of ['strong_kill', 'network_unknown_result', 'duplicate_idempotency', 'out_of_order']) {
  assert.equal(recovery.faults?.[fault]?.status, 'verified', `Search Store recovery fault is not verified: ${fault}`)
}
assert.equal(golden.interactionEvidence?.followUp, true)
assert.equal(golden.interactionEvidence?.copiedExactToolResult, true)
assert.equal(golden.interactionEvidence?.exportedExactToolResult, true)
assert.deepEqual(golden.interactionEvidence?.boundedPickers, ['project'])
assert.deepEqual(golden.interactionEvidence?.viewports, ['1280x800', '960x640'])
assert(golden.canonicalBinding?.personalWorkspaceId, 'personal Workspace canonical binding is missing')
assert(golden.canonicalBinding?.canonicalRunId, 'personal Workspace Run binding is missing')
assert(golden.canonicalBinding?.artifactId, 'personal Workspace Artifact binding is missing')
assert.match(golden.canonicalBinding?.artifactDigest ?? '', /^sha256:[a-f0-9]{64}$/)
assert(golden.canonicalBinding?.evidenceId, 'personal Workspace Evidence binding is missing')
assert(golden.canonicalBinding?.acceptanceId, 'personal Workspace Acceptance binding is missing')
assert.equal(golden.canonicalBinding?.activeReplay, true)
assert.equal(golden.canonicalBinding?.activeReplayNetworkDelta, 0)
assert.deepEqual(Object.keys(golden.failureEvidence ?? {}), expectedFailures)
for (const status of expectedFailures) {
  const evidence = golden.failureEvidence[status]
  assert.equal(evidence?.result?.ok, false, `${status} did not preserve an explicit failed result`)
  assert.equal(evidence?.result?.status, status)
  assert.deepEqual(evidence?.result?.results, [])
  assert.deepEqual(evidence?.result?.citations, [])
  assert.equal(Object.prototype.hasOwnProperty.call(evidence?.result ?? {}, 'artifactId'), false,
    `${status} exposed a dangling Artifact ID`)
  assert(String(evidence?.visibleText ?? '').includes(expectedFailureLabels[status]),
    `${status} did not preserve its independent visible failure label`)
}

const report = {
  schemaVersion: 1,
  gate: 'test:assistant-search-golden:required',
  runId,
  status: 'passed',
  requirement: 'SEARCH-001 / UX-GOLDEN-001 machine path',
  classification: 'local_targeted_not_release',
  worktreeStatusCount: git(['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean).length,
  requiredGates: Object.fromEntries(expectedGates.map((gate) => [gate, {
    status: 'passed',
    evidence: gate === 'search_broker_restart_duplicate_recovery'
      ? ['assistant-search-golden', 'search-broker-runtime', 'search-broker-store-recovery']
      : gate === 'search_broker_artifact_evidence_binding'
        ? ['assistant-search-golden', 'search-broker-runtime']
        : ['assistant-search-golden']
  }])),
  failureStates: expectedFailures,
  sourceReports: {
    golden: golden.runId,
    runtime: runtime.runId,
    recovery: recovery.runId,
    checkoutDigest: sourceEvidenceStart.checkoutDigest
  },
  explicitlyNotVerified: [
    'five-user timed UX-GOLDEN-001 acceptance',
    'clean release SHA binding',
    'commercial search account quality or availability'
  ]
}
bindSourceEvidence(report, sourceEvidenceStart, readSourceEvidenceState(repoRoot), 'Assistant Search required audit')
assert.equal(report.provenance.status, 'pass', report.error)

mkdirSync(runDir, { recursive: true })
const output = `${JSON.stringify(report, null, 2)}\n`
writeFileSync(path.join(runDir, 'report.json'), output)
writeFileSync(path.join(reportRoot, 'latest.json'), output)
console.log(`assistant search required audit: PASS (${expectedGates.length}/${expectedGates.length})`)
console.log(path.join(runDir, 'report.json'))

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'))
}

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}
