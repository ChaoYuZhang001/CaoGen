#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const buildDir = mkdtempSync(path.join(tmpdir(), 'caogen-local-provider-parity-build-'))
const dataDir = mkdtempSync(path.join(tmpdir(), 'caogen-local-provider-parity-data-'))
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'local-provider-parity')
const reportDir = path.join(reportRoot, runId)

try {
  compileRouter()
  const stats = await import(pathToFileURL(findCompiled(buildDir, 'modelStats.js')).href)
  const health = await import(pathToFileURL(findCompiled(buildDir, 'providerHealth.js')).href)
  const router = await import(pathToFileURL(findCompiled(buildDir, 'model-router.js')).href)
  const sessionRouting = await import(pathToFileURL(findCompiled(buildDir, 'session-routing.js')).href)
  stats.configureModelStatsDir(path.join(dataDir, 'model-stats'))
  health.configureProviderHealthDir(path.join(dataDir, 'provider-health'))

  const local = provider({
    id: 'a-local-compatible',
    name: 'Local compatible service',
    baseUrl: 'http://127.0.0.1:11434/v1',
    openaiProtocol: 'responses'
  })
  const remote = provider({
    id: 'b-remote-compatible',
    name: 'Remote compatible service',
    baseUrl: 'https://remote.example.invalid/v1',
    openaiProtocol: 'chat'
  })
  const providers = [local, remote]
  const checks = []
  const decisions = []

  for (const routeCase of routeCases()) {
    const baseline = router.routeModel({ providers, ...routeCase.input })
    const reversed = router.routeModel({ providers: [...providers].reverse(), ...routeCase.input })
    const locationSwapped = router.routeModel({
      providers: [
        { ...local, baseUrl: remote.baseUrl, openaiProtocol: remote.openaiProtocol },
        { ...remote, baseUrl: local.baseUrl, openaiProtocol: local.openaiProtocol }
      ],
      ...routeCase.input
    })
    assertEqual(decisionFingerprint(reversed), decisionFingerprint(baseline), `${routeCase.name}: input order changed routing`)
    assertEqual(
      decisionFingerprint(locationSwapped),
      decisionFingerprint(baseline),
      `${routeCase.name}: Base URL or protocol label changed routing`
    )
    assertEqual(
      baseline.selected.profile.providerId,
      local.id,
      `${routeCase.name}: identical local candidate did not win the stable tie-break`
    )
    assert(
      baseline.candidates.some((candidate) => candidate.profile.providerId === local.id),
      `${routeCase.name}: local candidate disappeared`
    )
    assert(
      baseline.candidates.some((candidate) => candidate.profile.providerId === remote.id),
      `${routeCase.name}: remote comparison candidate disappeared`
    )
    decisions.push({ name: routeCase.name, selected: selectedIdentity(baseline), candidateCount: baseline.candidates.length })
    checks.push(`${routeCase.name}-local-equal-candidacy`)
  }

  const manual = router.routeModel({
    providers,
    prompt: 'use the explicitly selected local model',
    strategy: 'quality',
    manualOverride: { providerId: local.id, model: 'gpt-5.6', reason: 'local operator choice' }
  })
  assert(manual.manualOverrideApplied, 'explicit local override was not applied')
  assertEqual(manual.selected.profile.providerId, local.id, 'explicit local override selected another Provider')
  checks.push('manual-local-provider-selection')

  const crossValidation = router.routeModel({
    providers,
    prompt: 'review a production release migration',
    requestedTasks: ['review', 'reasoning'],
    strategy: 'quality',
    riskLevel: 'high',
    crossValidation: { enabled: true, maxValidators: 1, minRiskLevel: 'low' }
  })
  assertEqual(crossValidation.selected.profile.providerId, local.id, 'local candidate could not act as primary')
  assert(crossValidation.crossValidationPlan.enabled, 'cross-validation plan was not created')
  assertEqual(
    crossValidation.crossValidationPlan.validators[0]?.providerId,
    remote.id,
    'remote candidate could not validate the equivalent local primary'
  )
  checks.push('local-primary-remote-validator')

  const globalRoute = resolveSession(sessionRouting, {
    providers,
    providerId: remote.id,
    allowAnyEngine: true,
    payload: { text: 'implement TypeScript code with tools', images: [] },
    strategy: 'balanced'
  })
  assertEqual(globalRoute.providerId, local.id, 'global automatic routing penalized the local service')
  assert(globalRoute.switchedProvider, 'global route did not switch from remote to the equal local winner')
  assertEqual(globalRoute.decision.candidateCount, 6, 'global route did not include every local and remote model')
  checks.push('global-session-routing-local-candidate')

  const scopedRoute = resolveSession(sessionRouting, {
    providers,
    providerId: remote.id,
    engine: 'openai',
    allowAnyEngine: false,
    payload: { text: 'review and test this release', images: [] },
    strategy: 'cost'
  })
  assertEqual(scopedRoute.providerId, local.id, 'engine-scoped routing penalized the local service')
  assertEqual(scopedRoute.decision.candidateCount, 6, 'engine-scoped route dropped local candidates')
  checks.push('engine-scoped-session-routing-local-candidate')

  for (let index = 0; index < 3; index += 1) health.recordFailure(remote.id, '503 service unavailable')
  const remoteUnhealthy = resolveSession(sessionRouting, {
    providers,
    providerId: remote.id,
    engine: 'openai',
    payload: { text: 'continue locally after the remote service fails', images: [] },
    strategy: 'balanced'
  })
  assertEqual(remoteUnhealthy.providerId, local.id, 'healthy local service did not continue after remote health failure')
  assert(remoteUnhealthy.decision.warnings.some((warning) => warning.includes('Provider')), 'health exclusion was not visible')
  checks.push('healthy-local-continuation-after-remote-failure')

  health.recordSuccess(remote.id, 120)
  for (let index = 0; index < 3; index += 1) health.recordFailure(local.id, 'ECONNREFUSED')
  const localUnhealthy = resolveSession(sessionRouting, {
    providers,
    providerId: local.id,
    engine: 'openai',
    payload: { text: 'continue remotely while the local service is unavailable', images: [] },
    strategy: 'balanced'
  })
  assertEqual(localUnhealthy.providerId, remote.id, 'local service bypassed the common health policy')
  checks.push('local-provider-obeys-common-health-policy')

  for (let index = 0; index < 3; index += 1) health.recordFailure(remote.id, '503 service unavailable')
  const allUnhealthy = resolveSession(sessionRouting, {
    providers: [...providers].reverse(),
    providerId: remote.id,
    engine: 'openai',
    payload: { text: 'continue with all compatible services marked unhealthy', images: [] },
    strategy: 'balanced'
  })
  assertEqual(allUnhealthy.providerId, local.id, 'all-unhealthy fallback introduced a local-service penalty')
  assert(
    allUnhealthy.decision.warnings.some((warning) => warning.includes('全部候选')),
    'all-unhealthy fallback did not report the shared policy'
  )
  checks.push('all-unhealthy-local-equal-fallback')

  const report = {
    schemaVersion: 1,
    status: 'passed',
    runId,
    requirement: 'required',
    requirementIds: ['NFR-PRIV-004'],
    checks,
    decisions,
    localProvider: {
      providerId: local.id,
      baseUrlClass: 'loopback-http',
      protocol: local.openaiProtocol,
      modelCount: local.models.length
    },
    policyBoundary: {
      providerLocationAffectsScore: false,
      providerProtocolLabelAffectsScore: false,
      healthPolicyShared: true,
      manualSelectionSupported: true,
      automaticSelectionSupported: true,
      crossValidationSupported: true
    },
    failures: []
  }
  mkdirSync(reportDir, { recursive: true })
  const body = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(reportDir, 'report.json'), body)
  writeFileSync(path.join(reportRoot, 'latest.json'), body)
  console.log(JSON.stringify({ ...report, reportDir }, null, 2))
} finally {
  rmSync(buildDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
}

function compileRouter() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/model/model-profile.ts',
    'src/main/model/model-router.ts',
    'src/main/model/session-routing.ts',
    'src/main/modelStats.ts',
    '--outDir', buildDir,
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--esModuleInterop',
    '--strict',
    '--skipLibCheck'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function provider({ id, name, baseUrl, openaiProtocol }) {
  return {
    id,
    name,
    baseUrl,
    engine: 'openai',
    models: ['gpt-5.6', 'gemini-2.5-flash', 'claude-sonnet-4'],
    budgetUsd: 0,
    createdAt: 100,
    hasToken: true,
    openaiProtocol
  }
}

function routeCases() {
  return [
    {
      name: 'balanced-tools',
      input: { prompt: 'implement TypeScript code', requestedTasks: ['coding'], requiresTools: true, strategy: 'balanced' }
    },
    {
      name: 'speed-tools',
      input: { prompt: 'quickly fix and test code', requestedTasks: ['coding', 'testing'], requiresTools: true, strategy: 'speed' }
    },
    {
      name: 'quality-review',
      input: { prompt: 'review a critical release', requestedTasks: ['review', 'reasoning'], riskLevel: 'high', strategy: 'quality' }
    },
    {
      name: 'cost-documentation',
      input: { prompt: 'write concise documentation', requestedTasks: ['documentation'], strategy: 'cost' }
    },
    {
      name: 'vision-capability',
      input: {
        prompt: 'inspect this interface screenshot',
        attachments: [{ mime: 'image/png' }],
        requiresVision: true,
        strategy: 'balanced'
      }
    },
    {
      name: 'hard-budget',
      input: {
        prompt: 'summarize within a hard budget',
        requestedTasks: ['summarization'],
        strategy: 'cost',
        budget: { remainingUsd: Number.MIN_VALUE, hardLimit: true }
      }
    }
  ]
}

function resolveSession(sessionRouting, overrides) {
  const result = sessionRouting.resolveSessionModelRoute({
    enabled: true,
    currentModel: 'auto',
    providerId: '',
    providers: [],
    engine: 'openai',
    allowAnyEngine: false,
    payload: { text: '', images: [] },
    strategy: 'balanced',
    sessionCostUsd: 0,
    settingsBudgetUsd: 0,
    ...overrides
  })
  assert(result.kind === 'routed', `expected routed session result, got ${result.kind}`)
  return result
}

function selectedIdentity(decision) {
  return {
    providerId: decision.selected.profile.providerId,
    model: decision.selected.profile.model
  }
}

function decisionFingerprint(decision) {
  return JSON.stringify({
    selected: selectedIdentity(decision),
    candidates: decision.candidates.map((candidate) => ({
      providerId: candidate.profile.providerId,
      model: candidate.profile.model,
      score: candidate.score,
      estimatedCostUsd: candidate.estimatedCostUsd,
      latencyEmaMs: candidate.latencyEmaMs ?? null
    })),
    validators: decision.crossValidationPlan.validators.map((candidate) => ({
      providerId: candidate.providerId,
      model: candidate.model
    }))
  })
}

function findCompiled(root, fileName) {
  const found = findCompiledMaybe(root, fileName)
  if (!found) throw new Error(`compiled file not found: ${fileName}`)
  return found
}

function findCompiledMaybe(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledMaybe(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  return undefined
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`)
}
