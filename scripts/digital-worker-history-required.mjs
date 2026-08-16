#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const Module = require('node:module').Module
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-worker-history-'))
const outDir = path.join(tempRoot, 'compiled')
const stateRoot = path.join(tempRoot, 'user-data')
const generatedAt = 20_000
const startedAt = new Date().toISOString()
const runId = startedAt.replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'digital-worker-history')
const reportDir = path.join(reportRoot, runId)
const checks = []

const PROJECT_ID = 'project-worker-history'
const GOAL_ID = 'goal-worker-history'
const WORK_ITEM_ID = 'work-worker-history'
const RUN_ID = 'run-worker-history'
const WORKER_ID = 'worker-history-primary'
const ASSIGNMENT_ID = 'assignment-worker-history'
const ARTIFACT_ID = 'artifact-worker-history'
const EVIDENCE_ID = 'evidence-worker-history'
const ARTIFACT_ONLY_EVIDENCE_ID = 'evidence-worker-history-artifact-only'
const ACCEPTANCE_ID = 'acceptance-worker-history'
const PROMPT_CANARY = 'TEAM005_RAW_PROMPT_MUST_NOT_EXPORT'
const TOOL_ARGUMENT_CANARY = 'TEAM005_TOOL_ARGUMENTS_MUST_NOT_EXPORT'
const ERROR_CANARY = 'TEAM005_RAW_ERROR_BODY_MUST_NOT_EXPORT'
const FOREIGN_CANARY = 'TEAM005_FOREIGN_WORKER_MUST_NOT_EXPORT'
const SENSITIVE_CANARIES = [PROMPT_CANARY, TOOL_ARGUMENT_CANARY, ERROR_CANARY, FOREIGN_CANARY]
let failure

process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter)
Module._initPaths()

try {
  compileSources()
  installElectronStub()
  const api = await loadApi()
  const fixture = await seedFixture(api)
  await check('retirement releases live ownership and blocks all future Assignment creation', async () => {
    assert.equal(fixture.retired.status, 'retired')
    await assertRejects(
      fixture.workerStore.createAssignment({
        id: 'assignment-after-retirement',
        projectId: PROJECT_ID,
        workItemId: WORK_ITEM_ID,
        assigneeKind: 'digital_worker',
        assigneeId: WORKER_ID,
        assignedBy: 'history-gate'
      }),
      (error) => error?.code === 'CONFLICT' && /retired|not active/i.test(String(error?.message)),
      'retired Worker accepted a new Assignment'
    )
  })
  await check('hard deletion rejects any Worker with immutable Assignment or lease history', async () => {
    await assertRejects(
      fixture.workerStore.deleteDigitalWorker(WORKER_ID, fixture.retired.revision),
      (error) => error?.code === 'IMMUTABLE_HISTORY',
      'Worker with retained history was hard deleted'
    )
  })

  injectLegacyAuditCanaries(api.worker.digitalWorkerStorePath(stateRoot))
  const snapshot = await api.worker.buildDigitalWorkerHistory(stateRoot, WORKER_ID, generatedAt)
  const exported = await api.worker.exportDigitalWorkerHistory(stateRoot, WORKER_ID, generatedAt)

  await check('history retains Assignment, lease, Run, Artifact, Evidence, Acceptance, and Audit identity', () => {
    assert.equal(snapshot.schemaVersion, 2)
    assert.equal(snapshot.format, 'caogen.digital-worker-history.v2')
    assert.equal(snapshot.worker.status, 'retired')
    assert.deepEqual(snapshot.assignments.map((item) => item.id), [ASSIGNMENT_ID])
    assert.deepEqual(snapshot.leases.map((item) => item.id), [fixture.lease.id])
    assert.deepEqual(snapshot.runs.map((item) => item.id), [RUN_ID])
    assert.deepEqual(snapshot.artifacts.map((item) => item.id), [ARTIFACT_ID])
    assert(snapshot.evidence.some((item) => item.evidenceId === EVIDENCE_ID))
    const artifactOnlyEvidence = snapshot.evidence.find((item) => item.evidenceId === ARTIFACT_ONLY_EVIDENCE_ID)
    assert(artifactOnlyEvidence)
    assert.equal(artifactOnlyEvidence.runId, undefined)
    assert.equal(artifactOnlyEvidence.artifactId, ARTIFACT_ID)
    assert(snapshot.evidenceLinks.some((item) =>
      item.evidenceId === ARTIFACT_ONLY_EVIDENCE_ID &&
      item.runId === undefined &&
      item.artifactId === ARTIFACT_ID
    ))
    assert.deepEqual(snapshot.acceptances.map((item) => item.id), [ACCEPTANCE_ID])
    assert(snapshot.audit.some((item) => item.source === 'digital_worker' && item.kind === 'worker.lifecycle'))
    assert(snapshot.audit.some((item) => item.source === 'workflow_ledger' && item.runId === RUN_ID))
    assert.deepEqual(snapshot.summary, {
      assignments: snapshot.assignments.length,
      leases: snapshot.leases.length,
      runs: snapshot.runs.length,
      artifacts: snapshot.artifacts.length,
      evidence: snapshot.evidence.length,
      evidenceLinks: snapshot.evidenceLinks.length,
      acceptances: snapshot.acceptances.length,
      audit: snapshot.audit.length
    })
  })
  await check('history export excludes raw prompts, tool arguments, errors, arbitrary metadata, and foreign Worker records', () => {
    assert.equal(exported.schemaVersion, 2)
    assert.equal(exported.format, 'caogen.digital-worker-history.export.v2')
    assert.equal(exported.snapshot.integrity.historyDigest, snapshot.integrity.historyDigest)
    assertNoSensitiveCanaries(exported.json)
    assertNoRawSensitiveKeys(JSON.parse(exported.json))
    assert.match(snapshot.runs[0].errorDigest ?? '', /^[a-f0-9]{64}$/)
    assert.match(snapshot.assignments[0].scopeDigest, /^[a-f0-9]{64}$/)
    assert.match(snapshot.artifacts[0].recordDigest, /^[a-f0-9]{64}$/)
    assert(snapshot.audit.every((item) => /^[a-f0-9]{64}$/.test(item.eventDigest)))
  })
  await check('fresh process restart reproduces byte-identical history and export digests', () => {
    const restarted = freshProcessReadback()
    assert.equal(restarted.workerStatus, 'retired')
    assert.equal(restarted.historyDigest, snapshot.integrity.historyDigest)
    assert.equal(restarted.exportDigest, exported.exportDigest)
    assert.equal(restarted.json, exported.json)
    assertNoSensitiveCanaries(restarted.json)
  })
  await check('source mutation changes the integrity digest without exposing the mutated plaintext', async () => {
    const storePath = api.worker.digitalWorkerStorePath(stateRoot)
    const document = JSON.parse(readFileSync(storePath, 'utf8'))
    const lifecycle = document.audit.find((event) => event.kind === 'worker.lifecycle' && event.entityId === WORKER_ID)
    assert(lifecycle)
    lifecycle.details.promptText = `${PROMPT_CANARY}:mutated`
    writeFileSync(storePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    const next = await api.worker.exportDigitalWorkerHistory(stateRoot, WORKER_ID, generatedAt)
    assert.notEqual(next.snapshot.integrity.historyDigest, snapshot.integrity.historyDigest)
    assertNoSensitiveCanaries(next.json)
  })

  process.stdout.write(`digital worker history required: PASS (${checks.length} checks)\n`)
} catch (error) {
  failure = serializeError(error)
  throw error
} finally {
  const report = {
    schemaVersion: 1,
    status: failure ? 'failed' : 'passed',
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    gate: 'test:digital-worker-history:required',
    git: {
      commit: gitOutput(['rev-parse', 'HEAD']),
      worktreeClean: gitOutput(['status', '--porcelain']).length === 0,
      statusEntryCount: gitOutput(['status', '--porcelain']).split('\n').filter(Boolean).length
    },
    checks,
    guarantees: [
      'retired Workers preserve immutable Assignment, lease, Run, Artifact, Evidence, Acceptance, and Audit history',
      'history-bearing Workers reject hard deletion and new Assignments after retirement',
      'v2 history exports expose only allowlisted identity, status, and digest projections',
      'fresh-process readback is deterministic and plaintext prompt, tool argument, error, and foreign-worker canaries remain absent'
    ],
    error: failure
  }
  writeReport(report)
  rmSync(tempRoot, { recursive: true, force: true })
}

async function seedFixture(api) {
  const workspace = await seedWorkspace(api)
  const workforce = await seedWorkforce(api)
  await seedWorkflow(api, workspace.goal, workspace.workItem)
  await workforce.workerStore.releaseLease({
    leaseId: workforce.lease.id,
    fencingToken: workforce.lease.fencingToken,
    now: 1_014
  })
  await workforce.workerStore.releaseAssignment(workforce.assignment.id, {}, {
    now: 1_015,
    reason: ERROR_CANARY
  })
  const retired = await workforce.workerStore.retireDigitalWorker(WORKER_ID, {
    expectedRevision: workforce.worker.revision,
    now: 1_016
  })
  return { workerStore: workforce.workerStore, retired, lease: workforce.lease }
}

async function seedWorkspace(api) {
  const workspaceStore = new api.workspace.ProjectWorkspaceStore(stateRoot)
  await workspaceStore.open()
  const project = await workspaceStore.createWorkspace({
    id: PROJECT_ID,
    name: 'Worker history project',
    kind: 'software',
    createdAt: 1_000,
    updatedAt: 1_000
  })
  const goal = await workspaceStore.createGoal({
    id: GOAL_ID,
    projectId: PROJECT_ID,
    title: 'Preserve retired worker history',
    objective: 'Prove TEAM-005',
    acceptance: [{ id: 'criterion-worker-history', criterion: 'History is durable and redacted' }],
    createdAt: 1_001,
    updatedAt: 1_001
  })
  const workItem = await workspaceStore.createWorkItem({
    id: WORK_ITEM_ID,
    projectId: PROJECT_ID,
    goalId: GOAL_ID,
    title: 'Build history export',
    type: 'testing',
    runRefs: [RUN_ID],
    artifactRefs: [ARTIFACT_ID],
    createdAt: 1_002,
    updatedAt: 1_002
  })
  assert.equal(project.id, PROJECT_ID)
  return { goal, workItem }
}

async function seedWorkforce(api) {
  const workerStore = new api.worker.DigitalWorkerStore(stateRoot)
  const role = await workerStore.createRoleTemplate({
    id: 'role-worker-history',
    name: 'History verifier',
    purpose: 'Verify immutable retirement history'
  })
  const proposed = await workerStore.createDigitalWorker({
    id: WORKER_ID,
    projectId: PROJECT_ID,
    roleTemplateId: role.id,
    displayName: 'History Worker',
    createdAt: 1_003,
    updatedAt: 1_003
  })
  const worker = await workerStore.activateDigitalWorker(WORKER_ID, {
    expectedRevision: proposed.revision,
    now: 1_004
  })
  const foreign = await workerStore.createDigitalWorker({
    id: 'worker-history-foreign',
    projectId: PROJECT_ID,
    roleTemplateId: role.id,
    displayName: FOREIGN_CANARY,
    createdAt: 1_005,
    updatedAt: 1_005
  })
  await workerStore.activateDigitalWorker(foreign.id, { expectedRevision: foreign.revision, now: 1_006 })
  const assignment = await workerStore.createAssignment({
    id: ASSIGNMENT_ID,
    projectId: PROJECT_ID,
    workItemId: WORK_ITEM_ID,
    assigneeKind: 'digital_worker',
    assigneeId: WORKER_ID,
    assignedBy: PROMPT_CANARY,
    assignedAt: 1_007,
    scope: { promptText: PROMPT_CANARY, toolArguments: TOOL_ARGUMENT_CANARY },
    reason: ERROR_CANARY
  })
  const lease = await workerStore.acquireLease({
    projectId: PROJECT_ID,
    workItemId: WORK_ITEM_ID,
    workerId: WORKER_ID,
    assignmentId: ASSIGNMENT_ID,
    ttlMs: 10_000,
    now: 1_008
  })
  return { workerStore, worker, assignment, lease }
}

async function seedWorkflow(api, goal, workItem) {
  await api.workflow.createWorkflowGoal({
    id: goal.id,
    projectId: PROJECT_ID,
    title: goal.title,
    objective: goal.objective,
    status: goal.status,
    revision: goal.revision,
    source: 'explicit',
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt
  }, stateRoot)
  await api.workflow.createWorkflowWorkItem({
    id: workItem.id,
    projectId: PROJECT_ID,
    goalId: GOAL_ID,
    type: workItem.type,
    title: workItem.title,
    status: workItem.status,
    revision: workItem.revision,
    source: 'explicit',
    runIds: [RUN_ID],
    currentRunId: RUN_ID,
    createdAt: workItem.createdAt,
    updatedAt: workItem.updatedAt
  }, stateRoot)

  const taskRun = taskRunFixture()
  await api.snapshot.saveTaskSnapshot(api.snapshot.buildTaskSnapshot({
    meta: sessionMetaFixture(),
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run: taskRun,
    now: 1_009
  }), stateRoot)
  await api.workflow.createWorkflowArtifact({
    id: ARTIFACT_ID,
    projectId: PROJECT_ID,
    goalId: GOAL_ID,
    workItemId: WORK_ITEM_ID,
    runId: RUN_ID,
    kind: 'test_report',
    title: PROMPT_CANARY,
    digest: 'a'.repeat(64),
    metadata: { promptText: PROMPT_CANARY, toolArguments: TOOL_ARGUMENT_CANARY, rawError: ERROR_CANARY },
    createdAt: 1_010,
    updatedAt: 1_010
  }, stateRoot)
  const acceptance = await api.workflow.saveWorkflowAcceptance({
    id: ACCEPTANCE_ID,
    projectId: PROJECT_ID,
    goalId: GOAL_ID,
    workItemId: WORK_ITEM_ID,
    criteria: [PROMPT_CANARY],
    status: 'pending',
    evidenceRefs: [],
    notes: ERROR_CANARY,
    revision: 1,
    createdAt: 1_011,
    updatedAt: 1_011
  }, stateRoot)
  const evidence = await api.workflow.createWorkflowEvidence({
    evidenceId: EVIDENCE_ID,
    projectId: PROJECT_ID,
    goalId: GOAL_ID,
    workItemId: WORK_ITEM_ID,
    runId: RUN_ID,
    artifactId: ARTIFACT_ID,
    kind: 'test_result',
    title: TOOL_ARGUMENT_CANARY,
    summary: ERROR_CANARY,
    contentDigest: 'b'.repeat(64),
    metadata: { promptText: PROMPT_CANARY }
  }, stateRoot, {
    source: 'runtime',
    verifier: TOOL_ARGUMENT_CANARY,
    observedAt: 1_012
  })
  const artifactOnlyEvidence = await api.workflow.createWorkflowEvidence({
    evidenceId: ARTIFACT_ONLY_EVIDENCE_ID,
    projectId: PROJECT_ID,
    goalId: GOAL_ID,
    workItemId: WORK_ITEM_ID,
    artifactId: ARTIFACT_ID,
    kind: 'delivery_check',
    title: TOOL_ARGUMENT_CANARY,
    summary: ERROR_CANARY,
    contentDigest: 'c'.repeat(64),
    metadata: { promptText: PROMPT_CANARY, linkage: 'artifact-only' }
  }, stateRoot, {
    source: 'human',
    verifier: TOOL_ARGUMENT_CANARY,
    observedAt: 1_012
  })
  await api.workflow.createWorkflowEvidenceLink({
    id: 'evidence-link-worker-history',
    evidenceId: evidence.evidenceId,
    evidenceOrigin: 'workflow',
    projectId: PROJECT_ID,
    runId: RUN_ID,
    artifactId: ARTIFACT_ID,
    acceptanceId: acceptance.id,
    relation: 'supports',
    createdAt: 1_013
  }, stateRoot)
  await api.workflow.createWorkflowEvidenceLink({
    id: 'evidence-link-worker-history-artifact-only',
    evidenceId: artifactOnlyEvidence.evidenceId,
    evidenceOrigin: 'workflow',
    projectId: PROJECT_ID,
    artifactId: ARTIFACT_ID,
    acceptanceId: acceptance.id,
    relation: 'supports',
    createdAt: 1_014
  }, stateRoot)
}

function taskRunFixture() {
  return {
    schemaVersion: 1,
    id: RUN_ID,
    sessionId: 'session-worker-history',
    taskId: 'task-worker-history',
    digitalWorkerBinding: { kind: 'assigned', workerId: WORKER_ID, assignmentId: ASSIGNMENT_ID },
    status: 'failed',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: 1_009,
    updatedAt: 1_010,
    startedAt: 1_009,
    finishedAt: 1_010,
    error: ERROR_CANARY,
    steps: [],
    toolExecutions: [{
      id: 'tool-execution-worker-history',
      runId: RUN_ID,
      sessionId: 'session-worker-history',
      toolUseId: 'tool-use-worker-history',
      toolName: 'synthetic-history-tool',
      status: 'failed',
      createdAt: 1_009,
      updatedAt: 1_010,
      error: TOOL_ARGUMENT_CANARY
    }],
    effects: []
  }
}

function sessionMetaFixture() {
  return {
    id: 'session-worker-history',
    title: 'Worker history session',
    cwd: stateRoot,
    projectId: PROJECT_ID,
    workspaceId: PROJECT_ID,
    goalId: GOAL_ID,
    workItemId: WORK_ITEM_ID,
    childTaskId: 'task-worker-history',
    model: 'synthetic-history-model',
    providerId: 'synthetic-history-provider',
    engine: 'openai',
    permissionMode: 'default',
    status: 'idle',
    sdkSessionId: 'sdk-session-worker-history',
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: 1_009,
    digitalWorkerBinding: { kind: 'assigned', workerId: WORKER_ID, assignmentId: ASSIGNMENT_ID }
  }
}

function injectLegacyAuditCanaries(storePath) {
  const document = JSON.parse(readFileSync(storePath, 'utf8'))
  const event = document.audit.find((candidate) => candidate.kind === 'worker.lifecycle' && candidate.entityId === WORKER_ID)
  assert(event)
  event.details.promptText = PROMPT_CANARY
  event.details.toolArguments = TOOL_ARGUMENT_CANARY
  event.details.rawError = ERROR_CANARY
  writeFileSync(storePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
}

function freshProcessReadback() {
  const modulePath = path.join(outDir, 'main', 'digital-worker', 'worker-history.js')
  const program = [
    `const history = require(${JSON.stringify(modulePath)})`,
    `Promise.all([history.buildDigitalWorkerHistory(${JSON.stringify(stateRoot)}, ${JSON.stringify(WORKER_ID)}, ${generatedAt}), history.exportDigitalWorkerHistory(${JSON.stringify(stateRoot)}, ${JSON.stringify(WORKER_ID)}, ${generatedAt})])`,
    ".then(([snapshot, exported]) => process.stdout.write(JSON.stringify({ workerStatus: snapshot.worker.status, historyDigest: snapshot.integrity.historyDigest, exportDigest: exported.exportDigest, json: exported.json })))",
    ".catch((error) => { console.error(error); process.exitCode = 1 })"
  ].join('\n')
  const output = execFileSync(process.execPath, ['-e', program], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_PATH: [path.join(outDir, 'node_modules'), path.join(repoRoot, 'node_modules')].join(path.delimiter)
    }
  })
  return JSON.parse(output)
}

function assertNoSensitiveCanaries(serialized) {
  for (const canary of SENSITIVE_CANARIES) {
    assert(!serialized.includes(canary), `history export leaked canary ${canary}`)
  }
}

function assertNoRawSensitiveKeys(value) {
  const forbidden = new Set([
    'assignedBy', 'criteria', 'details', 'error', 'metadata', 'notes', 'prompt', 'promptText',
    'rawError', 'reason', 'scope', 'title', 'toolArguments', 'uri', 'verifier', 'waiverReason'
  ])
  const visit = (current, location) => {
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${location}[${index}]`))
      return
    }
    if (!current || typeof current !== 'object') return
    for (const [key, child] of Object.entries(current)) {
      assert(!forbidden.has(key), `history export contains forbidden raw field ${location}.${key}`)
      visit(child, `${location}.${key}`)
    }
  }
  visit(value, '$')
}

async function loadApi() {
  return {
    aggregate: await importCompiled('main/project-aggregate/index.js'),
    worker: await importCompiled('main/digital-worker/index.js'),
    workspace: await importCompiled('main/project-workspace/index.js'),
    workflow: await importCompiled('main/task/workflow-ledger-api.js'),
    snapshot: await importCompiled('main/task/task-snapshot.js'),
    workflowStore: await importCompiled('main/task/workflow-ledger-store.js')
  }
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/shared/digital-worker-types.ts',
    'src/main/project-aggregate/index.ts',
    'src/main/project-workspace/index.ts',
    'src/main/digital-worker/index.ts',
    'src/main/task/workflow-ledger-api.ts',
    'src/main/task/task-snapshot.ts',
    'src/main/task/workflow-ledger-store.ts',
    '--outDir', outDir,
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
  writeFileSync(path.join(electronDir, 'index.js'), `export const app = { getPath: () => ${JSON.stringify(stateRoot)} }\n`)
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

function importCompiled(relativePath) {
  return import(pathToFileURL(path.join(outDir, relativePath)).href)
}

async function check(name, operation) {
  await operation()
  checks.push({ name, status: 'passed' })
}

async function assertRejects(promise, predicate, message) {
  try {
    await promise
  } catch (error) {
    if (predicate(error)) return
    throw new Error(`${message}: unexpected rejection ${serializeError(error).message}`)
  }
  throw new Error(`${message}: operation unexpectedly succeeded`)
}

function writeReport(report) {
  const payload = `${JSON.stringify(report, null, 2)}\n`
  mkdirSync(reportDir, { recursive: true })
  atomicWrite(path.join(reportDir, 'report.json'), payload)
  atomicWrite(path.join(reportRoot, 'latest.json'), payload)
}

function atomicWrite(filePath, payload) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  renameSync(temporary, filePath)
}

function gitOutput(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    code: typeof error?.code === 'string' ? error.code : undefined
  }
}
