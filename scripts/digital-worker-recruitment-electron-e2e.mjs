#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const packageJson = require(path.join(repoRoot, 'package.json'))
const electronPackage = require('electron/package.json')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const outputRoot = path.join(repoRoot, 'test-results', 'digital-worker-recruitment-electron')
const runDir = path.join(outputRoot, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-digital-worker-electron-'))
const userDataDir = path.join(tempRoot, 'userData')
const fixtureHome = path.join(tempRoot, 'home')
const xdgConfigHome = path.join(fixtureHome, '.config')
const sentinelBin = path.join(tempRoot, 'agent-cli-sentinels')
const sentinelLog = path.join(tempRoot, 'agent-cli-invocations.log')
const sourceOutDir = path.join(repoRoot, 'out')
const isolatedOutDir = path.join(runDir, 'app', 'out')
const mainEntry = path.join(isolatedOutDir, 'main', 'index.js')
const electronBin = require('electron')
const externalAgentNames = ['claude', 'codex', 'aider', 'cursor', 'goose']
const externalAgentCommand = /(^|[\\/\s])(claude|codex|aider|cursor|goose)(?:\.exe|\.cmd)?(?=\s|$)/i

const state = {
  projectName: 'TEAM-002 Release Project',
  roleName: 'Release Evidence Reviewer',
  workerName: 'CaoGen Release Reviewer',
  watercolorRole: 'review-test',
  primaryWorkItemTitle: 'Review release evidence package',
  secondaryWorkItemTitle: 'Post-retirement assignment probe',
  projectId: '',
  roleId: '',
  workerId: '',
  primaryWorkItemId: '',
  secondaryWorkItemId: '',
  expectedWorkItems: [],
  assignmentId: '',
  engineRegistry: null
}
let markedFieldSequence = 0

const report = {
  schemaVersion: 1,
  runId,
  runDir,
  requirement: 'required',
  requirements: ['TEAM-002'],
  packageVersion: packageJson.version,
  gitCommit: '',
  worktreeClean: false,
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  electronVersion: electronPackage.version,
  checks: [],
  phases: [],
  screenshots: [],
  warnings: [],
  externalAgentBoundary: {
    interceptedNames: externalAgentNames,
    sentinelLog,
    sourceFiles: [],
    phaseSnapshots: []
  },
  coverage: {
    verified: [
      'directory-free Project template WorkItems and two explicit WorkItems created through real Studio UI clicks',
      'role creation and role-selected native DigitalWorker recruitment through real UI clicks',
      'explicit watercolor role selection and restart-safe avatar profile persistence',
      'responsibility, tool, data, budget, concurrency, acceptance, and escalation policy presentation',
      'WorkItem assignment through the native renderer to main-process IPC gateway',
      'same-userData recovery without duplicate project, role, worker, or assignment records',
      'Assignment release and retirement through UI, fail-closed new assignment, and durable assignment history',
      'no external Agent CLI install, launch, Provider/session creation, or engine registry mutation'
    ],
    explicitlyNotVerified: [
      'executing a DigitalWorker WorkItem with an Agent runtime',
      'releasing an in-flight Assignment during retirement'
    ]
  }
}

prepareFixture()
assertBuildInputs()
assertNativeRecruitmentBoundary()
copyBuiltApp()

let activeRuntime
let signalCleanupStarted = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void cleanupAfterSignal(signal)
  })
}

try {
  await runPhase('recruit-and-assign', async (page) => {
    await check('directory-free Project and WorkItems are created through Studio clicks', async () => {
      await setupProjectWorkItems(page)
    })

    await check('role is created and selected through the Digital Team UI', async () => {
      await enterDigitalTeam(page)
      await clickButtonByText(page, '岗位库', '[data-studio-surface="digital-workers"]', false)
      await page.click('[data-dws-action="create-role"]')
      await page.waitForSelector('[data-dws-form="role-template"]', { visible: true, timeout: 5_000 })
      const defaultRoleForm = await page.$eval('[data-dws-form="role-template"]', (form) => ({
        advancedOpen: Boolean(form.querySelector('details.dws-advanced')?.open),
        visibleInputs: [...form.querySelectorAll('input, select, textarea')].filter((element) => {
          const rect = element.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }).length
      }))
      assert(!defaultRoleForm.advancedOpen, `role advanced settings opened by default: ${JSON.stringify(defaultRoleForm)}`)
      assert(defaultRoleForm.visibleInputs === 2, `default role form should expose 2 inputs: ${JSON.stringify(defaultRoleForm)}`)
      await replaceLabeledValue(page, '[data-dws-form="role-template"]', '岗位名称', state.roleName)
      await replaceLabeledValue(page, '[data-dws-form="role-template"]', '主要职责', 'Review release evidence under explicit project policy')
      await page.click('[data-dws-form="role-template"] details.dws-advanced > summary')
      await replaceLabeledValue(page, '[data-dws-form="role-template"]', '详细执行说明', 'Verify evidence, record gaps, and escalate blocked release decisions.')
      await replaceLabeledValue(page, '[data-dws-form="role-template"]', '能力标签', 'release-review, evidence-audit')
      await replaceLabeledValue(page, '[data-dws-form="role-template"]', '技能标签', 'artifact-review, risk-triage')
      await page.click('[data-dws-form="role-template"] button[type="submit"]')
      const role = await waitForValue(
        () => page.evaluate((name) => window.agentDesk.listDigitalWorkerRoleTemplates().then((items) => items.find((item) => item.name === name)), state.roleName),
        Boolean,
        10_000,
        'waiting for the role created through Studio'
      )
      state.roleId = role.id
      await page.waitForSelector(`[data-role-template-id="${state.roleId}"]`, { visible: true, timeout: 5_000 })
      const roleText = await page.$eval(`[data-role-template-id="${state.roleId}"]`, (element) => element.textContent || '')
      for (const token of ['Review release evidence', 'release-review', 'artifact-review']) {
        assert(roleText.includes(token), `role presentation omitted ${token}: ${roleText}`)
      }
    })

    await check('native DigitalWorker recruitment persists and presents the complete policy', async () => {
      await page.click(`[data-role-template-id="${state.roleId}"] [data-dws-action="hire-from-role"]`)
      await page.waitForSelector('[data-dws-form="hire-worker"]', { visible: true, timeout: 5_000 })
      const defaultForm = await page.$eval('[data-dws-form="hire-worker"]', (form) => ({
        advancedOpen: Boolean(form.querySelector('details.dws-advanced')?.open),
        visibleInputs: [...form.querySelectorAll('input, select, textarea')].filter((element) => {
          const rect = element.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }).length
      }))
      assert(!defaultForm.advancedOpen, `advanced settings opened by default: ${JSON.stringify(defaultForm)}`)
      assert(defaultForm.visibleInputs === 2, `default recruitment form should expose 2 inputs: ${JSON.stringify(defaultForm)}`)
      assert(
        await readLabeledValue(page, '[data-dws-form="hire-worker"]', '岗位') === state.roleId,
        'role-selected recruitment did not retain the chosen RoleTemplate'
      )
      assert(
        await readLabeledValue(page, '[data-dws-form="hire-worker"]', '员工名称') === `${state.roleName} 01`,
        'recruitment did not generate a worker name from the selected role'
      )
      await replaceLabeledValue(page, '[data-dws-form="hire-worker"]', '员工名称', state.workerName)
      await page.click('[data-dws-form="hire-worker"] details.dws-advanced > summary')
      assert(
        await readLabeledValue(page, '[data-dws-form="hire-worker"]', '自定义职责') === 'Verify evidence, record gaps, and escalate blocked release decisions.',
        'recruitment did not inherit responsibilities from the selected role'
      )
      await replaceLabeledValue(page, '[data-dws-form="hire-worker"]', '自定义职责', 'Review release evidence\nReport acceptance gaps')
      await page.waitForSelector('[data-dws-form="hire-worker"] [data-dws-watercolor-role]', { visible: true, timeout: 5_000 })
      await page.select('[data-dws-form="hire-worker"] [data-dws-watercolor-role]', state.watercolorRole)
      await setLabeledCheckbox(page, '[data-dws-form="hire-worker"]', '修改工作区', true)
      await setLabeledCheckbox(page, '[data-dws-form="hire-worker"]', '终端操作', true)
      await replaceLabeledValue(page, '[data-dws-form="hire-worker"]', '允许的数据类', 'project-internal')
      await replaceLabeledValue(page, '[data-dws-form="hire-worker"]', '禁止的数据类', 'credential')
      await replaceLabeledValue(page, '[data-dws-form="hire-worker"]', '允许的 Resource ID', 'repo-main')
      await setLabeledCheckbox(page, '[data-dws-form="hire-worker"]', '分配 WorkItem 时必须声明数据类', true)
      await replaceLabeledValue(page, '[data-dws-form="hire-worker"]', '月度预算 (USD)', '42.5')
      await replaceLabeledValue(page, '[data-dws-form="hire-worker"]', '最大并发', '3')
      await replaceLabeledValue(page, '[data-dws-form="hire-worker"]', '最少 Evidence 数', '2')
      await setLabeledCheckbox(page, '[data-dws-form="hire-worker"]', '验收需用户确认', true)
      await replaceLabeledValue(page, '[data-dws-form="hire-worker"]', '升级目标', 'release-manager')
      await replaceLabeledValue(page, '[data-dws-form="hire-worker"]', '连续失败后升级', '3')
      await page.click('[data-dws-form="hire-worker"] button[type="submit"]')
      const worker = await waitForValue(
        () => page.evaluate((name) => window.agentDesk.listDigitalWorkers({ includeRetired: true }).then((items) => items.find((item) => item.displayName === name)), state.workerName),
        (candidate) => candidate?.status === 'active',
        10_000,
        'waiting for active recruited DigitalWorker'
      )
      state.workerId = worker.id
      assertWorkerPolicy(worker)
      await page.waitForSelector(workerCardSelector(), { visible: true, timeout: 5_000 })
      await assertWorkerCardPresentation(page, 'active')
    })

    await check('WorkItem assignment is completed through the Digital Team UI', async () => {
      await page.click(`${workerCardSelector()} [data-dws-action="assign"]`)
      await page.waitForSelector('[data-dws-form="assignment"]', { visible: true, timeout: 5_000 })
      await page.select('[data-dws-form="assignment"] [data-dws-field="work-item"]', state.primaryWorkItemId)
      await page.select('[data-dws-form="assignment"] [data-dws-field="worker"]', state.workerId)
      await replaceLabeledValue(page, '[data-dws-form="assignment"]', '数据类', 'project-internal')
      await replaceLabeledValue(page, '[data-dws-form="assignment"]', 'Resource ID', 'repo-main')
      await replaceLabeledValue(page, '[data-dws-form="assignment"]', '分配原因', 'TEAM-002 release review')
      await page.click('[data-dws-form="assignment"] button[type="submit"]')
      await page.waitForSelector('[data-dws-form="assignment"]', { hidden: true, timeout: 10_000 })
      const history = await waitForValue(
        () => page.evaluate(
          ({ projectId, workerId }) => window.agentDesk.listDigitalWorkerAssignmentHistory({ projectId, assigneeId: workerId }),
          { projectId: state.projectId, workerId: state.workerId }
        ),
        (items) => items.length === 1,
        10_000,
        'waiting for assignment history'
      )
      state.assignmentId = history[0].id
      assert(history[0].workItemId === state.primaryWorkItemId, 'UI assigned the wrong WorkItem')
      assert(history[0].scope?.dataClass === 'project-internal', 'assignment data class did not persist')
      assert(history[0].scope?.resourceIds?.[0] === 'repo-main', 'assignment resource scope did not persist')
      const workItem = await page.evaluate((id) => window.agentDesk.getProjectWorkItem(id), state.primaryWorkItemId)
      assert(workItem?.owner?.id === state.workerId, `WorkItem owner did not update: ${JSON.stringify(workItem?.owner)}`)
      await page.waitForFunction(
        ({ selector, title }) => document.querySelector(selector)?.textContent?.includes(title),
        { timeout: 10_000 },
        { selector: workerCardSelector(), title: state.primaryWorkItemTitle }
      )
      await screenshot(page, '01-recruited-and-assigned')
    })
  })

  await runPhase('restart-and-retire', async (page) => {
    await check('same userData reopens without duplicate team records', async () => {
      await waitForSelectedProject(page)
      await enterDigitalTeam(page)
      await page.waitForSelector(workerCardSelector(), { visible: true, timeout: 10_000 })
      const snapshot = await readTeamSnapshot(page)
      assertTeamSnapshot(snapshot, 'first restart')
      const dom = await page.evaluate(() => ({
        roles: document.querySelectorAll('[data-role-template-id]').length,
        workers: document.querySelectorAll('[data-digital-worker-id]').length
      }))
      assert(dom.roles === 0, `team tab should not duplicate hidden role cards: ${JSON.stringify(dom)}`)
      assert(dom.workers === 1, `expected one worker card after restart: ${JSON.stringify(dom)}`)
      await assertWorkerCardPresentation(page, 'active')
    })

    await check('retirement is clicked in UI and blocks a new Assignment while preserving history', async () => {
      await page.click(`${workerCardSelector()} [data-dws-action="release-assignment"][data-assignment-id="${state.assignmentId}"]`)
      await page.waitForFunction(
        ({ projectId, workerId }) => window.agentDesk.listDigitalWorkerAssignments({
          projectId,
          assigneeId: workerId,
          status: 'active'
        }).then((items) => items.length === 0),
        { timeout: 10_000 },
        { projectId: state.projectId, workerId: state.workerId }
      )
      const retireSelector = `${workerCardSelector()} [data-dws-action="retire"]:not([disabled])`
      await page.waitForSelector(retireSelector, { visible: true, timeout: 10_000 })
      await page.click(retireSelector)
      await page.waitForSelector(`${workerCardSelector()} [data-dws-action="confirm-retire"]`, { visible: true, timeout: 5_000 })
      await page.click(`${workerCardSelector()} [data-dws-action="confirm-retire"]`)
      await page.waitForFunction(
        (selector) => document.querySelector(selector)?.getAttribute('data-digital-worker-status') === 'retired',
        { timeout: 10_000 },
        workerCardSelector()
      )
      const retired = await page.evaluate((id) => window.agentDesk.getDigitalWorker(id), state.workerId)
      assert(retired?.status === 'retired', `retirement did not persist: ${JSON.stringify(retired)}`)
      assert(await page.$(`${workerCardSelector()} [data-dws-action="assign"]`) === null, 'retired worker still exposes a new assignment action')
      const rejection = await tryAssignRetiredWorker(page)
      assert(!rejection.ok, 'retired worker unexpectedly accepted a new Assignment')
      assert(
        /retired|not active|cannot receive an Assignment|CONFLICT/i.test(`${rejection.code || ''} ${rejection.message || ''}`),
        `retired Assignment rejection was not explicit: ${JSON.stringify(rejection)}`
      )
      const history = await page.evaluate(
        ({ projectId, workerId }) => window.agentDesk.listDigitalWorkerAssignmentHistory({ projectId, assigneeId: workerId }),
        { projectId: state.projectId, workerId: state.workerId }
      )
      assert(history.length === 1 && history[0].id === state.assignmentId, `retirement changed history: ${JSON.stringify(history)}`)
      assert(history[0].status === 'released', 'retirement should preserve the released historical Assignment')
      await page.click(`${workerCardSelector()} [data-dws-action="worker-history"]`)
      await assertHistoryPanel(page)
      await screenshot(page, '02-retired-with-history')
    })
  })

  await runPhase('retired-history-restart', async (page) => {
    await check('retired worker and Assignment history survive another Electron restart', async () => {
      await waitForSelectedProject(page)
      await enterDigitalTeam(page)
      await page.waitForSelector(workerCardSelector(), { visible: true, timeout: 10_000 })
      const snapshot = await readTeamSnapshot(page)
      assertTeamSnapshot(snapshot, 'retired restart', 'released')
      assert(snapshot.workers[0].status === 'retired', `worker status regressed after restart: ${snapshot.workers[0].status}`)
      assert(await page.$(`${workerCardSelector()} [data-dws-action="assign"]`) === null, 'retired worker regained assignment action after restart')
      const rejection = await tryAssignRetiredWorker(page)
      assert(!rejection.ok, 'retired worker accepted an Assignment after restart')
      await assertWorkerCardPresentation(page, 'retired')
      await page.click(`${workerCardSelector()} [data-dws-action="worker-history"]`)
      await assertHistoryPanel(page)
      await screenshot(page, '03-retired-history-after-restart')
    })
  })

  await check('durable worker state contains no external Agent registration or CLI artifacts', async () => {
    const persistedPath = path.join(userDataDir, 'digital-workers.json')
    assert(existsSync(persistedPath), `DigitalWorker store missing: ${persistedPath}`)
    const document = JSON.parse(readFileSync(persistedPath, 'utf8'))
    assert(document.roleTemplates.length === 1, `persisted RoleTemplate count ${document.roleTemplates.length}`)
    assert(document.workers.length === 1, `persisted DigitalWorker count ${document.workers.length}`)
    assert(document.assignments.length === 1, `persisted Assignment count ${document.assignments.length}`)
    assert(document.workers[0].status === 'retired', `persisted status ${document.workers[0].status}`)
    assert(document.workers[0].avatarProfile?.watercolorRole === state.watercolorRole, 'persisted watercolor role changed')
    assert(document.assignments[0].id === state.assignmentId, 'persisted Assignment identity changed')
    const forbiddenKeys = findForbiddenRegistrationKeys(document)
    assert(forbiddenKeys.length === 0, `DigitalWorker state contains external runtime identity keys: ${forbiddenKeys.join(', ')}`)
    assertNoExternalAgentArtifacts()
    const invocations = readSentinelInvocations()
    assert(invocations.length === 0, `external Agent CLI sentinel was invoked: ${invocations.join(', ')}`)
    report.persistedState = {
      path: persistedPath,
      roleTemplateCount: document.roleTemplates.length,
      workerCount: document.workers.length,
      assignmentCount: document.assignments.length,
      workerStatus: document.workers[0].status,
      watercolorRole: document.workers[0].avatarProfile.watercolorRole,
      assignmentStatus: document.assignments[0].status,
      auditCount: document.audit.length,
      forbiddenRegistrationKeys: forbiddenKeys
    }
  })
} catch (error) {
  report.error = error instanceof Error ? error.stack || error.message : String(error)
  process.exitCode = 1
  if (activeRuntime?.page) await screenshot(activeRuntime.page, 'failure').catch(() => undefined)
} finally {
  if (activeRuntime) await stopRuntime(activeRuntime)
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
  report.cleanup = await cleanupTempRoot()
  if (!report.cleanup.removed && !report.error) {
    report.error = `test Electron cleanup incomplete: ${JSON.stringify(report.cleanup.remainingProcesses)}`
  }
  report.status = report.checks.every((item) => item.status === 'pass') && !report.error ? 'pass' : 'fail'
  const body = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(runDir, 'report.json'), body)
  writeFileSync(path.join(outputRoot, 'latest.json'), body)
}

if (report.status === 'pass') {
  console.log(`digital worker recruitment Electron E2E ok: ${runDir}`)
  console.log(`${report.checks.length}/${report.checks.length} checks passed across ${report.phases.length} Electron launches`)
} else {
  console.error(`digital worker recruitment Electron E2E failed: ${report.error || 'check failure'}`)
}
process.exit(report.status === 'pass' ? 0 : 1)

async function runPhase(name, execute) {
  const startedAt = Date.now()
  activeRuntime = await launchRuntime(name)
  try {
    await enterStudio(activeRuntime.page)
    const before = await readRuntimeBoundary(activeRuntime.page)
    if (state.engineRegistry === null) state.engineRegistry = before.engines
    else assertSameJson(before.engines, state.engineRegistry, `${name} engine registry before workflow`)
    assert(before.providers.length === 0, `${name} unexpectedly has Providers: ${JSON.stringify(before.providers)}`)
    assert(before.sessions.length === 0, `${name} unexpectedly has sessions: ${JSON.stringify(before.sessions)}`)
    await execute(activeRuntime.page)
    await check(`${name} does not install, launch, or register an external Agent CLI`, async () => {
      const after = await readRuntimeBoundary(activeRuntime.page)
      assertSameJson(after.engines, before.engines, `${name} engine registry`)
      assertSameJson(after.providers, before.providers, `${name} Provider registry`)
      assertSameJson(after.sessions, before.sessions, `${name} session registry`)
      const invocations = readSentinelInvocations()
      assert(invocations.length === 0, `${name} external Agent CLI invocations: ${invocations.join(', ')}`)
      const descendants = electronDescendantCommands(activeRuntime.child.pid)
      const externalCommands = descendants.filter((command) => externalAgentCommand.test(command))
      assert(externalCommands.length === 0, `${name} external Agent processes: ${externalCommands.join(' | ')}`)
      assertNoExternalAgentArtifacts()
      report.externalAgentBoundary.phaseSnapshots.push({
        name,
        engines: after.engines,
        providerCount: after.providers.length,
        sessionCount: after.sessions.length,
        sentinelInvocations: invocations,
        electronDescendants: descendants
      })
    })
    report.phases.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
  } catch (error) {
    await screenshot(activeRuntime.page, `failure-${name}`).catch(() => undefined)
    report.phases.push({
      name,
      status: 'fail',
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  } finally {
    await stopRuntime(activeRuntime)
    activeRuntime = null
  }
}

async function launchRuntime(phase) {
  const port = await findFreePort(9960)
  const phaseSlug = phase.replace(/[^a-z0-9_-]+/gi, '-')
  const stdoutPath = path.join(runDir, `${phaseSlug}.stdout.log`)
  const stderrPath = path.join(runDir, `${phaseSlug}.stderr.log`)
  const stdoutFd = openSync(stdoutPath, 'a')
  const stderrFd = openSync(stderrPath, 'a')
  const child = spawn(electronBin, [
    ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    `--remote-debugging-port=${port}`,
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    mainEntry
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${sentinelBin}${path.delimiter}${process.env.PATH || ''}`,
      HOME: fixtureHome,
      XDG_CONFIG_HOME: xdgConfigHome,
      CAOGEN_AGENT_CLI_SENTINEL_LOG: sentinelLog,
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
    detached: process.platform !== 'win32',
    stdio: ['ignore', stdoutFd, stderrFd]
  })
  closeSync(stdoutFd)
  closeSync(stderrFd)
  try {
    await waitForDebugPort(port, 20_000)
    const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null })
    const page = await waitForElectronPage(browser, 20_000)
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        report.warnings.push(`${phase} console ${message.type()}: ${message.text()}`)
      }
    })
    page.on('pageerror', (error) => report.warnings.push(`${phase} pageerror: ${error.message}`))
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
    await page.bringToFront()
    return {
      browser,
      child,
      page,
      phase,
      port,
      rootPid: child.pid,
      stdoutPath,
      stderrPath
    }
  } catch (error) {
    await terminate(child)
    throw error
  }
}

async function stopRuntime(runtime) {
  if (runtime.stopPromise) return runtime.stopPromise
  runtime.stopPromise = (async () => {
    try {
      runtime.browser?.disconnect()
    } catch {
      // The debug connection may already be gone after a renderer failure.
    }
    const exited = await terminate(runtime.child)
    const portClosed = await waitForPortClosed(runtime.port, 5_000)
    const remainingProcesses = processRowsReferencing([tempRoot, userDataDir, mainEntry])
    const output = readRuntimeOutput(runtime)
    report.warnings.push(...summarizeProcessOutput(runtime.phase, output, exited))
    if (!portClosed) report.warnings.push(`${runtime.phase} debug port ${runtime.port} remained open after Electron termination`)
    if (remainingProcesses.length > 0) {
      report.warnings.push(`${runtime.phase} retained related processes: ${JSON.stringify(remainingProcesses)}`)
    }
    return { exited, portClosed, remainingProcesses }
  })()
  return runtime.stopPromise
}

async function enterStudio(page) {
  await page.waitForSelector('.app', { timeout: 20_000 })
  await page.waitForFunction(
    () => typeof window.agentDesk?.listProjectWorkspaces === 'function' &&
      typeof window.agentDesk?.listDigitalWorkers === 'function',
    { timeout: 15_000 }
  )
  await page.click('[data-experience-mode-option="studio"]')
  await page.waitForSelector('[data-project-workspace-studio]', { visible: true, timeout: 15_000 })
  await page.waitForFunction(
    () => document.querySelector('[data-project-workspace-studio]')?.getAttribute('aria-busy') === 'false',
    { timeout: 15_000 }
  )
}

async function createDirectoryFreeProject(page) {
  await page.waitForSelector('.pws-project-empty', { visible: true, timeout: 10_000 })
  await clickVisibleSelectorUntilVisible(
    page,
    '[data-studio-action="create-project-empty"]',
    '[data-studio-form="project"]'
  )
  await replaceSelectorValue(page, '[data-studio-form="project"] [name="projectName"]', state.projectName)
  await page.select('[data-studio-form="project"] [name="projectKind"]', 'software')
  await page.click('[data-studio-form="project"] button[type="submit"]')
  const project = await waitForValue(
    () => page.evaluate((name) => window.agentDesk.listProjectWorkspaces({ includeArchived: true, includeDeleted: true }).then((items) => items.find((item) => item.name === name)), state.projectName),
    Boolean,
    10_000,
    'waiting for directory-free Project'
  )
  state.projectId = project.id
  await waitForSelectedProject(page, { requireWorkItems: false })
}

async function setupProjectWorkItems(page) {
  await createDirectoryFreeProject(page)
  const templateItems = await page.evaluate(
    (projectId) => window.agentDesk.listProjectWorkItems(projectId),
    state.projectId
  )
  const templateTitles = ['理解代码与约束', '实现变更', '独立验证', '审查与交付']
  assert(
    templateItems.length === templateTitles.length &&
      templateItems.every((item) => item.id.startsWith('project-template-work-')) &&
      templateTitles.every((title) => templateItems.filter((item) => item.title === title).length === 1),
    `software Project template WorkItems changed: ${JSON.stringify(workItemIdentities(templateItems))}`
  )
  const first = await createWorkItem(page, state.primaryWorkItemTitle)
  const second = await createWorkItem(page, state.secondaryWorkItemTitle)
  state.primaryWorkItemId = first.id
  state.secondaryWorkItemId = second.id
  const allItems = await page.evaluate(
    (projectId) => window.agentDesk.listProjectWorkItems(projectId),
    state.projectId
  )
  state.expectedWorkItems = workItemIdentities(allItems)
  assert(
    state.expectedWorkItems.length === templateTitles.length + 2,
    `initial WorkItem set changed: ${JSON.stringify(state.expectedWorkItems)}`
  )
  for (const expected of [
    { id: state.primaryWorkItemId, title: state.primaryWorkItemTitle },
    { id: state.secondaryWorkItemId, title: state.secondaryWorkItemTitle }
  ]) {
    assert(
      state.expectedWorkItems.filter((item) => item.id === expected.id && item.title === expected.title).length === 1,
      `explicit WorkItem identity changed: ${JSON.stringify({ expected, actual: state.expectedWorkItems })}`
    )
  }
  const project = await page.evaluate((id) => window.agentDesk.getProjectWorkspace(id), state.projectId)
  assert(project?.resources?.length === 0, `directory-free Project gained resources: ${JSON.stringify(project?.resources)}`)
}

async function createWorkItem(page, title) {
  await clickButtonByText(page, '新建工作项', '[data-project-workspace-studio]')
  await page.waitForSelector('[data-studio-form="work-item"]', { visible: true, timeout: 5_000 })
  await replaceLabeledValue(page, '[data-studio-form="work-item"]', '工作项名称', title)
  await replaceLabeledValue(page, '[data-studio-form="work-item"]', '说明', `TEAM-002 fixture for ${title}`).catch(() => undefined)
  await page.click('[data-studio-form="work-item"] button[type="submit"]')
  const item = await waitForValue(
    () => page.evaluate(
      ({ projectId, title: expectedTitle }) => window.agentDesk.listProjectWorkItems(projectId).then((items) => items.find((entry) => entry.title === expectedTitle)),
      { projectId: state.projectId, title }
    ),
    Boolean,
    10_000,
    `waiting for WorkItem ${title}`
  )
  await page.waitForSelector(`[data-work-item-id="${item.id}"]`, { visible: true, timeout: 5_000 })
  return item
}

async function enterDigitalTeam(page) {
  await clickButtonByText(page, '数字团队', '[data-studio-view] .studio-section-switcher')
  await page.waitForSelector('[data-studio-surface="digital-workers"]', { visible: true, timeout: 10_000 })
  await page.waitForFunction(
    () => !document.querySelector('[data-studio-surface="digital-workers"]')?.textContent?.includes('正在加载团队...'),
    { timeout: 15_000 }
  )
}

async function waitForSelectedProject(page, { requireWorkItems = true } = {}) {
  try {
    await page.waitForFunction(
      (projectId) => document.querySelector('[data-project-workspace-select]')?.value === projectId,
      { timeout: 15_000 },
      state.projectId
    )
  } catch (error) {
    const diagnostics = await readProjectSelectionDiagnostics(page).catch((diagnosticError) => ({
      diagnosticError: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)
    }))
    report.projectSelectionDiagnostics = diagnostics
    await screenshot(page, 'project-selection-timeout').catch(() => undefined)
    throw new Error(
      `created Project was not selected automatically: expected ${state.projectId}; diagnostics=${JSON.stringify(diagnostics)}`,
      { cause: error }
    )
  }
  await page.waitForFunction(
    () => document.querySelector('[data-project-workspace-studio]')?.getAttribute('aria-busy') === 'false',
    { timeout: 15_000 }
  )
  if (!requireWorkItems) return
  await page.waitForFunction(
    ({ first, second }) => {
      const text = document.querySelector('[data-project-workspace-studio]')?.textContent || ''
      return text.includes(first) && text.includes(second)
    },
    { timeout: 15_000 },
    { first: state.primaryWorkItemTitle, second: state.secondaryWorkItemTitle }
  )
}

async function readProjectSelectionDiagnostics(page) {
  return page.evaluate(async (expectedProjectId) => {
    const selector = document.querySelector('[data-project-workspace-select]')
    const studio = document.querySelector('[data-project-workspace-studio]')
    const projects = await window.agentDesk.listProjectWorkspaces({ includeArchived: true, includeDeleted: true })
    return {
      expectedProjectId,
      selectedValue: selector?.value ?? null,
      options: selector instanceof HTMLSelectElement
        ? [...selector.options].map((option) => ({ value: option.value, text: option.textContent?.trim() ?? '' }))
        : [],
      ariaBusy: studio?.getAttribute('aria-busy') ?? null,
      errorFeedback: [...document.querySelectorAll('.pws-feedback-error')].map((element) => element.textContent?.trim() ?? ''),
      successFeedback: [...document.querySelectorAll('.pws-feedback-success')].map((element) => element.textContent?.trim() ?? ''),
      projects: projects.map((project) => ({ id: project.id, name: project.name, status: project.status })),
      studioText: (studio?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 2500)
    }
  }, state.projectId)
}

async function readTeamSnapshot(page) {
  return page.evaluate(async ({ projectId }) => {
    const [projects, workItems, roles, workers, history, activeAssignments] = await Promise.all([
      window.agentDesk.listProjectWorkspaces({ includeArchived: true, includeDeleted: true }),
      window.agentDesk.listProjectWorkItems(projectId),
      window.agentDesk.listDigitalWorkerRoleTemplates(),
      window.agentDesk.listDigitalWorkers({ projectId, includeRetired: true }),
      window.agentDesk.listDigitalWorkerAssignmentHistory({ projectId }),
      window.agentDesk.listDigitalWorkerAssignments({ projectId, status: 'active' })
    ])
    return { projects, workItems, roles, workers, history, activeAssignments }
  }, { projectId: state.projectId })
}

function assertTeamSnapshot(snapshot, label, assignmentStatus = 'active') {
  assert(snapshot.projects.length === 1 && snapshot.projects[0].id === state.projectId, `${label} Project duplication: ${snapshot.projects.length}`)
  const actualWorkItems = workItemIdentities(snapshot.workItems)
  assertSameJson(actualWorkItems, state.expectedWorkItems, `${label} WorkItem identity projection`)
  assert(
    new Set(actualWorkItems.map((item) => item.id)).size === actualWorkItems.length &&
      new Set(actualWorkItems.map((item) => item.title)).size === actualWorkItems.length,
    `${label} WorkItem duplication: ${JSON.stringify(actualWorkItems)}`
  )
  assert(
    actualWorkItems.filter((item) => item.templateOrigin).length === 4 &&
      actualWorkItems.filter((item) => !item.templateOrigin).length === 2,
    `${label} template/explicit WorkItem partition changed: ${JSON.stringify(actualWorkItems)}`
  )
  assert(snapshot.roles.length === 1 && snapshot.roles[0].id === state.roleId, `${label} RoleTemplate duplication: ${snapshot.roles.length}`)
  assert(snapshot.workers.length === 1 && snapshot.workers[0].id === state.workerId, `${label} DigitalWorker duplication: ${snapshot.workers.length}`)
  assertWorkerPolicy(snapshot.workers[0])
  assert(snapshot.history.length === 1 && snapshot.history[0].id === state.assignmentId, `${label} Assignment history duplication: ${snapshot.history.length}`)
  assert(snapshot.history[0].status === assignmentStatus, `${label} Assignment status changed: ${snapshot.history[0].status}`)
  if (assignmentStatus === 'active') {
    assert(snapshot.activeAssignments.length === 1 && snapshot.activeAssignments[0].id === state.assignmentId, `${label} active Assignment changed`)
  } else {
    assert(snapshot.activeAssignments.length === 0, `${label} released Assignment became active: ${JSON.stringify(snapshot.activeAssignments)}`)
  }
}

async function assertHistoryPanel(page) {
  const selector = `[data-dws-worker-history="${state.workerId}"]`
  await page.waitForSelector(selector, { visible: true, timeout: 10_000 })
  const summary = await page.$$eval(`${selector} .dws-history-summary > div`, (items) => Object.fromEntries(
    items.map((item) => {
      const label = item.querySelector('span')?.textContent?.trim() ?? ''
      const value = Number(item.querySelector('strong')?.textContent?.trim() ?? 'NaN')
      return [label, value]
    })
  ))
  assert(summary.Assignment === 1, `worker history UI lost Assignment history: ${JSON.stringify(summary)}`)
}

function workItemIdentities(items) {
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    goalId: item.goalId ?? null,
    parentId: item.parentId ?? null,
    type: item.type,
    dependencyIds: [...(item.dependencyIds ?? [])].sort(),
    templateOrigin: item.id.startsWith('project-template-work-')
  })).sort((left, right) => left.id.localeCompare(right.id))
}

function assertWorkerPolicy(worker) {
  assert(worker.projectId === state.projectId, `worker Project mismatch: ${worker.projectId}`)
  assert(worker.roleTemplateId === state.roleId, `worker RoleTemplate mismatch: ${worker.roleTemplateId}`)
  assert(worker.responsibilityScope.join('|') === 'Review release evidence|Report acceptance gaps', `responsibilities ${JSON.stringify(worker.responsibilityScope)}`)
  assert(worker.toolPolicy.workspaceRead === true, 'workspaceRead policy missing')
  assert(worker.toolPolicy.workspaceWrite === true, 'workspaceWrite policy missing')
  assert(worker.toolPolicy.terminal === true, 'terminal policy missing')
  assert(worker.dataScope.requireExplicitScope === true, 'explicit data scope policy missing')
  assert(worker.dataScope.allowedDataClasses?.[0] === 'project-internal', 'allowed data class missing')
  assert(worker.dataScope.deniedDataClasses?.[0] === 'credential', 'denied data class missing')
  assert(worker.dataScope.allowedResourceIds?.[0] === 'repo-main', 'allowed Resource missing')
  assert(worker.budgetPolicy.monthlyUsd === 42.5, `budget policy ${JSON.stringify(worker.budgetPolicy)}`)
  assert(worker.concurrencyLimit === 3, `concurrency ${worker.concurrencyLimit}`)
  assert(worker.acceptancePolicy.minimumEvidenceCount === 2, `acceptance ${JSON.stringify(worker.acceptancePolicy)}`)
  assert(worker.acceptancePolicy.requireUserApproval === true, 'user approval policy missing')
  assert(worker.escalationPolicy.target === 'release-manager', `escalation target ${worker.escalationPolicy.target}`)
  assert(worker.escalationPolicy.afterFailures === 3, `escalation failures ${worker.escalationPolicy.afterFailures}`)
  assert(worker.avatarProfile?.watercolorRole === state.watercolorRole, `watercolor role ${JSON.stringify(worker.avatarProfile)}`)
  for (const field of ['providerId', 'model', 'engine', 'cli']) {
    assert(!(field in worker), `native DigitalWorker unexpectedly contains ${field}`)
  }
}

async function assertWorkerCardPresentation(page, expectedStatus) {
  const presentation = await page.$eval(workerCardSelector(), (element) => ({
    text: element.textContent || '',
    status: element.getAttribute('data-digital-worker-status'),
    watercolorRole: element.getAttribute('data-watercolor-role'),
    watercolorRoleSource: element.getAttribute('data-watercolor-role-source'),
    sections: [...element.querySelectorAll('h4')].map((heading) => heading.textContent?.trim() || '')
  }))
  assert(presentation.status === expectedStatus, `worker card status ${presentation.status}, expected ${expectedStatus}`)
  assert(presentation.watercolorRole === state.watercolorRole, `worker card watercolor role ${presentation.watercolorRole}`)
  assert(presentation.watercolorRoleSource === 'avatar-profile', `worker card watercolor role source ${presentation.watercolorRoleSource}`)
  for (const section of ['职责', '工具权限', '数据范围', '验收与升级', 'WorkItem']) {
    assert(presentation.sections.includes(section), `worker card missing ${section}: ${presentation.sections.join(', ')}`)
  }
  for (const token of [
    state.workerName,
    state.roleName,
    'Review release evidence',
    'Report acceptance gaps',
    '读取工作区',
    '修改工作区',
    '终端操作',
    '允许: project-internal',
    '禁止: credential',
    'Resource: repo-main',
    '$42.5 / 月',
    '并发',
    '3',
    'Evidence >= 2',
    '需用户确认',
    'release-manager',
    '3 次失败后升级'
  ]) {
    assert(presentation.text.includes(token), `worker card omitted ${token}: ${presentation.text}`)
  }
}

async function tryAssignRetiredWorker(page) {
  return page.evaluate(async (input) => {
    try {
      const assignment = await window.agentDesk.createDigitalWorkerAssignment(input)
      return { ok: true, assignment }
    } catch (error) {
      return {
        ok: false,
        code: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }, {
    projectId: state.projectId,
    workItemId: state.secondaryWorkItemId,
    assigneeKind: 'digital_worker',
    assigneeId: state.workerId,
    assignedBy: 'team-002-e2e',
    scope: { dataClass: 'project-internal', resourceIds: ['repo-main'] },
    reason: 'retirement rejection proof'
  })
}

async function readRuntimeBoundary(page) {
  return page.evaluate(async () => {
    const [engines, providers, sessions] = await Promise.all([
      window.agentDesk.listEngines(),
      window.agentDesk.listProviders(),
      window.agentDesk.listSessions()
    ])
    return {
      engines: [...engines].sort((left, right) => left.kind.localeCompare(right.kind)),
      providers: providers.map((provider) => provider.id).sort(),
      sessions: sessions.map((session) => session.id).sort()
    }
  })
}

async function replaceLabeledValue(page, formSelector, label, value) {
  const selector = await markLabeledControl(page, formSelector, label)
  const tagName = await page.$eval(selector, (element) => element.tagName)
  if (tagName === 'SELECT') {
    await page.select(selector, value)
    return
  }
  await replaceSelectorValue(page, selector, value)
}

async function readLabeledValue(page, formSelector, label) {
  const selector = await markLabeledControl(page, formSelector, label)
  return page.$eval(selector, (element) => element.value)
}

async function setLabeledCheckbox(page, formSelector, label, checked) {
  const selector = await markLabeledControl(page, formSelector, label)
  const current = await page.$eval(selector, (element) => element.checked)
  if (current !== checked) await page.click(selector)
}

async function markLabeledControl(page, formSelector, labelText) {
  const token = `team-002-field-${++markedFieldSequence}`
  const found = await page.evaluate(({ formSelector: form, labelText: expected, token: marker }) => {
    const root = document.querySelector(form)
    if (!root) return false
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim()
    for (const label of root.querySelectorAll('label')) {
      const labelValue = normalize(label.querySelector('span')?.textContent || label.textContent)
      if (labelValue !== expected) continue
      const control = label.control || label.querySelector('input, textarea, select')
      if (!control) return false
      control.setAttribute('data-team-002-field', marker)
      return true
    }
    return false
  }, { formSelector, labelText, token })
  assert(found, `missing labeled control ${labelText} in ${formSelector}`)
  return `[data-team-002-field="${token}"]`
}

async function replaceSelectorValue(page, selector, value) {
  await page.click(selector)
  await page.$eval(selector, (element) => {
    if (typeof element.select === 'function') element.select()
  })
  if (value) await page.keyboard.type(value)
}

async function clickButtonByText(page, text, rootSelector = 'body', exact = true) {
  const buttons = await page.$$(`${rootSelector} button`)
  for (const button of buttons) {
    const candidate = await button.evaluate((element) => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return {
        text: (element.textContent || '').replace(/\s+/g, ' ').trim(),
        visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
        disabled: element.disabled === true
      }
    })
    const matches = exact ? candidate.text === text : candidate.text.startsWith(text)
    if (matches && candidate.visible && !candidate.disabled) {
      await button.click()
      return
    }
  }
  throw new Error(`visible enabled button not found: ${text}`)
}

async function clickVisibleSelector(page, selector) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let element
    try {
      element = await page.waitForSelector(selector, { visible: true, timeout: 5_000 })
      if (!element) throw new Error(`visible selector disappeared before click: ${selector}`)
      await element.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'center' }))
      await element.click()
      return
    } catch (error) {
      lastError = error
      if (attempt === 2) throw error
      await sleep(100)
    } finally {
      await element?.dispose()
    }
  }
  throw lastError ?? new Error(`visible selector did not become clickable: ${selector}`)
}

async function clickVisibleSelectorUntilVisible(page, triggerSelector, targetSelector) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await clickVisibleSelector(page, triggerSelector)
    try {
      await page.waitForSelector(targetSelector, { visible: true, timeout: 5_000 })
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error(`selector did not become visible after click: ${targetSelector}`)
}

function workerCardSelector() {
  return `[data-digital-worker-id="${state.workerId}"]`
}

async function check(name, execute) {
  const startedAt = Date.now()
  try {
    await execute()
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

async function screenshot(page, name) {
  const file = path.join(runDir, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  report.screenshots.push(file)
}

function prepareFixture() {
  for (const directory of [runDir, userDataDir, fixtureHome, xdgConfigHome, sentinelBin]) {
    mkdirSync(directory, { recursive: true })
  }
  writeFileSync(sentinelLog, '', 'utf8')
  for (const name of externalAgentNames) {
    if (process.platform === 'win32') {
      writeFileSync(
        path.join(sentinelBin, `${name}.cmd`),
        `@echo ${name}>>"%CAOGEN_AGENT_CLI_SENTINEL_LOG%"\r\n@exit /b 97\r\n`,
        'utf8'
      )
    } else {
      const file = path.join(sentinelBin, name)
      writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' ${name} >> "$CAOGEN_AGENT_CLI_SENTINEL_LOG"\nexit 97\n`, 'utf8')
      chmodSync(file, 0o755)
    }
  }
}

function assertBuildInputs() {
  assert(existsSync(electronBin), 'Electron binary not found. Run npm install first.')
  for (const entry of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
    assert(existsSync(path.join(sourceOutDir, entry)), `Built app entry missing: out/${entry}. Run npm run build first.`)
  }
}

function copyBuiltApp() {
  rmSync(isolatedOutDir, { recursive: true, force: true })
  mkdirSync(isolatedOutDir, { recursive: true })
  for (const directory of ['main', 'preload', 'renderer']) {
    cpSync(path.join(sourceOutDir, directory), path.join(isolatedOutDir, directory), { recursive: true })
  }
}

function assertNativeRecruitmentBoundary() {
  const files = [
    ...sourceFiles(path.join(repoRoot, 'src', 'main', 'digital-worker')),
    path.join(repoRoot, 'src', 'main', 'ipc', 'digital-worker-handlers.ts'),
    path.join(repoRoot, 'src', 'preload', 'digital-worker.ts'),
    ...[
      'DigitalWorkerCards.tsx',
      'DigitalWorkerForms.tsx',
      'DigitalWorkerStudio.tsx',
      'DigitalWorkerStudioView.tsx',
      'digital-worker-studio-model.ts',
      'useDigitalWorkerStudio.ts'
    ].map((name) => path.join(repoRoot, 'src', 'renderer', 'src', 'components', 'studio', name))
  ]
  const source = files.map((file) => readFileSync(file, 'utf8')).join('\n')
  for (const pattern of [
    /node:child_process/,
    /\b(?:spawn|execFile|fork)\s*\(/,
    /registerEngine\s*\(/,
    /(?:claude|codex|aider|cursor|goose)[-_ ]?(?:cli|process|binary)/i,
    /(?:npm|pnpm|yarn|brew)\s+(?:install|add)[^\n]*(?:claude|codex|aider|cursor|goose)/i
  ]) {
    assert(!pattern.test(source), `native recruitment source matched external Agent boundary ${pattern}`)
  }
  report.externalAgentBoundary.sourceFiles = files.map((file) => path.relative(repoRoot, file))
}

function sourceFiles(root) {
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(file))
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(file)
  }
  return files
}

function readSentinelInvocations() {
  if (!existsSync(sentinelLog)) return []
  return readFileSync(sentinelLog, 'utf8').split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)
}

function assertNoExternalAgentArtifacts() {
  const artifacts = []
  for (const root of [fixtureHome, userDataDir]) {
    for (const entry of walkPaths(root)) {
      const basename = path.basename(entry).toLowerCase()
      if (externalAgentNames.some((name) => basename === name || basename.startsWith(`${name}.`) || basename.startsWith(`.${name}`))) {
        artifacts.push(entry)
      }
    }
  }
  assert(artifacts.length === 0, `external Agent installation artifacts found: ${artifacts.join(', ')}`)
}

function walkPaths(root) {
  if (!existsSync(root)) return []
  const entries = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name)
    entries.push(candidate)
    if (entry.isDirectory()) entries.push(...walkPaths(candidate))
  }
  return entries
}

function electronDescendantCommands(rootPid) {
  if (process.platform === 'win32') return []
  let output = ''
  try {
    output = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  } catch (error) {
    report.warnings.push(`process tree inspection failed: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
  const rows = output.split(/\r?\n/).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null
  }).filter(Boolean)
  const descendants = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid)
        changed = true
      }
    }
  }
  return rows.filter((row) => row.pid !== rootPid && descendants.has(row.pid)).map((row) => row.command)
}

function findForbiddenRegistrationKeys(value, pointer = '$', findings = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findForbiddenRegistrationKeys(entry, `${pointer}[${index}]`, findings))
    return findings
  }
  if (!value || typeof value !== 'object') return findings
  for (const [key, entry] of Object.entries(value)) {
    const next = `${pointer}.${key}`
    if (/^(?:provider(?:Id|Name|Key|Ref)?|model(?:Id|Name|Key|Ref)?|engine|externalAgent|cli|cliPath|binaryPath|commandPath)$/i.test(key)) {
      findings.push(next)
    }
    findForbiddenRegistrationKeys(entry, next, findings)
  }
  return findings
}

function assertSameJson(actual, expected, label) {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  assert(left === right, `${label} changed: expected ${right}, got ${left}`)
}

async function waitForElectronPage(browser, timeoutMs) {
  return waitForValue(
    async () => (await browser.pages()).find((candidate) => !candidate.url().startsWith('devtools://')),
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
  let outcome = await Promise.race([exited, sleep(3000).then(() => null)])
  if (electronTreeAlive(child.pid)) {
    signalElectronTree(child.pid, 'SIGKILL')
    outcome ??= await Promise.race([
      exited,
      sleep(3000).then(() => ({ code: child.exitCode, signal: child.signalCode ?? 'SIGKILL' }))
    ])
  }
  await waitForProcessReferencesToClear([tempRoot, userDataDir, mainEntry], 5_000)
  return outcome ?? { code: child.exitCode, signal: child.signalCode }
}

function signalElectronTree(pid, signal) {
  if (!pid) return
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal)
  } catch {
    // The isolated process group already exited.
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

function readRuntimeOutput(runtime) {
  return {
    stdout: existsSync(runtime.stdoutPath) ? readFileSync(runtime.stdoutPath, 'utf8') : '',
    stderr: existsSync(runtime.stderrPath) ? readFileSync(runtime.stderrPath, 'utf8') : ''
  }
}

function summarizeProcessOutput(phase, output, exited) {
  const warnings = []
  if (output.stderr.trim()) warnings.push(`${phase} [stderr tail]\n${output.stderr.trim().slice(-1200)}`)
  if (output.stdout.trim()) warnings.push(`${phase} [stdout tail]\n${output.stdout.trim().slice(-600)}`)
  if (exited?.signal) warnings.push(`${phase} Electron exited by signal ${exited.signal}`)
  return warnings
}

function readGitState() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  return {
    commit,
    worktreeClean: status.length === 0,
    statusEntryCount: status ? status.split(/\r?\n/).length : 0
  }
}

async function cleanupTempRoot() {
  const remainingProcesses = await waitForProcessReferencesToClear([tempRoot, userDataDir, mainEntry], 5_000)
  if (remainingProcesses.length > 0) {
    report.warnings.push(`temporary directory retained because related processes are still running: ${JSON.stringify(remainingProcesses)}`)
    return { removed: false, tempRoot, remainingProcesses }
  }
  try {
    rmSync(tempRoot, { recursive: true, force: true })
    return { removed: true, tempRoot, remainingProcesses: [] }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    report.warnings.push(`temporary directory cleanup failed: ${message}`)
    return { removed: false, tempRoot, remainingProcesses: [], error: message }
  }
}

function processRowsReferencing(needles) {
  if (process.platform === 'win32') return []
  let output = ''
  try {
    output = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  } catch (error) {
    report.warnings.push(`process reference inspection failed: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
  return output.split(/\r?\n/).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null
  }).filter((row) => row && row.pid !== process.pid && needles.some((needle) => row.command.includes(needle)))
}

async function waitForProcessReferencesToClear(needles, timeoutMs) {
  const startedAt = Date.now()
  let rows = processRowsReferencing(needles)
  while (rows.length > 0 && Date.now() - startedAt < timeoutMs) {
    await sleep(150)
    rows = processRowsReferencing(needles)
  }
  return rows
}

async function waitForPortClosed(port, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await canListen(port)) return true
    await sleep(150)
  }
  return canListen(port)
}

async function cleanupAfterSignal(signal) {
  if (signalCleanupStarted) return
  signalCleanupStarted = true
  if (activeRuntime) await stopRuntime(activeRuntime).catch(() => undefined)
  const cleanup = await cleanupTempRoot().catch(() => ({ removed: false }))
  process.exitCode = signal === 'SIGINT' ? 130 : 143
  if (!cleanup.removed) process.exitCode = 1
  process.exit()
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
