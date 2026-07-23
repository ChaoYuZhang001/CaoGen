import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const buildDir = mkdtempSync(path.join(tmpdir(), 'caogen-routing-neutrality-build-'))
const dataDir = mkdtempSync(path.join(tmpdir(), 'caogen-routing-neutrality-data-'))

try {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/model/model-profile.ts',
      'src/main/model/model-router.ts',
      'src/main/modelStats.ts',
      '--outDir',
      buildDir,
      '--target',
      'ES2022',
      '--module',
      'commonjs',
      '--moduleResolution',
      'node',
      '--esModuleInterop',
      '--strict',
      '--skipLibCheck'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )

  const stats = await import(pathToFileURL(findCompiled(buildDir, 'modelStats.js')).href)
  const router = await import(pathToFileURL(findCompiled(buildDir, 'model-router.js')).href)
  stats.configureModelStatsDir(dataDir)

  const baselineProviders = [
    provider('a-provider', 'Plain local relay', 'neutral-alpha'),
    provider('b-provider', 'Plain remote relay', 'neutral-beta')
  ]
  const commercialMutation = [
    provider('a-provider', 'Sponsored Enterprise Platinum', 'neutral-alpha', {
      baseUrl: 'https://renamed-a.invalid/v9',
      budgetUsd: 999_999,
      createdAt: 9_999_999
    }),
    provider('b-provider', 'OpenAI Google Anthropic Premium Partner', 'neutral-beta', {
      baseUrl: 'https://renamed-b.invalid/v42',
      budgetUsd: 1,
      createdAt: 1
    })
  ]

  const taskVariants = [
    { prompt: 'implement TypeScript code', requestedTasks: ['coding'] },
    { prompt: 'research the market', requestedTasks: ['research'] },
    { prompt: 'plan the release', requestedTasks: ['planning'] },
    { prompt: 'run QA tests', requestedTasks: ['testing'] },
    { prompt: 'write product documentation', requestedTasks: ['documentation'] }
  ]

  const decisions = []
  for (const task of taskVariants) {
    const baseline = router.routeModel({ providers: baselineProviders, strategy: 'balanced', ...task })
    const renamed = router.routeModel({ providers: commercialMutation, strategy: 'balanced', ...task })
    const reversed = router.routeModel({ providers: [...commercialMutation].reverse(), strategy: 'balanced', ...task })
    assertEqual(
      decisionFingerprint(renamed),
      decisionFingerprint(baseline),
      `commercial metadata must not change ${task.requestedTasks[0]} routing`
    )
    assertEqual(
      decisionFingerprint(reversed),
      decisionFingerprint(baseline),
      `Provider input order must not change ${task.requestedTasks[0]} routing`
    )
    assert(
      renamed.selected.profile.providerName === commercialMutation[0].name,
      'selected display metadata should remain visible without entering the score'
    )
    decisions.push({ task: task.requestedTasks[0], selected: selectedIdentity(baseline) })
  }

  const sharedModelProviders = [
    provider('b-provider', 'Brand B', 'neutral-shared'),
    provider('a-provider', 'Brand A', 'neutral-shared')
  ]
  const manualForward = router.routeModel({
    providers: sharedModelProviders,
    prompt: 'use the explicitly requested shared model',
    strategy: 'quality',
    manualOverride: { model: 'neutral-shared' },
    crossValidation: { enabled: true, maxValidators: 1, minRiskLevel: 'low' },
    riskLevel: 'high'
  })
  const manualReverse = router.routeModel({
    providers: [...sharedModelProviders].reverse(),
    prompt: 'use the explicitly requested shared model',
    strategy: 'quality',
    manualOverride: { model: 'neutral-shared' },
    crossValidation: { enabled: true, maxValidators: 1, minRiskLevel: 'low' },
    riskLevel: 'high'
  })
  assert(manualForward.manualOverrideApplied, 'model-only manual override must be explicit')
  assertEqual(
    decisionFingerprint(manualForward),
    decisionFingerprint(manualReverse),
    'model-only override and validator ordering must be deterministic'
  )
  assertEqual(
    manualForward.selected.profile.providerId,
    'a-provider',
    'ambiguous model-only override must use the stable Provider identity tie-break'
  )

  const hardBudgetForward = router.routeModel({
    providers: baselineProviders,
    prompt: 'summarize under an impossible hard budget',
    strategy: 'cost',
    budget: { remainingUsd: Number.MIN_VALUE, hardLimit: true }
  })
  const hardBudgetReverse = router.routeModel({
    providers: [...baselineProviders].reverse(),
    prompt: 'summarize under an impossible hard budget',
    strategy: 'cost',
    budget: { remainingUsd: Number.MIN_VALUE, hardLimit: true }
  })
  assertEqual(
    decisionFingerprint(hardBudgetForward),
    decisionFingerprint(hardBudgetReverse),
    'equal-cost hard-budget fallback must be deterministic'
  )

  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  const report = {
    status: 'passed',
    runId,
    checks: [
      'provider-name-does-not-create-model-family-affinity',
      'base-url-budget-created-at-do-not-affect-score',
      'provider-input-order-is-deterministic',
      'model-only-manual-override-is-deterministic',
      'cross-validation-order-is-deterministic',
      'hard-budget-equal-cost-fallback-is-deterministic',
      'display-name-remains-presentational'
    ],
    decisions,
    tieBreak: selectedIdentity(manualForward),
    failures: []
  }
  const reportRoot = path.join(repoRoot, 'test-results', 'routing-commercial-neutrality')
  const reportDir = path.join(reportRoot, runId)
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ ...report, reportDir }, null, 2))
} finally {
  rmSync(buildDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
}

function provider(id, name, model, overrides = {}) {
  return {
    id,
    name,
    baseUrl: `https://${id}.invalid/v1`,
    engine: 'openai',
    models: [model],
    budgetUsd: 0,
    createdAt: 100,
    hasToken: true,
    ...overrides
  }
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
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`)
  }
}
