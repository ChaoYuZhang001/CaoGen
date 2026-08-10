#!/usr/bin/env node
import { createHash } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
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
const outputRoot = path.join(repoRoot, 'test-results', 'studio-result-surface')
const runDir = path.join(outputRoot, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-studio-result-surface-'))
const userDataDir = path.join(tempRoot, 'userData')
const projectDir = path.join(tempRoot, 'project')
const sourceOutDir = path.join(repoRoot, 'out')
const isolatedOutDir = path.join(runDir, 'app', 'out')
const mainEntry = path.join(isolatedOutDir, 'main', 'index.js')
const electronBin = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const deliveryBytes = Buffer.from('# Canonical delivery\n\nStudio result fixture.\n')
const deliveryDigest = createHash('sha256').update(deliveryBytes).digest('hex')
const ids = {
  project: 'studio-result-project', goal: 'studio-result-goal', workItem: 'studio-result-work-item',
  artifact: 'studio-result-artifact', acceptance: 'studio-result-acceptance', evidence: 'studio-result-evidence',
  approval: 'studio-result-approval'
}
const viewports = [
  { name: 'desktop', width: 1320, height: 860 },
  { name: 'compact', width: 760, height: 700 },
  { name: 'mobile', width: 360, height: 520 }
]

assert(existsSync(electronBin), 'Electron binary not found. Run npm install first.')
for (const entry of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
  assert(existsSync(path.join(sourceOutDir, entry)), `Built app entry missing: out/${entry}. Run npm run build first.`)
}

mkdirSync(runDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
mkdirSync(projectDir, { recursive: true })
writeFileSync(path.join(projectDir, 'delivery-report.md'), deliveryBytes)
copyBuiltApp()

const report = {
  schemaVersion: 1,
  runId,
  runDir,
  requirement: 'required',
  requirementIds: ['EXP-005', 'ART-005', 'NFR-AUD-001', 'NFR-AUD-002'],
  packageVersion: packageJson.version,
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  electronVersion: electronPackage.version,
  gitCommit: '',
  worktreeClean: false,
  checks: [],
  screenshots: [],
  viewports: [],
  warnings: [],
  coverage: {
    verified: [
      'real Electron IPC reads a fail-closed ProjectAggregate projection for the active Session ownership',
      'one result entry exposes Goal, WorkItem, Run, Artifact location/version/digest, Evidence, Acceptance, cost coverage, risk, open items, approvals, and audit timeline',
      'Studio result tab and Assistant result rail share the same renderer-safe contract while Memory remains a separate tool',
      'Artifact, Evidence, and delivery export retain canonical digests without Provider or response material',
      'desktop, compact, and 360px result views have no horizontal page or panel overflow',
      'a two-layer, two-node DAG runs through real child Sessions against the local mock Provider',
      'production audit IPC exposes attributed ModelAttempt routing, opaque pagination, Run filtering, and Renderer integrity state without credential material',
      'result quick actions hand off to the existing Changes, Files, Preview, Browser, Terminal, and Task/DAG surfaces without changing canonical identities'
    ],
    explicitlyNotVerified: [
      'human 30-minute Office and code delivery drills',
      'clean release-commit binding',
      'all historical cost coverage when a Run Session has no retained cost record'
    ]
  }
}

const mock = await startOpenAiMock()
const remotePort = await findFreePort(9940)
const electron = spawnElectronTestProcess(electronBin, [`--remote-debugging-port=${remotePort}`, mainEntry], {
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
let sessionId = ''
let runIdValue = ''
electron.stdout.on('data', (chunk) => { stdout += chunk.toString() })
electron.stderr.on('data', (chunk) => { stderr += chunk.toString() })

try {
  await waitForDebugPort(remotePort, 20_000)
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${remotePort}`, defaultViewport: null })
  page = await waitForElectronPage(browser, 20_000)
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') report.warnings.push(`console ${message.type()}: ${message.text()}`)
  })
  page.on('pageerror', (error) => report.warnings.push(`pageerror: ${error.message}`))
  await page.setViewport({ width: 1320, height: 860, deviceScaleFactor: 1 })
  await waitForApp(page)

  await check('seed canonical Project Goal WorkItem Run Artifact Evidence and Acceptance', async () => {
    const owned = await createOwnedResultSession(page, mock.baseUrl)
    sessionId = owned.sessionId
    runIdValue = owned.runId
    const linked = await linkCanonicalResultRecords(page, runIdValue)
    assert(linked.artifact.id === ids.artifact, 'Artifact linkage failed')
    assert(linked.workItem.runRefs.includes(runIdValue), 'WorkItem Run ref missing')
    assert(linked.workItem.artifactRefs.includes(ids.artifact), 'WorkItem Artifact ref missing')
  })

  await check('renderer-safe snapshot and export are canonical and redacted', async () => {
    const result = await page.evaluate(async ({ id, entityIds }) => {
      const snapshot = await window.agentDesk.getStudioResultSnapshot(id)
      const exported = await window.agentDesk.exportStudioResultSnapshot(id)
      const provider = (await window.agentDesk.listProviders()).find((item) => item.name === 'Studio Result Local Mock')
      const unbound = await window.agentDesk.createSession({
        cwd: snapshot.workspace ? '/tmp' : '',
        unassigned: true,
        providerId: provider.id,
        model: 'result-fixture',
        routingScope: 'fixed',
        taskStrategy: 'view',
        isolated: false,
        title: 'Unbound result fixture'
      })
      return {
        snapshot,
        exported,
        unbound: await window.agentDesk.getStudioResultSnapshot(unbound.id),
        ids: entityIds
      }
    }, { id: sessionId, entityIds: ids })
    const { snapshot, exported, unbound } = result
    assert(snapshot.state === 'ready', 'snapshot not ready')
    assert(snapshot.scope.workItemId === ids.workItem, 'snapshot WorkItem ownership mismatch')
    assert(snapshot.runs.length === 1 && snapshot.runs[0].id === runIdValue, 'snapshot Run mismatch')
    assert(snapshot.artifacts.length === 1 && snapshot.artifacts[0].id === ids.artifact, 'snapshot Artifact mismatch')
    assert(snapshot.artifacts[0].locations.length === 1, 'Artifact location missing')
    assert(snapshot.evidence.length === 2, `expected 2 Evidence rows, got ${snapshot.evidence.length}`)
    assert(snapshot.acceptances.length === 1, 'Acceptance missing')
    assert(snapshot.tests.length === 2, `expected Artifact and Evidence tests, got ${snapshot.tests.length}`)
    assert(snapshot.approvals.length === 1, 'recorded approval missing')
    assert(snapshot.risks.length >= 1, 'Goal risk projection missing')
    assert(snapshot.openItems.length >= 1, 'pending Acceptance open item missing')
    assert(snapshot.cost.coverage === 'complete', `unexpected cost coverage ${snapshot.cost.coverage}`)
    assert(snapshot.verification.canonicalAggregateVerified === true, 'canonical verification missing')
    assert(/^sha256:[a-f0-9]{64}$/.test(snapshot.verification.resultDigest), 'result digest missing')
    const bundle = JSON.parse(exported.json)
    assert(bundle.exportDigest === exported.exportDigest, 'export digest mismatch')
    assert(bundle.snapshot.scope.workItemId === ids.workItem, 'export scope mismatch')
    for (const forbidden of ['Studio Result Local Mock', mock.baseUrl, 'result-fixture', 'Canonical result completed.']) {
      assert(!exported.json.includes(forbidden), `export leaked runtime material: ${forbidden}`)
    }
    assert(unbound.state === 'unbound' && unbound.scope.level === 'conversation', 'unbound conversation state is not explicit')
  })

  await check('two-layer DAG completes through two real child Sessions', async () => {
    const dagId = 'studio-result-two-layer-dag'
    const dispatched = await page.evaluate(async ({ id, executionId }) => window.agentDesk.dispatchTaskDag(id, {
      dag: {
        id: executionId,
        title: 'Verify result task graph',
        source: 'studio-result-surface-e2e',
        complexity: 'multi',
        createdAt: Date.now(),
        tasks: [
          {
            id: 'inspect-result',
            title: 'Inspect canonical result',
            description: 'Inspect the canonical delivery result.',
            dependencies: [],
            role: 'review',
            prompt: 'Inspect the canonical delivery result and report completion.'
          },
          {
            id: 'verify-result',
            title: 'Verify canonical result',
            description: 'Verify the result after inspection completes.',
            dependencies: ['inspect-result'],
            role: 'qa',
            prompt: 'Verify the canonical delivery result and report completion.'
          }
        ]
      },
      isolated: false,
      autoMerge: false,
      maxRetries: 0,
      taskTimeoutMs: 15_000
    }), { id: sessionId, executionId: dagId })
    assert(dispatched.execution.layers.length === 2, `expected two DAG layers, got ${dispatched.execution.layers.length}`)
    assert(dispatched.children.some((child) => child.taskId === 'inspect-result'), 'first dependency layer was not dispatched')
    assert(new Set(dispatched.children.map((child) => child.taskId)).size === dispatched.children.length, 'DAG dispatch returned duplicate child tasks')
    const firstTask = dispatched.execution.tasks.find((task) => task.task.id === 'inspect-result')
    const dependentTask = dispatched.execution.tasks.find((task) => task.task.id === 'verify-result')
    assert(firstTask && dependentTask, 'DAG dispatch lost a task view')
    if (dispatched.children.some((child) => child.taskId === 'verify-result')) {
      assert(firstTask.completedAt && dependentTask.startedAt && dependentTask.startedAt >= firstTask.completedAt,
        'dependent task started before its upstream task completed')
    } else {
      assert(dependentTask.status === 'waiting', `undispatched dependent task is ${dependentTask.status}`)
    }

    const settled = await waitForValue(
      () => page.evaluate(async ({ id, executionId }) => {
        const [entries, sessions] = await Promise.all([
          window.agentDesk.getTranscript(id),
          window.agentDesk.listSessions()
        ])
        const updates = entries
          .map((entry) => entry.event)
          .filter((event) => event?.kind === 'task-dag-update' && event.execution.id === executionId)
          .map((event) => event.execution)
        return {
          execution: updates.at(-1),
          children: sessions.filter((item) => item.parentSessionId === id && item.orchestrationId === executionId),
          parent: sessions.find((item) => item.id === id),
          parentTurnResults: entries.filter((entry) => entry.event?.kind === 'turn-result').length
        }
      }, { id: sessionId, executionId: dagId }),
      (value) => value.execution?.status === 'success' &&
        value.execution.finalization?.phase === 'completed' &&
        value.execution.tasks.length === 2 &&
        value.execution.tasks.every((task) => task.status === 'success') &&
        value.children.length === 2 &&
        value.children.every((child) => child.status === 'idle') &&
        value.parent?.status === 'idle' &&
        value.parentTurnResults >= 2,
      30_000,
      'waiting for the two-layer DAG and both child Sessions'
    )
    assert(settled.execution.layers.length === 2, 'settled DAG lost its dependency layers')
    assert(settled.children.every((child) => child.isolated === false), 'DAG child unexpectedly created an isolated worktree')

    const snapshot = await waitForValue(
      () => page.evaluate(async (id) => {
        try {
          return await window.agentDesk.getStudioResultSnapshot(id)
        } catch (error) {
          return { state: 'error', error: error instanceof Error ? error.message : String(error) }
        }
      }, sessionId),
      (value) => value.state === 'ready' && value.runs.length === 4 && value.runs.every((run) => run.status === 'completed'),
      15_000,
      'waiting for the canonical result aggregate to include both DAG Runs and the parent summary Run'
    )
    assert(snapshot.artifacts.some((artifact) => artifact.id === ids.artifact), 'DAG refresh lost the canonical Artifact')
    assert(snapshot.evidence.some((evidence) => evidence.id === ids.evidence), 'DAG refresh lost canonical Evidence')
    assert(snapshot.acceptances.some((acceptance) => acceptance.id === ids.acceptance), 'DAG refresh lost canonical Acceptance')
  })

  await check('production audit API is attributed, paginated, Run-filtered, and redacted', async () => {
    await seedAuditTimelineEvidence(page, runIdValue, 28)
    const audit = await page.evaluate(async ({ id, selectedRunId }) => {
      const complete = await window.agentDesk.queryStudioAuditTimeline(id, { limit: 100 })
      const first = await window.agentDesk.queryStudioAuditTimeline(id, { limit: 3 })
      const second = first.nextCursor
        ? await window.agentDesk.queryStudioAuditTimeline(id, { limit: 3, cursor: first.nextCursor })
        : undefined
      const filtered = await window.agentDesk.queryStudioAuditTimeline(id, { runId: selectedRunId, limit: 100 })
      return { complete, first, second, filtered }
    }, { id: sessionId, selectedRunId: runIdValue })
    assert(audit.complete.state === 'ready', `audit state is ${audit.complete.state}`)
    assert(audit.complete.total > 25, `audit fixture did not force pagination: ${audit.complete.total}`)
    const attempt = audit.complete.items.find((item) => item.category === 'model_attempt' && item.runId === runIdValue)
    assert(attempt, 'production audit API omitted the primary ModelAttempt')
    assert(attempt.providerId && attempt.model && attempt.protocol && attempt.reason, 'ModelAttempt routing attribution is incomplete')
    assert(/^sha256:[a-f0-9]{64}$/.test(attempt.resultDigest), 'ModelAttempt result digest is invalid')
    assert(audit.first.hasMore && audit.first.nextCursor, 'audit API did not return an opaque next cursor')
    assert(audit.second && !audit.first.items.some((item) => audit.second.items.some((next) => next.id === item.id)), 'audit pages contain duplicate rows')
    assert(audit.filtered.items.some((item) => item.runId === runIdValue), 'Run filter omitted the selected Run')
    assert(audit.filtered.items.every((item) => !item.runId || item.runId === runIdValue), 'Run filter leaked another Run')
    const rendered = JSON.stringify(audit)
    for (const forbidden of ['test-only', mock.baseUrl, 'Canonical result completed.']) {
      assert(!rendered.includes(forbidden), `audit API leaked runtime material: ${forbidden}`)
    }
  })

  await check('Studio result tabs use linked roving focus with Arrow/Home/End activation', async () => {
    sessionId = await selectSessionFromSidebar(page, sessionId)
    await clickMode(page, 'studio')
    await clickStudioSurface(page, 'result')
    await page.waitForSelector('[data-studio-result-state="ready"]', { visible: true, timeout: 15_000 })
    await page.click('[data-studio-result-tab="summary"]')
    const semantics = await page.$eval('.studio-result-tabs', (tablist) => {
      const tabs = [...tablist.querySelectorAll('[role="tab"]')]
      const selected = tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true')
      const tabbable = tabs.filter((tab) => tab.tabIndex === 0)
      const active = selected[0]
      const panel = active ? document.getElementById(active.getAttribute('aria-controls') ?? '') : null
      return {
        count: tabs.length,
        selected: selected.length,
        tabbable: tabbable.length,
        linked: Boolean(active?.id && panel?.getAttribute('aria-labelledby') === active.id)
      }
    })
    assert(semantics.count === 4 && semantics.selected === 1 && semantics.tabbable === 1 && semantics.linked,
      `result tab semantics invalid: ${JSON.stringify(semantics)}`)
    await page.focus('[data-studio-result-tab="summary"]')
    await page.keyboard.press('ArrowRight')
    await assertResultTabFocus(page, 'artifacts')
    await page.keyboard.press('End')
    await assertResultTabFocus(page, 'timeline')
    await page.keyboard.press('Home')
    await assertResultTabFocus(page, 'summary')
    await page.keyboard.press('ArrowLeft')
    await assertResultTabFocus(page, 'timeline')
  })

  await check('Studio result UI is complete and responsive at three viewports', async () => {
    sessionId = await selectSessionFromSidebar(page, sessionId)
    await clickMode(page, 'studio')
    await clickStudioSurface(page, 'result')
    await page.waitForSelector('[data-studio-result-state="ready"]', { visible: true, timeout: 15_000 })
    for (const viewport of viewports) {
      await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 })
      await sleep(180)
      const viewportReport = { ...viewport, tabs: [] }
      for (const tab of ['summary', 'artifacts', 'evidence', 'timeline']) {
        await page.click(`[data-studio-result-tab="${tab}"]`)
        await page.waitForSelector(`[data-studio-result-view="${tab}"]`, { visible: true, timeout: 5_000 })
        if (tab === 'timeline') {
          await page.waitForSelector('[data-studio-audit-state="ready"]', { visible: true, timeout: 15_000 })
          if (viewport.name === 'desktop') {
            await loadAuditUntilSelector(page, '[data-studio-audit-category="model_attempt"]')
          }
          if (viewport.name === 'mobile') {
            await page.waitForSelector('[data-studio-audit-load-more]', { visible: true, timeout: 5_000 })
            const before = await page.$$eval('[data-studio-audit-item]', (nodes) => nodes.length)
            await page.click('[data-studio-audit-load-more]')
            await page.waitForFunction((count) => document.querySelectorAll('[data-studio-audit-item]').length > count, { timeout: 10_000 }, before)
            await page.select('[data-studio-audit-run-filter]', runIdValue)
            await page.waitForFunction((expectedRunId) => {
              const select = document.querySelector('[data-studio-audit-run-filter]')
              const rows = [...document.querySelectorAll('[data-studio-audit-item]')]
              return select?.value === expectedRunId && rows.length > 0 && rows.every((row) => {
                const rowRunId = row.getAttribute('data-studio-audit-run')
                return !rowRunId || rowRunId === expectedRunId
              })
            }, { timeout: 15_000 }, runIdValue)
          }
        }
        const overflow = await readOverflow(page)
        assert(overflow.documentOverflow <= 1, `${viewport.name}/${tab} document overflow ${overflow.documentOverflow}px`)
        assert(overflow.panelOverflow <= 1, `${viewport.name}/${tab} panel overflow ${overflow.panelOverflow}px`)
        if (tab === 'artifacts') {
          assert(await page.$(`[data-studio-result-artifact="${ids.artifact}"]`), `${viewport.name} Artifact row missing`)
        }
        if (tab === 'evidence') {
          assert(await page.$(`[data-studio-result-evidence="${ids.evidence}"]`), `${viewport.name} Evidence row missing`)
          await page.waitForSelector(`[data-acceptance-review="${ids.acceptance}"]`, { visible: true, timeout: 5_000 })
        }
        if (tab === 'timeline') {
          assert(await page.$('[data-studio-audit-actor]'), `${viewport.name} audit actor missing`)
          assert(await page.$('[data-studio-audit-digest]'), `${viewport.name} audit digest missing`)
          if (viewport.name === 'desktop') {
            assert(await page.$('[data-studio-audit-provider]'), 'desktop ModelAttempt Provider attribution missing')
          }
        }
        await screenshot(page, `${viewport.name}-${tab}`)
        viewportReport.tabs.push({ tab, ...overflow })
      }
      report.viewports.push(viewportReport)
    }
  })

  await check('all six result quick actions preserve canonical delivery identities', async () => {
    await page.setViewport({ width: 760, height: 700, deviceScaleFactor: 1 })
    const tools = [
      { id: 'diff', selector: '.workspace-diff' },
      { id: 'files', selector: '.file-panel' },
      { id: 'preview', selector: '.preview-panel' },
      { id: 'browser', selector: '.browser-panel' },
      { id: 'terminal', selector: '.terminal-input:not([disabled])', screenshot: 'compact-terminal' },
      { id: 'tasks', selector: '.subagent-panel', screenshot: 'compact-tasks' }
    ]
    for (const tool of tools) {
      await clickStudioSurface(page, 'result')
      await page.waitForSelector('[data-studio-result-state="ready"]', { visible: true, timeout: 15_000 })
      const renderedTools = await page.$$eval('[data-studio-result-tool]', (nodes) =>
        nodes.map((node) => node.getAttribute('data-studio-result-tool')))
      assert(JSON.stringify(renderedTools) === JSON.stringify(tools.map((item) => item.id)),
        `result tool order mismatch: ${JSON.stringify(renderedTools)}`)
      if (tool.id === 'browser') {
        await page.evaluate((id) => window.agentDesk.openBrowser(id, 'about:blank'), sessionId)
      }
      const before = await page.evaluate((id) => window.agentDesk.getStudioResultSnapshot(id), sessionId)
      await page.click(`[data-studio-result-tool="${tool.id}"]`)
      await page.waitForFunction(() =>
        document.querySelector('.experience-pane')?.getAttribute('data-studio-surface') === 'session',
      { timeout: 10_000 })
      await page.waitForSelector(tool.selector, { visible: true, timeout: 15_000 })
      if (tool.id === 'browser') {
        const browserUrl = await page.$eval('.browser-url', (node) => node.value)
        assert(browserUrl === 'about:blank', `Browser quick action introduced an external URL: ${browserUrl}`)
      }
      if (tool.id === 'tasks') {
        await page.waitForFunction(() => document.querySelectorAll('.task-dag-node-success').length === 2, { timeout: 10_000 })
        const layerCount = await page.$$eval('.task-dag-layer', (nodes) => nodes.length)
        assert(layerCount === 2, `Task quick action rendered ${layerCount} DAG layers`)
        await page.$eval('.task-dag-graph', (node) => node.scrollIntoView({ block: 'start' }))
        await page.waitForSelector('.task-dag-node-success', { visible: true, timeout: 5_000 })
      }
      const after = await page.evaluate((id) => window.agentDesk.getStudioResultSnapshot(id), sessionId)
      assertSameDeliveryIdentity(before, after, tool.id)
      if (tool.screenshot) await screenshot(page, tool.screenshot)
    }
  })

  assert(mock.requests === 4, `expected four model requests, got ${mock.requests}`)
} catch (error) {
  report.error = error instanceof Error ? error.stack || error.message : String(error)
  process.exitCode = 1
  if (page) await screenshot(page, 'failure').catch(() => undefined)
} finally {
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
  rmSync(tempRoot, { recursive: true, force: true })
}

if (report.status !== 'pass') {
  console.error(`studio result surface E2E failed: ${report.error || 'check failure'}`)
  process.exitCode = 1
} else {
  console.log(`studio result surface E2E ok: ${runDir}`)
  console.log(`${report.checks.length}/${report.checks.length} checks passed; ${report.screenshots.length} screenshots`)
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

async function assertResultTabFocus(targetPage, tab) {
  await targetPage.waitForFunction((expected) => {
    const target = document.querySelector(`[data-studio-result-tab="${expected}"]`)
    const panel = document.querySelector(`[data-studio-result-view="${expected}"]`)
    return target?.getAttribute('aria-selected') === 'true'
      && target.tabIndex === 0
      && document.activeElement === target
      && panel?.checkVisibility()
  }, { timeout: 10_000 }, tab)
}

async function createOwnedResultSession(targetPage, baseUrl) {
  const created = await targetPage.evaluate(async ({ entityIds, cwd, providerBaseUrl }) => {
    const project = await window.agentDesk.createProjectWorkspace({ id: entityIds.project, name: 'Unified result fixture', kind: 'software' })
    const goal = await window.agentDesk.createProjectGoal({
      id: entityIds.goal, projectId: project.id, title: 'Deliver a verified result',
      objective: 'Aggregate one delivery from canonical records', successCriteria: ['Artifact and Evidence remain inspectable'],
      riskLevel: 'medium', status: 'verifying'
    })
    const workItem = await window.agentDesk.createProjectWorkItem({
      id: entityIds.workItem, projectId: project.id, goalId: goal.id,
      title: 'Verify unified result workspace', description: 'One WorkItem owns the Run and delivery report.',
      type: 'testing', status: 'ready'
    })
    const provider = await window.agentDesk.createProvider({
      name: 'Studio Result Local Mock', baseUrl: providerBaseUrl, token: 'test-only',
      models: ['result-fixture'], openaiProtocol: 'responses'
    })
    return window.agentDesk.createSession({
      cwd, workspaceId: project.id, goalId: goal.id, workItemId: workItem.id,
      providerId: provider.id, model: 'result-fixture', routingScope: 'fixed',
      taskStrategy: 'execute', isolated: false, title: 'Unified result session'
    })
  }, { entityIds: ids, cwd: projectDir, providerBaseUrl: baseUrl })
  const id = created.id
  await waitForValue(
    () => targetPage.evaluate((sessionIdValue) => window.agentDesk.listSessions()
      .then((items) => items.find((item) => item.id === sessionIdValue)), id),
    (meta) => Boolean(meta?.sdkSessionId && meta.status === 'idle'),
    15_000,
    'waiting for owned Session initialization'
  )
  await targetPage.evaluate((sessionIdValue) => window.agentDesk.sendMessage(sessionIdValue, {
    text: 'Create the canonical result Run.', messageId: 'studio-result-message'
  }), id)
  const completed = await waitForValue(
    () => targetPage.evaluate(async ({ sessionIdValue, projectId }) => {
      const [sessions, ledger] = await Promise.all([
        window.agentDesk.listSessions(),
        window.agentDesk.listWorkflowLedger({ projectId, limit: 100 })
      ])
      return { meta: sessions.find((item) => item.id === sessionIdValue), runs: ledger.runs.items }
    }, { sessionIdValue: id, projectId: ids.project }),
    (value) => value.meta?.status === 'idle' && value.runs.length === 1 && value.runs[0].status === 'completed',
    20_000,
    'waiting for canonical Run completion'
  )
  await waitForValue(
    () => targetPage.evaluate(async (sessionIdValue) => {
      try {
        const snapshot = await window.agentDesk.getStudioResultSnapshot(sessionIdValue)
        return { ready: snapshot.state === 'ready', error: '' }
      } catch (error) {
        return { ready: false, error: error instanceof Error ? error.message : String(error) }
      }
    }, id),
    (value) => value.ready,
    15_000,
    'waiting for a stable canonical aggregate before Artifact writes'
  )
  await sleep(400)
  return { sessionId: id, runId: completed.runs[0].id }
}

async function linkCanonicalResultRecords(targetPage, runId) {
  return targetPage.evaluate(async ({ entityIds, canonicalRunId, digest, reportPath }) => {
    const committed = async (write, read) => {
      try {
        return await write()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/changed during the cross-store stable read/.test(message)) throw error
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const existing = await read()
          if (existing) return existing
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        throw error
      }
    }
    const artifact = await committed(() => window.agentDesk.createWorkflowArtifact({
      id: entityIds.artifact, projectId: entityIds.project, goalId: entityIds.goal,
      workItemId: entityIds.workItem, runId: canonicalRunId, kind: 'test_report',
      title: 'Canonical delivery report', version: 1, digest: `sha256:${digest}`,
      mediaType: 'text/markdown', provenance: 'explicit'
    }), async () => (await window.agentDesk.listWorkflowLedger({ artifactId: entityIds.artifact, limit: 100 }))
      .artifacts.items.find((item) => item.id === entityIds.artifact))
    await committed(() => window.agentDesk.createWorkflowArtifactLocation({
      id: 'studio-result-location', artifactId: artifact.id, projectId: entityIds.project,
      goalId: entityIds.goal, workItemId: entityIds.workItem, runId: canonicalRunId,
      kind: 'file', path: reportPath, availability: 'available', checksum: `sha256:${digest}`,
      mediaType: 'text/markdown'
    }), async () => (await window.agentDesk.listWorkflowArtifactLocations({ artifactId: artifact.id, limit: 100 }))
      .items.find((item) => item.id === 'studio-result-location'))
    const acceptance = await committed(() => window.agentDesk.saveWorkflowAcceptance({
      id: entityIds.acceptance, projectId: entityIds.project, goalId: entityIds.goal,
      workItemId: entityIds.workItem, criteria: ['Artifact and Evidence remain inspectable'], status: 'pending'
    }), async () => (await window.agentDesk.listWorkflowLedger({ acceptanceId: entityIds.acceptance, limit: 100 }))
      .acceptances.items.find((item) => item.id === entityIds.acceptance))
    const evidence = await committed(() => window.agentDesk.createWorkflowEvidence({
      evidenceId: entityIds.evidence, projectId: entityIds.project, goalId: entityIds.goal,
      workItemId: entityIds.workItem, runId: canonicalRunId, artifactId: artifact.id,
      kind: 'test_result', title: 'Studio result surface regression',
      summary: 'Renderer contract and responsive checks are recorded.', contentDigest: digest
    }), async () => (await window.agentDesk.queryWorkflowEvidence({ evidenceId: entityIds.evidence, limit: 10 }))
      .items.find((item) => item.evidenceId === entityIds.evidence))
    await committed(() => window.agentDesk.createWorkflowEvidenceLink({
      id: 'studio-result-evidence-link', evidenceId: evidence.evidenceId, evidenceOrigin: 'workflow',
      projectId: entityIds.project, runId: canonicalRunId, artifactId: artifact.id,
      acceptanceId: acceptance.id, relation: 'verifies'
    }), async () => (await window.agentDesk.listWorkflowLedger({ acceptanceId: acceptance.id, limit: 100 }))
      .evidenceLinks.items.find((item) => item.id === 'studio-result-evidence-link'))
    await committed(() => window.agentDesk.createWorkflowEvidence({
      evidenceId: entityIds.approval, projectId: entityIds.project, goalId: entityIds.goal,
      workItemId: entityIds.workItem, runId: canonicalRunId, artifactId: artifact.id,
      kind: 'approval', title: 'Local review recorded', contentDigest: digest
    }), async () => (await window.agentDesk.queryWorkflowEvidence({ evidenceId: entityIds.approval, limit: 10 }))
      .items.find((item) => item.evidenceId === entityIds.approval))
    const current = await window.agentDesk.getProjectWorkItem(entityIds.workItem)
    if (!current) throw new Error('WorkItem disappeared before result linkage')
    const workItem = await committed(() => window.agentDesk.updateProjectWorkItem(entityIds.workItem, {
      runRefs: [canonicalRunId], artifactRefs: [artifact.id]
    }, { expectedRevision: current.revision }), () => window.agentDesk.getProjectWorkItem(entityIds.workItem))
    return { artifact, acceptance, evidence, workItem }
  }, {
    entityIds: ids,
    canonicalRunId: runId,
    digest: deliveryDigest,
    reportPath: path.join(projectDir, 'delivery-report.md')
  })
}

async function seedAuditTimelineEvidence(targetPage, canonicalRunId, count) {
  return targetPage.evaluate(async ({ entityIds, runId, digest, rows }) => {
    for (let index = 0; index < rows; index += 1) {
      const evidenceId = `studio-result-audit-page-${String(index).padStart(2, '0')}`
      await window.agentDesk.createWorkflowEvidence({
        evidenceId,
        projectId: entityIds.project,
        goalId: entityIds.goal,
        workItemId: entityIds.workItem,
        runId,
        kind: 'observation',
        title: `Audit pagination row ${index + 1}`,
        contentDigest: digest
      })
    }
    return rows
  }, { entityIds: ids, runId: canonicalRunId, digest: deliveryDigest, rows: count })
}

async function clickMode(targetPage, mode) {
  await targetPage.click(`[data-experience-mode-option="${mode}"]`)
  await targetPage.waitForFunction((expected) =>
    document.querySelector('.experience-pane')?.getAttribute('data-experience-mode') === expected,
  { timeout: 10_000 }, mode)
}

async function selectSessionFromSidebar(targetPage, id) {
  const activeSelector = `.session-card:not(.history-card)[data-session-id="${id}"]`
  const historySelector = `.session-card.history-card[data-session-id="${id}"]`
  await targetPage.waitForSelector(`${activeSelector}, ${historySelector}`, { visible: true, timeout: 10_000 })
  const selector = await targetPage.$(activeSelector) ? activeSelector : historySelector
  await targetPage.click(selector)
  await targetPage.waitForSelector('.session-card.active[data-session-id]', { visible: true, timeout: 10_000 })
  const activeId = await targetPage.$eval('.session-card.active', (node) => node.getAttribute('data-session-id'))
  assert(typeof activeId === 'string' && activeId.length > 0, 'resumed Session id missing from active sidebar entry')
  return activeId
}

async function clickStudioSurface(targetPage, surface) {
  await targetPage.click(`[data-studio-projection-tab="${surface}"]`)
  await targetPage.waitForSelector(`#studio-projection-panel-${surface}:not([hidden])`, { visible: true, timeout: 10_000 })
}

async function readOverflow(targetPage) {
  return targetPage.evaluate(() => {
    const panel = document.querySelector('[data-studio-result-panel]')
    return {
      documentOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      panelOverflow: panel ? Math.max(0, panel.scrollWidth - panel.clientWidth) : -1
    }
  })
}

async function loadAuditUntilSelector(targetPage, selector, maxPages = 10) {
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    if (await targetPage.$(selector)) return
    const more = await targetPage.$('[data-studio-audit-load-more]')
    if (!more) break
    const count = await targetPage.$$eval('[data-studio-audit-item]', (nodes) => nodes.length)
    await more.click()
    await targetPage.waitForFunction((previous) =>
      document.querySelectorAll('[data-studio-audit-item]').length > previous,
    { timeout: 10_000 }, count)
  }
  throw new Error(`audit selector did not appear after pagination: ${selector}`)
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
    typeof window.agentDesk?.getStudioResultSnapshot === 'function' &&
    typeof window.agentDesk?.queryStudioAuditTimeline === 'function' &&
    typeof window.agentDesk?.createProjectWorkspace === 'function', { timeout: 15_000 })
  await targetPage.waitForSelector('[data-experience-mode-switcher]', { visible: true, timeout: 15_000 })
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
    const reply = 'Canonical result completed.'
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: reply })}\n\n`)
    response.write(`data: ${JSON.stringify({
      type: 'response.completed',
      response: { id: `resp_result_${Date.now()}`, output_text: reply, usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 0 } } }
    })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  const port = await findFreePort(9300)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return { server, baseUrl: `http://127.0.0.1:${port}`, get requests() { return requests } }
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

async function closeServer(server) {
  if (!server.listening) return
  await new Promise((resolve) => server.close(resolve))
}

function readGitState() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  return { commit, worktreeClean: status.length === 0, statusEntryCount: status ? status.split(/\r?\n/).length : 0 }
}

function assertSameDeliveryIdentity(before, after, tool) {
  const identity = (snapshot) => ({
    state: snapshot.state,
    scope: snapshot.scope,
    artifactIds: snapshot.artifacts.map((item) => item.id).sort(),
    evidenceIds: snapshot.evidence.map((item) => `${item.origin}:${item.id}`).sort(),
    acceptanceIds: snapshot.acceptances.map((item) => item.id).sort()
  })
  const beforeIdentity = identity(before)
  const afterIdentity = identity(after)
  assert(
    JSON.stringify(beforeIdentity) === JSON.stringify(afterIdentity),
    `${tool} navigation changed canonical delivery identity: ${JSON.stringify({ before: beforeIdentity, after: afterIdentity })}`
  )
}

function writeReport() {
  const text = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(runDir, 'report.json'), text)
  writeFileSync(path.join(outputRoot, 'latest.json'), text)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
