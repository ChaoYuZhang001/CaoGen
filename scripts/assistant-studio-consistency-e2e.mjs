#!/usr/bin/env node
import { createHash } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const packageJson = require(path.join(repoRoot, 'package.json'))
const electronPackage = require('electron/package.json')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const outputRoot = path.join(repoRoot, 'test-results', 'assistant-studio-consistency')
const runDir = path.join(outputRoot, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-assistant-studio-consistency-'))
const userDataDir = path.join(tempRoot, 'userData')
const projectDir = path.join(tempRoot, 'project')
const sourceOutDir = path.join(repoRoot, 'out')
const isolatedOutDir = path.join(runDir, 'app', 'out')
const mainEntry = path.join(isolatedOutDir, 'main', 'index.js')
const electronBin = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const ids = {
  projectId: 'exp-002-project',
  goalId: 'exp-002-goal',
  workItemId: 'exp-002-work-item',
  artifactId: 'exp-002-artifact'
}

assert(existsSync(electronBin), 'Electron binary not found. Run npm install first.')
for (const entry of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
  assert(existsSync(path.join(sourceOutDir, entry)), `Built app entry missing: out/${entry}. Run npm run build first.`)
}

mkdirSync(runDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
mkdirSync(projectDir, { recursive: true })
writeFileSync(path.join(projectDir, 'README.md'), '# Assistant Studio consistency E2E\n', 'utf8')

const initialSourceBuildBinding = inspectSourceBuildBinding()
const report = {
  schemaVersion: 1,
  runId,
  runDir,
  requirement: 'required',
  requirementIds: ['EXP-002'],
  packageVersion: packageJson.version,
  gitCommit: '',
  worktreeClean: false,
  statusEntryCount: 0,
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  electronVersion: electronPackage.version,
  sourceBuildBinding: { status: initialSourceBuildBinding.status, initial: initialSourceBuildBinding },
  checks: [],
  screenshots: [],
  canonicalIds: null,
  baselineDigest: '',
  modelRequestCount: 0,
  warnings: [],
  coverage: {
    verified: [
      'Assistant and Studio read the same ProjectWorkspace, Goal, WorkItem, canonical Run, and Artifact records',
      'a production SessionManager send creates the Run under the selected Project/Goal/WorkItem ownership',
      'a Studio-mode Artifact write remains visible from Assistant without ID translation or duplication',
      'ten bidirectional projection switches preserve exact IDs, revisions, ownership, refs, and record digests',
      'renderer reload preserves the same persistent canonical identities and Studio rows'
    ],
    explicitlyNotVerified: [
      'approval, failure, notification, and crash-recovery continuity covered by EXP-003 and RUN-005',
      'clean release-commit binding'
    ]
  }
}

if (initialSourceBuildBinding.status !== 'pass') {
  report.status = 'fail'
  report.error = staleBuildMessage(initialSourceBuildBinding)
  writeReport()
  cleanupTempRoot(tempRoot)
  throw new Error(report.error)
}

copyBuiltApp()
const mock = await startOpenAiMock()
const remotePort = await findFreePort(9980)
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
const watchdog = setTimeout(() => signalElectronTree(electron.pid, 'SIGKILL'), 120_000)

let stdout = ''
let stderr = ''
let browser
let page
let sessionId = ''
let runRecordId = ''
let baseline
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
  await waitForApp(page, false)

  await check('Assistant creates one owned Project, Goal, WorkItem, and production Run', async () => {
    const created = await page.evaluate(async ({ entityIds, cwd, baseUrl }) => {
      const project = await window.agentDesk.createProjectWorkspace({
        id: entityIds.projectId,
        name: 'EXP-002 shared projection',
        kind: 'software'
      })
      const goal = await window.agentDesk.createProjectGoal({
        id: entityIds.goalId,
        projectId: project.id,
        title: 'Keep canonical identity across projections',
        objective: 'Assistant and Studio must share one store',
        status: 'planned'
      })
      const workItem = await window.agentDesk.createProjectWorkItem({
        id: entityIds.workItemId,
        projectId: project.id,
        goalId: goal.id,
        title: 'Verify shared canonical records',
        type: 'testing',
        status: 'ready'
      })
      const provider = await window.agentDesk.createProvider({
        name: 'EXP-002 Responses Mock',
        baseUrl,
        token: 'test-only',
        models: ['exp-002-model'],
        openaiProtocol: 'responses'
      })
      const session = await window.agentDesk.createSession({
        cwd,
        workspaceId: project.id,
        goalId: goal.id,
        workItemId: workItem.id,
        engine: 'openai',
        providerId: provider.id,
        model: 'exp-002-model',
        routingScope: 'fixed',
        permissionMode: 'default',
        isolated: false,
        title: 'EXP-002 canonical session'
      })
      return { project, goal, workItem, session }
    }, { entityIds: ids, cwd: projectDir, baseUrl: mock.baseUrl })

    sessionId = created.session.id
    assert(created.project.id === ids.projectId, 'Project ID changed during creation')
    assert(created.goal.id === ids.goalId, 'Goal ID changed during creation')
    assert(created.workItem.id === ids.workItemId, 'WorkItem ID changed during creation')
    await waitForValue(
      () => page.evaluate((id) => window.agentDesk.listSessions().then((items) => items.find((item) => item.id === id)), sessionId),
      (meta) => Boolean(meta?.sdkSessionId && meta.status === 'idle'),
      15_000,
      'waiting for owned session initialization'
    )

    await page.evaluate((id) => window.agentDesk.sendMessage(id, {
      text: 'Create one canonical Run for Assistant Studio identity verification.',
      messageId: 'exp-002-message'
    }), sessionId)
    const completed = await waitForValue(
      () => page.evaluate(async ({ projectId, id }) => {
        const [sessions, transcript, ledger] = await Promise.all([
          window.agentDesk.listSessions(),
          window.agentDesk.getTranscript(id),
          window.agentDesk.listWorkflowLedger({ projectId, limit: 500 })
        ])
        return {
          meta: sessions.find((item) => item.id === id),
          turnResultCount: transcript.filter((entry) => entry.event?.kind === 'turn-result').length,
          runs: ledger.runs.items
        }
      }, { projectId: ids.projectId, id: sessionId }),
      (value) => value.meta?.status === 'idle' && value.turnResultCount === 1 && value.runs.length === 1,
      20_000,
      'waiting for canonical Run completion'
    )
    runRecordId = completed.runs[0].id
    assert(completed.runs[0].projectId === ids.projectId, 'Run Project ownership mismatch')
    assert(completed.runs[0].goalId === ids.goalId, 'Run Goal ownership mismatch')
    assert(completed.runs[0].workItemId === ids.workItemId, 'Run WorkItem ownership mismatch')
    assert(completed.runs[0].sessionId === sessionId, 'Run Session identity mismatch')
    assert(mock.requests === 1, `expected one model request, got ${mock.requests}`)
  })

  await check('Studio writes the Artifact and renders the same Project, Goal, and WorkItem IDs', async () => {
    await clickMode(page, 'studio')
    await clickStudioSurface(page, 'workspace')
    await waitForStudioRecords(page)

    const linked = await page.evaluate(async ({ entityIds, runId }) => {
      const artifact = await window.agentDesk.createWorkflowArtifact({
        id: entityIds.artifactId,
        projectId: entityIds.projectId,
        goalId: entityIds.goalId,
        workItemId: entityIds.workItemId,
        runId,
        kind: 'test_report',
        title: 'EXP-002 projection consistency report',
        version: 1,
        digest: `sha256:${'a'.repeat(64)}`,
        provenance: 'explicit',
        metadata: { requirementId: 'EXP-002' }
      })
      const current = await window.agentDesk.getProjectWorkItem(entityIds.workItemId)
      if (!current) throw new Error('WorkItem disappeared before Artifact linkage')
      const workItem = await window.agentDesk.updateProjectWorkItem(entityIds.workItemId, {
        runRefs: [runId],
        artifactRefs: [artifact.id]
      }, { expectedRevision: current.revision })
      return { artifact, workItem }
    }, { entityIds: ids, runId: runRecordId })

    assert(linked.artifact.id === ids.artifactId, 'Artifact ID changed during Studio write')
    assert(linked.artifact.runId === runRecordId, 'Artifact Run ownership mismatch')
    assert(linked.workItem.runRefs.includes(runRecordId), 'Project WorkItem omitted canonical Run ref')
    assert(linked.workItem.artifactRefs.includes(ids.artifactId), 'Project WorkItem omitted Artifact ref')
    await page.click('[data-studio-action="refresh"]')
    await waitForStudioRecords(page, linked.workItem.revision)
    await screenshot(page, '01-studio-canonical-records')

    await clickMode(page, 'assistant')
    baseline = await readCanonicalSnapshot(page)
    assertCanonicalSnapshot(baseline)
    report.canonicalIds = baseline.ids
    report.baselineDigest = stableDigest(baseline)
  })

  await check('ten Assistant/Studio roundtrips preserve exact canonical records', async () => {
    for (let cycle = 0; cycle < 10; cycle += 1) {
      await clickMode(page, 'studio')
      await clickStudioSurface(page, 'workspace')
      await waitForStudioRecords(page, baseline.workItem.revision)
      assertSnapshotEqual(baseline, await readCanonicalSnapshot(page), `cycle ${cycle + 1} Studio`)

      await clickMode(page, 'assistant')
      assertSnapshotEqual(baseline, await readCanonicalSnapshot(page), `cycle ${cycle + 1} Assistant`)
    }
    assert(mock.requests === 1, `projection switches created ${mock.requests} model requests`)
  })

  await check('renderer reload preserves the same store and Studio rows', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApp(page, true)
    assertSnapshotEqual(baseline, await readCanonicalSnapshot(page), 'renderer reload')
    await clickMode(page, 'studio')
    await clickStudioSurface(page, 'workspace')
    await waitForStudioRecords(page, baseline.workItem.revision)
    assertSnapshotEqual(baseline, await readCanonicalSnapshot(page), 'reloaded Studio')
    await screenshot(page, '02-reloaded-studio-canonical-records')
  })

  await check('Workflow Ledger remains valid with one Run and one Artifact', async () => {
    const verification = await page.evaluate(() => window.agentDesk.verifyWorkflowLedger())
    assert(verification.valid === true, 'Workflow Ledger verification failed')
    const finalSnapshot = await readCanonicalSnapshot(page)
    assertSnapshotEqual(baseline, finalSnapshot, 'final verification')
    assert(finalSnapshot.counts.runs === 1, `expected one Run, got ${finalSnapshot.counts.runs}`)
    assert(finalSnapshot.counts.artifacts === 1, `expected one Artifact, got ${finalSnapshot.counts.artifacts}`)
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
  report.modelRequestCount = mock.requests
  const finalSourceBuildBinding = inspectSourceBuildBinding()
  report.sourceBuildBinding.final = finalSourceBuildBinding
  report.sourceBuildBinding.status = finalSourceBuildBinding.status
  if (finalSourceBuildBinding.status !== 'pass' && !report.error) {
    report.error = `Source/build binding changed during E2E. ${staleBuildMessage(finalSourceBuildBinding)}`
  }
  const workflowBindingError = findWorkflowBindingError(stderr)
  if (workflowBindingError && !report.error) {
    report.error = `Workflow binding error observed in Electron stderr: ${workflowBindingError}`
  }
  report.warnings.push(...summarizeProcessOutput(stdout, stderr, exited))
  report.status = report.checks.every((item) => item.status === 'pass') && !report.error ? 'pass' : 'fail'
  writeReport()
  cleanupTempRoot(tempRoot)
}

if (report.status !== 'pass') {
  console.error(`assistant/studio consistency E2E failed: ${report.error || 'check failure'}`)
  process.exitCode = 1
} else {
  console.log(`assistant/studio consistency E2E ok: ${runDir}`)
  console.log(`${report.checks.length}/${report.checks.length} checks passed; canonical digest ${report.baselineDigest}`)
}

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
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}

async function readCanonicalSnapshot(targetPage) {
  return targetPage.evaluate(async ({ entityIds, id }) => {
    const [projects, goals, workItems, ledger, sessions] = await Promise.all([
      window.agentDesk.listProjectWorkspaces({ includeArchived: true, includeDeleted: true }),
      window.agentDesk.listProjectGoals(entityIds.projectId, { includeArchived: true }),
      window.agentDesk.listProjectWorkItems(entityIds.projectId),
      window.agentDesk.listWorkflowLedger({ projectId: entityIds.projectId, limit: 500 }),
      window.agentDesk.listSessions()
    ])
    const project = projects.find((item) => item.id === entityIds.projectId)
    const goal = goals.find((item) => item.id === entityIds.goalId)
    const workItem = workItems.find((item) => item.id === entityIds.workItemId)
    const run = ledger.runs.items.find((item) => item.id === id.runId)
    const artifact = ledger.artifacts.items.find((item) => item.id === entityIds.artifactId)
    const session = sessions.find((item) => item.id === id.sessionId)
    return {
      ids: {
        projectIds: projects.map((item) => item.id).sort(),
        goalIds: goals.map((item) => item.id).sort(),
        workItemIds: workItems.map((item) => item.id).sort(),
        runIds: ledger.runs.items.map((item) => item.id).sort(),
        artifactIds: ledger.artifacts.items.map((item) => item.id).sort(),
        sessionIds: sessions.map((item) => item.id).sort()
      },
      counts: {
        projects: projects.length,
        goals: goals.length,
        workItems: workItems.length,
        runs: ledger.runs.total,
        artifacts: ledger.artifacts.total
      },
      project: project && { id: project.id, status: project.status, revision: project.revision },
      goal: goal && {
        id: goal.id,
        projectId: goal.projectId,
        status: goal.status,
        revision: goal.revision
      },
      workItem: workItem && {
        id: workItem.id,
        projectId: workItem.projectId,
        goalId: workItem.goalId,
        status: workItem.status,
        revision: workItem.revision,
        runRefs: [...workItem.runRefs].sort(),
        artifactRefs: [...workItem.artifactRefs].sort()
      },
      run: run && {
        id: run.id,
        projectId: run.projectId,
        goalId: run.goalId,
        workItemId: run.workItemId,
        sessionId: run.sessionId,
        taskId: run.taskId,
        status: run.status,
        revision: run.revision,
        attempt: run.attempt,
        taskRunDigest: run.taskRunDigest
      },
      artifact: artifact && {
        id: artifact.id,
        projectId: artifact.projectId,
        goalId: artifact.goalId,
        workItemId: artifact.workItemId,
        runId: artifact.runId,
        kind: artifact.kind,
        version: artifact.version,
        digest: artifact.digest,
        provenance: artifact.provenance
      },
      ledgerWorkItem: ledger.workItems.items.find((item) => item.id === entityIds.workItemId),
      session: session && {
        id: session.id,
        workspaceId: session.workspaceId,
        goalId: session.goalId,
        workItemId: session.workItemId,
        providerId: session.providerId,
        model: session.model,
        engine: session.engine,
        routingScope: session.routingScope,
        status: session.status
      }
    }
  }, { entityIds: ids, id: { sessionId, runId: runRecordId } })
}

function assertCanonicalSnapshot(snapshot) {
  assert(snapshot.counts.projects === 1, `expected one Project, got ${snapshot.counts.projects}`)
  assert(snapshot.counts.goals === 1, `expected one Goal, got ${snapshot.counts.goals}`)
  assert(snapshot.counts.workItems === 1, `expected one WorkItem, got ${snapshot.counts.workItems}`)
  assert(snapshot.counts.runs === 1, `expected one Run, got ${snapshot.counts.runs}`)
  assert(snapshot.counts.artifacts === 1, `expected one Artifact, got ${snapshot.counts.artifacts}`)
  assert(snapshot.project?.id === ids.projectId, 'canonical Project missing')
  assert(snapshot.goal?.id === ids.goalId && snapshot.goal.projectId === ids.projectId, 'canonical Goal ownership changed')
  assert(
    snapshot.workItem?.id === ids.workItemId &&
      snapshot.workItem.projectId === ids.projectId &&
      snapshot.workItem.goalId === ids.goalId,
    'canonical WorkItem ownership changed'
  )
  assert(snapshot.run?.id === runRecordId, 'canonical Run missing')
  assert(snapshot.run.projectId === ids.projectId, 'canonical Run Project changed')
  assert(snapshot.run.goalId === ids.goalId, 'canonical Run Goal changed')
  assert(snapshot.run.workItemId === ids.workItemId, 'canonical Run WorkItem changed')
  assert(snapshot.run.sessionId === sessionId, 'canonical Run Session changed')
  assert(snapshot.artifact?.id === ids.artifactId, 'canonical Artifact missing')
  assert(snapshot.artifact.projectId === ids.projectId, 'canonical Artifact Project changed')
  assert(snapshot.artifact.goalId === ids.goalId, 'canonical Artifact Goal changed')
  assert(snapshot.artifact.workItemId === ids.workItemId, 'canonical Artifact WorkItem changed')
  assert(snapshot.artifact.runId === runRecordId, 'canonical Artifact Run changed')
  assert(snapshot.workItem.runRefs.includes(runRecordId), 'Project WorkItem lost its Run ref')
  assert(snapshot.workItem.artifactRefs.includes(ids.artifactId), 'Project WorkItem lost its Artifact ref')
  assert(snapshot.ledgerWorkItem?.runIds.includes(runRecordId), 'Workflow WorkItem lost its Run projection')
  assert(snapshot.session?.workspaceId === ids.projectId, 'Session Workspace ownership changed')
  assert(snapshot.session?.goalId === ids.goalId, 'Session Goal ownership changed')
  assert(snapshot.session?.workItemId === ids.workItemId, 'Session WorkItem ownership changed')
}

function assertSnapshotEqual(expected, actual, label) {
  assertCanonicalSnapshot(actual)
  const expectedDigest = stableDigest(expected)
  const actualDigest = stableDigest(actual)
  assert(actualDigest === expectedDigest, `${label}: canonical snapshot ${expectedDigest} -> ${actualDigest}`)
}

async function waitForStudioRecords(targetPage, workItemRevision) {
  await targetPage.waitForFunction(({ projectId, goalId, workItemId, revision }) => {
    const project = document.querySelector('[data-project-workspace-select]')
    const goal = document.querySelector(`[data-goal-id="${goalId}"]`)
    const workItem = document.querySelector(`[data-work-item-id="${workItemId}"]`)
    return project?.value === projectId && Boolean(goal) && Boolean(workItem) &&
      (revision === undefined || Number(workItem.getAttribute('data-work-item-revision')) === revision)
  }, { timeout: 15_000 }, {
    projectId: ids.projectId,
    goalId: ids.goalId,
    workItemId: ids.workItemId,
    revision: workItemRevision
  })
}

async function clickMode(targetPage, mode) {
  await targetPage.click(`[data-experience-mode-option="${mode}"]`)
  await targetPage.waitForFunction((expected) => {
    const pressed = Array.from(document.querySelectorAll('[data-experience-mode-option]'))
      .filter((option) => option.getAttribute('aria-pressed') === 'true')
    const pane = document.querySelector('[data-experience-mode]')
    return pressed.length === 1 && pressed[0].getAttribute('data-experience-mode-option') === expected &&
      pane?.getAttribute('data-experience-mode') === expected
  }, { timeout: 10_000 }, mode)
  if (mode === 'studio') await targetPage.waitForSelector('[data-studio-view]', { timeout: 10_000 })
}

async function clickStudioSurface(targetPage, surface) {
  await targetPage.click(`[data-studio-projection-tab="${surface}"]`)
  await targetPage.waitForSelector(`#studio-projection-panel-${surface}:not([hidden])`, {
    visible: true,
    timeout: 10_000
  })
}

async function waitForApp(targetPage, expectSession) {
  await targetPage.waitForSelector('.app', { timeout: 20_000 })
  await targetPage.waitForFunction(() =>
    typeof window.agentDesk?.createProjectWorkspace === 'function' &&
    typeof window.agentDesk?.createWorkflowArtifact === 'function', { timeout: 15_000 })
  await targetPage.waitForSelector('[data-experience-mode-switcher]', { visible: true, timeout: 15_000 })
  await targetPage.waitForSelector(expectSession ? '.composer-input' : '.welcome-composer-input', {
    visible: true,
    timeout: 15_000
  })
}

async function startOpenAiMock() {
  let requests = 0
  const server = http.createServer(async (request, response) => {
    if (request.url !== '/v1/responses' || request.method !== 'POST') {
      response.writeHead(404).end('not found')
      return
    }
    requests += 1
    for await (const _chunk of request) {
      // Consume the request before completing the stream.
    }
    const reply = 'Shared canonical identity verified.'
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: reply })}\n\n`)
    response.write(`data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: `resp_exp_002_${Date.now()}`,
        output_text: reply,
        usage: { input_tokens: 14, output_tokens: 6, input_tokens_details: { cached_tokens: 0 } }
      }
    })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  const port = await findFreePort(9200)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    get requests() { return requests }
  }
}

function copyBuiltApp() {
  rmSync(isolatedOutDir, { recursive: true, force: true })
  mkdirSync(isolatedOutDir, { recursive: true })
  for (const directory of ['main', 'preload', 'renderer']) {
    cpSync(path.join(sourceOutDir, directory), path.join(isolatedOutDir, directory), { recursive: true })
  }
}

function inspectSourceBuildBinding() {
  const groups = [
    { target: 'main', output: 'out/main/index.js', sourceRoots: ['src/main', 'src/shared'] },
    { target: 'preload', output: 'out/preload/index.js', sourceRoots: ['src/preload', 'src/shared'] },
    { target: 'renderer', output: 'out/renderer/index.html', sourceRoots: ['src/renderer', 'src/shared'] }
  ].map((group) => {
    const latestSource = newestSourceFile(group.sourceRoots)
    const outputMtimeMs = statSync(path.join(repoRoot, group.output)).mtimeMs
    return {
      ...group,
      latestSource,
      outputMtimeMs,
      fresh: latestSource.mtimeMs <= outputMtimeMs
    }
  })
  return {
    status: groups.every((group) => group.fresh) ? 'pass' : 'fail',
    checkedAt: new Date().toISOString(),
    groups
  }
}

function newestSourceFile(sourceRoots) {
  let latest = { path: '', mtimeMs: 0 }
  const visit = (relativePath) => {
    const absolutePath = path.join(repoRoot, relativePath)
    const stats = statSync(absolutePath)
    if (stats.isDirectory()) {
      for (const entry of readdirSync(absolutePath)) visit(path.join(relativePath, entry))
      return
    }
    if (stats.mtimeMs > latest.mtimeMs) latest = { path: relativePath, mtimeMs: stats.mtimeMs }
  }
  for (const sourceRoot of sourceRoots) visit(sourceRoot)
  assert(latest.path, `No source files found under ${sourceRoots.join(', ')}`)
  return latest
}

function staleBuildMessage(binding) {
  const stale = binding.groups
    .filter((group) => !group.fresh)
    .map((group) => `${group.target}: ${group.latestSource.path} is newer than ${group.output}`)
  return `Built app is stale (${stale.join('; ')}). Run npm run build before this E2E.`
}

function stableDigest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function writeReport() {
  const reportText = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(runDir, 'report.json'), reportText)
  writeFileSync(path.join(outputRoot, 'latest.json'), reportText)
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

function findWorkflowBindingError(stderrText) {
  const failure = stderrText.split(/\r?\n/).find((line) =>
    line.includes('[caogen] 写入任务快照失败:') ||
    line.includes('[caogen] terminal TaskRun persistence/binding failed:') ||
    /canonical (?:Workspace|Goal|WorkItem) does not exist:/.test(line)
  )
  return failure?.trim()
}

function readGitState() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
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
