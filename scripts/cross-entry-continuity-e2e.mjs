#!/usr/bin/env node

import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnElectronTestProcess, terminateElectronTestProcess } from './lib/electron-test-process.mjs'
import { bindSourceEvidence, readSourceEvidenceState } from './lib/source-evidence-binding.mjs'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const electronBin = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const sourceOutDir = path.join(repoRoot, 'out')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'cross-entry-continuity')
const reportDir = path.join(reportRoot, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-cross-entry-continuity-'))
const userDataDir = path.join(tempRoot, 'userData')
const projectRoot = path.join(tempRoot, 'project')
const isolatedOutDir = path.join(reportDir, 'app', 'out')
const mainEntry = path.join(isolatedOutDir, 'main', 'index.js')
const sourceEvidenceAtStart = readSourceEvidenceState(repoRoot)
const fixtureCredential = randomUUID()
const OFFICE_MAX_VISIBLE_SESSIONS = 9
const CONTROL_ROOM_TEST_SESSION_COUNT = 11
const CONTROL_ROOM_REQUIRED_GATES = [
  'office_nine_workstation_capacity',
  'office_tenth_session_overflow_list',
  'office_active_session_prioritized',
  'office_source_entry_return',
  'office_equivalent_list_view'
]
const ids = {
  project: 'ux-golden-005-project',
  goal: 'ux-golden-005-goal',
  workItem: 'ux-golden-005-work-item',
  artifact: 'ux-golden-005-artifact',
  evidence: 'ux-golden-005-evidence',
  acceptance: 'ux-golden-005-acceptance',
  evidenceLink: 'ux-golden-005-evidence-link'
}
const bytes = Buffer.from('# Cross-entry delivery\n\nThe same result is projected in every entry.\n', 'utf8')
const digest = createHash('sha256').update(bytes).digest('hex')

for (const entry of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
  assert(existsSync(path.join(sourceOutDir, entry)), `Built app entry missing: out/${entry}. Run npm run build first.`)
}
assert(existsSync(electronBin), 'Electron binary not found. Run npm install first.')
mkdirSync(reportDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
mkdirSync(projectRoot, { recursive: true })
writeFileSync(path.join(projectRoot, 'delivery.md'), bytes)
copyBuiltApp()

const checks = []
const report = {
  schemaVersion: 1,
  runId,
  gate: 'test:cross-entry-continuity',
  requirement: 'UX-GOLDEN-005',
  classification: 'local_targeted_not_release',
  sourceRevision: sourceEvidenceAtStart.commit,
  sourceWorktreeClean: sourceEvidenceAtStart.worktreeClean,
  worktreeStatusCount: sourceEvidenceAtStart.statusEntryCount,
  status: 'failed',
  checks,
  continuity: {},
  controlRoom: {
    sessionFixtureCount: CONTROL_ROOM_TEST_SESSION_COUNT,
    maxExpensiveWorkstations: OFFICE_MAX_VISIBLE_SESSIONS,
    requiredGates: CONTROL_ROOM_REQUIRED_GATES,
    gates: []
  },
  warnings: [],
  explicitlyNotVerified: ['five-user timed acceptance', 'clean release SHA binding', 'multi-device collaboration']
}
let server
let electron
let browser
let page
let serverBase = ''
let stderr = ''

try {
  server = await startOpenAiMock()
  serverBase = server.baseUrl
  await launchElectron(false)

  const fixture = await check('Assistant starts a project-bound task without changing canonical identity', async () => {
    const created = await page.evaluate(async ({ ids: entityIds, cwd, baseUrl, credential, sessionCount }) => {
      const project = await window.agentDesk.createProjectWorkspace({ id: entityIds.project, name: 'Cross-entry continuity', kind: 'research' })
      const goal = await window.agentDesk.createProjectGoal({
        id: entityIds.goal, projectId: project.id, title: 'One continuous delivery',
        objective: 'Keep one result continuous across Assistant, Project and Control Room', status: 'planned'
      })
      const workItem = await window.agentDesk.createProjectWorkItem({
        id: entityIds.workItem, projectId: project.id, goalId: goal.id,
        title: 'Preserve identity across entries', description: goal.objective, type: 'research', status: 'ready'
      })
      const provider = await window.agentDesk.createProvider({
        name: 'Cross-entry Local Provider', baseUrl, token: credential,
        models: ['cross-entry-model'], openaiProtocol: 'responses'
      })
      const session = await window.agentDesk.createSession({
        cwd, workspaceId: project.id, goalId: goal.id, workItemId: workItem.id,
        providerId: provider.id, model: 'cross-entry-model', routingScope: 'fixed',
        isolated: false, taskStrategy: 'execute', experienceModeOverride: 'assistant', title: 'Cross-entry task'
      })
      const overflowSessions = []
      for (let index = 1; index < sessionCount; index += 1) {
        overflowSessions.push(await window.agentDesk.createSession({
          cwd, workspaceId: project.id, goalId: goal.id, workItemId: workItem.id,
          providerId: provider.id, model: 'cross-entry-model', routingScope: 'fixed',
          isolated: false, taskStrategy: 'execute', experienceModeOverride: 'assistant',
          title: `Cross-entry overflow ${String(index).padStart(2, '0')}`
        }))
      }
      return { project, goal, workItem, session, overflowSessions }
    }, {
      ids,
      cwd: projectRoot,
      baseUrl: serverBase,
      credential: fixtureCredential,
      sessionCount: CONTROL_ROOM_TEST_SESSION_COUNT
    })
    assert.equal(created.session.workspaceId, ids.project)
    assert.equal(created.session.goalId, ids.goal)
    assert.equal(created.session.workItemId, ids.workItem)
    const fixtureSessionIds = [created.session.id, ...created.overflowSessions.map((item) => item.id)]
    await waitForValue(
      () => page.evaluate((expectedIds) => window.agentDesk.listSessions().then((items) => expectedIds.map((id) => items.find((item) => item.id === id))), fixtureSessionIds),
      (metas) => metas.length === CONTROL_ROOM_TEST_SESSION_COUNT && metas.every((meta) => Boolean(meta?.sdkSessionId && meta.status === 'idle')),
      35_000,
      'waiting for bounded control-room Session fixture initialization'
    )
    // The fixture creates through preload, so rehydrate the renderer before using
    // sidebar navigation. Otherwise the new active Session can be mistaken for a
    // resumable history entry and the test itself attempts a duplicate resume.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
    await page.waitForFunction(
      (id) => document.querySelector(`.session-card:not(.history-card)[data-session-id="${id}"]`) !== null,
      { timeout: 20_000 },
      created.session.id
    )
    await page.evaluate((id) => window.agentDesk.sendMessage(id, {
      text: 'Prepare the cross-entry delivery result.', messageId: 'ux-golden-005-message'
    }), created.session.id)
    await waitForValue(
      () => page.evaluate(async ({ id, projectId }) => {
        const [sessions, ledger] = await Promise.all([
          window.agentDesk.listSessions(),
          window.agentDesk.listWorkflowLedger({ projectId, limit: 500 })
        ])
        return {
          session: sessions.find((item) => item.id === id),
          runs: ledger.runs.items.filter((item) => item.sessionId === id)
        }
      }, { id: created.session.id, projectId: ids.project }),
      (value) => value.session?.status === 'idle' && value.runs.some((run) => run.status === 'completed'),
      25_000,
      'waiting for Assistant result'
    )
    return created
  })
  const session = fixture.session
  const overflowSessionIds = fixture.overflowSessions.map((item) => item.id)

  await check('Artifact, Evidence and Acceptance are linked before projection switching', async () => {
    const linked = await page.evaluate(async ({ ids: entityIds, projectPath, fileDigest }) => {
      const artifact = await window.agentDesk.createWorkflowArtifact({
        id: entityIds.artifact, projectId: entityIds.project, goalId: entityIds.goal,
        workItemId: entityIds.workItem, kind: 'report', title: 'Cross-entry delivery',
        digest: `sha256:${fileDigest}`, mediaType: 'text/markdown', provenance: 'explicit'
      })
      await window.agentDesk.createWorkflowArtifactLocation({
        id: `${entityIds.artifact}-location`, artifactId: artifact.id,
        projectId: entityIds.project, goalId: entityIds.goal, workItemId: entityIds.workItem,
        kind: 'file', path: projectPath, availability: 'available', checksum: `sha256:${fileDigest}`,
        sizeBytes: 69, mediaType: 'text/markdown'
      })
      const acceptance = await window.agentDesk.saveWorkflowAcceptance({
        id: entityIds.acceptance, projectId: entityIds.project, goalId: entityIds.goal,
        workItemId: entityIds.workItem, criteria: ['The delivery remains inspectable after switching entries'], status: 'pending'
      })
      const evidence = await window.agentDesk.createWorkflowEvidence({
        evidenceId: entityIds.evidence, projectId: entityIds.project, goalId: entityIds.goal,
        workItemId: entityIds.workItem, artifactId: artifact.id, kind: 'review_result',
        title: 'Cross-entry continuity review', summary: 'The same canonical result is visible in every entry.', contentDigest: fileDigest
      })
      const review = await window.agentDesk.reviewWorkflowAcceptance({
        acceptanceId: acceptance.id,
        criterionEvidence: [{ criterionIndex: 0, evidenceRefs: [evidence.evidenceId] }],
        decision: 'passed', notes: 'Cross-entry continuity gate'
      })
      return { artifact, evidence, acceptance: review.acceptance, link: review.evidenceLinks[0] }
    }, { ids, projectPath: path.join(projectRoot, 'delivery.md'), fileDigest: digest })
    assert.equal(linked.acceptance.status, 'passed')
    assert.equal(linked.link.relation, 'verifies')
  })

  await check('Assistant to Project keeps the same Session and exposes the same result', async () => {
    await page.click('[data-experience-mode-option="assistant"]')
    await page.waitForFunction(() => document.querySelector('.experience-pane')?.getAttribute('data-experience-mode') === 'assistant')
    await page.waitForSelector(`[data-session-id="${session.id}"]`, { visible: true, timeout: 15_000 })
    await page.click(`[data-session-id="${session.id}"]`)
    const snapshot = await page.evaluate((id) => window.agentDesk.getStudioResultSnapshot(id), session.id)
    assert.equal(snapshot.state, 'ready')
    assert.equal(snapshot.scope.workspaceId, ids.project)
    assert(snapshot.artifacts.some((item) => item.id === ids.artifact))
    assert(snapshot.acceptances.some((item) => item.id === ids.acceptance && item.status === 'passed'))
  })

  await check('Project projection and Control Room return without creating a second workflow', async () => {
    await page.click('[data-experience-mode-option="studio"]')
    await page.waitForSelector('[data-project-workspace-studio]', { visible: true, timeout: 15_000 })
    await waitForProjectDeliveryAction(page)
    await openProjectDelivery(page)
    await page.$eval('[data-sidebar-action="control-room"]', (button) => button.click())
    await page.waitForSelector('.office', { visible: true, timeout: 20_000 })
    await page.waitForFunction(
      () => {
        const wrap = document.querySelector('.office-canvas-wrap')
        return wrap?.hasAttribute('data-office-return-mode') && wrap.hasAttribute('data-office-projects')
      },
      { timeout: 45_000 }
    )
    const office = await waitForValue(
      () => readOfficeProjection(page),
      (value) => value.returnMode === 'studio' && value.businessView === 'project' && value.projects >= 1 &&
        value.sessions === OFFICE_MAX_VISIBLE_SESSIONS && value.hiddenSessions === CONTROL_ROOM_TEST_SESSION_COUNT - OFFICE_MAX_VISIBLE_SESSIONS &&
        value.workstationIds.length === OFFICE_MAX_VISIBLE_SESSIONS,
      20_000,
      'waiting for live Control Room projection'
    )
    await verifyControlRoomGate('office_nine_workstation_capacity', () => {
      assert.equal(office.capacity, OFFICE_MAX_VISIBLE_SESSIONS)
      assert.equal(office.sessions, OFFICE_MAX_VISIBLE_SESSIONS)
      assert.equal(office.clickableWorkstations, OFFICE_MAX_VISIBLE_SESSIONS)
      assert.equal(office.workstationIds.length, OFFICE_MAX_VISIBLE_SESSIONS)
      assert.equal(new Set(office.workstationIds).size, OFFICE_MAX_VISIBLE_SESSIONS)
    })

    await page.click('[data-office-hidden-sessions-toggle]')
    const overflowList = await waitForValue(
      () => page.$$eval('[data-office-hidden-session]', (buttons) => buttons.map((button) => ({
        id: button.getAttribute('data-office-hidden-session') ?? '',
        title: button.querySelector('span')?.textContent?.trim() ?? '',
        model: button.querySelector('small')?.textContent?.trim() ?? ''
      }))),
      (items) => items.length === CONTROL_ROOM_TEST_SESSION_COUNT - OFFICE_MAX_VISIBLE_SESSIONS,
      10_000,
      'waiting for the 10th and later Sessions in the equivalent list'
    )
    await verifyControlRoomGate('office_tenth_session_overflow_list', () => {
      assert.equal(office.hiddenSessions, CONTROL_ROOM_TEST_SESSION_COUNT - OFFICE_MAX_VISIBLE_SESSIONS)
      assert.equal(overflowList.length, CONTROL_ROOM_TEST_SESSION_COUNT - OFFICE_MAX_VISIBLE_SESSIONS)
      assert(overflowList.every((item) => overflowSessionIds.includes(item.id)), 'overflow list contains a Session outside the bounded fixture')
    })
    await verifyControlRoomGate('office_active_session_prioritized', () => {
      assert.equal(office.selected, session.id)
      assert(office.workstationIds.includes(session.id), 'selected source Session was not prioritized onto the bounded floor')
      assert(!overflowList.some((item) => item.id === session.id), 'selected source Session leaked into the overflow list')
    })

    const overflowTarget = overflowList[0]
    await verifyControlRoomGate('office_equivalent_list_view', async () => {
      assert(overflowTarget?.id, 'overflow list did not expose a selectable Session')
      assert(overflowTarget.title.startsWith('Cross-entry overflow'), `overflow list omitted the Session title: ${JSON.stringify(overflowTarget)}`)
      assert.equal(overflowTarget.model, 'cross-entry-model')
      await page.$$eval('[data-office-hidden-session]', (buttons, targetId) => {
        const target = buttons.find((button) => button.getAttribute('data-office-hidden-session') === targetId)
        if (!(target instanceof HTMLButtonElement)) throw new Error(`overflow Session ${targetId} is not selectable`)
        target.click()
      }, overflowTarget.id)
      const revealed = await waitForValue(
        () => readOfficeProjection(page),
        (value) => value.selected === overflowTarget.id && value.workstationIds.includes(overflowTarget.id),
        15_000,
        'waiting for overflow Session selection to enter the bounded floor'
      )
      assert.equal(revealed.capacity, OFFICE_MAX_VISIBLE_SESSIONS)
      assert.equal(revealed.sessions, OFFICE_MAX_VISIBLE_SESSIONS)
      assert.equal(revealed.hiddenSessions, CONTROL_ROOM_TEST_SESSION_COUNT - OFFICE_MAX_VISIBLE_SESSIONS)
      assert.equal(revealed.returnMode, 'studio')
      report.controlRoom.revealedSessionId = overflowTarget.id
      report.controlRoom.afterOverflowSelection = revealed
    })

    await verifyControlRoomGate('office_source_entry_return', async () => {
      await page.click('.office-actions .btn-primary')
      await page.waitForFunction(
        () => document.querySelector('.experience-pane')?.getAttribute('data-experience-mode') === 'studio' &&
          Boolean(document.querySelector('[data-project-workspace-studio]')),
        { timeout: 15_000 }
      )
      await waitForProjectDeliveryAction(page)
      await openProjectDelivery(page)
    })
    const after = await page.evaluate(async ({ id, projectId, entityIds, fixtureIds }) => {
      const [sessions, ledger, evidencePage, audit] = await Promise.all([
        window.agentDesk.listSessions(),
        window.agentDesk.listWorkflowLedger({ projectId, limit: 500 }),
        window.agentDesk.queryWorkflowEvidence({ projectId, limit: 500 }),
        window.agentDesk.queryStudioAuditTimeline(id, { limit: 100 })
      ])
      return {
        matchingSessions: sessions.filter((item) => item.id === id).length,
        fixtureSessions: sessions.filter((item) => fixtureIds.includes(item.id)).length,
        runs: ledger.runs.items.filter((item) => item.sessionId === id).length,
        artifacts: ledger.artifacts.items.filter((item) => item.id === entityIds.artifact).length,
        evidence: evidencePage.items.filter((item) => item.evidenceId === entityIds.evidence).length,
        acceptances: ledger.acceptances.items.filter((item) => item.id === entityIds.acceptance).length,
        auditItems: audit.items.length
      }
      }, {
        id: session.id,
        projectId: ids.project,
        entityIds: ids,
        fixtureIds: [session.id, ...overflowSessionIds]
      })
    assert.equal(after.matchingSessions, 1)
    assert.equal(after.fixtureSessions, CONTROL_ROOM_TEST_SESSION_COUNT)
    assert.equal(after.runs, 1)
    assert.equal(after.artifacts, 1)
    assert.equal(after.evidence, 1)
    assert.equal(after.acceptances, 1)
    assert(after.auditItems > 0, 'audit timeline did not follow the source Session')
    report.continuity = { sessionId: session.id, projectId: ids.project, ...after, office }
  })

  await stopElectron()
  await launchElectron(true)
  await check('restart preserves source entry, Session identity and accepted result', async () => {
    const restored = await waitForValue(
      () => page.evaluate((id) => window.agentDesk.listSessions().then((items) => items.find((item) => item.id === id)), session.id),
      (meta) => Boolean(meta?.id && meta.workspaceId === ids.project && meta.status !== 'starting' && meta.status !== 'running'),
      25_000,
      'waiting for cross-entry restart recovery'
    )
    assert.equal(restored.id, session.id)
    assert.equal(restored.experienceModeOverride, 'assistant')
    const result = await page.evaluate(async ({ id, projectId, entityIds }) => {
      const snapshot = await window.agentDesk.getStudioResultSnapshot(id)
      const [ledger, evidencePage] = await Promise.all([
        window.agentDesk.listWorkflowLedger({ projectId, limit: 500 }),
        window.agentDesk.queryWorkflowEvidence({ projectId, limit: 500 })
      ])
      return {
        state: snapshot.state,
        artifact: snapshot.artifacts.find((item) => item.id === entityIds.artifact),
        acceptance: snapshot.acceptances.find((item) => item.id === entityIds.acceptance),
        artifactCount: ledger.artifacts.items.filter((item) => item.id === entityIds.artifact).length,
        evidenceCount: evidencePage.items.filter((item) => item.evidenceId === entityIds.evidence).length
      }
    }, { id: session.id, projectId: ids.project, entityIds: ids })
    assert.equal(result.state, 'ready')
    assert.equal(result.artifact?.id, ids.artifact)
    assert.equal(result.acceptance?.status, 'passed')
    assert.equal(result.artifactCount, 1)
    assert.equal(result.evidenceCount, 1)
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert(!stderr.includes('Conversation Ledger archive failed'), `Conversation Ledger archive failed after restart:\n${stderr}`)
  })

  assert.deepEqual(
    report.controlRoom.gates.filter((gate) => gate.status === 'pass').map((gate) => gate.id).sort(),
    [...CONTROL_ROOM_REQUIRED_GATES].sort(),
    'CONTROL-ROOM-009 required gates are incomplete'
  )
  report.status = 'passed'
  writeReport()
  if (report.status === 'passed') {
    console.log(`cross-entry continuity e2e: passed (${checks.length}/${checks.length})`)
    console.log(path.join(reportDir, 'report.json'))
  } else {
    console.error(`cross-entry continuity e2e: failed: ${report.error}`)
    process.exitCode = 1
  }
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  report.rendererDiagnostic = await captureRendererDiagnostic(page)
  report.stderr = stderr
  writeReport()
  console.error(`cross-entry continuity e2e: failed: ${report.error}`)
  process.exitCode = 1
} finally {
  await stopElectron().catch(() => undefined)
  if (server) await close(server.server).catch(() => undefined)
  if (process.env.CAOGEN_KEEP_CROSS_ENTRY_FIXTURE !== '1') rmSync(tempRoot, { recursive: true, force: true })
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

async function verifyControlRoomGate(id, run) {
  assert(CONTROL_ROOM_REQUIRED_GATES.includes(id), `unknown CONTROL-ROOM-009 gate: ${id}`)
  assert(!report.controlRoom.gates.some((gate) => gate.id === id), `duplicate CONTROL-ROOM-009 gate: ${id}`)
  const startedAt = Date.now()
  try {
    const value = await run()
    report.controlRoom.gates.push({ id, status: 'pass', durationMs: Date.now() - startedAt })
    return value
  } catch (error) {
    report.controlRoom.gates.push({
      id,
      status: 'fail',
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}

async function readOfficeProjection(activePage) {
  return activePage.$eval('.office-canvas-wrap', (node) => {
    let workstationTargets = []
    try {
      const parsed = JSON.parse(node.getAttribute('data-office-workstation-hit-targets') ?? '[]')
      if (Array.isArray(parsed)) workstationTargets = parsed
    } catch {
      workstationTargets = []
    }
    return {
      businessView: node.getAttribute('data-office-business-view') ?? '',
      capacity: Number(node.getAttribute('data-office-session-capacity') ?? 0),
      sessions: Number(node.getAttribute('data-office-sessions') ?? 0),
      hiddenSessions: Number(node.getAttribute('data-office-hidden-sessions') ?? 0),
      clickableWorkstations: Number(node.getAttribute('data-office-clickable-workstations') ?? 0),
      projects: Number(node.getAttribute('data-office-projects') ?? 0),
      selected: node.getAttribute('data-office-selected-session') ?? '',
      returnMode: node.getAttribute('data-office-return-mode') ?? '',
      workstationIds: workstationTargets
        .map((target) => target && typeof target === 'object' && typeof target.id === 'string' ? target.id : '')
        .filter(Boolean)
    }
  })
}

async function waitForProjectDeliveryAction(activePage) {
  await waitForValue(
    () => activePage.evaluate(() => ({
      busy: document.querySelector('[data-project-workspace-studio]')?.getAttribute('aria-busy'),
      deliveryReady: Boolean(document.querySelector('[data-project-execution-action="delivery"]'))
    })),
    (value) => value.busy === 'false' && value.deliveryReady,
    15_000,
    'waiting for stable Project delivery action'
  )
}

async function openProjectDelivery(activePage) {
  await activePage.waitForSelector('[data-project-execution-action="delivery"]', { visible: true, timeout: 20_000 })
  await activePage.waitForFunction(
    () => document.querySelector('[data-project-workspace-studio]')?.getAttribute('aria-busy') === 'false',
    { timeout: 20_000 }
  )
  await activePage.$eval('[data-project-execution-action="delivery"]', (button) => {
    button.scrollIntoView({ block: 'center' })
    const target = document.querySelector('[data-project-flow-step="delivery"]')
    if (target instanceof HTMLDetailsElement) {
      if (!target.open) target.open = true
      target.scrollIntoView({ block: 'start' })
    }
  })
  await activePage.waitForSelector('[data-project-delivery-workbench]', { visible: true, timeout: 20_000 })
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

async function startOpenAiMock() {
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(404).end('not found')
      return
    }
    for await (const _chunk of request) { /* consume request */ }
    const text = 'Cross-entry task completed.'
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`)
    response.write(`data: ${JSON.stringify({ type: 'response.completed', response: { id: `cross-entry-${Date.now()}`, output_text: text, usage: { input_tokens: 8, output_tokens: 4, input_tokens_details: { cached_tokens: 0 } } } })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` }
}

async function launchElectron(restart) {
  const remotePort = await findFreePort(9990)
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
  stderr = ''
  electron.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
  await waitForDebugPort(remotePort, 20_000)
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${remotePort}`, defaultViewport: null })
  page = await waitForElectronPage(browser, 20_000)
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
  await page.waitForSelector('.app', { timeout: 20_000 })
  await page.waitForFunction(() => typeof window.agentDesk?.getStudioResultSnapshot === 'function', { timeout: 20_000 })
  await new Promise((resolve) => setTimeout(resolve, restart ? 1_500 : 500))
}

async function stopElectron() {
  if (browser) { browser.disconnect(); browser = undefined; page = undefined }
  if (electron) { await terminateElectronTestProcess(electron); electron = undefined }
}

function copyBuiltApp() {
  rmSync(isolatedOutDir, { recursive: true, force: true })
  mkdirSync(isolatedOutDir, { recursive: true })
  for (const directory of ['main', 'preload', 'renderer']) cpSync(path.join(sourceOutDir, directory), path.join(isolatedOutDir, directory), { recursive: true })
}

async function waitForElectronPage(connectedBrowser, timeoutMs) {
  return waitForValue(async () => (await connectedBrowser.pages()).find((candidate) => candidate.url().startsWith('file:')), Boolean, timeoutMs, 'waiting for Electron renderer page')
}

async function waitForDebugPort(port, timeoutMs) {
  await waitForValue(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok } catch { return false } }, Boolean, timeoutMs, `waiting for Electron debug port ${port}`)
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
    } catch { probe.close() }
  }
  throw new Error(`no free port from ${start}`)
}

function close(target) { return new Promise((resolve) => target.close(() => resolve())) }

function writeReport() {
  const provenance = bindSourceEvidence(
    report,
    sourceEvidenceAtStart,
    readSourceEvidenceState(repoRoot),
    'Cross-entry continuity'
  )
  if (provenance.status !== 'pass') report.status = 'failed'
  mkdirSync(reportDir, { recursive: true })
  const output = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(reportDir, 'report.json'), output, 'utf8')
  mkdirSync(reportRoot, { recursive: true })
  writeFileSync(path.join(reportRoot, 'latest.json'), output, 'utf8')
}
