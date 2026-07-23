#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const tempRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'caogen-real-provider-runner-smoke-')))
const providerFile = path.join(tempRoot, 'providers.json')
const recordFile = path.join(tempRoot, 'record.json')
const auditRoot = path.join(tempRoot, 'audit')
const syntheticToken = 'secret-for-smoke-real-provider-runner-canary'
const syntheticModel = 'runner-fixture-model'
const childEnvironmentCanaries = {
  APPLE_API_KEY: 'apple-key-runner-canary',
  APPLE_API_KEY_ID: 'apple-key-id-runner-canary',
  APPLE_API_ISSUER: 'apple-issuer-runner-canary',
  RUNNER_GENERIC_TOKEN: 'generic-token-runner-canary',
  RUNNER_GENERIC_SECRET: 'generic-secret-runner-canary',
  RUNNER_GENERIC_API_KEY: 'generic-api-key-runner-canary'
}
const requests = []
let server

try {
  server = createServer(async (request, response) => {
    const body = await readJson(request)
    requests.push({ authorizationPresent: Boolean(request.headers.authorization), body })
    const rawInput = JSON.stringify(body.input ?? [])
    if (rawInput.includes('function_call_output')) {
      writeFinalResponse(response)
      return
    }
    const prompt = inputText(body)
    const content = prompt.match(/CONTENT-BEGIN\n([\s\S]*?)CONTENT-END/)?.[1]
    if (!content) {
      response.writeHead(400).end('invalid fixture request')
      return
    }
    writeToolResponse(response, content)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  writeFileSync(providerFile, `${JSON.stringify([{
    id: 'fixture-baseline',
    name: 'Fixture baseline',
    group: 'baseline',
    apiFormat: 'openai-responses',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: syntheticModel,
    apiKey: syntheticToken
  }])}\n`, { mode: 0o600 })
  chmodSync(providerFile, 0o600)

  const result = await runProcess(process.execPath, [
    path.join(repoRoot, 'scripts', 'real-provider-release-runner.mjs'),
    '--providers', providerFile,
    '--record', recordFile,
    '--audit-report-root', auditRoot,
    '--allow-loopback-fixture',
    '--max-requests', '3',
    '--timeout-ms', '5000'
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...childEnvironmentCanaries,
      CAOGEN_REAL_PROVIDER_RELEASE_TEST_MODE: '1'
    }
  })
  const diagnostic = redactDiagnostic(`${result.stderr}\n${result.stdout}`, [
    syntheticToken,
    syntheticModel,
    `127.0.0.1:${port}`,
    ...Object.values(childEnvironmentCanaries)
  ])
  assert.equal(result.signal, null, diagnostic)
  assert([0, 2].includes(result.status), `runner exit=${result.status} output=${diagnostic}`)
  const summary = JSON.parse(result.stdout.trim())
  assert.equal(summary.functionalPassed, true)
  assert.equal(summary.formalBinding, summary.worktreeClean)
  assert.equal(summary.requestCount, 2)
  assert.equal(summary.toolCallCount, 1)
  assert.equal(Object.hasOwn(summary, 'recordPath'), false)
  assert.equal(Object.hasOwn(summary, 'auditReport'), false)
  assert.equal(result.stdout.includes(recordFile), false)
  assert.equal(result.stdout.includes(auditRoot), false)
  assert.match(summary.transcriptSha256, /^sha256:[0-9a-f]{64}$/)
  assert.match(summary.artifactSha256, /^sha256:[0-9a-f]{64}$/)
  assert.match(summary.recoverySha256, /^sha256:[0-9a-f]{64}$/)

  const record = JSON.parse(readFileSync(recordFile, 'utf8'))
  assert.equal(record.schemaVersion, 1)
  assert.equal(record.protocol, 'openai-compatible')
  assert.equal(record.redacted, true)
  assert.equal(record.requestCount, 2)
  assert.equal(record.toolCallCount, 1)
  for (const field of ['sendPassed', 'toolPassed', 'artifactPassed', 'recoveryPassed', 'usagePassed', 'billingPassed']) {
    assert.equal(record[field], true, field)
  }
  assert.match(record.providerTarget.sha256, /^sha256:[0-9a-f]{64}$/)
  assert.match(record.transcriptSha256, /^sha256:[0-9a-f]{64}$/)
  assert.match(record.artifactSha256, /^sha256:[0-9a-f]{64}$/)
  assert.match(record.recoverySha256, /^sha256:[0-9a-f]{64}$/)
  assert.equal(statSync(recordFile).mode & 0o777, 0o600)
  assert.equal(requests.length, 2)
  assert(requests.every((item) => item.authorizationPresent))

  const publicOutput = `${result.stdout}\n${result.stderr}\n${JSON.stringify(record)}`
  for (const forbidden of [
    syntheticToken,
    syntheticModel,
    `127.0.0.1:${port}`,
    'CONTENT-BEGIN',
    'function_call_output',
    ...Object.values(childEnvironmentCanaries)
  ]) {
    assert.equal(publicOutput.includes(forbidden), false, `public output leaked ${forbidden}`)
  }

  const realRecordParent = path.join(tempRoot, 'real-record-parent')
  const symlinkRecordParent = path.join(tempRoot, 'symlink-record-parent')
  mkdirSync(realRecordParent, { mode: 0o700 })
  symlinkSync(realRecordParent, symlinkRecordParent, 'dir')
  const rejected = await runProcess(process.execPath, [
    path.join(repoRoot, 'scripts', 'real-provider-release-runner.mjs'),
    '--providers', providerFile,
    '--record', path.join(symlinkRecordParent, 'record.json'),
    '--audit-report-root', auditRoot,
    '--allow-loopback-fixture'
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, CAOGEN_REAL_PROVIDER_RELEASE_TEST_MODE: '1' }
  })
  assert.equal(rejected.status, 1)
  assert.equal(rejected.signal, null)
  const rejectionSummary = JSON.parse(rejected.stdout.trim())
  assert.equal(rejectionSummary.errorCode, 'record_parent_symlink')
  assert.equal(rejected.stdout.includes(symlinkRecordParent), false)
  console.log('real provider release runner smoke: PASS')
} finally {
  await new Promise((resolve) => server?.close(resolve) ?? resolve())
  rmSync(tempRoot, { recursive: true, force: true })
}

function writeToolResponse(response, content) {
  const item = {
    type: 'function_call',
    call_id: 'call_release_evidence',
    name: 'write_file',
    arguments: JSON.stringify({ path: 'release-evidence-output.txt', content })
  }
  response.writeHead(200, sseHeaders())
  response.write(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item })}\n\n`)
  response.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\n`)
  response.write(`data: ${JSON.stringify({
    type: 'response.completed',
    response: {
      id: 'resp_release_tool',
      usage: { input_tokens: 20, output_tokens: 6, input_tokens_details: { cached_tokens: 0 } }
    }
  })}\n\n`)
  response.end('data: [DONE]\n\n')
}

function writeFinalResponse(response) {
  response.writeHead(200, sseHeaders())
  response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'done' })}\n\n`)
  response.write(`data: ${JSON.stringify({
    type: 'response.completed',
    response: {
      id: 'resp_release_done',
      output_text: 'done',
      usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 0 } }
    }
  })}\n\n`)
  response.end('data: [DONE]\n\n')
}

function sseHeaders() {
  return { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function inputText(body) {
  for (const item of Array.isArray(body.input) ? body.input : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === 'input_text' && typeof content.text === 'string') return content.text
    }
  }
  return ''
}

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options)
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('runner smoke child timed out'))
    }, 30_000)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (status, signal) => {
      clearTimeout(timer)
      resolve({ status, signal, stdout, stderr })
    })
  })
}

function redactDiagnostic(value, forbiddenValues) {
  return forbiddenValues.reduce(
    (redacted, forbidden) => redacted.replaceAll(forbidden, '[redacted]'),
    value
  )
}
