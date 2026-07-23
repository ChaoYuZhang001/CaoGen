import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-workflow-ledger-security-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
mkdirSync(userData, { recursive: true })

try {
  assertBundledRendererPaths()
  compileSources()
  installElectronStub()
  const security = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-ledger-artifact-security.js')).href)
  const snapshotStore = await import(pathToFileURL(findCompiledModule(outDir, 'task-snapshot.js')).href)
  const workflowApi = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-ledger-api.js')).href)
  const workflowStore = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-ledger-store.js')).href)
  const projectStoreApi = await import(pathToFileURL(
    path.join(outDir, 'main', 'project-workspace', 'store.js')
  ).href)
  const graph = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-ledger-artifact-graph.js')).href)
  const electronStub = await import(pathToFileURL(path.join(outDir, 'node_modules', 'electron', 'index.js')).href)
  const ipcHandlers = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-ledger-handlers.js')).href)
  ipcHandlers.registerWorkflowLedgerIpc()

  const canary = ['sk', 'workflow-security-canary-fixture'].join('-')
  assertThrows(
    () => security.assertWorkflowArtifactMetadataSafe({ apiKey: canary }, 'artifact metadata'),
    canary,
    'artifact metadata rejection must not echo the canary'
  )
  assertThrows(
    () => security.assertWorkflowArtifactMetadataSafe({ note: 'REDACTED_TOKEN_PLACEHOLDER' }, 'artifact metadata'),
    'credential-value',
    'deterministic secret canary values must fail closed'
  )
  assertThrows(
    () => security.assertWorkflowArtifactMetadataSafe({ nested: { password: 'ordinary' } }, 'graph edge metadata'),
    'credential-key',
    'credential-like metadata keys must fail closed'
  )
  assertThrows(
    () => security.assertWorkflowArtifactUriSafe(`https://user:pass@example.test/report`),
    'url-userinfo',
    'URI userinfo must fail closed'
  )
  assertThrows(
    () => security.assertWorkflowArtifactUriSafe(`https://example.test/report?apiKey=${canary}`),
    'url-query',
    'credential-like URI query must fail closed'
  )
  assertThrows(
    () => security.assertWorkflowArtifactLocationPathSafe(`/tmp/${canary}`),
    'credential-value',
    'credential-like location path must fail closed'
  )
  assertThrows(
    () => security.assertWorkflowArtifactLocationPathSafe('/tmp/%73k-workflow-security-canary-fixture'),
    'credential-value',
    'encoded credential-like location path must fail closed'
  )
  assertThrows(
    () => security.assertWorkflowArtifactUriSafe(`https://example.test/report#${canary}`),
    'url-credential',
    'credential-like URI fragment must fail closed'
  )
  const inspected = security.inspectWorkflowArtifactSecurity({
    artifactUri: `https://example.test/report?token=${canary}`,
    locationPath: `/tmp/${canary}`
  })
  assert(inspected.length >= 2, 'security inspection must report URI and path categories')
  assert(!JSON.stringify(inspected).includes(canary), 'security diagnostics must not contain raw canaries')

  const snapshot = snapshotStore.buildTaskSnapshot({
    meta: { ...buildMeta('security-session', 'security-project'), childTaskId: 'security-task' },
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run: buildRun('security-run', 'security-session', 'security-task', 1, 100)
  })
  await snapshotStore.saveTaskSnapshot(snapshot, userData)

  const internal = await workflowApi.listPersistedWorkflowLedger({}, userData)
  const internalRun = internal.runs.items[0]
  assert(internalRun && internalRun.taskRun, 'internal Ledger query must retain TaskRun for recovery')
  const projectStore = new projectStoreApi.ProjectWorkspaceStore(userData)
  await projectStore.open()
  await projectStore.createWorkspace({ id: 'security-project', name: 'Security project', kind: 'software' })
  await projectStore.createWorkItem({
    id: internalRun.workItemId,
    projectId: 'security-project',
    title: 'Security run ownership',
    status: 'ready',
    runRefs: [internalRun.id]
  })
  const renderer = await workflowApi.listWorkflowLedger({}, userData)
  const rendererRun = renderer.runs.items[0]
  assert(rendererRun && !('taskRun' in rendererRun), 'renderer Ledger query must omit TaskRun payload')
  assert(typeof rendererRun?.taskRunDigest === 'string' && rendererRun.taskRunDigest.length === 64, 'renderer Run must expose a payload digest')
  assert(!('error' in rendererRun), 'renderer Run must not expose raw error text')

  process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173/'
  const trustedFrame = { url: process.env.ELECTRON_RENDERER_URL }
  const trustedSender = {
    id: 7,
    mainFrame: trustedFrame,
    getURL: () => process.env.ELECTRON_RENDERER_URL,
    isDestroyed: () => false
  }
  electronStub.windows.push({ webContents: trustedSender })
  const trustedEvent = { sender: trustedSender, senderFrame: trustedFrame }
  const listHandler = globalThis.__workflowHandlers.get('workflowLedger:list')
  assert(typeof listHandler === 'function', 'workflow Ledger list IPC handler must register')
  await assertRejects(
    Promise.resolve().then(() => listHandler({ sender: { getURL: () => 'https://remote.invalid' }, senderFrame: { url: 'https://remote.invalid' } }, {})),
    'not trusted',
    'workflow Ledger IPC must reject an unowned sender'
  )
  await assertRejects(
    Promise.resolve().then(() => listHandler(trustedEvent, { unexpected: true })),
    '未知字段',
    'workflow Ledger scope must reject unknown fields'
  )
  await assertRejects(
    Promise.resolve().then(() => listHandler(trustedEvent, { entityType: 'invalid' })),
    'entityType',
    'workflow Ledger scope must reject invalid entity types'
  )
  await assertRejects(
    Promise.resolve().then(() => listHandler(trustedEvent, { limit: 0 })),
    'limit',
    'workflow Ledger scope must reject invalid limits'
  )
  const undefinedPaging = await listHandler(trustedEvent, { limit: undefined, cursor: undefined })
  assert(undefinedPaging && undefinedPaging.runs.items[0] && !('taskRun' in undefinedPaging.runs.items[0]), 'undefined paging fields must normalize safely')

  const createEvidenceHandler = globalThis.__workflowHandlers.get('workflowLedger:createEvidence')
  const listEvidenceHandler = globalThis.__workflowHandlers.get('workflowLedger:listEvidence')
  const queryEvidenceHandler = globalThis.__workflowHandlers.get('workflowLedger:queryEvidence')
  const verifyEvidenceHandler = globalThis.__workflowHandlers.get('workflowLedger:verifyEvidence')
  assert(typeof createEvidenceHandler === 'function', 'workflow evidence create IPC handler must register')
  assert(typeof listEvidenceHandler === 'function', 'workflow evidence list IPC handler must register')
  assert(typeof queryEvidenceHandler === 'function', 'workflow evidence query IPC handler must register')
  assert(typeof verifyEvidenceHandler === 'function', 'workflow evidence verify IPC handler must register')
  const evidenceInput = {
    evidenceId: 'security-evidence',
    projectId: 'security-project',
    runId: 'security-run',
    kind: 'test_result',
    title: 'Security evidence fixture',
    contentDigest: 'a'.repeat(64)
  }
  await assertRejects(
    Promise.resolve().then(() => createEvidenceHandler(trustedEvent, { ...evidenceInput, source: 'runtime' })),
    '未知字段',
    'renderer must not self-assert workflow evidence provenance'
  )
  const createdEvidence = await createEvidenceHandler(trustedEvent, evidenceInput)
  assert(createdEvidence.source === 'runtime', 'renderer evidence must use a non-human main-process source')
  assert(createdEvidence.verifier === 'renderer-ipc', 'renderer evidence must use a non-human verifier')
  const replayedEvidence = await createEvidenceHandler(trustedEvent, evidenceInput)
  assert(replayedEvidence.seq === createdEvidence.seq, 'renderer evidence retry must be idempotent')
  const listedEvidence = await listEvidenceHandler(trustedEvent, { evidenceId: evidenceInput.evidenceId })
  assert(listedEvidence.length === 1, 'workflow evidence list IPC must return the persisted record')
  const evidencePage = await queryEvidenceHandler(trustedEvent, { projectId: evidenceInput.projectId, limit: 1 })
  assert(evidencePage.items.length === 1 && evidencePage.total === 1 && evidencePage.hasMore === false,
    'workflow evidence query IPC must return page metadata')
  await assertRejects(
    Promise.resolve().then(() => queryEvidenceHandler(trustedEvent, { limit: 0 })),
    'limit',
    'workflow evidence query IPC must reject invalid limits'
  )
  await assertRejects(
    Promise.resolve().then(() => queryEvidenceHandler(trustedEvent, { cursor: 'not-a-cursor' })),
    'cursor',
    'workflow evidence query IPC must reject invalid cursors'
  )
  const verifiedEvidence = await verifyEvidenceHandler(trustedEvent)
  assert(verifiedEvidence.valid === true && verifiedEvidence.count === 1, 'workflow evidence verification IPC must verify the chain')

  await snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => {
    workflowStore.setupWorkflowLedgerSchema(db)
    workflowStore.registerWorkflowArtifact(db, {
      id: 'security-artifact-a',
      kind: 'report',
      title: 'Security fixture A',
      digest: 'sha256:security-a',
      createdAt: 200,
      updatedAt: 200
    })
    workflowStore.registerWorkflowArtifact(db, {
      id: 'security-artifact-b',
      kind: 'report',
      title: 'Security fixture B',
      digest: 'sha256:security-b',
      createdAt: 201,
      updatedAt: 201
    })
    graph.registerWorkflowArtifactEdge(db, {
      id: 'security-edge-safe',
      fromArtifactId: 'security-artifact-a',
      toArtifactId: 'security-artifact-b',
      relation: 'derived_from',
      metadata: { visible: 'audit metadata' },
      createdAt: 202,
      updatedAt: 202
    })
    graph.recordWorkflowArtifactLocation(db, {
      id: 'security-location-safe',
      artifactId: 'security-artifact-a',
      kind: 'url',
      uri: 'https://example.test/report?view=1',
      metadata: { visible: true },
      createdAt: 203,
      updatedAt: 203
    })
  })

  await assertRejects(
    snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => graph.registerWorkflowArtifactEdge(db, {
      id: 'security-edge-secret',
      fromArtifactId: 'security-artifact-a',
      toArtifactId: 'security-artifact-b',
      relation: 'supports',
      metadata: { credential: canary }
    })),
    canary,
    'graph edge secret metadata must fail closed without echoing the canary'
  )
  await assertRejects(
    snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => graph.recordWorkflowArtifactLocation(db, {
      id: 'security-location-userinfo',
      artifactId: 'security-artifact-a',
      kind: 'url',
      uri: 'https://user:pass@example.test/report'
    })),
    'url-userinfo',
    'graph location URI userinfo must fail closed'
  )
  await assertRejects(
    snapshotStore.mutateTaskSnapshotDatabase(userData, (db) => graph.recordWorkflowArtifactLocation(db, {
      id: 'security-location-query',
      artifactId: 'security-artifact-a',
      kind: 'url',
      uri: `https://example.test/report?token=${canary}`
    })),
    canary,
    'graph location credential query must fail closed without echoing the canary'
  )
  await assertRejects(
    workflowApi.createWorkflowArtifact({
      id: 'security-artifact-secret',
      kind: 'report',
      title: 'Must reject',
      digest: 'sha256:security-secret',
      uri: `https://example.test/report?token=${canary}`,
      metadata: { visible: 'safe' }
    }, userData),
    canary,
    'artifact URI query must fail closed without echoing the canary'
  )

  const graphSelection = await snapshotStore.readTaskSnapshotDatabase(userData, (db) => ({
    edges: graph.selectWorkflowArtifactEdges(db, {}),
    locations: graph.selectWorkflowArtifactLocations(db, {})
  }))
  assertEqual(graphSelection.edges.total, 1, 'rejected edge must not persist')
  assertEqual(graphSelection.locations.total, 1, 'rejected locations must not persist')
  assertEqual((await workflowApi.verifyPersistedWorkflowLedger(userData)).valid, true, 'security fixtures must leave a valid Ledger')
  await assertAcceptanceEvidenceEventBindings({ workflowApi, workflowStore, snapshotStore, canary })
  console.log('workflow ledger security smoke: PASS')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compileSources() {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/task/task-snapshot.ts',
      'src/main/task/workflow-ledger-api.ts',
      'src/main/task/workflow-ledger-artifact-graph.ts',
      'src/main/project-workspace/store.ts',
      'src/main/ipc/workflow-ledger-handlers.ts',
      '--outDir', outDir,
      '--target', 'ES2022',
      '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext',
      '--types', 'node',
      '--skipLibCheck',
      '--esModuleInterop'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )
}

function assertBundledRendererPaths() {
  const bundlePath = path.join(repoRoot, 'out', 'main', 'index.js')
  const rendererPath = path.join(repoRoot, 'out', 'renderer', 'index.html')
  assert(existsSync(bundlePath), 'main bundle is missing; run npm run build before this security smoke')
  assert(existsSync(rendererPath), 'renderer bundle is missing; run npm run build before this security smoke')

  const sourcePaths = [
    path.join(repoRoot, 'src', 'main', 'ipc', 'workflow-ledger-handlers.ts'),
    path.join(repoRoot, 'src', 'main', 'ipc', 'digital-worker-handlers.ts')
  ]
  const latestSourceMtime = Math.max(...sourcePaths.map((sourcePath) => statSync(sourcePath).mtimeMs))
  assert(
    statSync(bundlePath).mtimeMs >= latestSourceMtime,
    'main bundle is stale; run npm run build before this security smoke'
  )

  const bundle = readFileSync(bundlePath, 'utf8')
  assertBundleTrustHelperPath(bundle, 'Workflow ledger IPC sender is not trusted', 'Workflow Ledger')
  assertBundleTrustHelperPath(bundle, 'DigitalWorker IPC sender is not trusted', 'DigitalWorker')

  const resolvedRendererUrl = pathToFileURL(path.resolve(path.dirname(bundlePath), '../renderer/index.html')).href
  assertEqual(
    resolvedRendererUrl,
    pathToFileURL(rendererPath).href,
    'bundled IPC renderer path must resolve to the renderer loaded by main/index'
  )
}

function assertBundleTrustHelperPath(bundle, marker, label) {
  const markerIndex = bundle.indexOf(marker)
  assert(markerIndex >= 0, `${label} trust helper is missing from the main bundle`)
  const section = bundle.slice(markerIndex, markerIndex + 4_000)
  assert(
    section.includes('../renderer/index.html') && !section.includes('../../renderer/index.html'),
    `${label} bundled trust helper must resolve renderer/index.html from out/main`
  )
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  const source = [
    `const windows = globalThis.__workflowWindows ??= []`,
    `export const app = { getPath: () => ${JSON.stringify(userData)} }`,
    `export const ipcMain = { handle: (name, handler) => { globalThis.__workflowHandlers ??= new Map(); globalThis.__workflowHandlers.set(name, handler) } }`,
    `export const BrowserWindow = { getAllWindows: () => globalThis.__workflowWindows ?? [] }`,
    `export { windows }`
  ].join('\n') + '\n'
  require('node:fs').writeFileSync(path.join(electronDir, 'index.js'), source)
  require('node:fs').writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

function findCompiledModule(root, name) {
  for (const entry of require('node:fs').readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModule(fullPath, name)
      if (found) return found
    } else if (entry.isFile() && entry.name === name) {
      return fullPath
    }
  }
  return undefined
}

function buildMeta(id, projectId) {
  return {
    id,
    title: `Security ${id}`,
    cwd: userData,
    projectId,
    model: 'fixture-model',
    providerId: 'fixture-provider',
    permissionMode: 'default',
    status: 'running',
    sdkSessionId: `sdk-${id}`,
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: 1
  }
}

async function assertAcceptanceEvidenceEventBindings({ workflowApi, workflowStore, snapshotStore, canary }) {
  const workflowRoot = path.join(tempRoot, 'workflow-evidence-event-binding')
  mkdirSync(workflowRoot, { recursive: true })
  const workItem = await workflowApi.createWorkflowWorkItem({
    id: 'security-workflow-event-item',
    projectId: 'security-workflow-event-project',
    title: 'Workflow evidence event binding',
    type: 'testing',
    status: 'verifying'
  }, workflowRoot)
  const pending = await workflowApi.saveWorkflowAcceptance({
    id: 'security-workflow-event-acceptance',
    projectId: workItem.projectId,
    workItemId: workItem.id,
    criteria: ['Workflow evidence retains its recorded event']
  }, workflowRoot)
  const evidence = await workflowApi.createWorkflowEvidence({
    evidenceId: 'security-workflow-event-evidence',
    projectId: workItem.projectId,
    workItemId: workItem.id,
    kind: 'test_result',
    title: 'Workflow event binding evidence',
    contentDigest: 'c'.repeat(64)
  }, workflowRoot)
  await workflowApi.createWorkflowEvidenceLink({
    id: 'security-workflow-event-link',
    evidenceId: evidence.evidenceId,
    evidenceOrigin: 'workflow',
    projectId: workItem.projectId,
    acceptanceId: pending.id,
    relation: 'verifies'
  }, workflowRoot)
  const verifying = await workflowApi.saveWorkflowAcceptance({
    ...pending,
    status: 'verifying',
    evidenceRefs: [evidence.evidenceId],
    revision: pending.revision + 1
  }, workflowRoot)
  const passed = await workflowApi.saveWorkflowAcceptance({
    ...verifying,
    status: 'passed',
    verifier: 'workflow-ledger-security-smoke',
    verifiedAt: 300,
    revision: verifying.revision + 1,
    updatedAt: 300
  }, workflowRoot)
  assertEqual(passed.status, 'passed', 'verified Workflow evidence event binding must pass normally')
  await snapshotStore.mutateTaskSnapshotDatabase(workflowRoot, (db) => {
    db.run('DELETE FROM workflow_events WHERE event_id = ?', [`workflow:evidence-record:${evidence.evidenceId}`])
    assertAcceptanceEvidenceRejects(
      () => workflowStore.projectWorkflowAcceptance(db, passed),
      'workflow_evidence_event_invalid',
      undefined,
      'deleted Workflow evidence event must fail Acceptance resolution closed'
    )
  })

  const taskRoot = path.join(tempRoot, 'task-evidence-event-binding')
  mkdirSync(taskRoot, { recursive: true })
  const taskRun = buildRun('security-task-event-run', 'security-task-event-session', 'security-task-event-task', 1, 400)
  await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
    meta: {
      ...buildMeta('security-task-event-session', 'security-task-event-project'),
      childTaskId: 'security-task-event-task'
    },
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run: taskRun
  }), taskRoot)
  const taskLedger = await workflowApi.listPersistedWorkflowLedger({}, taskRoot)
  const projectedRun = taskLedger.runs.items.find((record) => record.id === taskRun.id)
  const projectedWorkItem = taskLedger.workItems.items.find((record) => record.id === projectedRun?.workItemId)
  assert(projectedRun && projectedWorkItem, 'Task evidence event fixture must project its Run and WorkItem')
  const taskPending = await workflowApi.saveWorkflowAcceptance({
    id: 'security-task-event-acceptance',
    projectId: projectedRun.projectId,
    workItemId: projectedWorkItem.id,
    criteria: ['Task evidence retains its Effect event binding']
  }, taskRoot)
  const taskEvidenceId = `evidence-${taskRun.id}`
  await workflowApi.createWorkflowEvidenceLink({
    id: 'security-task-event-link',
    evidenceId: taskEvidenceId,
    projectId: projectedRun.projectId,
    runId: projectedRun.id,
    acceptanceId: taskPending.id,
    relation: 'verifies'
  }, taskRoot)
  const taskVerifying = await workflowApi.saveWorkflowAcceptance({
    ...taskPending,
    status: 'verifying',
    evidenceRefs: [taskEvidenceId],
    revision: taskPending.revision + 1
  }, taskRoot)
  const taskPassed = await workflowApi.saveWorkflowAcceptance({
    ...taskVerifying,
    status: 'passed',
    verifier: 'workflow-ledger-security-smoke',
    verifiedAt: 410,
    revision: taskVerifying.revision + 1,
    updatedAt: 410
  }, taskRoot)
  assertEqual(taskPassed.status, 'passed', 'verified Task evidence event binding must pass normally')
  await snapshotStore.mutateTaskSnapshotDatabase(taskRoot, (db) => {
    db.run(
      'UPDATE workflow_events SET payload = ? WHERE event_id = ?',
      [JSON.stringify({ tampered: canary }), `workflow:evidence:${taskEvidenceId}`]
    )
    assertAcceptanceEvidenceRejects(
      () => workflowStore.projectWorkflowAcceptance(db, taskPassed),
      'task_evidence_event_invalid',
      canary,
      'tampered Task evidence event must fail Acceptance resolution closed'
    )
  })
}

function buildRun(id, sessionId, taskId, revision, updatedAt) {
  return {
    schemaVersion: 1,
    id,
    sessionId,
    taskId,
    status: 'executing',
    revision,
    attempt: 1,
    recoveryCount: 0,
    createdAt: 1,
    updatedAt,
    steps: [],
    toolExecutions: [],
    effects: [{
      schemaVersion: 1,
      id: `effect-${id}`,
      effectKey: `effect-key-${id}`,
      resourceKey: `resource-key-${id}`,
      sessionId,
      runId: id,
      toolUseId: `tool-${id}`,
      toolName: 'fixture_tool',
      generation: 1,
      revision,
      status: 'confirmed',
      reconcilability: 'queryable',
      target: { kind: 'unsupported', toolName: 'fixture_tool' },
      targetDigest: `target-${id}`,
      intentDigest: `intent-${id}`,
      inputDigest: `input-${id}`,
      evidence: [{
        id: `evidence-${id}`,
        kind: 'execution_result',
        digest: `evidence-digest-${id}`,
        observedAt: 1,
        verifier: 'workflow-ledger-security-smoke',
        generation: 1
      }],
      createdAt: 1,
      updatedAt
    }]
  }
}

async function assertRejects(promise, needle, message) {
  try {
    await promise
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    if (needle.startsWith('sk-')) {
      assert(!text.includes(needle), `${message}: raw canary was echoed`)
      return
    }
    if (text.includes(needle)) {
      return
    }
    throw new Error(`${message}: unexpected error ${text}`)
  }
  throw new Error(`${message}: operation unexpectedly succeeded`)
}

function assertThrows(fn, needle, message) {
  try {
    fn()
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    if (needle.startsWith('sk-')) {
      assert(!text.includes(needle), `${message}: raw canary was echoed`)
      return
    }
    assert(text.includes(needle), `${message}: expected ${needle}, got ${text}`)
    return
  }
  throw new Error(`${message}: operation unexpectedly succeeded`)
}

function assertAcceptanceEvidenceRejects(fn, reason, secret, message) {
  try {
    fn()
  } catch (error) {
    assertEqual(error?.code, 'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID', `${message}: stable error code`)
    assertEqual(error?.details?.reason, reason, `${message}: stable reason`)
    assert(typeof error?.details?.cause === 'string' && error.details.cause.length > 0, `${message}: cause is missing`)
    if (secret) {
      const diagnostic = JSON.stringify({ message: error?.message, details: error?.details })
      assert(!diagnostic.includes(secret), `${message}: raw event content was echoed`)
    }
    return
  }
  throw new Error(`${message}: operation unexpectedly succeeded`)
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
