#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-work-item-transfer-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')

try {
  compileSources()
  const projectDomain = require(path.join(outDir, 'main', 'project-workspace', 'index.js'))
  const workerDomain = require(path.join(outDir, 'main', 'digital-worker', 'index.js'))
  const coordinatorDomain = require(path.join(outDir, 'main', 'assignment-owner-coordinator', 'index.js'))
  const projectStore = await new projectDomain.ProjectWorkspaceStore(userData).open()
  const workerStore = new workerDomain.DigitalWorkerStore(userData)
  const service = projectDomain.createWorkItemTransferService(userData)
  const localActor = projectDomain.LOCAL_USER_ACTOR

  const projectA = await projectStore.createWorkspace({ id: 'project-a', name: 'Project A', kind: 'software' })
  const projectB = await projectStore.createWorkspace({ id: 'project-b', name: 'Project B', kind: 'research' })
  const role = await workerStore.createRoleTemplate({
    id: 'transfer-role',
    name: 'Transfer worker',
    purpose: 'Exercise WorkItem transfer ownership'
  })
  const workerA = await createWorker('worker-a', projectA.id, 'Worker A', 'active')
  const workerB = await createWorker('worker-b', projectB.id, 'Worker B', 'active')
  const retiredWorker = await createWorker('worker-retired', projectA.id, 'Retired Worker', 'retired')

  let humanItem = await createHumanItem('work-human-human', 'human-a', 'Human A', 'ready')
  const staleLease = await projectStore.acquireWorkItemLease(humanItem.id, {
    expectedRevision: humanItem.revision,
    ownerId: 'human-a',
    leaseId: 'lease-human-a',
    durationMs: 60_000
  })
  humanItem = staleLease
  const oldAuthorization = projectDomain.inspectWorkItemAuthorization(
    projectA,
    humanItem,
    { type: 'human', id: 'human-a' }
  )
  assert(oldAuthorization.capabilities.includes('transfer'), 'current human owner must be allowed to transfer')

  const humanInput = transferInput(
    'transfer-human-a-to-b',
    humanItem,
    { type: 'human', id: 'human-b', displayName: 'Human B' },
    'Hand work to the next human owner'
  )
  const humanTransfer = await service.transfer(humanInput, localActor)
  assertEqual(humanTransfer.previousOwner?.id, 'human-a', 'human transfer must retain the previous owner')
  assertEqual(humanTransfer.owner.id, 'human-b', 'human transfer must write the new owner')
  assertEqual(humanTransfer.workItem.lease, undefined, 'owner transfer must revoke the old WorkItem lease')
  assert(humanTransfer.auditEventIds.length >= 3, 'human transfer must return correlated audit event IDs')

  await assertRejects(
    projectStore.renewWorkItemLease(humanItem.id, {
      expectedRevision: humanTransfer.workItem.revision,
      ownerId: 'human-a',
      leaseId: staleLease.lease.id,
      fencingToken: staleLease.lease.fencingToken
    }),
    (error) => error?.code === 'lease_expired' || error?.code === 'stale_lease',
    'revoked WorkItem lease must not renew'
  )

  const oldOwnerAfter = projectDomain.inspectWorkItemAuthorization(
    projectA,
    humanTransfer.workItem,
    { type: 'human', id: 'human-a' }
  )
  const newOwnerAfter = projectDomain.inspectWorkItemAuthorization(
    projectA,
    humanTransfer.workItem,
    { type: 'human', id: 'human-b' }
  )
  assertEqual(oldOwnerAfter.capabilities.length, 0, 'old owner must immediately lose authorization')
  assert(newOwnerAfter.capabilities.includes('execute'), 'new owner must immediately gain authorization')
  const humanHistory = await workerStore.listAssignments({ workItemId: humanItem.id, includeHistory: true })
  assertEqual(humanHistory.length, 2, 'human transfer must retain released and active Assignment history')
  assertEqual(humanHistory.filter((entry) => entry.status === 'active').length, 1, 'human transfer must leave one active Assignment')
  assertEqual(humanHistory.find((entry) => entry.status === 'released')?.assigneeId, 'human-a', 'old Assignment must be released')

  const restartedService = projectDomain.createWorkItemTransferService(userData)
  const replay = await restartedService.transfer(humanInput, localActor)
  assertEqual(replay.assignmentId, humanTransfer.assignmentId, 'restart replay must return the original Assignment')
  assertEqual(replay.idempotentReplay, true, 'restart replay must be marked idempotent')
  assertEqual(
    (await workerStore.listAssignments({ workItemId: humanItem.id, includeHistory: true })).length,
    2,
    'restart replay must not duplicate Assignment history'
  )
  await assertRejects(
    restartedService.transfer({
      ...humanInput,
      target: { type: 'human', id: 'human-c', displayName: 'Human C' }
    }, localActor),
    (error) => error?.code === 'request_conflict',
    'requestId reuse with another target must fail closed'
  )
  await assertRejects(
    restartedService.transfer({ ...humanInput, expectedRevision: humanInput.expectedRevision + 1 }, localActor),
    (error) => error?.code === 'request_conflict',
    'requestId reuse with another CAS precondition must fail closed'
  )

  const workerItem = await createHumanItem('work-human-worker', 'human-c', 'Human C')
  const workerTransfer = await service.transfer(transferInput(
    'transfer-human-to-worker',
    workerItem,
    { type: 'digital_worker', id: workerA.id },
    'Delegate execution to the active digital worker'
  ), localActor)
  assertEqual(workerTransfer.owner.id, workerA.id, 'human to DigitalWorker transfer must write the worker owner')
  assertEqual(workerTransfer.authorization.actor.id, workerA.id, 'transfer result must expose the new owner authorization')
  assert(workerTransfer.authorization.capabilities.includes('execute'), 'new DigitalWorker owner must be executable')

  const workerLease = await workerStore.acquireLease({
    projectId: projectA.id,
    workItemId: workerItem.id,
    workerId: workerA.id,
    assignmentId: workerTransfer.assignmentId,
    ttlMs: 60_000
  })
  await assertRejects(
    service.transfer(transferInput(
      'transfer-active-worker-lease',
      workerTransfer.workItem,
      { type: 'human', id: 'human-d', displayName: 'Human D' },
      'Attempt transfer while execution is fenced'
    ), localActor),
    (error) => /active lease/i.test(String(error?.message)),
    'active DigitalWorker lease must block reassignment'
  )
  assertEqual((await projectStore.getWorkItem(workerItem.id)).owner?.id, workerA.id, 'lease conflict must preserve owner')
  assertEqual(
    (await workerStore.listAssignments({ workItemId: workerItem.id, includeHistory: true })).length,
    2,
    'lease conflict must not append Assignment history'
  )
  await workerStore.releaseLease({ leaseId: workerLease.id, fencingToken: workerLease.fencingToken })

  const staleItem = await createHumanItem('work-stale', 'human-a', 'Human A')
  await projectStore.updateWorkItem(staleItem.id, { title: 'Externally changed' }, { expectedRevision: staleItem.revision })
  await assertRejects(
    service.transfer(transferInput(
      'transfer-stale-revision',
      staleItem,
      { type: 'human', id: 'human-b' },
      'Stale caller must not take ownership'
    ), localActor),
    (error) => error?.code === 'authorization_revision_conflict',
    'stale WorkItem revision must fail before transfer'
  )
  assertEqual(
    (await workerStore.listAssignments({ workItemId: staleItem.id, includeHistory: true })).length,
    0,
    'stale transfer must leave no Assignment history'
  )

  const crossItem = await createHumanItem('work-cross-project', 'human-a', 'Human A')
  await assertRejects(
    service.transfer(transferInput(
      'transfer-cross-project-worker',
      crossItem,
      { type: 'digital_worker', id: workerB.id },
      'Cross-project target must be rejected'
    ), localActor),
    (error) => error?.code === 'project_scope_conflict',
    'cross-project DigitalWorker must fail closed'
  )
  assertEqual(
    (await workerStore.listAssignments({ workItemId: crossItem.id, includeHistory: true })).length,
    0,
    'cross-project target rejection must have zero persistence side effects'
  )

  const retiredItem = await createHumanItem('work-retired-worker', 'human-a', 'Human A')
  await assertRejects(
    service.transfer(transferInput(
      'transfer-retired-worker',
      retiredItem,
      { type: 'digital_worker', id: retiredWorker.id },
      'Retired target must be rejected'
    ), localActor),
    (error) => error?.code === 'target_inactive',
    'retired DigitalWorker must fail closed'
  )
  assertEqual(
    (await workerStore.listAssignments({ workItemId: retiredItem.id, includeHistory: true })).length,
    0,
    'retired target rejection must have zero persistence side effects'
  )

  const restartedProjectStore = await new projectDomain.ProjectWorkspaceStore(userData).open()
  const persistedHumanItem = await restartedProjectStore.getWorkItem(humanItem.id)
  assertEqual(persistedHumanItem?.owner?.id, 'human-b', 'new owner must survive ProjectWorkspace restart readback')
  assertEqual(persistedHumanItem?.lease, undefined, 'revoked WorkItem lease must stay revoked after restart')
  const restartedCoordinator = await coordinatorDomain.openAssignmentOwnerCoordinator(userData)
  const persistedJournal = await restartedCoordinator.getJournalEntry(humanInput.requestId)
  const persistedAudit = await restartedCoordinator.listAudit(humanInput.requestId)
  assertEqual(persistedJournal?.phase, 'committed', 'transfer journal must remain committed after restart')
  assertEqual(persistedJournal?.releaseReason, humanInput.reason, 'transfer reason must remain in immutable journal history')
  assert(persistedAudit.some((event) => event.kind === 'coordinator.committed'), 'committed audit must persist after restart')

  console.log(JSON.stringify({
    status: 'PASS',
    checks: [
      'human-a-to-human-b-transfer',
      'human-to-digital-worker-transfer',
      'old-owner-denied-new-owner-authorized',
      'work-item-lease-revocation-and-stale-renewal-rejection',
      'assignment-history-retention',
      'request-idempotency-and-payload-conflict',
      'stale-work-item-cas-rejection',
      'cross-project-and-retired-worker-zero-side-effect-rejection',
      'active-digital-worker-lease-conflict',
      'restart-readback-journal-and-audit-persistence'
    ],
    auditEvents: persistedAudit.length,
    humanAssignmentHistory: humanHistory.length
  }, null, 2))

  async function createHumanItem(id, ownerId, displayName, status = 'backlog') {
    return projectStore.createWorkItem({
      id,
      projectId: projectA.id,
      title: id,
      owner: { type: 'human', id: ownerId, displayName },
      status
    })
  }

  async function createWorker(id, projectId, displayName, desiredStatus) {
    const proposed = await workerStore.createDigitalWorker({
      id,
      projectId,
      roleTemplateId: role.id,
      displayName,
      memoryNamespace: `project:${projectId}:worker:${id}`
    })
    const active = await workerStore.activateDigitalWorker(id, { expectedRevision: proposed.revision })
    if (desiredStatus === 'active') return active
    return workerStore.retireDigitalWorker(id, { expectedRevision: active.revision })
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function transferInput(requestId, workItem, target, reason) {
  return { requestId, workItemId: workItem.id, target, reason, expectedRevision: workItem.revision }
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/assignment-owner-coordinator/index.ts',
    'src/main/digital-worker/index.ts',
    'src/main/project-workspace/index.ts',
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
