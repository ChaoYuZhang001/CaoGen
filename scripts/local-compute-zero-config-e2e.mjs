#!/usr/bin/env node
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'
import {
  spawnElectronTestProcess,
  terminateElectronTestProcess
} from './lib/electron-test-process.mjs'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const packageJson = require(path.join(repoRoot, 'package.json'))
const electronPackage = require('electron/package.json')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const runDir = path.join(repoRoot, 'test-results', 'local-compute-zero-config', runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-local-compute-'))
const userDataDir = path.join(tempRoot, 'userData')
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')
const electronBin = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')

assert(existsSync(mainEntry), 'Built app missing. Run npm run build first.')
assert(existsSync(electronBin), 'Electron binary missing. Run npm install first.')
mkdirSync(runDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })

const report = {
  schemaVersion: 1,
  runId,
  runDir,
  requirement: 'required',
  requirementIds: ['ROUTE-003', 'NFR-PRIV-004', 'NFR-UX-001'],
  packageVersion: packageJson.version,
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  electronVersion: electronPackage.version,
  gitCommit: '',
  worktreeClean: false,
  checks: [],
  screenshots: [],
  requests: [],
  warnings: []
}

const mock = await startOllamaMock()
const remotePort = await findFreePort(9960)
const electron = spawnElectronTestProcess(electronBin, [`--remote-debugging-port=${remotePort}`, mainEntry], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CAOGEN_USER_DATA_DIR: userDataDir,
    CAOGEN_MEMORY_DIR: path.join(tempRoot, 'memory'),
    CAOGEN_LOCAL_COMPUTE_TEST_MODE: '1',
    CAOGEN_LOCAL_COMPUTE_TEST_BASE_URL: mock.baseUrl,
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
const watchdog = setTimeout(() => terminateElectronTestProcess(electron), 90_000)
let browser
let page
let stderr = ''
electron.stderr.on('data', (chunk) => { stderr += chunk.toString() })

try {
  await waitForDebugPort(remotePort, 20_000)
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${remotePort}`, defaultViewport: null })
  page = await waitForElectronPage(browser, 20_000)
  page.on('pageerror', (error) => report.warnings.push(`pageerror: ${error.message}`))
  await page.setViewport({ width: 1320, height: 860, deviceScaleFactor: 1 })
  await page.waitForSelector('.welcome-composer-input', { visible: true, timeout: 20_000 })

  await check('first launch automatically activates local compute without a key', async () => {
    await page.waitForSelector('[data-compute-status="ready"]', { visible: true, timeout: 10_000 })
    const providers = await page.evaluate(() => window.agentDesk.listProviders())
    assert(providers.length === 1, `expected one local provider, got ${providers.length}`)
    const provider = providers[0]
    assert(provider.name.includes('Ollama'), `unexpected provider name: ${provider.name}`)
    assert(provider.authMode === 'none', `unexpected auth mode: ${provider.authMode}`)
    assert(provider.ready === true, 'local provider is not ready')
    assert(provider.hasToken === false, 'local provider persisted a fake API key')
    assert(provider.credentialStorage === 'none', `unexpected credential storage: ${provider.credentialStorage}`)
    assert(JSON.stringify(provider.models) === JSON.stringify(['qwen3-local']), `unexpected models: ${JSON.stringify(provider.models)}`)
    const presets = await page.$$eval('[data-welcome-preset]', (nodes) => nodes.map((node) => ({
      id: node.getAttribute('data-welcome-preset'),
      strategy: node.getAttribute('data-preset-strategy'),
      label: node.textContent?.trim() ?? ''
    })))
    assert(JSON.stringify(presets.map(({ id, strategy }) => ({ id, strategy }))) === JSON.stringify([
      { id: 'understand', strategy: 'view' },
      { id: 'review', strategy: 'view' },
      { id: 'report', strategy: 'execute' },
      { id: 'plan', strategy: 'plan' }
    ]), `unexpected welcome presets: ${JSON.stringify(presets)}`)
    assert(presets.every((preset) => preset.label.length > 0), `preset label missing: ${JSON.stringify(presets)}`)
    report.presets = presets
    await screenshot('01-local-compute-ready')
  })

  await check('activation is idempotent and unauthenticated remote targets fail closed', async () => {
    const result = await page.evaluate(async () => {
      const second = await window.agentDesk.activateLocalCompute()
      let remoteError = ''
      try {
        await window.agentDesk.createProvider({
          name: 'Rejected remote no-auth service',
          baseUrl: 'https://example.com',
          models: ['should-not-exist'],
          engine: 'openai',
          openaiProtocol: 'chat',
          authMode: 'none'
        })
      } catch (error) {
        remoteError = error instanceof Error ? error.message : String(error)
      }
      return { second, providers: await window.agentDesk.listProviders(), remoteError }
    })
    assert(result.second.status === 'activated', `second activation failed: ${JSON.stringify(result.second)}`)
    assert(result.providers.length === 1, `idempotent activation created ${result.providers.length} providers`)
    assert(/本机回环地址/.test(result.remoteError), `remote no-auth rejection missing: ${result.remoteError}`)
  })

  await check('double-click and running reload keep one first-task Session and request', async () => {
    mock.holdNextCompletion()
    const presetBox = await page.$eval('[data-welcome-preset="report"]', (node) => {
      const rect = node.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })
    await page.mouse.click(presetBox.x, presetBox.y)
    await page.mouse.click(presetBox.x, presetBox.y)
    await waitForValue(
      () => mock.requests.length,
      (count) => count === 1,
      10_000,
      'waiting for one report preset request'
    )
    await page.waitForSelector('[data-first-task-status="running"]', { visible: true, timeout: 10_000 })
    const started = await readFirstTaskState()
    assert(started.sessions.length === 1, `double-click created ${started.sessions.length} sessions`)
    assert(started.record?.candidateSessionId === started.sessions[0]?.id,
      `onboarding candidate does not match the started Session: ${JSON.stringify(started)}`)

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.composer-input', { visible: true, timeout: 20_000 })
    const reloaded = await readFirstTaskState()
    assert(reloaded.sessions.length === 1, `reload changed Session count: ${reloaded.sessions.length}`)
    assert(reloaded.sessions[0]?.id === started.sessions[0]?.id,
      `reload changed Session identity: ${JSON.stringify({ started, reloaded })}`)
    assert(reloaded.record?.candidateSessionId === started.record?.candidateSessionId,
      `reload changed onboarding candidate: ${JSON.stringify({ started, reloaded })}`)
    assert(mock.requests.length === 1, `reload resent the first task: ${mock.requests.length} requests`)

    mock.releaseNextCompletion()
    await waitForText('Local task completed:', 20_000)
    const sessions = await page.evaluate(() => window.agentDesk.listSessions())
    assert(sessions.length === 1, `expected one session, got ${sessions.length}`)
    assert(sessions[0].unassigned === true, 'zero-config session unexpectedly requires a Project')
    assert(sessions[0].cwd.endsWith('/personal-workspace'), `unexpected managed workspace: ${sessions[0].cwd}`)
    assert(sessions[0].taskStrategy === 'execute', `report preset strategy mismatch: ${sessions[0].taskStrategy}`)
    assert(sessions[0].title === '整理文件成报告', `report preset title mismatch: ${sessions[0].title}`)
  })

  await check('local model request omits Authorization and uses the discovered model', async () => {
    assert(mock.requests.length === 1, `expected one model request, got ${mock.requests.length}`)
    const request = mock.requests[0]
    assert(request.authorization === null, `Authorization header leaked: ${request.authorization}`)
    assert(request.body?.model === 'qwen3-local', `unexpected model: ${JSON.stringify(request.body?.model)}`)
    const bodyText = JSON.stringify(request.body)
    assert(bodyText.includes('CaoGen-report.md'), 'report preset prompt missing output contract')
    assert(bodyText.includes('保留原文件不变'), 'report preset prompt missing source preservation contract')
    report.requests = mock.requests
  })

  await check('consecutive Enter starts exactly one additional Session and request', async () => {
    await page.click('.sidebar-new')
    await page.waitForSelector('.welcome-composer-input', { visible: true, timeout: 10_000 })
    const before = await page.evaluate(() => window.agentDesk.listSessions())
    const requestCountBefore = mock.requests.length
    mock.holdNextCompletion()
    await page.type('.welcome-composer-input', 'Enter submission marker')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await waitForValue(
      () => mock.requests.length,
      (count) => count === requestCountBefore + 1,
      10_000,
      'waiting for one Enter submission request'
    )
    await page.waitForSelector('.composer-input', { visible: true, timeout: 20_000 })
    const during = await page.evaluate(() => window.agentDesk.listSessions())
    assert(during.length === before.length + 1,
      `consecutive Enter created ${during.length - before.length} sessions`)
    assert(mock.requests.length === requestCountBefore + 1,
      `consecutive Enter created ${mock.requests.length - requestCountBefore} requests`)
    const enterRequest = mock.requests.at(-1)
    assert(enterRequest?.authorization === null, `Enter request leaked Authorization: ${enterRequest?.authorization}`)
    assert(enterRequest?.body?.model === 'qwen3-local',
      `Enter request used unexpected model: ${JSON.stringify(enterRequest?.body?.model)}`)
    mock.releaseNextCompletion()
    await waitForText('Local task completed: Enter submission marker', 20_000)
  })

  await check('desktop task and 360px welcome presets have no overflow', async () => {
    await screenshot('02-local-task-complete')
    await page.setViewport({ width: 360, height: 520, deviceScaleFactor: 1 })
    await sleep(250)
    const chatOverflow = await page.evaluate(() => Math.max(
      0,
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      document.body.scrollWidth - document.body.clientWidth
    ))
    assert(chatOverflow === 0, `360px chat horizontal overflow is ${chatOverflow}px`)
    await screenshot('03-local-task-mobile')
    await page.setViewport({ width: 1320, height: 860, deviceScaleFactor: 1 })
    await page.click('.sidebar-new')
    await page.waitForSelector('[data-welcome-preset="report"]', { visible: true, timeout: 10_000 })
    await page.setViewport({ width: 360, height: 520, deviceScaleFactor: 1 })
    await sleep(250)
    const welcomeLayout = await page.evaluate(() => {
      const dock = document.querySelector('.welcome-compose-dock')?.getBoundingClientRect()
      const presets = [...document.querySelectorAll('[data-welcome-preset]')]
        .map((node) => node.getBoundingClientRect())
      return {
        overflow: Math.max(
          0,
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
          document.body.scrollWidth - document.body.clientWidth
        ),
        presetCount: presets.length,
        allPresetWidths: presets.map((rect) => Math.round(rect.width)),
        dockBottom: dock ? Math.round(dock.bottom) : null,
        viewportHeight: window.innerHeight
      }
    })
    assert(welcomeLayout.overflow === 0, `360px welcome horizontal overflow is ${welcomeLayout.overflow}px`)
    assert(welcomeLayout.presetCount === 4, `expected four mobile presets: ${JSON.stringify(welcomeLayout)}`)
    assert(welcomeLayout.allPresetWidths.every((width) => width > 0), `hidden mobile preset: ${JSON.stringify(welcomeLayout)}`)
    assert(welcomeLayout.dockBottom !== null && welcomeLayout.dockBottom <= welcomeLayout.viewportHeight, `mobile composer is clipped: ${JSON.stringify(welcomeLayout)}`)
    report.mobileWelcomeLayout = welcomeLayout
    await screenshot('04-welcome-presets-mobile')
  })
} catch (error) {
  report.error = error instanceof Error ? error.stack || error.message : String(error)
  process.exitCode = 1
  if (page) await screenshot('failure').catch(() => undefined)
} finally {
  clearTimeout(watchdog)
  mock.releaseAll()
  if (browser) await browser.disconnect().catch(() => undefined)
  await terminateElectronTestProcess(electron)
  await closeServer(mock.server)
  const git = readGitState()
  report.gitCommit = git.commit
  report.worktreeClean = git.clean
  report.status = report.checks.every((item) => item.status === 'pass') && !report.error ? 'pass' : 'fail'
  if (stderr.trim()) report.warnings.push(stderr.trim().split('\n').slice(-4).join('\n'))
  writeFileSync(path.join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  rmSync(tempRoot, { recursive: true, force: true })
  console.log(`local compute zero-config: ${report.status} (${report.checks.filter((item) => item.status === 'pass').length}/${report.checks.length})`)
  console.log(path.join(runDir, 'report.json'))
}

async function check(name, operation) {
  const startedAt = Date.now()
  try {
    await operation()
    report.checks.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
  } catch (error) {
    report.checks.push({ name, status: 'fail', durationMs: Date.now() - startedAt, error: String(error) })
    throw error
  }
}

async function startOllamaMock() {
  const requests = []
  const completionGates = []
  let nextCompletionGate = null
  const server = http.createServer(async (request, response) => {
    if (request.url === '/api/tags' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ models: [{ name: 'qwen3-local' }] }))
      return
    }
    if (request.url === '/v1/chat/completions' && request.method === 'POST') {
      const body = await readJson(request)
      const messages = Array.isArray(body?.messages) ? body.messages : []
      const prompt = [...messages].reverse().find((message) => message?.role === 'user')?.content ?? ''
      const completionGate = nextCompletionGate
      nextCompletionGate = null
      requests.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.authorization ?? null,
        body
      })
      if (completionGate) await completionGate.promise
      const content = `Local task completed: ${prompt}`
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\n`)
      response.end('data: [DONE]\n\n')
      return
    }
    response.writeHead(404).end('not found')
  })
  const port = await findFreePort(8980)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${port}`,
    holdNextCompletion() {
      assert(nextCompletionGate === null, 'a completion is already held')
      let release
      const gate = {
        promise: new Promise((resolve) => { release = resolve }),
        release: () => release(),
        released: false
      }
      nextCompletionGate = gate
      completionGates.push(gate)
    },
    releaseNextCompletion() {
      const gate = completionGates.find((candidate) => !candidate.released)
      assert(gate, 'no held completion to release')
      gate.released = true
      gate.release()
    },
    releaseAll() {
      for (const gate of completionGates) {
        if (gate.released) continue
        gate.released = true
        gate.release()
      }
    }
  }
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function screenshot(name) {
  const file = path.join(runDir, `${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  report.screenshots.push(file)
}

async function waitForText(text, timeoutMs) {
  await page.waitForFunction((needle) => document.body.innerText.includes(needle), { timeout: timeoutMs }, text)
}

async function readFirstTaskState() {
  return page.evaluate(async () => ({
    sessions: await window.agentDesk.listSessions(),
    record: JSON.parse(window.localStorage.getItem('caogen.first-task-onboarding.v1') ?? 'null')
  }))
}

async function waitForElectronPage(connectedBrowser, timeoutMs) {
  return waitForValue(
    async () => (await connectedBrowser.pages()).find((candidate) => !candidate.url().startsWith('devtools://')),
    Boolean,
    timeoutMs,
    'waiting for Electron page'
  )
}

async function waitForDebugPort(port, timeoutMs) {
  await waitForValue(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok
    } catch {
      return false
    }
  }, Boolean, timeoutMs, 'waiting for Electron debug port')
}

async function waitForValue(producer, predicate, timeoutMs, label) {
  const startedAt = Date.now()
  let last
  while (Date.now() - startedAt < timeoutMs) {
    last = await producer()
    if (predicate(last)) return last
    await sleep(120)
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`)
}

async function findFreePort(start) {
  for (let port = start; port < start + 200; port += 1) {
    if (await canListen(port)) return port
  }
  throw new Error(`no free port from ${start}`)
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve))
}

function readGitState() {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const status = execFileSync('git', ['status', '--porcelain=v1'], { encoding: 'utf8' }).trim()
    return { commit, clean: status.length === 0 }
  } catch {
    return { commit: 'unknown', clean: false }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
