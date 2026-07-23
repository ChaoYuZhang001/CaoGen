#!/usr/bin/env node
import http from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const packageJson = require(path.join(repoRoot, 'package.json'))
const electronPackage = require('electron/package.json')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const outputRoot = path.join(repoRoot, 'test-results', 'routing-zero-choice')
const runDir = path.join(outputRoot, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-routing-zero-choice-'))
const userDataDir = path.join(tempRoot, 'userData')
const projectDir = path.join(tempRoot, 'project')
const sourceOutDir = path.join(repoRoot, 'out')
const isolatedOutDir = path.join(runDir, 'app', 'out')
const mainEntry = path.join(isolatedOutDir, 'main', 'index.js')
const electronBin = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')

assert(existsSync(electronBin), 'Electron binary not found. Run npm install first.')
for (const entry of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
  assert(existsSync(path.join(sourceOutDir, entry)), `Built app entry missing: out/${entry}. Run npm run build first.`)
}

mkdirSync(runDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
mkdirSync(projectDir, { recursive: true })
writeFileSync(path.join(projectDir, 'README.md'), '# Routing zero-choice real Electron E2E\n', 'utf8')
copyBuiltApp()

const report = {
  schemaVersion: 1,
  runId,
  runDir,
  requirement: 'required',
  requirementIds: ['ROUTE-003', 'NFR-UX-001'],
  packageVersion: packageJson.version,
  gitCommit: '',
  worktreeClean: false,
  statusEntryCount: 0,
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  electronVersion: electronPackage.version,
  checks: [],
  screenshots: [],
  requests: [],
  warnings: []
}

const mock = await startResponsesMock()
const remotePort = await findFreePort(9940)
const electron = spawn(electronBin, [`--remote-debugging-port=${remotePort}`, mainEntry], {
  cwd: repoRoot,
  detached: process.platform !== 'win32',
  env: {
    ...process.env,
    CAOGEN_USER_DATA_DIR: userDataDir,
    CAOGEN_MEMORY_DIR: path.join(tempRoot, 'memory'),
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
const watchdog = setTimeout(() => {
  report.warnings.push('routing zero-choice E2E exceeded its 120 second total timeout')
  signalElectronTree(electron.pid, 'SIGKILL')
}, 120_000)

let stdout = ''
let stderr = ''
let browser
let page
let sessionId = ''
electron.stdout.on('data', (chunk) => { stdout += chunk.toString() })
electron.stderr.on('data', (chunk) => { stderr += chunk.toString() })

try {
  await waitForDebugPort(remotePort, 20_000)
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${remotePort}`, defaultViewport: null })
  page = await waitForElectronPage(browser, 20_000)
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      report.warnings.push(`console ${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => report.warnings.push(`pageerror: ${error.message}`))
  await page.setViewport({ width: 1320, height: 860, deviceScaleFactor: 1 })
  await waitForApp(page)

  const prompt = `zero choice assistant ${runId}`
  const expectedReply = `Zero-choice route completed: ${prompt}`

  await check('Assistant starts with no technical routing controls', async () => {
    await assertMode(page, 'assistant')
    await assertAssistantProjection(page)
    await setValue(page, '.welcome-project-path', projectDir)
    await setValue(page, '.welcome-composer-input', prompt)
    const computeState = await page.$eval('[data-assistant-compute-state]', (node) => ({
      available: node.getAttribute('data-compute-available'),
      text: node.textContent || ''
    }))
    assert(computeState.available === 'false', `unexpected initial compute state: ${JSON.stringify(computeState)}`)
  })

  await check('missing compute produces a non-technical recoverable state', async () => {
    await page.click('.welcome-send')
    await page.waitForSelector('[data-assistant-start-state="compute-unavailable"]', { visible: true, timeout: 5_000 })
    const notice = await page.$eval('[data-assistant-start-state]', (node) => node.innerText)
    assert(!/Provider|model|模型|API|Key|引擎/i.test(notice), `technical recovery text leaked: ${notice}`)
    const sessions = await page.evaluate(() => window.agentDesk.listSessions())
    assert(sessions.length === 0, `failed start created ${sessions.length} session(s)`)
    await screenshot(page, '01-assistant-compute-unavailable')
  })

  await check('retry discovers a real local Responses provider without UI choices', async () => {
    await page.evaluate(async ({ baseUrl }) => {
      await window.agentDesk.createProvider({
        name: 'Zero Choice Local Service',
        baseUrl,
        token: 'test-only',
        models: ['zero-choice-responses'],
        openaiProtocol: 'responses'
      })
    }, { baseUrl: mock.baseUrl })
    await page.click('[data-assistant-start-action="retry"]')
    await page.waitForFunction(() => document.querySelector('[data-assistant-compute-state]')?.getAttribute('data-compute-available') === 'true')
    await page.waitForSelector('[data-assistant-start-state]', { hidden: true, timeout: 5_000 })
    await assertAssistantProjection(page)
  })

  let stableSnapshot
  await check('Assistant zero-choice submit uses the real Router and streamed engine path', async () => {
    await page.click('.welcome-send')
    await page.waitForSelector('.composer-input', { visible: true, timeout: 20_000 })
    await waitForText(page, expectedReply, 20_000)
    const sessions = await page.evaluate(() => window.agentDesk.listSessions())
    assert(sessions.length === 1, `expected one session, got ${sessions.length}`)
    sessionId = sessions[0].id
    const transcript = await waitForValue(
      () => page.evaluate((id) => window.agentDesk.getTranscript(id), sessionId),
      (entries) => entries.some((entry) => entry.event?.kind === 'turn-result'),
      15_000,
      'waiting for completed zero-choice transcript'
    )
    assert(transcript.some((entry) => entry.event?.kind === 'routing'), 'canonical routing event missing')
    assert(mock.requests.length === 1, `expected one model request, got ${mock.requests.length}`)
    assert(mock.requests[0].body?.model === 'zero-choice-responses', `wrong routed model: ${JSON.stringify(mock.requests[0].body)}`)
    assert(JSON.stringify(mock.requests[0].body).includes(prompt), 'prompt missing from routed request')
    stableSnapshot = await readSessionSnapshot(page, sessionId)
    report.requests = mock.requests.map(({ authorization: _authorization, ...request }) => request)
    await assertAssistantProjection(page)
    await screenshot(page, '02-assistant-zero-choice-complete')
  })

  await check('Assistant command surfaces omit expert-only commands', async () => {
    await openCommandPalette(page)
    const text = await page.$eval('.command-palette', (node) => node.innerText)
    for (const forbidden of ['/model', '/terminal', '/plugins', '/subagents', '/diff', '/worktree']) {
      assert(!text.includes(forbidden), `Assistant palette exposed ${forbidden}`)
    }
    await page.keyboard.press('Escape')
    await page.waitForSelector('.command-palette-backdrop', { hidden: true, timeout: 5_000 })
  })

  await check('Studio expert tab supports arrow keys and reveals the same session controls', async () => {
    await page.click('.composer-input')
    await page.type('.composer-input', 'projection draft remains local')
    const before = await readSessionSnapshot(page, sessionId)
    await clickMode(page, 'studio')
    await page.waitForSelector('[data-studio-projection-tab="workspace"][aria-selected="true"]', { visible: true })
    await page.focus('[data-studio-projection-tab="workspace"]')
    await page.keyboard.press('ArrowRight')
    await page.waitForSelector('[data-studio-projection-tab="session"][aria-selected="true"]', { visible: true })
    await page.waitForSelector('#studio-projection-panel-session:not([hidden])', { visible: true })
    await waitForValue(
      () => page.evaluate(() => document.activeElement?.getAttribute('data-studio-projection-tab')),
      (focused) => focused === 'session',
      5_000,
      'ArrowRight did not move tab focus to session'
    )
    const draft = await page.$eval('.composer-input', (input) => input.value)
    assert(draft === 'projection draft remains local', `Composer draft changed in Studio: ${draft}`)
    await assertStudioExpertProjection(page)
    const after = await readSessionSnapshot(page, sessionId)
    assertSameSnapshot(before, after, 'Studio expert projection')
    assert(mock.requests.length === 1, 'mode switch resent the model request')
    await screenshot(page, '03-studio-expert-session')
  })

  await check('workspace roundtrip and Assistant return preserve DOM draft and canonical state', async () => {
    await page.focus('[data-studio-projection-tab="session"]')
    await page.keyboard.press('ArrowLeft')
    await page.waitForSelector('[data-studio-projection-tab="workspace"][aria-selected="true"]', { visible: true })
    await page.waitForSelector('#studio-projection-panel-workspace:not([hidden])', { visible: true })
    await waitForValue(
      () => page.evaluate(() => document.activeElement?.getAttribute('data-studio-projection-tab')),
      (focused) => focused === 'workspace',
      5_000,
      'ArrowLeft did not move tab focus to workspace'
    )
    await clickMode(page, 'assistant')
    await page.waitForSelector('.composer-input', { visible: true })
    const draft = await page.$eval('.composer-input', (input) => input.value)
    assert(draft === 'projection draft remains local', `Assistant draft changed after workspace roundtrip: ${draft}`)
    await assertAssistantProjection(page)
    const after = await readSessionSnapshot(page, sessionId)
    assertSameSnapshot(stableSnapshot, after, 'Assistant return')
    assert(mock.requests.length === 1, 'projection roundtrip created a new model request')
  })
} catch (error) {
  report.error = error instanceof Error ? error.stack || error.message : String(error)
  process.exitCode = 1
  if (page) await screenshot(page, 'failure').catch(() => undefined)
} finally {
  clearTimeout(watchdog)
  if (browser) await browser.disconnect().catch(() => undefined)
  const exited = await terminate(electron)
  await closeServer(mock.server)
  const git = readGitState()
  report.gitCommit = git.commit
  report.worktreeClean = git.worktreeClean
  report.statusEntryCount = git.statusEntryCount
  report.releaseBinding = {
    requirement: report.requirement,
    packageVersion: report.packageVersion,
    git,
    statusEntryCount: git.statusEntryCount,
    platform: report.platform,
    arch: report.arch,
    nodeVersion: report.nodeVersion,
    electronVersion: report.electronVersion
  }
  report.warnings.push(...summarizeProcessOutput(stdout, stderr, exited))
  report.status = report.checks.every((item) => item.status === 'pass') && !report.error ? 'pass' : 'fail'
  const reportText = JSON.stringify(report, null, 2)
  writeFileSync(path.join(runDir, 'report.json'), reportText)
  writeFileSync(path.join(outputRoot, 'latest.json'), reportText)
  cleanupTempRoot(tempRoot)
}

if (report.status !== 'pass') {
  console.error(`routing zero-choice E2E failed: ${report.error || 'check failure'}`)
  process.exitCode = 1
} else {
  console.log(`routing zero-choice E2E ok: ${runDir}`)
  console.log(`${report.checks.length}/${report.checks.length} checks passed; ${report.screenshots.length} screenshots captured`)
}

async function check(name, run) {
  const startedAt = Date.now()
  try {
    await run()
    report.checks.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
  } catch (error) {
    report.checks.push({ name, status: 'fail', durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

async function assertAssistantProjection(targetPage) {
  await assertMode(targetPage, 'assistant')
  const inventory = await targetPage.evaluate(() => {
    const visible = (node) => {
      const style = getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }
    return {
      text: document.body.innerText,
      visibleExpertControls: Array.from(document.querySelectorAll('[data-expert-control="true"], [data-expert-controls]')).filter(visible).length,
      railVisible: Array.from(document.querySelectorAll('.desk-rail')).some(visible)
    }
  })
  assert(inventory.visibleExpertControls === 0, `Assistant exposed ${inventory.visibleExpertControls} expert controls`)
  assert(!inventory.railVisible, 'Assistant exposed the expert workbench rail')
  for (const forbidden of ['Zero Choice Local Service', 'zero-choice-responses', '权限模式', 'MCP', 'Git', 'DAG', '终端']) {
    assert(!inventory.text.includes(forbidden), `Assistant visible text exposed ${forbidden}`)
  }
}

async function assertStudioExpertProjection(targetPage) {
  const inventory = await targetPage.evaluate(() => {
    const visible = (node) => {
      const style = getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }
    return {
      text: document.body.innerText,
      expertControls: Array.from(document.querySelectorAll('[data-expert-control="true"]')).filter(visible).length,
      railVisible: Array.from(document.querySelectorAll('.desk-rail')).some(visible)
    }
  })
  assert(inventory.expertControls >= 2, `Studio exposed only ${inventory.expertControls} expert controls`)
  assert(inventory.railVisible, 'Studio expert rail is not visible')
  assert(inventory.text.includes('Zero Choice Local Service'), 'Studio did not expose the routed service')
  assert(inventory.text.includes('zero-choice-responses'), 'Studio did not expose the effective model')
}

async function clickMode(targetPage, mode) {
  await targetPage.click(`[data-experience-mode-option="${mode}"]`)
  await assertMode(targetPage, mode)
}

async function assertMode(targetPage, expected) {
  await targetPage.waitForFunction((mode) => {
    const pressed = Array.from(document.querySelectorAll('[data-experience-mode-option]'))
      .filter((option) => option.getAttribute('aria-pressed') === 'true')
    const pane = document.querySelector('[data-experience-mode]')
    return pressed.length === 1 && pressed[0].getAttribute('data-experience-mode-option') === mode &&
      pane?.getAttribute('data-experience-mode') === mode && !pane.hidden
  }, { timeout: 10_000 }, expected)
}

async function readSessionSnapshot(targetPage, id) {
  return targetPage.evaluate(async (sessionIdValue) => {
    const sessions = await window.agentDesk.listSessions()
    const transcript = await window.agentDesk.getTranscript(sessionIdValue)
    return { count: sessions.length, ids: sessions.map((item) => item.id).sort(), transcript }
  }, id)
}

function assertSameSnapshot(before, after, label) {
  assert(after.count === before.count, `${label}: session count changed`)
  assert(JSON.stringify(after.ids) === JSON.stringify(before.ids), `${label}: session ids changed`)
  assert(JSON.stringify(after.transcript) === JSON.stringify(before.transcript), `${label}: transcript changed`)
}

async function setValue(targetPage, selector, value) {
  await targetPage.click(selector)
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await targetPage.keyboard.down(modifier)
  await targetPage.keyboard.press('a')
  await targetPage.keyboard.up(modifier)
  await targetPage.keyboard.type(value)
}

async function openCommandPalette(targetPage) {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await targetPage.keyboard.down(modifier)
  await targetPage.keyboard.press('k')
  await targetPage.keyboard.up(modifier)
  await targetPage.waitForSelector('.command-palette-backdrop', { visible: true, timeout: 5_000 })
}

async function waitForApp(targetPage) {
  await targetPage.waitForSelector('.app', { timeout: 20_000 })
  await targetPage.waitForFunction(() => typeof window.agentDesk?.createProvider === 'function', { timeout: 15_000 })
  await targetPage.waitForSelector('[data-experience-mode-switcher]', { visible: true, timeout: 15_000 })
  await targetPage.waitForSelector('.welcome-composer-input', { visible: true, timeout: 15_000 })
}

async function waitForText(targetPage, text, timeoutMs) {
  await targetPage.waitForFunction((needle) => document.body.innerText.includes(needle), { timeout: timeoutMs }, text)
}

async function startResponsesMock() {
  const requests = []
  const server = http.createServer(async (request, response) => {
    if (request.url !== '/v1/responses' || request.method !== 'POST') {
      response.writeHead(404).end('not found')
      return
    }
    const body = await readJson(request)
    const prompt = lastInputText(body)
    requests.push({ url: request.url, method: request.method, authorization: request.headers.authorization || '', body })
    const reply = `Zero-choice route completed: ${prompt}`
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: reply })}\n\n`)
    response.write(`data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: `resp_zero_choice_${Date.now()}`,
        output_text: reply,
        usage: { input_tokens: 14, output_tokens: 9, input_tokens_details: { cached_tokens: 0 } }
      }
    })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  const port = await findFreePort(8940)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return { server, requests, baseUrl: `http://127.0.0.1:${port}` }
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function lastInputText(body) {
  const input = Array.isArray(body?.input) ? body.input : []
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const content = Array.isArray(input[index]?.content) ? input[index].content : []
    const text = content.find((item) => item?.type === 'input_text')?.text
    if (typeof text === 'string' && text) return text
  }
  return ''
}

function copyBuiltApp() {
  rmSync(isolatedOutDir, { recursive: true, force: true })
  mkdirSync(isolatedOutDir, { recursive: true })
  for (const directory of ['main', 'preload', 'renderer']) {
    cpSync(path.join(sourceOutDir, directory), path.join(isolatedOutDir, directory), { recursive: true })
  }
}

async function screenshot(targetPage, name) {
  const file = path.join(runDir, `${name}.png`)
  await targetPage.screenshot({ path: file, fullPage: false })
  report.screenshots.push(file)
}

async function waitForElectronPage(connectedBrowser, timeoutMs) {
  return waitForValue(
    async () => (await connectedBrowser.pages()).find((candidate) => !candidate.url().startsWith('devtools://')),
    Boolean,
    timeoutMs,
    'waiting for Electron renderer page'
  )
}

async function waitForDebugPort(port, timeoutMs) {
  await waitForValue(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      return response.ok
    } catch {
      return false
    }
  }, Boolean, timeoutMs, `waiting for Electron debug port ${port}`)
}

async function waitForValue(producer, predicate, timeoutMs, label) {
  const startedAt = Date.now()
  let lastValue
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await producer()
    if (predicate(lastValue)) return lastValue
    await sleep(150)
  }
  throw new Error(`${label}: ${JSON.stringify(lastValue)}`)
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

async function terminate(child) {
  const exited = child.exitCode !== null
    ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
    : new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  signalElectronTree(child.pid, 'SIGTERM')
  const outcome = await Promise.race([
    exited,
    sleep(3000).then(() => ({ code: child.exitCode, signal: child.signalCode ?? 'SIGKILL' }))
  ])
  await sleep(250)
  if (electronTreeAlive(child.pid)) signalElectronTree(child.pid, 'SIGKILL')
  return outcome
}

function signalElectronTree(pid, signal) {
  if (!pid) return
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal)
  } catch {
    // The isolated Electron process group already exited.
  }
}

function electronTreeAlive(pid) {
  if (!pid) return false
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0)
    return true
  } catch {
    return false
  }
}

async function closeServer(server) {
  if (!server.listening) return
  await new Promise((resolve) => server.close(resolve))
}

function summarizeProcessOutput(out, err, exited) {
  const warnings = []
  if (err.trim()) warnings.push(`[stderr tail]\n${err.trim().slice(-2000)}`)
  if (out.trim()) warnings.push(`[stdout tail]\n${out.trim().slice(-1000)}`)
  if (exited.signal) warnings.push(`Electron exited by signal ${exited.signal}`)
  return warnings
}

function readGitState() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  return {
    commit,
    worktreeClean: status.length === 0,
    statusEntryCount: status ? status.split(/\r?\n/).length : 0
  }
}

function cleanupTempRoot(root) {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // Cleanup failure does not replace the E2E result.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
