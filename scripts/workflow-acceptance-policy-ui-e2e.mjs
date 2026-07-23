#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const packageJson = require(path.join(repoRoot, 'package.json'))
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const outputRoot = path.join(repoRoot, 'test-results', 'workflow-acceptance-policy-ui')
const runDir = path.join(outputRoot, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-acceptance-policy-ui-'))
const userDataDir = path.join(tempRoot, 'userData')
const memoryDir = path.join(tempRoot, 'memory')
const sourceOutDir = path.join(repoRoot, 'out')
const mainEntry = path.join(sourceOutDir, 'main', 'index.js')
const electronBin = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')

const ids = {
  project: 'ui-policy-project',
  workItem: 'ui-policy-work-item'
}
let acceptanceId = ''

const report = {
  schemaVersion: 1,
  runId,
  runDir,
  requirement: 'required',
  packageVersion: packageJson.version,
  gitCommit: '',
  worktreeClean: false,
  checks: [],
  screenshots: [],
  warnings: []
}

let electron
let browser
let page

assert(existsSync(electronBin), 'Electron binary not found. Run npm install first.')
assert(existsSync(mainEntry), 'Built app entry missing. Run npm run build first.')
mkdirSync(runDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
mkdirSync(memoryDir, { recursive: true })

try {
  const port = await findFreePort(9860)
  electron = spawn(electronBin, [`--remote-debugging-port=${port}`, mainEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAOGEN_USER_DATA_DIR: userDataDir,
      CAOGEN_MEMORY_DIR: memoryDir,
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  electron.stderr.on('data', (chunk) => { stderr += chunk.toString() })

  await waitForDebugPort(port, 20_000)
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null })
  page = await waitForPage(browser, 20_000)
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      report.warnings.push(`console ${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => report.warnings.push(`pageerror: ${error.message}`))
  await waitForApp(page)

  await check('canonical Project and WorkItem are available to the Ledger UI', async () => {
    const created = await page.evaluate(async (input) => {
      const project = await window.agentDesk.createProjectWorkspace({
        id: input.projectId,
        name: 'Acceptance Policy UI Project',
        kind: 'software'
      })
      const workItem = await window.agentDesk.createProjectWorkItem({
        id: input.workItemId,
        projectId: input.projectId,
        title: 'Author acceptance policy',
        type: 'testing',
        description: 'UI authoring smoke fixture'
      })
      return { project, workItem }
    }, { projectId: ids.project, workItemId: ids.workItem })
    assert(created.project?.id === ids.project, `project was not created: ${JSON.stringify(created.project)}`)
    assert(created.workItem?.id === ids.workItem, `work item was not created: ${JSON.stringify(created.workItem)}`)
  })

  await openWorkflowLedger()
  await check('authoring form creates a multi-criterion kind/source policy', async () => {
    await clickText('新建验收')
    await page.waitForSelector('.workflow-acceptance-authoring', { visible: true, timeout: 8_000 })
    const fields = await page.$$('.workflow-criterion-editor')
    assert(fields.length === 1, `expected one initial criterion, got ${fields.length}`)
    await page.type('.workflow-criterion-input', 'Build output is present and reproducible')
    await clickText('添加 criterion', '.workflow-acceptance-authoring')
    await page.waitForFunction(() => document.querySelectorAll('.workflow-criterion-editor').length === 2)
    const inputs = await page.$$('.workflow-criterion-input')
    await inputs[1].type('A reviewer confirms the release evidence')
    const selects = await page.$$('.workflow-criterion-editor select')
    await selects[1].select('review_result')
    await toggleSource(0, 'human')
    await toggleSource(1, 'human')

    const before = await readLedgerAcceptanceCount()
    await clearSources(0)
    await clickText('保存 pending Acceptance', '.workflow-acceptance-authoring')
    await page.waitForFunction(
      () => document.querySelector('.workflow-acceptance-authoring')?.textContent?.includes('至少需要一个允许的 Evidence source') === true,
      { timeout: 5_000 }
    )
    assert(await readLedgerAcceptanceCount() === before, 'invalid empty-source submission mutated the ledger')
    await toggleSource(0, 'runtime')
    await toggleSource(0, 'human')

    await clickText('保存 pending Acceptance', '.workflow-acceptance-authoring')
    await page.waitForFunction(
      () => document.querySelector('.workflow-acceptance-authoring')?.textContent?.includes('已创建 pending Acceptance') === true,
      { timeout: 8_000 }
    )
    const persisted = await readAcceptance()
    acceptanceId = persisted?.id || ''
    assert(acceptanceId, 'saved acceptance id is missing')
    assert(persisted?.status === 'pending', `unexpected acceptance status: ${JSON.stringify(persisted)}`)
    assert(persisted.criteria?.length === 2, `criterion count was not persisted: ${JSON.stringify(persisted)}`)
    assert(persisted.criterionPolicies?.length === 2, `policy count was not persisted: ${JSON.stringify(persisted)}`)
    assert(persisted.criterionPolicies[0].evidenceKind === 'test_result', 'first kind was not persisted')
    assert(persisted.criterionPolicies[1].evidenceKind === 'review_result', 'second kind was not persisted')
    assert(persisted.criterionPolicies.every((policy) => policy.allowedSources.includes('runtime') && policy.allowedSources.includes('human')), 'source policy was not persisted')
    await capture('created')
  })

  await check('review UI records matching Evidence and passes every criterion', async () => {
    const rowSelector = `[data-acceptance-review="${acceptanceId}"]`
    await page.waitForSelector(`${rowSelector} [data-acceptance-add-evidence]`, { visible: true, timeout: 8_000 })
    await page.click(`${rowSelector} [data-acceptance-add-evidence]`)
    await page.type(`${rowSelector} [data-acceptance-evidence-title]`, 'Build verification report')
    await page.type(`${rowSelector} [data-acceptance-evidence-summary]`, 'Required build completed with deterministic output')
    await page.select(`${rowSelector} [data-acceptance-evidence-kind]`, 'test_result')
    await page.click(`${rowSelector} [data-acceptance-save-evidence]`)
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.textContent?.includes('Build verification report') === true,
      { timeout: 8_000 },
      `${rowSelector} .workflow-criterion-review:nth-of-type(1)`
    )

    await page.click(`${rowSelector} [data-acceptance-add-evidence]`)
    await page.type(`${rowSelector} [data-acceptance-evidence-title]`, 'Human release review')
    await page.type(`${rowSelector} [data-acceptance-evidence-summary]`, 'Reviewer confirmed the release evidence package')
    await page.select(`${rowSelector} [data-acceptance-evidence-kind]`, 'review_result')
    await page.click(`${rowSelector} [data-acceptance-save-evidence]`)
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.textContent?.includes('Human release review') === true,
      { timeout: 8_000 },
      `${rowSelector} .workflow-criterion-review:nth-of-type(2)`
    )

    const criterionRows = await page.$$(`${rowSelector} .workflow-criterion-review`)
    assert(criterionRows.length === 2, `expected two review criteria, got ${criterionRows.length}`)
    for (const criterionRow of criterionRows) {
      const checkbox = await criterionRow.$('input[type="checkbox"]')
      assert(checkbox, 'matching Evidence checkbox was not rendered')
      await checkbox.click()
    }
    await page.click(`${rowSelector} [data-acceptance-decision="passed"]`)
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.textContent?.includes('passed') === true,
      { timeout: 10_000 },
      rowSelector
    )
    const passed = await readAcceptance()
    assert(passed?.status === 'passed', `review did not pass Acceptance: ${JSON.stringify(passed)}`)
    assert(passed.evidenceRefs?.length === 2, `review did not link both Evidence records: ${JSON.stringify(passed)}`)
    await capture('reviewed')
  })

  await check('policy remains visible and identical after renderer restart', async () => {
    const expected = await readAcceptance()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await openWorkflowLedger()
    await page.waitForFunction(
      () => document.querySelector('.workflow-acceptance-list')?.textContent?.includes('Acceptance policies') === true,
      { timeout: 8_000 }
    )
    const actual = await readAcceptance()
    assert(JSON.stringify(actual) === JSON.stringify(expected), 'acceptance policy changed across restart')
    const rowText = await page.$eval('.workflow-acceptance-row', (node) => node.textContent || '')
    for (const token of ['test_result', 'review_result', 'runtime', 'human']) {
      assert(rowText.includes(token), `policy presentation omitted ${token}: ${rowText}`)
    }
    await capture('restarted')
  })

  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.stack || error.message : String(error)
  if (page) await capture('failure').catch(() => undefined)
  process.exitCode = 1
} finally {
  if (browser) await browser.disconnect().catch(() => undefined)
  if (electron) await terminate(electron)
  report.gitCommit = readGitCommit()
  report.worktreeClean = readWorktreeClean()
  writeFileSync(path.join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  rmSync(tempRoot, { recursive: true, force: true })
  console.log(`workflow acceptance policy UI E2E: ${report.status || 'failed'}`)
  console.log(`report: ${path.join(runDir, 'report.json')}`)
  if (report.error) console.error(report.error)
  if (report.warnings.length > 0) console.log(`warnings: ${report.warnings.length}`)
}

async function openWorkflowLedger() {
  await clickText('设置')
  await page.waitForSelector('.settings-page', { visible: true, timeout: 8_000 })
  const controlTab = await page.$('[data-settings-tab="control"]')
  if (controlTab) await controlTab.click()
  await page.waitForSelector('.workflow-ledger-panel', { visible: true, timeout: 12_000 })
  await page.waitForFunction(
    () => document.querySelector('.workflow-ledger-list')?.textContent?.includes('Author acceptance policy') === true,
    { timeout: 12_000 }
  )
}

async function toggleSource(index, source) {
  const changed = await page.evaluate(({ index, source }) => {
    const editor = document.querySelectorAll('.workflow-criterion-editor')[index]
    const label = [...(editor?.querySelectorAll('.workflow-policy-source') ?? [])]
      .find((candidate) => candidate.textContent?.trim() === source)
    const input = label?.querySelector('input[type="checkbox"]')
    if (!input) return false
    input.click()
    return true
  }, { index, source })
  assert(changed, `source checkbox missing: criterion ${index + 1} ${source}`)
  await sleep(100)
}

async function clearSources(index) {
  await page.evaluate((index) => {
    const editor = document.querySelectorAll('.workflow-criterion-editor')[index]
    for (const input of editor?.querySelectorAll('input[type="checkbox"]') ?? []) {
      if (input.checked) input.click()
    }
  }, index)
  await sleep(100)
}

async function readAcceptance() {
  return page.evaluate(async ({ id, workItemId }) => {
    const ledger = await window.agentDesk.listWorkflowLedger({ limit: 25 })
    return ledger.acceptances.items.find((item) => (id ? item.id === id : item.workItemId === workItemId)) ?? null
  }, { id: acceptanceId, workItemId: ids.workItem })
}

async function readLedgerAcceptanceCount() {
  return page.evaluate(async () => (await window.agentDesk.listWorkflowLedger({ limit: 25 })).acceptances.total)
}

async function clickText(text, scope = 'body') {
  const result = await page.evaluate(({ text, scope }) => {
    const root = document.querySelector(scope) || document.body
    const element = [...root.querySelectorAll('button, [role="button"]')]
      .find((candidate) => (candidate.textContent || '').replace(/\s+/g, ' ').trim().includes(text))
    if (!element) return false
    element.scrollIntoView({ block: 'center', inline: 'center' })
    element.click()
    return true
  }, { text, scope })
  assert(result, `button not found: ${text}`)
  await sleep(180)
}

async function waitForApp(targetPage) {
  await targetPage.waitForSelector('#root', { timeout: 15_000 })
  await targetPage.waitForFunction(() => document.body.innerText.length > 20, { timeout: 15_000 })
}

async function capture(label) {
  if (!page) return
  const file = path.join(runDir, `${label}.png`)
  await page.screenshot({ path: file, fullPage: false })
  report.screenshots.push(file)
}

async function check(name, action) {
  const startedAt = Date.now()
  try {
    await action()
    report.checks.push({ name, status: 'passed', durationMs: Date.now() - startedAt })
  } catch (error) {
    report.checks.push({ name, status: 'failed', durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

async function waitForPage(browserInstance, timeout) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    const pages = await browserInstance.pages()
    const candidate = pages.find((item) => item.url().startsWith('file://') || item.url().startsWith('http://'))
    if (candidate) return candidate
    await sleep(200)
  }
  throw new Error('Electron renderer page did not appear')
}

async function waitForDebugPort(port, timeout) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return
    } catch {
      // Electron is still booting.
    }
    await sleep(200)
  }
  throw new Error(`Electron remote debugging port ${port} did not open`)
}

async function findFreePort(start) {
  for (let port = start; port < start + 100; port += 1) {
    const free = await new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => server.close(() => resolve(true)))
      server.listen(port, '127.0.0.1')
    })
    if (free) return port
  }
  throw new Error(`no free port from ${start}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function readGitCommit() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim() } catch { return '' }
}

function readWorktreeClean() {
  try {
    execFileSync('git', ['diff', '--quiet'], { cwd: repoRoot, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

async function terminate(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(undefined) }, 3_000)
    child.once('exit', () => { clearTimeout(timer); resolve(undefined) })
  })
}
