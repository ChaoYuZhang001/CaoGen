#!/usr/bin/env node
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
const outputRoot = path.join(repoRoot, 'test-results', 'assistant-studio-live-switch')
const runDir = path.join(outputRoot, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-assistant-studio-live-switch-'))
const userDataDir = path.join(tempRoot, 'userData')
const projectDir = path.join(tempRoot, 'project')
const sourceOutDir = path.join(repoRoot, 'out')
const isolatedOutDir = path.join(runDir, 'app', 'out')
const mainEntry = path.join(isolatedOutDir, 'main', 'index.js')
const electronBin = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const firstDelta = 'live-switch-alpha '
const finalDelta = 'live-switch-omega'
const duplicateSendError = '上一轮仍在运行,请等待完成或中断后再发送。'

assert(existsSync(electronBin), 'Electron binary not found. Run npm install first.')
for (const entry of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
  assert(existsSync(path.join(sourceOutDir, entry)), `Built app entry missing: out/${entry}. Run npm run build first.`)
}
const sourceBuildBinding = inspectSourceBuildBinding()

mkdirSync(runDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
mkdirSync(projectDir, { recursive: true })
writeFileSync(path.join(projectDir, 'README.md'), '# Assistant Studio live switch E2E\n', 'utf8')

const report = {
  schemaVersion: 1,
  runId,
  runDir,
  requirement: 'required',
  requirementIds: ['EXP-003A'],
  packageVersion: packageJson.version,
  gitCommit: '',
  worktreeClean: false,
  statusEntryCount: 0,
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  electronVersion: electronPackage.version,
  sourceBuildBinding: { status: sourceBuildBinding.status, initial: sourceBuildBinding },
  checks: [],
  screenshots: [],
  requests: [],
  expectedDiagnostics: [],
  warnings: [],
  coverage: {
    verified: [
      'running Responses stream survives repeated Assistant/Studio projection switches',
      'session/runtime/provider/model identity remains stable',
      'projection switches do not restart the session or resend the model request',
      'duplicate sends remain nonfatal and cannot open a model-switch policy bypass',
      'running sessions reject model changes through the sessions:setModel IPC policy',
      'running model selector is disabled in Studio',
      'stream deltas remain ordered and are applied exactly once'
    ],
    explicitlyNotVerified: [
      'cross-provider or cross-protocol hot switching',
      'approval and notification continuity',
      'failure and crash recovery continuity'
    ]
  }
}
if (sourceBuildBinding.status !== 'pass') {
  report.status = 'fail'
  report.error = staleBuildMessage(sourceBuildBinding)
  const reportText = JSON.stringify(report, null, 2)
  writeFileSync(path.join(runDir, 'report.json'), reportText)
  writeFileSync(path.join(outputRoot, 'latest.json'), reportText)
  cleanupTempRoot(tempRoot)
  throw new Error(report.error)
}
copyBuiltApp()

const mock = await startControlledResponsesMock()
const remotePort = await findFreePort(9960)
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
const watchdog = setTimeout(() => {
  report.warnings.push('assistant/studio live switch E2E exceeded its 120 second timeout')
  signalElectronTree(electron.pid, 'SIGKILL')
}, 120_000)

let stdout = ''
let stderr = ''
let browser
let page
let sessionId = ''
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

  await check('seed one fixed runtime session without sending a request', async () => {
    const session = await page.evaluate(async ({ cwd, baseUrl }) => {
      const provider = await window.agentDesk.createProvider({
        name: 'Live Switch Mock',
        baseUrl,
        token: 'test-only',
        models: ['live-model-primary', 'live-model-backup'],
        openaiProtocol: 'responses'
      })
      return window.agentDesk.createSession({
        cwd,
        engine: 'openai',
        providerId: provider.id,
        model: 'live-model-primary',
        routingScope: 'fixed',
        permissionMode: 'default',
        isolated: false,
        title: 'Live switch session'
      })
    }, { cwd: projectDir, baseUrl: mock.baseUrl })
    sessionId = session.id
    await waitForValue(
      () => readRuntimeSnapshot(page, sessionId),
      (snapshot) => Boolean(snapshot.meta?.sdkSessionId && snapshot.meta.status === 'idle'),
      15_000,
      'waiting for seeded session initialization'
    )
    assert(mock.requests.length === 0, 'session initialization unexpectedly called the model')
  })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForApp(page, true)
  await installSessionEventProbe(page, sessionId)

  await check('running stream begins once with a stable runtime identity', async () => {
    await page.evaluate((id) => window.agentDesk.sendMessage(id, {
      text: 'keep this request running while projections switch',
      messageId: 'live-switch-message'
    }), sessionId)
    await mock.started
    baseline = await waitForValue(
      () => readRuntimeSnapshot(page, sessionId),
      (snapshot) => snapshot.meta?.status === 'running' && snapshot.deltaText === firstDelta,
      15_000,
      'waiting for first live stream delta'
    )
    assert(baseline.count === 1, `expected one active session, got ${baseline.count}`)
    assert(baseline.userMessageCount === 1, `expected one user message, got ${baseline.userMessageCount}`)
    assert(baseline.turnResultCount === 0, 'turn completed before projection switching')
    assert(baseline.initCount === 0, `active request unexpectedly restarted the session: initCount=${baseline.initCount}`)
    assert(mock.requests.length === 1, `expected one model request, got ${mock.requests.length}`)
    assert(mock.requests[0].body?.model === 'live-model-primary', 'request used the wrong model')
    await screenshot(page, '01-running-assistant')
  })

  await check('duplicate send stays nonfatal and model change remains rejected', async () => {
    const before = await readRuntimeSnapshot(page, sessionId)
    await page.evaluate((id) => window.agentDesk.sendMessage(id, {
      text: 'this duplicate request must be rejected without replacing the active turn',
      messageId: 'live-switch-duplicate-message'
    }), sessionId)
    const duplicate = await waitForValue(
      () => readRuntimeSnapshot(page, sessionId),
      (snapshot) => snapshot.duplicateSendRejectionCount === before.duplicateSendRejectionCount + 1,
      10_000,
      'waiting for nonfatal duplicate-send rejection'
    )
    assertRuntimeSnapshotStable(before, duplicate, 'duplicate send rejection')
    assert(duplicate.meta.lastError === duplicateSendError, `duplicate rejection diagnostic changed: ${duplicate.meta.lastError}`)
    assert(duplicate.liveEventCount === before.liveEventCount + 1, 'duplicate send emitted unexpected session events')
    assert(duplicate.transcriptCount === before.transcriptCount, 'duplicate send mutated the durable transcript')
    assert(mock.requests.length === 1, `duplicate send created ${mock.requests.length} model requests`)
    await page.waitForFunction(
      (message) => Array.from(document.querySelectorAll('.notice-error')).some((element) => element.textContent?.includes(message)),
      { timeout: 10_000 },
      duplicateSendError
    )

    const rejection = await page.evaluate(async ({ id, model }) => {
      try {
        await window.agentDesk.setModel(id, model)
        return { rejected: false, message: '' }
      } catch (error) {
        return {
          rejected: true,
          code: typeof error?.code === 'string' ? error.code : '',
          message: error instanceof Error ? error.message : String(error)
        }
      }
    }, { id: sessionId, model: 'live-model-backup' })
    assert(rejection.rejected, 'running model change unexpectedly succeeded')
    assert(
      rejection.code === 'SESSION_MODEL_SWITCH_BLOCKED' ||
        /任务正在运行.*阻止切换模型|SESSION_MODEL_SWITCH_BLOCKED/.test(rejection.message),
      `running model change returned an unexpected error: ${rejection.message}`
    )
    const after = await readRuntimeSnapshot(page, sessionId)
    assertRuntimeSnapshotStable(duplicate, after, 'rejected running model change')
    assert(after.metaCount === duplicate.metaCount, 'rejected model change emitted transcript meta mutation')
    assert(after.liveEventCount === duplicate.liveEventCount, 'rejected model change emitted a session event')
    assert(after.transcriptCount === duplicate.transcriptCount, 'rejected model change mutated the durable transcript')
    assert(mock.requests.length === 1, `rejected model change resent the request ${mock.requests.length} times`)
    await page.$eval('[data-session-model-select="true"]', (element, model) => {
      element.disabled = false
      element.value = model
      element.dispatchEvent(new Event('change', { bubbles: true }))
    }, 'live-model-backup')
    await page.waitForFunction(
      () => document.querySelector('.session-model-error')?.textContent?.includes('阻止切换模型'),
      { timeout: 10_000 }
    )
    await page.$eval('[data-session-model-select="true"]', (element) => { element.disabled = true })
    const afterUiRejection = await readRuntimeSnapshot(page, sessionId)
    assertRuntimeSnapshotStable(after, afterUiRejection, 'visible UI model-switch rejection')
    assert(mock.requests.length === 1, 'visible UI rejection resent the active request')
    report.duplicateSendRejection = {
      message: duplicateSendError,
      status: duplicate.meta.status,
      eventCount: duplicate.duplicateSendRejectionCount
    }
    report.modelSwitchRejection = rejection
    report.uiModelSwitchRejectionVisible = true
    baseline = afterUiRejection
  })

  await check('ten projection roundtrips do not restart or reconfigure the active runtime', async () => {
    for (let cycle = 0; cycle < 10; cycle += 1) {
      await clickMode(page, 'studio')
      await clickStudioSurface(page, 'workspace')
      await assertRuntimeStable(page, sessionId, baseline, `cycle ${cycle + 1} Studio workspace`, mock.requests.length)

      await clickStudioSurface(page, 'session')
      const modelControl = await page.$eval('[data-session-model-select="true"]', (element) => ({
        disabled: element.disabled,
        value: element.value
      }))
      assert(modelControl.disabled, `cycle ${cycle + 1}: running model selector was enabled`)
      assert(modelControl.value === baseline.meta.model, `cycle ${cycle + 1}: model control changed value`)
      await assertRuntimeStable(page, sessionId, baseline, `cycle ${cycle + 1} Studio session`, mock.requests.length)

      await clickMode(page, 'assistant')
      await assertRuntimeStable(page, sessionId, baseline, `cycle ${cycle + 1} Assistant`, mock.requests.length)
    }
    await clickMode(page, 'studio')
    await clickStudioSurface(page, 'session')
    await screenshot(page, '02-running-studio-session')
    await clickMode(page, 'assistant')
  })

  await check('completion preserves exact stream order and single request identity', async () => {
    mock.pushDelta(finalDelta)
    mock.finish()
    const completed = await waitForValue(
      () => readRuntimeSnapshot(page, sessionId),
      (snapshot) => snapshot.meta?.status === 'idle' && snapshot.turnResultCount === 1,
      15_000,
      'waiting for live request completion'
    )
    assertIdentityEqual(baseline, completed, 'completed runtime')
    assert(completed.deltaText === `${firstDelta}${finalDelta}`, `stream delta mismatch: ${completed.deltaText}`)
    assert(
      JSON.stringify(completed.deltaParts) === JSON.stringify([firstDelta, finalDelta]),
      `stream delta order/duplication mismatch: ${JSON.stringify(completed.deltaParts)}`
    )
    assert(completed.deltaEventIds.length === new Set(completed.deltaEventIds).size, 'stream delta event id duplicated')
    assert(isStrictlyIncreasing(completed.deltaSeqs), `stream delta sequence is not increasing: ${completed.deltaSeqs}`)
    assert(completed.userMessageCount === 1, `user message duplicated: ${completed.userMessageCount}`)
    assert(completed.turnResultCount === 1, `turn result count mismatch: ${completed.turnResultCount}`)
    assert(completed.initCount === baseline.initCount, `session restarted during switching: initCount=${completed.initCount}`)
    assert(mock.requests.length === 1, `projection switching resent the request ${mock.requests.length} times`)
    assert(mock.requests[0].body?.model === baseline.meta.model, 'request model changed during switching')
    await screenshot(page, '03-completed-assistant')
  })
} catch (error) {
  report.error = error instanceof Error ? error.stack || error.message : String(error)
  process.exitCode = 1
  if (page) await screenshot(page, 'failure').catch(() => undefined)
} finally {
  clearTimeout(watchdog)
  mock.abort()
  if (browser) await browser.disconnect().catch(() => undefined)
  const exited = await terminate(electron)
  await closeServer(mock.server)
  const git = readGitState()
  report.gitCommit = git.commit
  report.worktreeClean = git.worktreeClean
  report.statusEntryCount = git.statusEntryCount
  report.requests = mock.requests.map(({ authorization: _authorization, ...request }) => request)
  const finalSourceBuildBinding = inspectSourceBuildBinding()
  report.sourceBuildBinding.final = finalSourceBuildBinding
  report.sourceBuildBinding.status = finalSourceBuildBinding.status
  if (finalSourceBuildBinding.status !== 'pass' && !report.error) {
    report.error = `Source/build binding changed during E2E. ${staleBuildMessage(finalSourceBuildBinding)}`
  }
  report.releaseBinding = {
    requirement: report.requirement,
    packageVersion: report.packageVersion,
    git,
    platform: report.platform,
    arch: report.arch,
    nodeVersion: report.nodeVersion,
    electronVersion: report.electronVersion
  }
  const processDiagnostics = extractExpectedProcessDiagnostics(stderr)
  report.expectedDiagnostics.push(...processDiagnostics.expected)
  report.warnings.push(...summarizeProcessOutput(stdout, processDiagnostics.stderr, exited))
  report.status = report.checks.every((item) => item.status === 'pass') && !report.error ? 'pass' : 'fail'
  const reportText = JSON.stringify(report, null, 2)
  writeFileSync(path.join(runDir, 'report.json'), reportText)
  writeFileSync(path.join(outputRoot, 'latest.json'), reportText)
  cleanupTempRoot(tempRoot)
}

if (report.status !== 'pass') {
  console.error(`assistant/studio live switch E2E failed: ${report.error || 'check failure'}`)
  process.exitCode = 1
} else {
  console.log(`assistant/studio live switch E2E ok: ${runDir}`)
  console.log(`${report.checks.length}/${report.checks.length} checks passed; ${report.screenshots.length} screenshots captured`)
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

async function assertRuntimeStable(targetPage, id, expected, label, requestCount) {
  const current = await readRuntimeSnapshot(targetPage, id)
  assertRuntimeSnapshotStable(expected, current, label)
  assert(current.liveEventCount === expected.liveEventCount, `${label}: live event count changed`)
  assert(requestCount === 1, `${label}: request count changed to ${requestCount}`)
}

function assertRuntimeSnapshotStable(expected, current, label) {
  assertIdentityEqual(expected, current, label)
  assert(current.meta.status === 'running', `${label}: runtime status changed to ${current.meta.status}`)
  assert(current.userMessageCount === expected.userMessageCount, `${label}: user message count changed`)
  assert(current.turnResultCount === expected.turnResultCount, `${label}: turn result count changed`)
  assert(current.initCount === expected.initCount, `${label}: init count changed`)
  assert(current.metaCount === expected.metaCount, `${label}: meta event count changed`)
  assert(current.deltaText === expected.deltaText, `${label}: held stream changed unexpectedly`)
}

function assertIdentityEqual(expected, current, label) {
  assert(current.count === expected.count, `${label}: session count changed`)
  assert(JSON.stringify(current.ids) === JSON.stringify(expected.ids), `${label}: session ids changed`)
  for (const key of ['id', 'sdkSessionId', 'engine', 'providerId', 'model', 'routingScope', 'cwd']) {
    assert(current.meta?.[key] === expected.meta?.[key], `${label}: ${key} changed`)
  }
}

async function readRuntimeSnapshot(targetPage, id) {
  return targetPage.evaluate(async ({ sessionIdValue, duplicateSendErrorValue }) => {
    const sessions = await window.agentDesk.listSessions()
    const transcript = await window.agentDesk.getTranscript(sessionIdValue)
    const meta = sessions.find((item) => item.id === sessionIdValue)
    const events = transcript.map((entry) => entry.event)
    const liveEntries = Array.isArray(window.__assistantStudioLiveSwitchEvents)
      ? window.__assistantStudioLiveSwitchEvents
      : []
    const liveEvents = liveEntries.map((entry) => entry.event)
    const deltaEntries = liveEntries.filter((entry) => entry.event?.kind === 'text-delta')
    return {
      count: sessions.length,
      ids: sessions.map((item) => item.id).sort(),
      meta: meta ? {
        id: meta.id,
        sdkSessionId: meta.sdkSessionId,
        engine: meta.engine,
        providerId: meta.providerId,
        model: meta.model,
        routingScope: meta.routingScope,
        cwd: meta.cwd,
        status: meta.status,
        lastError: meta.lastError
      } : null,
      transcriptCount: transcript.length,
      liveEventCount: liveEntries.length,
      initCount: liveEvents.filter((event) => event.kind === 'init').length,
      metaCount: liveEvents.filter((event) => event.kind === 'meta').length,
      duplicateSendRejectionCount: liveEvents.filter((event) =>
        event.kind === 'status' && event.status === 'running' && event.error === duplicateSendErrorValue
      ).length,
      userMessageCount: events.filter((event) => event.kind === 'user-message').length,
      turnResultCount: events.filter((event) => event.kind === 'turn-result').length,
      deltaText: deltaEntries.map((entry) => entry.event.text).join(''),
      deltaParts: deltaEntries.map((entry) => entry.event.text),
      deltaSeqs: deltaEntries.map((entry) => entry.seq),
      deltaEventIds: deltaEntries.map((entry) => entry.eventId)
    }
  }, { sessionIdValue: id, duplicateSendErrorValue: duplicateSendError })
}

async function installSessionEventProbe(targetPage, id) {
  await targetPage.evaluate((sessionIdValue) => {
    window.__assistantStudioLiveSwitchUnsubscribe?.()
    window.__assistantStudioLiveSwitchEvents = []
    window.__assistantStudioLiveSwitchUnsubscribe = window.agentDesk.onSessionEvent(
      (eventSessionId, event, seq, eventId) => {
        if (eventSessionId !== sessionIdValue) return
        window.__assistantStudioLiveSwitchEvents.push({ event, seq, eventId: eventId ?? '' })
      }
    )
  }, id)
}

function isStrictlyIncreasing(values) {
  return values.every((value, index) => index === 0 || value > values[index - 1])
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
  if (mode === 'studio') {
    await targetPage.waitForSelector('[data-studio-view]', { timeout: 10_000 })
  }
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
  await targetPage.waitForFunction(() => typeof window.agentDesk?.createProvider === 'function', { timeout: 15_000 })
  await targetPage.waitForSelector('[data-experience-mode-switcher]', { visible: true, timeout: 15_000 })
  await targetPage.waitForSelector(expectSession ? '.composer-input' : '.welcome-composer-input', {
    visible: true,
    timeout: 15_000
  })
}

async function startControlledResponsesMock() {
  const requests = []
  let activeResponse
  let startedResolve
  const started = new Promise((resolve) => { startedResolve = resolve })
  const server = http.createServer(async (request, response) => {
    if (request.url !== '/v1/responses' || request.method !== 'POST') {
      response.writeHead(404).end('not found')
      return
    }
    const body = await readJson(request)
    requests.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.authorization || '',
      body
    })
    if (activeResponse) {
      response.writeHead(409).end('only one live request is expected')
      return
    }
    activeResponse = response
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    writeSse(response, { type: 'response.output_text.delta', delta: firstDelta })
    startedResolve()
  })
  const port = await findFreePort(9060)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return {
    server,
    requests,
    started,
    baseUrl: `http://127.0.0.1:${port}`,
    pushDelta(text) {
      assert(activeResponse, 'live response is not active')
      writeSse(activeResponse, { type: 'response.output_text.delta', delta: text })
    },
    finish() {
      assert(activeResponse, 'live response is not active')
      writeSse(activeResponse, {
        type: 'response.completed',
        response: {
          id: `resp_live_switch_${Date.now()}`,
          output_text: `${firstDelta}${finalDelta}`,
          usage: { input_tokens: 16, output_tokens: 8, input_tokens_details: { cached_tokens: 0 } }
        }
      })
      activeResponse.end('data: [DONE]\n\n')
      activeResponse = undefined
    },
    abort() {
      activeResponse?.destroy()
      activeResponse = undefined
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

function copyBuiltApp() {
  rmSync(isolatedOutDir, { recursive: true, force: true })
  mkdirSync(isolatedOutDir, { recursive: true })
  for (const directory of ['main', 'preload', 'renderer']) {
    cpSync(path.join(sourceOutDir, directory), path.join(isolatedOutDir, directory), { recursive: true })
  }
}

function inspectSourceBuildBinding() {
  const groups = [
    {
      target: 'main',
      output: 'out/main/index.js',
      sourceRoots: [
        'src/main/index.ts',
        'src/main/ipc.ts',
        'src/main/ipc/session-model-switch-handler.ts',
        'src/main/openaiEngine.ts',
        'src/main/providers.ts',
        'src/main/sessionManager.ts',
        'src/main/session-model-switch-policy.ts',
        'src/main/transcript.ts',
        'src/shared'
      ]
    },
    { target: 'preload', output: 'out/preload/index.js', sourceRoots: ['src/preload', 'src/shared'] },
    { target: 'renderer', output: 'out/renderer/index.html', sourceRoots: ['src/renderer', 'src/shared'] }
  ].map((group) => {
    const latestSource = newestSourceFile(group.sourceRoots)
    const outputMtimeMs = statSync(path.join(repoRoot, group.output)).mtimeMs
    return {
      ...group,
      latestSource: { path: latestSource.path, mtimeMs: latestSource.mtimeMs },
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

function extractExpectedProcessDiagnostics(err) {
  const expected = []
  const stderr = err.replace(
    /Error occurred in handler for 'sessions:setModel': SessionModelSwitchPolicyError: 任务正在运行，已阻止切换模型；请先等待完成或中断任务。\r?\n[\s\S]*?\r?\n  code: 'SESSION_MODEL_SWITCH_BLOCKED'\r?\n\}\r?\n?/g,
    () => {
      expected.push({
        kind: 'expected-ipc-rejection',
        handler: 'sessions:setModel',
        code: 'SESSION_MODEL_SWITCH_BLOCKED',
        message: '任务正在运行，已阻止切换模型；请先等待完成或中断任务。'
      })
      return ''
    }
  )
  return { stderr, expected }
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
    // Cleanup failure does not replace the E2E result.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
