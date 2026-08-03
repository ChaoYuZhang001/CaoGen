import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter)
require('node:module').Module._initPaths()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-project-deletion-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
const externalRoot = path.join(tempRoot, 'external-project-resource')
const credentialCanary = 'SYNTHETIC_PROJECT_DELETION_SECRET_CANARY'

try {
  mkdirSync(userData, { recursive: true })
  mkdirSync(externalRoot, { recursive: true })
  writeFileSync(path.join(externalRoot, 'must-survive.txt'), 'external owner\n')
  compileSources()
  installElectronStub()

  const workspaceApi = await importCompiled('main/project-workspace/index.js')
  const workerApi = await importCompiled('main/digital-worker/index.js')
  const aggregateApi = await importCompiled('main/project-aggregate/index.js')
  const supervisorApi = await importCompiled('main/task/supervisor-state.js')
  const deletionApi = await importCompiled('main/data-lifecycle/project-deletion-coordinator.js')
  const sessionPurgeApi = await importCompiled('main/data-lifecycle/project-session-purge.js')
  const journalApi = await importCompiled('main/data-lifecycle/project-deletion-journal.js')
  const workflowPurgeApi = await importCompiled('main/data-lifecycle/workflow-project-purge.js')
  const snapshotApi = await importCompiled('main/task/task-snapshot.js')
  const modelAttemptApi = await importCompiled('main/task/model-attempt-api.js')
  const workflowApi = await importCompiled('main/task/workflow-ledger-api.js')
  const readinessApi = await importCompiled('main/task/workflow-ledger-readiness.js')
  const continuityApi = await importCompiled('main/task/workflow-ledger-migration-continuity.js')
  const authorizedPurgeApi = await importCompiled('main/task/workflow-ledger-authorized-purge.js')

  await verifyWorkflowChainPurge({
    workflowPurgeApi,
    snapshotApi,
    modelAttemptApi,
    workflowApi,
    readinessApi,
    continuityApi,
    authorizedPurgeApi
  })
  verifyActiveSessionPurgeFormat(sessionPurgeApi)

  const workspaceStore = await new workspaceApi.ProjectWorkspaceStore(userData).open()
  const alpha = await workspaceStore.createWorkspace({
    id: 'project-alpha',
    name: 'Alpha',
    resources: [{ id: 'alpha-external', kind: 'directory', path: externalRoot }]
  })
  const bravo = await workspaceStore.createWorkspace({ id: 'project-bravo', name: 'Bravo' })
  const workerStore = new workerApi.DigitalWorkerStore(userData)
  const role = await workerStore.createRoleTemplate({
    id: 'role-project-deletion',
    name: 'Deletion fixture',
    purpose: 'Deletion fixture',
    instructions: 'Fixture only'
  })
  await workerStore.createDigitalWorker({
    id: 'worker-alpha',
    projectId: alpha.id,
    roleTemplateId: role.id,
    displayName: 'Alpha Worker',
    memoryNamespace: 'project:alpha:worker',
    toolPolicy: { allowedTools: ['search'], clientSecret: credentialCanary },
    budgetPolicy: { maxUsd: 1 },
    concurrencyLimit: 1
  })
  await workerStore.createDigitalWorker({
    id: 'worker-bravo',
    projectId: bravo.id,
    roleTemplateId: role.id,
    displayName: 'Bravo Worker',
    memoryNamespace: 'project:bravo:worker',
    toolPolicy: { allowedTools: ['search'] },
    budgetPolicy: { maxUsd: 1 },
    concurrencyLimit: 1
  })
  await aggregateApi.createProjectMemoryDraft(alpha.id, path.join(userData, 'learning'), {
    id: 'memory-alpha',
    source: 'project-deletion-smoke',
    payload: {
      memoryKind: 'decision',
      title: 'Alpha memory',
      body: 'Project-owned memory',
      reason: 'Deletion regression'
    }
  })
  const supervisor = new supervisorApi.SupervisorStateStore(userData)
  await supervisor.createRun({
    id: 'supervisor-alpha',
    projectId: alpha.id,
    workItemId: 'work-item-alpha',
    maxRetries: 1
  })
  await supervisor.createRun({
    id: 'supervisor-bravo',
    projectId: bravo.id,
    workItemId: 'work-item-bravo',
    maxRetries: 1
  })
  seedSessionData(alpha.id)

  const deletedAlpha = await workspaceStore.deleteWorkspace(alpha.id, { expectedRevision: alpha.revision })
  let injected = false
  await assertRejects(
    deletionApi.purgeProjectPermanently(alpha.id, userData, { expectedRevision: deletedAlpha.revision }, {
      afterPhase: (phase) => {
        if (!injected && phase === 'project_stores_purged') {
          injected = true
          throw new Error('synthetic crash after project stores')
        }
      }
    }),
    (error) => String(error?.message).includes('synthetic crash'),
    'failure injection must interrupt after a durable phase commit'
  )
  assert((await workspaceStore.getWorkspace(alpha.id))?.status === 'deleted', 'workspace is the final commit and survives the injected crash')

  const pending = new journalApi.ProjectDeletionJournal(userData).listPending()
  assertEqual(pending.length, 1, 'one deletion journal remains pending after crash')
  assertEqual(pending[0].phase, 'project_stores_purged', 'journal persists the exact completed phase')
  const resumed = await deletionApi.resumeProjectDeletions(userData)
  assertEqual(resumed.length, 1, 'restart resumes one pending deletion')
  assertEqual(resumed[0].phase, 'completed', 'resumed deletion completes')
  assert(Object.values(resumed[0].residuals).every((value) => value === 0), 'residual scan is zero')
  assert(/^[a-f0-9]{64}$/.test(resumed[0].proofDigest), 'completed deletion returns a proof digest')
  const verifiedAlphaProof = await deletionApi.verifyProjectDeletionProof(userData, resumed[0].operationId)
  assertEqual(verifiedAlphaProof.proofDigest, resumed[0].proofDigest, 'restart proof verification matches deletion receipt')
  assert(verifiedAlphaProof.proof.backup.readbackVerified === true, 'private aggregate backup passes readback')
  assert(Object.values(verifiedAlphaProof.proof.residuals).every((value) => value === 0),
    'durable proof binds a zero residual scan')
  assertEqual(verifiedAlphaProof.proof.externalResources.before.length, 1, 'proof inventories external resources')
  assertEqual(verifiedAlphaProof.proof.externalResources.before[0].state, 'directory',
    'proof captures the pre-delete external directory state')
  assertEqual(verifiedAlphaProof.proof.externalResources.after[0].state, 'directory',
    'proof confirms the post-delete external directory state')
  assertEqual((await deletionApi.resumeProjectDeletions(userData)).length, 0, 'completed journal is not replayed')

  const reopened = await new workspaceApi.ProjectWorkspaceStore(userData).open()
  assertEqual(await reopened.getWorkspace(alpha.id), undefined, 'alpha is absent after restart readback')
  assert((await reopened.getWorkspace(bravo.id))?.id === bravo.id, 'bravo survives alpha deletion')
  const workers = workerStore.read().workers
  assert(!workers.some((worker) => worker.projectId === alpha.id), 'alpha DigitalWorkers are purged')
  assert(workers.some((worker) => worker.projectId === bravo.id), 'bravo DigitalWorkers remain')
  assertEqual((await supervisor.listRuns({ projectId: alpha.id })).length, 0, 'alpha Supervisor runs are purged')
  assertEqual((await supervisor.listRuns({ projectId: bravo.id })).length, 1, 'bravo Supervisor run remains')
  assert(statSync(path.join(externalRoot, 'must-survive.txt')).isFile(), 'external resource remains untouched')
  const activeSessionRegistry = JSON.parse(readFileSync(path.join(userData, 'active-sessions.json'), 'utf8'))
  assertEqual(activeSessionRegistry.schemaVersion, 1, 'legacy active session registry migrates during Project purge')
  assertEqual(activeSessionRegistry.sessions.length, 0, 'purged Project leaves no active session records')

  const backup = resumed[0].backupPath
  const backupText = readFileSync(backup, 'utf8')
  assert(!backupText.includes(credentialCanary), 'private backup contains no credential canary')
  assert(backupText.includes('[REDACTED]'), 'private backup records explicit redaction')
  if (process.platform !== 'win32') assertEqual(statSync(backup).mode & 0o777, 0o600, 'private backup mode')
  const proofText = readFileSync(resumed[0].proofPath, 'utf8')
  assert(!proofText.includes(credentialCanary), 'private deletion proof contains no credential canary')
  if (process.platform !== 'win32') assertEqual(statSync(resumed[0].proofPath).mode & 0o777, 0o600, 'private proof mode')

  await assertRejects(
    deletionApi.purgeProjectPermanently(bravo.id, userData),
    (error) => String(error?.message).includes('must be moved to deleted state'),
    'active Project cannot be permanently deleted'
  )
  const deletedBravo = await reopened.deleteWorkspace(bravo.id, { expectedRevision: bravo.revision })
  const beforeStaleAttempt = digestTree(userData)
  await assertRejects(
    deletionApi.purgeProjectPermanently(bravo.id, userData, { expectedRevision: deletedBravo.revision - 1 }),
    (error) => String(error?.message).includes('stale_revision'),
    'stale revision fails before backup or mutation'
  )
  assertEqual(digestTree(userData), beforeStaleAttempt, 'stale revision has zero side effects')

  let proofCrashInjected = false
  await assertRejects(
    deletionApi.purgeProjectPermanently(bravo.id, userData, { expectedRevision: deletedBravo.revision }, {
      afterPhase: (phase) => {
        if (!proofCrashInjected && phase === 'proof_written') {
          proofCrashInjected = true
          throw new Error('synthetic crash after deletion proof')
        }
      }
    }),
    (error) => String(error?.message).includes('synthetic crash after deletion proof'),
    'failure injection must interrupt after the durable proof boundary'
  )
  const proofPending = new journalApi.ProjectDeletionJournal(userData).listPending()
  assertEqual(proofPending.length, 1, 'proof-boundary crash leaves one resumable deletion')
  assertEqual(proofPending[0].phase, 'proof_written', 'journal persists the proof-written phase')
  const proofResumed = await deletionApi.resumeProjectDeletions(userData)
  assertEqual(proofResumed.length, 1, 'restart resumes proof-written deletion')
  const verifiedBravoProof = await deletionApi.verifyProjectDeletionProof(userData, proofResumed[0].operationId)
  assertEqual(verifiedBravoProof.proofDigest, proofResumed[0].proofDigest, 'proof-written restart verifies its receipt')

  const tamperedProof = JSON.parse(proofText)
  tamperedProof.residuals.workspace = 1
  writeFileSync(resumed[0].proofPath, `${JSON.stringify(tamperedProof)}\n`)
  await assertRejects(
    deletionApi.verifyProjectDeletionProof(userData, resumed[0].operationId),
    (error) => String(error?.message).includes('proof'),
    'tampered deletion proof fails closed'
  )
  writeFileSync(resumed[0].proofPath, proofText)

  const tamperedBackup = JSON.parse(backupText)
  tamperedBackup.aggregateExport.aggregate.workspace.name = 'tampered backup'
  writeFileSync(backup, `${JSON.stringify(tamperedBackup)}\n`)
  await assertRejects(
    deletionApi.verifyProjectDeletionProof(userData, resumed[0].operationId),
    (error) => String(error?.message).includes('backup') || String(error?.message).includes('aggregate'),
    'tampered aggregate backup fails proof readback'
  )
  console.log('project permanent deletion smoke: PASS')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function seedSessionData(projectId) {
  const session = {
    id: 'session-alpha',
    sdkSessionId: 'sdk-alpha',
    workspaceId: projectId,
    projectId,
    title: 'Alpha session',
    cwd: externalRoot
  }
  writeFileSync(path.join(userData, 'sessions.json'), `${JSON.stringify({ schemaVersion: 1, entries: [session] }, null, 2)}\n`)
  writeFileSync(path.join(userData, 'active-sessions.json'), `${JSON.stringify([session], null, 2)}\n`)
  mkdirSync(path.join(userData, 'transcripts'), { recursive: true })
  writeFileSync(path.join(userData, 'transcripts', 'sdk-alpha.jsonl'), '{"fixture":true}\n')
  mkdirSync(path.join(userData, 'event-receipts'), { recursive: true })
  writeFileSync(path.join(userData, 'event-receipts', 'sdk-alpha.jsonl'), '{"fixture":true}\n')
  mkdirSync(path.join(userData, 'attachments', 'session-alpha'), { recursive: true })
  writeFileSync(path.join(userData, 'attachments', 'session-alpha', 'fixture.txt'), 'fixture\n')
  mkdirSync(path.join(userData, 'task-plans'), { recursive: true })
  writeFileSync(path.join(userData, 'task-plans', 'task-plan-contracts.json'), `${JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    sessions: {
      'session-alpha': {
        sessionId: 'session-alpha',
        versions: [{ binding: { sessionId: 'session-alpha', workspaceId: projectId } }],
        approvalEvents: []
      }
    }
  }, null, 2)}\n`)
}

function verifyActiveSessionPurgeFormat(sessionPurgeApi) {
  const v1Root = path.join(tempRoot, 'active-session-purge-v1')
  mkdirSync(v1Root, { recursive: true })
  writeFileSync(path.join(v1Root, 'active-sessions.json'), `${JSON.stringify({
    schemaVersion: 1,
    sessions: [
      { id: 'purge-target', projectId: 'project-purge-target' },
      { id: 'preserved-session', projectId: 'project-preserved' }
    ]
  }, null, 2)}\n`)
  const result = sessionPurgeApi.purgeProjectSessionData(v1Root, 'project-purge-target', [], [])
  assertEqual(result.removedRecords.activeSessions, 1, 'v1 active-session purge removes only the target record')
  const preserved = JSON.parse(readFileSync(path.join(v1Root, 'active-sessions.json'), 'utf8'))
  assertEqual(preserved.schemaVersion, 1, 'v1 active-session purge preserves the envelope version')
  assertEqual(preserved.sessions.length, 1, 'v1 active-session purge preserves unrelated records')
  assertEqual(preserved.sessions[0].id, 'preserved-session', 'v1 active-session purge preserves record identity')

  const futureRoot = path.join(tempRoot, 'active-session-purge-future')
  mkdirSync(futureRoot, { recursive: true })
  writeFileSync(path.join(futureRoot, 'active-sessions.json'), '{"schemaVersion":2,"sessions":[]}\n')
  const before = digestTree(futureRoot)
  assertThrows(
    () => sessionPurgeApi.purgeProjectSessionData(futureRoot, 'project-purge-target', [], []),
    (error) => String(error?.message).includes('Unsupported Active Session Registry schema version: 2'),
    'future active-session schema blocks Project purge'
  )
  assertEqual(digestTree(futureRoot), before, 'future active-session schema blocks all Project purge writes')
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/data-lifecycle/project-deletion-coordinator.ts',
    'src/main/project-workspace/index.ts',
    'src/main/digital-worker/index.ts',
    'src/main/project-aggregate/index.ts',
    'src/main/task/supervisor-state.ts',
    'src/main/task/model-attempt-api.ts',
    'src/main/task/workflow-ledger-api.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

async function verifyWorkflowChainPurge({
  workflowPurgeApi,
  snapshotApi,
  modelAttemptApi,
  workflowApi,
  readinessApi,
  continuityApi,
  authorizedPurgeApi
}) {
  const root = path.join(tempRoot, 'workflow-chain')
  mkdirSync(root, { recursive: true })
  for (const suffix of ['alpha', 'bravo']) {
    const sessionId = `chain-session-${suffix}`
    const runId = `chain-run-${suffix}`
    const taskId = `chain-task-${suffix}`
    const projectId = `chain-project-${suffix}`
    const run = buildWorkflowRun(runId, sessionId, taskId, suffix === 'alpha' ? 100 : 200)
    await snapshotApi.saveTaskSnapshot(snapshotApi.buildTaskSnapshot({
      meta: buildWorkflowMeta(sessionId, projectId, taskId, root),
      transcript: [],
      lastSeq: 0,
      eventCount: 0,
      reason: 'created',
      run
    }), root)
    await modelAttemptApi.startPersistedModelAttempt({
      id: `attempt-${suffix}`,
      commandId: `command-${suffix}`,
      requestId: `request-${suffix}`,
      runId,
      providerId: 'fixture-provider',
      model: 'fixture-model',
      protocol: 'openai.responses',
      adapterVersion: 'adapter-v1',
      contextDigest: `sha256:${'a'.repeat(64)}`,
      routeReason: 'Synthetic chain purge regression.',
      keyLabel: 'label:synthetic',
      startedAt: suffix === 'alpha' ? 110 : 210
    }, root)
    if (suffix === 'alpha') {
      await modelAttemptApi.completePersistedModelAttempt('attempt-alpha', {
        commandId: 'command-alpha-complete',
        expectedRevision: 1,
        status: 'failed',
        completedAt: 115,
        outcome: 'rate_limited',
        errorClass: 'provider_rate_limit'
      }, root)
      await modelAttemptApi.startPersistedModelAttempt({
        id: 'attempt-alpha-failover',
        commandId: 'command-alpha-failover',
        requestId: 'request-alpha',
        runId,
        providerId: 'fixture-provider-2',
        model: 'fixture-model-2',
        protocol: 'openai.responses',
        adapterVersion: 'adapter-v1',
        contextDigest: `sha256:${'b'.repeat(64)}`,
        routeReason: 'Synthetic failover chain purge regression.',
        keyLabel: 'label:synthetic-2',
        failoverFromAttemptId: 'attempt-alpha',
        startedAt: 120
      }, root)
    }
  }
  const databasePath = snapshotApi.taskSnapshotsDbFile(root)
  const beforePurge = await readinessApi.assessWorkflowLedgerCanonicalReadinessFile(databasePath, { assessedAt: 1 })
  const result = await workflowPurgeApi.purgeWorkflowProjectData(
    'chain-project-alpha', root, 'chain-purge-alpha', ['chain-session-alpha'])
  assert(result.removed.workflow_events > 0, 'alpha workflow events are removed and the remaining chain is rebuilt')
  assert(result.removed.task_evidence > 0, 'alpha Task Evidence is removed and the remaining chain is rebuilt')
  assert(result.removed.model_attempts > 0, 'alpha ModelAttempt is removed and the remaining chain is rebuilt')
  assertEqual((await workflowPurgeApi.scanWorkflowProjectResiduals(
    'chain-project-alpha', root, ['chain-session-alpha'])).total, 0, 'alpha workflow residual scan')
  const bravoLedger = await workflowApi.listPersistedWorkflowLedger({ projectId: 'chain-project-bravo' }, root)
  assertEqual(bravoLedger.runs.total, 1, 'bravo Workflow Run survives alpha chain rebuild')
  assertEqual((await modelAttemptApi.queryPersistedModelAttempts({ projectId: 'chain-project-bravo' }, root)).total, 1,
    'bravo ModelAttempt survives alpha chain rebuild')
  await modelAttemptApi.verifyPersistedModelAttemptLedger(root)
  await workflowApi.verifyPersistedWorkflowLedger(root)
  const afterPurge = await readinessApi.assessWorkflowLedgerCanonicalReadinessFile(databasePath, { assessedAt: 2 })
  continuityApi.assertCommittedWorkflowLedgerTargetContinuity({
    currentVersion: 8,
    current: afterPurge,
    committed: { journal: { toVersion: 8, readiness: beforePurge } }
  })
  const firstAuthorization = await snapshotApi.readTaskSnapshotDatabase(
    root,
    (db) => authorizedPurgeApi.verifyWorkflowLedgerAuthorizedPurges(db)
  )
  assertEqual(firstAuthorization.operations, 1, 'one authorized Project purge operation is durable')
  assertEqual(firstAuthorization.removed.taskRuns, result.removed.task_runs, 'authorized TaskRun removal total')
  assertEqual(firstAuthorization.removed.workflowRuns, result.removed.workflow_runs, 'authorized Workflow Run removal total')
  assertEqual(firstAuthorization.removed.workflowEvents, result.removed.workflow_events, 'authorized Workflow Event removal total')
  assertEqual(firstAuthorization.removed.taskEvidence, result.removed.task_evidence, 'authorized Task Evidence removal total')
  await workflowPurgeApi.purgeWorkflowProjectData(
    'chain-project-alpha', root, 'chain-purge-alpha', ['chain-session-alpha'])
  assertEqual((await workflowApi.listPersistedWorkflowLedger({ projectId: 'chain-project-bravo' }, root)).runs.total, 1,
    'idempotent replay preserves bravo after restart readback')
  const replayedAuthorization = await snapshotApi.readTaskSnapshotDatabase(
    root,
    (db) => authorizedPurgeApi.verifyWorkflowLedgerAuthorizedPurges(db)
  )
  assertEqual(replayedAuthorization.operations, 1, 'same operationId does not double-count authorized removal')
  assertEqual(replayedAuthorization.lastDigest, firstAuthorization.lastDigest, 'idempotent replay preserves purge digest')

  await snapshotApi.mutateTaskSnapshotDatabase(root, (db) => {
    db.run('UPDATE workflow_authorized_project_purges SET task_runs = task_runs + 1 WHERE seq = 1')
  })
  const tampered = await readinessApi.assessWorkflowLedgerCanonicalReadinessFile(databasePath, { assessedAt: 3 })
  assertEqual(tampered.status, 'blocked', 'tampered authorized purge ledger blocks readiness')
  assert(tampered.diagnostics.some((item) => item.code === 'authorized_project_purge_ledger_corrupt'),
    'tampered authorized purge ledger emits a specific corruption diagnostic')
}

function buildWorkflowMeta(id, projectId, childTaskId, cwd) {
  return {
    id,
    title: id,
    cwd,
    projectId,
    childTaskId,
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

function buildWorkflowRun(id, sessionId, taskId, updatedAt) {
  return {
    schemaVersion: 1,
    id,
    sessionId,
    taskId,
    status: 'executing',
    revision: 1,
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
      revision: 1,
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
        verifier: 'project-permanent-deletion-smoke',
        generation: 1
      }],
      createdAt: 1,
      updatedAt
    }]
  }
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), `export const app = { getPath: () => ${JSON.stringify(userData)} }\n`)
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

function importCompiled(relativePath) {
  return import(pathToFileURL(path.join(outDir, relativePath)).href)
}

function digestTree(root) {
  const hash = createHash('sha256')
  walk(root, root, hash)
  return hash.digest('hex')
}

function walk(root, current, hash) {
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const full = path.join(current, entry.name)
    hash.update(path.relative(root, full))
    if (entry.isDirectory()) walk(root, full, hash)
    else if (entry.isFile()) hash.update(readFileSync(full))
  }
}

async function assertRejects(promise, predicate, label) {
  try {
    await promise
  } catch (error) {
    if (predicate(error)) return
    throw new Error(`${label}: unexpected error ${String(error?.stack ?? error)}`)
  }
  throw new Error(`${label}: expected rejection`)
}

function assertThrows(run, predicate, label) {
  try {
    run()
  } catch (error) {
    if (predicate(error)) return
    throw new Error(`${label}: unexpected error ${String(error?.stack ?? error)}`)
  }
  throw new Error(`${label}: expected failure`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
}
