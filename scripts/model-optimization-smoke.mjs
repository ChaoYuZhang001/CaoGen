import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const buildDir = mkdtempSync(path.join(tmpdir(), 'caogen-model-optimization-build-'))
const dataDir = mkdtempSync(path.join(tmpdir(), 'caogen-model-optimization-data-'))

try {
  mkdirSync(buildDir, { recursive: true })
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/model/model-profile.ts',
      'src/main/model/model-router.ts',
      'src/main/model/monthly-budget.ts',
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
  const monthlyBudget = await import(pathToFileURL(findCompiled(buildDir, 'monthly-budget.js')).href)
  stats.configureModelStatsDir(dataDir)

  const providers = [
    {
      id: 'premium',
      name: 'Premium',
      baseUrl: 'https://premium.example.test',
      models: ['gpt-4o'],
      budgetUsd: 0,
      createdAt: Date.now(),
      hasToken: true
    },
    {
      id: 'budget',
      name: 'Budget',
      baseUrl: 'https://budget.example.test',
      models: ['gpt-4o-mini', 'deepseek-chat'],
      budgetUsd: 0,
      createdAt: Date.now(),
      hasToken: true
    }
  ]

  const task = {
    providers,
    prompt: 'summarize a long engineering log and produce concise action items',
    requestedTasks: ['summarization'],
    contextTokens: 20_000,
    expectedOutputTokens: 5_000
  }
  const qualityBaseline = router.routeModel({ ...task, strategy: 'quality' })
  const costOptimized = router.routeModel({ ...task, strategy: 'cost' })
  assert.equal(qualityBaseline.selected.profile.model, 'gpt-4o', 'quality baseline should pick the premium model')
  assert.notEqual(
    costOptimized.selected.profile.model,
    qualityBaseline.selected.profile.model,
    'cost strategy should select a cheaper executable model'
  )
  const costReduction = 1 - costOptimized.selected.estimatedCostUsd / qualityBaseline.selected.estimatedCostUsd
  assert(
    costReduction >= 0.5,
    `cost strategy should reduce estimated cost by at least 50%, got ${(costReduction * 100).toFixed(1)}%`
  )

  for (let index = 0; index < 20; index += 1) stats.recordModelSuccess('stable-mini', 700)
  for (let index = 0; index < 20; index += 1) stats.recordModelFailure('buggy-mini')

  const reliabilityDecision = router.routeModel({
    providers: [
      {
        id: 'same-tier',
        name: 'Same Tier',
        baseUrl: 'https://same-tier.example.test',
        models: ['buggy-mini', 'stable-mini'],
        budgetUsd: 0,
        createdAt: Date.now(),
        hasToken: true
      }
    ],
    prompt: 'implement a focused TypeScript bug fix and run tests',
    requestedTasks: ['coding'],
    strategy: 'balanced',
    contextTokens: 8_000,
    expectedOutputTokens: 1_000
  })
  const stableFailureRate = failureRate(stats.getModelStat('stable-mini'))
  const buggyFailureRate = failureRate(stats.getModelStat('buggy-mini'))
  assert.equal(
    reliabilityDecision.selected.profile.model,
    'stable-mini',
    'router should avoid the same-tier model with repeated historical failures'
  )
  assert(
    stableFailureRate <= buggyFailureRate - 0.5,
    `selected model failure-rate proxy should be materially lower; stable=${stableFailureRate}, buggy=${buggyFailureRate}`
  )

  const now = new Date('2026-07-07T05:00:00Z').getTime()
  const snapshot = monthlyBudget.calculateMonthlyBudgetSnapshot({
    settings: { budgetUsdPerMonth: 1 },
    now,
    history: [
      {
        id: 'old-month',
        title: 'old',
        cwd: repoRoot,
        model: 'gpt-4o',
        providerId: 'premium',
        permissionMode: 'default',
        sdkSessionId: 'old-month-sdk',
        createdAt: new Date('2026-06-30T12:00:00Z').getTime(),
        updatedAt: new Date('2026-06-30T12:00:00Z').getTime(),
        costUsd: 99
      },
      {
        id: 'this-month',
        title: 'current',
        cwd: repoRoot,
        model: 'gpt-4o',
        providerId: 'premium',
        permissionMode: 'default',
        sdkSessionId: 'this-month-sdk',
        createdAt: now,
        updatedAt: now,
        costUsd: 0.95
      }
    ]
  })
  assert.equal(snapshot.monthKey, '2026-07')
  assert.equal(snapshot.spentUsd, 0.95)
  assert.equal(snapshot.remainingUsd, 0.05)

  const monthlyDowngrade = router.routeModel({
    ...task,
    strategy: 'quality',
    budget: { remainingUsd: snapshot.remainingUsd, hardLimit: true }
  })
  assert.notEqual(monthlyDowngrade.selected.profile.model, 'gpt-4o', 'monthly budget should downgrade away from premium model')

  assertRuntimeMonthlyBudgetWiring()

  console.log(
    `modelOptimization smoke ok: costReduction=${(costReduction * 100).toFixed(1)}%, monthlyRemaining=$${snapshot.remainingUsd.toFixed(2)}, failureRateDelta=${(
      (buggyFailureRate - stableFailureRate) *
      100
    ).toFixed(1)}pp`
  )
} finally {
  rmSync(buildDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
}

function failureRate(stat) {
  assert(stat, 'model stat should exist')
  const total = stat.successes + stat.failures
  assert(total > 0, 'model stat should have samples')
  return stat.failures / total
}

function findCompiled(root, fileName) {
  const found = findCompiledOptional(root, fileName)
  if (!found) throw new Error(`compiled file not found: ${fileName}`)
  return found
}

function findCompiledOptional(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledOptional(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  return null
}

function assertRuntimeMonthlyBudgetWiring() {
  const settings = read('src/main/settings.ts')
  assert(settings.includes('budgetUsdPerMonth: 0'), 'monthly budget must default to unlimited')
  const shared = read('src/shared/types.ts')
  assert(shared.includes('budgetUsdPerMonth: number'), 'AppSettings must type monthly budget')
  const agentSession = read('src/main/agentSession.ts')
  assert(agentSession.includes('resolveClaudeAutoRoute'), 'Claude sessions must use the shared auto-route boundary')
  const claudeAutoRoute = read('src/main/model/claude-auto-route.ts')
  assert(claudeAutoRoute.includes('calculateMonthlyBudgetSnapshot'), 'auto routing must calculate monthly budget')
  assert(claudeAutoRoute.includes('monthlyBudgetRemainingUsd'), 'auto routing must pass monthly remaining budget')
  const sessionManager = read('src/main/sessionManager.ts')
  assert(sessionManager.includes('monthlyBudget.exceeded'), 'send gate must block after monthly budget is exceeded')
  const settingsModal = read('src/renderer/src/components/SettingsModal.tsx')
  assert(settingsModal.includes('budgetUsdPerMonth'), 'Settings UI must expose monthly budget')
}

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}
