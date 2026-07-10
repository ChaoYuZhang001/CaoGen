#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-key-failover-'))
const buildDir = path.join(tempRoot, 'compiled')
const reportRoot = path.join(repoRoot, 'test-results', 'provider-key-failover')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const runDir = path.join(reportRoot, runId)
const checks = []
let finalStatus = 'fail'
let finalError = null

try {
  mkdirSync(runDir, { recursive: true })
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/providerHealth.ts',
      'src/main/providerKeyRouting.ts',
      '--outDir',
      buildDir,
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--types',
      'node',
      '--skipLibCheck'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )

  const routing = await import(pathToFileURL(findCompiled(buildDir, 'providerKeyRouting.js')).href)
  const health = await import(pathToFileURL(findCompiled(buildDir, 'providerHealth.js')).href)
  const now = 1_800_000_000_000
  const keys = [
    key('primary', 'Primary'),
    key('disabled', 'Disabled', { disabled: true }),
    key('cooling', 'Cooling', { lastFailureAt: now - 10_000 }),
    key('backup', 'Backup')
  ]

  check('only credential-bound failures rotate keys', () => {
    for (const message of ['HTTP 401 invalid API key', 'HTTP 403 forbidden', 'HTTP 429 rate limit', 'insufficient quota']) {
      assert(routing.canRotateProviderKey(health.classifyFailure(message)), `should rotate for ${message}`)
    }
    for (const message of ['HTTP 503 service unavailable', 'fetch failed', 'model not found', 'max_turns reached']) {
      assert(!routing.canRotateProviderKey(health.classifyFailure(message)), `must not rotate for ${message}`)
    }
  })

  check('rotation skips disabled and cooling keys', () => {
    const selected = routing.pickNextProviderKey(keys, {
      activeKeyId: 'primary',
      failedKeyId: 'primary',
      now
    })
    assert(selected?.id === 'backup', `expected backup key, got ${selected?.id}`)
  })

  check('turn-local exclusions prevent key loops', () => {
    const selected = routing.pickNextProviderKey(keys, {
      activeKeyId: 'primary',
      failedKeyId: 'primary',
      excludedKeyIds: new Set(['backup']),
      now
    })
    assert(selected === undefined, `excluded backup must not be retried: ${selected?.id}`)
  })

  check('cooled-down keys become eligible again', () => {
    const selected = routing.pickNextProviderKey(keys, {
      activeKeyId: 'primary',
      failedKeyId: 'primary',
      excludedKeyIds: new Set(['backup']),
      now: now + routing.PROVIDER_KEY_FAILURE_COOLDOWN_MS + 1
    })
    assert(selected?.id === 'cooling', `cooled key should recover: ${selected?.id}`)
  })

  check('main engines switch keys before provider failover and expose labels only', () => {
    const providers = read('src/main/providers.ts')
    const openai = read('src/main/openaiEngine.ts')
    const sdk = read('src/main/agentSession.ts')
    const types = read('src/shared/types.ts')
    const store = read('src/renderer/src/store.ts')
    const message = read('src/renderer/src/components/MessageItem.tsx')
    const office = read('src/renderer/src/components/office/model.ts')

    assert(providers.includes('export function rotateProviderKey'), 'provider storage must persist key rotation')
    assert(providers.includes('recordProviderKeySuccess'), 'successful keys must clear failure metadata')
    assert(openai.indexOf('tryProviderKeyFailover(text') < openai.indexOf('recordFailure(this.meta.providerId, text)'), 'OpenAI must rotate a key before marking the Provider failed')
    assert(sdk.includes('providerTokenFingerprint(selection.token)'), 'SDK credential changes must rebuild even when key presence stays true')
    assert(sdk.includes('await this.tryProviderKeyFailover(errorText)'), 'SDK result failures must try another key')
    assert(types.includes("kind: 'provider-key-failover'"), 'shared event contract must include key failover')
    assert(!types.match(/provider-key-failover[\s\S]{0,500}(token|encryptedToken):/), 'key failover event must not expose secret fields')
    assert(store.includes("case 'provider-key-failover'"), 'renderer store must preserve key failover')
    assert(message.includes("case 'provider-key-failover'"), 'chat must render key failover')
    assert(office.includes('latestProviderKeyFailoverSignal'), '3D office must consume key failover state')
  })

  finalStatus = 'pass'
} catch (error) {
  finalError = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  const report = {
    runId,
    status: finalStatus,
    checks,
    error: finalError,
    generatedAt: new Date().toISOString()
  }
  mkdirSync(runDir, { recursive: true })
  writeFileSync(path.join(runDir, 'provider-key-failover-smoke.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`)
  rmSync(tempRoot, { recursive: true, force: true })
}

if (finalStatus === 'pass') console.log(`provider key failover smoke ok: ${runDir}`)
else console.error(`provider key failover smoke failed: ${finalError}`)

function key(id, label, patch = {}) {
  return {
    id,
    label,
    encryptedToken: `b64:${id}`,
    createdAt: 1,
    disabled: false,
    ...patch
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
  if (path.basename(root) === path.basename(buildDir)) throw new Error(`compiled file not found: ${fileName}`)
  return null
}

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
