import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-assignment-owner-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
process.env.CAOGEN_ASSIGNMENT_OWNER_TEST_RENDERER_URL = pathToFileURL(
  path.join(outDir, 'renderer', 'index.html')
).href
process.env.ELECTRON_RENDERER_URL = process.env.CAOGEN_ASSIGNMENT_OWNER_TEST_RENDERER_URL

try {
  compileSources()
  installElectronShim()
  const coordinatorDomain = require(path.join(outDir, 'main', 'assignment-owner-coordinator', 'index.js'))
  const projectDomain = require(path.join(outDir, 'main', 'project-workspace', 'index.js'))
  const workerDomain = require(path.join(outDir, 'main', 'digital-worker', 'index.js'))
  const projectStore = new projectDomain.ProjectWorkspaceStore(userData)
  const workerStore = new workerDomain.DigitalWorkerStore(userData)
  await projectStore.open()

  const projectA = await projectStore.createWorkspace({ id: 'project-a', name: 'Project A', kind: 'software' })
  const projectB = await projectStore.createWorkspace({ id: 'project-b', name: 'Project B', kind: 'research' })
  const items = {}
  for (const id of ['success', 'concurrent', 'stale', 'reassign-policy', 'crash-assignment', 'crash-owner', 'compensate']) {
    items[id] = await projectStore.createWorkItem({
      id: `work-${id}`,
      projectId: projectA.id,
      title: `Work ${id}`
    })
  }
  const foreignItem = await projectStore.createWorkItem({
    id: 'work-foreign',
    projectId: projectB.id,
    title: 'Foreign work'
  })

  const role = await workerStore.createRoleTemplate({
    id: 'role-coordinator',
    name: 'Coordinator fixture',
    purpose: 'Exercise durable assignment owner coordination'
  })
  const proposedA = await workerStore.createDigitalWorker({
    id: 'worker-a',
    projectId: projectA.id,
    roleTemplateId: role.id,
    displayName: 'Worker A',
    memoryNamespace: 'project:project-a:worker:a'
  })
  const workerA = await workerStore.activateDigitalWorker(proposedA.id, { expectedRevision: proposedA.revision })
  const proposedPolicyWorker = await workerStore.createDigitalWorker({
    id: 'worker-policy',
    projectId: projectA.id,
    roleTemplateId: role.id,
    displayName: 'Policy Worker',
    memoryNamespace: 'project:project-a:worker:policy',
    dataScope: {
      requireExplicitScope: true,
      allowedDataClasses: ['project-internal'],
      deniedDataClasses: ['credential'],
      allowedResourceIds: ['repo-main']
    }
  })
  const policyWorker = await workerStore.activateDigitalWorker(proposedPolicyWorker.id, {
    expectedRevision: proposedPolicyWorker.revision
  })
  const proposedB = await workerStore.createDigitalWorker({
    id: 'worker-b',
    projectId: projectB.id,
    roleTemplateId: role.id,
    displayName: 'Worker B',
    memoryNamespace: 'project:project-b:worker:b'
  })
  await workerStore.activateDigitalWorker(proposedB.id, { expectedRevision: proposedB.revision })

  const coordinator = await coordinatorDomain.openAssignmentOwnerCoordinator(userData, false)
  const successInput = await buildInput('request-success', items.success, workerA.id)
  const success = await coordinator.coordinate(successInput)
  assertEqual(success.assignment.status, 'active', 'same-project Assignment must be active')
  assertEqual(success.workItem.owner?.id, workerA.id, 'same-project WorkItem owner must match Assignment')
  assertEqual(success.idempotentReplay, false, 'first request must not be marked replay')
  const replay = await coordinator.coordinate(successInput)
  assertEqual(replay.assignmentId, success.assignmentId, 'request replay must return the original Assignment')
  assertEqual(replay.journalId, success.journalId, 'request replay must return the original journal')
  assertEqual(replay.idempotentReplay, true, 'second request must be marked replay')
  assertEqual(
    (await workerStore.listAssignments({ workItemId: items.success.id, includeHistory: true })).length,
    1,
    'request replay must not create duplicate Assignment history'
  )
  await assertRejects(
    coordinator.coordinate({ ...successInput, workerId: 'different-worker' }),
    (error) => error?.code === 'REQUEST_CONFLICT',
    'same requestId with a different fingerprint must fail closed'
  )

  const concurrentInput = await buildInput('request-concurrent', items.concurrent, workerA.id)
  const concurrent = await Promise.all([
    coordinator.coordinate(concurrentInput),
    coordinator.coordinate(concurrentInput)
  ])
  assertEqual(new Set(concurrent.map((result) => result.assignmentId)).size, 1, 'concurrent replay must converge')
  assertEqual(
    concurrent.filter((result) => result.idempotentReplay).length,
    1,
    'exactly one concurrent caller must observe an idempotent replay'
  )

  await assertRejects(
    coordinator.coordinate(await buildInput('request-cross-worker', items.stale, 'worker-b')),
    (error) => error?.code === 'PROJECT_SCOPE_CONFLICT',
    'cross-project worker ownership must fail closed'
  )
  await assertRejects(
    coordinator.coordinate({
      ...(await buildInput('request-cross-item', foreignItem, workerA.id)),
      projectId: projectA.id
    }),
    (error) => error?.code === 'PROJECT_SCOPE_CONFLICT',
    'cross-project WorkItem ownership must fail closed'
  )

  const staleInput = await buildInput('request-stale', items.stale, workerA.id)
  await projectStore.updateWorkItem(items.stale.id, { title: 'Externally updated before coordinate' }, items.stale.revision)
  await assertRejects(
    coordinator.coordinate(staleInput),
    (error) => error?.code === 'REVISION_CONFLICT',
    'stale WorkItem CAS must fail before Assignment creation'
  )
  assertEqual(
    (await workerStore.listAssignments({ workItemId: items.stale.id, includeHistory: true })).length,
    0,
    'stale WorkItem CAS must leave no Assignment history'
  )

  const policyOriginal = await coordinator.coordinate(
    await buildInput('request-reassign-policy-original', items['reassign-policy'], workerA.id)
  )
  const policyItemBefore = await projectStore.getWorkItem(items['reassign-policy'].id)
  await assertRejects(
    coordinator.reassignAssignment({
      requestId: 'request-reassign-policy-denied',
      currentAssignmentId: policyOriginal.assignment.id,
      nextInput: {
        id: 'assignment-reassign-policy-denied',
        projectId: projectA.id,
        workItemId: items['reassign-policy'].id,
        assigneeKind: 'digital_worker',
        assigneeId: policyWorker.id,
        assignedBy: 'user-owner',
        scope: { dataClass: 'credential', resourceIds: ['repo-main'] }
      },
      expectedRevision: policyOriginal.assignment.revision
    }),
    (error) => error?.code === 'POLICY_DENIED',
    'reassignment policy must fail before the new owner is written'
  )
  const policyItemAfter = await projectStore.getWorkItem(items['reassign-policy'].id)
  assertEqual(policyItemAfter.owner?.id, workerA.id, 'denied reassignment must preserve the original owner')
  assertEqual(policyItemAfter.revision, policyItemBefore.revision, 'denied reassignment must not mutate WorkItem revision')
  assertEqual(
    (await workerStore.listAssignments({ workItemId: items['reassign-policy'].id, includeHistory: true })).length,
    1,
    'denied reassignment must not create Assignment history'
  )

  const assignmentCrash = await runCrash(
    'after_assignment_write',
    'request-crash-assignment',
    items['crash-assignment']
  )
  assertEqual(assignmentCrash.before.phase, 'prepared', 'assignment-write crash must leave durable prepare')
  assertEqual(assignmentCrash.assignment.status, 'active', 'assignment-write crash must persist Assignment')
  assertEqual(assignmentCrash.itemBefore.owner, undefined, 'assignment-write crash must not write owner yet')
  const assignmentRecovery = await recover('request-crash-assignment')
  assertEqual(assignmentRecovery.entry.phase, 'committed', 'restart must complete assignment-write crash')
  assertEqual(assignmentRecovery.item.owner?.id, workerA.id, 'assignment recovery must write matching owner')

  const ownerCrash = await runCrash(
    'after_owner_write',
    'request-crash-owner',
    items['crash-owner']
  )
  assertEqual(ownerCrash.before.phase, 'assignment_written', 'owner-write crash must leave assignment phase durable')
  assertEqual(ownerCrash.itemBefore.owner?.id, workerA.id, 'owner-write crash must persist owner')
  const ownerRevisionAfterCrash = ownerCrash.itemBefore.revision
  const ownerRecovery = await recover('request-crash-owner')
  assertEqual(ownerRecovery.entry.phase, 'committed', 'restart must recognize already-written owner')
  assertEqual(ownerRecovery.item.revision, ownerRevisionAfterCrash, 'recovery must not write owner twice')

  const compensationCrash = await runCrash(
    'after_assignment_write',
    'request-compensate',
    items.compensate
  )
  await projectStore.updateWorkItem(
    items.compensate.id,
    { title: 'External writer wins during crash window' },
    compensationCrash.itemBefore.revision
  )
  const compensationRecovery = await recover('request-compensate')
  assertEqual(compensationRecovery.entry.phase, 'compensated', 'stale owner CAS must compensate on restart')
  assertEqual(compensationRecovery.assignment.status, 'released', 'compensation must release active Assignment')
  assertEqual(compensationRecovery.item.owner, undefined, 'compensation must preserve the external WorkItem owner state')

  const audit = await coordinator.listAudit('request-success')
  assert(audit.length >= 4, 'coordinator must emit phase audit events')
  for (const event of audit) {
    assertEqual(event.requestId, success.requestId, 'audit must link requestId')
    assertEqual(event.journalId, success.journalId, 'audit must link journalId')
    assertEqual(event.assignmentId, success.assignmentId, 'audit must link Assignment')
    assertEqual(event.workItemId, success.workItemId, 'audit must link WorkItem')
  }
  assert(audit.some((event) => event.kind === 'coordinator.committed'), 'audit must include commit')
  const compensationAudit = await coordinator.listAudit('request-compensate')
  assert(
    compensationAudit.some((event) => event.kind === 'coordinator.compensated'),
    'audit must include compensation'
  )

  const journalPath = coordinatorDomain.assignmentOwnerJournalPath(userData)
  assert(existsSync(journalPath), 'durable coordinator journal must exist')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
  assert(Number.isSafeInteger(journal.revision) && journal.revision > 0, 'journal must have a durable revision')
  assertEqual(journal.entries.length, 6, 'only prepared requests belong in the journal')
  const ipcChecks = await exerciseLegacyIpc()

  console.log(JSON.stringify({
    status: 'PASS',
    checks: [
      'same-project-atomic-assignment-owner',
      'cross-project-rejection',
      'work-item-and-store-cas',
      'reassignment-policy-before-owner-write',
      'request-idempotency-and-concurrency',
      'assignment-write-crash-recovery',
      'owner-write-crash-recovery',
      'stale-recovery-compensation',
      'correlated-journal-audit',
      ...ipcChecks
    ],
    journalRevision: journal.revision,
    auditEvents: journal.audit.length
  }, null, 2))

  async function buildInput(requestId, item, workerId) {
    const [projectRevision, workerRevision] = await Promise.all([
      projectStore.getRevision(),
      Promise.resolve(workerStore.read().revision)
    ])
    return {
      requestId,
      projectId: item.projectId,
      workItemId: item.id,
      workerId,
      assignedBy: 'user-owner',
      expectedWorkItemRevision: item.revision,
      expectedProjectStoreRevision: projectRevision,
      expectedDigitalWorkerStoreRevision: workerRevision,
      scope: { purpose: 'coordinator smoke' },
      reason: 'atomic assignment owner update'
    }
  }

  async function runCrash(point, requestId, item) {
    const crashing = await coordinatorDomain.openAssignmentOwnerCoordinator({
      rootDir: userData,
      faultInjector: (candidate) => {
        if (candidate === point) throw new Error(`crash at ${point}`)
      }
    }, false)
    const input = await buildInput(requestId, item, workerA.id)
    await assertRejects(
      crashing.coordinate(input),
      (error) => error?.name === 'AssignmentOwnerCrashSimulationError' && error?.point === point,
      `${point} must expose the simulated crash boundary`
    )
    return {
      before: await crashing.getJournalEntry(requestId),
      assignment: (await workerStore.listAssignments({ workItemId: item.id, includeHistory: true }))[0],
      itemBefore: await projectStore.getWorkItem(item.id)
    }
  }

  async function recover(requestId) {
    const restarted = await coordinatorDomain.openAssignmentOwnerCoordinator(userData, false)
    const outcomes = await restarted.recoverPending()
    assert(
      outcomes.some((outcome) => outcome.requestId === requestId && outcome.recovered),
      `restart recovery must process ${requestId}`
    )
    const entry = await restarted.getJournalEntry(requestId)
    return {
      entry,
      assignment: await workerStore.getAssignment(entry.assignmentId),
      item: await projectStore.getWorkItem(entry.workItemId)
    }
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/assignment-owner-coordinator/index.ts',
    'src/main/digital-worker/index.ts',
    'src/main/project-workspace/index.ts',
    'src/main/ipc/digital-worker-handlers.ts',
    'src/main/ipc/project-workspace-handlers.ts',
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

async function exerciseLegacyIpc() {
  const context = await prepareLegacyIpcContext()
  const active = await exerciseLegacyReassignCrash(context)
  await exerciseLegacyReleaseCrash(context, active)
  await exerciseReadinessRetry(context)
  return [
    'legacy-create-reassign-release-ipc-routing',
    'legacy-reassign-owner-write-crash-recovery',
    'legacy-release-assignment-write-crash-recovery',
    'shared-readiness-fail-closed-diagnostics-retry'
  ]
}

async function prepareLegacyIpcContext() {
  const ipcRoot = path.join(tempRoot, 'ipc-user-data')
  process.env.CAOGEN_ASSIGNMENT_OWNER_TEST_USER_DATA = ipcRoot
  installElectronShim()
  const projectDomain = require(path.join(outDir, 'main', 'project-workspace', 'index.js'))
  const workerDomain = require(path.join(outDir, 'main', 'digital-worker', 'index.js'))
  const projectStore = new projectDomain.ProjectWorkspaceStore(ipcRoot)
  const workerStore = new workerDomain.DigitalWorkerStore(ipcRoot)
  await projectStore.open()
  await projectStore.createWorkspace({ id: 'ipc-project', name: 'IPC project', kind: 'software' })
  for (const id of ['reassign-crash', 'readiness-retry']) {
    await projectStore.createWorkItem({
      id: `ipc-work-${id}`,
      projectId: 'ipc-project',
      title: `IPC ${id}`
    })
  }
  const role = await workerStore.createRoleTemplate({
    id: 'ipc-role',
    name: 'IPC role',
    purpose: 'Exercise legacy Assignment IPC recovery'
  })
  const proposedA = await workerStore.createDigitalWorker({
    id: 'ipc-worker-a',
    projectId: 'ipc-project',
    roleTemplateId: role.id,
    displayName: 'IPC Worker A'
  })
  const proposedB = await workerStore.createDigitalWorker({
    id: 'ipc-worker-b',
    projectId: 'ipc-project',
    roleTemplateId: role.id,
    displayName: 'IPC Worker B'
  })
  await workerStore.activateDigitalWorker(proposedA.id, { expectedRevision: proposedA.revision })
  await workerStore.activateDigitalWorker(proposedB.id, { expectedRevision: proposedB.revision })

  const crash = installCoordinatorCrashShim()
  const electron = require(path.join(outDir, 'node_modules', 'electron', 'index.js'))
  require(path.join(outDir, 'main', 'ipc', 'digital-worker-handlers.js')).registerDigitalWorkerIpc()
  require(path.join(outDir, 'main', 'ipc', 'project-workspace-handlers.js')).registerProjectWorkspaceIpc()
  const event = {
    sender: electron.__trustedSender,
    senderFrame: electron.__trustedSender.mainFrame
  }
  const digitalGateway = electron.__handlers.get('digitalWorker:invoke')
  const projectGateway = electron.__handlers.get('projectWorkspace:invoke')
  assert(digitalGateway && projectGateway, 'legacy IPC gateways must register')
  const invokeDigital = (action, payload) => digitalGateway(
    event,
    payload === undefined ? { action } : { action, payload }
  )
  const invokeProject = (action, ...args) => projectGateway(event, action, ...args)
  return { projectStore, workerStore, crash, invokeDigital, invokeProject }
}

async function exerciseLegacyReassignCrash(context) {
  const { projectStore, workerStore, crash, invokeDigital, invokeProject } = context
  const first = await invokeDigital('createDigitalWorkerAssignment', {
    input: assignmentInput('ipc-assignment-a', 'ipc-work-reassign-crash', 'ipc-worker-a')
  })
  assertEqual(
    (await projectStore.getWorkItem(first.workItemId)).owner?.id,
    'ipc-worker-a',
    'old create action must atomically write WorkItem owner'
  )
  await assertRejects(
    invokeProject('workItems:update', first.workItemId, { owner: null }),
    (error) => /controlled by active Assignment/.test(String(error?.message)),
    'generic WorkItem update must not bypass active Assignment owner coordination'
  )
  const lease = await invokeDigital('acquireDigitalWorkerLease', {
    input: {
      projectId: first.projectId,
      workItemId: first.workItemId,
      workerId: first.assigneeId,
      assignmentId: first.id,
      ttlMs: 60_000
    }
  })
  await assertRejects(
    invokeDigital('releaseDigitalWorkerAssignment', { id: first.id }),
    (error) => /active lease/.test(String(error?.message)),
    'Assignment release must fail while its execution lease is active'
  )
  await assertRejects(
    invokeProject('workItems:transition', first.workItemId, 'cancelled'),
    (error) => /active Assignment/.test(String(error?.message)),
    'WorkItem terminal transition must fail while its Assignment is active'
  )
  await assertRejects(
    invokeProject('archive', first.projectId),
    (error) => /active Assignment/.test(String(error?.message)),
    'Project archive must fail while an Assignment is active'
  )
  await invokeDigital('releaseDigitalWorkerLease', {
    input: { leaseId: lease.id, fencingToken: lease.fencingToken }
  })
  crash.at('reassign', 'after_owner_write')
  await assertRejects(
    invokeDigital('reassignDigitalWorkerAssignment', {
      input: {
        currentAssignmentId: first.id,
        nextInput: assignmentInput('ipc-assignment-b', first.workItemId, 'ipc-worker-b'),
        expectedRevision: first.revision,
        reason: 'crash after owner write'
      }
    }),
    (error) => error?.name === 'AssignmentOwnerCrashSimulationError',
    'old reassign action must expose the owner-write crash boundary'
  )
  assertEqual(
    (await projectStore.getWorkItem(first.workItemId)).owner?.id,
    'ipc-worker-b',
    'reassign crash must persist the new owner before recovery'
  )
  assertEqual(
    (await workerStore.getAssignment(first.id)).status,
    'active',
    'reassign owner-write crash must preserve the old Assignment'
  )
  await invokeDigital('recoverDigitalWorkerAssignmentOwners')
  assertEqual((await workerStore.getAssignment(first.id)).status, 'released', 'retry must release the old Assignment')
  assertEqual((await workerStore.getAssignment('ipc-assignment-b')).status, 'active', 'retry must create the new Assignment')
  return workerStore.getAssignment('ipc-assignment-b')
}

async function exerciseLegacyReleaseCrash(context, activeB) {
  const { projectStore, workerStore, crash, invokeDigital } = context
  crash.at('release', 'after_assignment_release')
  await assertRejects(
    invokeDigital('releaseDigitalWorkerAssignment', {
      id: activeB.id,
      options: { expectedRevision: activeB.revision },
      releaseOptions: { now: 500, reason: 'crash after release write' }
    }),
    (error) => error?.name === 'AssignmentOwnerCrashSimulationError',
    'old release action must expose the Assignment-write crash boundary'
  )
  assertEqual((await workerStore.getAssignment(activeB.id)).status, 'released', 'release crash must persist history')
  assertEqual((await projectStore.getWorkItem(activeB.workItemId)).owner, undefined, 'release crash must clear owner')
  await invokeDigital('recoverDigitalWorkerAssignmentOwners')
}

async function exerciseReadinessRetry(context) {
  const { projectStore, crash, invokeDigital, invokeProject } = context
  const guarded = await invokeDigital('createDigitalWorkerAssignment', {
    input: assignmentInput('ipc-guarded-assignment', 'ipc-work-readiness-retry', 'ipc-worker-a')
  })
  crash.at('release', 'after_owner_clear')
  await assertRejects(
    invokeDigital('releaseDigitalWorkerAssignment', { id: guarded.id }),
    (error) => error?.name === 'AssignmentOwnerCrashSimulationError',
    'readiness fixture must crash after owner clear'
  )
  let guardedItem = await projectStore.getWorkItem(guarded.workItemId)
  guardedItem = await projectStore.updateWorkItem(guardedItem.id, {
    owner: { type: 'human', id: 'conflicting-owner' }
  }, {
    expectedRevision: guardedItem.revision,
    expectedStoreRevision: await projectStore.getRevision()
  })
  await assertRejects(
    invokeDigital('recoverDigitalWorkerAssignmentOwners'),
    (error) => error?.code === 'RECOVERY_PENDING',
    'unresolved recovery must reject and close readiness'
  )
  await assertRejects(
    invokeDigital('getDigitalWorkerAssignment', { id: guarded.id }),
    (error) => error?.code === 'RECOVERY_PENDING',
    'Assignment reads must fail closed while readiness is rejected'
  )
  await assertRejects(
    invokeProject('workItems:get', guarded.workItemId),
    (error) => error?.code === 'RECOVERY_PENDING',
    'WorkItem reads must share the rejected readiness barrier'
  )
  const audit = await invokeDigital('listDigitalWorkerAssignmentOwnerAudit', {})
  const pendingAudit = [...audit].reverse().find((event) => event.assignmentId === guarded.id)
  assert(pendingAudit, 'audit diagnostics must remain readable while readiness is rejected')
  const journalEntry = await invokeDigital('getDigitalWorkerAssignmentOwnerJournal', {
    requestId: pendingAudit.requestId
  })
  assertEqual(journalEntry.phase, 'compensation_pending', 'diagnostics must expose the pending phase')

  guardedItem = await projectStore.updateWorkItem(guardedItem.id, {
    owner: { type: 'digital_worker', id: 'ipc-worker-a', displayName: 'IPC Worker A' }
  }, {
    expectedRevision: guardedItem.revision,
    expectedStoreRevision: await projectStore.getRevision()
  })
  const recovered = await invokeDigital('recoverDigitalWorkerAssignmentOwners')
  assert(
    recovered.some((outcome) => outcome.requestId === journalEntry.requestId && outcome.recovered),
    'explicit retry must replace rejected readiness after recovery succeeds'
  )
  assertEqual(
    (await invokeDigital('getDigitalWorkerAssignment', { id: guarded.id })).status,
    'active',
    'ordinary Assignment reads must reopen after retry'
  )
  assertEqual(
    (await invokeProject('workItems:get', guarded.workItemId)).owner?.id,
    'ipc-worker-a',
    'ordinary WorkItem reads must reopen after retry'
  )
}

function assignmentInput(id, workItemId, assigneeId) {
  return {
    id,
    projectId: 'ipc-project',
    workItemId,
    assigneeKind: 'digital_worker',
    assigneeId,
    assignedBy: 'ipc-owner'
  }
}

function installCoordinatorCrashShim() {
  const errors = require(path.join(outDir, 'main', 'assignment-owner-coordinator', 'errors.js'))
  const release = require(path.join(outDir, 'main', 'assignment-owner-coordinator', 'release-operation.js'))
  const reassign = require(path.join(outDir, 'main', 'assignment-owner-coordinator', 'reassign-operation.js'))
  let selected
  patch(release.AssignmentReleaseOperation.prototype, 'release')
  patch(reassign.AssignmentReassignOperation.prototype, 'reassign')
  return { at: (operation, point) => { selected = { operation, point } } }

  function patch(prototype, operation) {
    const original = prototype.checkpoint
    prototype.checkpoint = async function patchedCheckpoint(point, entry) {
      if (selected?.operation === operation && selected.point === point) {
        selected = undefined
        throw new errors.AssignmentOwnerCrashSimulationError(point, 'IPC smoke crash')
      }
      return original.call(this, point, entry)
    }
  }
}

function installElectronShim() {
  const shimDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(shimDir, { recursive: true })
  writeFileSync(path.join(shimDir, 'index.js'), `
const handlers = new Map()
const mainFrame = { url: process.env.CAOGEN_ASSIGNMENT_OWNER_TEST_RENDERER_URL }
const trustedSender = {
  mainFrame,
  isDestroyed: () => false,
  getURL: () => mainFrame.url
}
module.exports = {
  __handlers: handlers,
  __trustedSender: trustedSender,
  app: {
    getPath(name) {
      if (name !== 'userData') throw new Error('unexpected app path request: ' + name)
      return process.env.CAOGEN_ASSIGNMENT_OWNER_TEST_USER_DATA
    }
  },
  BrowserWindow: { getAllWindows: () => [{ webContents: trustedSender }] },
  ipcMain: {
    handle(channel, handler) {
      if (handlers.has(channel)) throw new Error('duplicate IPC handler: ' + channel)
      handlers.set(channel, handler)
    }
  }
}
`)
}

async function assertRejects(promise, predicate, message) {
  try {
    await promise
  } catch (error) {
    if (predicate(error)) return
    throw new Error(`${message}: unexpected error ${error instanceof Error ? error.stack : String(error)}`)
  }
  throw new Error(`${message}: operation unexpectedly succeeded`)
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
