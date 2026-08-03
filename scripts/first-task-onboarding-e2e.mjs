#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const read = (path) => readFile(resolve(root, path), 'utf8')
const onboardingPath = resolve(root, 'src/renderer/src/components/experience/first-task-onboarding.ts')
const tempDir = await mkdtemp(join(tmpdir(), 'caogen-first-task-onboarding-'))
const bundlePath = join(tempDir, 'first-task-onboarding.mjs')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = resolve(root, 'test-results', 'first-task-onboarding', runId)
const checks = []
const privacyCanaries = [
  ['private', 'prompt', 'canary'].join('-'),
  ['private', 'path', 'canary'].join('-'),
  ['private', 'token', 'canary'].join('-'),
  ['private', 'provider', 'canary'].join('-')
]

const storage = new Map()
const runtimeCalls = { snapshot: 0, send: 0, start: 0 }
globalThis.window = {
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value)
  },
  dispatchEvent: () => true,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  agentDesk: {
    getStudioResultSnapshot: async () => {
      runtimeCalls.snapshot += 1
      return { state: 'unbound' }
    },
    sendMessage: async () => { runtimeCalls.send += 1 },
    startSessionWithPrompt: async () => { runtimeCalls.start += 1 }
  }
}
globalThis.CustomEvent = class CustomEvent {
  constructor(type) { this.type = type }
}

let onboarding
await check('production onboarding helper bundle loads', async () => {
  await build({
    entryPoints: [onboardingPath],
    outfile: bundlePath,
    bundle: true,
    format: 'esm',
    platform: 'node',
    plugins: [{
      name: 'onboarding-test-store',
      setup(builder) {
        builder.onResolve({ filter: /^\.\.\/\.\.\/store$/ }, () => ({ path: 'test-store', namespace: 'onboarding-test' }))
        builder.onLoad({ filter: /.*/, namespace: 'onboarding-test' }, () => ({
          contents: 'export const useStore = Object.assign(() => undefined, { getState: () => ({}) })',
          loader: 'js'
        }))
      }
    }]
  })
  onboarding = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`)
})

if (onboarding) {
  const {
    FIRST_TASK_ONBOARDING_STORAGE_KEY,
    createFirstTaskSubmissionGate,
    deriveFirstTaskOnboardingStatus,
    deriveFirstTaskProgress,
    isActiveFirstTaskCandidate,
    isFirstTaskComplete,
    patchFirstTaskOnboardingRecord,
    readFirstTaskOnboardingRecord,
    recentTopLevelSessionIds,
    restartFirstTaskOnboardingCandidate,
    runFirstTaskSubmissionExclusive
  } = onboarding

  const emptyRecord = () => ({ schemaVersion: 1, artifactLocationIds: [] })
  const acceptance = (status, extra = {}) => ({ id: status, status, ...extra })
  const snapshot = ({ state = 'ready', artifacts = [], acceptances = [] } = {}) => ({ state, artifacts, acceptances })
  const availableArtifact = (id = 'location-1') => ({
    locations: [{ id, availability: 'available' }]
  })

  await check('versioned codec fails closed and merges first-write fields', () => {
    storage.set(FIRST_TASK_ONBOARDING_STORAGE_KEY, '{damaged json')
    assert.deepEqual(readFirstTaskOnboardingRecord(), emptyRecord())
    storage.set(FIRST_TASK_ONBOARDING_STORAGE_KEY, JSON.stringify({ schemaVersion: 99, completedAt: 1 }))
    assert.deepEqual(readFirstTaskOnboardingRecord(), emptyRecord())

    storage.clear()
    patchFirstTaskOnboardingRecord({ candidateSessionId: 'first', presetKey: 'review', startedAt: 10, artifactLocationIds: ['a'] })
    const firstWrite = patchFirstTaskOnboardingRecord({
      candidateSessionId: 'second', presetKey: 'plan', startedAt: 20, artifactLocationIds: ['a', 'b']
    })
    assert.equal(firstWrite.candidateSessionId, 'first')
    assert.equal(firstWrite.presetKey, 'review')
    assert.equal(firstWrite.startedAt, 10)
    assert.deepEqual(firstWrite.artifactLocationIds, ['a', 'b'])
  })

  await check('completion requires an opened available Artifact and resolved Acceptance', () => {
    const opened = { ...emptyRecord(), artifactLocationIds: ['location-1'] }
    assert.equal(isFirstTaskComplete(snapshot({ artifacts: [availableArtifact()], acceptances: [] }), opened), false)
    assert.equal(isFirstTaskComplete(snapshot({ state: 'loading', artifacts: [availableArtifact()], acceptances: [acceptance('passed')] }), opened), false)
    assert.equal(isFirstTaskComplete(snapshot({ artifacts: [availableArtifact('other')], acceptances: [acceptance('passed')] }), opened), false)
    assert.equal(isFirstTaskComplete(snapshot({ artifacts: [availableArtifact()], acceptances: [acceptance('pending')] }), opened), false)
    assert.equal(isFirstTaskComplete(snapshot({ artifacts: [availableArtifact()], acceptances: [acceptance('failed')] }), opened), false)
    assert.equal(isFirstTaskComplete(snapshot({ artifacts: [availableArtifact()], acceptances: [acceptance('waived')] }), opened), false)
    assert.equal(isFirstTaskComplete(snapshot({
      artifacts: [availableArtifact()],
      acceptances: [acceptance('waived', { waiverReason: ' ', waivedBy: 'qa' })]
    }), opened), false)
    assert.equal(isFirstTaskComplete(snapshot({
      artifacts: [availableArtifact()],
      acceptances: [acceptance('waived', { waiverReason: 'accepted risk', waivedBy: 'qa' })]
    }), opened), true)
    assert.equal(isFirstTaskComplete(snapshot({
      artifacts: [availableArtifact()],
      acceptances: [acceptance('passed'), acceptance('waived', { waiverReason: 'accepted risk', waivedBy: 'qa' })]
    }), opened), true)
  })

  await check('component-independent submission gate rejects the concurrent loser', async () => {
    let release
    const held = new Promise((resolvePromise) => { release = resolvePromise })
    let createCount = 0
    let sendCount = 0
    const winner = runFirstTaskSubmissionExclusive(async () => {
      createCount += 1
      sendCount += 1
      await held
      return 'winner'
    })
    const loser = await runFirstTaskSubmissionExclusive(async () => {
      createCount += 1
      sendCount += 1
      return 'loser'
    })
    assert.deepEqual(loser, { started: false })
    assert.equal(createCount, 1)
    assert.equal(sendCount, 1)
    release()
    assert.deepEqual(await winner, { started: true, value: 'winner' })
    const later = await runFirstTaskSubmissionExclusive(async () => {
      createCount += 1
      sendCount += 1
      return 'later'
    })
    assert.deepEqual(later, { started: true, value: 'later' })
    assert.equal(createCount, 2)
    assert.equal(sendCount, 2)
  })

  await check('submission gate releases after rejection', async () => {
    const gate = createFirstTaskSubmissionGate()
    await assert.rejects(gate.run(async () => { throw new Error('expected submission failure') }), /expected submission failure/)
    assert.equal(gate.isPending(), false)
    assert.deepEqual(await gate.run(async () => 'retry'), { started: true, value: 'retry' })
  })

  await check('six-state projection preserves running work across Provider hydration', () => {
    const candidate = { ...emptyRecord(), candidateSessionId: 'session-1' }
    assert.equal(deriveFirstTaskOnboardingStatus({
      record: candidate,
      providersHydrated: false,
      computeAvailable: false,
      activatingLocal: false,
      sessionStatus: 'running'
    }), 'running')
    assert.equal(deriveFirstTaskOnboardingStatus({
      record: candidate,
      providersHydrated: true,
      computeAvailable: true,
      activatingLocal: false,
      sessionStatus: 'error'
    }), 'ready_to_start')
    assert.equal(deriveFirstTaskOnboardingStatus({
      record: candidate,
      providersHydrated: true,
      computeAvailable: true,
      activatingLocal: false,
      sessionStatus: 'idle'
    }), 'reviewing_result')
    assert.equal(deriveFirstTaskOnboardingStatus({
      record: emptyRecord(),
      providersHydrated: false,
      computeAvailable: false,
      activatingLocal: false
    }), 'activating_local')
    assert.equal(deriveFirstTaskOnboardingStatus({
      record: emptyRecord(),
      providersHydrated: true,
      computeAvailable: false,
      activatingLocal: false
    }), 'needs_compute')
    assert.equal(deriveFirstTaskOnboardingStatus({
      record: emptyRecord(),
      providersHydrated: true,
      computeAvailable: true,
      activatingLocal: false
    }), 'ready_to_start')
    assert.equal(deriveFirstTaskOnboardingStatus({
      record: { ...emptyRecord(), completedAt: 1 },
      providersHydrated: false,
      computeAvailable: false,
      activatingLocal: true
    }), 'completed')
  })

  await check('four-step progress is derived from onboarding status and opened Artifact state', () => {
    assert.deepEqual(deriveFirstTaskProgress('needs_compute', emptyRecord()), {
      compute: 'active', task: 'pending', result: 'pending', acceptance: 'pending'
    })
    assert.deepEqual(deriveFirstTaskProgress('running', emptyRecord()), {
      compute: 'done', task: 'active', result: 'pending', acceptance: 'pending'
    })
    assert.deepEqual(deriveFirstTaskProgress('reviewing_result', emptyRecord()), {
      compute: 'done', task: 'done', result: 'active', acceptance: 'pending'
    })
    assert.deepEqual(deriveFirstTaskProgress('reviewing_result', { ...emptyRecord(), artifactLocationIds: ['location-1'] }), {
      compute: 'done', task: 'done', result: 'done', acceptance: 'active'
    })
    assert.deepEqual(deriveFirstTaskProgress('completed', emptyRecord()), {
      compute: 'done', task: 'done', result: 'done', acceptance: 'done'
    })
  })

  await check('failed candidate restart uses compare-and-reset without Session mutation', () => {
    const sessions = { first: { meta: { id: 'first', status: 'error' } } }
    const sessionsBefore = JSON.stringify(sessions)
    storage.clear()
    patchFirstTaskOnboardingRecord({
      candidateSessionId: 'first',
      presetKey: 'review',
      startedAt: 10,
      resultOpenedAt: 20,
      autoOpenedResultSessionId: 'first',
      artifactLocationIds: ['location-1']
    })
    assert.equal(restartFirstTaskOnboardingCandidate('stale').candidateSessionId, 'first')
    assert.deepEqual(restartFirstTaskOnboardingCandidate('first'), emptyRecord())
    assert.equal(JSON.stringify(sessions), sessionsBefore)

    storage.clear()
    patchFirstTaskOnboardingRecord({ candidateSessionId: 'completed', completedAt: 30 })
    assert.equal(restartFirstTaskOnboardingCandidate('completed').candidateSessionId, 'completed')
  })

  await check('stale Result callbacks cannot reclaim a restarted or completed candidate', () => {
    const active = { ...emptyRecord(), candidateSessionId: 'first', startedAt: 10 }
    assert.equal(isActiveFirstTaskCandidate(active, 'first'), true)
    assert.equal(isActiveFirstTaskCandidate(active, 'stale'), false)
    assert.equal(isActiveFirstTaskCandidate(emptyRecord(), 'first'), false)
    assert.equal(isActiveFirstTaskCandidate({ ...active, completedAt: 20 }, 'first'), false)

    storage.clear()
    patchFirstTaskOnboardingRecord(active)
    restartFirstTaskOnboardingCandidate('first')
    assert.equal(isActiveFirstTaskCandidate(readFirstTaskOnboardingRecord(), 'first'), false)
  })

  await check('running reload recovers projection without create or send side effects', async () => {
    storage.clear()
    patchFirstTaskOnboardingRecord({ candidateSessionId: 'running-session', presetKey: 'custom', startedAt: 10 })
    const before = { ...runtimeCalls }
    const reloaded = await import(`${pathToFileURL(bundlePath).href}?reload=${Date.now()}`)
    const record = reloaded.readFirstTaskOnboardingRecord()
    assert.equal(reloaded.deriveFirstTaskOnboardingStatus({
      record,
      providersHydrated: false,
      computeAvailable: false,
      activatingLocal: false,
      sessionStatus: 'running'
    }), 'running')
    assert.deepEqual(runtimeCalls, before)
  })

  await check('onboarding storage and report ledger exclude sensitive draft fields', () => {
    storage.clear()
    patchFirstTaskOnboardingRecord({
      candidateSessionId: 'privacy-session',
      presetKey: 'custom',
      startedAt: 10,
      prompt: privacyCanaries[0],
      cwd: privacyCanaries[1],
      token: privacyCanaries[2],
      provider: privacyCanaries[3]
    })
    const persisted = storage.get(FIRST_TASK_ONBOARDING_STORAGE_KEY) ?? ''
    assert.equal(privacyCanaries.some((marker) => persisted.includes(marker)), false, 'onboarding storage leaked a private draft field')
  })

  await check('historical migration scans recent top-level Sessions deterministically', () => {
    const session = (id, createdAt, parentSessionId) => ({ meta: { id, createdAt, parentSessionId } })
    const sessions = {
      old: session('old', 100),
      newest: session('newest', 400),
      tiedFirst: session('tiedFirst', 300),
      child: session('child', 500, 'newest'),
      tiedSecond: session('tiedSecond', 300)
    }
    assert.deepEqual(
      recentTopLevelSessionIds(['old', 'tiedFirst', 'child', 'newest', 'tiedSecond'], sessions, 3),
      ['newest', 'tiedFirst', 'tiedSecond']
    )
  })

  await check('Welcome and Workbench consume the production gate, progress, and scoped recovery', async () => {
    const onboardingSource = await read('src/renderer/src/components/experience/first-task-onboarding.ts')
    const welcome = await read('src/renderer/src/components/WelcomeView.tsx')
    const workbench = await read('src/renderer/src/components/workbench/WorkbenchRoot.tsx')
    const appList = await read('src/renderer/src/components/AppListView.tsx')
    const i18n = await read('src/renderer/src/i18n.ts')
    assert.match(welcome, /runFirstTaskSubmissionExclusive\(async \(\) =>/)
    assert.doesNotMatch(welcome, /submitPending/)
    assert.match(welcome, /deriveFirstTaskOnboardingStatus/)
    assert.match(welcome, /deriveFirstTaskProgress/)
    assert.match(welcome, /data-first-task-status=\{onboardingStatus\}/)
    assert.match(workbench, /activeId === onboardingRecord\.candidateSessionId/)
    assert.match(workbench, /candidateSession\?\.meta\.status === 'error'/)
    assert.match(workbench, /restartFirstTaskOnboardingCandidate\(activeId\)[\s\S]*setShowNewSession\(true\)/)
    assert.doesNotMatch(onboardingSource.slice(
      onboardingSource.indexOf('export function restartFirstTaskOnboardingCandidate'),
      onboardingSource.indexOf('export function isFirstTaskComplete')
    ), /closeSession|sendMessage|startSessionWithPrompt/)
    assert.match(appList, /useFirstTaskOnboardingLifecycle\(\)/)
    for (const key of ['firstTaskFailedTitle', 'firstTaskFailedDetail', 'firstTaskRestart']) assert.match(i18n, new RegExp(key))
  })

  await check('store returns and binds the deterministic created Session id', async () => {
    const store = await read('src/renderer/src/store.ts')
    const welcome = await read('src/renderer/src/components/WelcomeView.tsx')
    assert.match(store, /createSession\(opts: CreateSessionOptions\): Promise<string>/)
    assert.match(store, /startSessionWithPrompt\(opts: CreateSessionOptions, prompt: string\): Promise<string>/)
    assert.match(store, /sendMessage\(input: string \| SendMessagePayload, sessionId\?: string\): Promise<void>/)

    const sessionCreation = store.slice(
      store.indexOf('  async createSession(opts) {'),
      store.indexOf('  async recoverTaskSnapshot(snapshotId) {')
    )
    assert.match(sessionCreation, /return meta\.id/)
    assert.match(sessionCreation, /const sessionId = await get\(\)\.createSession\(opts\)/)
    assert.match(sessionCreation, /if \(text\) await get\(\)\.sendMessage\(text, sessionId\)/)
    assert.match(sessionCreation, /return sessionId/)
    const sendMessage = store.slice(
      store.indexOf('  async sendMessage(input, sessionId) {'),
      store.indexOf('  async sendQuickbarClipboard(options) {')
    )
    assert.match(sendMessage, /const id = sessionId \?\? get\(\)\.activeId/)

    const welcomeSubmit = welcome.slice(
      welcome.indexOf('  const submit = async ('),
      welcome.indexOf('  const startPreset = (tool: WelcomeTool): void => {')
    )
    assert.match(welcomeSubmit, /const candidateSessionId = await startSessionWithPrompt\(/)
    assert.match(welcomeSubmit, /patchFirstTaskOnboardingRecord\(\{\s*candidateSessionId,/)
    assert.doesNotMatch(welcomeSubmit, /getState\(\)\.activeId/)
  })

  await check('canonical Result and Settings recovery boundaries remain intact', async () => {
    const onboardingSource = await read('src/renderer/src/components/experience/first-task-onboarding.ts')
    const welcome = await read('src/renderer/src/components/WelcomeView.tsx')
    const result = await read('src/renderer/src/components/workbench/StudioResultPanel.tsx')
    const store = await read('src/renderer/src/store.ts')
    const welcomeDraftSlice = await read('src/renderer/src/store/welcome-draft.ts')
    const resourceCatalog = await read('src/renderer/src/store/resource-catalog.ts')
    const sessionSend = await read('src/renderer/src/store/session-send.ts')
    const settings = await read('src/renderer/src/components/SettingsModal.tsx')
    const i18n = await read('src/renderer/src/i18n.ts')
    assert.match(onboardingSource, /Promise\.all\(\[worker\(\), worker\(\)\]\)/)
    assert.match(result, /openLocation\(location, openTool\)\.then/)
    assert.match(result, /record\.candidateSessionId !== sessionId/)
    assert.match(result, /getStudioResultSnapshot\(sessionId\)/)
    assert.match(result, /WorkflowAcceptanceRow/)
    assert.match(welcome, /tool\.key !== 'understand'/)
    assert.match(welcome, /const candidateSessionId = await startSessionWithPrompt\(/)
    assert.match(welcome, /clearWelcomeDraft\(\)/)
    assert.match(store, /WelcomeDraftSlice/)
    assert.match(store, /\.\.\.createWelcomeDraftSlice\(/)
    assert.match(welcomeDraftSlice, /forkFromSdkSessionId\?: string/)
    assert.doesNotMatch(store, /welcomeDraft\?: import\('\.\/components\/experience\/first-task-onboarding'\)/)
    assert.match(welcome, /const providersLoaded = useStore\(\(state\) => state\.providersLoaded\)/)
    assert.match(resourceCatalog, /providersLoaded: false/)
    assert.match(resourceCatalog, /set\(\{ providers, providersLoaded: true \}\)/)
    assert.doesNotMatch(store, /providersHydrated/)
    assert.match(store, /await sendActiveSessionMessage\(/)
    assert.match(sessionSend, /export async function sendActiveSessionMessage\(/)
    assert.doesNotMatch(store.slice(
      store.indexOf('  async sendMessage(input, sessionId) {'),
      store.indexOf('  async sendQuickbarClipboard(options) {')
    ), /window\.agentDesk\.sendMessage/)
    assert.match(settings, /const closeSettings = \(\): void => \{\s*void refreshProviders\(\)\.catch\(\(\) => undefined\)\s*setShowSettings\(false\)\s*\}/)
    assert.equal((settings.match(/onClick=\{closeSettings\}/g) ?? []).length, 2)
    assert.doesNotMatch(settings, /onClick=\{\(\) => setShowSettings\(false\)\}/)
    for (const key of ['welcomeUnderstandProjectPrompt', 'welcomeReviewChangesPrompt', 'welcomeOrganizeReportPrompt', 'welcomePlanTaskPrompt']) {
      assert.match(i18n, new RegExp(key))
    }
    assert.doesNotMatch(onboardingSource, /console\.(log|warn|error)/)
  })
}

delete globalThis.window
delete globalThis.CustomEvent
await rm(tempDir, { recursive: true, force: true })

const failures = checks.filter((item) => item.status === 'fail')
const report = {
  schemaVersion: 1,
  gate: 'test:first-task-onboarding:required',
  status: failures.length === 0 ? 'passed' : 'failed',
  ok: failures.length === 0,
  generatedAt: new Date().toISOString(),
  sourceRevision: gitOutput(['rev-parse', 'HEAD']),
  worktreeStatusCount: gitOutput(['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean).length,
  pass: checks.length - failures.length,
  total: checks.length,
  checks,
  failures: failures.map((item) => ({ name: item.name, error: item.error }))
}
const reportContent = `${JSON.stringify(report, null, 2)}\n`
assert.equal(privacyCanaries.some((marker) => reportContent.includes(marker)), false, 'machine report leaked a privacy canary')
await mkdir(reportDir, { recursive: true })
await writeFile(join(reportDir, 'report.json'), reportContent, 'utf8')

console.log(`first-task-onboarding: ${report.status} (${report.pass}/${report.total})`)
console.log(join(reportDir, 'report.json'))
if (failures.length > 0) process.exitCode = 1

async function check(name, operation) {
  const startedAt = Date.now()
  try {
    await operation()
    checks.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
  } catch (error) {
    checks.push({
      name,
      status: 'fail',
      durationMs: Date.now() - startedAt,
      error: redactError(error)
    })
  }
}

function redactError(error) {
  let value = error instanceof Error ? error.stack || error.message : String(error)
  for (const marker of privacyCanaries) value = value.replaceAll(marker, '[REDACTED]')
  return value
}

function gitOutput(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}
