#!/usr/bin/env node
import net from 'node:net'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnElectronTestProcess, terminateElectronTestProcess } from './lib/electron-test-process.mjs'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const runDir = path.join(repoRoot, 'test-results', 'work-item-transfer-ui', runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-work-item-transfer-ui-'))
const userDataDir = path.join(tempRoot, 'userData')
const sourceOutDir = path.join(repoRoot, 'out')
const isolatedOutDir = path.join(runDir, 'app', 'out')
const mainEntry = path.join(isolatedOutDir, 'main', 'index.js')
const electronBin = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const ids = { project: 'transfer-ui-project', workItem: 'transfer-ui-work-item' }
const report = { status: 'running', checks: [], screenshots: [], warnings: [] }

assert(existsSync(electronBin), 'Electron binary not found')
for (const entry of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
  assert(existsSync(path.join(sourceOutDir, entry)), `Built app entry missing: out/${entry}`)
}
mkdirSync(runDir, { recursive: true })
copyBuiltApp()

let runtime
try {
  runtime = await launchRuntime('transfer')
  await enterStudio(runtime.page)
  await check('visible Studio transfer revokes old owner and keeps responsive controls', async () => {
    await runtime.page.evaluate(async ({ projectId, workItemId }) => {
      await window.agentDesk.createProjectWorkspace({ id: projectId, name: 'Transfer UI fixture', kind: 'software' })
      await window.agentDesk.createProjectWorkItem({
        id: workItemId,
        projectId,
        title: 'Visible transfer fixture',
        owner: { type: 'human', id: 'human-a', displayName: 'Human A' },
        status: 'ready'
      })
    }, { projectId: ids.project, workItemId: ids.workItem })
    await refreshAndSelect(runtime.page)
    const row = `[data-work-item-id="${ids.workItem}"]`
    await runtime.page.waitForSelector(`${row} [data-work-item-transfer="open"]`, { visible: true, timeout: 10_000 })
    await runtime.page.click(`${row} [data-work-item-transfer="open"]`)
    await runtime.page.waitForSelector(`[data-work-item-transfer-form="${ids.workItem}"]`, { visible: true, timeout: 5_000 })

    await runtime.page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
    await runtime.page.$eval('[data-work-item-transfer-form]', (form) => form.scrollIntoView({ block: 'center' }))
    await sleep(200)
    const mobile = await runtime.page.evaluate(() => {
      const form = document.querySelector('[data-work-item-transfer-form]')
      const rect = form?.getBoundingClientRect()
      return {
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        formOverflow: form ? form.scrollWidth - form.clientWidth : -1,
        left: rect?.left ?? -1,
        right: rect?.right ?? -1,
        submitWidth: document.querySelector('[data-work-item-transfer-submit]')?.getBoundingClientRect().width ?? 0
      }
    })
    assert(mobile.documentOverflow <= 1 && mobile.formOverflow <= 1, `mobile transfer form overflowed: ${JSON.stringify(mobile)}`)
    assert(mobile.left >= 0 && mobile.right <= 390 && mobile.submitWidth > 0, `mobile transfer controls are clipped: ${JSON.stringify(mobile)}`)
    await screenshot(runtime.page, '01-transfer-form-mobile')

    await runtime.page.setViewport({ width: 1320, height: 860, deviceScaleFactor: 1 })
    await replaceInput(runtime.page, '[data-work-item-transfer-target-id]', 'human-b')
    await replaceInput(runtime.page, '[data-work-item-transfer-target-name]', 'Human B')
    await replaceInput(runtime.page, '[data-work-item-transfer-reason]', 'UI handoff regression')
    await runtime.page.click('[data-work-item-transfer-submit]')
    await runtime.page.waitForSelector('[data-work-item-transfer-form]', { hidden: true, timeout: 15_000 })
    await waitForValue(
      () => runtime.page.evaluate((id) => window.agentDesk.getProjectWorkItem(id), ids.workItem),
      (item) => item?.owner?.id === 'human-b' && !item.lease,
      15_000,
      'waiting for visible transfer persistence'
    )
    const renderedOwner = await runtime.page.$eval(`${row} [role="cell"]:nth-child(4)`, (cell) => cell.textContent?.trim())
    assert(renderedOwner === 'Human B', `Studio did not refresh the new owner: ${renderedOwner}`)
    await screenshot(runtime.page, '02-transfer-committed')
  })
  await stopRuntime(runtime)
  runtime = null

  runtime = await launchRuntime('restart')
  await enterStudio(runtime.page)
  await check('restart preserves owner Assignment history and correlated audit', async () => {
    await refreshAndSelect(runtime.page)
    const persisted = await runtime.page.evaluate(async (workItemId) => {
      const [item, history, audit] = await Promise.all([
        window.agentDesk.getProjectWorkItem(workItemId),
        window.agentDesk.listDigitalWorkerAssignmentHistory({ workItemId }),
        window.agentDesk.listDigitalWorkerAssignmentOwnerAudit()
      ])
      const active = history.find((entry) => entry.status === 'active')
      const committed = audit.find((event) =>
        event.workItemId === workItemId && event.assignmentId === active?.id && event.kind === 'coordinator.committed'
      )
      const journal = committed
        ? await window.agentDesk.getDigitalWorkerAssignmentOwnerJournal(committed.requestId)
        : null
      return { item, history, committed, journal }
    }, ids.workItem)
    assert(persisted.item?.owner?.id === 'human-b', 'restart lost the transferred owner')
    assert(persisted.history.length === 2, `restart Assignment history mismatch: ${persisted.history.length}`)
    assert(persisted.history.filter((entry) => entry.status === 'active').length === 1, 'restart did not retain one active Assignment')
    assert(persisted.committed && persisted.journal?.phase === 'committed', 'restart lost committed transfer audit/journal')
    assert(persisted.journal.releaseReason === 'UI handoff regression', 'restart lost the transfer reason')
    const row = `[data-work-item-id="${ids.workItem}"]`
    await runtime.page.waitForSelector(row, { visible: true, timeout: 10_000 })
    const renderedOwner = await runtime.page.$eval(`${row} [role="cell"]:nth-child(4)`, (cell) => cell.textContent?.trim())
    assert(renderedOwner === 'Human B', `restart UI owner mismatch: ${renderedOwner}`)
    await screenshot(runtime.page, '03-restart-owner')
  })
  report.status = 'pass'
} catch (error) {
  report.status = 'fail'
  report.error = error instanceof Error ? error.stack : String(error)
  if (runtime?.page) await screenshot(runtime.page, 'failure').catch(() => undefined)
} finally {
  if (runtime) await stopRuntime(runtime).catch(() => undefined)
  rmSync(tempRoot, { recursive: true, force: true })
}

console.log(JSON.stringify(report, null, 2))
process.exit(report.status === 'pass' ? 0 : 1)

async function launchRuntime(phase) {
  const port = await findFreePort(9960)
  const child = spawnElectronTestProcess(electronBin, [`--remote-debugging-port=${port}`, mainEntry], {
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
  const output = { stdout: '', stderr: '' }
  child.stdout.on('data', (chunk) => { output.stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => { output.stderr += chunk.toString() })
  try {
    await waitForDebugPort(port, 20_000)
    const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null })
    const page = await waitForValue(
      async () => (await browser.pages()).find((candidate) => !candidate.url().startsWith('devtools://')),
      Boolean,
      20_000,
      'waiting for Electron renderer'
    )
    page.on('pageerror', (error) => report.warnings.push(`${phase} pageerror: ${error.message}`))
    await page.setViewport({ width: 1320, height: 860, deviceScaleFactor: 1 })
    return { browser, child, output, page, phase }
  } catch (error) {
    await terminateElectronTestProcess(child)
    throw error
  }
}

async function stopRuntime(active) {
  await Promise.race([
    active.browser.close().catch(() => undefined),
    sleep(3_000)
  ])
  await terminateElectronTestProcess(active.child)
  for (const line of active.output.stderr.split('\n').filter(Boolean)) {
    if (!/DevTools listening|Autofill.enable|CONNECTION_CLOSED/.test(line)) report.warnings.push(`${active.phase}: ${line}`)
  }
}

async function enterStudio(page) {
  await page.waitForSelector('.app', { timeout: 20_000 })
  await page.waitForFunction(() => typeof window.agentDesk?.transferProjectWorkItem === 'function', { timeout: 15_000 })
  await page.click('[data-experience-mode-option="studio"]')
  await page.waitForSelector('[data-project-workspace-studio]', { visible: true, timeout: 15_000 })
  await page.waitForFunction(() => document.querySelector('[data-project-workspace-studio]')?.getAttribute('aria-busy') === 'false', { timeout: 15_000 })
}

async function refreshAndSelect(page) {
  await page.click('[data-studio-action="refresh"]')
  await page.waitForFunction(
    (projectId) => Array.from(document.querySelectorAll('[data-project-workspace-select] option')).some((option) => option.value === projectId),
    { timeout: 10_000 },
    ids.project
  )
  await page.select('[data-project-workspace-select]', ids.project)
  await page.waitForSelector(`[data-work-item-id="${ids.workItem}"]`, { visible: true, timeout: 10_000 })
}

async function replaceInput(page, selector, value) {
  await page.$eval(selector, (input) => { input.focus(); input.select() })
  await page.keyboard.type(value)
}

async function screenshot(page, name) {
  const file = path.join(runDir, `${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  report.screenshots.push(file)
}

async function check(name, execute) {
  const startedAt = Date.now()
  try {
    await execute()
    report.checks.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
  } catch (error) {
    report.checks.push({ name, status: 'fail', durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

async function waitForValue(read, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let value
  while (Date.now() < deadline) {
    value = await read()
    if (predicate(value)) return value
    await sleep(100)
  }
  throw new Error(`${label} timed out; last value: ${JSON.stringify(value)}`)
}

function findFreePort(start) {
  return new Promise((resolve, reject) => {
    const probe = (port) => {
      const server = net.createServer()
      server.once('error', () => probe(port + 1))
      server.once('listening', () => server.close(() => resolve(port)))
      server.listen(port, '127.0.0.1')
    }
    probe(start)
    setTimeout(() => reject(new Error('no free debugging port')), 10_000).unref()
  })
}

function waitForDebugPort(port, timeoutMs) {
  return waitForValue(
    () => new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1')
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => resolve(false))
    }),
    Boolean,
    timeoutMs,
    'waiting for Electron debug port'
  )
}

function copyBuiltApp() {
  rmSync(isolatedOutDir, { recursive: true, force: true })
  mkdirSync(isolatedOutDir, { recursive: true })
  for (const directory of ['main', 'preload', 'renderer']) {
    cpSync(path.join(sourceOutDir, directory), path.join(isolatedOutDir, directory), { recursive: true })
  }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
function assert(value, message) { if (!value) throw new Error(message) }
