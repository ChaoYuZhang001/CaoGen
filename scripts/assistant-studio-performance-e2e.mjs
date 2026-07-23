#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { cpus, release, tmpdir, totalmem } from 'node:os'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { createRequire } from 'node:module'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const packageJson = require(path.join(repoRoot, 'package.json'))
const electronPackage = require('electron/package.json')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const outputRoot = path.join(repoRoot, 'test-results', 'assistant-studio-performance')
const runDir = path.join(outputRoot, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-assistant-studio-performance-'))
const sourceOutDir = path.join(repoRoot, 'out')
const isolatedOutDir = path.join(runDir, 'app', 'out')
const mainEntry = path.join(isolatedOutDir, 'main', 'index.js')
const electronBin = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const thresholdMs = 300
const warmSwitchesPerViewport = 20
const firstDelta = 'performance-held-stream '
const finalDelta = 'performance-complete'
const viewports = [
  { name: 'desktop', width: 1320, height: 860, deviceScaleFactor: 1 },
  { name: 'tablet', width: 760, height: 700, deviceScaleFactor: 1 },
  { name: 'mobile', width: 360, height: 520, deviceScaleFactor: 1 }
]

assert(existsSync(electronBin), 'Electron binary not found. Run npm install first.')
for (const entry of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
  assert(existsSync(path.join(sourceOutDir, entry)), `Built app entry missing: out/${entry}. Run npm run build first.`)
}

mkdirSync(runDir, { recursive: true })
const initialSourceBuildBinding = inspectSourceBuildBinding()
const report = createReport(initialSourceBuildBinding)
let mock

try {
  assert(initialSourceBuildBinding.status === 'pass', staleBuildMessage(initialSourceBuildBinding))
  copyBuiltApp()
  mock = await startControlledResponsesMock()
  for (const viewport of viewports) {
    await check(`${viewport.name} cold/warm mode switching`, async () => {
      const phase = await runViewportPhase(viewport, mock)
      report.phases.push(phase)
    })
  }
  report.metrics = summarizeMetrics(report.phases)
  await check('cold and warm P95 remain below 300ms in every viewport', async () => {
    assertPerformanceThresholds(report.metrics)
  })
  await check('all switches preserve one canonical Run and one runtime request', async () => {
    for (const phase of report.phases) assertPhaseContinuity(phase)
  })
} catch (error) {
  report.error = error instanceof Error ? error.stack || error.message : String(error)
  process.exitCode = 1
} finally {
  if (mock) {
    mock.abort()
    await closeServer(mock.server)
  }
  const finalSourceBuildBinding = inspectSourceBuildBinding()
  report.sourceBuildBinding.final = finalSourceBuildBinding
  report.sourceBuildBinding.status = finalSourceBuildBinding.status
  if (finalSourceBuildBinding.status !== 'pass' && !report.error) {
    report.error = `Source/build binding changed during E2E. ${staleBuildMessage(finalSourceBuildBinding)}`
  }
  const git = readGitState()
  report.gitCommit = git.commit
  report.worktreeClean = git.worktreeClean
  report.statusEntryCount = git.statusEntryCount
  report.finishedAt = new Date().toISOString()
  report.status = report.checks.every((item) => item.status === 'pass') && !report.error ? 'pass' : 'fail'
  writeReport()
  cleanupTempRoot(tempRoot)
}

if (report.status !== 'pass') {
  console.error(`assistant/studio performance E2E failed: ${report.error || 'check failure'}`)
  process.exitCode = 1
} else {
  console.log(`assistant/studio performance E2E ok: ${runDir}`)
  console.log(`cold P95=${formatMs(report.metrics.cold.p95Ms)} warm P95=${formatMs(report.metrics.warm.p95Ms)} threshold<${thresholdMs}ms`)
}

function createReport(sourceBuildBinding) {
  return {
    schemaVersion: 1,
    runId,
    runDir,
    startedAt: new Date().toISOString(),
    requirement: 'required',
    requirementIds: ['NFR-PERF-001'],
    packageVersion: packageJson.version,
    gitCommit: '',
    worktreeClean: false,
    statusEntryCount: 0,
    threshold: { metric: 'p95', operator: '<', milliseconds: thresholdMs },
    samplePlan: {
      viewports,
      coldSamplesPerViewport: 1,
      warmSamplesPerViewport: warmSwitchesPerViewport,
      totalColdSamples: viewports.length,
      totalWarmSamples: viewports.length * warmSwitchesPerViewport
    },
    measurementProtocol: {
      clock: 'renderer window.performance.now()',
      start: 'programmatic activation of the visible Assistant/Studio mode button',
      stop: 'target mode, visible panel, and enabled mode-local control committed through the next animation frame',
      cold: 'first Studio mount in a fresh Electron renderer process and fresh userData directory',
      warm: 'subsequent Assistant/Studio switches after Studio has mounted',
      networkIsolation: 'one local Responses request remains deliberately open and emits no data during all measurements',
      continuity: 'session/runtime IDs, canonical Run ID/count, transcript counts, init events, and request count are compared before and after switching'
    },
    hardware: readHardwareMetadata(),
    runtime: {
      platform: process.platform,
      arch: process.arch,
      osRelease: release(),
      nodeVersion: process.version,
      electronVersion: electronPackage.version
    },
    sourceBuildBinding: { status: sourceBuildBinding.status, initial: sourceBuildBinding },
    phases: [],
    checks: [],
    screenshots: [],
    warnings: [],
    metrics: null,
    coverage: {
      verified: [
        'fresh-process cold and mounted warm Assistant/Studio interaction latency at desktop, tablet, and mobile viewports',
        'per-viewport and aggregate cold/warm P95 are strictly below 300ms',
        'switching completes while the local Provider response is held open without additional network data',
        'switching does not restart or duplicate the canonical Run, runtime session, request, user message, or turn result'
      ],
      explicitlyNotVerified: [
        'remote Provider latency because mode switching must be independent of Provider networking',
        'release-candidate performance on hardware other than the recorded reference device',
        'Office/3D performance, which is governed by separate requirements'
      ]
    }
  }
}

async function runViewportPhase(viewport, controlledMock) {
  const phaseRoot = path.join(tempRoot, viewport.name)
  const userDataDir = path.join(phaseRoot, 'userData')
  const projectDir = path.join(phaseRoot, 'project')
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(path.join(projectDir, 'README.md'), `# NFR-PERF-001 ${viewport.name}\n`, 'utf8')
  const remotePort = await findFreePort(9820 + report.phases.length * 100)
  const electron = launchElectron(remotePort, userDataDir)
  const watchdog = setTimeout(() => signalElectronTree(electron.pid, 'SIGKILL'), 90_000)
  const processOutput = collectProcessOutput(electron)
  let browser
  let page
  const phase = createPhase(viewport)

  try {
    await waitForDebugPort(remotePort, 20_000)
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${remotePort}`, defaultViewport: null })
    page = await waitForElectronPage(browser, 20_000)
    attachPageDiagnostics(page, phase)
    await page.setViewport(viewport)
    await page.bringToFront()
    await waitForApp(page, false)
    const fixture = await createCanonicalFixture(page, viewport.name, projectDir, controlledMock.baseUrl)
    phase.sessionId = fixture.sessionId
    await waitForSessionReady(page, phase.sessionId)

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.setViewport(viewport)
    await page.bringToFront()
    await waitForApp(page, true)
    await installSessionEventProbe(page, phase.sessionId)
    const requestOrdinal = controlledMock.requests.length + 1
    await page.evaluate((id) => window.agentDesk.sendMessage(id, {
      text: 'Hold this canonical Run while Assistant and Studio performance is measured.',
      messageId: `nfr-perf-001-${viewport.name}`
    }), phase.sessionId)
    await controlledMock.waitForRequest(requestOrdinal)
    phase.before = await waitForRunningBaseline(page, fixture, requestOrdinal, controlledMock)

    phase.samples.push(await measureModeSwitch(page, 'studio', 'cold', 1))
    phase.studioShellInteraction = await verifyStudioShellInteraction(page)
    phase.studioDataReady = await measureStudioDataReady(page)
    await captureScreenshot(page, phase, `${viewport.name}-cold-studio`)
    for (let index = 0; index < warmSwitchesPerViewport; index += 1) {
      const mode = index % 2 === 0 ? 'assistant' : 'studio'
      phase.samples.push(await measureModeSwitch(page, mode, 'warm', index + 1))
    }
    phase.afterSwitches = await readRuntimeSnapshot(page, fixture)
    phase.requestCountAfterSwitches = controlledMock.requests.length
    assertRuntimeStable(phase.before, phase.afterSwitches, `${viewport.name} switches`)
    assert(phase.requestCountAfterSwitches === requestOrdinal, `${viewport.name}: switch created another model request`)
    await captureScreenshot(page, phase, `${viewport.name}-warm-final`)

    controlledMock.finish(requestOrdinal)
    phase.completed = await waitForCompletedRuntime(page, fixture)
    phase.requestCountAfterCompletion = controlledMock.requests.length
    assertCompletionStable(phase.before, phase.completed, `${viewport.name} completion`)
    phase.metrics = summarizePhaseMetrics(phase.samples)
    phase.browserRuntime = await readBrowserRuntime(page)
    phase.status = 'pass'
    return phase
  } catch (error) {
    phase.status = 'fail'
    phase.error = error instanceof Error ? error.stack || error.message : String(error)
    if (page) await captureScreenshot(page, phase, `${viewport.name}-failure`).catch(() => undefined)
    throw error
  } finally {
    clearTimeout(watchdog)
    controlledMock.abort()
    if (browser) await browser.disconnect().catch(() => undefined)
    const exited = await terminate(electron)
    phase.process = { ...processOutput.read(), exited }
    report.warnings.push(...summarizeProcessOutput(viewport.name, phase.process))
  }
}

function createPhase(viewport) {
  return {
    name: viewport.name,
    viewport,
    status: 'running',
    sessionId: '',
    samples: [],
    screenshots: [],
    before: null,
    afterSwitches: null,
    completed: null,
    metrics: null,
    studioShellInteraction: null,
    studioDataReady: null,
    browserRuntime: null,
    warnings: []
  }
}

function launchElectron(remotePort, userDataDir) {
  return spawn(electronBin, [`--remote-debugging-port=${remotePort}`, mainEntry], {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      CAOGEN_USER_DATA_DIR: userDataDir,
      CAOGEN_MEMORY_DIR: path.join(userDataDir, 'memory'),
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
}

function collectProcessOutput(child) {
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  return { read: () => ({ stdout, stderr }) }
}

function attachPageDiagnostics(page, phase) {
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      phase.warnings.push(`console ${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => phase.warnings.push(`pageerror: ${error.message}`))
}

async function createCanonicalFixture(page, name, cwd, baseUrl) {
  return page.evaluate(async ({ phaseName, projectRoot, providerBaseUrl }) => {
    const projectId = `nfr-perf-001-${phaseName}-project`
    const goalId = `nfr-perf-001-${phaseName}-goal`
    const workItemId = `nfr-perf-001-${phaseName}-work-item`
    const project = await window.agentDesk.createProjectWorkspace({
      id: projectId,
      name: `NFR-PERF-001 ${phaseName}`,
      kind: 'software'
    })
    const goal = await window.agentDesk.createProjectGoal({
      id: goalId,
      projectId,
      title: 'Keep mode switching local and continuous',
      objective: 'Measure Assistant and Studio without restarting work',
      status: 'planned'
    })
    const workItem = await window.agentDesk.createProjectWorkItem({
      id: workItemId,
      projectId,
      goalId,
      title: `Measure ${phaseName} mode switching`,
      type: 'testing',
      status: 'ready'
    })
    const provider = await window.agentDesk.createProvider({
      name: `NFR-PERF-001 ${phaseName} local mock`,
      baseUrl: providerBaseUrl,
      token: 'test-only',
      models: [`nfr-perf-001-${phaseName}-model`],
      openaiProtocol: 'responses'
    })
    const session = await window.agentDesk.createSession({
      cwd: projectRoot,
      workspaceId: projectId,
      goalId,
      workItemId,
      engine: 'openai',
      providerId: provider.id,
      model: `nfr-perf-001-${phaseName}-model`,
      routingScope: 'fixed',
      permissionMode: 'default',
      isolated: false,
      title: `NFR-PERF-001 ${phaseName} session`
    })
    return { projectId, goalId, workItemId, sessionId: session.id }
  }, { phaseName: name, projectRoot: cwd, providerBaseUrl: baseUrl })
}

async function waitForSessionReady(page, sessionId) {
  await waitForValue(
    () => page.evaluate((id) => window.agentDesk.listSessions().then((items) => items.find((item) => item.id === id)), sessionId),
    (meta) => Boolean(meta?.sdkSessionId && meta.status === 'idle'),
    15_000,
    'waiting for canonical performance session initialization'
  )
}

async function waitForRunningBaseline(page, fixture, requestOrdinal, controlledMock) {
  const value = await waitForValue(
    () => readRuntimeSnapshot(page, fixture),
    (snapshot) => snapshot.meta?.status === 'running' &&
      snapshot.userMessageCount === 1 &&
      snapshot.turnResultCount === 0 &&
      snapshot.canonicalRuns.length === 1 &&
      snapshot.deltaText === firstDelta &&
      controlledMock.requests.length === requestOrdinal,
    20_000,
    'waiting for held canonical Run'
  )
  assert(value.sessionCount === 1, `expected one session, got ${value.sessionCount}`)
  assert(value.initCount === 0, `session restarted before measurement: initCount=${value.initCount}`)
  assertCanonicalRun(value.canonicalRuns[0], fixture)
  return value
}

async function waitForCompletedRuntime(page, fixture) {
  const value = await waitForValue(
    () => readRuntimeSnapshot(page, fixture),
    (snapshot) => snapshot.meta?.status === 'idle' &&
      snapshot.turnResultCount === 1 &&
      snapshot.canonicalRuns.length === 1 &&
      snapshot.deltaText === `${firstDelta}${finalDelta}`,
    20_000,
    'waiting for canonical performance Run completion'
  )
  assertCanonicalRun(value.canonicalRuns[0], fixture)
  return value
}

async function readRuntimeSnapshot(page, fixture) {
  return page.evaluate(async ({ ids, heldDelta }) => {
    const [sessions, transcript, ledger] = await Promise.all([
      window.agentDesk.listSessions(),
      window.agentDesk.getTranscript(ids.sessionId),
      window.agentDesk.listWorkflowLedger({ projectId: ids.projectId, limit: 100 })
    ])
    const meta = sessions.find((item) => item.id === ids.sessionId)
    const events = transcript.map((entry) => entry.event)
    const liveEntries = Array.isArray(window.__assistantStudioPerformanceEvents)
      ? window.__assistantStudioPerformanceEvents
      : []
    const liveEvents = liveEntries.map((entry) => entry.event)
    const deltaText = liveEvents
      .filter((event) => event?.kind === 'text-delta')
      .map((event) => event.text)
      .join('')
    return {
      sessionCount: sessions.length,
      sessionIds: sessions.map((item) => item.id).sort(),
      meta: meta ? {
        id: meta.id,
        sdkSessionId: meta.sdkSessionId,
        engine: meta.engine,
        providerId: meta.providerId,
        model: meta.model,
        routingScope: meta.routingScope,
        cwd: meta.cwd,
        workspaceId: meta.workspaceId,
        goalId: meta.goalId,
        workItemId: meta.workItemId,
        status: meta.status
      } : null,
      transcriptCount: transcript.length,
      userMessageCount: events.filter((event) => event?.kind === 'user-message').length,
      turnResultCount: events.filter((event) => event?.kind === 'turn-result').length,
      liveEventCount: liveEvents.length,
      initCount: liveEvents.filter((event) => event?.kind === 'init').length,
      deltaText: deltaText || (events.some((event) => event?.kind === 'text-delta') ? heldDelta : ''),
      canonicalRuns: ledger.runs.items
        .filter((run) => run.sessionId === ids.sessionId)
        .map((run) => ({
          id: run.id,
          projectId: run.projectId,
          goalId: run.goalId,
          workItemId: run.workItemId,
          sessionId: run.sessionId,
          status: run.status,
          revision: run.revision
        }))
    }
  }, { ids: fixture, heldDelta: firstDelta })
}

async function installSessionEventProbe(page, sessionId) {
  await page.evaluate((id) => {
    window.__assistantStudioPerformanceUnsubscribe?.()
    window.__assistantStudioPerformanceEvents = []
    window.__assistantStudioPerformanceUnsubscribe = window.agentDesk.onSessionEvent(
      (eventSessionId, event, seq, eventId) => {
        if (eventSessionId !== id) return
        window.__assistantStudioPerformanceEvents.push({ event, seq, eventId: eventId ?? '' })
      }
    )
  }, sessionId)
}

async function measureModeSwitch(page, mode, temperature, ordinal) {
  const measurement = await page.evaluate(async ({ expectedMode, sampleTemperature, timeoutMs }) => {
    const button = document.querySelector(`[data-experience-mode-option="${expectedMode}"]`)
    if (!(button instanceof HTMLButtonElement)) throw new Error(`mode button missing: ${expectedMode}`)
    await new Promise((resolve) => requestAnimationFrame(() => resolve()))
    const startedAt = performance.now()
    if (sampleTemperature === 'cold') window.__assistantStudioPerformanceColdStartedAt = startedAt
    button.click()
    return new Promise((resolve, reject) => {
      const deadline = startedAt + timeoutMs
      const poll = () => {
        if (modeReady(expectedMode)) {
          requestAnimationFrame(() => resolve({
            durationMs: performance.now() - startedAt,
            visibilityState: document.visibilityState
          }))
          return
        }
        if (performance.now() >= deadline) {
          reject(new Error(`mode ${expectedMode} did not become interactive within ${timeoutMs}ms`))
          return
        }
        requestAnimationFrame(poll)
      }
      requestAnimationFrame(poll)
    })

    function modeReady(targetMode) {
      const pressed = Array.from(document.querySelectorAll('[data-experience-mode-option]'))
        .filter((item) => item.getAttribute('aria-pressed') === 'true')
      const pane = document.querySelector('[data-experience-mode]')
      if (pressed.length !== 1 || pressed[0].getAttribute('data-experience-mode-option') !== targetMode) return false
      if (pane?.getAttribute('data-experience-mode') !== targetMode) return false
      if (targetMode === 'studio') {
        const control = document.querySelector('.studio-section-switcher button')
        return visible('#studio-projection-panel-workspace') &&
          visible('[data-studio-view]') &&
          visible('.studio-section-switcher') &&
          control instanceof HTMLButtonElement &&
          !control.disabled &&
          focusableAndUnblocked(control)
      }
      const composer = document.querySelector('.composer-input')
      return visible('#studio-projection-panel-session') &&
        composer instanceof HTMLElement &&
        visible('.composer-input') &&
        focusableAndUnblocked(composer)
    }

    function visible(selector) {
      const element = document.querySelector(selector)
      if (!(element instanceof HTMLElement) || element.hidden) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
    }

    function focusableAndUnblocked(element) {
      element.focus({ preventScroll: true })
      if (document.activeElement !== element) return false
      const rect = element.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return hit === element || (hit !== null && element.contains(hit))
    }
  }, { expectedMode: mode, sampleTemperature: temperature, timeoutMs: 5_000 })
  assert(measurement.visibilityState === 'visible', `renderer was ${measurement.visibilityState} during measurement`)
  return { mode, temperature, ordinal, durationMs: roundMs(measurement.durationMs) }
}

async function verifyStudioShellInteraction(page) {
  return page.evaluate(async () => {
    const buttons = Array.from(document.querySelectorAll('.studio-section-switcher button'))
    if (buttons.length !== 2 || buttons.some((button) => !(button instanceof HTMLButtonElement) || button.disabled)) {
      throw new Error('Studio shell controls are not operable during hydration')
    }
    const startedAt = performance.now()
    buttons[1].click()
    await waitForPressed(buttons[1])
    buttons[0].click()
    await waitForPressed(buttons[0])
    buttons[0].focus({ preventScroll: true })
    if (document.activeElement !== buttons[0]) throw new Error('Studio shell control cannot retain focus')
    return {
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      projectDataBusyDuringInteraction: document.querySelector('[data-project-workspace-studio]')?.getAttribute('aria-busy') === 'true'
    }

    function waitForPressed(button) {
      return new Promise((resolve, reject) => {
        const started = performance.now()
        const poll = () => {
          if (button.getAttribute('aria-pressed') === 'true') {
            requestAnimationFrame(resolve)
            return
          }
          if (performance.now() - started >= 2_000) {
            reject(new Error('Studio shell section switch did not commit within 2000ms'))
            return
          }
          requestAnimationFrame(poll)
        }
        requestAnimationFrame(poll)
      })
    }
  })
}

async function measureStudioDataReady(page) {
  return page.evaluate(async () => {
    const startedAt = performance.now()
    const coldStartedAt = window.__assistantStudioPerformanceColdStartedAt
    if (!Number.isFinite(coldStartedAt)) throw new Error('cold switch timestamp is unavailable')
    return new Promise((resolve, reject) => {
      const poll = () => {
        const root = document.querySelector('[data-project-workspace-studio]')
        const refresh = document.querySelector('[data-studio-action="refresh"]')
        if (root?.getAttribute('aria-busy') === 'false' && refresh && !refresh.disabled) {
          const finishedAt = performance.now()
          resolve({
            afterShellInteractiveMs: Math.round((finishedAt - startedAt) * 100) / 100,
            fromColdSwitchStartMs: Math.round((finishedAt - coldStartedAt) * 100) / 100
          })
          return
        }
        if (performance.now() - startedAt >= 10_000) {
          reject(new Error('Studio project data did not become ready within 10000ms'))
          return
        }
        requestAnimationFrame(poll)
      }
      requestAnimationFrame(poll)
    })
  })
}

function assertRuntimeStable(before, after, label) {
  assertIdentityStable(before, after, label)
  assert(after.meta.status === 'running', `${label}: session status changed to ${after.meta.status}`)
  assert(after.userMessageCount === before.userMessageCount, `${label}: user message count changed`)
  assert(after.turnResultCount === before.turnResultCount, `${label}: turn result count changed`)
  assert(after.transcriptCount === before.transcriptCount, `${label}: transcript changed while stream was held`)
  assert(after.liveEventCount === before.liveEventCount, `${label}: live event count changed while network was held`)
  assert(after.initCount === before.initCount, `${label}: session init event count changed`)
  assert(after.deltaText === before.deltaText, `${label}: held stream content changed`)
  assert(after.canonicalRuns[0].status === before.canonicalRuns[0].status, `${label}: canonical Run status changed`)
  assert(after.canonicalRuns[0].revision === before.canonicalRuns[0].revision, `${label}: canonical Run revision changed`)
}

function assertCompletionStable(before, completed, label) {
  assertIdentityStable(before, completed, label)
  assert(completed.userMessageCount === 1, `${label}: user message duplicated`)
  assert(completed.turnResultCount === 1, `${label}: turn result count is not exactly one`)
  assert(completed.initCount === before.initCount, `${label}: session restarted`)
  assert(completed.canonicalRuns.length === 1, `${label}: canonical Run duplicated`)
}

function assertIdentityStable(before, after, label) {
  assert(after.sessionCount === before.sessionCount, `${label}: session count changed`)
  assert(JSON.stringify(after.sessionIds) === JSON.stringify(before.sessionIds), `${label}: session IDs changed`)
  for (const key of [
    'id', 'sdkSessionId', 'engine', 'providerId', 'model', 'routingScope', 'cwd',
    'workspaceId', 'goalId', 'workItemId'
  ]) {
    assert(after.meta?.[key] === before.meta?.[key], `${label}: session ${key} changed`)
  }
  assert(after.canonicalRuns.length === before.canonicalRuns.length, `${label}: canonical Run count changed`)
  assert(after.canonicalRuns[0]?.id === before.canonicalRuns[0]?.id, `${label}: canonical Run ID changed`)
}

function assertCanonicalRun(run, fixture) {
  assert(run?.projectId === fixture.projectId, 'canonical Run Project ownership mismatch')
  assert(run.goalId === fixture.goalId, 'canonical Run Goal ownership mismatch')
  assert(run.workItemId === fixture.workItemId, 'canonical Run WorkItem ownership mismatch')
  assert(run.sessionId === fixture.sessionId, 'canonical Run Session ownership mismatch')
}

function summarizePhaseMetrics(samples) {
  const cold = samples.filter((sample) => sample.temperature === 'cold').map((sample) => sample.durationMs)
  const warm = samples.filter((sample) => sample.temperature === 'warm').map((sample) => sample.durationMs)
  return { cold: metricSummary(cold), warm: metricSummary(warm), all: metricSummary([...cold, ...warm]) }
}

function summarizeMetrics(phases) {
  const cold = phases.flatMap((phase) => phase.samples.filter((sample) => sample.temperature === 'cold').map((sample) => sample.durationMs))
  const warm = phases.flatMap((phase) => phase.samples.filter((sample) => sample.temperature === 'warm').map((sample) => sample.durationMs))
  return {
    cold: metricSummary(cold),
    warm: metricSummary(warm),
    all: metricSummary([...cold, ...warm]),
    byViewport: Object.fromEntries(phases.map((phase) => [phase.name, phase.metrics]))
  }
}

function metricSummary(values) {
  const sorted = [...values].sort((left, right) => left - right)
  assert(sorted.length > 0, 'performance metric requires at least one sample')
  return {
    count: sorted.length,
    minMs: roundMs(sorted[0]),
    medianMs: roundMs(percentile(sorted, 0.5)),
    p95Ms: roundMs(percentile(sorted, 0.95)),
    maxMs: roundMs(sorted[sorted.length - 1]),
    samplesMs: sorted.map(roundMs)
  }
}

function percentile(sorted, ratio) {
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]
}

function assertPerformanceThresholds(metrics) {
  for (const [name, summary] of Object.entries(metrics.byViewport)) {
    assert(summary.cold.p95Ms < thresholdMs, `${name} cold P95 ${summary.cold.p95Ms}ms is not <${thresholdMs}ms`)
    assert(summary.warm.p95Ms < thresholdMs, `${name} warm P95 ${summary.warm.p95Ms}ms is not <${thresholdMs}ms`)
  }
  assert(metrics.cold.p95Ms < thresholdMs, `aggregate cold P95 ${metrics.cold.p95Ms}ms is not <${thresholdMs}ms`)
  assert(metrics.warm.p95Ms < thresholdMs, `aggregate warm P95 ${metrics.warm.p95Ms}ms is not <${thresholdMs}ms`)
  assert(metrics.all.p95Ms < thresholdMs, `overall P95 ${metrics.all.p95Ms}ms is not <${thresholdMs}ms`)
}

function assertPhaseContinuity(phase) {
  assert(phase.status === 'pass', `${phase.name}: phase did not pass`)
  assert(phase.before.sessionCount === 1, `${phase.name}: baseline session count is not one`)
  assert(phase.before.canonicalRuns.length === 1, `${phase.name}: baseline canonical Run count is not one`)
  assert(phase.afterSwitches.canonicalRuns.length === 1, `${phase.name}: switch duplicated canonical Run`)
  assert(phase.completed.canonicalRuns.length === 1, `${phase.name}: completion duplicated canonical Run`)
  assert(phase.requestCountAfterSwitches === phase.requestCountAfterCompletion, `${phase.name}: request count changed after switches`)
}

async function startControlledResponsesMock() {
  const requests = []
  let activeResponse
  let activeOrdinal = 0
  const server = http.createServer(async (request, response) => {
    if (request.url !== '/v1/responses' || request.method !== 'POST') {
      response.writeHead(404).end('not found')
      return
    }
    const body = await readJson(request)
    const ordinal = requests.length + 1
    requests.push({ ordinal, model: body.model, startedAt: new Date().toISOString(), finishedAt: null })
    if (activeResponse) {
      response.writeHead(409).end('only one live request is expected')
      return
    }
    activeOrdinal = ordinal
    activeResponse = response
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    writeSse(response, { type: 'response.output_text.delta', delta: firstDelta })
  })
  const port = await findFreePort(9300)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${port}`,
    waitForRequest(ordinal) {
      return waitForValue(() => requests.length, (count) => count >= ordinal, 15_000, `waiting for model request ${ordinal}`)
    },
    finish(ordinal) {
      assert(activeResponse && activeOrdinal === ordinal, `active response ${activeOrdinal} does not match ${ordinal}`)
      writeSse(activeResponse, {
        type: 'response.output_text.delta',
        delta: finalDelta
      })
      writeSse(activeResponse, {
        type: 'response.completed',
        response: {
          id: `resp_nfr_perf_001_${ordinal}`,
          output_text: `${firstDelta}${finalDelta}`,
          usage: { input_tokens: 12, output_tokens: 6, input_tokens_details: { cached_tokens: 0 } }
        }
      })
      activeResponse.end('data: [DONE]\n\n')
      requests[ordinal - 1].finishedAt = new Date().toISOString()
      activeResponse = undefined
      activeOrdinal = 0
    },
    abort() {
      activeResponse?.destroy()
      activeResponse = undefined
      activeOrdinal = 0
    }
  }
}

function writeSse(response, event) {
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function readBrowserRuntime(page) {
  return page.evaluate(() => ({
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGiB: navigator.deviceMemory ?? null,
    devicePixelRatio: window.devicePixelRatio,
    visibilityState: document.visibilityState
  }))
}

function readHardwareMetadata() {
  const processors = cpus()
  return {
    modelIdentifier: commandOutput('sysctl', ['-n', 'hw.model']),
    cpuModel: commandOutput('sysctl', ['-n', 'machdep.cpu.brand_string']) || processors[0]?.model || 'unknown',
    physicalCpuCount: numberCommandOutput('sysctl', ['-n', 'hw.physicalcpu']),
    logicalCpuCount: numberCommandOutput('sysctl', ['-n', 'hw.logicalcpu']) || processors.length,
    memoryBytes: numberCommandOutput('sysctl', ['-n', 'hw.memsize']) || totalmem(),
    osVersion: commandOutput('sw_vers', ['-productVersion']),
    osBuild: commandOutput('sw_vers', ['-buildVersion'])
  }
}

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function numberCommandOutput(command, args) {
  const value = Number(commandOutput(command, args))
  return Number.isFinite(value) ? value : null
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
    return { ...group, latestSource, outputMtimeMs, fresh: latestSource.mtimeMs <= outputMtimeMs }
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

async function captureScreenshot(page, phase, name) {
  const file = path.join(runDir, `${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  phase.screenshots.push(file)
  report.screenshots.push(file)
}

async function waitForApp(page, expectSession) {
  await page.waitForSelector('.app', { timeout: 20_000 })
  await page.waitForFunction(() => typeof window.agentDesk?.createProvider === 'function', { timeout: 15_000 })
  await page.waitForSelector('[data-experience-mode-switcher]', { visible: true, timeout: 15_000 })
  await page.waitForSelector(expectSession ? '.composer-input' : '.welcome-composer-input', {
    visible: true,
    timeout: 15_000
  })
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
    await sleep(100)
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

function summarizeProcessOutput(name, processInfo) {
  const warnings = []
  if (processInfo.stderr.trim()) warnings.push(`${name} [stderr tail]\n${processInfo.stderr.trim().slice(-2000)}`)
  if (processInfo.stdout.trim()) warnings.push(`${name} [stdout tail]\n${processInfo.stdout.trim().slice(-1000)}`)
  if (processInfo.exited.signal) warnings.push(`${name} Electron exited by signal ${processInfo.exited.signal}`)
  return warnings
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

function writeReport() {
  const json = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(runDir, 'report.json'), json)
  writeFileSync(path.join(outputRoot, 'latest.json'), json)
  writeFileSync(path.join(runDir, 'report.md'), renderMarkdown(report))
}

function renderMarkdown(value) {
  const lines = [
    '# Assistant/Studio Performance',
    '',
    `Status: ${value.status}`,
    `Requirement: NFR-PERF-001`,
    `Threshold: P95 < ${thresholdMs}ms`,
    `Reference hardware: ${value.hardware.modelIdentifier}; ${value.hardware.cpuModel}; ${formatBytes(value.hardware.memoryBytes)}`,
    `Runtime: ${value.runtime.platform}/${value.runtime.arch}; macOS ${value.hardware.osVersion}; Electron ${value.runtime.electronVersion}; Node ${value.runtime.nodeVersion}`,
    '',
    '| Viewport | Cold samples | Cold P95 | Warm samples | Warm P95 | Overall P95 | Data ready after cold |',
    '|---|---:|---:|---:|---:|---:|---:|'
  ]
  for (const phase of value.phases) {
    const metrics = phase.metrics
    lines.push(`| ${phase.name} ${phase.viewport.width}x${phase.viewport.height} | ${metrics.cold.count} | ${formatMs(metrics.cold.p95Ms)} | ${metrics.warm.count} | ${formatMs(metrics.warm.p95Ms)} | ${formatMs(metrics.all.p95Ms)} | ${formatMs(phase.studioDataReady.fromColdSwitchStartMs)} |`)
  }
  if (value.metrics) {
    lines.push(`| aggregate | ${value.metrics.cold.count} | ${formatMs(value.metrics.cold.p95Ms)} | ${value.metrics.warm.count} | ${formatMs(value.metrics.warm.p95Ms)} | ${formatMs(value.metrics.all.p95Ms)} | diagnostic only |`)
  }
  lines.push('', 'Switches ran while one local Provider response was held open. Each viewport retained exactly one session, one canonical Run, one user message, and one model request.')
  if (value.error) lines.push('', '## Error', '', '```text', value.error, '```')
  return `${lines.join('\n')}\n`
}

function cleanupTempRoot(root) {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // Cleanup failure does not replace the measured result.
  }
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

function roundMs(value) {
  return Math.round(value * 100) / 100
}

function formatMs(value) {
  return `${Number(value).toFixed(2)}ms`
}

function formatBytes(value) {
  return `${(Number(value) / 1024 / 1024 / 1024).toFixed(1)} GiB`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
