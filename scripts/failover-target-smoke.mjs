import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const buildDir = mkdtempSync(path.join(tmpdir(), 'caogen-failover-target-build-'))
const outDir = path.join(repoRoot, 'test-results', 'failover-target')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const runDir = path.join(outDir, runId)
const checks = []
let finalStatus = 'fail'
let finalError = null

mkdirSync(runDir, { recursive: true })

try {
  mkdirSync(buildDir, { recursive: true })
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/scheduler.ts',
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

  const scheduler = await import(pathToFileURL(findCompiled(buildDir, 'scheduler.js')).href)

  check('fallback provider and model preferences win after primary failure', () => {
    const preferred = scheduler.pickFailoverTarget({
      candidates: [
        { id: 'primary', name: 'Primary', models: ['primary-strong'] },
        { id: 'backup', name: 'Backup', models: ['backup-fast', 'backup-strong'] }
      ],
      exclude: new Set(['primary']),
      desiredModel: 'primary-strong',
      fallbackProviderId: 'backup',
      fallbackModel: 'backup-fast'
    })
    assert(preferred?.providerId === 'backup', 'fallback provider preference should win after primary failure')
    assert(preferred?.model === 'backup-fast', 'fallback model preference should win after primary failure')
    assert(preferred?.preference === '备用模型偏好', 'fallback target should expose preference reason')
  })

  check('unhealthy configured fallback is skipped for a healthy provider', () => {
    for (let i = 0; i < 3; i += 1) scheduler.recordFailure('offline-backup', 'quota')
    const unhealthySkipped = scheduler.pickFailoverTarget({
      candidates: [
        { id: 'primary-b', name: 'Primary B', models: ['primary-b-strong'] },
        { id: 'offline-backup', name: 'Offline Backup', models: ['offline-fast'] },
        { id: 'healthy-backup', name: 'Healthy Backup', models: ['healthy-fast'] }
      ],
      exclude: new Set(['primary-b']),
      desiredModel: 'primary-b-strong',
      fallbackProviderId: 'offline-backup',
      fallbackModel: 'offline-fast'
    })
    assert(unhealthySkipped?.providerId === 'healthy-backup', 'unhealthy fallback provider should be skipped')
  })

  check('fallback model alone finds a provider that advertises it', () => {
    const modelOnly = scheduler.pickFailoverTarget({
      candidates: [
        { id: 'primary-c', name: 'Primary C', models: ['primary-c-strong'] },
        { id: 'general-a', name: 'General A', models: ['general-fast'] },
        { id: 'general-b', name: 'General B', models: ['preferred-lite'] }
      ],
      exclude: new Set(['primary-c']),
      desiredModel: 'primary-c-strong',
      fallbackModel: 'preferred-lite'
    })
    assert(modelOnly?.providerId === 'general-b', 'fallback model should find a provider that lists it')
    assert(modelOnly?.model === 'preferred-lite', 'fallback model-only preference should set the target model')
  })

  check('OpenAI failover updates fixed model and exposes the preference reason', () => {
    const openaiEngine = readFileSync(path.join(repoRoot, 'src/main/openaiEngine.ts'), 'utf8')
    assert(
      openaiEngine.includes('else this.meta.model = target.model'),
      'OpenAI failover must update fixed meta.model when a target model is selected'
    )
    assert(
      openaiEngine.includes("reason: [failure.label, target.preference].filter(Boolean).join(' · ')"),
      'OpenAI failover event must include the user-visible preference reason'
    )
  })

  check('SDK AgentSession failover updates fixed model and exposes the preference reason', () => {
    const agentSession = readFileSync(path.join(repoRoot, 'src/main/agentSession.ts'), 'utf8')
    assert(
      agentSession.includes('if (this.meta.model !== AUTO_MODEL && target.model) this.meta.model = target.model'),
      'AgentSession failover must update fixed meta.model when a target model is selected'
    )
    assert(
      agentSession.includes("reason: [failure.label, target.preference].filter(Boolean).join(' · ')"),
      'AgentSession failover event must include the user-visible preference reason'
    )
  })

  check('renderer shows a readable failover note', () => {
    const messageItem = readFileSync(path.join(repoRoot, 'src/renderer/src/components/MessageItem.tsx'), 'utf8')
    const i18n = readFileSync(path.join(repoRoot, 'src/renderer/src/i18n.ts'), 'utf8')
    assert(messageItem.includes("case 'failover'"), 'MessageItem must render failover events')
    assert(messageItem.includes("t('failoverText'"), 'failover note must use localized copy')
    assert(i18n.includes('已切换 → {to},自动重试中'), 'Chinese failover copy must explain the retry target')
  })

  finalStatus = 'pass'
} catch (error) {
  finalError = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  rmSync(buildDir, { recursive: true, force: true })
  const report = {
    runId,
    status: finalStatus,
    checks,
    error: finalError,
    generatedAt: new Date().toISOString()
  }
  writeFileSync(path.join(runDir, 'failover-target-smoke.json'), JSON.stringify(report, null, 2))
  writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(report, null, 2))
}

if (finalStatus === 'pass') {
  console.log(`failover-target smoke ok: ${runDir}`)
} else {
  console.error(`failover-target smoke failed: ${finalError}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
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
