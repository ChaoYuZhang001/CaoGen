import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const buildDir = mkdtempSync(path.join(tmpdir(), 'caogen-budget-report-build-'))
const reportRoot = path.join(repoRoot, 'test-results', 'budget-report')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(reportRoot, runId)
const checks = []
let finalStatus = 'failed'
let finalError = null

try {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/shared/budget.ts',
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

  const budget = await import(pathToFileURL(findCompiled(buildDir, 'budget.js')).href)
  const now = Date.UTC(2026, 6, 10, 12)
  const providers = [
    {
      id: 'provider-a',
      name: 'Provider A',
      baseUrl: 'https://provider-a.example/v1',
      models: ['model-a'],
      budgetUsd: 4,
      createdAt: now,
      hasToken: true
    },
    {
      id: 'provider-b',
      name: 'Provider B',
      baseUrl: 'https://provider-b.example/v1',
      models: ['model-b'],
      budgetUsd: 0,
      createdAt: now,
      hasToken: true
    }
  ]
  const activeSessions = [
    activeSession({
      id: 'active-explicit',
      sdkSessionId: 'sdk-shared',
      title: 'Explicit cap',
      providerId: 'provider-a',
      model: 'model-a',
      costUsd: 3,
      budgetUsd: 1.5,
      createdAt: now - 3_000
    }),
    activeSession({
      id: 'active-provider',
      sdkSessionId: 'sdk-provider',
      title: 'Provider cap',
      providerId: 'provider-a',
      model: 'model-a',
      costUsd: 1,
      createdAt: now - 2_000
    }),
    activeSession({
      id: 'active-global',
      sdkSessionId: 'sdk-global',
      title: 'Global cap',
      providerId: 'provider-b',
      model: 'model-b',
      costUsd: 0.5,
      createdAt: now - 1_000
    })
  ]
  const history = [
    historySession({
      id: 'active-explicit',
      sdkSessionId: 'archived-id-duplicate',
      title: 'Duplicate by id',
      providerId: 'provider-a',
      model: 'model-a',
      costUsd: 9,
      createdAt: Date.UTC(2026, 6, 5),
      updatedAt: Date.UTC(2026, 6, 8)
    }),
    historySession({
      id: 'history-sdk-duplicate',
      sdkSessionId: 'sdk-shared',
      title: 'Duplicate by sdk id',
      providerId: 'provider-a',
      model: 'model-a',
      costUsd: 8,
      createdAt: Date.UTC(2026, 6, 5),
      updatedAt: Date.UTC(2026, 6, 8)
    }),
    historySession({
      id: 'history-a',
      sdkSessionId: 'sdk-history-a',
      title: 'Historical A',
      providerId: 'provider-a',
      model: 'model-a',
      costUsd: 2,
      createdAt: Date.UTC(2026, 6, 4),
      updatedAt: Date.UTC(2026, 6, 7)
    }),
    historySession({
      id: 'history-b',
      sdkSessionId: 'sdk-history-b',
      title: 'Historical B',
      providerId: 'provider-b',
      model: 'model-b',
      costUsd: 4,
      createdAt: Date.UTC(2026, 6, 3),
      updatedAt: Date.UTC(2026, 6, 6)
    }),
    historySession({
      id: 'history-old',
      sdkSessionId: 'sdk-history-old',
      title: 'Previous month',
      providerId: 'provider-b',
      model: 'model-b',
      costUsd: 100,
      createdAt: Date.UTC(2026, 4, 14),
      updatedAt: Date.UTC(2026, 4, 15)
    })
  ]
  const report = budget.calculateBudgetReport({
    settings: { budgetUsdPerSession: 2, budgetUsdPerMonth: 10 },
    providers,
    history,
    activeSessions,
    now
  })

  check('active and historical sessions are deduplicated by id and sdk session id', () => {
    assert(report.activeSessions.length === 3, `active session count mismatch: ${report.activeSessions.length}`)
    assert(report.historicalCostUsd === 6, `historical cost should exclude duplicate and old entries: ${report.historicalCostUsd}`)
    assert(!report.topSessions.some((session) => session.title.startsWith('Duplicate')), 'duplicate history must not enter top sessions')
  })

  check('monthly totals expose spent, remaining, ratio, and exceeded state', () => {
    assert(report.monthKey === '2026-07', `month key mismatch: ${report.monthKey}`)
    assert(report.activeCostUsd === 4.5, `active cost mismatch: ${report.activeCostUsd}`)
    assert(report.monthlySpentUsd === 10.5, `monthly spent mismatch: ${report.monthlySpentUsd}`)
    assert(report.monthlyRemainingUsd === 0, `monthly remaining mismatch: ${report.monthlyRemainingUsd}`)
    assert(report.monthlyRatio === 1, `monthly ratio should be capped at 1: ${report.monthlyRatio}`)
    assert(report.monthlyExceeded, 'monthly budget should be exceeded')
  })

  check('provider aggregation combines current and historical cost', () => {
    const providerA = report.providers.find((provider) => provider.providerId === 'provider-a')
    const providerB = report.providers.find((provider) => provider.providerId === 'provider-b')
    assert(providerA?.spentUsd === 6, `provider A cost mismatch: ${providerA?.spentUsd}`)
    assert(providerA?.sessionCount === 3 && providerA.activeSessions === 2, 'provider A session aggregation mismatch')
    assert(providerA.currentSessionLimitUsd === 4, 'provider budget must be labeled as a current per-session limit')
    assert(providerB?.spentUsd === 4.5, `provider B cost mismatch: ${providerB?.spentUsd}`)
  })

  check('active session limits use explicit, provider, then global priority', () => {
    const explicit = report.activeSessions.find((session) => session.id === 'active-explicit')
    const provider = report.activeSessions.find((session) => session.id === 'active-provider')
    const global = report.activeSessions.find((session) => session.id === 'active-global')
    assert(explicit?.sessionLimitUsd === 1.5 && explicit.overBudget, 'explicit session budget should win and flag over-budget')
    assert(provider?.sessionLimitUsd === 4 && !provider.overBudget, 'provider per-session budget should be the second fallback')
    assert(global?.sessionLimitUsd === 2 && !global.overBudget, 'global per-session budget should be the final fallback')
  })

  check('top sessions are sorted by cost without inventing historical budget ratios', () => {
    assert(report.topSessions.map((session) => session.costUsd).join(',') === '4,3,2,1,0.5', 'top sessions should sort by descending cost')
    const historical = report.topSessions.find((session) => session.id === 'history-b')
    assert(historical?.sessionLimitUsd === undefined && historical.ratio === undefined, 'historical sessions must not invent a budget limit')
  })

  check('Control Center renders report data and Settings passes both data sources', () => {
    const viewSource = readFileSync(path.join(repoRoot, 'src/renderer/src/controlCenter.ts'), 'utf8')
    const componentSource = readFileSync(path.join(repoRoot, 'src/renderer/src/components/ControlCenter.tsx'), 'utf8')
    const settingsSource = readFileSync(path.join(repoRoot, 'src/renderer/src/components/SettingsModal.tsx'), 'utf8')
    const stylesSource = readFileSync(path.join(repoRoot, 'src/renderer/src/styles.css'), 'utf8')
    assert(viewSource.includes('calculateBudgetReport'), 'Control Center view should use the shared budget report')
    assert(componentSource.includes('view.budget.report.providers.map'), 'Control Center should render provider budget rows')
    assert(componentSource.includes('view.budget.report.topSessions.map'), 'Control Center should render top session rows')
    assert(settingsSource.includes('history={history}'), 'Settings should pass persisted history to Control Center')
    assert(settingsSource.includes('activeSessions={activeSessions}'), 'Settings should pass active sessions to Control Center')
    assert(stylesSource.includes('.control-budget-progress'), 'budget progress styling should exist')
  })

  finalStatus = 'passed'
  console.log(`budget report smoke ok: ${reportDir}`)
} catch (error) {
  finalError = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  mkdirSync(reportDir, { recursive: true })
  const report = {
    runId,
    status: finalStatus,
    checks,
    error: finalError,
    generatedAt: new Date().toISOString()
  }
  writeFileSync(path.join(reportDir, 'budget-report-smoke.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`)
  rmSync(buildDir, { recursive: true, force: true })
}

function activeSession(input) {
  return {
    cwd: '/tmp/project',
    permissionMode: 'default',
    status: 'idle',
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    ...input
  }
}

function historySession(input) {
  return {
    cwd: '/tmp/project',
    engine: 'openai',
    permissionMode: 'default',
    ...input
  }
}

function check(name, fn) {
  const startedAt = Date.now()
  try {
    fn()
    checks.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
  } catch (error) {
    checks.push({
      name,
      status: 'fail',
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
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
  return null
}
