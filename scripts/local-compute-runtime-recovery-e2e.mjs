#!/usr/bin/env node
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
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
const runDir = path.join(repoRoot, 'test-results', 'local-compute-runtime-recovery', runId)
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')
const runtimeFixture = path.join(repoRoot, 'scripts', 'local-compute-runtime-fixture.cjs')
const electronBin = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')

assert(existsSync(mainEntry), 'Built app missing. Run npm run build first.')
assert(existsSync(electronBin), 'Electron binary missing. Run npm install first.')
assert(existsSync(runtimeFixture), 'Local runtime fixture is missing.')
mkdirSync(runDir, { recursive: true })

const report = {
  schemaVersion: 1,
  runId,
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
  warnings: []
}

try {
  await runMissingRuntimeCase()
  await runStoppedRuntimeCase()
} catch (error) {
  report.error = error instanceof Error ? error.stack || error.message : String(error)
  process.exitCode = 1
} finally {
  const git = readGitState()
  report.gitCommit = git.commit
  report.worktreeClean = git.clean
  report.status = report.checks.every((item) => item.status === 'pass') && !report.error ? 'pass' : 'fail'
  writeFileSync(path.join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`local compute runtime recovery: ${report.status} (${report.checks.filter((item) => item.status === 'pass').length}/${report.checks.length})`)
  console.log(path.join(runDir, 'report.json'))
}

async function runMissingRuntimeCase() {
  const deadPort = await findFreePort(11240)
  await withElectronCase('missing-runtime', {
    CAOGEN_LOCAL_COMPUTE_TEST_BASE_URL: `http://127.0.0.1:${deadPort}`
  }, async (page) => {
    await check('missing runtime preserves the first-task draft and creates no state', async () => {
      const marker = 'Preserve this first task while local compute is unavailable'
      await page.type('.welcome-composer-input', marker)
      await page.keyboard.press('Enter')
      await page.waitForSelector('[data-local-compute-reason="runtime-missing"]', { visible: true, timeout: 12_000 })
      const state = await page.evaluate(async () => ({
        draft: document.querySelector('.welcome-composer-input')?.value ?? '',
        sessions: await window.agentDesk.listSessions(),
        providers: await window.agentDesk.listProviders(),
        helpHref: document.querySelector('[data-assistant-start-action="local-help"]')?.href ?? ''
      }))
      assert(state.draft === marker, `first-task draft changed: ${JSON.stringify(state.draft)}`)
      assert(state.sessions.length === 0, `missing runtime created ${state.sessions.length} Sessions`)
      assert(state.providers.length === 0, `missing runtime created ${state.providers.length} Providers`)
      assert(state.helpHref === 'https://ollama.com/download', `unexpected recovery href: ${state.helpHref}`)
      await page.setViewport({ width: 360, height: 520, deviceScaleFactor: 1 })
      await sleep(200)
      const overflow = await horizontalOverflow(page)
      assert(overflow === 0, `missing-runtime recovery has ${overflow}px horizontal overflow`)
      await capture(page, '01-missing-runtime-mobile')
    })
  })
}

async function runStoppedRuntimeCase() {
  const mock = await startControllableOllamaMock()
  try {
    await withElectronCase('stopped-runtime', {
      CAOGEN_LOCAL_COMPUTE_TEST_BASE_URL: mock.baseUrl,
      CAOGEN_LOCAL_COMPUTE_TEST_RUNTIME_EXECUTABLE: process.execPath,
      CAOGEN_LOCAL_COMPUTE_TEST_RUNTIME_SCRIPT: runtimeFixture,
      CAOGEN_LOCAL_COMPUTE_TEST_CONTROL_URL: mock.controlUrl
    }, async (page) => {
      await check('first task starts installed Ollama and resumes without duplicate state', async () => {
        const marker = 'Resume this exact first task after starting local compute'
        await page.type('.welcome-composer-input', marker)
        await page.keyboard.press('Enter')
        await page.waitForSelector('.composer-input', { visible: true, timeout: 20_000 })
        await page.waitForFunction(
          (text) => document.body.innerText.includes(`Local runtime completed: ${text}`),
          { timeout: 20_000 },
          marker
        )
        const state = await page.evaluate(async () => ({
          sessions: await window.agentDesk.listSessions(),
          providers: await window.agentDesk.listProviders()
        }))
        assert(mock.startCount === 1, `runtime start fixture ran ${mock.startCount} times`)
        assert(mock.requests.length === 1, `expected one model request, got ${mock.requests.length}`)
        assert(mock.requests[0].authorization === null, 'local request included Authorization')
        assert(mock.requests[0].model === 'qwen3-recovery', `unexpected model: ${mock.requests[0].model}`)
        assert(mock.requests[0].prompt === marker, 'first-task draft was not preserved into the model request')
        assert(state.sessions.length === 1, `expected one Session, got ${state.sessions.length}`)
        assert(state.providers.length === 1, `expected one Provider, got ${state.providers.length}`)
        assert(state.providers[0].authMode === 'none', `unexpected auth mode: ${state.providers[0].authMode}`)
        assert(state.providers[0].hasToken === false, 'local Provider persisted a fake API key')
        await capture(page, '02-runtime-autostart-complete')
      })
    })
  } finally {
    await closeServer(mock.server)
  }
}

async function withElectronCase(name, extraEnv, operation) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), `caogen-local-${name}-`))
  const userDataDir = path.join(tempRoot, 'userData')
  mkdirSync(userDataDir, { recursive: true })
  const remotePort = await findFreePort(name === 'missing-runtime' ? 10140 : 10340)
  const electron = spawnElectronTestProcess(electronBin, [`--remote-debugging-port=${remotePort}`, mainEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAOGEN_USER_DATA_DIR: userDataDir,
      CAOGEN_MEMORY_DIR: path.join(tempRoot, 'memory'),
      CAOGEN_LOCAL_COMPUTE_TEST_MODE: '1',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const watchdog = setTimeout(() => terminateElectronTestProcess(electron), 45_000)
  let browser
  try {
    electron.stderr.on('data', (chunk) => {
      const line = chunk.toString().trim()
      if (line) report.warnings.push(`${name}: ${line.split('\n').at(-1)}`)
    })
    await waitForDebugPort(remotePort, 20_000)
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${remotePort}`, defaultViewport: null })
    const page = await waitForElectronPage(browser, 20_000)
    page.on('pageerror', (error) => report.warnings.push(`${name} pageerror: ${error.message}`))
    await page.setViewport({ width: 1320, height: 860, deviceScaleFactor: 1 })
    await page.waitForSelector('.welcome-composer-input', { visible: true, timeout: 20_000 })
    await operation(page)
  } finally {
    clearTimeout(watchdog)
    if (browser) await browser.disconnect().catch(() => undefined)
    await terminateElectronTestProcess(electron)
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function startControllableOllamaMock() {
  const requests = []
  let enabled = false
  let startCount = 0
  const server = http.createServer(async (request, response) => {
    if (request.url === '/__start' && request.method === 'POST') {
      enabled = true
      startCount += 1
      response.writeHead(204).end()
      return
    }
    if (request.url === '/api/tags' && request.method === 'GET') {
      if (!enabled) {
        response.writeHead(503).end('runtime stopped')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ models: [{ name: 'qwen3-recovery' }] }))
      return
    }
    if (request.url === '/v1/chat/completions' && request.method === 'POST' && enabled) {
      const body = await readJson(request)
      const messages = Array.isArray(body?.messages) ? body.messages : []
      const prompt = [...messages].reverse().find((message) => message?.role === 'user')?.content ?? ''
      requests.push({
        authorization: request.headers.authorization ?? null,
        model: body?.model ?? null,
        prompt
      })
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `Local runtime completed: ${prompt}` } }] })}\n\n`)
      response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
      return
    }
    response.writeHead(404).end('not found')
  })
  const port = await findFreePort(11640)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${port}`,
    controlUrl: `http://127.0.0.1:${port}/__start`,
    get startCount() { return startCount }
  }
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

async function capture(page, name) {
  const file = path.join(runDir, `${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  report.screenshots.push(file)
}

async function horizontalOverflow(page) {
  return page.evaluate(() => Math.max(
    0,
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
    document.body.scrollWidth - document.body.clientWidth
  ))
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function waitForElectronPage(browser, timeoutMs) {
  return waitForValue(
    async () => (await browser.pages()).find((candidate) => !candidate.url().startsWith('devtools://')),
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
    await sleep(100)
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
