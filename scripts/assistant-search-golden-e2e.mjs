#!/usr/bin/env node

import assert from 'node:assert/strict'
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
const reportDir = path.join(repoRoot, 'test-results', 'assistant-search-golden', runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-assistant-search-golden-'))
const userDataDir = path.join(tempRoot, 'userData')
const workspaceDir = path.join(tempRoot, 'workspace')
const isolatedOutDir = path.join(reportDir, 'app', 'out')
const mainEntry = path.join(isolatedOutDir, 'main', 'index.js')
const checks = []
const modelRequests = []
const searchRequests = []

for (const entry of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
  assert(existsSync(path.join(sourceOutDir, entry)), `Built app entry missing: out/${entry}. Run npm run build first.`)
}
mkdirSync(reportDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
mkdirSync(workspaceDir, { recursive: true })
writeFileSync(path.join(workspaceDir, 'README.md'), '# Assistant search golden workspace\n', 'utf8')
copyBuiltApp()

const server = http.createServer(async (request, response) => {
  const body = await readBody(request)
  if (request.method === 'POST' && request.url === '/v1/responses') {
    const payload = parseJson(body)
    modelRequests.push(payload)
    const raw = JSON.stringify(payload?.input ?? '')
    const continuation = raw.includes('function_call_output')
    if (continuation) return writeTextResponse(response, '联网研究结果已返回，可继续追问或导出。')
    const prompt = raw
    if (!prompt.includes('search golden')) return writeTextResponse(response, 'Assistant 首任务响应已完成。')
    const statusMatch = /search failure (no_results|timeout|no_credentials|egress_denied|provider_failure|unknown_result)/.exec(prompt)
    const query = statusMatch ? `search failure ${statusMatch[1]}` : 'search golden success'
    return writeFunctionCallResponse(response, `search-call-${modelRequests.length}`, 'web_search', {
      query,
      mode: 'model_native',
      operationId: `assistant-search-golden-${modelRequests.length}`,
      limit: 1
    })
  }
  if (request.method === 'POST' && request.url === '/search') {
    const payload = parseJson(body)
    const query = typeof payload?.query === 'string' ? payload.query : ''
    searchRequests.push({ query })
    const failure = query.match(/^search failure (no_results|timeout|no_credentials|egress_denied|provider_failure|unknown_result)$/)?.[1]
    if (failure) {
      if (failure === 'timeout') await new Promise((resolve) => setTimeout(resolve, 300))
      return json(response, 200, { status: failure, message: `fixture ${failure}` })
    }
    return json(response, 200, {
      status: 'success',
      results: [{ url: 'https://example.com/', title: 'Example Domain', summary: 'fixture snippet is advisory only' }]
    })
  }
  response.writeHead(404).end('not found')
})

let serverBase = ''
let electron
let browser
let page
let electronStdout = ''
let electronStderr = ''
try {
  await listen(server)
  serverBase = `http://127.0.0.1:${server.address().port}`
  writeFileSync(path.join(userDataDir, 'providers.json'), JSON.stringify([{
    id: 'assistant-search-golden', name: 'Assistant Search Golden Mock', baseUrl: serverBase,
    encryptedToken: `b64:${Buffer.from('search-golden-token').toString('base64')}`,
    models: ['search-golden-model'], openaiProtocol: 'responses',
    credentialHeaderNames: ['Authorization'], createdAt: Date.now()
  }], null, 2))
  writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify({
    defaultModel: 'search-golden-model', defaultProviderId: 'assistant-search-golden',
    language: 'zh', theme: 'dark', failoverEnabled: false, budgetUsdPerSession: 0
  }, null, 2))
  const remotePort = await findFreePort(9960)
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
      CAOGEN_SEARCH_MODEL_NATIVE_URL: `${serverBase}/search`,
      CAOGEN_SEARCH_BYOK_URL: '',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  electron.stdout?.on('data', (chunk) => { electronStdout += chunk.toString() })
  electron.stderr?.on('data', (chunk) => { electronStderr += chunk.toString() })
  await waitForDebugPort(remotePort, 20_000)
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${remotePort}`, defaultViewport: null })
  page = await waitForElectronPage(browser, 20_000)
  await page.waitForSelector('.app', { timeout: 20_000 })
  await page.waitForSelector('[data-experience-mode-switcher]', { visible: true, timeout: 15_000 })
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
  // Session registry recovery runs during renderer bootstrap; wait for it before creating the fixture.
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  writeFileSync(path.join(reportDir, 'sessions-before-create.json'), JSON.stringify(await page.evaluate(() => window.agentDesk.listSessions()), null, 2))

  await page.waitForSelector('.welcome-composer-input', { visible: true, timeout: 15_000 })
  await page.type('.welcome-composer-input', 'search golden success')
  await page.click('.welcome-send')
  await page.waitForSelector('.composer-input', { visible: true, timeout: 20_000 })
  const session = await waitForValue(
    () => page.evaluate(() => window.agentDesk.listSessions().then((items) => items.find((item) => item.title === 'search golden success' || item.title === 'search golden success'.slice(0, 40)))),
    (item) => Boolean(item?.id),
    15_000,
    'waiting for Assistant search golden Session'
  )
  assert(session?.id, 'search golden Session was not created')

  await check('Assistant starts the search golden task without a Project', async () => {
    const transcript = await waitForValue(
      () => page.evaluate((id) => window.agentDesk.getTranscript(id), session.id),
      (entries) => entries.some((entry) => entry.event?.kind === 'turn-result'),
      30_000,
      'waiting for successful search turn'
    )
    const toolResult = transcript.find((entry) => entry.event?.kind === 'tool-result' && entry.event?.toolUseId?.startsWith('search-call-'))
    assert(toolResult, 'successful web_search tool result is missing')
    const rawContent = toolResult.event.content
    let result
    try { result = JSON.parse(rawContent) } catch { throw new Error(`web_search returned non-JSON content: ${String(rawContent).slice(0, 500)}`) }
    if (!result.ok) throw new Error(`web_search success fixture failed: ${JSON.stringify(result)}`)
    assert.equal(result.ok, true)
    assert.equal(result.status, 'success')
    assert.equal(result.projectId, null)
    assert(result.results[0].url === 'https://example.com/', 'verified source URL missing')
    assert(result.results[0].contentSha256.length === 64, 'content SHA-256 missing')
    assert(result.results[0].evidenceId, 'Evidence ID missing')
  })

  await check('Assistant renders verified source metadata and export actions', async () => {
    await page.click('.tool-card .tool-header')
    await page.screenshot({ path: path.join(reportDir, 'search-success-debug.png') })
    writeFileSync(path.join(reportDir, 'search-success-debug.json'), JSON.stringify(await page.evaluate(() => ({
      active: [...document.querySelectorAll('[data-session-id]')].filter((node) => node.classList.contains('active') || node.getAttribute('aria-current') === 'true').map((node) => node.getAttribute('data-session-id')),
      sessionNodes: [...document.querySelectorAll('[data-session-id]')].map((node) => ({ id: node.getAttribute('data-session-id'), className: node.className, text: node.textContent?.slice(0, 120) })),
      cards: [...document.querySelectorAll('[data-search-result-status]')].map((node) => node.getAttribute('data-search-result-status')),
      body: document.body.innerText.slice(-2000)
    })), null, 2))
    await page.waitForSelector('.tool-search-result[data-search-result-status="success"]', { visible: true, timeout: 15_000 })
    const view = await page.$eval('.tool-search-result[data-search-result-status="success"]', (node) => ({
      text: node.textContent ?? '', copy: Boolean(node.querySelector('[data-search-result-copy]')),
      export: Boolean(node.querySelector('[data-search-result-export]')), raw: Boolean(node.querySelector('.tool-search-raw'))
    }))
    assert(view.text.includes('已找到已验证来源'), `success status missing: ${view.text}`)
    assert(view.text.includes('Evidence'), `Evidence label missing: ${view.text}`)
    assert(view.text.includes('sha256:'), `digest label missing: ${view.text}`)
    assert(view.copy && view.export && view.raw, `result actions missing: ${JSON.stringify(view)}`)
  })

  const failureStates = ['no_results', 'timeout', 'no_credentials', 'egress_denied', 'provider_failure', 'unknown_result']
  const renderedFailureStates = []
  const failureCardText = {}
  const failureSessionIds = []
  for (const state of failureStates) {
    const sessionIdsBeforeCreate = await page.evaluate(() => window.agentDesk.listSessions().then((items) => items.map((item) => item.id)))
    await page.click('.sidebar-new')
    await page.waitForSelector('.welcome-composer-input', { visible: true, timeout: 15_000 })
    const prompt = `search golden search failure ${state}`
    await page.type('.welcome-composer-input', prompt)
    await page.click('.welcome-send')
    await page.waitForSelector('.composer-input', { visible: true, timeout: 20_000 })
    const failureSession = await waitForValue(
      async () => {
        const activeId = await page.$eval('.session-card.active', (node) => node.getAttribute('data-session-id')).catch(() => null)
        const items = await page.evaluate(() => window.agentDesk.listSessions())
        const created = items.find((item) => !sessionIdsBeforeCreate.includes(item.id))
        return created?.id === activeId ? created : created ?? (activeId ? items.find((item) => item.id === activeId) : undefined)
      },
      (item) => Boolean(item?.id),
      15_000,
      `waiting for failure Session ${state}`
    )
    failureSessionIds.push(failureSession.id)
    await waitForValue(
      () => page.evaluate((id) => window.agentDesk.getTranscript(id), failureSession.id),
      (entries) => entries.some((entry) => entry.event?.kind === 'tool-result'),
      30_000,
      `waiting for search failure ${state}`
    )
    await page.click('.tool-card .tool-header')
    const failureNode = await page.waitForSelector(`.tool-search-result[data-search-result-status="${state}"]`, { visible: true, timeout: 15_000 })
    failureCardText[state] = await failureNode.evaluate((element) => element.textContent ?? '')
    renderedFailureStates.push(state)
  }
  await check('Assistant preserves all six explicit search failure states', async () => {
    await waitForValue(
      () => renderedFailureStates,
      (statuses) => failureStates.every((status) => statuses.includes(status)),
      45_000,
      'waiting for six search failure cards'
    )
    for (const status of failureStates) {
      const text = failureCardText[status]
      assert(text, `${status} result card missing`)
      assert(!text.includes('联网搜索完成'), `${status} was rendered as success`)
    }
  })

  await check('Search replay preserves one successful source fetch and canonical failure results', async () => {
    const resultCount = await page.evaluate(async ({ firstId, failureIds }) => {
      const ids = [firstId, ...failureIds]
      const transcripts = await Promise.all(ids.map((id) => window.agentDesk.getTranscript(id)))
      return transcripts.reduce((count, transcript) => count + transcript.filter((entry) => entry.event?.kind === 'tool-result' && entry.event?.toolUseId?.startsWith('search-call-')).length, 0)
    }, { firstId: session.id, failureIds: failureSessionIds })
    assert.equal(resultCount, 7, `expected 7 search tool results, got ${resultCount}`)
    assert.equal(searchRequests.filter((item) => item.query === 'search golden success').length, 1)
    // Successful searches require a continuation request; failure states may be
    // rendered as terminal tool results, so the fixture must not assume two
    // model calls for every scenario.
    assert(modelRequests.length >= 7, `model did not receive all seven search turns (${modelRequests.length})`)
  })

  const report = {
    schemaVersion: 1, runId, gate: 'test:assistant-search-golden', status: 'passed',
    requirement: 'UX-GOLDEN-001 / SEARCH-001', classification: 'local_targeted_not_release',
    checks, searchRequests, modelRequestCount: modelRequests.length,
    explicitlyNotVerified: ['five-user timed acceptance', 'clean release SHA binding', 'commercial search account parity']
  }
  writeReport(report)
  console.log(`assistant search golden e2e: passed (${checks.length}/${checks.length})`)
  console.log(path.join(reportDir, 'report.json'))
} catch (error) {
  writeReport({ schemaVersion: 1, runId, gate: 'test:assistant-search-golden', status: 'failed', checks, error: error instanceof Error ? error.message : String(error), tempRoot, electronStdout: electronStdout.slice(-8000), electronStderr: electronStderr.slice(-16000) })
  throw error
} finally {
  if (browser) browser.disconnect()
  if (electron) await terminateElectronTestProcess(electron)
  await close(server)
  if (process.env.CAOGEN_KEEP_ASSISTANT_SEARCH_FIXTURE !== '1') rmSync(tempRoot, { recursive: true, force: true })
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
  writeFileSync(path.join(repoRoot, 'test-results', 'assistant-search-golden', 'latest.json'), output)
}

function copyBuiltApp() {
  rmSync(isolatedOutDir, { recursive: true, force: true })
  mkdirSync(isolatedOutDir, { recursive: true })
  for (const directory of ['main', 'preload', 'renderer']) cpSync(path.join(sourceOutDir, directory), path.join(isolatedOutDir, directory), { recursive: true })
}

function parseJson(body) {
  try { return JSON.parse(body.toString('utf8')) } catch { return null }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function writeTextResponse(response, text) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`)
  response.write(`data: ${JSON.stringify({ type: 'response.completed', response: { id: `search-response-${Date.now()}`, output_text: text, usage: { input_tokens: 12, output_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}\n\n`)
  response.end('data: [DONE]\n\n')
}

function writeFunctionCallResponse(response, callId, name, args) {
  const item = { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  response.write(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item })}\n\n`)
  response.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\n`)
  response.write(`data: ${JSON.stringify({ type: 'response.completed', response: { id: `search-tool-response-${Date.now()}`, usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 0 } } } })}\n\n`)
  response.end('data: [DONE]\n\n')
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
  return waitForValue(async () => (await connectedBrowser.pages()).find((candidate) => candidate.url().startsWith('file:')), Boolean, timeoutMs, 'waiting for Electron renderer page')
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
    } catch { /* try next port */ }
  }
  throw new Error('no free Electron debug port')
}
