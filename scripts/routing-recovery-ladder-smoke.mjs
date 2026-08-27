#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { bindSourceEvidence, readSourceEvidenceState } from './lib/source-evidence-binding.mjs'

const repoRoot = process.cwd()
const sourceEvidenceAtStart = readSourceEvidenceState(repoRoot)
const buildDir = mkdtempSync(path.join(tmpdir(), 'caogen-routing-recovery-ladder-'))
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'routing-recovery-ladder', runId)
const checks = []
let status = 'failed'
let failure = null

mkdirSync(reportDir, { recursive: true })

try {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/provider/providerRuntimeTarget.ts',
    'src/main/providerHealth.ts',
    'src/main/scheduler.ts',
    '--outDir', buildDir,
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--esModuleInterop',
    '--strict',
    '--skipLibCheck'
  ], { cwd: repoRoot, stdio: 'inherit' })

  const runtimeTarget = await import(pathToFileURL(findCompiled(buildDir, 'providerRuntimeTarget.js')).href)
  const health = await import(pathToFileURL(findCompiled(buildDir, 'providerHealth.js')).href)
  const scheduler = await import(pathToFileURL(findCompiled(buildDir, 'scheduler.js')).href)

  check('runtime protocol resolution honors explicit configuration and safe defaults', () => {
    assert.equal(runtimeTarget.resolveOpenAIProtocol({ baseUrl: 'https://gateway.example/v1', protocol: 'responses' }), 'responses')
    assert.equal(runtimeTarget.resolveOpenAIProtocol({ baseUrl: 'https://gateway.example/v1', protocol: 'chat' }), 'chat')
    assert.equal(runtimeTarget.resolveOpenAIProtocol({ baseUrl: 'https://api.openai.com/v1' }), 'responses')
    assert.equal(runtimeTarget.resolveOpenAIProtocol({ baseUrl: 'https://gateway.example/v1' }), 'chat')
    assert.equal(runtimeTarget.resolveOpenAIProtocol({ baseUrl: 'not a url' }), 'chat')
  })

  check('protocol errors are narrow and never absorb model, auth, or server failures', () => {
    assert.equal(
      health.classifyFailure('HTTP 404 model not found; protocol: responses').kind,
      'model_unavailable'
    )
    assert.equal(health.classifyFailure('HTTP 401 invalid API key; protocol: responses').kind, 'auth')
    assert.equal(health.classifyFailure('HTTP 503 service unavailable; protocol: responses').kind, 'server')
    assert.equal(health.classifyFailure('HTTP 404 not found; protocol: responses').kind, 'protocol_unavailable')
    assert.equal(health.classifyFailure('Responses API is not supported by this endpoint').kind, 'protocol_unavailable')
  })

  check('protocol failures bypass same-provider model rotation', () => {
    const selected = scheduler.pickProviderModelFailoverTarget({
      providerId: 'fixture-provider',
      models: ['primary', 'backup'],
      desiredModel: 'primary',
      exclude: new Set(['primary']),
      failure: health.classifyFailure('HTTP 404 not found; protocol: responses')
    })
    assert.equal(selected, null)
  })

  const engine = source('src/main/openaiEngine.ts')
  const recovery = source('src/main/provider/openAiProviderModelRecovery.ts')
  const shared = source('src/shared/types.ts')
  const guard = source('src/main/native-runtime-guard.ts')
  const transcript = source('src/main/transcript.ts')
  const snapshot = source('src/main/task/task-snapshot-validation.ts')
  const reducer = source('src/renderer/src/store/provider-failover.ts')
  const message = source('src/renderer/src/components/experience/RoutingMessage.tsx')
  const settingsNavigation = source('src/renderer/src/store/settings-navigation.ts')
  const anthropic = source('src/main/anthropicEngine.ts')
  const anthropicDependencies = source('src/main/anthropic-engine-dependencies.ts')

  check('OpenAI recovery order is credential, model, same-protocol Provider, protocol, manual takeover', () => {
    const key = engine.indexOf('tryProviderKeyFailover(text')
    const model = engine.indexOf('tryProviderModelFailover(text')
    const provider = engine.indexOf('tryFailover(text')
    const protocol = engine.indexOf('tryProtocolFailover(text')
    const manual = engine.indexOf('emitRecoveryExhausted(text)')
    assert(key >= 0 && key < model && model < provider && provider < protocol && protocol < manual)
  })

  check('cross-provider candidates resolve and filter the effective protocol', () => {
    assert.match(recovery, /currentProtocol:\s*OpenAIProtocol/)
    assert.match(recovery, /resolveOpenAIProtocol\(target\)\s*!==\s*input\.currentProtocol/)
    assert.match(engine, /currentProtocol:\s*this\.protocol\(\)/)
  })

  check('Responses to Chat fallback is session scoped and does not mutate Provider storage', () => {
    assert.match(engine, /private protocolOverride\?:/)
    assert.match(engine, /this\.protocolOverride\s*=\s*\{ providerId, from: recovery\.fromProtocol, to: recovery\.toProtocol \}/)
    const protocolMethod = between(engine, 'private async tryProtocolFailover(', 'private emitRecoveryExhausted(')
    assert.doesNotMatch(protocolMethod, /updateProvider|saveProvider|writeFile|providers\.json/)
    assert.match(recovery, /currentProtocol !== 'responses'/)
    assert.match(recovery, /failure\.kind !== 'protocol_unavailable'/)
  })

  check('both native engines expose recovery exhaustion without secret-bearing fields', () => {
    assert.match(engine, /kind:\s*'provider-recovery-exhausted'[\s\S]*engine:\s*'openai'/)
    assert.match(anthropic, /kind:\s*'provider-recovery-exhausted'[\s\S]*engine:\s*this\.dependencies\.recoveryEngineKind/)
    assert.match(anthropicDependencies, /recoveryEngineKind:\s*'anthropic'/)
    const eventContract = between(shared, "kind: 'provider-recovery-exhausted'", "| { kind: 'text-delta'")
    assert.doesNotMatch(eventContract, /baseUrl|apiKey|token|credential|endpoint/i)
  })

  check('new recovery events are durable and rendered with an explicit takeover action', () => {
    for (const kind of ['provider-protocol-failover', 'provider-recovery-exhausted']) {
      assert(guard.includes(`'${kind}': 'context'`), `${kind} missing from native runtime guard`)
      assert(transcript.includes(`'${kind}'`), `${kind} missing from durable conversation ledger`)
      assert(snapshot.includes(`'${kind}'`), `${kind} missing from snapshot validation`)
      assert(reducer.includes(`event.kind === '${kind}'`), `${kind} missing from renderer reducer`)
    }
    assert.match(message, /setShowSettings\(true, 'providers', 'provider-recovery-exhausted'\)/)
    assert(settingsNavigation.includes("'provider-recovery-exhausted'"))
  })

  status = 'passed'
} catch (error) {
  failure = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  rmSync(buildDir, { recursive: true, force: true })
  const report = {
    schemaVersion: 1,
    gate: 'test:routing-recovery-ladder:required',
    runId,
    status,
    checks,
    error: failure,
    failures: failure ? [{ message: failure }] : [],
    warnings: []
  }
  const provenance = bindSourceEvidence(
    report,
    sourceEvidenceAtStart,
    readSourceEvidenceState(repoRoot),
    'Routing recovery ladder'
  )
  if (provenance.status !== 'pass') {
    report.status = 'failed'
    process.exitCode = 1
  }
  writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2))
  writeFileSync(
    path.join(repoRoot, 'test-results', 'routing-recovery-ladder', 'latest.json'),
    JSON.stringify(report, null, 2)
  )
}

if (status === 'passed') console.log(`routing recovery ladder smoke ok: ${reportDir}`)
else console.error(`routing recovery ladder smoke failed: ${failure}`)

function source(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function between(value, start, end) {
  const startIndex = value.indexOf(start)
  const endIndex = value.indexOf(end, startIndex + start.length)
  assert(startIndex >= 0 && endIndex > startIndex, `source boundary missing: ${start}`)
  return value.slice(startIndex, endIndex)
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
      try {
        return findCompiled(fullPath, fileName)
      } catch {
        // Continue searching sibling directories.
      }
    } else if (entry.name === fileName) {
      return fullPath
    }
  }
  throw new Error(`compiled file not found: ${fileName}`)
}
