#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const buildDir = mkdtempSync(path.join(tmpdir(), 'caogen-provider-circuit-build-'))
const dataDir = mkdtempSync(path.join(tmpdir(), 'caogen-provider-circuit-data-'))
const reportRoot = path.join(repoRoot, 'test-results', 'provider-circuit-breaker')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(reportRoot, runId)
const checks = []
let finalStatus = 'failed'
let finalError = null

try {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/providerHealth.ts',
    'src/main/scheduler.ts',
    'src/main/modelStats.ts',
    '--outDir', buildDir,
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--esModuleInterop',
    '--strict',
    '--skipLibCheck'
  ], { cwd: repoRoot, stdio: 'inherit' })

  const health = await import(pathToFileURL(findCompiled(buildDir, 'providerHealth.js')).href)
  const scheduler = await import(pathToFileURL(findCompiled(buildDir, 'scheduler.js')).href)
  const standard = {
    failureThreshold: 3,
    successThreshold: 2,
    timeoutSeconds: 60,
    errorRateThreshold: 0.6,
    minRequests: 5
  }
  health.configureProviderHealthDir(dataDir, standard)

  check('closed circuit opens only at the configured consecutive-failure threshold', () => {
    assert(health.acquireProviderRequest('threshold-provider'), 'closed circuit should allow requests')
    health.recordFailure('threshold-provider', 'HTTP 503 service unavailable')
    health.recordFailure('threshold-provider', 'HTTP 503 service unavailable')
    assert(health.getHealth('threshold-provider').circuitState === 'closed', 'circuit opened before threshold')
    health.recordFailure('threshold-provider', 'HTTP 503 service unavailable')
    const opened = health.getHealth('threshold-provider')
    assert(opened.circuitState === 'open' && !opened.healthy, 'threshold should open the circuit')
    assert(!health.acquireProviderRequest('threshold-provider'), 'open circuit must reject a real request')
  })

  check('open providers are excluded from failover routing', () => {
    const selected = scheduler.pickFailoverTarget({
      candidates: [
        { id: 'threshold-provider', name: 'Open', models: ['model-fast'] },
        { id: 'healthy-provider', name: 'Healthy', models: ['model-fast'] }
      ],
      exclude: new Set(),
      desiredModel: 'model-fast',
      fallbackProviderId: 'threshold-provider'
    })
    assert(selected?.providerId === 'healthy-provider', 'routing must skip the configured but open fallback')
  })

  check('cooldown enters half-open and permits only one concurrent probe', () => {
    const opened = health.getHealth('threshold-provider')
    assert(opened.circuitOpenedAt, 'open timestamp is required for cooldown recovery')
    const recoveryAt = opened.circuitOpenedAt + standard.timeoutSeconds * 1000
    assert(health.isProviderAvailable('threshold-provider', recoveryAt), 'provider should become probe-eligible')
    assert(health.getHealth('threshold-provider').circuitState === 'half_open', 'cooldown should enter half-open')
    assert(health.acquireProviderRequest('threshold-provider', recoveryAt), 'first half-open probe should be admitted')
    assert(!health.acquireProviderRequest('threshold-provider', recoveryAt), 'second concurrent probe must be rejected')
  })

  check('a failed half-open probe reopens the circuit immediately', () => {
    health.recordFailure('threshold-provider', 'network fetch failed')
    const reopened = health.getHealth('threshold-provider')
    assert(reopened.circuitState === 'open', 'failed half-open probe must reopen the circuit')
    assert(!health.acquireProviderRequest('threshold-provider'), 'reopened circuit must reject requests')
  })

  check('configured half-open successes close and reset the circuit', () => {
    const reopened = health.getHealth('threshold-provider')
    const recoveryAt = reopened.circuitOpenedAt + standard.timeoutSeconds * 1000
    assert(health.acquireProviderRequest('threshold-provider', recoveryAt), 'first recovery probe should start')
    health.recordSuccess('threshold-provider', 100)
    assert(health.getHealth('threshold-provider').circuitState === 'half_open', 'one success is below threshold')
    assert(health.acquireProviderRequest('threshold-provider', recoveryAt + 1), 'second recovery probe should start')
    health.recordSuccess('threshold-provider', 80)
    const closed = health.getHealth('threshold-provider')
    assert(closed.circuitState === 'closed' && closed.healthy, 'success threshold should close the circuit')
    assert(closed.circuitTotalRequests === 0 && closed.circuitFailedRequests === 0, 'closed transition resets window')
  })

  check('local non-switchable failures never poison Provider availability', () => {
    for (let index = 0; index < 8; index += 1) health.recordFailure('local-error-provider', 'max_turns reached')
    const state = health.getHealth('local-error-provider')
    assert(state.circuitState === 'closed' && state.healthy, 'local execution errors must not open Provider circuit')
    assert(state.circuitFailedRequests === 0, 'local errors must not enter upstream failure numerator')
  })

  check('error-rate policy opens independently of the consecutive threshold', () => {
    health.configureProviderCircuitBreaker({ ...standard, failureThreshold: 20 })
    health.recordSuccess('ratio-provider')
    health.recordSuccess('ratio-provider')
    health.recordFailure('ratio-provider', 'HTTP 503 service unavailable')
    health.recordFailure('ratio-provider', 'HTTP 503 service unavailable')
    assert(health.getHealth('ratio-provider').circuitState === 'closed', 'minimum sample should defer rate opening')
    health.recordFailure('ratio-provider', 'HTTP 503 service unavailable')
    const ratio = health.getHealth('ratio-provider')
    assert(ratio.circuitState === 'open', '60 percent failure ratio at minRequests should open circuit')
  })

  check('Provider-specific circuit policies coexist and override only their Provider', () => {
    health.configureProviderCircuitBreaker({ ...standard, failureThreshold: 9, timeoutSeconds: 120 })
    health.synchronizeProviderReliabilityPolicies([
      {
        id: 'strict-provider',
        advancedConfig: {
          schemaVersion: 1,
          reliability: {
            circuitBreaker: { ...standard, failureThreshold: 1, timeoutSeconds: 0 }
          }
        }
      },
      {
        id: 'patient-provider',
        advancedConfig: {
          schemaVersion: 1,
          reliability: {
            circuitBreaker: { ...standard, failureThreshold: 4, timeoutSeconds: 90 }
          }
        }
      }
    ])
    health.recordFailure('strict-provider', 'HTTP 503 service unavailable')
    health.recordFailure('patient-provider', 'HTTP 503 service unavailable')
    assert(health.getHealth('strict-provider').circuitState === 'half_open',
      'strict Provider should open and immediately reach its zero-cooldown half-open state')
    assert(health.getHealth('patient-provider').circuitState === 'closed',
      'patient Provider must keep its independent threshold')
    health.recordFailure('unconfigured-provider', 'HTTP 503 service unavailable')
    assert(health.getHealth('unconfigured-provider').circuitState === 'closed',
      'unconfigured Provider must continue inheriting the global policy')
  })

  check('health-list refresh advances every expired open circuit', () => {
    health.configureProviderCircuitBreaker({
      ...standard,
      failureThreshold: 1,
      timeoutSeconds: 0
    })
    health.recordFailure('batch-provider-a', 'HTTP 503 service unavailable')
    health.recordFailure('batch-provider-b', 'HTTP 503 service unavailable')
    const refreshed = health.listHealth().filter((item) => item.providerId.startsWith('batch-provider-'))
    assert(refreshed.length === 2, 'both batch providers should be present')
    assert(refreshed.every((item) => item.circuitState === 'half_open'),
      'listHealth must not short-circuit after the first cooldown transition')
  })

  check('circuit state persists without leaking upstream error details', () => {
    health.configureProviderCircuitBreaker({
      ...standard,
      failureThreshold: 1,
      timeoutSeconds: 60
    })
    health.recordFailure('persisted-open-provider', 'HTTP 503 service unavailable')
    health._resetProviderHealthCacheForTest()
    health.configureProviderCircuitBreaker({ ...standard, failureThreshold: 1, timeoutSeconds: 60 })
    const restored = health.getHealth('persisted-open-provider')
    assert(restored.circuitState === 'open' && restored.circuitOpenedAt, 'open circuit should survive cache reload')
    const raw = readFileSync(path.join(dataDir, 'provider-health.json'), 'utf8')
    assert(raw.includes('"circuitState": "open"'), 'persisted file should carry explicit circuit state')
    assert(!raw.includes('secret-provider.example'), 'persisted circuit evidence must not expose Provider URLs')
  })

  check('both engines and settings are wired to the circuit contract', () => {
    const openai = readFileSync(path.join(repoRoot, 'src/main/openaiEngine.ts'), 'utf8')
    const anthropic = readFileSync(path.join(repoRoot, 'src/main/anthropicEngine.ts'), 'utf8')
    const ipc = readFileSync(path.join(repoRoot, 'src/main/ipc.ts'), 'utf8')
    const settingsUi = readFileSync(path.join(repoRoot, 'src/renderer/src/components/SettingsModal.tsx'), 'utf8')
    assert(openai.includes('acquireProviderRequest(this.meta.providerId)'), 'OpenAI must acquire before upstream work')
    assert(openai.includes('releaseProviderRequest(this.meta.providerId)'), 'OpenAI must release abandoned probes')
    assert(anthropic.includes('this.dependencies.acquireProviderRequest(activeTarget.providerId)'),
      'Anthropic must acquire before upstream work')
    assert(anthropic.includes('this.dependencies.releaseProviderRequest(activeTarget.providerId)'),
      'Anthropic must release probes when no ModelAttempt result exists')
    assert(ipc.includes('configureProviderCircuitBreaker(next.providerCircuitBreaker)'),
      'saved settings must hot-update the main-process circuit policy')
    for (const field of ['failureThreshold', 'successThreshold', 'timeoutSeconds', 'errorRateThreshold', 'minRequests']) {
      assert(settingsUi.includes(`providerCircuitBreaker.${field}`), `settings UI is missing ${field}`)
    }
  })

  finalStatus = 'passed'
  console.log(`provider circuit breaker smoke ok: ${checks.length}/${checks.length}`)
} catch (error) {
  finalError = error instanceof Error ? error.message : String(error)
  console.error(`provider circuit breaker smoke failed: ${finalError}`)
  process.exitCode = 1
} finally {
  mkdirSync(reportDir, { recursive: true })
  const report = { runId, status: finalStatus, checks, error: finalError, generatedAt: new Date().toISOString() }
  writeFileSync(path.join(reportDir, 'provider-circuit-breaker-smoke.json'), `${JSON.stringify(report, null, 2)}\n`)
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
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiled(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  return null
}
