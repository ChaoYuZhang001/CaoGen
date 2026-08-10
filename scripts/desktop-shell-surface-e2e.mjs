#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnElectronTestProcess, terminateElectronTestProcess } from './lib/electron-test-process.mjs'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const packageJson = require(path.join(repoRoot, 'package.json'))
const electronPackage = require('electron/package.json')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const outputRoot = path.join(repoRoot, 'test-results', 'desktop-shell-surface')
const runDir = path.join(outputRoot, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-desktop-shell-'))
const userDataDir = path.join(tempRoot, 'userData')
const projectDir = path.join(tempRoot, 'project')
const sourceOutDir = path.join(repoRoot, 'out')
const isolatedOutDir = path.join(runDir, 'app', 'out')
const mainEntry = path.join(isolatedOutDir, 'main', 'index.js')
const electronBin = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const electronEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path')
)
electronEnv.Path = [path.dirname(electronBin), process.env.Path ?? process.env.PATH]
  .filter(Boolean)
  .join(path.delimiter)

const report = {
  schemaVersion: 1,
  runId,
  runDir,
  requirement: 'desktop-shell-visual-regression',
  packageVersion: packageJson.version,
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  electronVersion: electronPackage.version,
  gitCommit: '',
  worktreeClean: false,
  checks: [],
  screenshots: [],
  warnings: [],
  coverage: {
    verified: [
      'primary sidebar actions share one quiet navigation-row hierarchy',
      'closed recovery state remains reachable from the sidebar without a floating Composer overlay',
      'production legacy-snapshot migration produces real recoverable task candidates',
      'Recovery Center header and footer remain visible while its body scrolls',
      'chat zoom and density controls live in the low-frequency header menu',
      'desktop, 760px, and 360px shell states have no horizontal document overflow'
    ],
    explicitlyNotVerified: [
      'installed unsigned-preview executable',
      'native title-bar menu behavior',
      'human keyboard and screen-reader traversal'
    ]
  }
}

assert(existsSync(electronBin), 'Electron binary not found. Run npm install first.')
for (const entry of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
  assert(existsSync(path.join(sourceOutDir, entry)), `Built app entry missing: out/${entry}. Run npm run build first.`)
}

mkdirSync(runDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
mkdirSync(projectDir, { recursive: true })
copyBuiltApp()
seedRecoverySnapshots(8)

const mock = await startOpenAiMock()
const remotePort = await findFreePort(10140)
const electron = spawnElectronTestProcess(electronBin, [
  `--remote-debugging-port=${remotePort}`,
  '--in-process-gpu',
  mainEntry
], {
  cwd: repoRoot,
  env: {
    ...electronEnv,
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
  await waitForApp(page)
  await page.setViewport({ width: 1320, height: 860, deviceScaleFactor: 1 })

  await check('recovery drawer uses real migrated candidates and a bounded scrolling body', async () => {
    await page.waitForSelector('.task-recovery-drawer', { visible: true, timeout: 20_000 })
    await waitForRecoveryDrawerSettled(page)
    const state = await page.evaluate(() => {
      const drawer = document.querySelector('.task-recovery-drawer')
      const body = document.querySelector('.task-recovery-drawer-body')
      const footer = document.querySelector('.task-recovery-drawer-footer')
      const rows = document.querySelectorAll('.task-recovery-row')
      if (!drawer || !body || !footer) return null
      const drawerRect = drawer.getBoundingClientRect()
      const footerRect = footer.getBoundingClientRect()
      return {
        rows: rows.length,
        drawerTop: drawerRect.top,
        drawerBottom: drawerRect.bottom,
        footerTop: footerRect.top,
        footerBottom: footerRect.bottom,
        bodyClientHeight: body.clientHeight,
        bodyScrollHeight: body.scrollHeight,
        viewportHeight: window.innerHeight
      }
    })
    assert(state?.rows === 8, `expected 8 recovery rows, got ${state?.rows}`)
    assert(state.drawerTop >= 0 && state.drawerBottom <= state.viewportHeight,
      `desktop recovery drawer escaped viewport: ${JSON.stringify(state)}`)
    assert(state.bodyScrollHeight > state.bodyClientHeight, 'desktop recovery body did not become independently scrollable')
    assert(state.footerBottom <= state.drawerBottom && state.footerTop >= state.drawerTop,
      'desktop recovery footer is not pinned inside the drawer')
    await screenshot(page, 'desktop-recovery')
  })

  await check('sidebar hierarchy is uniform and closed recovery has no floating trigger', async () => {
    await page.click('.task-recovery-drawer-close')
    await page.waitForSelector('.task-recovery-drawer', { hidden: true, timeout: 5_000 })
    const state = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.sidebar-primary-nav .sidebar-nav-item')]
      return {
        labels: rows.map((row) => row.textContent?.trim()),
        heights: rows.map((row) => Number(row.getBoundingClientRect().height.toFixed(2))),
        recoveryCount: document.querySelector('.sidebar-nav-badge')?.textContent,
        floatingTrigger: Boolean(document.querySelector('.recovery-center-trigger')),
        overflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
      }
    })
    assert(state.labels.length === 3, `expected 3 primary navigation rows, got ${state.labels.length}`)
    assert(Math.max(...state.heights) - Math.min(...state.heights) <= 1,
      `sidebar row heights diverged: ${state.heights.join(', ')}`)
    assert(state.recoveryCount === '8', `recovery badge is ${state.recoveryCount}`)
    assert(!state.floatingTrigger, 'closed Recovery Center left a floating trigger over the workspace')
    assert(state.overflow <= 1, `desktop welcome overflow ${state.overflow}px`)
    await screenshot(page, 'desktop-welcome')
  })

  await check('chat header keeps layout controls in the more menu', async () => {
    sessionId = await createSessionFromWelcome(page, mock.baseUrl)
    await waitForValue(
      () => page.evaluate((id) => window.agentDesk.listSessions()
        .then((items) => items.find((item) => item.id === id)), sessionId),
      (meta) => meta?.status === 'idle',
      15_000,
      'waiting for shell fixture response'
    )
    await page.waitForSelector('.assistant-text', { visible: true, timeout: 10_000 })
    const header = await readShellOverflow(page)
    assert(!header.legacyLayoutControls, 'legacy inline chat layout controls are still rendered')
    assert(header.documentOverflow <= 1, `desktop chat overflow ${header.documentOverflow}px`)
    assert(header.headerOverflow <= 1, `desktop header overflow ${header.headerOverflow}px`)
    await screenshot(page, 'desktop-session')

    await page.click('.header-more > button')
    await page.waitForSelector('.header-more-menu', { visible: true, timeout: 5_000 })
    const actions = await page.$$eval('[data-header-action]', (nodes) =>
      nodes.map((node) => node.getAttribute('data-header-action')))
    for (const action of ['zoom-out', 'zoom-reset', 'zoom-in', 'density']) {
      assert(actions.includes(action), `header menu is missing ${action}`)
    }
    await screenshot(page, 'desktop-more-menu')

    const initialDensity = await page.$eval('.chat', (node) => node.className)
    await page.click('[data-header-action="density"]')
    await page.waitForFunction((before) => document.querySelector('.chat')?.className !== before,
      { timeout: 5_000 }, initialDensity)
  })

  await check('compact and mobile shell states remain bounded and reachable', async () => {
    await page.setViewport({ width: 760, height: 700, deviceScaleFactor: 1 })
    await sleep(200)
    let overflow = await readShellOverflow(page)
    assert(overflow.documentOverflow <= 1, `760px document overflow ${overflow.documentOverflow}px`)
    assert(overflow.headerOverflow <= 1, `760px header overflow ${overflow.headerOverflow}px`)
    assert(overflow.composerOverflow <= 1, `760px composer overflow ${overflow.composerOverflow}px`)
    await assertMobileToggleClearance(page, '.first-task-workbench-progress > strong', '760px onboarding title')
    await screenshot(page, 'compact-session')

    await page.setViewport({ width: 360, height: 520, deviceScaleFactor: 1 })
    await sleep(200)
    await assertMobileToggleClearance(page, '.first-task-progress span:first-child', '360px onboarding progress')
    await page.click('.mobile-sidebar-toggle')
    await page.waitForSelector('.sidebar-mobile-open', { visible: true, timeout: 5_000 })
    await page.waitForFunction(() => {
      const sidebar = document.querySelector('.sidebar-mobile-open')
      if (!sidebar) return false
      const rect = sidebar.getBoundingClientRect()
      return rect.left >= -0.5 && Number.parseFloat(getComputedStyle(sidebar).opacity) >= 0.99
    }, { timeout: 2_000 })
    const mobileNav = await page.evaluate(() => {
      const sidebar = document.querySelector('.sidebar-mobile-open')
      const rows = [...document.querySelectorAll('.sidebar-mobile-open .sidebar-nav-item')]
      return {
        sidebarRight: sidebar?.getBoundingClientRect().right ?? 0,
        viewportWidth: window.innerWidth,
        rows: rows.length,
        clippedRows: rows.filter((row) => row.scrollWidth > row.clientWidth + 1).length,
        overflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
      }
    })
    assert(mobileNav.rows >= 3, `mobile sidebar rendered ${mobileNav.rows} navigation rows`)
    assert(mobileNav.clippedRows === 0, `mobile sidebar clipped ${mobileNav.clippedRows} navigation rows`)
    assert(mobileNav.sidebarRight <= mobileNav.viewportWidth, 'mobile sidebar escaped the viewport')
    assert(mobileNav.overflow <= 1, `mobile sidebar overflow ${mobileNav.overflow}px`)
    await screenshot(page, 'mobile-sidebar')

    await page.click('[data-sidebar-action="recovery-center"]')
    await page.waitForSelector('.task-recovery-drawer', { visible: true, timeout: 5_000 })
    await waitForRecoveryDrawerSettled(page)
    const mobileDrawer = await page.evaluate(() => {
      const drawer = document.querySelector('.task-recovery-drawer')
      const body = document.querySelector('.task-recovery-drawer-body')
      const footer = document.querySelector('.task-recovery-drawer-footer')
      if (!drawer || !body || !footer) return null
      const rect = drawer.getBoundingClientRect()
      const footerRect = footer.getBoundingClientRect()
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        footerBottom: footerRect.bottom,
        bodyClientHeight: body.clientHeight,
        bodyScrollHeight: body.scrollHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        overflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
      }
    })
    assert(mobileDrawer && mobileDrawer.left >= 0 && mobileDrawer.right <= mobileDrawer.viewportWidth,
      `mobile recovery drawer escaped horizontally: ${JSON.stringify(mobileDrawer)}`)
    assert(mobileDrawer.top >= 0 && mobileDrawer.bottom <= mobileDrawer.viewportHeight,
      `mobile recovery drawer escaped vertically: ${JSON.stringify(mobileDrawer)}`)
    assert(mobileDrawer.footerBottom <= mobileDrawer.bottom, 'mobile recovery footer escaped the drawer')
    assert(mobileDrawer.bodyScrollHeight > mobileDrawer.bodyClientHeight, 'mobile recovery body is not scrollable')
    assert(mobileDrawer.overflow <= 1, `mobile recovery overflow ${mobileDrawer.overflow}px`)
    await screenshot(page, 'mobile-recovery')
  })

  assert(mock.requests === 1, `expected one model request, got ${mock.requests}`)
} catch (error) {
  report.error = formatError(error)
  process.exitCode = 1
  if (page) await screenshot(page, 'failure').catch(() => undefined)
} finally {
  if (page && !page.isClosed()) await page.close({ runBeforeUnload: true }).catch(() => undefined)
  await waitForValue(
    async () => electron.exitCode,
    (code) => code !== null,
    2_000,
    'waiting for graceful Electron exit'
  ).catch(() => undefined)
  if (browser) await browser.disconnect().catch(() => undefined)
  const exited = await terminateElectronTestProcess(electron)
  await closeServer(mock.server)
  const git = readGitState()
  report.gitCommit = git.commit
  report.worktreeClean = git.worktreeClean
  report.statusEntryCount = git.statusEntryCount
  if (stderr.trim()) report.warnings.push(`[stderr tail]\n${stderr.trim().slice(-2000)}`)
  if (stdout.trim()) report.warnings.push(`[stdout tail]\n${stdout.trim().slice(-1000)}`)
  if (exited.signal) report.warnings.push(`Electron exited by signal ${exited.signal}`)
  report.status = report.checks.every((item) => item.status === 'pass') && !report.error ? 'pass' : 'fail'
  writeReport()
  try {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 })
  } catch (error) {
    report.warnings.push(`temporary directory cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
    writeReport()
  }
}

if (report.status !== 'pass') {
  console.error(`desktop shell surface E2E failed: ${report.error || 'check failure'}`)
  process.exitCode = 1
} else {
  console.log(`desktop shell surface E2E ok: ${runDir}`)
  console.log(`${report.checks.length}/${report.checks.length} checks passed; ${report.screenshots.length} screenshots`)
}
process.exit(report.status === 'pass' ? 0 : 1)

async function check(name, run) {
  const startedAt = Date.now()
  try {
    await run()
    report.checks.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
  } catch (error) {
    report.checks.push({
      name,
      status: 'fail',
      durationMs: Date.now() - startedAt,
      error: formatError(error)
    })
    throw error
  }
}

function seedRecoverySnapshots(count) {
  const now = Date.now()
  const snapshots = Array.from({ length: count }, (_, index) => {
    const suffix = String(index + 1).padStart(2, '0')
    const sessionIdValue = `desktop-shell-recovery-${suffix}`
    const eventId = `desktop-shell-event-${suffix}`
    const messageId = `desktop-shell-message-${suffix}`
    const createdAt = now - (count - index) * 60_000
    return {
      id: sessionIdValue,
      taskId: sessionIdValue,
      sessionId: sessionIdValue,
      title: `恢复验证任务 ${suffix}`,
      projectPath: projectDir,
      engine: 'openai',
      model: 'desktop-shell-fixture',
      providerId: 'desktop-shell-provider',
      createdAt,
      updatedAt: createdAt + 20_000,
      eventCount: 1,
      reason: 'shutdown',
      meta: {
        id: sessionIdValue,
        title: `恢复验证任务 ${suffix}`,
        cwd: projectDir,
        model: 'desktop-shell-fixture',
        providerId: 'desktop-shell-provider',
        status: 'running',
        taskStrategy: 'execute',
        permissionMode: 'default',
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        costUsd: 0,
        contextTokens: 0,
        createdAt,
        engine: 'openai'
      },
      execution: {
        status: 'running',
        lastSeq: 1,
        cursor: { seq: 1, eventId },
        lastEventId: eventId,
        lastEventKind: 'user-message',
        lastEventAt: createdAt + 20_000,
        sdkSessionId: `desktop-shell-sdk-${suffix}`,
        lastUserMessageId: messageId
      },
      replayCandidate: {
        messageId,
        text: `继续恢复验证任务 ${suffix}`,
        seq: 1,
        capturedAt: createdAt + 20_000,
        reason: 'running-user-message'
      },
      transcript: [{
        seq: 1,
        eventId,
        streamId: `desktop-shell-stream-${suffix}`,
        occurredAt: createdAt + 20_000,
        event: { kind: 'user-message', messageId, text: `继续恢复验证任务 ${suffix}` }
      }],
      subtasks: [],
      dagExecutions: [],
      dagRuntimes: []
    }
  })
  writeFileSync(path.join(userDataDir, 'task-snapshots.json'), `${JSON.stringify({ version: 1, snapshots }, null, 2)}\n`)
}

async function createSessionFromWelcome(targetPage, baseUrl) {
  await targetPage.evaluate(async (providerBaseUrl) => {
    await window.agentDesk.createProvider({
      name: 'Desktop Shell Local Mock',
      baseUrl: providerBaseUrl,
      token: 'test-only',
      models: ['desktop-shell-fixture'],
      openaiProtocol: 'responses'
    })
  }, baseUrl)
  await targetPage.reload({ waitUntil: 'domcontentloaded' })
  await waitForApp(targetPage)
  await targetPage.waitForSelector('.task-recovery-drawer', { visible: true, timeout: 10_000 })
  await targetPage.click('.task-recovery-drawer-close')
  await targetPage.waitForSelector('.task-recovery-drawer', { hidden: true, timeout: 5_000 })
  await targetPage.select('.welcome-project-select', '__new_project__')
  await targetPage.waitForSelector('.welcome-project-path', { visible: true, timeout: 5_000 })
  await targetPage.type('.welcome-project-path', projectDir)
  await targetPage.type('.welcome-composer-input', 'Reply with a short shell verification result.')
  await targetPage.click('.welcome-send')
  await targetPage.waitForSelector('.chat-header', { visible: true, timeout: 15_000 })
  const sessions = await waitForValue(
    () => targetPage.evaluate(() => window.agentDesk.listSessions()),
    (items) => items.find((item) => item.title.startsWith('Reply with a short shell verification')),
    15_000,
    'waiting for desktop shell Session creation'
  )
  const created = sessions.find((item) => item.title.startsWith('Reply with a short shell verification'))
  assert(created, 'desktop shell Session disappeared after creation')
  return created.id
}

async function readShellOverflow(targetPage) {
  return targetPage.evaluate(() => {
    const header = document.querySelector('.chat-header')
    const composer = document.querySelector('.composer')
    return {
      documentOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      headerOverflow: header ? Math.max(0, header.scrollWidth - header.clientWidth) : -1,
      composerOverflow: composer ? Math.max(0, composer.scrollWidth - composer.clientWidth) : -1,
      legacyLayoutControls: Boolean(document.querySelector('.chat-layout-controls'))
    }
  })
}

async function screenshot(targetPage, name) {
  const file = path.join(runDir, `${name}.png`)
  await targetPage.screenshot({ path: file, fullPage: false })
  report.screenshots.push(file)
}

function copyBuiltApp() {
  rmSync(isolatedOutDir, { recursive: true, force: true })
  mkdirSync(isolatedOutDir, { recursive: true })
  for (const directory of ['main', 'preload', 'renderer']) {
    cpSync(path.join(sourceOutDir, directory), path.join(isolatedOutDir, directory), { recursive: true })
  }
}

async function waitForApp(targetPage) {
  await targetPage.waitForSelector('.app', { timeout: 20_000 })
  await targetPage.waitForFunction(() =>
    typeof window.agentDesk?.listTaskSnapshots === 'function' &&
    typeof window.agentDesk?.createSession === 'function', { timeout: 15_000 })
  await targetPage.waitForSelector('[data-experience-mode-switcher]', { visible: true, timeout: 15_000 })
}

async function waitForRecoveryDrawerSettled(targetPage) {
  await targetPage.waitForFunction(() => {
    const drawer = document.querySelector('.task-recovery-drawer')
    if (!drawer) return false
    const rect = drawer.getBoundingClientRect()
    return rect.left >= -0.5 && rect.right <= window.innerWidth + 0.5 &&
      Number.parseFloat(getComputedStyle(drawer).opacity) >= 0.99
  }, { timeout: 2_000 })
}

async function assertMobileToggleClearance(targetPage, targetSelector, label) {
  const spacing = await targetPage.evaluate((selector) => {
    const toggle = document.querySelector('.mobile-sidebar-toggle')
    const target = document.querySelector(selector)
    if (!toggle || !target) return null
    return {
      targetLeft: target.getBoundingClientRect().left,
      toggleRight: toggle.getBoundingClientRect().right
    }
  }, targetSelector)
  assert(spacing && spacing.targetLeft >= spacing.toggleRight + 4,
    `${label} overlaps the mobile sidebar toggle: ${JSON.stringify(spacing)}`)
}

async function startOpenAiMock() {
  let requests = 0
  const server = http.createServer(async (request, response) => {
    if (request.url !== '/v1/responses' || request.method !== 'POST') {
      response.writeHead(404).end('not found')
      return
    }
    requests += 1
    for await (const _chunk of request) { /* consume request */ }
    const reply = 'Desktop shell verified.'
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: reply })}\n\n`)
    response.write(`data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: `resp_shell_${Date.now()}`,
        output_text: reply,
        usage: { input_tokens: 8, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } }
      }
    })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  const port = await findFreePort(10240)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return { server, baseUrl: `http://127.0.0.1:${port}`, get requests() { return requests } }
}

async function waitForElectronPage(connectedBrowser, timeoutMs) {
  return waitForValue(
    async () => {
      for (const candidate of await connectedBrowser.pages()) {
        try {
          if (/\/out\/renderer\/index\.html(?:[?#].*)?$/.test(candidate.url())) return candidate
        } catch {
          // The initial empty target can disappear before its main frame exists.
        }
      }
      return undefined
    },
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

async function closeServer(server) {
  if (!server.listening) return
  await new Promise((resolve) => server.close(resolve))
}

function readGitState() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: repoRoot,
    encoding: 'utf8'
  }).trim()
  return { commit, worktreeClean: status.length === 0, statusEntryCount: status ? status.split(/\r?\n/).length : 0 }
}

function writeReport() {
  mkdirSync(outputRoot, { recursive: true })
  writeFileSync(path.join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(path.join(outputRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function formatError(error) {
  if (error instanceof Error) return error.stack || error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
