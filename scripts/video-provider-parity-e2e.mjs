#!/usr/bin/env node

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnElectronTestProcess, terminateElectronTestProcess } from './lib/electron-test-process.mjs'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const electronBin = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const sourceOutDir = path.join(repoRoot, 'out')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'video-provider-parity', runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-video-provider-parity-'))
const userDataDir = path.join(tempRoot, 'userData')
const isolatedOutDir = path.join(reportDir, 'app', 'out')
const mainEntry = path.join(isolatedOutDir, 'main', 'index.js')
const fixtureCredential = randomUUID()
const requests = []
const jobs = new Map()
const checks = []

for (const entry of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
  assert(existsSync(path.join(sourceOutDir, entry)), `Built app entry missing: out/${entry}. Run npm run build first.`)
}
mkdirSync(reportDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
copyBuiltApp()

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const body = await readBody(request)
  requests.push({ method: request.method, path: url.pathname, contentType: request.headers['content-type'] ?? '', body: body.toString('utf8') })

  if (request.method === 'POST' && url.pathname === '/v1/videos') {
    const model = multipartField(body, 'model')
    const id = `parity-${jobs.size + 1}`
    jobs.set(id, { model })
    if (model === 'failure-model') return json(response, 503, { error: { message: 'simulated provider failure' } })
    return json(response, 200, { id, status: 'queued', model })
  }
  const match = /^\/v1\/videos\/([^/]+)(?:\/content)?$/.exec(url.pathname)
  if (!match) return json(response, 404, { error: { message: 'not found' } })
  const id = match[1]
  const job = jobs.get(id)
  if (!job) return json(response, 404, { error: { message: 'unknown job' } })
  if (request.method === 'DELETE') return json(response, 200, { id, status: 'cancelled' })
  if (request.method === 'GET' && url.pathname.endsWith('/content')) {
    const bytes = Buffer.from('caogen-video-provider-parity')
    response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(bytes.length) })
    return response.end(bytes)
  }
  if (request.method === 'GET') return json(response, 200, { id, status: 'completed', output_url: `${serverBase}/v1/videos/${id}/content`, media_type: 'video/mp4' })
  return json(response, 405, { error: { message: 'method not allowed' } })
})

let serverBase = ''
let electron
let browser
let page
try {
  await listen(server)
  serverBase = `http://127.0.0.1:${server.address().port}`
  const remotePort = await findFreePort(9950)
  electron = spawnElectronTestProcess(electronBin, [
    ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    `--remote-debugging-port=${remotePort}`,
    mainEntry
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAOGEN_USER_DATA_DIR: userDataDir,
      CAOGEN_MEMORY_DIR: path.join(tempRoot, 'memory'),
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  await waitForDebugPort(remotePort, 20_000)
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${remotePort}`, defaultViewport: null })
  page = await waitForElectronPage(browser, 20_000)
  await page.waitForSelector('.app', { timeout: 20_000 })
  await page.waitForFunction(() => typeof window.agentDesk?.createProjectWorkspace === 'function', { timeout: 15_000 })

  const fixture = await page.evaluate(async ({ baseUrl, credential }) => {
    const provider = await window.agentDesk.createProvider({
      name: 'Video Provider Parity Mock', baseUrl, token: credential,
      models: ['grok-imagine-video', 'grok-imagine-video-1.5', 'failure-model', 'cancel-model'],
      engine: 'openai', authMode: 'api-key', openaiProtocol: 'responses'
    })
    const project = await window.agentDesk.createProjectWorkspace({ id: 'video-provider-parity-project', name: 'Video Provider Parity', kind: 'software' })
    const production = await window.agentDesk.createVideoProduction({
      id: 'video-provider-parity-production', projectId: project.id, title: 'Provider parity production',
      script: 'A short provider parity fixture.', autoStructure: false
    })
    const mediaProvider = await window.agentDesk.upsertMediaProvider({
      id: 'media-provider:video-parity', displayName: 'OpenAI Video Parity', capabilities: ['video'],
      operations: ['video.text-to-video'], endpointClass: 'openai-video', providerId: provider.id,
      model: 'grok-imagine-video', enabled: true
    })
    return { providerId: provider.id, projectId: project.id, productionId: production.id, mediaProviderId: mediaProvider.id }
  }, { baseUrl: serverBase, credential: fixtureCredential })

  await check('grok-imagine-video submits multipart POST /v1/videos and completes through poll/download', async () => {
    const result = await runSuccessfulModel(fixture, 'grok-imagine-video')
    assert.equal(result.status, 'succeeded')
    const submit = requests.find((item) => item.method === 'POST' && item.path === '/v1/videos' && item.body.includes('grok-imagine-video'))
    assert(submit, 'grok-imagine-video multipart submission was not observed')
    assert(submit.contentType.startsWith('multipart/form-data;'), `unexpected content type: ${submit.contentType}`)
    assert(requests.some((item) => item.method === 'GET' && item.path.endsWith('/content')), 'video download was not observed')
  })

  await check('grok-imagine-video-1.5 uses the same canonical endpoint and state machine', async () => {
    const result = await runSuccessfulModel(fixture, 'grok-imagine-video-1.5')
    assert.equal(result.status, 'succeeded')
    assert(requests.some((item) => item.method === 'POST' && item.path === '/v1/videos' && item.body.includes('grok-imagine-video-1.5')), 'grok-imagine-video-1.5 submission was not observed')
  })

  await check('remote HTTP failure remains a failed MediaJob', async () => {
    const job = await page.evaluate((value) => window.agentDesk.submitMediaJob({
      projectId: value.projectId, productionId: value.productionId, capability: 'video', operation: 'video.text-to-video',
      idempotencyKey: 'video-provider-parity-failure', mediaProviderId: value.mediaProviderId, model: 'failure-model', prompt: 'failure fixture'
    }), fixture)
    assert.equal(job.status, 'failed')
    assert.match(job.error ?? '', /simulated provider failure|HTTP 503|Provider reported failure/i)
  })

  await check('remote cancellation remains explicit and does not become success', async () => {
    const job = await page.evaluate((value) => window.agentDesk.submitMediaJob({
      projectId: value.projectId, productionId: value.productionId, capability: 'video', operation: 'video.text-to-video',
      idempotencyKey: 'video-provider-parity-cancel', mediaProviderId: value.mediaProviderId, model: 'cancel-model', prompt: 'cancel fixture'
    }), fixture)
    const cancelled = await page.evaluate((id) => window.agentDesk.cancelMediaJob(id), job.id)
    assert.equal(cancelled.status, 'cancelled')
  })

  const report = {
    schemaVersion: 1,
    runId,
    gate: 'test:video-provider-parity',
    status: 'passed',
    classification: 'local_targeted_not_release',
    models: ['grok-imagine-video', 'grok-imagine-video-1.5'],
    endpoint: 'POST /v1/videos',
    checks,
    requestSummary: requests.map((item) => ({ method: item.method, path: item.path, contentType: item.contentType, model: multipartField(Buffer.from(item.body), 'model') || undefined })),
    explicitlyNotVerified: ['real ciyuan2api.com credentials or production quota', 'commercial video quality parity', 'five-user timed acceptance and clean release SHA binding']
  }
  writeReport(report)
  console.log(`video provider parity e2e: passed (${checks.length}/${checks.length})`)
  console.log(path.join(reportDir, 'report.json'))
} catch (error) {
  writeReport({ schemaVersion: 1, runId, gate: 'test:video-provider-parity', status: 'failed', checks, error: error instanceof Error ? error.message : String(error) })
  throw error
} finally {
  if (browser) browser.disconnect()
  if (electron) await terminateElectronTestProcess(electron)
  await close(server)
  rmSync(tempRoot, { recursive: true, force: true })
}

async function runSuccessfulModel(fixture, model) {
  const job = await page.evaluate((value) => window.agentDesk.submitMediaJob({
    projectId: value.projectId, productionId: value.productionId, capability: 'video', operation: 'video.text-to-video',
    idempotencyKey: `video-provider-parity-${value.model}`, mediaProviderId: value.mediaProviderId, model: value.model,
    prompt: 'A clean provider parity test clip.', parameters: { durationSeconds: 5 }
  }), { ...fixture, model })
  assert.equal(job.status, 'running', `submit status for ${model}: ${job.status}`)
  const downloading = await page.evaluate((id) => window.agentDesk.advanceMediaJob(id), job.id)
  assert.equal(downloading.status, 'downloading', `poll status for ${model}: ${downloading.status}`)
  return page.evaluate((id) => window.agentDesk.advanceMediaJob(id), job.id)
}

async function check(name, fn) {
  const started = Date.now()
  try {
    await fn()
    checks.push({ name, status: 'pass', durationMs: Date.now() - started })
  } catch (error) {
    checks.push({ name, status: 'fail', error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started })
    throw error
  }
}

function writeReport(report) {
  mkdirSync(reportDir, { recursive: true })
  const output = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(reportDir, 'report.json'), output)
  writeFileSync(path.join(repoRoot, 'test-results', 'video-provider-parity', 'latest.json'), output)
}

function copyBuiltApp() {
  rmSync(isolatedOutDir, { recursive: true, force: true })
  mkdirSync(isolatedOutDir, { recursive: true })
  for (const directory of ['main', 'preload', 'renderer']) cpSync(path.join(sourceOutDir, directory), path.join(isolatedOutDir, directory), { recursive: true })
}

function multipartField(body, name) {
  const match = body.toString('utf8').match(new RegExp(`name="${name}"\\r?\\n\\r?\\n([^\\r\\n]+)`))
  return match?.[1] ?? ''
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

async function waitForElectronPage(connectedBrowser, timeoutMs) {
  return waitForValue(async () => (await connectedBrowser.pages()).find((candidate) => !candidate.url().startsWith('devtools://')), Boolean, timeoutMs, 'waiting for Electron renderer page')
}

async function waitForDebugPort(port, timeoutMs) {
  await waitForValue(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok } catch { return false }
  }, Boolean, timeoutMs, `waiting for Electron debug port ${port}`)
}

async function waitForValue(producer, predicate, timeoutMs, label) {
  const started = Date.now()
  let value
  while (Date.now() - started < timeoutMs) {
    value = await producer()
    if (predicate(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${label}: ${JSON.stringify(value)}`)
}

async function findFreePort(start) {
  for (let port = start; port < start + 200; port += 1) {
    try {
      const probe = http.createServer()
      await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve) })
      await new Promise((resolve) => probe.close(resolve))
      return port
    } catch { /* try the next port */ }
  }
  throw new Error('no free Electron debug port')
}
