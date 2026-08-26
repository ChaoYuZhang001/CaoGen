#!/usr/bin/env node

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnElectronTestProcess, terminateElectronTestProcess } from './lib/electron-test-process.mjs'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const electronBin = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const sourceOutDir = path.join(repoRoot, 'out')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'project-golden-delivery')
const reportDir = path.join(reportRoot, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-project-golden-delivery-'))
const userDataDir = path.join(tempRoot, 'userData')
const projectRoot = path.join(tempRoot, 'project-repo')
const isolatedOutDir = path.join(reportDir, 'app', 'out')
const mainEntry = path.join(isolatedOutDir, 'main', 'index.js')
const fixtureCredential = randomUUID()

const ids = {
  project: 'ux-golden-002-project',
  goal: 'ux-golden-002-goal',
  workItem: 'ux-golden-002-work-item'
}
const objective = 'Deliver a verified project change with one reversible review'
const baselineLines = Array.from({ length: 24 }, (_, index) => `line-${index + 1}`)
const changedLines = baselineLines.map((line, index) => {
  if (index === 1) return 'line-2 approved change'
  if (index === 18) return 'line-19 reversible change'
  return line
})

for (const entry of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
  assert(existsSync(path.join(sourceOutDir, entry)), `Built app entry missing: out/${entry}. Run npm run build first.`)
}
assert(existsSync(electronBin), 'Electron binary not found. Run npm install first.')
mkdirSync(reportDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
mkdirSync(projectRoot, { recursive: true })
prepareGitFixture()
copyBuiltApp()

const checks = []
const report = {
  schemaVersion: 1,
  runId,
  gate: 'test:project-golden-delivery',
  requirement: 'UX-GOLDEN-002',
  classification: 'local_targeted_not_release',
  sourceRevision: gitOutput(['rev-parse', 'HEAD']),
  worktreeStatusCount: gitStatusCount(),
  status: 'failed',
  checks,
  projectId: ids.project,
  sessionId: '',
  plan: {},
  delivery: {},
  explicitlyNotVerified: [
    'five-user timed acceptance',
    'clean release SHA binding',
    'commercial Provider quality or model parity'
  ]
}

let server
let electron
let browser
let page
let serverBase = ''
let stdout = ''
let stderr = ''

try {
  server = await startOpenAiMock()
  serverBase = server.baseUrl
  await launchElectron('initial')

  const created = await check('one sentence creates canonical Goal, WorkItem, Provider and Session', async () => {
    const value = await page.evaluate(async ({ ids: entityIds, cwd, providerBaseUrl, objective: goalObjective, credential }) => {
      const project = await window.agentDesk.createProjectWorkspace({
        id: entityIds.project,
        name: 'UX Golden Project Delivery',
        kind: 'software'
      })
      const goal = await window.agentDesk.createProjectGoal({
        id: entityIds.goal,
        projectId: project.id,
        title: goalObjective,
        objective: goalObjective,
        status: 'planned',
        successCriteria: ['Approved change is committed and test evidence is retained']
      })
      const workItem = await window.agentDesk.createProjectWorkItem({
        id: entityIds.workItem,
        projectId: project.id,
        goalId: goal.id,
        title: 'Implement and verify one reversible change',
        description: goalObjective,
        type: 'coding',
        status: 'ready'
      })
      const provider = await window.agentDesk.createProvider({
        name: 'UX Golden Local Provider',
        baseUrl: providerBaseUrl,
        token: credential,
        models: ['ux-golden-model'],
        openaiProtocol: 'responses'
      })
      const session = await window.agentDesk.createSession({
        cwd,
        workspaceId: project.id,
        goalId: goal.id,
        workItemId: workItem.id,
        providerId: provider.id,
        model: 'ux-golden-model',
        routingScope: 'fixed',
        isolated: false,
        taskStrategy: 'plan',
        title: 'UX Golden Project Session'
      })
      return { project, goal, workItem, session }
    }, { ids, cwd: projectRoot, providerBaseUrl: serverBase, objective, credential: fixtureCredential })
    assert.equal(value.project.id, ids.project)
    assert.equal(value.goal.id, ids.goal)
    assert.equal(value.workItem.goalId, ids.goal)
    assert.equal(value.session.workspaceId, ids.project)
    report.sessionId = value.session.id
    await waitForValue(
      () => page.evaluate((id) => window.agentDesk.listSessions().then((items) => items.find((item) => item.id === id)), value.session.id),
      (meta) => Boolean(meta?.sdkSessionId && meta.status === 'idle'),
      20_000,
      'waiting for canonical Session initialization'
    )
    return value
  })

  await check('automatic plan and routing require exactly one explicit approval before execution', async () => {
    const result = await page.evaluate(async ({ id, goalObjective }) => {
      const planned = await window.agentDesk.generateTaskPlan(id, { objective: goalObjective })
      if (!planned.currentVersion) throw new Error('automatic plan did not produce a version')
      const version = planned.currentVersion
      const approved = await window.agentDesk.approveTaskPlan(id, {
        version: version.version,
        digest: version.digest,
        reason: 'UX golden review'
      })
      const dispatched = await window.agentDesk.dispatchApprovedTaskPlan(id, {
        version: version.version,
        digest: version.digest,
        reason: 'UX golden execution'
      })
      const after = await window.agentDesk.getTaskPlan(id)
      return { version, approved, dispatched, after }
    }, { id: report.sessionId, goalObjective: objective })
    assert(result.version.steps.length > 0, 'automatic plan has no executable steps')
    assert.equal(result.approved.approvalStatus, 'approved')
    assert.equal(result.after.approvalStatus, 'approved')
    assert.equal(result.after.approvalEvents.filter((event) => event.kind === 'approved').length, 1)
    assert.equal(result.dispatched.taskCount, result.version.steps.length)
    report.plan = {
      version: result.version.version,
      digest: result.version.digest,
      stepCount: result.version.steps.length,
      dispatchStatus: result.dispatched.status,
      executionId: result.dispatched.executionId
    }
    await waitForValue(
      () => page.evaluate((id) => window.agentDesk.listSessions().then((items) => items.filter((item) => item.parentSessionId === id))),
      (children) => children.length >= result.version.steps.length,
      20_000,
      'waiting for digital worker Sessions'
    )
  })

  await check('approved Session executes and records one canonical Run', async () => {
    const accepted = await page.evaluate((id) => window.agentDesk.sendMessage(id, {
      text: 'Execute the approved project change and report the result.',
      messageId: 'ux-golden-002-execution'
    }), report.sessionId)
    assert.equal(accepted, true)
    await waitForValue(
      () => page.evaluate(async ({ id, projectId }) => {
        const [sessions, ledger] = await Promise.all([
          window.agentDesk.listSessions(),
          window.agentDesk.listWorkflowLedger({ projectId, limit: 500 })
        ])
        return {
          session: sessions.find((item) => item.id === id),
          runs: ledger.runs.items.filter((run) => run.sessionId === id)
        }
      }, { id: report.sessionId, projectId: ids.project }),
      (value) => value.session?.status === 'idle' && value.runs.some((run) => run.status === 'completed'),
      30_000,
      'waiting for approved Session execution'
    )
  })

  await check('worktree and two hunk changes support apply and reversible discard', async () => {
    const write = await page.evaluate(async ({ id, content }) => window.agentDesk.writeTextFile(id, 'README.md', content), {
      id: report.sessionId,
      content: `${changedLines.join('\n')}\n`
    })
    assert.equal(write.ok, true, `file write failed: ${JSON.stringify(write)}`)
    const diff = await page.evaluate((id) => window.agentDesk.getWorkspaceDiff(id), report.sessionId)
    const file = diff.files.find((candidate) => candidate.newPath === 'README.md')
    assert(file, 'README.md diff is missing')
    assert(file.hunks.length >= 2, `expected two reviewable hunks, got ${file.hunks.length}`)
    const first = file.hunks[0]
    const second = file.hunks[1]
    const staged = await page.evaluate(async ({ id, patch }) => window.agentDesk.applyWorkspaceHunk(id, 'README.md', patch), {
      id: report.sessionId,
      patch: first.patch
    })
    assert.equal(staged.ok, true, `hunk apply failed: ${JSON.stringify(staged)}`)
    const discarded = await page.evaluate(async ({ id, patch }) => window.agentDesk.discardWorkspaceHunk(id, 'README.md', patch), {
      id: report.sessionId,
      patch: second.patch
    })
    assert.equal(discarded.ok, true, `hunk undo failed: ${JSON.stringify(discarded)}`)
    const status = await page.evaluate((id) => window.agentDesk.gitStatus(id), report.sessionId)
    assert.equal(status.staged, 1)
    assert.equal(status.unstaged, 0)
    const content = await page.evaluate((id) => window.agentDesk.readTextFile(id, 'README.md'), report.sessionId)
    assert(content.content.includes('line-2 approved change'))
    assert(!content.content.includes('line-19 reversible change'))
  })

  await check('Test panel runs a real command and binds Artifact, Evidence and Acceptance', async () => {
    const discovered = await page.evaluate((id) => window.agentDesk.discoverProjectTests(id), report.sessionId)
    const command = discovered.commands.find((candidate) => candidate.default) ?? discovered.commands[0]
    assert(command, 'Project Test discovery returned no command')
    const result = await page.evaluate(({ id, commandId }) => window.agentDesk.runProjectTest(id, commandId), {
      id: report.sessionId,
      commandId: command.id
    })
    assert.equal(result.status, 'passed')
    assert(result.workflowArtifactId && result.workflowEvidenceId && result.workflowAcceptanceId,
      `test result is not bound to canonical delivery records: ${JSON.stringify(result)}`)
    const { ledger, evidencePage } = await page.evaluate(async (projectId) => {
      const [ledger, evidencePage] = await Promise.all([
        window.agentDesk.listWorkflowLedger({ projectId, limit: 500 }),
        window.agentDesk.queryWorkflowEvidence({ projectId, limit: 500 })
      ])
      return { ledger, evidencePage }
    }, ids.project)
    const artifact = ledger.artifacts.items.find((item) => item.id === result.workflowArtifactId)
    const evidence = evidencePage.items.find((item) => item.evidenceId === result.workflowEvidenceId)
    const acceptance = ledger.acceptances.items.find((item) => item.id === result.workflowAcceptanceId)
    assert(artifact && evidence && acceptance, 'canonical test records cannot be read back')
    assert.equal(acceptance.status, 'passed')
    assert(ledger.evidenceLinks.items.some((link) => link.acceptanceId === acceptance.id && link.evidenceId === evidence.evidenceId),
      'Acceptance Evidence Link is missing')
    report.delivery = {
      artifactId: artifact.id,
      evidenceId: evidence.evidenceId,
      acceptanceId: acceptance.id,
      acceptanceStatus: acceptance.status
    }
  })

  await check('Diff/Test/Delivery actions expose the live Project surfaces', async () => {
    await page.click('[data-experience-mode-option="studio"]')
    await page.waitForSelector('[data-project-workspace-studio]', { visible: true, timeout: 15_000 })
    await page.waitForSelector(`[data-session-id="${report.sessionId}"]`, { visible: true, timeout: 15_000 })
    await page.click(`[data-session-id="${report.sessionId}"]`)
    await page.click('[data-studio-projection-tab="workspace"]')
    await waitForValue(
      () => page.evaluate(() => ({
        busy: document.querySelector('[data-project-workspace-studio]')?.getAttribute('aria-busy'),
        hasDiff: Boolean(document.querySelector('[data-project-execution-action="diff"]'))
      })),
      (value) => value.busy === 'false' && value.hasDiff,
      15_000,
      'waiting for stable Project execution actions'
    )
    await page.$eval('[data-project-execution-action="diff"]', (button) => button.click())
    await page.waitForSelector('[data-workbench-active-panel="diff"]', { visible: true, timeout: 15_000 })
    await page.click('[data-studio-projection-tab="workspace"]')
    await page.click('[data-project-execution-action="delivery"]')
    await page.waitForFunction(() => document.querySelector('[data-project-flow-step="delivery"]')?.hasAttribute('open') === true)
    await page.waitForSelector('[data-project-delivery-workbench]', { visible: true, timeout: 15_000 })
  })

  await stopElectron()
  await launchElectron('restart')

  await check('restart restores the same Session, plan approval and delivery records', async () => {
    const restored = await waitForValue(
      () => page.evaluate((id) => window.agentDesk.listSessions().then((items) => items.find((item) => item.id === id)), report.sessionId),
      (meta) => Boolean(meta?.id && meta.workspaceId === ids.project && meta.status !== 'starting' && meta.status !== 'running'),
      25_000,
      'waiting for Session restart recovery'
    )
    const [plan, ledger, evidencePage, delivery] = await page.evaluate(async ({ id, projectId }) => Promise.all([
      window.agentDesk.getTaskPlan(id),
      window.agentDesk.listWorkflowLedger({ projectId, limit: 500 }),
      window.agentDesk.queryWorkflowEvidence({ projectId, limit: 500 }),
      window.agentDesk.getProjectDeliveryWorkbench(projectId)
    ]), { id: report.sessionId, projectId: ids.project })
    assert.equal(restored.id, report.sessionId)
    assert.equal(plan.approvalStatus, 'approved')
    assert(ledger.artifacts.items.some((item) => item.id === report.delivery.artifactId))
    assert(evidencePage.items.some((item) => item.evidenceId === report.delivery.evidenceId))
    assert(delivery.acceptances.some((item) => item.id === report.delivery.acceptanceId && item.status === 'passed'))
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert(!stderr.includes('Conversation Ledger archive failed'), `Conversation Ledger archive failed after restart:\n${stderr}`)
  })

  report.status = 'passed'
  writeReport()
  console.log(`project golden delivery e2e: passed (${checks.length}/${checks.length})`)
  console.log(path.join(reportDir, 'report.json'))
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  report.rendererDiagnostic = await captureRendererDiagnostic(page)
  writeReport()
  console.error(`project golden delivery e2e: failed: ${report.error}`)
  process.exitCode = 1
} finally {
  await stopElectron().catch(() => undefined)
  if (server) await close(server.server).catch(() => undefined)
  if (process.env.CAOGEN_KEEP_PROJECT_GOLDEN_FIXTURE !== '1') rmSync(tempRoot, { recursive: true, force: true })
}

async function check(name, run) {
  const startedAt = Date.now()
  try {
    const value = await run()
    checks.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
    return value
  } catch (error) {
    checks.push({ name, status: 'fail', durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

async function captureRendererDiagnostic(activePage) {
  if (!activePage) return { available: false }
  try {
    return await activePage.evaluate(() => {
      const pane = document.querySelector('.experience-pane')
      const workspace = document.querySelector('[data-project-workspace-studio]')
      const projectSelect = workspace?.querySelector('select')
      return {
        available: true,
        experienceMode: pane?.getAttribute('data-experience-mode'),
        studioSurface: pane?.getAttribute('data-studio-surface'),
        workspaceBusy: workspace?.getAttribute('aria-busy'),
        selectedProjectId: projectSelect instanceof HTMLSelectElement ? projectSelect.value : undefined,
        projectOptions: projectSelect instanceof HTMLSelectElement
          ? [...projectSelect.options].map((option) => ({ value: option.value, label: option.textContent }))
          : [],
        primarySurface: Boolean(document.querySelector('[data-project-primary-surface]')),
        text: workspace?.textContent?.slice(0, 2_000)
      }
    })
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function prepareGitFixture() {
  writeFileSync(path.join(projectRoot, 'README.md'), `${baselineLines.join('\n')}\n`, 'utf8')
  writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'ux-golden-project-fixture',
    private: true,
    scripts: { test: "node -e \"console.log('ux-golden-pass')\"" }
  }, null, 2) + '\n', 'utf8')
  execFileSync('git', ['init', '-b', 'main'], { cwd: projectRoot, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'ux-golden@example.invalid'], { cwd: projectRoot })
  execFileSync('git', ['config', 'user.name', 'CaoGen UX Golden'], { cwd: projectRoot })
  execFileSync('git', ['add', '.'], { cwd: projectRoot })
  execFileSync('git', ['commit', '-m', 'fixture baseline'], { cwd: projectRoot, stdio: 'ignore' })
}

async function startOpenAiMock() {
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(404).end('not found')
      return
    }
    for await (const _chunk of request) { /* consume request */ }
    const text = 'Approved project execution completed.'
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`)
    response.write(`data: ${JSON.stringify({ type: 'response.completed', response: { id: `ux-golden-${Date.now()}`, output_text: text, usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } } })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` }
}

async function launchElectron(phase) {
  const remotePort = await findFreePort(9980)
  electron = spawnElectronTestProcess(electronBin, [
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
      ANTHROPIC_AUTH_TOKEN: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  stdout = ''; stderr = ''
  electron.stdout?.on('data', (chunk) => { stdout += chunk.toString() })
  electron.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
  await waitForDebugPort(remotePort, 20_000)
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${remotePort}`, defaultViewport: null })
  page = await waitForElectronPage(browser, 20_000)
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
  await page.waitForSelector('.app', { timeout: 20_000 })
  await page.waitForFunction(() => typeof window.agentDesk?.createProjectWorkspace === 'function', { timeout: 20_000 })
  await new Promise((resolve) => setTimeout(resolve, phase === 'restart' ? 1_500 : 500))
}

async function stopElectron() {
  if (browser) {
    browser.disconnect()
    browser = undefined
    page = undefined
  }
  if (electron) {
    await terminateElectronTestProcess(electron)
    electron = undefined
  }
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
    async () => (await connectedBrowser.pages()).find((candidate) => candidate.url().startsWith('file:')),
    Boolean,
    timeoutMs,
    'waiting for Electron renderer page'
  )
}

async function waitForDebugPort(port, timeoutMs) {
  await waitForValue(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok } catch { return false }
  }, Boolean, timeoutMs, `waiting for Electron debug port ${port}`)
}

async function waitForValue(producer, predicate, timeoutMs, label) {
  const started = Date.now()
  let value
  while (Date.now() - started < timeoutMs) {
    value = await producer()
    if (predicate(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  throw new Error(`${label}: ${JSON.stringify(value)}`)
}

async function findFreePort(start) {
  for (let port = start; port < start + 100; port += 1) {
    const probe = http.createServer()
    try {
      await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve) })
      await new Promise((resolve) => probe.close(resolve))
      return port
    } catch {
      probe.close()
    }
  }
  throw new Error(`no free port from ${start}`)
}

function close(target) {
  return new Promise((resolve) => target.close(() => resolve()))
}

function writeReport() {
  mkdirSync(reportDir, { recursive: true })
  const output = `${JSON.stringify({ ...report, stdout: stdout.slice(-2_000), stderr: stderr.slice(-4_000) }, null, 2)}\n`
  writeFileSync(path.join(reportDir, 'report.json'), output, 'utf8')
  mkdirSync(reportRoot, { recursive: true })
  writeFileSync(path.join(reportRoot, 'latest.json'), output, 'utf8')
}

function gitOutput(args) {
  try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim() } catch { return '' }
}

function gitStatusCount() {
  return gitOutput(['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean).length
}
