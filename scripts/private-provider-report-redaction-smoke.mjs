#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const tempRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'caogen-private-provider-report-')))
const privateDir = path.join(tempRoot, '.caogen-private')
const providerFile = path.join(privateDir, 'provider-parity.json')
const reportRoot = path.join(tempRoot, 'reports')
const responseCanary = 'private-provider-response-canary'
const privateProviders = []
const requests = []
let server

try {
  server = createServer(async (request, response) => {
    const body = await readJson(request)
    requests.push(request.url || '')
    const tool = firstTool(body)
    const name = tool?.function?.name || tool?.name
    const args = Object.fromEntries(
      (tool?.function?.parameters?.required || tool?.parameters?.required || []).map((key) => [key, null])
    )
    response.writeHead(200, { 'content-type': 'application/json' })
    if (request.url?.endsWith('/responses')) {
      response.end(JSON.stringify({
        output: [{ type: 'function_call', name, arguments: JSON.stringify(args) }],
        privateResponseMarker: responseCanary
      }))
      return
    }
    response.end(JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }],
      privateResponseMarker: responseCanary
    }))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const port = server.address().port
  privateProviders.push(
    providerFixture('baseline-private-canary', 'Baseline private canary', 'baseline', 'openai-responses', port),
    providerFixture('china-private-canary', 'China private canary', 'china', 'openai-compatible', port)
  )
  mkdirSync(privateDir, { recursive: true, mode: 0o700 })
  chmodSync(privateDir, 0o700)
  writeFileSync(providerFile, `${JSON.stringify(privateProviders, null, 2)}\n`, { mode: 0o600 })
  chmodSync(providerFile, 0o600)

  const result = await runProcess(process.execPath, ['scripts/china-tool-call-parity.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAOGEN_PRIVATE_PROVIDER_TEST_MODE: '1',
      CAOGEN_CHINA_TOOL_CALL_PARITY: '1',
      CAOGEN_CHINA_PARITY_PROVIDERS: providerFile,
      CAOGEN_CHINA_TOOL_CALL_PARITY_REPORT_ROOT: reportRoot
    }
  })
  assert.equal(result.signal, null)
  assert.equal(result.status, 0, safeDiagnostic(result))
  assert.equal(requests.length, 24, safeDiagnostic(result))

  const reportText = readFileSync(path.join(reportRoot, 'latest.json'), 'utf8')
  const report = JSON.parse(reportText)
  assert.equal(report.status, 'passed')
  assert.equal(report.privateProviderConfigRedacted, true)
  assert.equal(report.providerConcurrency, 2)
  assert.deepEqual(report.results.map((item) => item.providerRef), ['provider-01', 'provider-02'])
  assert(report.results.every((item) => item.passRate === 1))

  const publicSurface = `${result.stdout}\n${result.stderr}\n${reportText}`
  for (const provider of privateProviders) {
    for (const field of ['id', 'name', 'baseUrl', 'model', 'apiKey']) {
      assert.equal(publicSurface.includes(provider[field]), false, `private Provider field leaked: ${field}`)
    }
  }
  assert.equal(publicSurface.includes(responseCanary), false, 'private Provider response leaked')
  console.log('private provider report redaction smoke: PASS')
} finally {
  await new Promise((resolve) => server?.close(resolve) ?? resolve())
  rmSync(tempRoot, { recursive: true, force: true })
}

function providerFixture(id, name, group, apiFormat, port) {
  return {
    id,
    name,
    group,
    apiFormat,
    baseUrl: `http://127.0.0.1:${port}/v1/private-target-canary`,
    model: `${id}-private-model`,
    apiKey: `${id}-private-key`
  }
}

function firstTool(body) {
  return Array.isArray(body?.tools) ? body.tools[0] : undefined
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, encoding: 'utf8' })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('private Provider redaction smoke timed out'))
    }, 60_000)
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

function safeDiagnostic(result) {
  let output = `${result.stderr}\n${result.stdout}`
  for (const provider of privateProviders) {
    for (const field of ['id', 'name', 'baseUrl', 'model', 'apiKey']) {
      output = output.replaceAll(provider[field], '[redacted]')
    }
  }
  return output.replaceAll(responseCanary, '[redacted]')
}
