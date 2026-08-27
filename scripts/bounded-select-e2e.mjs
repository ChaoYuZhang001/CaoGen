#!/usr/bin/env node

import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'
import { verifyBuildEvidence } from './lib/build-evidence.mjs'
import { spawnElectronTestProcess, terminateElectronTestProcess } from './lib/electron-test-process.mjs'
import { bindSourceEvidence, readSourceEvidenceState } from './lib/source-evidence-binding.mjs'

const repoRoot = process.cwd()
const sourceEvidenceAtStart = readSourceEvidenceState(repoRoot)
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const packageJson = require(path.join(repoRoot, 'package.json'))
const electronPackage = require('electron/package.json')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const outputRoot = path.join(repoRoot, 'test-results', 'bounded-select')
const runDir = path.join(outputRoot, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-bounded-select-'))
const userDataDir = path.join(tempRoot, 'userData')
const workspaceDir = path.join(tempRoot, 'workspace')
const shortWorkspaceDir = path.join(tempRoot, 'short-workspace')
const sourceOutDir = path.join(repoRoot, 'out')
const isolatedOutDir = path.join(runDir, 'app', 'out')
const mainEntry = path.join(isolatedOutDir, 'main', 'index.js')
const electronBin = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const viewports = [{ width: 1280, height: 800 }, { width: 960, height: 640 }]
const projectId = 'bounded-select-long-project'
const providerId = 'bounded-select-ready-provider'
const disabledProviderId = 'bounded-select-disabled-provider'
const longProjectName = `Bounded project ${'project-name-'.repeat(28)}end`
const longProviderName = `Bounded provider ${'provider-name-'.repeat(24)}end`
const longModelName = `bounded-model-${'model-name-'.repeat(28)}end`
const projectRoot = '.welcome-bounded-select-project'
const providerRoot = '.welcome-expert-routing .welcome-bounded-select:has([data-welcome-routing-control="provider"])'
const modelRoot = '.welcome-expert-routing .welcome-bounded-select:has([data-welcome-routing-control="model"])'

const report = {
  schemaVersion: 1,
  runId,
  gate: 'test:bounded-select:required',
  requirement: 'Welcome bounded dynamic select interaction',
  classification: 'local_targeted_not_release',
  packageVersion: packageJson.version,
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  electronVersion: electronPackage.version,
  viewports: viewports.map(({ width, height }) => `${width}x${height}`),
  fixturePolicy: 'temporary local data; no Provider request; process credentials cleared',
  checks: [],
  measurements: [],
  screenshots: [],
  warnings: [],
  failures: []
}

mkdirSync(runDir, { recursive: true })
prepareFixture()
assertBuildInputs()
copyBuiltApp()

let electron
let browser
let page
let electronStdout = ''
let electronStderr = ''
try {
  ;({ electron, browser, page } = await launchElectronApp())
  await setViewportAndSettle(page, viewports[0])
  await page.waitForSelector('.welcome-composer-input', { visible: true, timeout: 20_000 })

  await check('Project menus are bounded with constrained long labels at both supported viewports', async () => {
    await exposeProjectPicker(page)
    for (const viewport of viewports) {
      await setViewportAndSettle(page, viewport)
      await openAndMeasure(page, projectRoot, viewport, 'project', projectId)
      await capture(page, `project-open-${viewport.width}x${viewport.height}`)
      await closeWithEscape(page, projectRoot, 'Project')
    }
  })

  await check('keyboard navigation, Enter and Space selection restore Project trigger focus', async () => {
    await setViewportAndSettle(page, viewports[0])
    await focusTriggerAndPress(page, projectRoot, 'Space')
    await assertMenuVisible(page, projectRoot)
    await assertActiveValue(page, '__unassigned__', 'Space opened at selected Project')
    await page.keyboard.press('ArrowDown')
    await assertActiveValue(page, projectId, 'ArrowDown moved to long Project')
    await page.keyboard.press('ArrowUp')
    await assertActiveValue(page, '__unassigned__', 'ArrowUp returned to unassigned')
    await page.keyboard.press('End')
    await assertActiveValue(page, '__new_project__', 'End moved to last Project option')
    await page.keyboard.press('Home')
    await assertActiveValue(page, '__unassigned__', 'Home moved to first Project option')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await assertMenuHidden(page, projectRoot)
    await assertNativeValue(page, '.welcome-project-select', projectId, 'Enter selected long Project')
    await assertTriggerFocus(page, projectRoot, 'Enter Project selection')
    await capture(page, 'project-long-trigger-selected')

    await focusTriggerAndPress(page, projectRoot, 'Enter')
    await page.keyboard.press('End')
    await page.keyboard.press('Space')
    await assertMenuHidden(page, projectRoot)
    await assertNativeValue(page, '.welcome-project-select', '__new_project__', 'Space selected last Project option')
    await assertTriggerFocus(page, projectRoot, 'Space Project selection')
    await page.select('.welcome-project-select', projectId)
  })

  await check('Escape, outside click, window blur, scroll and resize close the Project menu', async () => {
    await setViewportAndSettle(page, viewports[0])
    await clickOpen(page, projectRoot)
    await page.keyboard.press('ArrowDown')
    await closeWithEscape(page, projectRoot, 'Project')

    await clickOpen(page, projectRoot)
    await page.click('.welcome-composer-input')
    await assertMenuHidden(page, projectRoot)
    await assertFocusMatches(page, '.welcome-composer-input', 'outside click kept its destination focus')

    await clickOpen(page, projectRoot)
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await assertMenuHidden(page, projectRoot)

    await clickOpen(page, projectRoot)
    await page.evaluate(() => window.dispatchEvent(new Event('scroll')))
    await assertMenuHidden(page, projectRoot)

    await clickOpen(page, projectRoot)
    await setViewportAndSettle(page, viewports[1])
    await assertMenuHidden(page, projectRoot)
  })

  await enterExpertWelcome(page)

  await check('Provider menus are bounded and unavailable Providers remain disabled', async () => {
    for (const viewport of viewports) {
      await setViewportAndSettle(page, viewport)
      await openAndMeasure(page, providerRoot, viewport, 'provider', disabledProviderId)
      await assertDisabledOption(page, providerRoot, disabledProviderId, providerId)
      await capture(page, `provider-open-${viewport.width}x${viewport.height}`)
      await closeWithEscape(page, providerRoot, 'Provider')
    }
  })

  await check('Provider keyboard navigation skips disabled options and restores focus', async () => {
    await setViewportAndSettle(page, viewports[0])
    await focusTriggerAndPress(page, providerRoot, 'Enter')
    await page.keyboard.press('End')
    await assertActiveValue(page, providerId, 'End skipped unavailable Provider')
    await page.keyboard.press('ArrowDown')
    await assertActiveValue(page, providerId, 'ArrowDown did not enter disabled Provider')
    await page.keyboard.press('Escape')
    await assertTriggerFocus(page, providerRoot, 'Provider Escape')
  })

  await check('Tab and Shift+Tab close routed menus and continue from their triggers', async () => {
    await setViewportAndSettle(page, viewports[0])
    await focusTriggerAndPress(page, providerRoot, 'Enter')
    await assertMenuVisible(page, providerRoot)
    await page.keyboard.press('Tab')
    await assertMenuHidden(page, providerRoot)
    await assertFocusMatches(
      page,
      '[data-welcome-routing-control="drive"]',
      'Provider Tab did not advance to Drive'
    )

    await focusTriggerAndPress(page, modelRoot, 'Enter')
    await assertMenuVisible(page, modelRoot)
    await page.keyboard.down('Shift')
    await page.keyboard.press('Tab')
    await page.keyboard.up('Shift')
    await assertMenuHidden(page, modelRoot)
    await assertFocusMatches(
      page,
      '[data-welcome-routing-control="drive"]',
      'Model Shift+Tab did not return to Drive'
    )
  })

  await check('Model menus are bounded and long Model selection works with Space', async () => {
    for (const viewport of viewports) {
      await setViewportAndSettle(page, viewport)
      await openAndMeasure(page, modelRoot, viewport, 'model', longModelName)
      await capture(page, `model-open-${viewport.width}x${viewport.height}`)
      await closeWithEscape(page, modelRoot, 'Model')
    }
    await setViewportAndSettle(page, viewports[0])
    await focusTriggerAndPress(page, modelRoot, 'Enter')
    await page.keyboard.press('End')
    await assertActiveValue(page, longModelName, 'End focused long Model')
    await page.keyboard.press('Space')
    await assertNativeValue(page, '[data-welcome-routing-control="model"]', longModelName, 'Space selected long Model')
    await assertTriggerFocus(page, modelRoot, 'Space Model selection')
    await capture(page, 'model-long-trigger-selected')
  })

  const provenance = bindSourceEvidence(
    report,
    sourceEvidenceAtStart,
    readSourceEvidenceState(repoRoot),
    'Bounded select Electron test'
  )
  assert.equal(provenance.status, 'pass', report.error)
  report.status = 'passed'
  report.explicitlyNotVerified = ['clean release SHA binding', 'signed packaged application', 'five-user timed acceptance']
  writeReport()
  console.log(`bounded select Electron E2E: passed (${report.checks.length}/${report.checks.length})`)
  console.log(path.join(runDir, 'report.json'))
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.stack || error.message : String(error)
  report.failures.push({ message: report.error })
  if (!report.provenance) {
    bindSourceEvidence(report, sourceEvidenceAtStart, readSourceEvidenceState(repoRoot), 'Bounded select Electron test')
  }
  report.electronStdoutTail = electronStdout.slice(-4000)
  report.electronStderrTail = electronStderr.slice(-8000)
  writeReport()
  console.error(`bounded select Electron E2E failed: ${report.error}`)
  process.exitCode = 1
} finally {
  if (browser) browser.disconnect()
  if (electron) await terminateElectronTestProcess(electron)
  if (process.env.CAOGEN_KEEP_BOUNDED_SELECT_FIXTURE !== '1') rmSync(tempRoot, { recursive: true, force: true })
}

function prepareFixture() {
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(workspaceDir, { recursive: true })
  mkdirSync(shortWorkspaceDir, { recursive: true })
  writeFileSync(path.join(workspaceDir, 'README.md'), '# Bounded select fixture\n', 'utf8')
  writeFileSync(path.join(userDataDir, 'projects.json'), JSON.stringify({
    schemaVersion: 1,
    projects: [
      { id: projectId, name: longProjectName, path: workspaceDir, lastUsedAt: Date.now() },
      { id: 'bounded-select-short-project', name: 'Short project', path: shortWorkspaceDir, lastUsedAt: Date.now() - 1 }
    ]
  }, null, 2))
  writeFileSync(path.join(userDataDir, 'providers.json'), JSON.stringify([
    {
      id: providerId,
      name: longProviderName,
      baseUrl: 'http://127.0.0.1:9',
      encryptedToken: `b64:${Buffer.from('bounded-select-local-fixture').toString('base64')}`,
      models: ['bounded-model-short', longModelName],
      openaiProtocol: 'responses',
      credentialHeaderNames: ['Authorization'],
      createdAt: Date.now()
    },
    {
      id: disabledProviderId,
      name: `Unavailable ${longProviderName}`,
      baseUrl: 'http://127.0.0.1:9',
      models: ['bounded-disabled-model'],
      openaiProtocol: 'responses',
      credentialHeaderNames: ['Authorization'],
      createdAt: Date.now() - 1
    }
  ], null, 2))
  writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify({
    defaultModel: 'bounded-model-short',
    defaultProviderId: providerId,
    language: 'zh',
    theme: 'light',
    failoverEnabled: false,
    budgetUsdPerSession: 0
  }, null, 2))
}

function assertBuildInputs() {
  assert(existsSync(electronBin), 'Electron binary not found. Run npm install first.')
  const buildEvidence = verifyBuildEvidence(repoRoot, sourceEvidenceAtStart)
  report.buildEvidence = buildEvidence
  assert.equal(buildEvidence.status, 'pass', `Build evidence failed: ${buildEvidence.errors.join('; ')}`)
}

function copyBuiltApp() {
  rmSync(isolatedOutDir, { recursive: true, force: true })
  mkdirSync(isolatedOutDir, { recursive: true })
  for (const directory of ['main', 'preload', 'renderer']) {
    cpSync(path.join(sourceOutDir, directory), path.join(isolatedOutDir, directory), { recursive: true })
  }
}

async function launchElectronApp() {
  const remotePort = await findFreePort(9980)
  const child = spawnElectronTestProcess(electronBin, [
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
  child.stdout?.on('data', (chunk) => { electronStdout += chunk.toString() })
  child.stderr?.on('data', (chunk) => { electronStderr += chunk.toString() })
  await waitForDebugPort(remotePort, 20_000)
  const connectedBrowser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${remotePort}`, defaultViewport: null })
  const rendererPage = await waitForElectronPage(connectedBrowser, 20_000)
  await rendererPage.waitForSelector('.app', { timeout: 20_000 })
  await rendererPage.waitForSelector('[data-experience-mode-switcher]', { visible: true, timeout: 15_000 })
  return { electron: child, browser: connectedBrowser, page: rendererPage }
}

async function setViewportAndSettle(targetPage, viewport) {
  await targetPage.setViewport({ ...viewport, deviceScaleFactor: 1 })
  await targetPage.waitForFunction(
    ({ width, height }) => window.innerWidth === width && window.innerHeight === height,
    { timeout: 10_000 },
    viewport
  )
  await targetPage.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  }))
}

async function exposeProjectPicker(targetPage) {
  const visible = await targetPage.$eval('.welcome-project-bar', (node) => !node.hidden)
  if (!visible) await targetPage.click('[data-welcome-project-trigger]')
  await targetPage.waitForSelector(projectRoot, { visible: true, timeout: 10_000 })
}

async function enterExpertWelcome(targetPage) {
  await targetPage.click('[data-experience-mode-option="studio"]')
  await targetPage.waitForFunction(() => {
    const option = document.querySelector('[data-experience-mode-option="studio"]')
    const pane = document.querySelector('.experience-pane')
    return option?.getAttribute('aria-pressed') === 'true'
      && pane?.getAttribute('data-experience-mode') === 'studio'
  }, { timeout: 15_000 })
  await targetPage.waitForSelector('[data-studio-projection-tab="session"]', { visible: true, timeout: 15_000 })
  await targetPage.click('[data-studio-projection-tab="session"]')
  await targetPage.waitForFunction(() => {
    const pane = document.querySelector('.experience-pane')
    const panel = document.querySelector('#studio-projection-panel-session')
    return pane?.getAttribute('data-studio-surface') === 'session'
      && panel instanceof HTMLElement
      && !panel.hidden
      && panel.getAttribute('aria-hidden') === 'false'
  }, { timeout: 15_000 })
  await targetPage.waitForSelector('[data-welcome-routing-mode="fixed"]', { visible: true, timeout: 15_000 })
  await targetPage.click('[data-welcome-routing-mode="fixed"]')
  await targetPage.waitForSelector(providerRoot, { visible: true, timeout: 10_000 })
  await targetPage.waitForSelector(modelRoot, { visible: true, timeout: 10_000 })
  await targetPage.select('[data-welcome-routing-control="provider"]', providerId)
  await targetPage.select('[data-welcome-routing-control="model"]', 'bounded-model-short')
}

async function openAndMeasure(targetPage, rootSelector, viewport, kind, longOptionValue) {
  await clickOpen(targetPage, rootSelector)
  const measurement = await measureMenu(targetPage, rootSelector, longOptionValue)
  assert.equal(measurement.viewportWidth, viewport.width, `${kind} viewport width drifted`)
  assert.equal(measurement.viewportHeight, viewport.height, `${kind} viewport height drifted`)
  assert(measurement.left >= 11, `${kind} menu crossed left edge: ${JSON.stringify(measurement)}`)
  assert(measurement.right <= viewport.width - 11, `${kind} menu crossed right edge: ${JSON.stringify(measurement)}`)
  assert(measurement.top >= 11, `${kind} menu crossed top edge: ${JSON.stringify(measurement)}`)
  assert(measurement.bottom <= viewport.height - 11, `${kind} menu crossed bottom edge: ${JSON.stringify(measurement)}`)
  assert(measurement.documentWidth <= viewport.width + 1, `${kind} caused document overflow: ${JSON.stringify(measurement)}`)
  assert(measurement.menuScrollWidth <= measurement.menuClientWidth + 1, `${kind} menu scrolls horizontally: ${JSON.stringify(measurement)}`)
  assert(measurement.optionRight <= measurement.menuRight + 1, `${kind} option escaped menu: ${JSON.stringify(measurement)}`)
  assert(measurement.labelRight <= measurement.optionRight + 1, `${kind} label escaped option: ${JSON.stringify(measurement)}`)
  assert(measurement.optionScrollWidth <= measurement.optionClientWidth + 1, `${kind} option overflows: ${JSON.stringify(measurement)}`)
  assert(measurement.longTextLength > 100, `${kind} fixture label is not long enough`)
  assert.equal(measurement.overflowWrap, 'anywhere', `${kind} long label does not wrap anywhere`)
  assert.equal(measurement.portalParentIsBody, true, `${kind} menu is still trapped in a contained surface`)
  assert.equal(measurement.controlsMatch, true, `${kind} trigger does not own its Portal listbox`)
  report.measurements.push({ kind, viewport: `${viewport.width}x${viewport.height}`, ...measurement })
}

async function measureMenu(targetPage, rootSelector, optionValue) {
  return targetPage.$eval(rootSelector, (root, value) => {
    const trigger = root.querySelector('[data-bounded-select-trigger]')
    const menuId = trigger?.getAttribute('aria-controls')
    const menu = menuId ? document.getElementById(menuId) : null
    if (!(menu instanceof HTMLElement)) throw new Error(`owned Portal menu missing: ${menuId}`)
    const option = menu.querySelector(`[data-bounded-select-option="${CSS.escape(value)}"]`)
    const label = option?.querySelector('span')
    if (!option || !label) throw new Error(`long option missing: ${value}`)
    const menuRect = menu.getBoundingClientRect()
    const optionRect = option.getBoundingClientRect()
    const labelRect = label.getBoundingClientRect()
    return {
      left: menuRect.left,
      right: menuRect.right,
      top: menuRect.top,
      bottom: menuRect.bottom,
      menuRight: menuRect.right,
      menuClientWidth: menu.clientWidth,
      menuScrollWidth: menu.scrollWidth,
      optionRight: optionRect.right,
      optionClientWidth: option.clientWidth,
      optionScrollWidth: option.scrollWidth,
      labelRight: labelRect.right,
      longTextLength: (label.textContent ?? '').length,
      overflowWrap: getComputedStyle(label).overflowWrap,
      portalParentIsBody: menu.parentElement === document.body,
      controlsMatch: menu.id === menuId && trigger?.getAttribute('aria-expanded') === 'true',
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    }
  }, optionValue)
}

async function assertDisabledOption(targetPage, rootSelector, optionValue, expectedNativeValue) {
  const optionSelector = `[data-bounded-select-menu] [data-bounded-select-option="${optionValue}"]`
  const disabled = await targetPage.$eval(optionSelector, (node) => node.getAttribute('aria-disabled'))
  assert.equal(disabled, 'true', 'unavailable Provider is not aria-disabled')
  await targetPage.click(optionSelector)
  await assertMenuVisible(targetPage, rootSelector)
  await assertNativeValue(
    targetPage,
    '[data-welcome-routing-control="provider"]',
    expectedNativeValue,
    'disabled Provider click changed selection'
  )
}

async function clickOpen(targetPage, rootSelector) {
  const trigger = `${rootSelector} [data-bounded-select-trigger]`
  await targetPage.waitForSelector(trigger, { visible: true, timeout: 10_000 })
  await targetPage.click(trigger)
  await assertMenuVisible(targetPage, rootSelector)
}

async function focusTriggerAndPress(targetPage, rootSelector, key) {
  await targetPage.focus(`${rootSelector} [data-bounded-select-trigger]`)
  await targetPage.keyboard.press(key)
}

async function closeWithEscape(targetPage, rootSelector, label) {
  await targetPage.keyboard.press('Escape')
  await assertMenuHidden(targetPage, rootSelector)
  await assertTriggerFocus(targetPage, rootSelector, `${label} Escape`)
}

async function assertMenuVisible(targetPage, rootSelector) {
  await targetPage.waitForFunction((selector) => {
    const trigger = document.querySelector(`${selector} [data-bounded-select-trigger]`)
    const menuId = trigger?.getAttribute('aria-controls')
    const menu = menuId ? document.getElementById(menuId) : null
    return trigger?.getAttribute('aria-expanded') === 'true'
      && menu instanceof HTMLElement
      && menu.getClientRects().length > 0
  }, { timeout: 10_000 }, rootSelector)
}

async function assertMenuHidden(targetPage, rootSelector) {
  await targetPage.waitForFunction((selector) => {
    const trigger = document.querySelector(`${selector} [data-bounded-select-trigger]`)
    const menuId = trigger?.getAttribute('aria-controls')
    return trigger?.getAttribute('aria-expanded') === 'false'
      && (!menuId || document.getElementById(menuId) === null)
  }, { timeout: 10_000 }, rootSelector)
}

async function assertActiveValue(targetPage, expected, label) {
  const active = await targetPage.evaluate(() => ({
    value: document.activeElement?.getAttribute('data-bounded-select-option'),
    disabled: document.activeElement?.getAttribute('aria-disabled')
  }))
  assert.equal(active.value, expected, `${label}: ${JSON.stringify(active)}`)
  assert.notEqual(active.disabled, 'true', `${label} focused a disabled option`)
}

async function assertNativeValue(targetPage, selector, expected, label) {
  const value = await targetPage.$eval(selector, (select) => select.value)
  assert.equal(value, expected, `${label}: ${value}`)
}

async function assertTriggerFocus(targetPage, rootSelector, label) {
  const focused = await targetPage.$eval(rootSelector, (root) =>
    root.querySelector('[data-bounded-select-trigger]') === document.activeElement)
  assert.equal(focused, true, `${label} did not restore trigger focus`)
}

async function assertFocusMatches(targetPage, selector, label) {
  const focused = await targetPage.$eval(selector, (node) => node === document.activeElement)
  assert.equal(focused, true, label)
}

async function capture(targetPage, name) {
  const file = path.join(runDir, `${name}.png`)
  await targetPage.screenshot({ path: file, fullPage: false })
  report.screenshots.push(file)
}

async function check(name, action) {
  const startedAt = Date.now()
  try {
    await action()
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

function writeReport() {
  const output = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(runDir, 'report.json'), output)
  writeFileSync(path.join(outputRoot, 'latest.json'), output)
}

async function waitForElectronPage(connectedBrowser, timeoutMs) {
  return waitForValue(
    async () => (await connectedBrowser.pages()).find((candidate) => candidate.url().startsWith('file:')),
    Boolean,
    timeoutMs,
    'waiting for Electron renderer page'
  )
}

async function waitForDebugPort(port, timeoutMs) {
  await waitForValue(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok
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
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${label}: ${JSON.stringify(lastValue)}`)
}

async function findFreePort(start) {
  for (let port = start; port < start + 200; port += 1) {
    if (await canListen(port)) return port
  }
  throw new Error(`no free Electron debug port from ${start}`)
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}
