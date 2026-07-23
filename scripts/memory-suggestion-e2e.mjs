#!/usr/bin/env node
import http from 'node:http'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const outDir = path.join(repoRoot, 'test-results', 'memory-suggestion-e2e')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const runDir = path.join(outDir, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-memory-suggestion-e2e-'))
const userDataDir = path.join(tempRoot, 'userData')
const projectDir = path.join(tempRoot, 'project')
const electronBin =
  process.platform === 'win32'
    ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const sourceOutDir = path.join(repoRoot, 'out')
const sourceMainEntry = path.join(sourceOutDir, 'main', 'index.js')
const sourceRendererEntry = path.join(sourceOutDir, 'renderer', 'index.html')
const isolatedOutDir = path.join(runDir, 'app', 'out')
const mainEntry = path.join(isolatedOutDir, 'main', 'index.js')

if (!existsSync(electronBin)) fail('Electron binary not found. Run npm install first.')
if (!existsSync(sourceMainEntry)) fail('Built Electron main entry not found. Run npm run build first.')
if (!existsSync(sourceRendererEntry)) fail('Built Electron renderer entry not found. Run npm run build first.')

mkdirSync(runDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
mkdirSync(projectDir, { recursive: true })
writeFileSync(path.join(projectDir, 'README.md'), '# A5 memory suggestion e2e\n', 'utf8')
copyBuiltApp(isolatedOutDir)

const report = {
  runId,
  runDir,
  projectDir,
  userDataDir,
  checks: [],
  screenshots: [],
  warnings: [],
  requests: []
}

const triggerText = '请记住以后默认使用 pnpm.cmd 运行脚本'
const acceptText = '约定: 以后所有验证命令都先跑 npm.cmd run typecheck'

const mock = await startOpenAiMock()
writeMockUserData(mock.port)
const remotePort = await findFreePort(9880)
const app = spawn(electronBin, [`--remote-debugging-port=${remotePort}`, mainEntry], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CAOGEN_USER_DATA_DIR: userDataDir,
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: '',
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '',
    CLAUDE_CODE_HOST_CREDS_FILE: '',
    CLAUDE_CODE_HOST_AUTH_ENV_VAR: '',
    CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '',
    CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

let stdout = ''
let stderr = ''
app.stdout.on('data', (chunk) => {
  stdout += chunk.toString()
})
app.stderr.on('data', (chunk) => {
  stderr += chunk.toString()
})

let browser
let session
try {
  await waitForDebugPort(remotePort, 20_000)
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${remotePort}`, defaultViewport: null })
  const page = await waitForElectronPage(browser, 20_000)
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      report.warnings.push(`console ${msg.type()}: ${msg.text()}`)
    }
  })
  page.on('pageerror', (error) => report.warnings.push(`pageerror: ${error.message}`))

  await page.waitForSelector('.app', { timeout: 20_000 })
  await waitForAgentDesk(page)

  await check('create active mock session for memory suggestion flow', async () => {
    session = await page.evaluate((cwd) => {
      return window.agentDesk.createSession({
        cwd,
        engine: 'openai',
        providerId: 'mock-openai',
        model: 'mock-responses',
        isolated: false,
        title: 'A5 memory suggestion'
      })
    }, projectDir)
    assert(session?.id, 'session id missing')
  })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app', { timeout: 20_000 })
  await waitForAgentDesk(page)
  await page.waitForFunction(() => document.body.innerText.includes('A5 memory suggestion'), { timeout: 15_000 })
  await page.evaluate(() => {
    window.__memorySuggestionEvents = []
    window.agentDesk.onMemorySuggestion((event) => {
      window.__memorySuggestionEvents.push(event)
    })
  })

  await check('memory keyword message renders suggestion bar through real IPC', async () => {
    await sendMessage(page, session.id, triggerText)
    const bar = await waitForValue(
      () => readMemorySuggestionUi(page),
      (value) => value.visible && value.text.includes(triggerText),
      10_000,
      'waiting for memory suggestion bar'
    )
    const events = await readMemorySuggestionEvents(page)
    assert(events.length === 1, `expected one memory suggestion event, got ${events.length}`)
    assert(events[0].sessionId === session.id, 'memory suggestion session mismatch')
    report.firstSuggestion = { bar, events }
  })
  await screenshot(page, '01-memory-suggestion-bar')

  await check('same-session duplicate memory suggestion is throttled after dismiss', async () => {
    await page.click('[data-memory-suggestion-action="dismiss"]')
    await waitForValue(
      () => readMemorySuggestionUi(page),
      (value) => !value.visible,
      5_000,
      'waiting for dismissed memory suggestion bar'
    )
    const before = await readMemorySuggestionEvents(page)
    await sendMessage(page, session.id, triggerText)
    await sleep(900)
    const after = await readMemorySuggestionEvents(page)
    const ui = await readMemorySuggestionUi(page)
    assert(after.length === before.length, `duplicate text emitted another event: ${before.length} -> ${after.length}`)
    assert(!ui.visible, `duplicate text rendered suggestion again: ${JSON.stringify(ui)}`)
    report.duplicateThrottle = { before: before.length, after: after.length }
  })

  await check('accepting a distinct suggestion opens a prefilled form without duplicating or activating auto drafts', async () => {
    await sendMessage(page, session.id, acceptText)
    await waitForValue(
      () => readMemorySuggestionUi(page),
      (value) => value.visible && value.text.includes(acceptText),
      10_000,
      'waiting for second memory suggestion bar'
    )
    const beforeAccept = await waitForValue(
      () =>
        page.evaluate(async (sessionId) => {
          const data = await window.agentDesk.readProjectMemory(sessionId)
          return {
            draftBodies: data.drafts.map((draft) => draft.body),
            entries: data.entries.length
          }
        }, session.id),
      (value) =>
        value.entries === 0 &&
        value.draftBodies.includes(triggerText) &&
        value.draftBodies.includes(acceptText),
      10_000,
      'waiting for distinct auto-extracted Memory drafts'
    )
    await page.click('[data-memory-suggestion-action="accept"]')
    const panel = await waitForValue(
      () =>
        page.evaluate(async (sessionId) => {
          const data = await window.agentDesk.readProjectMemory(sessionId)
          const getValue = (selector) => document.querySelector(selector)?.value || ''
          return {
            panelVisible: Boolean(document.querySelector('[data-memory-panel="true"]')),
            formVisible: Boolean(document.querySelector('[data-memory-form="true"]')),
            kind: getValue('[data-memory-form-field="kind"]'),
            title: getValue('[data-memory-form-field="title"]'),
            body: getValue('[data-memory-form-field="body"]'),
            reason: getValue('[data-memory-form-field="reason"]'),
            drafts: data.drafts.length,
            entries: data.entries.length
          }
        }, session.id),
      (value) =>
        value.panelVisible &&
        value.formVisible &&
        value.body === acceptText &&
        value.drafts === beforeAccept.draftBodies.length &&
        value.entries === 0,
      10_000,
      'waiting for memory panel prefilled form without duplicate or active Memory'
    )
    assert(panel.kind === 'convention', `wrong prefilled memory kind: ${JSON.stringify(panel)}`)
    assert(beforeAccept.draftBodies.length === 2, `distinct suggestions should create exactly two drafts: ${JSON.stringify(beforeAccept)}`)
    assert(panel.drafts === beforeAccept.draftBodies.length, `accepting suggestion duplicated a draft: ${JSON.stringify(panel)}`)
    assert(panel.entries === 0, `accepting suggestion activated Memory without approval: ${JSON.stringify(panel)}`)
    report.acceptedSuggestion = panel
  })
  await screenshot(page, '02-memory-panel-prefill')
} catch (error) {
  report.error = error instanceof Error ? error.stack || error.message : String(error)
  if (!report.checks.some((item) => item.status === 'fail')) {
    report.checks.push({
      name: 'memory suggestion e2e runtime',
      status: 'fail',
      durationMs: 0,
      error: error instanceof Error ? error.message : String(error)
    })
  }
  process.exitCode = 1
} finally {
  if (browser) await browser.disconnect().catch(() => undefined)
  const exited = await terminate(app)
  await closeServer(mock.server)
  report.requests = mock.requests
  report.warnings.push(...summarizeProcessOutput(stdout, stderr, exited))
  writeFileSync(path.join(runDir, 'memory-suggestion-e2e.json'), JSON.stringify(report, null, 2))
  cleanupTempRoot(tempRoot)
}

const failed = report.checks.filter((item) => item.status === 'fail')
if (failed.length > 0) {
  console.error(`memory suggestion e2e failed: ${failed.map((item) => item.name).join(', ')}`)
  process.exitCode = 1
} else {
  console.log(`memory suggestion e2e ok: ${runDir}`)
}

async function check(name, fn) {
  const startedAt = Date.now()
  try {
    await fn()
    report.checks.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
  } catch (error) {
    report.checks.push({
      name,
      status: 'fail',
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}

async function sendMessage(page, sessionId, text) {
  await page.evaluate((id, body) => window.agentDesk.sendMessage(id, { text: body }), sessionId, text)
}

async function readMemorySuggestionUi(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-memory-suggestion-bar="true"]')
    return {
      visible: Boolean(bar),
      text: document.querySelector('[data-memory-suggestion-text]')?.textContent?.trim() || ''
    }
  })
}

async function readMemorySuggestionEvents(page) {
  return page.evaluate(() => (Array.isArray(window.__memorySuggestionEvents) ? window.__memorySuggestionEvents : []))
}

async function screenshot(page, name) {
  const file = path.join(runDir, `${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  report.screenshots.push(file)
}

async function startOpenAiMock() {
  const requests = []
  const server = http.createServer(async (req, res) => {
    if (req.url !== '/v1/responses' || req.method !== 'POST') {
      res.writeHead(404)
      res.end('not found')
      return
    }
    const body = await readJson(req)
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization || '', body })
    const reply = 'Mock A5 memory suggestion turn accepted.'
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    for (const piece of reply.match(/.{1,12}/g) || []) {
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: piece })}\n\n`)
      await sleep(15)
    }
    res.write(
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: `resp_memory_suggestion_${Date.now()}`,
          output_text: reply,
          usage: {
            input_tokens: 33,
            output_tokens: 9,
            input_tokens_details: { cached_tokens: 1 }
          }
        }
      })}\n\n`
    )
    res.write('data: [DONE]\n\n')
    res.end()
  })
  const port = await findFreePort(8880)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return { server, port, requests }
}

function writeMockUserData(port) {
  writeFileSync(
    path.join(userDataDir, 'providers.json'),
    JSON.stringify(
      [
        {
          id: 'mock-openai',
          name: 'CaoGen A5 Mock',
          baseUrl: `http://127.0.0.1:${port}`,
          encryptedToken: `b64:${Buffer.from('mock-key').toString('base64')}`,
          models: ['mock-responses'],
          openaiProtocol: 'responses',
          note: 'Local memory suggestion e2e provider; no real API key required.',
          createdAt: Date.now()
        }
      ],
      null,
      2
    )
  )
  writeFileSync(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify(
      {
        defaultModel: 'mock-responses',
        defaultPermissionMode: 'default',
        defaultProviderId: 'mock-openai',
        schedulerStrategy: 'balanced',
        budgetUsdPerSession: 0,
        failoverEnabled: true,
        language: 'zh',
        theme: 'dark',
        persona: '',
        allowedTools: '',
        disallowedTools: '',
        smartModelRoutingEnabled: false,
        modelCrossValidationAutoRunEnabled: false,
        autoSkillLearningEnabled: false,
        office: { showBadges: true, liveliness: 1, catEars: false }
      },
      null,
      2
    )
  )
}

async function waitForAgentDesk(page) {
  await page.waitForFunction(() => typeof window.agentDesk?.createSession === 'function', { timeout: 15_000 })
}

async function waitForElectronPage(browser, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const pages = await browser.pages()
    const page = pages.find((item) => !item.url().startsWith('devtools://'))
    if (page) return page
    await sleep(100)
  }
  throw new Error('Electron page target not found before timeout')
}

async function waitForValue(producer, predicate, timeout, label) {
  const startedAt = Date.now()
  let last
  while (Date.now() - startedAt < timeout) {
    last = await producer()
    if (predicate(last)) return last
    await sleep(250)
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`)
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

async function waitForDebugPort(port, timeoutMs) {
  const startedAt = Date.now()
  let lastError
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return
      lastError = new Error(`HTTP ${res.status}`)
    } catch (error) {
      lastError = error
    }
    await sleep(200)
  }
  throw new Error(`Timed out waiting for CDP port ${port}: ${lastError?.message || lastError}`)
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
    server.unref()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function terminate(child) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode }
  child.kill('SIGTERM')
  const result = await Promise.race([
    new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
    sleep(3000).then(() => {
      child.kill('SIGKILL')
      return { code: child.exitCode, signal: child.signalCode ?? 'SIGKILL' }
    })
  ])
  return result
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve))
}

function summarizeProcessOutput(out, err, exited) {
  const warnings = []
  const stderrText = err.trim()
  if (stderrText) warnings.push(`[stderr tail]\n${stderrText.slice(-2000)}`)
  if (out.trim()) warnings.push(`[stdout tail]\n${out.trim().slice(-1000)}`)
  if (exited.signal) warnings.push(`Electron exited by signal ${exited.signal}`)
  return warnings
}

function cleanupTempRoot(root) {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // best effort
  }
}

function copyBuiltApp(targetOutDir) {
  rmSync(targetOutDir, { recursive: true, force: true })
  mkdirSync(targetOutDir, { recursive: true })
  for (const dirName of ['main', 'preload', 'renderer']) {
    cpSync(path.join(sourceOutDir, dirName), path.join(targetOutDir, dirName), { recursive: true })
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
