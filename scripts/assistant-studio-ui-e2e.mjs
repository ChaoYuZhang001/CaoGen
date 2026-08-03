#!/usr/bin/env node
import http from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const packageJson = require(path.join(repoRoot, 'package.json'))
const electronPackage = require('electron/package.json')
const outputRoot = path.join(repoRoot, 'test-results', 'assistant-studio-ui')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const runDir = path.join(outputRoot, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-assistant-studio-ui-'))
const userDataDir = path.join(tempRoot, 'userData')
const projectDir = path.join(tempRoot, 'project')
const migrationHome = path.join(tempRoot, 'migration-home')
const migrationCanary = 'secret-for-smoke-migration-ui-canary'
const sourceOutDir = path.join(repoRoot, 'out')
const isolatedOutDir = path.join(runDir, 'app', 'out')
const mainEntry = path.join(isolatedOutDir, 'main', 'index.js')
const electronBin = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const ciSoftwareWebgl = process.env.CAOGEN_CI_SOFTWARE_WEBGL === '1'
const softwareWebglArgs = ciSoftwareWebgl
  ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  : []

assert(existsSync(electronBin), 'Electron binary not found. Run npm install first.')
for (const entry of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
  assert(existsSync(path.join(sourceOutDir, entry)), `Built app entry missing: out/${entry}. Run npm run build first.`)
}

mkdirSync(runDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
mkdirSync(projectDir, { recursive: true })
mkdirSync(path.join(projectDir, '.cursor'), { recursive: true })
mkdirSync(path.join(migrationHome, '.codex'), { recursive: true })
writeFileSync(path.join(projectDir, 'README.md'), '# Assistant Studio UI required E2E\n', 'utf8')
writeFileSync(path.join(projectDir, '.cursorrules'), 'Use the project fixture rule.\n', 'utf8')
writeFileSync(path.join(migrationHome, '.codex', 'AGENTS.md'), 'Use the user fixture rule.\n', 'utf8')
writeFileSync(path.join(projectDir, '.cursor', 'mcp.json'), JSON.stringify({
  mcpServers: {
    privateFixture: {
      command: 'node',
      args: ['fixture-server.js', '--token', migrationCanary],
      env: { FIXTURE_TOKEN: migrationCanary }
    }
  }
}), 'utf8')
copyBuiltApp()

const report = {
  schemaVersion: 2,
  runId,
  runDir,
  requirement: 'required',
  packageVersion: packageJson.version,
  gitCommit: '',
  worktreeClean: false,
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  electronVersion: electronPackage.version,
  softwareWebgl: {
    enabled: ciSoftwareWebgl,
    electronArgs: softwareWebglArgs
  },
  checks: [],
  screenshots: [],
  viewports: [],
  warnings: [],
  coverage: {
    verified: [
      'pointer and keyboard Assistant/Studio switching',
      'unique aria-pressed state',
      'session identity/count/transcript immutability while switching',
      'Welcome and Composer draft retention',
      'new-session/search/Office navigation mode retention',
      'View/Plan/Execute strategy selection, persistence, and active-run switch rejection',
      'immutable plan version creation, restart persistence, exact approval, and approve-to-execute gate',
      'unassigned plan approval remains conversation-only and creates no hidden Project',
      'redacted low-friction Codex migration preview, no-project conversation entry, responsive layout, safe defaults, apply, and rollback',
      'responsive horizontal-overflow and basic overlay stacking'
    ],
    explicitlyNotVerified: [
      'assistant-studio-consistency',
      'assistant-studio-live-switch'
    ]
  }
}

const mock = await startOpenAiMock()
const remotePort = await findFreePort(9920)
const electron = spawn(electronBin, [`--remote-debugging-port=${remotePort}`, ...softwareWebglArgs, mainEntry], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CAOGEN_USER_DATA_DIR: userDataDir,
    CAOGEN_MEMORY_DIR: path.join(tempRoot, 'memory'),
    CAOGEN_MIGRATION_TEST_MODE: '1',
    CAOGEN_MIGRATION_TEST_HOME: migrationHome,
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
let session
electron.stdout.on('data', (chunk) => { stdout += chunk.toString() })
electron.stderr.on('data', (chunk) => { stderr += chunk.toString() })

try {
  await waitForDebugPort(remotePort, 20_000)
  browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${remotePort}`,
    defaultViewport: null
  })
  page = await waitForElectronPage(browser, 20_000)
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      report.warnings.push(`console ${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => report.warnings.push(`pageerror: ${error.message}`))
  await waitForApp(page)
  await page.setViewport({ width: 1320, height: 860, deviceScaleFactor: 1 })

  await check('Welcome exposes one usable View Plan Execute strategy control', async () => {
    await assertTaskStrategy(page, 'execute')
    await clickTaskStrategy(page, 'view')
    await clickTaskStrategy(page, 'plan')
    await clickTaskStrategy(page, 'execute')
  })

  await check('pointer switching is bidirectional with one pressed option', async () => {
    await assertMode(page, 'assistant')
    await enterText(page, '.welcome-composer-input', 'welcome draft survives projection changes', 'Welcome draft')
    await clickMode(page, 'studio')
    await clickMode(page, 'assistant')
    const value = await page.$eval('.welcome-composer-input', (input) => input.value)
    assert(value === 'welcome draft survives projection changes', `Welcome draft changed: ${value}`)
  })

  await check('Space and Enter switch modes without losing focus or Welcome draft', async () => {
    await focusMode(page, 'studio')
    await page.keyboard.press('Space')
    await assertMode(page, 'studio', 'studio')
    await focusMode(page, 'assistant')
    await page.keyboard.press('Enter')
    await assertMode(page, 'assistant', 'assistant')
    const value = await page.$eval('.welcome-composer-input', (input) => input.value)
    assert(value === 'welcome draft survives projection changes', `Welcome draft changed after keyboard use: ${value}`)
  })

  await check('seed one real session with a completed transcript', async () => {
    session = await page.evaluate(async ({ cwd, baseUrl }) => {
      const provider = await window.agentDesk.createProvider({
        name: 'Assistant Studio UI Mock',
        baseUrl,
        token: 'test-only',
        models: ['mock-responses'],
        openaiProtocol: 'responses'
      })
      return window.agentDesk.createSession({
        cwd,
        engine: 'openai',
        providerId: provider.id,
        model: 'mock-responses',
        taskStrategy: 'plan',
        isolated: false,
        title: 'Assistant Studio UI session'
      })
    }, { cwd: projectDir, baseUrl: mock.baseUrl })
    assert(session?.id, 'session id missing')
    await waitForValue(
      () => page.evaluate((id) => window.agentDesk.listSessions().then((items) => items.find((item) => item.id === id)), session.id),
      (meta) => Boolean(meta?.sdkSessionId),
      12_000,
      'waiting for session initialization'
    )
    await page.evaluate((id) => window.agentDesk.sendMessage(id, { text: 'stable transcript marker' }), session.id)
    const transcript = await waitForValue(
      () => page.evaluate((id) => window.agentDesk.getTranscript(id), session.id),
      (entries) => entries.some((entry) => entry.event?.kind === 'turn-result'),
      15_000,
      'waiting for completed transcript'
    )
    assert(transcript.some((entry) => entry.event?.kind === 'user-message'), 'user message missing from transcript')
    assert(transcript.length >= 3, `transcript too weak for immutability check: ${transcript.length}`)
  })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForApp(page)
  await page.waitForSelector('.composer-input', { visible: true, timeout: 15_000 })

  await check('migration manager supports conversation entry, responsive safe defaults, apply, and rollback', async () => {
    await verifyMigrationManager(page, projectDir, migrationCanary)
  })

  await check('Plan strategy survives session creation, history persistence, and renderer reload', async () => {
    await assertTaskStrategy(page, 'plan')
    const persisted = await page.evaluate(async (id) => {
      const sessions = await window.agentDesk.listSessions()
      const history = await window.agentDesk.listHistory()
      return {
        active: sessions.find((item) => item.id === id)?.taskStrategy,
        history: history.find((item) => item.id === id)?.taskStrategy
      }
    }, session.id)
    assert(persisted.active === 'plan', `active strategy not persisted: ${JSON.stringify(persisted)}`)
    assert(persisted.history === 'plan', `history strategy not persisted: ${JSON.stringify(persisted)}`)
  })

  await check('Plan requires a persisted exact-version approval before Execute', async () => {
    const rejection = await page.evaluate(async (id) => {
      try {
        await window.agentDesk.setTaskStrategy(id, 'execute')
        return ''
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }, session.id)
    assert(/尚未形成结构化计划/.test(rejection), `unplanned Execute switch was not rejected: ${rejection}`)
    await assertTaskStrategy(page, 'plan')

    await setFieldValue(page, '[data-task-plan-objective]', 'Reviewable execution contract')
    await setFieldValue(page, '[data-task-plan-step-title="0"]', 'Verify the implementation')
    await setFieldValue(page, '[data-task-plan-acceptance]', 'Targeted regression passes')
    await page.click('[data-task-plan-save]')
    await page.waitForFunction(() =>
      document.querySelector('[data-task-plan-status]')?.getAttribute('data-task-plan-status') === 'pending',
    { timeout: 5_000 })
    const created = await page.evaluate((id) => window.agentDesk.getTaskPlan(id), session.id)
    assert(created.currentVersion?.version === 1, `plan v1 missing: ${JSON.stringify(created)}`)
    assert(/^sha256:[0-9a-f]{64}$/.test(created.currentVersion?.digest ?? ''), 'plan digest missing')

    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await page.waitForSelector('[data-task-plan-approve-execute]', { visible: true, timeout: 15_000 })
    const restarted = await page.evaluate((id) => window.agentDesk.getTaskPlan(id), session.id)
    assert(restarted.currentVersion?.digest === created.currentVersion.digest, 'plan digest changed after reload')
    await page.click('[data-task-plan-approve-execute]')
    await waitForValue(
      () => page.evaluate((id) => window.agentDesk.listSessions().then((items) => items.find((item) => item.id === id)?.taskStrategy), session.id),
      (strategy) => strategy === 'execute',
      5_000,
      'waiting for approved Execute strategy meta'
    )
    const approved = await page.evaluate((id) => window.agentDesk.getTaskPlan(id), session.id)
    assert(approved.approvalStatus === 'approved', `plan approval missing: ${JSON.stringify(approved)}`)
    assert(approved.projection?.mode === 'conversation', `unassigned plan projection is not conversation-only: ${JSON.stringify(approved)}`)
    await page.waitForSelector('[data-task-plan-projection="conversation"]', { visible: true, timeout: 5_000 })
    const workspaceCount = await page.evaluate(() => window.agentDesk.listProjectWorkspaces().then((items) => items.length))
    assert(workspaceCount === 0, `unassigned plan created hidden Project state: ${workspaceCount}`)
  })

  await check('idle strategy switch is explicit and active-run switch fails closed', async () => {
    await assertTaskStrategy(page, 'execute')
    await page.evaluate((id) => window.agentDesk.sendMessage(id, { text: 'strategy running marker' }), session.id)
    await waitForValue(
      () => page.evaluate((id) => window.agentDesk.listSessions().then((items) => items.find((item) => item.id === id)?.status), session.id),
      (status) => status === 'running',
      5_000,
      'waiting for running strategy fixture'
    )
    const runningState = await page.evaluate(async (id) => {
      const disabled = [...document.querySelectorAll('[data-task-strategy-option]')]
        .every((button) => button.disabled)
      let rejection = ''
      let planMutationRejection = ''
      try {
        await window.agentDesk.setTaskStrategy(id, 'plan')
      } catch (error) {
        rejection = error instanceof Error ? error.message : String(error)
      }
      try {
        await window.agentDesk.createTaskPlanVersion(id, {
          objective: 'Must not mutate while running',
          steps: [{ id: 'blocked', title: 'Blocked' }],
          acceptanceCriteria: ['Must remain unchanged'],
          changeReason: 'Running mutation probe'
        })
      } catch (error) {
        planMutationRejection = error instanceof Error ? error.message : String(error)
      }
      return { disabled, rejection, planMutationRejection }
    }, session.id)
    assert(runningState.disabled, `strategy control stayed enabled while running: ${JSON.stringify(runningState)}`)
    assert(/任务正在运行/.test(runningState.rejection), `running switch did not fail closed: ${JSON.stringify(runningState)}`)
    assert(/任务正在运行/.test(runningState.planMutationRejection),
      `running plan mutation did not fail closed: ${JSON.stringify(runningState)}`)
    await waitForValue(
      () => page.evaluate((id) => window.agentDesk.getTranscript(id), session.id),
      (entries) => entries.filter((entry) => entry.event?.kind === 'turn-result').length >= 2,
      15_000,
      'waiting for running strategy fixture completion'
    )
    const revokedGate = await page.evaluate(async (id) => {
      const plan = await window.agentDesk.getTaskPlan(id)
      const current = plan.currentVersion
      if (!current) throw new Error('current plan missing')
      await window.agentDesk.revokeTaskPlanApproval(id, { version: current.version, digest: current.digest })
      const beforeSessions = await window.agentDesk.listSessions()
      const beforeTranscript = await window.agentDesk.getTranscript(id)
      let subagentRejection = ''
      let dagRejection = ''
      try {
        await window.agentDesk.dispatchSubagents(id, { tasks: [{ id: 'blocked', prompt: 'must not run' }] })
      } catch (error) {
        subagentRejection = error instanceof Error ? error.message : String(error)
      }
      try {
        await window.agentDesk.dispatchTaskDag(id, {
          dag: {
            id: 'blocked-dag',
            title: 'Blocked DAG',
            source: 'ui-e2e',
            complexity: 'single',
            createdAt: Date.now(),
            tasks: [{
              id: 'blocked', title: 'Blocked', description: 'must not run', dependencies: [], role: 'qa', prompt: 'must not run'
            }]
          }
        })
      } catch (error) {
        dagRejection = error instanceof Error ? error.message : String(error)
      }
      await window.agentDesk.sendMessage(id, { text: 'must not enter the transcript' })
      const afterSessions = await window.agentDesk.listSessions()
      const afterTranscript = await window.agentDesk.getTranscript(id)
      await window.agentDesk.approveTaskPlan(id, { version: current.version, digest: current.digest })
      return {
        subagentRejection,
        dagRejection,
        sessionCountBefore: beforeSessions.length,
        sessionCountAfter: afterSessions.length,
        transcriptCountBefore: beforeTranscript.length,
        transcriptCountAfter: afterTranscript.length,
        lastError: afterSessions.find((item) => item.id === id)?.lastError
      }
    }, session.id)
    assert(/尚未批准|取代/.test(revokedGate.subagentRejection), `subagent gate missing: ${JSON.stringify(revokedGate)}`)
    assert(/尚未批准|取代/.test(revokedGate.dagRejection), `DAG gate missing: ${JSON.stringify(revokedGate)}`)
    assert(revokedGate.sessionCountAfter === revokedGate.sessionCountBefore,
      `rejected dispatch created a session: ${JSON.stringify(revokedGate)}`)
    assert(revokedGate.transcriptCountAfter === revokedGate.transcriptCountBefore,
      `rejected send entered transcript: ${JSON.stringify(revokedGate)}`)
    assert(/尚未批准|取代/.test(revokedGate.lastError ?? ''), `send gate missing: ${JSON.stringify(revokedGate)}`)
    await clickTaskStrategy(page, 'plan')
  })

  await check('Plan can decompose but cannot dispatch, and v2 supersedes approval', async () => {
    const result = await page.evaluate(async (id) => {
      const before = await window.agentDesk.listSessions()
      const decomposed = await window.agentDesk.decomposeTask(id, {
        request: 'Inspect the implementation and verify its tests',
        useModel: false
      })
      let dispatchRejection = ''
      try {
        await window.agentDesk.dispatchTaskDag(id, { dag: decomposed.dag })
      } catch (error) {
        dispatchRejection = error instanceof Error ? error.message : String(error)
      }
      const first = await window.agentDesk.getTaskPlan(id)
      const current = first.currentVersion
      if (!current) throw new Error('current plan missing')
      const second = await window.agentDesk.createTaskPlanVersion(id, {
        objective: `${current.objective} with a second review`,
        steps: current.steps,
        expectedArtifacts: current.expectedArtifacts,
        dataEgress: current.dataEgress,
        estimatedCostUsd: current.estimatedCostUsd,
        riskLevel: current.riskLevel,
        acceptanceCriteria: current.acceptanceCriteria,
        changeReason: 'Electron supersession probe'
      })
      let executeRejection = ''
      try {
        await window.agentDesk.setTaskStrategy(id, 'execute')
      } catch (error) {
        executeRejection = error instanceof Error ? error.message : String(error)
      }
      const interactiveRejections = []
      for (const operation of [
        () => window.agentDesk.startTerminal(id, { reuse: false }),
        () => window.agentDesk.writeTextFile(id, 'blocked-by-plan.txt', 'must not be written'),
        () => window.agentDesk.stageAll(id)
      ]) {
        try {
          await operation()
          interactiveRejections.push('')
        } catch (error) {
          interactiveRejections.push(error instanceof Error ? error.message : String(error))
        }
      }
      return {
        taskCount: decomposed.dag.tasks.length,
        dispatchRejection,
        executeRejection,
        beforeCount: before.length,
        afterCount: (await window.agentDesk.listSessions()).length,
        version: second.currentVersion?.version,
        approvalStatus: second.approvalStatus,
        lastEvent: second.approvalEvents.at(-1)?.kind,
        interactiveRejections,
        blockedFilePresent: (await window.agentDesk.listProjectFiles(id)).entries
          .some((entry) => entry.path === 'blocked-by-plan.txt')
      }
    }, session.id)
    assert(result.taskCount > 0, `Plan decomposition returned no tasks: ${JSON.stringify(result)}`)
    assert(/规划策略不允许执行任务 DAG/.test(result.dispatchRejection), `Plan dispatch gate missing: ${JSON.stringify(result)}`)
    assert(result.beforeCount === result.afterCount, `Plan dispatch created a session: ${JSON.stringify(result)}`)
    assert(result.version === 2 && result.approvalStatus === 'pending' && result.lastEvent === 'superseded',
      `v2 did not supersede v1 approval: ${JSON.stringify(result)}`)
    assert(/尚未批准|取代/.test(result.executeRejection), `pending v2 Execute gate missing: ${JSON.stringify(result)}`)
    assert(result.interactiveRejections.every((message) => /规划策略不允许/.test(message)),
      `manual mutation gate missing: ${JSON.stringify(result)}`)
    assert(result.blockedFilePresent === false, `manual file mutation escaped gate: ${JSON.stringify(result)}`)
  })

  let stableSnapshot
  await check('switching preserves session id, count, and transcript bytes', async () => {
    stableSnapshot = await readSessionSnapshot(page, session.id)
    assert(stableSnapshot.count === 1, `expected one session, got ${stableSnapshot.count}`)
    assert(stableSnapshot.ids[0] === session.id, `active session identity mismatch: ${stableSnapshot.ids.join(',')}`)
    await clickMode(page, 'studio')
    await clickMode(page, 'assistant')
    const after = await readSessionSnapshot(page, session.id)
    assertSameSnapshot(stableSnapshot, after, 'pointer projection switch')
  })

  await check('new-session, search, and Office roundtrip retain Studio mode', async () => {
    await clickMode(page, 'studio')
    await page.click('.sidebar-new')
    await assertMode(page, 'studio')
    await focusSidebarSearch(page)
    await assertMode(page, 'studio')
    await enterText(page, '.sidebar-search', 'stable transcript', 'Sidebar search')
    await clearFocusedInput(page)
    await page.waitForSelector('.session-card.active', { visible: true, timeout: 5_000 })
    await page.click('.sidebar-office')
    await page.waitForSelector('.office', { visible: true, timeout: 20_000 })
    assert(await page.$('[data-experience-mode-switcher]') === null, 'mode switcher should not cover Office')
    await page.waitForSelector('.office-actions .btn-primary', { visible: true, timeout: 30_000 })
    await page.$eval('.office-actions .btn-primary', (button) => button.click())
    await page.waitForSelector('[data-experience-mode-switcher]', { visible: true, timeout: 15_000 })
    await assertMode(page, 'studio')
    await page.click('.session-card.active')
    await assertMode(page, 'studio')
    const after = await readSessionSnapshot(page, session.id)
    assertSameSnapshot(stableSnapshot, after, 'navigation roundtrip')
  })

  await check('Composer draft survives Assistant/Studio projection changes', async () => {
    await clickMode(page, 'assistant')
    await page.waitForSelector('.composer-input', { visible: true, timeout: 30_000 })
    await enterText(page, '.composer-input', 'composer draft stays local', 'Composer draft')
    const before = await readSessionSnapshot(page, session.id)
    await clickMode(page, 'studio')
    await clickMode(page, 'assistant')
    const value = await page.$eval('.composer-input', (input) => input.value)
    assert(value === 'composer draft stays local', `Composer draft changed: ${value}`)
    const after = await readSessionSnapshot(page, session.id)
    assertSameSnapshot(before, after, 'Composer draft projection switch')
  })

  await check('command palette backdrop stays above the mode switcher', async () => {
    await page.setViewport({ width: 1320, height: 860, deviceScaleFactor: 1 })
    await openCommandPalette(page)
    const stacking = await readOverlayStacking(page, '.command-palette-backdrop')
    assert(stacking.overlayZ > stacking.switcherZ, `palette z-index ${stacking.overlayZ} <= switcher ${stacking.switcherZ}`)
    assert(stacking.overlayOwnsSwitcherPoint, `switcher painted above palette: ${JSON.stringify(stacking)}`)
    await page.keyboard.press('Escape')
    await page.waitForSelector('.command-palette-backdrop', { hidden: true, timeout: 5_000 })
  })

  await check('responsive Assistant and Studio panes do not overflow horizontally', async () => {
    for (const viewport of [
      { width: 1320, height: 860 },
      { width: 760, height: 700 },
      { width: 360, height: 520 }
    ]) {
      await page.setViewport({ ...viewport, deviceScaleFactor: 1 })
      await sleep(250)
      for (const mode of ['assistant', 'studio']) {
        await clickMode(page, mode)
        await sleep(50)
        const measurement = await readOverflow(page, mode)
        report.viewports.push(measurement)
        assert(measurement.documentOverflow <= 1, `${mode} ${viewport.width}: document overflow ${measurement.documentOverflow}px`)
        assert(measurement.appOverflow <= 1, `${mode} ${viewport.width}: app overflow ${measurement.appOverflow}px`)
        assert(measurement.mainOverflow <= 1, `${mode} ${viewport.width}: main overflow ${measurement.mainOverflow}px`)
        assert(measurement.switcherInsideViewport, `${mode} ${viewport.width}: mode switcher outside viewport`)
        assert(measurement.strategyInsideViewport, `${mode} ${viewport.width}: task strategy outside viewport`)
        assert(measurement.strategyTextFits, `${mode} ${viewport.width}: task strategy text clipped`)
        assert(measurement.visibleOffenders.length === 0, `${mode} ${viewport.width}: ${JSON.stringify(measurement.visibleOffenders)}`)
        await captureScreenshot(page, `${viewport.width}x${viewport.height}-${mode}`)
      }
    }
  })

  await check('mobile sidebar and backdrop stay above the mode switcher', async () => {
    await page.setViewport({ width: 360, height: 520, deviceScaleFactor: 1 })
    await page.click('.mobile-sidebar-toggle')
    await page.waitForSelector('.sidebar-mobile-open', { visible: true, timeout: 5_000 })
    const stacking = await readMobileSidebarStacking(page)
    assert(stacking.sidebarZ > stacking.switcherZ, `sidebar z-index ${stacking.sidebarZ} <= switcher ${stacking.switcherZ}`)
    assert(stacking.backdropZ > stacking.switcherZ, `sidebar backdrop ${stacking.backdropZ} <= switcher ${stacking.switcherZ}`)
    assert(stacking.overlayOwnsSwitcherPoint, `switcher painted above mobile overlay: ${JSON.stringify(stacking)}`)
    await page.mouse.click(350, 260)
    await page.waitForSelector('.mobile-sidebar-backdrop', { hidden: true, timeout: 5_000 })
  })
} catch (error) {
  report.error = error instanceof Error ? error.stack || error.message : String(error)
  process.exitCode = 1
  if (page) await captureScreenshot(page, 'failure').catch(() => undefined)
} finally {
  if (browser) await browser.disconnect().catch(() => undefined)
  const exited = await terminate(electron)
  await closeServer(mock.server)
  const git = readGitState()
  report.gitCommit = git.commit
  report.worktreeClean = git.worktreeClean
  report.releaseBinding = {
    requirement: report.requirement,
    packageVersion: report.packageVersion,
    git,
    platform: report.platform,
    arch: report.arch,
    nodeVersion: report.nodeVersion,
    electronVersion: report.electronVersion
  }
  report.warnings.push(...summarizeProcessOutput(stdout, stderr, exited))
  report.status = report.checks.every((item) => item.status === 'pass') && !report.error ? 'pass' : 'fail'
  const reportText = JSON.stringify(report, null, 2)
  writeFileSync(path.join(runDir, 'report.json'), reportText)
  writeFileSync(path.join(outputRoot, 'latest.json'), reportText)
  cleanupTempRoot(tempRoot)
}

if (report.status !== 'pass') {
  console.error(`assistant/studio required UI E2E failed: ${report.error || 'check failure'}`)
  process.exitCode = 1
} else {
  console.log(`assistant/studio required UI E2E ok: ${runDir}`)
  console.log(`${report.checks.length}/${report.checks.length} checks passed; ${report.screenshots.length} screenshots captured`)
}

async function verifyMigrationManager(targetPage, targetProject, secretCanary) {
  await targetPage.click('.sidebar-footer .btn-ghost')
  await targetPage.waitForSelector('[data-settings-tab="migrate"]', { visible: true, timeout: 10_000 })
  await targetPage.click('[data-settings-tab="migrate"]')
  await targetPage.waitForSelector('[data-migration-manager]', { visible: true, timeout: 5_000 })
  await clearFieldValue(targetPage, '[data-migration-manager] input')
  await targetPage.click('[data-migration-scan]')
  await targetPage.waitForSelector('[data-migration-mode="conversation"]', { visible: true, timeout: 10_000 })
  const conversation = await targetPage.evaluate(() => ({
    directory: document.querySelector('[data-migration-manager] input')?.value,
    rows: document.querySelectorAll('[data-migration-asset]').length,
    selected: [...document.querySelectorAll('[data-migration-asset] input')].filter((input) => input.checked).length
  }))
  assert(conversation.directory === '', `conversation migration required a project path: ${JSON.stringify(conversation)}`)
  assert(conversation.rows > 0, `conversation migration found no user assets: ${JSON.stringify(conversation)}`)
  assert(conversation.selected === 0, `user-scoped assets were selected by default: ${JSON.stringify(conversation)}`)

  await setFieldValue(targetPage, '[data-migration-manager] input', targetProject)
  await targetPage.click('[data-migration-scan]')
  await targetPage.waitForSelector('[data-migration-mode="project"]', { visible: true, timeout: 10_000 })
  await targetPage.waitForSelector('[data-migration-asset]', { visible: true, timeout: 10_000 })
  const state = await targetPage.evaluate((canary) => {
    const rows = [...document.querySelectorAll('[data-migration-asset]')].map((row) => ({
      kind: row.getAttribute('data-migration-kind'),
      risk: row.getAttribute('data-migration-risk'),
      checked: row.querySelector('input')?.checked,
      disabled: row.querySelector('input')?.disabled
    }))
    return {
      rows,
      leaked: document.querySelector('[data-migration-manager]')?.textContent?.includes(canary) === true
    }
  }, secretCanary)
  assert(!state.leaked, 'migration preview exposed the credential canary')
  assert(state.rows.some((row) => row.kind === 'rules' && row.risk === 'low' && row.checked),
    `safe rule was not selected by default: ${JSON.stringify(state.rows)}`)
  assert(state.rows.some((row) => row.kind === 'mcp' && row.risk === 'review' && !row.checked),
    `credential-bearing MCP was selected by default: ${JSON.stringify(state.rows)}`)
  for (const viewport of [
    { width: 1320, height: 860 },
    { width: 760, height: 700 },
    { width: 360, height: 520 }
  ]) {
    await targetPage.setViewport({ ...viewport, deviceScaleFactor: 1 })
    await sleep(150)
    const layout = await readMigrationLayout(targetPage)
    assert(layout.documentOverflow <= 1, `migration ${viewport.width}: document overflow ${layout.documentOverflow}px`)
    assert(layout.managerInsideViewport, `migration ${viewport.width}: manager outside viewport ${JSON.stringify(layout)}`)
    assert(layout.visibleOffenders.length === 0, `migration ${viewport.width}: ${JSON.stringify(layout.visibleOffenders)}`)
    await captureScreenshot(targetPage, `migration-manager-${viewport.width}x${viewport.height}`)
  }
  await targetPage.setViewport({ width: 1320, height: 860, deviceScaleFactor: 1 })
  await targetPage.click('[data-migration-apply]')
  await targetPage.waitForSelector('[data-migration-rollback]', { visible: true, timeout: 10_000 })
  assert(existsSync(path.join(targetProject, 'CLAUDE.md')), 'selected project rule was not imported')
  assert(!existsSync(path.join(targetProject, '.mcp.json')), 'unselected MCP was imported')
  await targetPage.click('[data-migration-rollback]')
  await waitForValue(
    async () => !existsSync(path.join(targetProject, 'CLAUDE.md')),
    Boolean,
    5_000,
    'waiting for migration rollback'
  )
  await targetPage.click('.settings-page-back')
  await targetPage.waitForSelector('.composer-input', { visible: true, timeout: 10_000 })
}

async function readMigrationLayout(targetPage) {
  return targetPage.evaluate(() => {
    const manager = document.querySelector('[data-migration-manager]')
    const managerRect = manager?.getBoundingClientRect()
    const visibleOffenders = [...(manager?.querySelectorAll('*') ?? [])].flatMap((element) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) return []
      const overflow = Math.max(0, rect.right - innerWidth, -rect.left)
      return overflow > 1 ? [{ tag: element.tagName, className: element.className, overflow }] : []
    }).slice(0, 10)
    return {
      documentOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      managerInsideViewport: Boolean(managerRect && managerRect.left >= -1 && managerRect.right <= innerWidth + 1),
      visibleOffenders
    }
  })
}

async function check(name, fn) {
  const startedAt = Date.now()
  try {
    await fn()
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

async function clickMode(targetPage, mode) {
  await targetPage.click(`[data-experience-mode-option="${mode}"]`)
  await assertMode(targetPage, mode)
}

async function enterText(targetPage, selector, text, label) {
  const initial = await targetPage.$eval(selector, (input) => {
    input.focus()
    return {
      focused: document.activeElement === input,
      value: input.value
    }
  })
  assert(initial.focused, `${label} did not receive focus`)
  assert(initial.value === '', `${label} started with unexpected text: ${initial.value}`)

  // One CDP insertion still exercises the browser input event while avoiding host-keyboard bleed.
  await targetPage.keyboard.sendCharacter(text)
  await waitForValue(
    () => targetPage.$eval(selector, (input) => input.value),
    (value) => value === text,
    5_000,
    `waiting for ${label} input`
  )
}

async function clickTaskStrategy(targetPage, strategy) {
  await targetPage.click(`[data-task-strategy-option="${strategy}"]`)
  await assertTaskStrategy(targetPage, strategy)
}

async function setFieldValue(targetPage, selector, value) {
  await targetPage.waitForSelector(selector, { visible: true, timeout: 5_000 })
  await targetPage.$eval(selector, (element, nextValue) => {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    if (!setter) throw new Error('form value setter missing')
    setter.call(element, nextValue)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}

async function clearFieldValue(targetPage, selector) {
  await targetPage.waitForSelector(selector, { visible: true, timeout: 5_000 })
  await targetPage.$eval(selector, (input) => {
    input.focus()
    input.select()
  })
  await targetPage.keyboard.press('Backspace')
  await waitForValue(
    () => targetPage.$eval(selector, (input) => input.value),
    (value) => value === '',
    5_000,
    `waiting for ${selector} to clear`
  )
}

async function assertTaskStrategy(targetPage, expected) {
  const state = await waitForValue(
    () => targetPage.evaluate(() => {
      const control = document.querySelector('[data-task-strategy]')
      const pressed = [...document.querySelectorAll('[data-task-strategy-option][aria-pressed="true"]')]
        .map((button) => button.getAttribute('data-task-strategy-option'))
      return { value: control?.getAttribute('data-task-strategy'), pressed }
    }),
    (value) => value.value === expected && value.pressed.length === 1 && value.pressed[0] === expected,
    5_000,
    `waiting for task strategy ${expected}`
  )
  assert(state.pressed.length === 1, `task strategy pressed state is ambiguous: ${JSON.stringify(state)}`)
}

async function focusMode(targetPage, mode) {
  await targetPage.focus(`[data-experience-mode-option="${mode}"]`)
  const focused = await targetPage.evaluate(() => document.activeElement?.getAttribute('data-experience-mode-option'))
  assert(focused === mode, `could not focus ${mode} option; focused=${focused}`)
}

async function assertMode(targetPage, expected, expectedFocus) {
  const state = await waitForValue(
    () => targetPage.evaluate(() => {
      const options = Array.from(document.querySelectorAll('[data-experience-mode-option]'))
      const pressed = options.filter((option) => option.getAttribute('aria-pressed') === 'true')
      const visiblePanes = Array.from(document.querySelectorAll('[data-experience-mode]'))
        .filter((pane) => !pane.hidden && getComputedStyle(pane).display !== 'none')
        .map((pane) => pane.getAttribute('data-experience-mode'))
      return {
        pressed: pressed.map((option) => option.getAttribute('data-experience-mode-option')),
        visiblePanes,
        focused: document.activeElement?.getAttribute('data-experience-mode-option') || null,
        studioReady: Boolean(document.querySelector('[data-studio-view]'))
      }
    }),
    (value) => value.pressed.length === 1 && value.pressed[0] === expected &&
      value.visiblePanes.length === 1 && value.visiblePanes[0] === expected &&
      (expected !== 'studio' || value.studioReady),
    30_000,
    `waiting for ${expected} mode`
  )
  if (expectedFocus) assert(state.focused === expectedFocus, `mode focus moved to ${state.focused}`)
  return state
}

async function readSessionSnapshot(targetPage, sessionId) {
  return targetPage.evaluate(async (id) => {
    const sessions = await window.agentDesk.listSessions()
    const transcript = await window.agentDesk.getTranscript(id)
    return {
      count: sessions.length,
      ids: sessions.map((item) => item.id).sort(),
      transcript
    }
  }, sessionId)
}

function assertSameSnapshot(before, after, label) {
  assert(after.count === before.count, `${label}: session count ${before.count} -> ${after.count}`)
  assert(JSON.stringify(after.ids) === JSON.stringify(before.ids), `${label}: session ids changed`)
  assert(JSON.stringify(after.transcript) === JSON.stringify(before.transcript), `${label}: transcript changed`)
}

async function focusSidebarSearch(targetPage) {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await targetPage.keyboard.down(modifier)
  await targetPage.keyboard.press('f')
  await targetPage.keyboard.up(modifier)
  await waitForValue(
    () => targetPage.evaluate(() => document.activeElement?.classList.contains('sidebar-search') === true),
    Boolean,
    5_000,
    'waiting for sidebar search focus'
  )
}

async function clearFocusedInput(targetPage) {
  await targetPage.$eval('.sidebar-search', (input) => {
    input.focus()
    input.select()
  })
  await targetPage.keyboard.press('Backspace')
  await waitForValue(
    () => targetPage.$eval('.sidebar-search', (input) => input.value),
    (value) => value === '',
    5_000,
    'waiting for sidebar search to clear'
  )
}

async function openCommandPalette(targetPage) {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await targetPage.keyboard.down(modifier)
  await targetPage.keyboard.press('k')
  await targetPage.keyboard.up(modifier)
  await targetPage.waitForSelector('.command-palette-backdrop', { visible: true, timeout: 5_000 })
}

async function readOverlayStacking(targetPage, overlaySelector) {
  return targetPage.evaluate((selector) => {
    const switcher = document.querySelector('[data-experience-mode-switcher]')
    const overlay = document.querySelector(selector)
    if (!switcher || !overlay) throw new Error(`missing overlay probe: ${selector}`)
    const rect = switcher.getBoundingClientRect()
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return {
      switcherZ: Number.parseInt(getComputedStyle(switcher).zIndex, 10) || 0,
      overlayZ: Number.parseInt(getComputedStyle(overlay).zIndex, 10) || 0,
      overlayOwnsSwitcherPoint: Boolean(top && overlay.contains(top)),
      topClass: top?.className || top?.tagName || ''
    }
  }, overlaySelector)
}

async function readMobileSidebarStacking(targetPage) {
  return targetPage.evaluate(() => {
    const switcher = document.querySelector('[data-experience-mode-switcher]')
    const sidebar = document.querySelector('.sidebar-mobile-open')
    const backdrop = document.querySelector('.mobile-sidebar-backdrop')
    if (!switcher || !sidebar || !backdrop) throw new Error('missing mobile overlay probe')
    const rect = switcher.getBoundingClientRect()
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return {
      switcherZ: Number.parseInt(getComputedStyle(switcher).zIndex, 10) || 0,
      sidebarZ: Number.parseInt(getComputedStyle(sidebar).zIndex, 10) || 0,
      backdropZ: Number.parseInt(getComputedStyle(backdrop).zIndex, 10) || 0,
      overlayOwnsSwitcherPoint: Boolean(top && (sidebar.contains(top) || backdrop.contains(top))),
      topClass: top?.className || top?.tagName || ''
    }
  })
}

async function readOverflow(targetPage, mode) {
  return targetPage.evaluate((activeMode) => {
    const app = document.querySelector('.app')
    const main = document.querySelector('.main')
    const switcher = document.querySelector('[data-experience-mode-switcher]')
    const switcherRect = switcher?.getBoundingClientRect()
    const strategy = document.querySelector('[data-task-strategy]')
    const strategyRect = strategy?.getBoundingClientRect()
    const width = window.innerWidth
    const visibleOffenders = Array.from(document.querySelectorAll('body *')).flatMap((element) => {
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0 || rect.right <= 0 || rect.left >= width) return []
      if (rect.left >= -1 && rect.right <= width + 1) return []
      if (element.closest('.sidebar:not(.sidebar-mobile-open)')) return []
      let ancestor = element.parentElement
      while (ancestor) {
        const overflowX = getComputedStyle(ancestor).overflowX
        if (overflowX === 'auto' || overflowX === 'scroll') return []
        ancestor = ancestor.parentElement
      }
      return [{
        selector: element.id ? `#${element.id}` : `${element.tagName.toLowerCase()}.${Array.from(element.classList).join('.')}`,
        left: Math.round(rect.left),
        right: Math.round(rect.right)
      }]
    }).slice(0, 10)
    return {
      mode: activeMode,
      width,
      height: window.innerHeight,
      documentOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      appOverflow: app ? Math.max(0, app.scrollWidth - app.clientWidth) : -1,
      mainOverflow: main ? Math.max(0, main.scrollWidth - main.clientWidth) : -1,
      switcherInsideViewport: Boolean(switcherRect && switcherRect.left >= -1 && switcherRect.right <= width + 1),
      strategyInsideViewport: Boolean(strategyRect && strategyRect.left >= -1 && strategyRect.right <= width + 1),
      strategyTextFits: [...document.querySelectorAll('[data-task-strategy-option]')]
        .every((button) => button.scrollWidth <= button.clientWidth + 1),
      visibleOffenders
    }
  }, mode)
}

async function captureScreenshot(targetPage, name) {
  const file = path.join(runDir, `${name}.png`)
  await targetPage.screenshot({ path: file, fullPage: false })
  report.screenshots.push(file)
}

async function waitForApp(targetPage) {
  await targetPage.waitForSelector('.app', { timeout: 20_000 })
  await targetPage.waitForFunction(() => typeof window.agentDesk?.createSession === 'function', { timeout: 15_000 })
  await targetPage.waitForSelector('[data-experience-mode-switcher]', { visible: true, timeout: 15_000 })
  await targetPage.waitForSelector('.welcome-composer-input, .composer-input', { visible: true, timeout: 15_000 })
}

async function startOpenAiMock() {
  const server = http.createServer(async (request, response) => {
    if (request.url !== '/v1/responses' || request.method !== 'POST') {
      response.writeHead(404).end('not found')
      return
    }
    let body = ''
    for await (const chunk of request) body += chunk.toString()
    if (body.includes('strategy running marker')) await sleep(900)
    const reply = 'Stable assistant studio transcript response.'
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: reply })}\n\n`)
    response.write(`data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: `resp_assistant_studio_${Date.now()}`,
        output_text: reply,
        usage: { input_tokens: 12, output_tokens: 7, input_tokens_details: { cached_tokens: 0 } }
      }
    })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  const port = await findFreePort(8800)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return { server, port, baseUrl: `http://127.0.0.1:${port}` }
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
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode }
  child.kill('SIGTERM')
  return Promise.race([
    new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
    sleep(3000).then(() => {
      child.kill('SIGKILL')
      return { code: child.exitCode, signal: child.signalCode ?? 'SIGKILL' }
    })
  ])
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

function readGitState() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8'
  }).trim()
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
