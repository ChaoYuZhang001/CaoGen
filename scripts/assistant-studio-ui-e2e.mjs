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
const outputRoot = path.join(repoRoot, 'test-results', 'assistant-studio-ui')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const runDir = path.join(outputRoot, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-assistant-studio-ui-'))
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
writeFileSync(path.join(projectDir, 'README.md'), '# Assistant Studio UI required E2E\n', 'utf8')
copyBuiltApp()

const report = {
  schemaVersion: 2,
  runId,
  runDir,
  requirement: 'required',
  packageVersion: packageJson.version,
  gitCommit: '',
  worktreeClean: false,
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  electronVersion: electronPackage.version,
  checks: [],
  screenshots: [],
  viewports: [],
  warnings: [],
  coverage: {
    verified: [
      'pointer and keyboard Assistant/Studio switching',
      'unique aria-pressed state',
      'session identity/count/transcript immutability while switching',
      'Welcome and Composer draft retention',
      'new-session/search/Office navigation mode retention',
      'responsive horizontal-overflow and basic overlay stacking'
    ],
    explicitlyNotVerified: [
      'assistant-studio-consistency',
      'assistant-studio-live-switch'
    ]
  }
}

const mock = await startOpenAiMock()
const remotePort = await findFreePort(9920)
const electron = spawn(electronBin, [`--remote-debugging-port=${remotePort}`, mainEntry], {
  cwd: repoRoot,
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

let stdout = ''
let stderr = ''
let browser
let page
let session
electron.stdout.on('data', (chunk) => { stdout += chunk.toString() })
electron.stderr.on('data', (chunk) => { stderr += chunk.toString() })

try {
  await waitForDebugPort(remotePort, 20_000)
  browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${remotePort}`,
    defaultViewport: null
  })
  page = await waitForElectronPage(browser, 20_000)
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      report.warnings.push(`console ${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => report.warnings.push(`pageerror: ${error.message}`))
  await waitForApp(page)
  await page.setViewport({ width: 1320, height: 860, deviceScaleFactor: 1 })

  await check('pointer switching is bidirectional with one pressed option', async () => {
    await assertMode(page, 'assistant')
    await page.click('.welcome-composer-input')
    await page.type('.welcome-composer-input', 'welcome draft survives projection changes')
    await clickMode(page, 'studio')
    await clickMode(page, 'assistant')
    const value = await page.$eval('.welcome-composer-input', (input) => input.value)
    assert(value === 'welcome draft survives projection changes', `Welcome draft changed: ${value}`)
  })

  await check('Space and Enter switch modes without losing focus or Welcome draft', async () => {
    await focusMode(page, 'studio')
    await page.keyboard.press('Space')
    await assertMode(page, 'studio', 'studio')
    await focusMode(page, 'assistant')
    await page.keyboard.press('Enter')
    await assertMode(page, 'assistant', 'assistant')
    const value = await page.$eval('.welcome-composer-input', (input) => input.value)
    assert(value === 'welcome draft survives projection changes', `Welcome draft changed after keyboard use: ${value}`)
  })

  await check('seed one real session with a completed transcript', async () => {
    session = await page.evaluate(async ({ cwd, baseUrl }) => {
      const provider = await window.agentDesk.createProvider({
        name: 'Assistant Studio UI Mock',
        baseUrl,
        token: 'test-only',
        models: ['mock-responses'],
        openaiProtocol: 'responses'
      })
      return window.agentDesk.createSession({
        cwd,
        engine: 'openai',
        providerId: provider.id,
        model: 'mock-responses',
        isolated: false,
        title: 'Assistant Studio UI session'
      })
    }, { cwd: projectDir, baseUrl: mock.baseUrl })
    assert(session?.id, 'session id missing')
    await waitForValue(
      () => page.evaluate((id) => window.agentDesk.listSessions().then((items) => items.find((item) => item.id === id)), session.id),
      (meta) => Boolean(meta?.sdkSessionId),
      12_000,
      'waiting for session initialization'
    )
    await page.evaluate((id) => window.agentDesk.sendMessage(id, { text: 'stable transcript marker' }), session.id)
    const transcript = await waitForValue(
      () => page.evaluate((id) => window.agentDesk.getTranscript(id), session.id),
      (entries) => entries.some((entry) => entry.event?.kind === 'turn-result'),
      15_000,
      'waiting for completed transcript'
    )
    assert(transcript.some((entry) => entry.event?.kind === 'user-message'), 'user message missing from transcript')
    assert(transcript.length >= 3, `transcript too weak for immutability check: ${transcript.length}`)
  })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForApp(page)
  await page.waitForSelector('.composer-input', { visible: true, timeout: 15_000 })

  let stableSnapshot
  await check('switching preserves session id, count, and transcript bytes', async () => {
    stableSnapshot = await readSessionSnapshot(page, session.id)
    assert(stableSnapshot.count === 1, `expected one session, got ${stableSnapshot.count}`)
    assert(stableSnapshot.ids[0] === session.id, `active session identity mismatch: ${stableSnapshot.ids.join(',')}`)
    await clickMode(page, 'studio')
    await clickMode(page, 'assistant')
    const after = await readSessionSnapshot(page, session.id)
    assertSameSnapshot(stableSnapshot, after, 'pointer projection switch')
  })

  await check('new-session, search, and Office roundtrip retain Studio mode', async () => {
    await clickMode(page, 'studio')
    await page.click('.sidebar-new')
    await assertMode(page, 'studio')
    await focusSidebarSearch(page)
    await assertMode(page, 'studio')
    await page.type('.sidebar-search', 'stable transcript')
    await clearFocusedInput(page)
    await page.waitForSelector('.session-card.active', { visible: true, timeout: 5_000 })
    await page.click('.sidebar-office')
    await page.waitForSelector('.office', { visible: true, timeout: 20_000 })
    assert(await page.$('[data-experience-mode-switcher]') === null, 'mode switcher should not cover Office')
    await page.click('.office-actions .btn-primary')
    await page.waitForSelector('[data-experience-mode-switcher]', { visible: true, timeout: 15_000 })
    await assertMode(page, 'studio')
    await page.click('.session-card.active')
    await assertMode(page, 'studio')
    const after = await readSessionSnapshot(page, session.id)
    assertSameSnapshot(stableSnapshot, after, 'navigation roundtrip')
  })

  await check('Composer draft survives Assistant/Studio projection changes', async () => {
    await clickMode(page, 'assistant')
    await page.waitForSelector('.composer-input', { visible: true, timeout: 30_000 })
    await page.click('.composer-input')
    await page.type('.composer-input', 'composer draft stays local')
    const before = await readSessionSnapshot(page, session.id)
    await clickMode(page, 'studio')
    await clickMode(page, 'assistant')
    const value = await page.$eval('.composer-input', (input) => input.value)
    assert(value === 'composer draft stays local', `Composer draft changed: ${value}`)
    const after = await readSessionSnapshot(page, session.id)
    assertSameSnapshot(before, after, 'Composer draft projection switch')
  })

  await check('command palette backdrop stays above the mode switcher', async () => {
    await page.setViewport({ width: 1320, height: 860, deviceScaleFactor: 1 })
    await openCommandPalette(page)
    const stacking = await readOverlayStacking(page, '.command-palette-backdrop')
    assert(stacking.overlayZ > stacking.switcherZ, `palette z-index ${stacking.overlayZ} <= switcher ${stacking.switcherZ}`)
    assert(stacking.overlayOwnsSwitcherPoint, `switcher painted above palette: ${JSON.stringify(stacking)}`)
    await page.keyboard.press('Escape')
    await page.waitForSelector('.command-palette-backdrop', { hidden: true, timeout: 5_000 })
  })

  await check('responsive Assistant and Studio panes do not overflow horizontally', async () => {
    for (const viewport of [
      { width: 1320, height: 860 },
      { width: 760, height: 700 },
      { width: 360, height: 520 }
    ]) {
      await page.setViewport({ ...viewport, deviceScaleFactor: 1 })
      await sleep(250)
      for (const mode of ['assistant', 'studio']) {
        await clickMode(page, mode)
        await sleep(50)
        const measurement = await readOverflow(page, mode)
        report.viewports.push(measurement)
        assert(measurement.documentOverflow <= 1, `${mode} ${viewport.width}: document overflow ${measurement.documentOverflow}px`)
        assert(measurement.appOverflow <= 1, `${mode} ${viewport.width}: app overflow ${measurement.appOverflow}px`)
        assert(measurement.mainOverflow <= 1, `${mode} ${viewport.width}: main overflow ${measurement.mainOverflow}px`)
        assert(measurement.switcherInsideViewport, `${mode} ${viewport.width}: mode switcher outside viewport`)
        assert(measurement.visibleOffenders.length === 0, `${mode} ${viewport.width}: ${JSON.stringify(measurement.visibleOffenders)}`)
        await captureScreenshot(page, `${viewport.width}x${viewport.height}-${mode}`)
      }
    }
  })

  await check('mobile sidebar and backdrop stay above the mode switcher', async () => {
    await page.setViewport({ width: 360, height: 520, deviceScaleFactor: 1 })
    await page.click('.mobile-sidebar-toggle')
    await page.waitForSelector('.sidebar-mobile-open', { visible: true, timeout: 5_000 })
    const stacking = await readMobileSidebarStacking(page)
    assert(stacking.sidebarZ > stacking.switcherZ, `sidebar z-index ${stacking.sidebarZ} <= switcher ${stacking.switcherZ}`)
    assert(stacking.backdropZ > stacking.switcherZ, `sidebar backdrop ${stacking.backdropZ} <= switcher ${stacking.switcherZ}`)
    assert(stacking.overlayOwnsSwitcherPoint, `switcher painted above mobile overlay: ${JSON.stringify(stacking)}`)
    await page.mouse.click(350, 260)
    await page.waitForSelector('.mobile-sidebar-backdrop', { hidden: true, timeout: 5_000 })
  })
} catch (error) {
  report.error = error instanceof Error ? error.stack || error.message : String(error)
  process.exitCode = 1
  if (page) await captureScreenshot(page, 'failure').catch(() => undefined)
} finally {
  if (browser) await browser.disconnect().catch(() => undefined)
  const exited = await terminate(electron)
  await closeServer(mock.server)
  const git = readGitState()
  report.gitCommit = git.commit
  report.worktreeClean = git.worktreeClean
  report.releaseBinding = {
    requirement: report.requirement,
    packageVersion: report.packageVersion,
    git,
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
  console.error(`assistant/studio required UI E2E failed: ${report.error || 'check failure'}`)
  process.exitCode = 1
} else {
  console.log(`assistant/studio required UI E2E ok: ${runDir}`)
  console.log(`${report.checks.length}/${report.checks.length} checks passed; ${report.screenshots.length} screenshots captured`)
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

async function clickMode(targetPage, mode) {
  await targetPage.click(`[data-experience-mode-option="${mode}"]`)
  await assertMode(targetPage, mode)
}

async function focusMode(targetPage, mode) {
  await targetPage.focus(`[data-experience-mode-option="${mode}"]`)
  const focused = await targetPage.evaluate(() => document.activeElement?.getAttribute('data-experience-mode-option'))
  assert(focused === mode, `could not focus ${mode} option; focused=${focused}`)
}

async function assertMode(targetPage, expected, expectedFocus) {
  const state = await waitForValue(
    () => targetPage.evaluate(() => {
      const options = Array.from(document.querySelectorAll('[data-experience-mode-option]'))
      const pressed = options.filter((option) => option.getAttribute('aria-pressed') === 'true')
      const visiblePanes = Array.from(document.querySelectorAll('[data-experience-mode]'))
        .filter((pane) => !pane.hidden && getComputedStyle(pane).display !== 'none')
        .map((pane) => pane.getAttribute('data-experience-mode'))
      return {
        pressed: pressed.map((option) => option.getAttribute('data-experience-mode-option')),
        visiblePanes,
        focused: document.activeElement?.getAttribute('data-experience-mode-option') || null,
        studioReady: Boolean(document.querySelector('[data-studio-view]'))
      }
    }),
    (value) => value.pressed.length === 1 && value.pressed[0] === expected &&
      value.visiblePanes.length === 1 && value.visiblePanes[0] === expected &&
      (expected !== 'studio' || value.studioReady),
    30_000,
    `waiting for ${expected} mode`
  )
  if (expectedFocus) assert(state.focused === expectedFocus, `mode focus moved to ${state.focused}`)
  return state
}

async function readSessionSnapshot(targetPage, sessionId) {
  return targetPage.evaluate(async (id) => {
    const sessions = await window.agentDesk.listSessions()
    const transcript = await window.agentDesk.getTranscript(id)
    return {
      count: sessions.length,
      ids: sessions.map((item) => item.id).sort(),
      transcript
    }
  }, sessionId)
}

function assertSameSnapshot(before, after, label) {
  assert(after.count === before.count, `${label}: session count ${before.count} -> ${after.count}`)
  assert(JSON.stringify(after.ids) === JSON.stringify(before.ids), `${label}: session ids changed`)
  assert(JSON.stringify(after.transcript) === JSON.stringify(before.transcript), `${label}: transcript changed`)
}

async function focusSidebarSearch(targetPage) {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await targetPage.keyboard.down(modifier)
  await targetPage.keyboard.press('f')
  await targetPage.keyboard.up(modifier)
  await waitForValue(
    () => targetPage.evaluate(() => document.activeElement?.classList.contains('sidebar-search') === true),
    Boolean,
    5_000,
    'waiting for sidebar search focus'
  )
}

async function clearFocusedInput(targetPage) {
  await targetPage.$eval('.sidebar-search', (input) => {
    input.focus()
    input.select()
  })
  await targetPage.keyboard.press('Backspace')
  await waitForValue(
    () => targetPage.$eval('.sidebar-search', (input) => input.value),
    (value) => value === '',
    5_000,
    'waiting for sidebar search to clear'
  )
}

async function openCommandPalette(targetPage) {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await targetPage.keyboard.down(modifier)
  await targetPage.keyboard.press('k')
  await targetPage.keyboard.up(modifier)
  await targetPage.waitForSelector('.command-palette-backdrop', { visible: true, timeout: 5_000 })
}

async function readOverlayStacking(targetPage, overlaySelector) {
  return targetPage.evaluate((selector) => {
    const switcher = document.querySelector('[data-experience-mode-switcher]')
    const overlay = document.querySelector(selector)
    if (!switcher || !overlay) throw new Error(`missing overlay probe: ${selector}`)
    const rect = switcher.getBoundingClientRect()
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return {
      switcherZ: Number.parseInt(getComputedStyle(switcher).zIndex, 10) || 0,
      overlayZ: Number.parseInt(getComputedStyle(overlay).zIndex, 10) || 0,
      overlayOwnsSwitcherPoint: Boolean(top && overlay.contains(top)),
      topClass: top?.className || top?.tagName || ''
    }
  }, overlaySelector)
}

async function readMobileSidebarStacking(targetPage) {
  return targetPage.evaluate(() => {
    const switcher = document.querySelector('[data-experience-mode-switcher]')
    const sidebar = document.querySelector('.sidebar-mobile-open')
    const backdrop = document.querySelector('.mobile-sidebar-backdrop')
    if (!switcher || !sidebar || !backdrop) throw new Error('missing mobile overlay probe')
    const rect = switcher.getBoundingClientRect()
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return {
      switcherZ: Number.parseInt(getComputedStyle(switcher).zIndex, 10) || 0,
      sidebarZ: Number.parseInt(getComputedStyle(sidebar).zIndex, 10) || 0,
      backdropZ: Number.parseInt(getComputedStyle(backdrop).zIndex, 10) || 0,
      overlayOwnsSwitcherPoint: Boolean(top && (sidebar.contains(top) || backdrop.contains(top))),
      topClass: top?.className || top?.tagName || ''
    }
  })
}

async function readOverflow(targetPage, mode) {
  return targetPage.evaluate((activeMode) => {
    const app = document.querySelector('.app')
    const main = document.querySelector('.main')
    const switcher = document.querySelector('[data-experience-mode-switcher]')
    const switcherRect = switcher?.getBoundingClientRect()
    const width = window.innerWidth
    const visibleOffenders = Array.from(document.querySelectorAll('body *')).flatMap((element) => {
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0 || rect.right <= 0 || rect.left >= width) return []
      if (rect.left >= -1 && rect.right <= width + 1) return []
      if (element.closest('.sidebar:not(.sidebar-mobile-open)')) return []
      let ancestor = element.parentElement
      while (ancestor) {
        const overflowX = getComputedStyle(ancestor).overflowX
        if (overflowX === 'auto' || overflowX === 'scroll') return []
        ancestor = ancestor.parentElement
      }
      return [{
        selector: element.id ? `#${element.id}` : `${element.tagName.toLowerCase()}.${Array.from(element.classList).join('.')}`,
        left: Math.round(rect.left),
        right: Math.round(rect.right)
      }]
    }).slice(0, 10)
    return {
      mode: activeMode,
      width,
      height: window.innerHeight,
      documentOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      appOverflow: app ? Math.max(0, app.scrollWidth - app.clientWidth) : -1,
      mainOverflow: main ? Math.max(0, main.scrollWidth - main.clientWidth) : -1,
      switcherInsideViewport: Boolean(switcherRect && switcherRect.left >= -1 && switcherRect.right <= width + 1),
      visibleOffenders
    }
  }, mode)
}

async function captureScreenshot(targetPage, name) {
  const file = path.join(runDir, `${name}.png`)
  await targetPage.screenshot({ path: file, fullPage: false })
  report.screenshots.push(file)
}

async function waitForApp(targetPage) {
  await targetPage.waitForSelector('.app', { timeout: 20_000 })
  await targetPage.waitForFunction(() => typeof window.agentDesk?.createSession === 'function', { timeout: 15_000 })
  await targetPage.waitForSelector('[data-experience-mode-switcher]', { visible: true, timeout: 15_000 })
  await targetPage.waitForSelector('.welcome-composer-input, .composer-input', { visible: true, timeout: 15_000 })
}

async function startOpenAiMock() {
  const server = http.createServer(async (request, response) => {
    if (request.url !== '/v1/responses' || request.method !== 'POST') {
      response.writeHead(404).end('not found')
      return
    }
    for await (const _chunk of request) {
      // Consume the request before completing the streaming response.
    }
    const reply = 'Stable assistant studio transcript response.'
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: reply })}\n\n`)
    response.write(`data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: `resp_assistant_studio_${Date.now()}`,
        output_text: reply,
        usage: { input_tokens: 12, output_tokens: 7, input_tokens_details: { cached_tokens: 0 } }
      }
    })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  const port = await findFreePort(8800)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return { server, port, baseUrl: `http://127.0.0.1:${port}` }
}

function copyBuiltApp() {
  rmSync(isolatedOutDir, { recursive: true, force: true })
  mkdirSync(isolatedOutDir, { recursive: true })
  for (const directory of ['main', 'preload', 'renderer']) {
    cpSync(path.join(sourceOutDir, directory), path.join(isolatedOutDir, directory), { recursive: true })
  }
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
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode }
  child.kill('SIGTERM')
  return Promise.race([
    new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
    sleep(3000).then(() => {
      child.kill('SIGKILL')
      return { code: child.exitCode, signal: child.signalCode ?? 'SIGKILL' }
    })
  ])
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
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8'
  }).trim()
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: repoRoot,
    encoding: 'utf8'
  }).trim()
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
    // Best-effort cleanup must not hide the test result.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
