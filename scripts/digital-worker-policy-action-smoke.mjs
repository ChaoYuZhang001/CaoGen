import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const repoRoot = process.cwd()
process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter)
require('node:module').Module._initPaths()
const startedAt = new Date().toISOString()
const runId = startedAt.replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'digital-worker-policy-action')
const reportDir = path.join(reportRoot, runId)
const reportPath = path.join(reportDir, 'report.json')
const latestPath = path.join(reportRoot, 'latest.json')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-digital-worker-policy-action-'))
const outDir = path.join(tempRoot, 'compiled')
const actionRoot = path.join(tempRoot, 'action')
const ownerRoot = path.join(tempRoot, 'owner')
const identityRoot = path.join(tempRoot, 'identity')
const compositeRoot = path.join(tempRoot, 'composite')
const checks = []
let failure

try {
  compileSources()
  const runtime = loadRuntime()
  await exerciseActionPolicies(runtime)
  await exerciseCompositeCapabilityPolicy(runtime)
  await exerciseIdentityBinding(runtime)
  await exerciseOwnerPreflight(runtime)
  assertProductionBoundaries()
  console.log(`digital worker policy action smoke: PASS (${checks.length} checks)`)
} catch (error) {
  failure = serializeError(error)
  throw error
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
  writeReport({
    schemaVersion: 1,
    status: failure ? 'failed' : 'passed',
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    gate: 'test:digital-worker-policy-action:required',
    checks,
    coverage: {
      policies: ['toolPolicy', 'compositeCapabilityPolicy', 'budgetPolicy', 'concurrencyLimit', 'escalationPolicy'],
      boundaries: ['provider send', 'native tool', 'Claude tool authorization', 'Supervisor control', 'Assignment owner'],
      guarantees: [
        'restart recovery', 'immutable Session/TaskRun identity', 'release/reassign/retire fail closed',
        'missing/tampered binding fail closed', 'no durable mutation on denied preflight'
      ]
    },
    error: failure,
    environment: { platform: process.platform, arch: process.arch, node: process.version }
  })
}

async function exerciseActionPolicies(runtime) {
  const fixture = await createActionPolicyFixture(runtime)
  exerciseToolPolicy(runtime, fixture)
  exerciseConcurrencyPolicy(runtime, fixture)
  await exerciseBudgetPolicy(runtime, fixture)
  exerciseEscalationPolicy(runtime, fixture)
}

async function createActionPolicyFixture(runtime) {
  const now = Date.now()
  const store = new runtime.worker.DigitalWorkerStore(actionRoot)
  const role = await store.createRoleTemplate({
    id: 'role-policy-action',
    name: 'Policy Action Worker',
    purpose: 'Exercise production action policy boundaries'
  })
  const proposed = await store.createDigitalWorker({
    id: 'worker-policy-action',
    projectId: 'project-policy-action',
    roleTemplateId: role.id,
    displayName: 'Policy Action Worker',
    toolPolicy: {
      workspaceRead: true,
      workspaceWrite: false,
      terminal: false,
      browser: false,
      network: false
    },
    budgetPolicy: { monthlyUsd: 5 },
    concurrencyLimit: 1,
    escalationPolicy: { target: 'project-owner', afterFailures: 2 }
  })
  const worker = await store.activateDigitalWorker(proposed.id, { expectedRevision: proposed.revision, now: now - 2_000 })
  const assignment = await store.createAssignment({
    id: 'assignment-policy-action',
    projectId: worker.projectId,
    workItemId: 'work-policy-action',
    assigneeKind: 'digital_worker',
    assigneeId: worker.id,
    assignedBy: 'policy-smoke',
    assignedAt: now - 1_000
  })
  const meta = sessionMeta('session-policy-action', assignment, now, 'idle', 'openai')
  return { now, worker, assignment, meta }
}

function exerciseToolPolicy(runtime, fixture) {
  const { now, meta } = fixture
  assertAllowed(runtime.policy.preflightDigitalWorkerAction({ rootDir: actionRoot, meta, action: 'provider_send', now }),
    'provider action within all limits is allowed')
  assertAllowed(runtime.policy.preflightDigitalWorkerAction({
    rootDir: actionRoot,
    meta: { ...meta, status: 'running' },
    action: 'tool_call',
    toolName: 'read_file',
    toolInput: { path: 'README.md' },
    now
  }), 'workspaceRead tool is allowed')

  const toolSnapshot = durableSnapshot(actionRoot)
  assertDenied(runtime.policy.preflightDigitalWorkerAction({
    rootDir: actionRoot,
    meta: { ...meta, status: 'running' },
    action: 'tool_call',
    toolName: 'write_file',
    toolInput: { path: 'blocked.txt', content: 'blocked' },
    now
  }), 'tool_denied', 'workspaceWrite denial is fail-closed')
  assertEqual(durableSnapshot(actionRoot), toolSnapshot, 'denied tool preflight has no durable side effect')
}

async function exerciseCompositeCapabilityPolicy(runtime) {
  exerciseCompositeCapabilityMatrix(runtime.contract)
  await exerciseCompositePersistentPreflight(runtime)
}

function exerciseCompositeCapabilityMatrix(contract) {
  const full = fullCapabilityPolicy()
  const onlyAmbient = capabilityPolicy({ terminal: true, browser: true, network: true })
  const composite = ['workspaceRead', 'workspaceWrite', 'terminal', 'browser', 'network']
  const compositeCalls = [
    ['bash', { command: 'printf test' }],
    ['gui_activate_window', { title: 'Terminal' }],
    ['gui_click', { x: 1, y: 1 }],
    ['gui_type', { text: 'touch escaped.txt' }],
    ['gui_scroll', { deltaY: 100 }],
    ['gui_hotkey', { keys: ['cmd', 's'] }],
    ['mcp_call_tool', { transport: 'stdio', command: 'node', toolName: 'arbitrary', arguments: {} }]
  ]
  for (const [toolName, toolInput] of compositeCalls) {
    assertContractDecision(contract, onlyAmbient, toolName, toolInput, false, composite,
      `${toolName} cannot escape through terminal/browser/network-only policy`)
    assertContractDecision(contract, full, toolName, toolInput, true, composite,
      `${toolName} requires and accepts the complete capability set`)
  }
  assertContractDecision(contract, capabilityPolicy({ browser: true }), 'gui_list_windows', {}, true, ['browser'],
    'read-only window listing keeps the minimal browser capability')
  assertContractDecision(
    contract, capabilityPolicy({ browser: true }), 'gui_screenshot', {}, false, ['browser', 'workspaceWrite'],
    'GUI screenshot cannot write its capture with browser-only policy')
  assertContractDecision(
    contract, capabilityPolicy({ browser: true, workspaceWrite: true }), 'gui_screenshot', {}, true,
    ['browser', 'workspaceWrite'], 'GUI screenshot is allowed with browser and workspaceWrite')
  assertContractDecision(contract, full, 'gui_future_composite', {}, false, [],
    'unknown GUI composite tools fail closed even under the full policy')
}

async function exerciseCompositePersistentPreflight(runtime) {
  const now = Date.now()
  const store = new runtime.worker.DigitalWorkerStore(compositeRoot)
  const role = await store.createRoleTemplate({
    id: 'role-composite-policy',
    name: 'Composite Policy Worker',
    purpose: 'Reject composite capability escapes'
  })
  const proposed = await store.createDigitalWorker({
    id: 'worker-composite-policy',
    projectId: 'project-composite-policy',
    roleTemplateId: role.id,
    displayName: 'Composite Policy Worker',
    toolPolicy: capabilityPolicy({ terminal: true, browser: true, network: true }),
    concurrencyLimit: 4
  })
  const worker = await store.activateDigitalWorker(proposed.id, {
    expectedRevision: proposed.revision,
    now: now - 2_000
  })
  const assignment = await store.createAssignment({
    id: 'assignment-composite-policy',
    projectId: worker.projectId,
    workItemId: 'work-composite-policy',
    assigneeKind: 'digital_worker',
    assigneeId: worker.id,
    assignedBy: 'policy-smoke',
    assignedAt: now - 1_000
  })
  const meta = sessionMeta('session-composite-policy', assignment, now, 'running', 'openai')
  const deniedCalls = [
    ['bash', { command: 'touch escaped.txt' }],
    ['gui_type', { text: 'curl example.invalid' }],
    ['mcp_call_tool', { transport: 'stdio', command: 'node', toolName: 'write_anywhere', arguments: {} }]
  ]
  const before = durableSnapshot(compositeRoot)
  for (const [toolName, toolInput] of deniedCalls) {
    assertDenied(compositePreflight(runtime, meta, toolName, toolInput, now), 'tool_denied',
      `${toolName} composite preflight is denied before execution`)
  }
  assertEqual(durableSnapshot(compositeRoot), before,
    'composite capability denials have no durable side effect')
  assertDenied(runPolicyInFreshProcess(compositePolicyInput(meta, deniedCalls[2], now)), 'tool_denied',
    'fresh process restores composite capability denial')

  const fullWorker = await store.updateDigitalWorker(worker.id, { toolPolicy: fullCapabilityPolicy() }, {
    expectedRevision: worker.revision
  })
  const restarted = new runtime.worker.DigitalWorkerStore(compositeRoot)
  assertEqual((await restarted.getDigitalWorker(worker.id))?.toolPolicy, fullWorker.toolPolicy,
    'complete composite capability policy survives restart')
  for (const [toolName, toolInput] of deniedCalls) {
    assertAllowed(compositePreflight(runtime, meta, toolName, toolInput, now),
      `${toolName} is allowed only after the complete policy is persisted`)
  }
  assertAllowed(runPolicyInFreshProcess(compositePolicyInput(meta, deniedCalls[1], now)),
    'fresh process restores complete composite capability authorization')
}

function compositePreflight(runtime, meta, toolName, toolInput, now) {
  return runtime.policy.preflightDigitalWorkerAction({
    rootDir: compositeRoot, meta, action: 'tool_call', toolName, toolInput, now
  })
}

function compositePolicyInput(meta, call, now) {
  return {
    rootDir: compositeRoot,
    meta,
    action: 'tool_call',
    toolName: call[0],
    toolInput: call[1],
    now
  }
}

function capabilityPolicy(enabled = {}) {
  return {
    workspaceRead: false,
    workspaceWrite: false,
    terminal: false,
    browser: false,
    network: false,
    ...enabled
  }
}

function fullCapabilityPolicy() {
  return capabilityPolicy({
    workspaceRead: true,
    workspaceWrite: true,
    terminal: true,
    browser: true,
    network: true
  })
}

function assertContractDecision(contract, policy, toolName, toolInput, allowed, capabilities, label) {
  const decision = contract.evaluateDigitalWorkerToolPolicy(policy, toolName, toolInput)
  assertEqual(decision.capabilities, capabilities, `${label} capabilities`)
  assert(decision.allowed === allowed, `${label}: expected allowed=${allowed}, got ${decision.allowed}`)
  pass(label)
}

function exerciseConcurrencyPolicy(runtime, fixture) {
  const { now, assignment, meta } = fixture
  writeJson(path.join(actionRoot, 'active-sessions.json'), [
    sessionMeta('session-policy-other', assignment, now, 'running', 'openai')
  ])
  const concurrencySnapshot = durableSnapshot(actionRoot)
  assertDenied(runtime.policy.preflightDigitalWorkerAction({
    rootDir: actionRoot,
    meta,
    action: 'provider_send',
    now
  }), 'concurrency_exhausted', 'second concurrent provider action is denied')
  assertEqual(durableSnapshot(actionRoot), concurrencySnapshot, 'concurrency denial has no durable side effect')
  assertDenied(runPolicyInFreshProcess({
    rootDir: actionRoot,
    meta,
    action: 'provider_send',
    now
  }), 'concurrency_exhausted', 'fresh process restores active-session concurrency denial')
  writeJson(path.join(actionRoot, 'active-sessions.json'), [])
}

async function exerciseBudgetPolicy(runtime, fixture) {
  const { now, worker, assignment, meta } = fixture
  assertDenied(runtime.policy.preflightDigitalWorkerAction({
    rootDir: actionRoot,
    meta: { ...meta, engine: 'anthropic' },
    action: 'provider_send',
    now
  }), 'budget_untrackable', 'budgeted worker rejects an engine without reliable cost reporting')

  writeJson(path.join(actionRoot, 'sessions.json'), [{
    ...sessionMeta('session-policy-budget', assignment, now, 'idle', 'openai'),
    updatedAt: now,
    sdkSessionId: 'sdk-policy-budget',
    title: 'Budget history',
    model: 'gpt-4.1',
    providerId: 'provider-policy',
    permissionMode: 'default',
    costUsd: 5
  }])
  const restarted = new runtime.worker.DigitalWorkerStore(actionRoot)
  assertEqual((await restarted.getDigitalWorker(worker.id))?.budgetPolicy.monthlyUsd, 5,
    'budget policy survives store restart')
  assertDenied(runtime.policy.preflightDigitalWorkerAction({
    rootDir: actionRoot,
    meta,
    action: 'provider_send',
    now
  }), 'budget_exhausted', 'restarted guard denies exhausted monthly budget')
  writeJson(path.join(actionRoot, 'sessions.json'), [])
}

function exerciseEscalationPolicy(runtime, fixture) {
  const { now, meta } = fixture
  writeJson(path.join(actionRoot, 'supervisor-state.json'), {
    schemaVersion: 1,
    revision: 1,
    runs: [{ id: 'run-policy-failed', status: 'failed', retryCount: 1 }],
    events: []
  })
  const escalationSnapshot = durableSnapshot(actionRoot)
  assertDenied(runtime.policy.preflightDigitalWorkerAction({
    rootDir: actionRoot,
    meta,
    action: 'provider_send',
    runId: 'run-policy-failed',
    runStatus: 'failed',
    runBinding: meta.digitalWorkerBinding,
    failureCount: 2,
    now
  }), 'escalation_required', 'failure threshold requires escalation before replay')
  assertEqual(durableSnapshot(actionRoot), escalationSnapshot, 'escalation denial has no Run mutation')
  assertAllowed(runtime.policy.preflightDigitalWorkerAction({
    rootDir: actionRoot,
    meta,
    action: 'supervisor_retry',
    runId: 'run-policy-failed',
    runStatus: 'failed',
    runBinding: meta.digitalWorkerBinding,
    failureCount: 2,
    escalationApproved: true,
    now
  }), 'explicit Supervisor retry authorization clears the escalation preflight')
  assertAllowed(runtime.policy.preflightDigitalWorkerAction({
    rootDir: actionRoot,
    meta,
    action: 'supervisor_resume',
    runId: 'run-policy-failed',
    runStatus: 'failed',
    runBinding: meta.digitalWorkerBinding,
    failureCount: 2,
    escalationApproved: true,
    now
  }), 'explicit Supervisor resume authorization clears the escalation preflight')
}

async function exerciseIdentityBinding(runtime) {
  const fixture = await createIdentityFixture(runtime)
  assertIdentityRestartAndTamper(runtime, fixture)
  await assertIdentityReleaseAndReassign(runtime, fixture)
  await assertRetiredIdentity(runtime, fixture)
  await assertUnscopedIdentity(runtime, fixture)
}

async function createIdentityFixture(runtime) {
  const now = Date.now()
  const store = new runtime.worker.DigitalWorkerStore(identityRoot)
  const role = await store.createRoleTemplate({
    id: 'role-identity-binding',
    name: 'Identity Binding Worker',
    purpose: 'Freeze Session and TaskRun worker identity'
  })
  const workerA = await createActiveWorker(store, role.id, 'worker-identity-a', 'project-identity', now - 5_000)
  const workerB = await createActiveWorker(store, role.id, 'worker-identity-b', 'project-identity', now - 4_000)
  const assignmentA = await store.createAssignment({
    id: 'assignment-identity-a',
    projectId: 'project-identity',
    workItemId: 'work-identity',
    assigneeKind: 'digital_worker',
    assigneeId: workerA.id,
    assignedBy: 'identity-smoke',
    assignedAt: now - 3_000
  })
  const claim = {
    workspaceId: assignmentA.projectId,
    workItemId: assignmentA.workItemId,
    createdAt: now
  }
  const frozen = runtime.binding.createDigitalWorkerSessionBinding(claim, identityRoot)
  assertEqual(frozen, { kind: 'assigned', workerId: workerA.id, assignmentId: assignmentA.id },
    'Session creation freezes workerId and assignmentId')
  const meta = {
    ...sessionMeta('session-identity', assignmentA, now, 'idle', 'openai'),
    digitalWorkerBinding: frozen
  }
  const run = runtime.taskRun.createTaskRun({
    id: 'run-identity',
    sessionId: meta.id,
    taskId: 'task-identity',
    now,
    digitalWorkerBinding: frozen
  })
  assertEqual(run.digitalWorkerBinding, frozen, 'TaskRun durably copies the Session identity binding')
  return { now, store, role, workerA, workerB, assignmentA, frozen, meta, run }
}

function assertIdentityRestartAndTamper(runtime, fixture) {
  const { now, workerB, assignmentA, frozen, meta, run } = fixture
  const restarted = JSON.parse(JSON.stringify({ meta, run }))
  assertEqual(
    runtime.binding.resolveDigitalWorkerSessionScope(restarted.meta, identityRoot).binding,
    frozen,
    'serialized Session binding validates after restart'
  )
  assertEqual(
    runtime.binding.bindAndValidateTaskRun(restarted.meta, restarted.run).digitalWorkerBinding,
    frozen,
    'serialized TaskRun binding validates after restart'
  )
  assertAllowed(runPolicyInFreshProcess({
    rootDir: identityRoot,
    meta: restarted.meta,
    action: 'provider_send',
    runId: restarted.run.id,
    runStatus: restarted.run.status,
    runBinding: restarted.run.digitalWorkerBinding,
    now
  }), 'fresh process preserves the original Session/TaskRun identity')

  assertDenied(runtime.policy.preflightDigitalWorkerAction({
    rootDir: identityRoot,
    meta: { ...meta, digitalWorkerBinding: undefined },
    action: 'provider_send',
    now
  }), 'assignment_conflict', 'missing scoped Session binding fails closed')
  assertDenied(runtime.policy.preflightDigitalWorkerAction({
    rootDir: identityRoot,
    meta,
    action: 'provider_send',
    runId: run.id,
    runStatus: run.status,
    runBinding: { kind: 'assigned', workerId: workerB.id, assignmentId: assignmentA.id },
    now
  }), 'assignment_conflict', 'tampered TaskRun worker binding fails closed')
  assertThrows(() => runtime.taskRun.mergeTaskRunRecords(run, {
    ...run,
    revision: run.revision + 1,
    digitalWorkerBinding: { kind: 'assigned', workerId: workerB.id, assignmentId: assignmentA.id }
  }), /identity binding conflict/, 'TaskRun merge rejects identity mutation')
}

async function assertIdentityReleaseAndReassign(runtime, fixture) {
  const { now, store, workerA, workerB, assignmentA, meta } = fixture
  const releasedA = await store.releaseAssignment(
    assignmentA.id,
    { expectedRevision: assignmentA.revision },
    { now: now + 1_000, reason: 'identity release test' }
  )
  assertDenied(runtime.policy.preflightDigitalWorkerAction({
    rootDir: identityRoot,
    meta,
    action: 'provider_send',
    now: now + 1_001
  }), 'assignment_conflict', 'released original Assignment fails closed')
  const assignmentB = await store.createAssignment({
    id: 'assignment-identity-b',
    projectId: assignmentA.projectId,
    workItemId: assignmentA.workItemId,
    assigneeKind: 'digital_worker',
    assigneeId: workerB.id,
    assignedBy: 'identity-smoke',
    assignedAt: now + 1_002,
    reason: `replaces ${releasedA.id}`
  })
  const reassignedDecision = runtime.policy.preflightDigitalWorkerAction({
    rootDir: identityRoot,
    meta,
    action: 'provider_send',
    now: now + 1_003
  })
  assertDenied(reassignedDecision, 'assignment_conflict', 'reassigned WorkItem does not adopt the new worker policy')
  assertEqual(reassignedDecision.workerId, workerA.id, 'reassignment denial retains the original worker identity')
  assertDenied(runtime.policy.preflightDigitalWorkerAction({
    rootDir: identityRoot,
    meta: {
      ...meta,
      digitalWorkerBinding: { kind: 'assigned', workerId: workerB.id, assignmentId: assignmentB.id }
    },
    action: 'provider_send',
    now: now + 1_003
  }), 'assignment_conflict', 'binding tampered to a later reassignment fails closed')
}

async function assertRetiredIdentity(runtime, fixture) {
  const { now, store, role } = fixture
  const worker = await createActiveWorker(
    store, role.id, 'worker-identity-retire', 'project-identity', now - 3_000)
  const retireAssignment = await store.createAssignment({
    id: 'assignment-identity-retire',
    projectId: 'project-identity',
    workItemId: 'work-identity-retire',
    assigneeKind: 'digital_worker',
    assigneeId: worker.id,
    assignedBy: 'identity-smoke',
    assignedAt: now - 2_000
  })
  const retireMeta = {
    ...sessionMeta('session-identity-retire', retireAssignment, now, 'idle', 'openai'),
    digitalWorkerBinding: {
      kind: 'assigned', workerId: worker.id, assignmentId: retireAssignment.id
    }
  }
  const currentWorker = await store.getDigitalWorker(worker.id)
  await store.retireDigitalWorker(worker.id, {
    expectedRevision: currentWorker.revision,
    now: now + 2_000
  })
  assertDenied(runtime.policy.preflightDigitalWorkerAction({
    rootDir: identityRoot,
    meta: retireMeta,
    action: 'provider_send',
    now: now + 2_001
  }), 'worker_unavailable', 'retired original DigitalWorker fails closed')
}

async function assertUnscopedIdentity(runtime, fixture) {
  const { now, store, workerB } = fixture
  const unscopedClaim = {
    workspaceId: 'project-identity',
    workItemId: 'work-identity-unscoped',
    createdAt: now + 3_000
  }
  const unscoped = runtime.binding.createDigitalWorkerSessionBinding(unscopedClaim, identityRoot)
  assertEqual(unscoped, { kind: 'unscoped' }, 'creation durably marks a WorkItem with no worker as unscoped')
  const unscopedMeta = {
    id: 'session-identity-unscoped',
    ...unscopedClaim,
    digitalWorkerBinding: unscoped,
    engine: 'openai',
    status: 'idle',
    costUsd: 0
  }
  assertAllowed(runtime.policy.preflightDigitalWorkerAction({
    rootDir: identityRoot,
    meta: unscopedMeta,
    action: 'provider_send',
    now: now + 3_000
  }), 'explicitly unscoped Session remains allowed while no worker owns the WorkItem')
  await store.createAssignment({
    id: 'assignment-identity-unscoped-later',
    projectId: 'project-identity',
    workItemId: 'work-identity-unscoped',
    assigneeKind: 'digital_worker',
    assigneeId: workerB.id,
    assignedBy: 'identity-smoke',
    assignedAt: now + 3_001
  })
  assertDenied(runtime.policy.preflightDigitalWorkerAction({
    rootDir: identityRoot,
    meta: unscopedMeta,
    action: 'provider_send',
    now: now + 3_002
  }), 'assignment_conflict', 'unscoped Session cannot silently adopt a later worker Assignment')
  assertThrows(() => runtime.binding.resolveDigitalWorkerSessionScope({
    ...unscopedMeta,
    digitalWorkerBinding: undefined
  }, identityRoot, { allowLegacyUnscoped: true }), /缺少不可变/, 'legacy scoped Session without a binding is not treated as unscoped')
}

async function createActiveWorker(store, roleTemplateId, id, projectId, now) {
  const proposed = await store.createDigitalWorker({
    id,
    projectId,
    roleTemplateId,
    displayName: id,
    toolPolicy: { workspaceRead: true },
    concurrencyLimit: 4
  })
  return store.activateDigitalWorker(proposed.id, { expectedRevision: proposed.revision, now })
}

async function exerciseOwnerPreflight(runtime) {
  const projects = await new runtime.project.ProjectWorkspaceStore(ownerRoot).open()
  await projects.createWorkspace({ id: 'project-owner-policy', name: 'Owner policy', kind: 'software' })
  const workItem = await projects.createWorkItem({
    id: 'work-owner-policy',
    projectId: 'project-owner-policy',
    title: 'Owner policy preflight'
  })
  const workers = new runtime.worker.DigitalWorkerStore(ownerRoot)
  const role = await workers.createRoleTemplate({
    id: 'role-owner-policy',
    name: 'Owner Policy Worker',
    purpose: 'Reject malformed policy before owner mutation'
  })
  const proposed = await workers.createDigitalWorker({
    id: 'worker-owner-policy',
    projectId: 'project-owner-policy',
    roleTemplateId: role.id,
    displayName: 'Owner Policy Worker',
    toolPolicy: { workspaceRead: true },
    concurrencyLimit: 1,
    escalationPolicy: { target: 'project-owner' }
  })
  await workers.activateDigitalWorker(proposed.id, { expectedRevision: proposed.revision })
  const coordinator = await runtime.coordinator.openAssignmentOwnerCoordinator(ownerRoot, false)
  const projectRevision = await projects.getRevision()
  const workerRevision = workers.read().revision
  const journalPath = runtime.coordinator.assignmentOwnerJournalPath(ownerRoot)
  const journalBefore = existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : '<missing>'
  await assertRejects(coordinator.coordinate({
    requestId: 'owner-policy-request',
    projectId: 'project-owner-policy',
    workItemId: 'work-owner-policy',
    workerId: 'worker-owner-policy',
    assignedBy: 'policy-smoke',
    expectedWorkItemRevision: workItem.revision,
    expectedProjectStoreRevision: projectRevision,
    expectedDigitalWorkerStoreRevision: workerRevision
  }), /action policy is invalid/, 'malformed policy is rejected before Assignment owner coordination')
  assertEqual((await workers.listAssignments({ includeHistory: true })).length, 0,
    'denied owner preflight creates no Assignment')
  assertEqual((await projects.getWorkItem('work-owner-policy'))?.owner, undefined,
    'denied owner preflight leaves WorkItem owner unchanged')
  assertEqual(existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : '<missing>', journalBefore,
    'denied owner preflight leaves coordinator journal bytes unchanged')
  const entries = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')).entries : []
  assertEqual(entries.length, 0, 'denied owner preflight leaves no coordinator journal mutation')
}

function assertProductionBoundaries() {
  const sessionManager = source('src/main/sessionManager.ts')
  const send = between(sessionManager, '  send(', '  async controlSupervisorRun(')
  assertOrder(send, 'digitalWorkerSendPolicyError(', 'this.taskRuns.set(',
    'DigitalWorker send guard runs before TaskRun mutation')
  assertOrder(send, 'digitalWorkerSendPolicyError(', 'session.send(input)',
    'DigitalWorker send guard runs before Provider dispatch')
  assert(send.includes('digitalWorkerBinding: session.meta.digitalWorkerBinding'),
    'SessionManager copies immutable DigitalWorker identity into each TaskRun')

  const creation = between(sessionManager, '  private async validatedSessionCreationDraft(', '  private activateSessionCreation(')
  assert(creation.includes('prepareSessionIdentityForActivation('),
    'Session creation freezes DigitalWorker identity before activation')
  const domainActivation = source('src/main/session-domain-activation.ts')
  assert(domainActivation.includes('createDigitalWorkerSessionBinding(') &&
    domainActivation.includes('resolveDigitalWorkerSessionScope('),
  'Session identity activation freezes new bindings and validates resumed bindings')
  const activation = between(sessionManager, '  private prepareSessionEngine(', '  private acknowledgeSessionCreation(')
  assertOrder(activation, 'resolveDigitalWorkerSessionScope(', 'createEngine(',
    'Session activation validates the frozen identity before Engine creation')

  const recovery = source('src/main/task/task-snapshot-recovery-lifecycle.ts')
  const prepareRecovery = between(recovery, 'export async function prepareTaskSnapshotRecovery(', 'export async function assertNoStartedModelAttemptReconciliation(')
  assertOrder(prepareRecovery, 'resolveDigitalWorkerSessionScope(', 'reconcilePersistedTaskSnapshot(',
    'Task snapshot recovery validates worker identity before persistence reconciliation')

  const nativeRuntime = source('src/main/native-tool-runtime.ts')
  const nativePreflight = between(nativeRuntime, '  preflightToolGate(', '  async executeToolWithPermission(')
  assertOrder(nativePreflight, 'digitalWorkerToolPolicyError(', 'evaluateToolPermission(',
    'native tool guard runs before shared permission and tool execution state')
  const nativeExecution = between(nativeRuntime, '  async executeToolWithPermission(', '  private async prepareToolEffect(')
  assertOrder(nativeExecution, 'this.preflightToolGate(', 'this.prepareToolEffect(',
    'native tool policy denial occurs before Effect preparation')

  const claude = source('src/main/agentSession.ts')
  const claudePermission = between(claude, '  private requestPermission(', '  private recordContextTokens(')
  assertOrder(claudePermission, 'digitalWorkerToolPermissionDecision(', 'this.authorizeClaudeTool(',
    'Claude tool guard runs before Effect execution authorization')

  const supervisor = source('src/main/task/supervisor-session-control.ts')
  const control = between(supervisor, 'export async function executeSupervisorSessionControl(', 'function findSupervisorRun(')
  assertOrder(control, 'await runtime.preflight?.(', 'await ensureSupervisorRunBinding(',
    'Supervisor policy preflight runs before canonical owner binding')
  assertOrder(control, 'await runtime.preflight?.(', 'await store.resumeRun(',
    'Supervisor policy preflight runs before Run resume mutation')
  assertOrder(control, 'await runtime.preflight?.(', 'await store.authorizeRetry(',
    'Supervisor policy preflight runs before Run retry mutation')

  const supervisorRuntime = source('src/main/session-supervisor-runtime.ts')
  const runtimeControl = between(supervisorRuntime, '  control(', '  private getStateStore(')
  assertOrder(runtimeControl, 'preflight: (controlRequest, binding) => this.preflightControl(', 'pause: (binding)',
    'Session Supervisor runtime installs the DigitalWorker policy preflight')
  const runtimePreflight = between(supervisorRuntime, '  private async preflightControl(', '  private setSendGate(')
  assertOrder(runtimePreflight, 'digitalWorkerSupervisorPolicyError(', 'this.requireReplaySnapshot(',
    'Session Supervisor worker policy runs before replay snapshot work')
}

function sessionMeta(id, assignment, now, status, engine) {
  return {
    id,
    workspaceId: assignment.projectId,
    workItemId: assignment.workItemId,
    digitalWorkerBinding: {
      kind: 'assigned', workerId: assignment.assigneeId, assignmentId: assignment.id
    },
    engine,
    status,
    costUsd: 0,
    createdAt: now
  }
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/digital-worker/action-policy.ts',
    'src/main/digital-worker/action-policy-contract.ts',
    'src/main/digital-worker/session-binding.ts',
    'src/main/digital-worker/domain-store.ts',
    'src/main/task/task-run.ts',
    'src/main/assignment-owner-coordinator/index.ts',
    'src/main/project-workspace/index.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function loadRuntime() {
  return {
    policy: requireCompiled('main/digital-worker/action-policy.js'),
    contract: requireCompiled('main/digital-worker/action-policy-contract.js'),
    binding: requireCompiled('main/digital-worker/session-binding.js'),
    worker: requireCompiled('main/digital-worker/domain-store.js'),
    taskRun: requireCompiled('main/task/task-run.js'),
    coordinator: requireCompiled('main/assignment-owner-coordinator/index.js'),
    project: requireCompiled('main/project-workspace/index.js')
  }
}

function requireCompiled(relativePath) {
  return require(resolveCompiledPath(relativePath))
}

function resolveCompiledPath(relativePath) {
  const exact = path.join(outDir, relativePath)
  if (existsSync(exact)) return exact
  const basename = path.basename(relativePath)
  const found = findFile(outDir, basename)
  if (!found) throw new Error(`compiled module not found: ${relativePath}`)
  return found
}

function runPolicyInFreshProcess(input) {
  const script = [
    `const policy = require(${JSON.stringify(resolveCompiledPath('main/digital-worker/action-policy.js'))})`,
    'const input = JSON.parse(process.env.CAOGEN_POLICY_ACTION_INPUT)',
    'process.stdout.write(JSON.stringify(policy.preflightDigitalWorkerAction(input)))'
  ].join(';')
  const output = execFileSync(process.execPath, ['-e', script], {
    cwd: repoRoot,
    env: { ...process.env, CAOGEN_POLICY_ACTION_INPUT: JSON.stringify(input) },
    encoding: 'utf8'
  })
  return JSON.parse(output)
}

function findFile(root, basename) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = findFile(candidate, basename)
      if (nested) return nested
    } else if (entry.name === basename) return candidate
  }
  return undefined
}

function durableSnapshot(root) {
  const hash = createHash('sha256')
  for (const name of [
    'digital-workers.json',
    'project-workspace.json',
    'supervisor-state.json',
    'sessions.json',
    'active-sessions.json',
    'assignment-owner-coordinator.json'
  ]) {
    const file = path.join(root, name)
    hash.update(name)
    hash.update(existsSync(file) ? readFileSync(file) : '<missing>')
  }
  return hash.digest('hex')
}

function source(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function between(text, start, end) {
  const from = text.indexOf(start)
  const to = text.indexOf(end, from + start.length)
  assert(from >= 0 && to > from, `source boundaries missing: ${start} -> ${end}`)
  return text.slice(from, to)
}

function assertOrder(text, first, second, label) {
  const firstIndex = text.indexOf(first)
  const secondIndex = text.indexOf(second)
  assert(firstIndex >= 0 && secondIndex > firstIndex, label)
  pass(label)
}

function assertAllowed(decision, label) {
  assert(decision.allowed === true, `${label}: ${'message' in decision ? decision.message : 'denied'}`)
  pass(label)
}

function assertDenied(decision, code, label) {
  assert(decision.allowed === false, `${label}: unexpectedly allowed`)
  assertEqual(decision.code, code, `${label} code`)
  pass(label)
}

async function assertRejects(task, pattern, label) {
  try {
    await task
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    assert(pattern.test(message), `${label}: unexpected error: ${message}`)
    pass(label)
    return
  }
  throw new Error(`${label}: expected rejection`)
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
  pass(label)
}

function assertThrows(task, pattern, label) {
  try {
    task()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    assert(pattern.test(message), `${label}: unexpected error: ${message}`)
    pass(label)
    return
  }
  throw new Error(`${label}: expected rejection`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function pass(label) {
  checks.push({ label, status: 'passed' })
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function writeReport(report) {
  mkdirSync(reportDir, { recursive: true })
  const body = `${JSON.stringify({
    ...report,
    reportDir: path.relative(repoRoot, reportDir),
    reportPath: path.relative(repoRoot, reportPath)
  }, null, 2)}\n`
  writeFileSync(reportPath, body, 'utf8')
  writeFileSync(latestPath, body, 'utf8')
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    code: error && typeof error === 'object' && 'code' in error ? error.code : undefined
  }
}
