#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const packageJson = require(path.join(repoRoot, 'package.json'))
const electronPackage = require('electron/package.json')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const outputRoot = path.join(repoRoot, 'test-results', 'workitem-board')
const runDir = path.join(outputRoot, runId)
const reportPath = path.join(runDir, 'report.json')
const latestPath = path.join(outputRoot, 'latest.json')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-workitem-board-'))
const domainOutDir = path.join(tempRoot, 'domain-compiled')
const domainDataDir = path.join(tempRoot, 'domain-data')
const userDataDir = path.join(tempRoot, 'electron-user-data')
const sourceOutDir = path.join(repoRoot, 'out')
const isolatedOutDir = path.join(runDir, 'app', 'out')
const mainEntry = path.join(isolatedOutDir, 'main', 'index.js')
const electronBin = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const projectId = 'workitem-board-project'
const ITEM_COUNT = 1000

const report = {
  schemaVersion: 1,
  status: 'running',
  requirement: 'WORK-002',
  gate: 'test:workitem-board:required',
  runId,
  packageVersion: packageJson.version,
  git: gitState(),
  environment: {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    electronVersion: electronPackage.version
  },
  checks: [],
  phases: [],
  screenshots: [],
  warnings: [],
  coverage: {
    verified: [
      'canonical WorkItem ID and field parity across List and Board production projections',
      'search, status, Goal, and owner filtering controls',
      'revision-guarded durable reorder semantics independent from priority',
      'fixed-size windowed rendering with 1,000 canonical WorkItems',
      'WorkItem order plus List/Board filter and view consistency across Electron restart'
    ],
    explicitlyNotVerified: [
      'multi-user remote synchronization',
      'drag-and-drop pointer interaction; keyboard-accessible move controls are the 1.0 reorder surface',
      'NFR-PERF-002 P95 latency below one second; this gate proves structural windowing, not latency SLO closure'
    ]
  }
}

let activeRuntime
mkdirSync(runDir, { recursive: true })

try {
  assertGateDefinition()
  await runDomainChecks()
  prepareElectronFixture()
  assertBuildInputs()
  copyBuiltApp()

  await runElectronPhase('list-board-1000', async (page) => {
    await check('List renders a bounded fixed-height window over 1,000 canonical WorkItems', async () => {
      const metrics = await page.$eval('[data-work-item-surface="list"]', (element) => ({
        total: Number(element.getAttribute('data-total-work-items')),
        rendered: Number(element.getAttribute('data-rendered-work-items')),
        height: element.getBoundingClientRect().height,
        rows: [...element.querySelectorAll('[data-work-item-id]')].map((row) => row.getBoundingClientRect().height)
      }))
      assert(metrics.total === ITEM_COUNT, `List total mismatch: ${metrics.total}`)
      assert(metrics.rendered > 0 && metrics.rendered < 30, `List did not window DOM rows: ${metrics.rendered}`)
      assert(metrics.height === 604, `List viewport height changed: ${metrics.height}`)
      assert(metrics.rows.every((height) => height === 110), `List rows are not fixed at 110px: ${metrics.rows.join(',')}`)
    })

    await check('filtering after a deep virtual scroll resets to the first matching WorkItem', async () => {
      await page.$eval('[data-work-item-surface="list"]', (element) => {
        element.scrollTop = element.scrollHeight
        element.dispatchEvent(new Event('scroll', { bubbles: true }))
      })
      await page.waitForFunction(() => {
        const first = document.querySelector('[data-work-item-surface="list"] [data-work-item-id]')
        return first?.getAttribute('data-work-item-id') !== 'work-item-0000'
      }, { timeout: 30_000 })
      await page.select('[data-work-item-filter="status"]', 'blocked')
      await waitForTotal(page, 'list', 250)
      await page.waitForFunction(() => {
        const surface = document.querySelector('[data-work-item-surface="list"]')
        const first = surface?.querySelector('[data-work-item-id]')
        return surface?.scrollTop === 0 && first?.getAttribute('data-work-item-id') === 'work-item-0001'
      }, { timeout: 30_000 })
      await page.click('[data-work-item-filter="clear"]')
      await waitForTotal(page, 'list', ITEM_COUNT)
    })
  })

  await runElectronPhase('filters-reorder-board', async (page) => {
    await check('search, status, Goal, and owner filters operate on the canonical projection', async () => {
      await page.type('[data-work-item-filter="query"]', 'Board item 0999')
      await waitForRenderedIds(page, ['work-item-0999'])
      await page.click('[data-work-item-filter="clear"]')
      await waitForTotal(page, 'list', ITEM_COUNT)

      await page.select('[data-work-item-filter="status"]', 'blocked')
      await waitForTotal(page, 'list', 250)
      await page.select('[data-work-item-filter="owner"]', 'human')
      await waitForTotal(page, 'list', 84)
      const filtered = await page.$$eval('[data-work-item-surface="list"] [data-work-item-id]', (rows) =>
        rows.map((row) => ({ status: row.getAttribute('data-status'), owner: row.getAttribute('data-owner-id') })))
      assert(filtered.length > 0, 'filtered List rendered no rows')
      assert(filtered.every((item) => item.status === 'blocked' && item.owner.startsWith('human-')), 'filter result leaked non-matching fields')

      await page.click('[data-work-item-filter="clear"]')
      await waitForTotal(page, 'list', ITEM_COUNT)
      await page.select('[data-work-item-filter="goal"]', 'workitem-board-goal')
      await waitForTotal(page, 'list', 100)
      await page.select('[data-work-item-filter="goal"]', 'none')
      await waitForTotal(page, 'list', 900)
      await page.click('[data-work-item-filter="clear"]')
      await waitForTotal(page, 'list', ITEM_COUNT)
    })

    await check('revision-guarded reorder persists without changing priority or status', async () => {
      const before = await page.evaluate(async () => ({
        first: await window.agentDesk.getProjectWorkItem('work-item-0000'),
        second: await window.agentDesk.getProjectWorkItem('work-item-0001')
      }))
      await page.click('[data-work-item-id="work-item-0001"] [data-work-item-reorder="up"]')
      await page.waitForFunction(async () => {
        const [first, second] = await Promise.all([
          window.agentDesk.getProjectWorkItem('work-item-0000'),
          window.agentDesk.getProjectWorkItem('work-item-0001')
        ])
        return Boolean(first && second && second.boardOrder < first.boardOrder)
      }, { timeout: 60_000 })
      const after = await page.evaluate(async () => ({
        first: await window.agentDesk.getProjectWorkItem('work-item-0000'),
        second: await window.agentDesk.getProjectWorkItem('work-item-0001')
      }))
      assert(after.second.revision === before.second.revision + 1, 'reorder did not increment the moved WorkItem revision exactly once')
      assert(after.second.priority === before.second.priority, 'reorder changed business priority')
      assert(after.second.status === before.second.status, 'reorder changed workflow status')
      report.reorder = {
        itemId: after.second.id,
        targetId: after.first.id,
        placement: 'before',
        boardOrder: after.second.boardOrder,
        revision: after.second.revision
      }
    })

    await check('List and Board expose identical canonical identity fields', async () => {
      const listProjection = await readRenderedProjection(page, 'work-item-0000')
      await page.click('[data-view-option="board"]')
      await page.waitForSelector('[data-work-item-surface="board-backlog"]')
      const boardProjection = await readRenderedProjection(page, 'work-item-0000')
      assertDeepEqual(boardProjection, listProjection, 'List/Board canonical projection differs')
      const canonical = await page.evaluate(() => window.agentDesk.getProjectWorkItem('work-item-0000'))
      assert(boardProjection.id === canonical.id, 'renderer ID differs from canonical WorkItem')
      assert(boardProjection.revision === String(canonical.revision), 'renderer revision differs from canonical WorkItem')
      assert(boardProjection.boardOrder === String(canonical.boardOrder), 'renderer boardOrder differs from canonical WorkItem')
      assert(boardProjection.priority === String(canonical.priority), 'renderer priority differs from canonical WorkItem')
    })

    await check('Board windows every status column and keeps aggregate DOM bounded', async () => {
      const metrics = await page.$$eval('[data-work-item-surface^="board-"]', (surfaces) => ({
        total: surfaces.reduce((sum, surface) => sum + Number(surface.getAttribute('data-total-work-items')), 0),
        rendered: surfaces.reduce((sum, surface) => sum + Number(surface.getAttribute('data-rendered-work-items')), 0),
        cardHeights: surfaces.flatMap((surface) => [...surface.querySelectorAll('[data-work-item-id]')].map((card) => card.getBoundingClientRect().height))
      }))
      assert(metrics.total === ITEM_COUNT, `Board aggregate total mismatch: ${metrics.total}`)
      assert(metrics.rendered > 0 && metrics.rendered < 80, `Board DOM is not bounded: ${metrics.rendered}`)
      assert(metrics.cardHeights.every((height) => height === 262), `Board cards are not fixed at 262px: ${metrics.cardHeights.join(',')}`)
      await screenshot(page, 'workitem-board-1000')
    })

    await check('view and filters are stored for restart without mutating WorkItems', async () => {
      await page.select('[data-work-item-filter="status"]', 'blocked')
      await waitForTotal(page, 'board-blocked', 250)
      const stored = await page.evaluate((id) => ({
        view: window.localStorage.getItem('caogen.project-workspace.work-items.view.v1'),
        filters: window.localStorage.getItem(`caogen.project-workspace.work-items.filters.v1:${id}`)
      }), projectId)
      assert(stored.view === 'board', `stored view mismatch: ${stored.view}`)
      assert(JSON.parse(stored.filters).status === 'blocked', `stored status filter mismatch: ${stored.filters}`)
    })
  })

  await runElectronPhase('restart-consistency', async (page) => {
    await check('Board view and filter state survive a full Electron restart', async () => {
      const mode = await page.$eval('[data-work-item-view]', (element) => element.getAttribute('data-work-item-view'))
      const status = await page.$eval('[data-work-item-filter="status"]', (element) => element.value)
      assert(mode === 'board', `view did not survive restart: ${mode}`)
      assert(status === 'blocked', `filter did not survive restart: ${status}`)
      await waitForTotal(page, 'board-blocked', 250)
    })

    await check('canonical reorder survives restart and remains visible in List order', async () => {
      const canonical = await page.evaluate(async () => ({
        first: await window.agentDesk.getProjectWorkItem('work-item-0000'),
        second: await window.agentDesk.getProjectWorkItem('work-item-0001')
      }))
      assert(canonical.second.boardOrder < canonical.first.boardOrder, 'canonical boardOrder reverted after restart')
      await page.click('[data-work-item-filter="clear"]')
      await page.click('[data-view-option="list"]')
      await waitForTotal(page, 'list', ITEM_COUNT)
      const firstRendered = await page.$eval('[data-work-item-surface="list"] [data-work-item-id]', (element) => element.getAttribute('data-work-item-id'))
      assert(firstRendered === 'work-item-0001', `List order reverted after restart: ${firstRendered}`)
      const persisted = JSON.parse(readFileSync(path.join(userDataDir, 'project-workspace.json'), 'utf8'))
      const first = persisted.workItems.find((item) => item.id === 'work-item-0000')
      const second = persisted.workItems.find((item) => item.id === 'work-item-0001')
      assert(second.boardOrder < first.boardOrder, 'durable JSON source lost reordered boardOrder')
    })
  })

  report.status = 'pass'
  report.conclusion = 'WORK-002 required gate passed with domain, production IPC/renderer, 1,000-item windowing, and restart evidence.'
} catch (error) {
  report.status = 'fail'
  report.error = error instanceof Error ? error.stack ?? error.message : String(error)
  report.conclusion = 'WORK-002 required gate failed closed.'
} finally {
  if (activeRuntime) await stopRuntime(activeRuntime).catch(() => undefined)
  writeReport()
  rmSync(tempRoot, { recursive: true, force: true })
}

if (report.status === 'pass') {
  console.log(`workitem board required ok: ${reportPath}`)
  console.log(`${report.checks.length}/${report.checks.length} checks passed across domain and ${report.phases.length} Electron launches`)
} else {
  console.error(`workitem board required failed: ${report.error || 'unknown failure'}`)
  console.error(`report: ${reportPath}`)
}
process.exit(report.status === 'pass' ? 0 : 1)

function assertGateDefinition() {
  const matrix = readFileSync(path.join(repoRoot, 'docs', '1.0-ACCEPTANCE-MATRIX.md'), 'utf8')
  assert(matrix.includes('`WORK-002`') && matrix.includes('test:workitem-board:required'), 'WORK-002 acceptance gate declaration is missing')
}

async function runDomainChecks() {
  compileDomainSources()
  installElectronStub()
  const api = await import(pathToFileURL(findCompiled(domainOutDir, 'index.js')).href)
  const store = new api.ProjectWorkspaceStore(domainDataDir)
  await store.open()
  const workspace = await store.createWorkspace({ id: 'domain-project', name: 'Board domain', kind: 'software' })
  const foreign = await store.createWorkspace({ id: 'foreign-project', name: 'Foreign', kind: 'software' })
  const first = await store.createWorkItem({ id: 'domain-first', projectId: workspace.id, title: 'First', priority: 99 })
  const second = await store.createWorkItem({ id: 'domain-second', projectId: workspace.id, title: 'Second', priority: 1 })
  const third = await store.createWorkItem({ id: 'domain-third', projectId: workspace.id, title: 'Third', priority: 50 })
  const foreignItem = await store.createWorkItem({ id: 'domain-foreign', projectId: foreign.id, title: 'Foreign item' })
  assert(first.boardOrder < second.boardOrder && second.boardOrder < third.boardOrder, 'create did not assign stable sparse boardOrder')

  const moved = await store.reorderWorkItem(third.id, first.id, 'before', { expectedRevision: third.revision })
  assert(moved.boardOrder < first.boardOrder, 'before reorder did not place item before target')
  assert(moved.priority === third.priority && moved.status === third.status, 'reorder changed business fields')
  await assertRejects(
    store.reorderWorkItem(third.id, second.id, 'after', { expectedRevision: third.revision }),
    (error) => error?.code === 'stale_revision',
    'stale reorder must fail closed'
  )
  await assertRejects(
    store.reorderWorkItem(first.id, foreignItem.id, 'before', { expectedRevision: first.revision }),
    (error) => error?.code === 'cross_project',
    'cross-project reorder must fail closed'
  )
  const cancelled = await store.transitionWorkItem(first.id, 'cancelled', { expectedRevision: first.revision })
  const terminalMoved = await store.reorderWorkItem(cancelled.id, second.id, 'after', { expectedRevision: cancelled.revision })
  assert(terminalMoved.status === 'cancelled', 'terminal reorder changed status')

  const reopened = new api.ProjectWorkspaceStore(domainDataDir)
  await reopened.open()
  const durable = (await reopened.listWorkItems(workspace.id)).sort(compareBoardOrder)
  assertDeepEqual(durable.map((item) => item.id), ['domain-third', 'domain-second', 'domain-first'], 'domain order did not survive reopen')

  const legacyRoot = path.join(tempRoot, 'legacy-v1-data')
  mkdirSync(legacyRoot, { recursive: true })
  const legacyState = JSON.parse(readFileSync(path.join(domainDataDir, 'project-workspace.json'), 'utf8'))
  legacyState.workItems.forEach((item) => { delete item.boardOrder })
  writeFileSync(path.join(legacyRoot, 'project-workspace.json'), `${JSON.stringify(legacyState)}\n`, { mode: 0o600 })
  const legacy = new api.ProjectWorkspaceStore(legacyRoot)
  await legacy.open()
  const firstLegacyRead = (await legacy.listWorkItems(workspace.id)).sort(compareBoardOrder).map((item) => item.id)
  const secondLegacyRead = (await legacy.listWorkItems(workspace.id)).sort(compareBoardOrder).map((item) => item.id)
  assert(firstLegacyRead.length === 3, 'legacy v1 WorkItems without boardOrder were not readable')
  assertDeepEqual(secondLegacyRead, firstLegacyRead, 'legacy v1 fallback order is not deterministic')
  report.checks.push({
    name: 'domain reorder enforces CAS, project boundary, field preservation, terminal support, reopen durability, and legacy v1 fallback',
    status: 'pass'
  })
}

function prepareElectronFixture() {
  mkdirSync(userDataDir, { recursive: true })
  const now = Date.now()
  const statuses = ['backlog', 'blocked', 'failed', 'cancelled']
  const workItems = Array.from({ length: ITEM_COUNT }, (_, index) => {
    const ownerKind = index % 3
    const owner = ownerKind === 0
      ? undefined
      : ownerKind === 1
        ? { type: 'human', id: `human-${String(index).padStart(4, '0')}`, displayName: `Human ${index}` }
        : { type: 'digital_worker', id: `worker-${String(index).padStart(4, '0')}`, displayName: `Worker ${index}` }
    return {
      schemaVersion: 1,
      id: `work-item-${String(index).padStart(4, '0')}`,
      projectId,
      goalId: index % 10 === 0 ? 'workitem-board-goal' : undefined,
      type: index % 2 === 0 ? 'coding' : 'testing',
      title: `Board item ${String(index).padStart(4, '0')}`,
      description: `Canonical renderer fixture ${index}`,
      dependencyIds: [],
      priority: index % 7,
      boardOrder: (index + 1) * 1024,
      owner,
      status: statuses[index % statuses.length],
      acceptanceSpec: [],
      artifactRefs: [],
      runRefs: [],
      createdAt: now + index,
      updatedAt: now + index,
      revision: 1
    }
  })
  const state = {
    schemaVersion: 1,
    revision: ITEM_COUNT + 1,
    workspaces: [{
      schemaVersion: 1,
      id: projectId,
      name: 'WorkItem Board 1000',
      kind: 'software',
      status: 'active',
      resources: [],
      createdAt: now,
      updatedAt: now,
      revision: 1
    }],
    goals: [{
      schemaVersion: 1,
      id: 'workitem-board-goal',
      projectId,
      title: 'Board linked Goal',
      objective: 'Verify linked Goal filtering',
      constraints: [],
      successCriteria: [],
      riskLevel: 'medium',
      forbiddenActions: [],
      acceptance: [],
      contract: {
        objective: 'Verify linked Goal filtering',
        constraints: [],
        successCriteria: [],
        riskLevel: 'medium',
        forbiddenActions: [],
        acceptance: []
      },
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      revision: 1
    }],
    workItems,
    events: []
  }
  writeFileSync(path.join(userDataDir, 'project-workspace.json'), `${JSON.stringify(state)}\n`, { mode: 0o600 })
}

async function runElectronPhase(name, execute) {
  const startedAt = Date.now()
  activeRuntime = await launchRuntime(name)
  try {
    await enterStudio(activeRuntime.page)
    await execute(activeRuntime.page)
    report.phases.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
  } catch (error) {
    await screenshot(activeRuntime.page, `failure-${name}`).catch(() => undefined)
    report.phases.push({ name, status: 'fail', durationMs: Date.now() - startedAt, error: safeError(error) })
    throw error
  } finally {
    await stopRuntime(activeRuntime)
    activeRuntime = null
  }
}

async function launchRuntime(phase) {
  const port = await findFreePort(10040)
  const child = spawn(electronBin, [`--remote-debugging-port=${port}`, mainEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAOGEN_USER_DATA_DIR: userDataDir,
      CAOGEN_MEMORY_DIR: path.join(tempRoot, 'memory'),
      CAOGEN_PROJECT_WORKSPACE_READ_MODE: 'canonical',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const output = { stdout: '', stderr: '' }
  child.stdout.on('data', (chunk) => { output.stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => { output.stderr += chunk.toString() })
  try {
    await waitForDebugPort(port, 30_000)
    const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null })
    const page = await waitForValue(
      async () => (await browser.pages()).find((candidate) => !candidate.url().startsWith('devtools://')),
      Boolean,
      30_000,
      'waiting for Electron renderer page'
    )
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') report.warnings.push(`${phase} console ${message.type()}: ${message.text()}`)
    })
    page.on('pageerror', (error) => report.warnings.push(`${phase} pageerror: ${error.message}`))
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    return { browser, child, output, page, phase }
  } catch (error) {
    await terminate(child)
    throw error
  }
}

async function enterStudio(page) {
  await page.waitForSelector('.app', { timeout: 30_000 })
  await page.waitForFunction(() => typeof window.agentDesk?.listProjectWorkItems === 'function', { timeout: 30_000 })
  await page.click('[data-experience-mode-option="studio"]')
  await page.waitForSelector('[data-project-workspace-studio]', { visible: true, timeout: 30_000 })
  await page.waitForFunction(
    () => document.querySelector('[data-project-workspace-studio]')?.getAttribute('aria-busy') === 'false',
    { timeout: 90_000 }
  )
  await page.waitForSelector('[data-work-item-surface]', { timeout: 90_000 })
}

async function check(name, execute) {
  const startedAt = Date.now()
  try {
    await execute()
    report.checks.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
  } catch (error) {
    report.checks.push({ name, status: 'fail', durationMs: Date.now() - startedAt, error: safeError(error) })
    throw error
  }
}

async function waitForTotal(page, surface, total) {
  await page.waitForFunction(
    ({ surface, total }) => Number(document.querySelector(`[data-work-item-surface="${surface}"]`)?.getAttribute('data-total-work-items')) === total,
    { timeout: 30_000 },
    { surface, total }
  )
}

async function waitForRenderedIds(page, expected) {
  await page.waitForFunction(
    (ids) => {
      const rendered = [...document.querySelectorAll('[data-work-item-surface="list"] [data-work-item-id]')]
        .map((element) => element.getAttribute('data-work-item-id'))
      return JSON.stringify(rendered) === JSON.stringify(ids)
    },
    { timeout: 30_000 },
    expected
  )
}

async function readRenderedProjection(page, id) {
  return page.$eval(`[data-work-item-id="${id}"]`, (element) => ({
    id: element.getAttribute('data-work-item-id'),
    status: element.getAttribute('data-status'),
    revision: element.getAttribute('data-work-item-revision'),
    boardOrder: element.getAttribute('data-board-order'),
    goalId: element.getAttribute('data-goal-id'),
    ownerId: element.getAttribute('data-owner-id'),
    priority: element.getAttribute('data-priority'),
    title: element.querySelector('strong')?.textContent?.trim() || ''
  }))
}

function compileDomainSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/shared/project-workspace-types.ts',
    'src/main/project-workspace/store.ts',
    'src/main/project-workspace/index.ts',
    '--outDir', domainOutDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'pipe' })
}

function installElectronStub() {
  const electronDir = path.join(domainOutDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), `export const app = { getPath: () => ${JSON.stringify(domainDataDir)} }\n`)
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

function findCompiled(root, name) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiled(fullPath, name)
      if (found) return found
    } else if (entry.isFile() && entry.name === name) {
      return fullPath
    }
  }
  return null
}

function assertBuildInputs() {
  assert(existsSync(electronBin), 'Electron binary not found. Run npm install first.')
  for (const entry of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
    assert(existsSync(path.join(sourceOutDir, entry)), `Built app entry missing: out/${entry}`)
  }
}

function copyBuiltApp() {
  rmSync(isolatedOutDir, { recursive: true, force: true })
  mkdirSync(isolatedOutDir, { recursive: true })
  for (const directory of ['main', 'preload', 'renderer']) {
    cpSync(path.join(sourceOutDir, directory), path.join(isolatedOutDir, directory), { recursive: true })
  }
}

async function screenshot(page, name) {
  const file = path.join(runDir, `${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  report.screenshots.push(file)
}

async function stopRuntime(runtime) {
  const browserClosed = await Promise.race([
    runtime.browser.close().then(() => true).catch(() => false),
    sleep(3000).then(() => false)
  ])
  const cleanExit = browserClosed ? await waitForChildExit(runtime.child, 2500) : null
  const exited = cleanExit ?? await terminate(runtime.child)
  if (runtime.output.stderr.trim()) report.warnings.push(`${runtime.phase} stderr tail:\n${runtime.output.stderr.trim().slice(-1500)}`)
  if (runtime.output.stdout.trim()) report.warnings.push(`${runtime.phase} stdout tail:\n${runtime.output.stdout.trim().slice(-800)}`)
  if (exited.signal) report.warnings.push(`${runtime.phase} Electron exited by signal ${exited.signal}`)
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
    await sleep(150)
  }
  throw new Error(`${label}: ${JSON.stringify(lastValue)}`)
}

async function findFreePort(start) {
  for (let port = start; port < start + 200; port += 1) if (await canListen(port)) return port
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
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  child.kill('SIGTERM')
  const graceful = await Promise.race([exited, sleep(3000).then(() => null)])
  if (graceful) return graceful
  child.kill('SIGKILL')
  return Promise.race([exited, sleep(3000).then(() => ({ code: child.exitCode, signal: child.signalCode ?? 'SIGKILL' }))])
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode }
  return Promise.race([
    new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
    sleep(timeoutMs).then(() => null)
  ])
}

function compareBoardOrder(left, right) {
  return (left.boardOrder ?? left.createdAt) - (right.boardOrder ?? right.createdAt) ||
    left.createdAt - right.createdAt || left.id.localeCompare(right.id)
}

async function assertRejects(promise, predicate, message) {
  try {
    await promise
  } catch (error) {
    if (predicate(error)) return
    throw new Error(`${message}: unexpected ${safeError(error)}`)
  }
  throw new Error(`${message}: operation unexpectedly succeeded`)
}

function writeReport() {
  mkdirSync(runDir, { recursive: true })
  const json = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(reportPath, json)
  writeFileSync(latestPath, json)
}

function gitState() {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    return { commit, worktreeClean: status.length === 0, statusEntryCount: status ? status.split(/\r?\n/).length : 0 }
  } catch {
    return { commit: null, worktreeClean: null }
  }
}

function safeError(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error)
}

function assertDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
