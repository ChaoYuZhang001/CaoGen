#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const scriptPath = fileURLToPath(import.meta.url)
const require = createRequire(import.meta.url)
process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter)
require('node:module').Module._initPaths()

if (process.argv[2] === '--restart-probe') {
  const payload = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString('utf8'))
  await runRestartProbe(payload)
  process.exit(0)
}

const runId = new Date().toISOString().replace(/[:.]/g, '-')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-notification-effect-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
const workspaceRoot = path.join(tempRoot, 'workspace')
const reportRoot = path.join(repoRoot, 'test-results', 'notification-effect')
const reportDir = path.join(reportRoot, runId)
process.env.CAOGEN_NOTIFICATION_USER_DATA = userData

const sensitiveValues = []
const report = {
  schemaVersion: 1,
  runId,
  status: 'failed',
  sourceRevision: gitOutput(['rev-parse', 'HEAD']),
  worktreeStatusCount: gitOutput(['status', '--porcelain']).split('\n').filter(Boolean).length,
  checks: [],
  summary: {},
  failures: []
}

try {
  mkdirSync(userData, { recursive: true })
  mkdirSync(workspaceRoot, { recursive: true })
  compileSources()
  installElectronStub()
  await runNotificationEffectGate()
  report.status = 'passed'
  assertNoSensitive(JSON.stringify(report), 'notification gate report')
} catch (error) {
  report.failures.push(redactSensitive(error instanceof Error ? error.stack ?? error.message : String(error)))
  process.exitCode = 1
} finally {
  mkdirSync(reportDir, { recursive: true })
  const serialized = `${redactSensitive(JSON.stringify(report, null, 2))}\n`
  writeFileSync(path.join(reportDir, 'report.json'), serialized, 'utf8')
  writeFileSync(path.join(reportRoot, 'latest.json'), serialized, 'utf8')
  rmSync(tempRoot, { recursive: true, force: true })
}

const output = redactSensitive(JSON.stringify({
  status: report.status,
  runId,
  checks: report.checks.length,
  summary: report.summary,
  failures: report.failures,
  reportDir
}, null, 2))
assertNoSensitive(output, 'notification gate stdout')
console.log(output)

async function runNotificationEffectGate() {
  const apis = await loadNotificationGateApis()
  const {
    connectorApi, effectLedger, effectRuntime, idempotencyApi, notificationApi,
    runtimeRegistry, snapshotApi, workspaceApi, workspaceCommands
  } = apis

  const connectors = createConnectorFixtures(connectorApi)
  verifyConnectorStore(connectorApi, connectors)
  const projectFixture = await seedProject(workspaceApi, workspaceCommands)

  const cases = notificationCases(connectors)
  const run = await seedRun(snapshotApi, runtimeRegistry, idempotencyApi, cases)
  await attachRunToWorkItem(projectFixture, run.id)
  runtimeRegistry.taskRuntimeRegistry.set(run.sessionId, run)

  const fetchHarness = installFetchHarness()
  await verifyConnectorRevisionDrift({
    connectorApi,
    effectRuntime,
    runtimeRegistry,
    fetchHarness,
    testCase: cases.revisionDrift,
    replacementConnectorId: connectors.feishuSecondary.id
  })
  await verifyMessageDrift({
    notificationApi,
    fetchHarness,
    input: cases.directDrift.input
  })

  const confirmed = []
  for (const testCase of cases.confirmed) {
    confirmed.push(await runConfirmedDelivery({
      effectRuntime,
      notificationApi,
      runtimeRegistry,
      fetchHarness,
      testCase
    }))
  }
  await verifyConfirmedDuplicateFence({
    effectRuntime,
    fetchHarness,
    testCase: cases.confirmed[0]
  })

  const waiting = []
  for (const testCase of cases.waiting) {
    waiting.push(await runUncertainDelivery({
      effectRuntime,
      notificationApi,
      runtimeRegistry,
      fetchHarness,
      testCase
    }))
  }
  const outOfOrder = await verifyOutOfOrderNotification({
    effectLedger,
    snapshotApi,
    run,
    effectId: waiting[0]?.effectId
  })

  const crash = await runCrashAfterSend({
    effectRuntime,
    notificationApi,
    runtimeRegistry,
    snapshotApi,
    fetchHarness,
    testCase: cases.crash
  })
  const retiredWeComId = seedRetiredWeComConnector(userData)
  const legacyWeCom = await verifyLegacyWeComCompatibility({
    ...apis, fetchHarness, retiredWeComId, run
  })
  const restart = runRestartChild(notificationRestartPayload({
    cases, confirmed, connectors, crash, legacyWeCom, retiredWeComId, run, waiting
  }))
  assertEqual(restart.fetchCalls, 0, 'restart reconciliation fetch count')
  assertEqual(restart.crashStatus, 'waiting_reconciliation', 'crash Effect restart status')
  assertEqual(restart.confirmedCount, confirmed.length, 'confirmed Effect restart count')
  assertEqual(restart.waitingCount, waiting.length, 'uncertain Effect restart count')
  assertEqual(restart.firstRevision, restart.secondRevision, 'restart reconciliation revision')
  assertEqual(restart.confirmedDuplicateDecision, 'ask', 'confirmed notification idempotency decision')
  assertEqual(restart.unresolvedDuplicateDecision, 'deny', 'unresolved notification idempotency decision')
  assertEqual(restart.connectorCount, Object.keys(connectors).length, 'connector restart readback count')
  assertEqual(restart.availableConnectorCount, Object.keys(connectors).length, 'available connector restart count')
  assertEqual(restart.encryptedConnectorCount, Object.keys(connectors).length, 'encrypted connector restart count')
  assertEqual(restart.legacyWeComStatus, 'waiting_reconciliation', 'legacy WeCom Effect restart status')
  verifyRetiredWeComMigration(userData, retiredWeComId, restart)
  check('independent restart keeps sent-before-complete Effect unresolved with zero automatic resend', 'negative')
  check('restart reconciliation is idempotent and duplicate decisions remain fail-closed', 'negative')
  check('encrypted notification connectors remain available after independent restart')
  check('restart preserves retired WeCom records without exposing or executing them')
  check('legacy WeCom TaskRun and receipt manifest remain readable while create and execute stay blocked', 'negative')

  const recovered = await snapshotApi.getTaskSnapshot(run.sessionId, userData)
  assert(recovered?.run, 'restarted TaskSnapshot must remain readable')
  assertNoSensitive(JSON.stringify(recovered), 'persisted notification Effect ledger')
  assertPersistedFilesHaveNoSensitiveValues(userData)
  assertNoSensitive(JSON.stringify(fetchHarness.audit), 'sanitized fetch audit')
  assertNoSensitive(JSON.stringify(report), 'notification report before serialization')
  check('tool output, Effect ledger, persisted files, report, and stdout contain no raw webhook or secret', 'negative')

  report.summary = {
    channels: connectorsByChannel(connectors),
    confirmedEffects: confirmed.length,
    waitingEffects: waiting.length + 1,
    abandonedBeforeSend: 1,
    mockedFetchCalls: fetchHarness.calls(),
    restartFetchCalls: restart.fetchCalls,
    restartReconciliation: 'idempotent',
    automaticResends: 0,
    outOfOrderReconciliation: outOfOrder.ignored,
    readableLegacyWeComEffects: 1,
    rawCredentialLeaks: 0,
    negativePaths: report.checks.filter((item) => item.kind === 'negative').length
  }
}

async function verifyOutOfOrderNotification({ effectLedger, snapshotApi, run, effectId }) {
  assert(effectId, 'notification out-of-order fixture requires a waiting Effect')
  const snapshot = await snapshotApi.getTaskSnapshot(run.sessionId, userData)
  assert(snapshot?.run, 'notification out-of-order fixture requires a persisted Run')
  const before = snapshot.run.effects?.find((effect) => effect.id === effectId)
  assert(before, 'notification out-of-order fixture Effect must be persisted')
  const delayed = {
    kind: 'confirmed',
    evidenceDigest: 'notification-delayed-receipt',
    verifier: 'notification-effect-fixture',
    reason: 'delayed notification receipt',
    observedAt: before.updatedAt - 1
  }
  const next = effectLedger.applyEffectReconciliation(
    structuredClone(snapshot.run),
    effectId,
    delayed,
    before.updatedAt + 10
  )
  const after = next.effects?.find((effect) => effect.id === effectId)
  assert(after, 'notification out-of-order result must retain the Effect')
  assertEqual(after.status, before.status, 'notification out-of-order result must preserve status')
  assertEqual(after.updatedAt, before.updatedAt, 'notification out-of-order result must preserve updatedAt')
  assert(after.revision > before.revision, 'notification out-of-order result must append an audit revision')
  check('delayed notification receipt is audited without resend or status regression', 'negative')
  return { ignored: true }
}

async function loadNotificationGateApis() {
  const load = (suffix) => importCompiled(suffix)
  return {
    connectorApi: await load('main/notification/notification-connector-store.js'),
    notificationApi: await load('main/notification/notification-effect.js'),
    effectRuntime: await load('main/task/effect-runtime.js'),
    effectLedger: await load('main/task/effect-ledger.js'),
    effectTargetValidation: await load('main/task/effect-target-validation.js'),
    notificationArtifact: await load('main/task/notification-artifact-producer.js'),
    snapshotApi: await load('main/task/task-snapshot.js'),
    taskRunApi: await load('main/task/task-run.js'),
    runtimeRegistry: await load('main/task/task-runtime-registry.js'),
    idempotencyApi: await load('main/task/tool-idempotency.js'),
    workspaceApi: await load('main/project-workspace/index.js'),
    workspaceCommands: await load('main/project-workspace/command-service.js')
  }
}

function notificationRestartPayload(input) {
  const { cases, confirmed, connectors, crash, legacyWeCom, retiredWeComId, run, waiting } = input
  return {
    outDir,
    userData,
    sessionId: run.sessionId,
    crashEffectId: crash.effectId,
    confirmedEffectIds: confirmed.map((item) => item.effectId),
    waitingEffectIds: waiting.map((item) => item.effectId),
    confirmedInput: cases.confirmed[0].input,
    crashInput: cases.crash.input,
    cwd: workspaceRoot,
    expectedConnectorIds: Object.values(connectors).map((item) => item.id),
    retiredWeComId,
    legacyWeComEffectId: legacyWeCom.effectId
  }
}

async function verifyLegacyWeComCompatibility(input) {
  const {
    effectLedger,
    effectRuntime,
    effectTargetValidation,
    fetchHarness,
    idempotencyApi,
    notificationApi,
    notificationArtifact,
    retiredWeComId,
    run,
    snapshotApi,
    taskRunApi
  } = input
  const snapshot = await snapshotApi.getTaskSnapshot(run.sessionId, userData)
  const currentRun = snapshot?.run
  assert(currentRun, 'legacy WeCom fixture requires a persisted TaskRun')
  const source = currentRun.effects?.find((effect) =>
    effect.status === 'confirmed' && effect.target?.kind === 'webhook_message_send')
  assert(source, 'legacy WeCom fixture requires a confirmed notification Effect')
  const fixture = buildLegacyWeComFixture(currentRun, source, retiredWeComId, idempotencyApi)

  assertEqual(effectTargetValidation.isEffectTarget(fixture.target), true, 'legacy WeCom EffectTarget persisted validation')
  assertEqual(effectTargetValidation.isEffectTargetCreatable(fixture.target), false, 'legacy WeCom EffectTarget create policy')
  assertEqual(taskRunApi.isTaskRunRecord(fixture.legacyRun), true, 'legacy WeCom TaskRun schema validation')
  assertEqual(
    notificationArtifact.isNotificationDeliveryManifest(fixture.manifest),
    true,
    'legacy WeCom receipt manifest validation'
  )
  await verifyLegacyWeComPolicies({
    currentRun, effectLedger, fetchHarness, fixture, notificationApi, retiredWeComId, source
  })

  const legacySnapshot = {
    ...snapshot,
    updatedAt: fixture.legacyRun.updatedAt,
    run: fixture.legacyRun
  }
  const callsBeforeRecovery = fetchHarness.calls()
  const reconciled = await effectRuntime.reconcilePersistedTaskSnapshot(legacySnapshot, userData)
  const recovered = requireSnapshotEffect(reconciled, fixture.effectId)
  assertEqual(recovered.status, 'waiting_reconciliation', 'legacy WeCom recovery status')
  assertEqual(recovered.target.channel, 'wecom', 'legacy WeCom recovery channel')
  assertEqual(fetchHarness.calls(), callsBeforeRecovery, 'legacy WeCom recovery fetch count')
  return { effectId: fixture.effectId }
}

function buildLegacyWeComFixture(currentRun, source, retiredWeComId, idempotencyApi) {
  const target = { ...source.target, connectorId: retiredWeComId, channel: 'wecom' }
  const targetDigest = idempotencyApi.stableValueDigest(target)
  const intentDigest = idempotencyApi.stableValueDigest({
    toolName: source.toolName, targetDigest, inputDigest: source.inputDigest
  })
  const effectId = 'effect-legacy-wecom-readonly'
  const legacyEffect = {
    ...source,
    id: effectId,
    effectKey: `effect-v1:${idempotencyApi.stableValueDigest({ effectId, targetDigest })}`,
    resourceKey: `resource-v1:${idempotencyApi.stableValueDigest({
      scope: 'webhook-message', connectorId: retiredWeComId, payloadDigest: target.payloadDigest
    })}`,
    toolUseId: 'notification-legacy-wecom-readonly',
    toolExecutionId: undefined,
    status: 'waiting_reconciliation',
    target,
    targetDigest,
    intentDigest,
    evidence: source.evidence.map((item, index) => ({
      ...item, id: `evidence-legacy-wecom-${index + 1}`
    })),
    lease: undefined,
    terminalAt: undefined,
    error: undefined
  }
  const legacyRun = {
    ...currentRun,
    revision: currentRun.revision + 1,
    updatedAt: Math.max(Date.now(), currentRun.updatedAt + 1),
    effects: [...(currentRun.effects ?? []), legacyEffect]
  }
  return {
    effectId,
    target,
    legacyRun,
    descriptor: {
      target, targetDigest, inputDigest: source.inputDigest, intentDigest, reconcilability: 'opaque'
    },
    manifest: {
      schemaVersion: 1,
      kind: 'notification_delivery',
      effectId,
      channel: 'wecom',
      connectorId: retiredWeComId,
      connectorRevision: target.connectorRevision,
      endpointDigest: target.webhookDigest,
      payloadDigest: target.payloadDigest,
      titleDigest: target.titleDigest,
      textDigest: target.textDigest,
      ...(target.linkUrlDigest ? { linkDigest: target.linkUrlDigest } : {}),
      confirmationSource: 'runtime_receipt',
      confirmationVerifier: source.evidence.at(-1)?.verifier ?? 'legacy-runtime-receipt',
      confirmationEvidenceDigest: source.evidence.at(-1)?.digest ?? target.payloadDigest
    }
  }
}

async function verifyLegacyWeComPolicies(input) {
  const { currentRun, effectLedger, fetchHarness, fixture, notificationApi, retiredWeComId, source } = input
  const callsBeforeCreate = fetchHarness.calls()
  await assertRejects(
    () => effectLedger.prepareEffect(currentRun, {
      sessionId: currentRun.sessionId,
      cwd: workspaceRoot,
      toolUseId: 'notification-legacy-wecom-new-attempt',
      toolName: source.toolName,
      descriptor: fixture.descriptor,
      ownerId: 'notification-required-gate'
    }),
    /历史通知|仅供读取|禁止创建/i,
    'legacy WeCom Effect creation must fail closed'
  )
  assertEqual(fetchHarness.calls(), callsBeforeCreate, 'legacy WeCom create fetch count')

  const callsBeforeExecute = fetchHarness.calls()
  await assertRejects(
    () => notificationApi.executeWebhookMessageEffectTarget(fixture.target, {
      connectorId: retiredWeComId,
      title: 'Legacy WeCom delivery',
      text: 'This historical target must never be sent.'
    }),
    /历史通知|仅供读取|禁止执行|禁止重发/i,
    'legacy WeCom Effect execution must fail closed'
  )
  assertEqual(fetchHarness.calls(), callsBeforeExecute, 'legacy WeCom execute fetch count')
}

function seedRetiredWeComConnector(root) {
  const file = path.join(root, 'notification-connectors.json')
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  assert(Array.isArray(stored) && stored.length > 0, 'notification store must be seeded before retired connector migration')
  const retiredId = 'legacy-wecom-connector'
  stored.push({
    ...stored[0],
    id: retiredId,
    name: 'Retired WeCom connector',
    channel: 'wecom',
    isDefault: false
  })
  writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return retiredId
}

function verifyRetiredWeComMigration(root, retiredId, restart) {
  assertEqual(restart.retiredWeComPresent, false, 'retired WeCom connector restart visibility')
  const file = path.join(root, 'notification-connectors.json')
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  assert(Array.isArray(stored), 'notification connector store must remain an array')
  const retired = stored.find((item) => item?.id === retiredId && item?.channel === 'wecom')
  assert(retired?.name === 'Retired WeCom connector', 'retired WeCom metadata must remain on disk')
  assertEqual(stored.length, restart.connectorIds.length + 1, 'preserved connector store count')
  assert(restart.connectorIds.every((id) => stored.some((item) => item?.id === id)), 'supported connector records must survive migration')
}

function createConnectorFixtures(connectorApi) {
  const definitions = {
    feishu: {
      name: 'Feishu required gate',
      channel: 'feishu',
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-only-feishu-hook',
      secret: 'secret-for-smoke-notification-feishu'
    },
    dingtalk: {
      name: 'DingTalk required gate',
      channel: 'dingtalk',
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=test-only-dingtalk-token',
      secret: 'secret-for-smoke-notification-dingtalk'
    },
    feishuSecondary: {
      name: 'Feishu revision replacement',
      channel: 'feishu',
      webhookUrl: 'https://open.larksuite.com/open-apis/bot/v2/hook/test-only-feishu-secondary-hook',
      secret: 'secret-for-smoke-notification-feishu-secondary'
    }
  }
  for (const definition of Object.values(definitions)) {
    sensitiveValues.push(definition.webhookUrl, definition.secret)
    const url = new URL(definition.webhookUrl)
    for (const value of url.searchParams.values()) sensitiveValues.push(value)
    const tail = url.pathname.split('/').filter(Boolean).at(-1)
    if (tail && url.pathname.includes('/hook/')) sensitiveValues.push(tail)
  }
  return Object.fromEntries(Object.entries(definitions).map(([key, definition]) => [
    key,
    connectorApi.createNotificationConnector(definition)
  ]))
}

function verifyConnectorStore(connectorApi, connectors) {
  const file = path.join(userData, 'notification-connectors.json')
  assert(existsSync(file), 'notification connector store must exist')
  const stored = readFileSync(file)
  assertNoSensitive(stored, 'notification connector store')
  if (process.platform !== 'win32') {
    assertEqual(statSync(file).mode & 0o777, 0o600, 'notification connector file mode')
  }
  const views = connectorApi.listNotificationConnectors()
  for (const connector of Object.values(connectors)) {
    const view = views.find((candidate) => candidate.id === connector.id)
    assert(view, `connector view must exist:${connector.channel}`)
    assertEqual(view.available, true, `${connector.channel} connector availability`)
    assertEqual(view.credentialStorage, 'encrypted', `${connector.channel} connector storage`)
    assert(/^[a-f0-9]{64}$/.test(view.webhookDigest), `${connector.channel} webhook digest`)
  }
  assertEqual(connectors.feishu.channel, 'feishu', 'official Feishu URL channel')
  assertEqual(connectors.dingtalk.channel, 'dingtalk', 'official DingTalk URL channel')
  check('official Feishu and DingTalk webhook URL shapes resolve to their connector channels')
  check('connector store contains only encrypted credentials and digests', 'negative')
  check('connector store uses owner-only POSIX permissions')
}

function notificationCases(connectors) {
  const confirmed = [
    {
      name: 'feishu',
      toolUseId: 'notification-confirmed-feishu',
      input: message(connectors.feishu.id, 'Feishu confirmed'),
      response: { ok: true, status: 200, body: '{"code":0,"msg":"success"}' },
      expectedHost: 'open.feishu.cn'
    },
    {
      name: 'dingtalk',
      toolUseId: 'notification-confirmed-dingtalk',
      input: message(connectors.dingtalk.id, 'DingTalk confirmed'),
      response: { ok: true, status: 200, body: '{"errcode":0,"errmsg":"ok"}' },
      expectedHost: 'oapi.dingtalk.com'
    }
  ]
  const waiting = [
    {
      name: 'ambiguous-receipt',
      toolUseId: 'notification-ambiguous-receipt',
      input: message(connectors.feishu.id, 'Ambiguous receipt'),
      response: { ok: true, status: 200, body: '{"message":"accepted"}' },
      expectedSent: true
    },
    {
      name: 'http-failure',
      toolUseId: 'notification-http-failure',
      input: message(connectors.dingtalk.id, 'HTTP failure'),
      response: { ok: false, status: 503, body: '{"errcode":0}' },
      expectedSent: true
    },
    {
      name: 'transport-failure',
      toolUseId: 'notification-transport-failure',
      input: message(connectors.dingtalk.id, 'Transport failure'),
      response: { throwsWithRequest: true },
      expectedSent: false
    }
  ]
  return {
    confirmed,
    waiting,
    revisionDrift: {
      toolUseId: 'notification-connector-revision-drift',
      input: message(connectors.feishu.id, 'Connector revision drift')
    },
    directDrift: {
      input: message(connectors.feishu.id, 'Frozen message intent')
    },
    crash: {
      toolUseId: 'notification-crash-after-send',
      input: message(connectors.dingtalk.id, 'Crash after send'),
      response: { ok: true, status: 200, body: '{"errcode":0,"errmsg":"ok"}' }
    },
    allExecutionCases() {
      return [this.revisionDrift, ...confirmed, ...waiting, this.crash]
    }
  }
}

function message(connectorId, title) {
  return {
    connectorId,
    title,
    text: `${title} body`,
    linkUrl: 'https://example.invalid/notification-result'
  }
}

async function seedRun(snapshotApi, runtimeRegistry, idempotencyApi, cases) {
  const now = Date.now()
  const run = {
    schemaVersion: 1,
    id: 'run-notification-required',
    sessionId: 'session-notification-required',
    taskId: 'task-notification-required',
    status: 'executing',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: now,
    updatedAt: now,
    steps: [],
    toolExecutions: cases.allExecutionCases().map((testCase, index) => ({
      id: `tool-execution-notification-${index + 1}`,
      runId: 'run-notification-required',
      sessionId: 'session-notification-required',
      toolUseId: testCase.toolUseId,
      toolName: 'send_notification',
      status: 'requested',
      inputDigest: idempotencyApi.stableValueDigest(testCase.input),
      idempotencyKey: idempotencyApi.buildToolIdempotencyKey({
        scopeId: 'session-notification-required',
        cwd: workspaceRoot,
        toolName: 'send_notification',
        toolInput: testCase.input
      }),
      createdAt: now + index,
      updatedAt: now + index
    })),
    effects: []
  }
  const snapshot = snapshotApi.buildTaskSnapshot({
    meta: {
      id: run.sessionId,
      title: 'Notification Effect required gate',
      cwd: workspaceRoot,
      projectId: 'project-notification-required',
      workspaceId: 'project-notification-required',
      workItemId: 'work-item-notification-required',
      childTaskId: run.taskId,
      model: 'synthetic-notification-model',
      providerId: 'synthetic-notification-provider',
      permissionMode: 'default',
      status: 'running',
      sdkSessionId: 'sdk-notification-required',
      costUsd: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      contextTokens: 0,
      createdAt: now
    },
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run,
    now
  })
  const persisted = await snapshotApi.saveTaskSnapshot(snapshot, userData)
  const persistedRun = persisted.run ?? run
  runtimeRegistry.taskRuntimeRegistry.set(run.sessionId, persistedRun)
  check('canonical TaskSnapshot and Run persist before notification Effect execution')
  return persistedRun
}

async function seedProject(workspaceApi, workspaceCommands) {
  const store = new workspaceApi.ProjectWorkspaceStore(userData)
  await store.open()
  await store.createWorkspace({
    id: 'project-notification-required',
    name: 'Notification Effect Project',
    kind: 'software',
    resources: []
  })
  const commands = workspaceCommands.createProjectWorkspaceCommandService(store, { rootDir: userData })
  await commands.reconcileShadowProjection()
  const workItem = await commands.createWorkItem({
    id: 'work-item-notification-required',
    projectId: 'project-notification-required',
    title: 'Deliver verified notification receipts',
    type: 'delivery',
    status: 'verifying'
  })
  return { store, commands, workItemId: workItem.id }
}

async function attachRunToWorkItem(fixture, runId) {
  const current = await fixture.store.getWorkItem(fixture.workItemId)
  if (!current) throw new Error(`Notification WorkItem disappeared:${fixture.workItemId}`)
  if (current.runRefs.includes(runId)) return
  await fixture.commands.updateWorkItem(current.id, {
    runRefs: [...current.runRefs, runId]
  }, { expectedRevision: current.revision })
}

function installFetchHarness() {
  let plan = null
  let callCount = 0
  const audit = []
  globalThis.fetch = async (input, init = {}) => {
    if (!plan) throw new Error('unexpected network attempt without a synthetic fetch plan')
    const current = plan
    plan = null
    callCount += 1
    const url = new URL(String(input))
    const body = typeof init.body === 'string' ? init.body : ''
    assertNoSensitive(body, 'notification request body')
    audit.push({
      label: current.label,
      host: url.hostname,
      endpoint: 'official-webhook',
      method: init.method,
      contentType: init.headers?.['content-type'],
      bodyDigestOnly: true
    })
    if (current.throwsWithRequest) throw new Error(`synthetic transport failure:${String(input)}`)
    return {
      ok: current.ok,
      status: current.status,
      text: async () => current.body
    }
  }
  return {
    audit,
    calls: () => callCount,
    expect(label, response) {
      if (plan) throw new Error('previous synthetic fetch plan was not consumed')
      plan = { label, ...response }
    },
    assertConsumed() {
      assert(plan === null, 'synthetic fetch plan was not consumed')
    }
  }
}

async function verifyConnectorRevisionDrift(input) {
  const { connectorApi, effectRuntime, runtimeRegistry, fetchHarness, testCase, replacementConnectorId } = input
  const execution = executionInput(testCase)
  const handle = await effectRuntime.prepareEffectExecution(execution)
  assert(handle?.target.kind === 'webhook_message_send', 'revision drift must freeze a webhook target')
  const approvedRevision = handle.target.connectorRevision
  connectorApi.setDefaultNotificationConnector(replacementConnectorId)
  const current = connectorApi.listNotificationConnectors().find((item) => item.id === handle.target.connectorId)
  assert(current && current.revision > approvedRevision, 'connector revision must advance after default change')
  const callsBefore = fetchHarness.calls()
  await assertRejects(
    () => effectRuntime.markEffectExecutionStarted(handle, execution),
    /变化|失效|重新审批|偏离/i,
    'connector revision drift must invalidate the prepared Effect'
  )
  assertEqual(fetchHarness.calls(), callsBefore, 'connector revision drift fetch count')
  const effect = currentEffect(runtimeRegistry, execution.sessionId, handle.effectId)
  assertEqual(effect.status, 'abandoned', 'connector revision drift Effect status')
  check('connector revision drift abandons the prepared Effect before fetch', 'negative')
}

async function verifyMessageDrift({ notificationApi, fetchHarness, input }) {
  const target = notificationApi.buildWebhookMessageEffectTarget(input)
  assertEqual(target.kind, 'webhook_message_send', 'direct drift target kind')
  const mutations = [
    ['title', { ...input, title: 'Changed title' }],
    ['text', { ...input, text: 'Changed text' }],
    ['link', { ...input, linkUrl: 'https://example.invalid/changed-result' }]
  ]
  for (const [field, changed] of mutations) {
    const callsBefore = fetchHarness.calls()
    await assertRejects(
      () => notificationApi.executeWebhookMessageEffectTarget(target, changed),
      /偏离效果审批时意图/i,
      `${field} drift must fail closed`
    )
    assertEqual(fetchHarness.calls(), callsBefore, `${field} drift fetch count`)
    check(`${field} drift fails closed before fetch`, 'negative')
  }

  const callsBeforePayload = fetchHarness.calls()
  await assertRejects(
    () => notificationApi.executeWebhookMessageEffectTarget(
      { ...target, payloadDigest: '0'.repeat(64) },
      input
    ),
    /偏离效果审批时意图/i,
    'payload digest drift must fail closed'
  )
  assertEqual(fetchHarness.calls(), callsBeforePayload, 'payload drift fetch count')
  check('payload digest drift fails closed before fetch', 'negative')

  const callsBeforeConnector = fetchHarness.calls()
  await assertRejects(
    () => notificationApi.executeWebhookMessageEffectTarget(
      { ...target, webhookDigest: 'f'.repeat(64) },
      input
    ),
    /偏离效果审批时版本/i,
    'webhook digest drift must fail closed'
  )
  assertEqual(fetchHarness.calls(), callsBeforeConnector, 'webhook digest drift fetch count')
  check('webhook digest drift fails closed before fetch', 'negative')
}

async function runConfirmedDelivery(input) {
  const { effectRuntime, notificationApi, runtimeRegistry, fetchHarness, testCase } = input
  const execution = executionInput(testCase)
  const handle = await effectRuntime.prepareEffectExecution(execution)
  assert(handle?.target.kind === 'webhook_message_send', `${testCase.name} target kind`)
  assertEqual(currentEffect(runtimeRegistry, execution.sessionId, handle.effectId).status, 'prepared', `${testCase.name} prepared status`)
  await effectRuntime.markEffectExecutionStarted(handle, execution)
  assertEqual(currentEffect(runtimeRegistry, execution.sessionId, handle.effectId).status, 'executing', `${testCase.name} executing status`)
  const callsBefore = fetchHarness.calls()
  fetchHarness.expect(testCase.name, testCase.response)
  const result = await notificationApi.executeWebhookMessageEffectTarget(handle.target, testCase.input)
  fetchHarness.assertConsumed()
  assertEqual(fetchHarness.calls(), callsBefore + 1, `${testCase.name} fetch count`)
  assertEqual(fetchHarness.audit.at(-1)?.host, testCase.expectedHost, `${testCase.name} official host`)
  assertEqual(result.ok, true, `${testCase.name} delivery result`)
  assertEqual(result.sent, true, `${testCase.name} sent result`)
  const output = JSON.stringify(result)
  assertNoSensitive(output, `${testCase.name} tool output`)
  const effect = await effectRuntime.completeEffectExecution(handle, { ok: result.ok, output })
  assertEqual(effect?.status, 'confirmed', `${testCase.name} confirmed status`)
  check(`${testCase.name} prepare -> executing -> explicit receipt -> confirmed`)
  return { effectId: handle.effectId }
}

async function verifyConfirmedDuplicateFence({ effectRuntime, fetchHarness, testCase }) {
  const execution = executionInput(testCase)
  const handle = await effectRuntime.prepareEffectExecution(execution)
  assert(handle, 'confirmed duplicate must resolve its existing Effect handle')
  const callsBefore = fetchHarness.calls()
  await assertRejects(
    () => effectRuntime.markEffectExecutionStarted(handle, execution),
    /confirmed|状态不能开始执行|stale_fence|lease 已失效/i,
    'same toolUseId must not restart a confirmed notification Effect'
  )
  assertEqual(fetchHarness.calls(), callsBefore, 'confirmed duplicate fetch count')
  check('same toolUseId cannot resend a confirmed notification', 'negative')
}

async function runUncertainDelivery(input) {
  const { effectRuntime, notificationApi, runtimeRegistry, fetchHarness, testCase } = input
  const execution = executionInput(testCase)
  const handle = await effectRuntime.prepareEffectExecution(execution)
  assert(handle?.target.kind === 'webhook_message_send', `${testCase.name} target kind`)
  await effectRuntime.markEffectExecutionStarted(handle, execution)
  const callsBefore = fetchHarness.calls()
  fetchHarness.expect(testCase.name, testCase.response)
  const result = await notificationApi.executeWebhookMessageEffectTarget(handle.target, testCase.input)
  fetchHarness.assertConsumed()
  assertEqual(fetchHarness.calls(), callsBefore + 1, `${testCase.name} fetch count`)
  assertEqual(result.ok, false, `${testCase.name} must not report confirmed success`)
  assertEqual(result.sent, testCase.expectedSent, `${testCase.name} sent state`)
  const output = JSON.stringify(result)
  assertNoSensitive(output, `${testCase.name} tool output`)
  const effect = await effectRuntime.completeEffectExecution(handle, { ok: result.ok, output })
  assertEqual(effect?.status, 'waiting_reconciliation', `${testCase.name} Effect status`)
  assertEqual(
    currentEffect(runtimeRegistry, execution.sessionId, handle.effectId).status,
    'waiting_reconciliation',
    `${testCase.name} persisted runtime status`
  )
  check(`${testCase.name} remains waiting_reconciliation`, 'negative')
  return { effectId: handle.effectId }
}

async function runCrashAfterSend(input) {
  const { effectRuntime, notificationApi, runtimeRegistry, snapshotApi, fetchHarness, testCase } = input
  const execution = executionInput(testCase)
  const handle = await effectRuntime.prepareEffectExecution(execution)
  assert(handle?.target.kind === 'webhook_message_send', 'crash target kind')
  await effectRuntime.markEffectExecutionStarted(handle, execution)
  const callsBefore = fetchHarness.calls()
  fetchHarness.expect('crash-after-send', testCase.response)
  const result = await notificationApi.executeWebhookMessageEffectTarget(handle.target, testCase.input)
  fetchHarness.assertConsumed()
  assertEqual(fetchHarness.calls(), callsBefore + 1, 'crash send fetch count')
  assertEqual(result.ok, true, 'crash send synthetic receipt')
  assertNoSensitive(JSON.stringify(result), 'crash send output')
  const persisted = await snapshotApi.getTaskSnapshot(execution.sessionId, userData)
  const effect = persisted?.run?.effects?.find((item) => item.id === handle.effectId)
  assertEqual(effect?.status, 'executing', 'sent-before-complete persisted status')
  assertEqual(currentEffect(runtimeRegistry, execution.sessionId, handle.effectId).status, 'executing', 'crash runtime status')
  check('successful send without complete leaves a durable executing Effect for recovery', 'negative')
  return { effectId: handle.effectId }
}

function runRestartChild(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const stdout = execFileSync(process.execPath, [scriptPath, '--restart-probe', encoded], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      CAOGEN_NOTIFICATION_USER_DATA: payload.userData
    }
  })
  assertNoSensitive(stdout, 'restart probe stdout')
  const line = stdout.split('\n').find((candidate) => candidate.startsWith('NOTIFICATION_RESTART_PROBE:'))
  if (!line) throw new Error('restart probe did not emit its result marker')
  return JSON.parse(line.slice('NOTIFICATION_RESTART_PROBE:'.length))
}

async function runRestartProbe(payload) {
  process.env.CAOGEN_NOTIFICATION_USER_DATA = payload.userData
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    throw new Error('restart reconciliation attempted a forbidden notification resend')
  }
  const connectorApi = await importCompiledFrom(payload.outDir, 'main/notification/notification-connector-store.js')
  const effectRuntime = await importCompiledFrom(payload.outDir, 'main/task/effect-runtime.js')
  const snapshotApi = await importCompiledFrom(payload.outDir, 'main/task/task-snapshot.js')
  const runtimeRegistry = await importCompiledFrom(payload.outDir, 'main/task/task-runtime-registry.js')

  const views = connectorApi.listNotificationConnectors()
  const ids = new Set(views.map((item) => item.id))
  assert(payload.expectedConnectorIds.every((id) => ids.has(id)), 'restart connector IDs must be preserved')
  const stored = await snapshotApi.getTaskSnapshot(payload.sessionId, payload.userData)
  assert(stored?.run, 'restart probe cannot read the persisted notification Run')
  const first = await effectRuntime.reconcilePersistedTaskSnapshot(stored)
  const firstEffect = requireSnapshotEffect(first, payload.crashEffectId)
  const firstRevision = first.run?.revision
  const second = await effectRuntime.reconcilePersistedTaskSnapshot(first)
  const secondEffect = requireSnapshotEffect(second, payload.crashEffectId)
  const legacyWeComEffect = requireSnapshotEffect(second, payload.legacyWeComEffectId)
  const confirmedIds = new Set(payload.confirmedEffectIds)
  const waitingIds = new Set(payload.waitingEffectIds)
  const effects = second.run?.effects ?? []
  const confirmedDuplicate = runtimeRegistry.taskRuntimeRegistry.evaluateTool({
    sessionId: payload.sessionId,
    cwd: payload.cwd,
    toolName: 'send_notification',
    toolInput: payload.confirmedInput,
    toolUseId: 'notification-confirmed-new-attempt'
  })
  const unresolvedDuplicate = runtimeRegistry.taskRuntimeRegistry.evaluateTool({
    sessionId: payload.sessionId,
    cwd: payload.cwd,
    toolName: 'send_notification',
    toolInput: payload.crashInput,
    toolUseId: 'notification-crash-new-attempt'
  })
  process.stdout.write(`NOTIFICATION_RESTART_PROBE:${JSON.stringify({
    fetchCalls,
    crashStatus: secondEffect.status,
    confirmedCount: effects.filter((effect) => confirmedIds.has(effect.id) && effect.status === 'confirmed').length,
    waitingCount: effects.filter((effect) => waitingIds.has(effect.id) && effect.status === 'waiting_reconciliation').length,
    firstRevision,
    secondRevision: second.run?.revision,
    firstCrashRevision: firstEffect.revision,
    secondCrashRevision: secondEffect.revision,
    confirmedDuplicateDecision: confirmedDuplicate.kind,
    unresolvedDuplicateDecision: unresolvedDuplicate.kind,
    connectorCount: views.length,
    connectorIds: views.map((item) => item.id),
    retiredWeComPresent: views.some((item) => item.id === payload.retiredWeComId || item.channel === 'wecom'),
    legacyWeComStatus: legacyWeComEffect.status,
    availableConnectorCount: views.filter((item) => item.available).length,
    encryptedConnectorCount: views.filter((item) => item.credentialStorage === 'encrypted').length
  })}\n`)
}

function requireSnapshotEffect(snapshot, effectId) {
  const effect = snapshot.run?.effects?.find((item) => item.id === effectId)
  if (!effect) throw new Error(`restart probe missing Effect:${effectId}`)
  return effect
}

function executionInput(testCase) {
  return {
    sessionId: 'session-notification-required',
    cwd: workspaceRoot,
    toolUseId: testCase.toolUseId,
    toolName: 'send_notification',
    toolInput: testCase.input
  }
}

function currentEffect(runtimeRegistry, sessionId, effectId) {
  const effect = runtimeRegistry.taskRuntimeRegistry.get(sessionId)?.effects?.find((item) => item.id === effectId)
  if (!effect) throw new Error(`runtime Effect not found:${effectId}`)
  return effect
}

function connectorsByChannel(connectors) {
  return [...new Set(Object.values(connectors).map((item) => item.channel))].sort()
}

function assertPersistedFilesHaveNoSensitiveValues(root) {
  const files = walkFiles(root)
  assert(files.length > 0, 'notification gate must produce persisted files')
  for (const file of files) assertNoSensitive(readFileSync(file), `persisted file:${path.basename(file)}`)
}

function walkFiles(root) {
  const files = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(fullPath)
      else if (entry.isFile()) files.push(fullPath)
    }
  }
  return files
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/notification/notification-effect.ts',
    'src/main/task/effect-runtime.ts',
    'src/main/task/task-snapshot.ts',
    'src/main/task/task-runtime-registry.ts',
    '--outDir', outDir,
    '--rootDir', 'src',
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop',
    '--strict'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), `
function transform(value) {
  const input = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, 'utf8')
  const output = Buffer.alloc(input.length)
  for (let index = 0; index < input.length; index += 1) {
    output[index] = input[input.length - index - 1] ^ 0xa5
  }
  return output
}
export const app = { getPath: () => process.env.CAOGEN_NOTIFICATION_USER_DATA }
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => transform(value),
  decryptString: (value) => transform(value).toString('utf8'),
  getSelectedStorageBackend: () => 'keychain'
}
`)
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

async function importCompiled(suffix) {
  return importCompiledFrom(outDir, suffix)
}

async function importCompiledFrom(root, suffix) {
  const file = findCompiled(root, suffix)
  if (!file) throw new Error(`compiled module not found:${suffix}`)
  return import(pathToFileURL(file).href)
}

function findCompiled(root, suffix) {
  const target = suffix.split('/').join(path.sep)
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(fullPath)
      else if (entry.isFile() && fullPath.endsWith(target)) return fullPath
    }
  }
  return null
}

function gitOutput(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}

function check(name, kind = 'positive') {
  report.checks.push({ name, kind, status: 'passed' })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

async function assertRejects(task, pattern, message) {
  try {
    await task()
  } catch (error) {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    if (!pattern.test(text)) throw new Error(`${message}: unexpected error:${redactSensitive(text)}`)
    return
  }
  throw new Error(`${message}: operation unexpectedly succeeded`)
}

function assertNoSensitive(value, label) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
  for (const secret of [...new Set(sensitiveValues.filter(Boolean))]) {
    if (bytes.includes(Buffer.from(secret, 'utf8'))) {
      throw new Error(`${label} contains raw notification credential material`)
    }
  }
}

function redactSensitive(value) {
  let redacted = String(value)
  for (const secret of [...new Set(sensitiveValues.filter(Boolean))].sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(secret).join('[REDACTED]')
  }
  return redacted
}
