#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const electronPackage = require('electron/package.json')
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')
const electronBin = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-workbench-keyboard-'))
const projectDir = path.join(tempRoot, 'project')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'workbench-keyboard-accessibility', runId)

assert(existsSync(mainEntry), 'Built Electron main entry not found. Run npm run build first.')
assert(existsSync(electronBin), 'Electron binary not found. Run npm install first.')
mkdirSync(projectDir, { recursive: true })
mkdirSync(reportDir, { recursive: true })
writeFixture()

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  requirement: 'IDE-002 keyboard accessibility',
  platform: process.platform,
  arch: process.arch,
  electronVersion: electronPackage.version,
  gitCommit: readGitCommit(),
  checks: [],
  screenshots: []
}
const remotePort = await findFreePort()
const electron = spawn(electronBin, [`--remote-debugging-port=${remotePort}`, mainEntry], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CAOGEN_USER_DATA_DIR: path.join(tempRoot, 'user-data'),
    CAOGEN_MEMORY_DIR: path.join(tempRoot, 'memory'),
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
let browser
let page
let stderr = ''
electron.stderr.on('data', (chunk) => { stderr += chunk.toString() })

try {
  await waitForDebugPort(remotePort, 20_000)
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${remotePort}`, defaultViewport: null })
  page = await waitForElectronPage(browser, 20_000)
  await page.setViewport({ width: 1280, height: 820, deviceScaleFactor: 1 })
  await page.waitForSelector('body', { timeout: 20_000 })
  const sessionId = await createSession(page)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector(`.session-card[data-session-id="${sessionId}"]`, { visible: true, timeout: 20_000 })
  await page.click(`.session-card[data-session-id="${sessionId}"]`)
  await openDeveloperPanel(page)

  await check('developer tabs expose one selected and one tabbable tab with valid panel linkage', async () => {
    await assertTablist(page, '.developer-panel-tabs', 4)
  })
  await check('ArrowRight traverses Files, Tests, Debug, Refactor and wraps to Files', async () => {
    await focusAndPress(page, '[data-developer-tab="files"]', 'ArrowRight')
    await assertDeveloperView(page, 'tests')
    await page.keyboard.press('ArrowRight')
    await assertDeveloperView(page, 'debug')
    await page.keyboard.press('ArrowRight')
    await assertDeveloperView(page, 'refactor')
    await page.keyboard.press('ArrowRight')
    await assertDeveloperView(page, 'files')
  })
  await check('ArrowLeft wraps from Files to Refactor', async () => {
    await focusAndPress(page, '[data-developer-tab="files"]', 'ArrowLeft')
    await assertDeveloperView(page, 'refactor')
  })
  await check('Home and End move to the first and last developer tabs', async () => {
    await page.keyboard.press('Home')
    await assertDeveloperView(page, 'files')
    await page.keyboard.press('End')
    await assertDeveloperView(page, 'refactor')
    await page.keyboard.press('Home')
    await assertDeveloperView(page, 'files')
  })

  await check('file browser modes use roving focus and Arrow/Home/End activation', async () => {
    await assertTablist(page, '.file-browser-modes', 3)
    await focusAndPress(page, '#file-browser-tab-tree', 'ArrowRight')
    await assertSelectedAndFocused(page, '#file-browser-tab-search')
    await page.keyboard.press('End')
    await assertSelectedAndFocused(page, '#file-browser-tab-problems')
    await page.keyboard.press('Home')
    await assertSelectedAndFocused(page, '#file-browser-tab-tree')
  })

  await check('open file tabs move focus and editor selection with Home and End', async () => {
    await openFixtureFile(page, 'alpha.ts')
    await openFixtureFile(page, 'beta.ts')
    await page.waitForFunction(() => document.querySelectorAll('.file-editor-tabs [role="tab"]').length === 2)
    await assertTablist(page, '.file-editor-tabs', 2)
    await page.focus('#file-editor-tab-1')
    await page.keyboard.press('Home')
    await assertSelectedAndFocused(page, '#file-editor-tab-0')
    assert(await page.$eval('[data-file-editor-path]', (editor) => editor.getAttribute('data-file-editor-path')) === 'alpha.ts', 'Home did not activate alpha.ts')
    await page.keyboard.press('End')
    await assertSelectedAndFocused(page, '#file-editor-tab-1')
    assert(await page.$eval('[data-file-editor-path]', (editor) => editor.getAttribute('data-file-editor-path')) === 'beta.ts', 'End did not activate beta.ts')
  })

  await check('test output tabs activate stderr and stdout with arrow keys', async () => {
    await focusAndPress(page, '[data-developer-tab="files"]', 'ArrowRight')
    await assertDeveloperView(page, 'tests')
    await page.waitForSelector('[data-project-test-command="package-script"]', { visible: true, timeout: 20_000 })
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('[data-project-test-command]')]
        .find((item) => item.querySelector('strong')?.textContent === 'npm run test')
      row?.querySelector('button')?.click()
    })
    await page.waitForSelector('[data-project-test-result="passed"]', { visible: true, timeout: 20_000 })
    await assertTablist(page, '.test-output-tabs', 2)
    await focusAndPress(page, '#project-test-output-tab-stdout', 'ArrowRight')
    await assertSelectedAndFocused(page, '#project-test-output-tab-stderr')
    assert((await page.$eval('#project-test-output-panel', (panel) => panel.textContent ?? '')).includes('keyboard-stderr'), 'stderr output did not follow tab activation')
    await page.keyboard.press('ArrowLeft')
    await assertSelectedAndFocused(page, '#project-test-output-tab-stdout')
    assert((await page.$eval('#project-test-output-panel', (panel) => panel.textContent ?? '')).includes('keyboard-stdout'), 'stdout output did not follow tab activation')
  })

  await check('keyboard traversal leaves Debug and Refactor panels mounted and visible', async () => {
    await page.focus('[data-developer-tab="tests"]')
    await page.keyboard.press('ArrowRight')
    await assertDeveloperView(page, 'debug')
    assert(await page.$('[data-project-debug-panel]'), 'Debug panel was not mounted')
    await page.keyboard.press('ArrowRight')
    await assertDeveloperView(page, 'refactor')
    assert(await page.$('[data-project-refactor-panel]'), 'Refactor panel was not mounted')
  })

  const screenshotName = 'workbench-keyboard-desktop.png'
  writeFileSync(path.join(reportDir, screenshotName), await page.screenshot({ type: 'png' }))
  report.screenshots.push(screenshotName)
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.stack || error.message : String(error)
  if (stderr.trim()) report.electronStderr = stderr.split(/\r?\n/).filter(Boolean).slice(-8)
  process.exitCode = 1
} finally {
  report.pass = report.checks.filter((item) => item.status === 'pass').length
  report.total = report.checks.length
  writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  if (browser) await browser.disconnect().catch(() => {})
  await stopElectron(electron)
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
}

if (report.status !== 'passed') throw new Error(report.error || 'workbench keyboard accessibility E2E failed')
console.log(`Workbench keyboard accessibility E2E: ${report.pass}/${report.total} checks passed`)

async function createSession(targetPage) {
  return targetPage.evaluate(async (cwd) => {
    const provider = await window.agentDesk.createProvider({
      name: 'Keyboard Fixture',
      baseUrl: 'http://127.0.0.1:9',
      token: 'test-only',
      models: ['keyboard-model'],
      engine: 'openai',
      openaiProtocol: 'responses'
    })
    const session = await window.agentDesk.createSession({
      cwd,
      engine: 'openai',
      providerId: provider.id,
      model: 'keyboard-model',
      routingScope: 'fixed',
      taskStrategy: 'execute',
      isolated: false,
      title: 'Keyboard Workbench'
    })
    return session.id
  }, projectDir)
}

async function openDeveloperPanel(targetPage) {
  await targetPage.click('[data-experience-mode-option="studio"]')
  await targetPage.waitForSelector('[data-studio-projection-tab="session"]', { visible: true })
  await targetPage.click('[data-studio-projection-tab="session"]')
  await targetPage.waitForSelector('.desk-rail-drawer-anchor .desk-rail-button', { visible: true })
  await targetPage.click('.desk-rail-drawer-anchor .desk-rail-button')
  await targetPage.waitForFunction(() => document.querySelectorAll('.desk-tool-item').length >= 4)
  await targetPage.evaluate(() => document.querySelector('.desk-tool-item:nth-child(4)')?.click())
  await targetPage.waitForSelector('.developer-panel', { visible: true, timeout: 20_000 })
  await targetPage.waitForSelector('#file-browser-tab-tree', { visible: true, timeout: 20_000 })
}

async function assertTablist(targetPage, selector, expectedCount) {
  const state = await targetPage.$eval(selector, (tablist) => {
    const tabs = [...tablist.querySelectorAll('[role="tab"]')]
      .filter((tab) => tab.closest('[role="tablist"]') === tablist)
    const selected = tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true')
    const tabbable = tabs.filter((tab) => tab.tabIndex === 0)
    const active = selected[0]
    const panel = active ? document.getElementById(active.getAttribute('aria-controls') ?? '') : null
    return {
      count: tabs.length,
      selected: selected.length,
      tabbable: tabbable.length,
      sameActive: selected[0] === tabbable[0],
      linked: Boolean(active?.id && panel && panel.getAttribute('aria-labelledby') === active.id)
    }
  })
  assert(state.count === expectedCount, `${selector} expected ${expectedCount} tabs, got ${state.count}`)
  assert(state.selected === 1 && state.tabbable === 1 && state.sameActive, `${selector} does not expose one active roving tab: ${JSON.stringify(state)}`)
  assert(state.linked, `${selector} active tab is not linked to its panel`)
}

async function focusAndPress(targetPage, selector, key) {
  await targetPage.focus(selector)
  await targetPage.keyboard.press(key)
}

async function assertDeveloperView(targetPage, view) {
  await targetPage.waitForSelector(`[data-developer-tab="${view}"][aria-selected="true"]`, { visible: true })
  await targetPage.waitForFunction((expected) => {
    const tab = document.querySelector(`[data-developer-tab="${expected}"]`)
    const panel = document.getElementById(`developer-panel-${expected}`)
    return document.activeElement === tab && panel && !panel.hidden && panel.checkVisibility()
  }, {}, view)
}

async function assertSelectedAndFocused(targetPage, selector) {
  await targetPage.waitForFunction((target) => {
    const tab = document.querySelector(target)
    return tab?.getAttribute('aria-selected') === 'true' && tab.tabIndex === 0 && document.activeElement === tab
  }, {}, selector)
}

async function openFixtureFile(targetPage, relativePath) {
  await targetPage.waitForSelector(`.file-tree-row[title="${relativePath}"]`, { visible: true, timeout: 20_000 })
  await targetPage.click(`.file-tree-row[title="${relativePath}"]`)
  await targetPage.waitForSelector(`[data-file-editor-path="${relativePath}"]`, { visible: true, timeout: 20_000 })
}

async function check(name, operation) {
  try {
    await operation()
    report.checks.push({ name, status: 'pass' })
    console.log(`[PASS] ${name}`)
  } catch (error) {
    report.checks.push({ name, status: 'fail', detail: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

function writeFixture() {
  writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({
    name: 'caogen-keyboard-fixture',
    private: true,
    main: 'debug-target.js',
    scripts: {
      test: 'node -e "console.log(\'keyboard-stdout\'); console.error(\'keyboard-stderr\')"'
    }
  }, null, 2), 'utf8')
  writeFileSync(path.join(projectDir, 'alpha.ts'), 'export const alpha = 1\n', 'utf8')
  writeFileSync(path.join(projectDir, 'beta.ts'), 'export const beta = 2\n', 'utf8')
  writeFileSync(path.join(projectDir, 'debug-target.js'), 'setTimeout(() => process.exit(0), 50)\n', 'utf8')
}

function readGitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function waitForDebugPort(port, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return
    } catch { /* Electron is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Electron debugging port did not become ready')
}

async function waitForElectronPage(targetBrowser, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const pages = await targetBrowser.pages()
    const candidate = pages.find((item) => item.url().startsWith('file:'))
    if (candidate) return candidate
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Electron renderer page did not become ready')
}

async function stopElectron(child) {
  if (!child?.pid) return
  const exited = child.exitCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once('exit', resolve))
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 5_000))
  ])
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
