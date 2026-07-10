import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const buildDir = mkdtempSync(path.join(tmpdir(), 'caogen-provider-health-build-'))
const dataDir = mkdtempSync(path.join(tmpdir(), 'caogen-provider-health-data-'))
const reportRoot = path.join(repoRoot, 'test-results', 'provider-health-history')
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
      'src/main/providerHealth.ts',
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

  const providerHealth = await import(pathToFileURL(findCompiled(buildDir, 'providerHealth.js')).href)
  providerHealth.configureProviderHealthDir(dataDir)

  check('success samples produce latest and EMA latency', () => {
    providerHealth.recordSuccess('provider-a', 100)
    providerHealth.recordSuccess('provider-a', 300)
    const health = providerHealth.getHealth('provider-a')
    assert(health.lastLatencyMs === 300, `latest latency mismatch: ${health.lastLatencyMs}`)
    assert(health.latencyEmaMs === 160, `latency EMA mismatch: ${health.latencyEmaMs}`)
    assert(health.successes === 2 && health.healthy, 'successes should keep provider healthy')
  })

  check('failure history is classified, redacted, bounded, and marks provider unhealthy', () => {
    const secret = ['sk', 'super-secret-value', '123456789'].join('-')
    for (let index = 0; index < 14; index += 1) {
      providerHealth.recordFailure('provider-a', `HTTP 401 invalid api key: ${secret} attempt=${index}`)
    }
    const health = providerHealth.getHealth('provider-a')
    assert(!health.healthy, 'three consecutive failures should mark provider unhealthy')
    assert(health.recentFailures.length === 12, `history should be bounded to 12, got ${health.recentFailures.length}`)
    assert(health.recentFailures[0].label === '鉴权失败', 'latest failure should be classified')
    assert(!JSON.stringify(health).includes(secret), 'failure history must redact API keys')
    assert(health.lastFailureAt === health.recentFailures[0].at, 'last failure timestamp should match latest history record')
  })

  check('successful recovery clears active error but preserves history', () => {
    providerHealth.recordSuccess('provider-a', 220)
    const health = providerHealth.getHealth('provider-a')
    assert(health.healthy, 'success should restore provider health')
    assert(health.consecutiveFailures === 0, 'success should reset consecutive failures')
    assert(health.lastError === undefined, 'success should clear active lastError')
    assert(health.recentFailures.length === 12, 'success should preserve bounded failure history')
  })

  check('health state survives cache reset and reload', () => {
    providerHealth._resetProviderHealthCacheForTest()
    const reloaded = providerHealth.getHealth('provider-a')
    assert(reloaded.successes === 3, `persisted success count mismatch: ${reloaded.successes}`)
    assert(reloaded.failures === 14, `persisted failure count mismatch: ${reloaded.failures}`)
    assert(reloaded.recentFailures.length === 12, 'persisted failure history should reload')
    const raw = readFileSync(path.join(dataDir, 'provider-health.json'), 'utf8')
    assert(!raw.includes('sk-super-secret'), 'persisted health file must not contain the raw API key')
  })

  check('failure classification distinguishes switchable and local execution errors', () => {
    assert(providerHealth.classifyFailure('HTTP 429 rate limit').switchable, 'rate limits should be switchable')
    assert(!providerHealth.classifyFailure('max_turns reached').switchable, 'local execution limits should not switch providers')
    assert(providerHealth.classifyFailure(undefined).label === '未知错误', 'missing error text should stay explicitly unknown')
  })

  check('Control Center exposes persisted health history', () => {
    const viewSource = readFileSync(path.join(repoRoot, 'src/renderer/src/controlCenter.ts'), 'utf8')
    const componentSource = readFileSync(path.join(repoRoot, 'src/renderer/src/components/ControlCenter.tsx'), 'utf8')
    assert(viewSource.includes('successRateLabel'), 'Control Center view should expose provider success rate')
    assert(viewSource.includes('latencyLabel'), 'Control Center view should expose provider latency EMA')
    assert(viewSource.includes('recentFailures'), 'Control Center view should preserve recent failures')
    assert(componentSource.includes('control-provider-failures'), 'Control Center should render expandable failure history')
    assert(componentSource.includes('failure.switchable'), 'failure history should explain whether failover can help')
  })

  finalStatus = 'passed'
  console.log(`provider health history smoke ok: ${reportDir}`)
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
  writeFileSync(path.join(reportDir, 'provider-health-history-smoke.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`)
  rmSync(buildDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
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
