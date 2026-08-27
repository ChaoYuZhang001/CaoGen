#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { bindSourceEvidence, readSourceEvidenceState } from './lib/source-evidence-binding.mjs'

const repoRoot = process.cwd()
const sourceEvidenceAtStart = readSourceEvidenceState(repoRoot)
const outDir = mkdtempSync(path.join(tmpdir(), 'caogen-provider-timeout-'))
const checks = []
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'provider-request-timeout')
const reportDir = path.join(reportRoot, runId)
let finalStatus = 'failed'
let finalError

try {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/provider/providerRequestTimeout.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck'
  ], { cwd: repoRoot, stdio: 'inherit' })
  const api = await import(pathToFileURL(findCompiled(outDir, 'providerRequestTimeout.js')).href)

  equal(api.providerRequestIsStreaming(JSON.stringify({ stream: true })), true,
    'structured request body detects streaming')
  equal(api.providerRequestIsStreaming('{broken'), false, 'invalid request body fails closed to non-streaming')
  const extracted = api.providerRequestTimeouts({ advancedConfig: { schemaVersion: 1, reliability: {
    streamingFirstByteTimeoutSeconds: 12,
    streamingIdleTimeoutSeconds: 34,
    requestTimeoutSeconds: 56
  } } })
  equal(extracted.streamingIdleTimeoutSeconds, 34, 'Provider reliability timeout values are extracted')

  await checkRejects(async () => {
    const deadline = new api.ProviderRequestDeadline(new AbortController().signal, {
      streamingFirstByteTimeoutSeconds: 0.02
    }, true)
    await waitForAbort(deadline.signal)
  }, 'PROVIDER_FIRST_BYTE_TIMEOUT', 'first-byte deadline aborts before any response chunk')

  await checkRejects(async () => {
    const deadline = new api.ProviderRequestDeadline(new AbortController().signal, {
      requestTimeoutSeconds: 0.02
    }, false)
    await waitForAbort(deadline.signal)
  }, 'PROVIDER_REQUEST_TIMEOUT', 'non-streaming deadline covers the complete request')

  await checkRejects(async () => {
    let source
    const raw = new Response(new ReadableStream({ start(controller) { source = controller } }), {
      status: 206,
      headers: { 'x-timeout-fixture': 'present' }
    })
    const deadline = new api.ProviderRequestDeadline(new AbortController().signal, {
      streamingFirstByteTimeoutSeconds: 0.1,
      streamingIdleTimeoutSeconds: 0.02
    }, true)
    const wrapped = deadline.wrapResponse(raw)
    equal(wrapped.status, 206, 'wrapped stream preserves response status')
    equal(wrapped.headers.get('x-timeout-fixture'), 'present', 'wrapped stream preserves response headers')
    const reader = wrapped.body.getReader()
    source.enqueue(new TextEncoder().encode('first'))
    equal(new TextDecoder().decode((await guarded(reader.read())).value), 'first', 'first response chunk is delivered')
    await guarded(reader.read())
  }, 'PROVIDER_STREAM_IDLE_TIMEOUT', 'idle deadline starts after the first chunk')

  const parent = new AbortController()
  const parentDeadline = new api.ProviderRequestDeadline(parent.signal, {
    streamingFirstByteTimeoutSeconds: 1
  }, true)
  const parentReason = new Error('user cancelled')
  parent.abort(parentReason)
  equal(await rejectedValue(waitForAbort(parentDeadline.signal)), parentReason,
    'parent cancellation is not relabeled as a Provider timeout')
  parentDeadline.finish()

  const completed = new api.ProviderRequestDeadline(new AbortController().signal, {
    requestTimeoutSeconds: 0.02
  }, false)
  completed.finish()
  await delay(35)
  equal(completed.signal.aborted, false, 'completed request clears its deadline')

  const openai = readFileSync(path.join(repoRoot, 'src/main/openaiEngine.ts'), 'utf8')
  const anthropic = readFileSync(path.join(repoRoot, 'src/main/anthropicEngine.ts'), 'utf8')
  const adapter = readFileSync(path.join(repoRoot, 'src/main/anthropicMessagesAdapter.ts'), 'utf8')
  const target = readFileSync(path.join(repoRoot, 'src/main/provider/anthropicMessagesTarget.ts'), 'utf8')
  equal(openai.includes('new ProviderRequestDeadline(signal, timeouts, streaming)'), true,
    'OpenAI ModelAttempt fetch creates a deadline per network attempt')
  equal(openai.includes('deadline.wrapResponse(response)'), true,
    'OpenAI response consumption is wrapped by streaming deadlines')
  equal(anthropic.includes('timeouts: target.timeouts'), true,
    'Anthropic engine forwards resolved Provider timeouts')
  equal(adapter.includes('new ProviderRequestDeadline(input.signal, input.timeouts ?? {}, true)')
    && target.includes('providerRequestTimeouts(provider)'), true,
  'Anthropic adapter enforces timeouts resolved from the active Provider')

  finalStatus = 'passed'
} catch (error) {
  finalError = error instanceof Error ? error.stack || error.message : String(error)
  process.exitCode = 1
} finally {
  rmSync(outDir, { recursive: true, force: true })
  const report = {
    schemaVersion: 1,
    runId,
    gate: 'test:provider-request-timeout',
    status: finalStatus,
    ok: finalStatus === 'passed',
    generatedAt: new Date().toISOString(),
    pass: checks.length,
    total: checks.length,
    checks: checks.map((name) => ({ name, status: 'pass' })),
    failures: finalError ? [{ message: finalError }] : [],
    warnings: []
  }
  const provenance = bindSourceEvidence(
    report,
    sourceEvidenceAtStart,
    readSourceEvidenceState(repoRoot),
    'Provider request timeout'
  )
  if (provenance.status !== 'pass') {
    report.status = 'failed'
    report.ok = false
    report.failures.push({ message: report.error })
    process.exitCode = 1
  }
  mkdirSync(reportDir, { recursive: true })
  const body = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(reportDir, 'report.json'), body, 'utf8')
  writeFileSync(path.join(reportRoot, 'latest.json'), body, 'utf8')
}

if (finalStatus === 'passed' && !process.exitCode) {
  console.log(`provider request timeout smoke ok: ${checks.length}/${checks.length}`)
} else {
  console.error(`provider request timeout smoke failed: ${finalError ?? 'evidence provenance failed'}`)
}

async function checkRejects(action, code, message) {
  const error = await rejectedValue(action())
  equal(error?.code, code, message)
}

async function rejectedValue(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected rejection')
}

function waitForAbort(signal) {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((_, reject) => {
    const guard = setTimeout(() => reject(new Error('timeout guard expired')), 2_000)
    signal.addEventListener('abort', () => {
      clearTimeout(guard)
      reject(signal.reason)
    }, { once: true })
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function guarded(promise) {
  return Promise.race([
    promise,
    delay(2_000).then(() => { throw new Error('stream timeout guard expired') })
  ])
}

function equal(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
  checks.push(message)
}

function findCompiled(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiled(candidate, fileName)
      if (found) return found
    } else if (entry.name === fileName) return candidate
  }
  return null
}
