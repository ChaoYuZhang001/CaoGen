#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-acceptance-repair-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')

process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
mkdirSync(userData, { recursive: true })

try {
  compileSources()
  installElectronStub()
  const api = await loadCompiled('workflow-ledger-api.js')
  const handlers = await loadCompiled('workflow-ledger-handlers.js')
  const repairRuntime = await loadCompiled('workflow-acceptance-repair-coordinator.js')
  const projectStoreApi = await loadCompiledAt('main/project-workspace/store.js')
  const projectCommandsApi = await loadCompiledAt('main/project-workspace/command-service.js')

  const store = await projectStoreApi.openProjectWorkspaceStore(userData)
  await store.createWorkspace({ id: 'repair-project', name: 'Repair project', kind: 'software' })
  const commands = projectCommandsApi.createProjectWorkspaceCommandService(store, { rootDir: userData })
  await commands.reconcileShadowProjection()
  const goal = await commands.createGoal({
    id: 'repair-goal',
    projectId: 'repair-project',
    title: 'Ship accepted work',
    objective: 'Repair every failed acceptance before retest'
  })
  const source = await commands.createWorkItem({
    id: 'repair-source',
    projectId: 'repair-project',
    goalId: goal.id,
    type: 'testing',
    title: 'Original verification',
    status: 'verifying',
    owner: { type: 'human', id: 'repair-owner', displayName: 'Repair owner' },
    acceptanceSpec: [{ id: 'source-criterion', criterion: 'verification passes', required: true }]
  })
  const acceptance = await api.saveWorkflowAcceptance({
    id: 'acceptance-repair',
    projectId: source.projectId,
    goalId: source.goalId,
    workItemId: source.id,
    criteria: ['verification passes'],
    criterionPolicies: [{
      criterionId: 'source-criterion',
      criterionIndex: 0,
      evidenceKind: 'test_result',
      allowedSources: ['runtime']
    }]
  }, userData)
  const evidence = await createEvidence(api, source, 'repair-review-evidence', 'a')
  const failedResult = await handlers.reviewWorkflowAcceptance({
    acceptanceId: acceptance.id,
    criterionEvidence: [{ criterionIndex: 0, evidenceRefs: [evidence.evidenceId] }],
    decision: 'failed',
    notes: 'fixture failure'
  }, authority('reviewer', 1_000), userData)

  assert.equal(failedResult.acceptance.status, 'failed')
  assert.deepEqual(failedResult.acceptance.criterionPolicies, acceptance.criterionPolicies)
  assert.equal(failedResult.repair?.disposition, 'created')
  const firstRepairId = failedResult.repair?.workItemId
  const firstRepairAcceptanceId = failedResult.repair?.acceptanceId
  assert(firstRepairId)
  assert(firstRepairAcceptanceId)
  const firstRepair = await store.getWorkItem(firstRepairId)
  assert(firstRepair)
  assert.equal(firstRepair.parentId, source.id)
  assert.equal(firstRepair.projectId, source.projectId)
  assert.equal(firstRepair.goalId, source.goalId)
  const repairAcceptanceBeforeReview = (await api.listWorkflowLedger({ projectId: source.projectId }, userData))
    .acceptances.items.find((item) => item.id === firstRepairAcceptanceId)
  assert(repairAcceptanceBeforeReview)
  assert.deepEqual(repairAcceptanceBeforeReview.criterionPolicies, [{
    criterionId: firstRepair.acceptanceSpec[0].id,
    criterionIndex: 0,
    evidenceKind: 'test_result',
    allowedSources: ['runtime']
  }], 'repair Acceptance must inherit the failed policy with repair-scoped criterion identity')

  const coordinator = await repairRuntime.openWorkflowAcceptanceRepairCoordinator(userData)
  const duplicates = await Promise.all([
    coordinator.ensureRepairWorkItem(failedResult.acceptance),
    coordinator.ensureRepairWorkItem(failedResult.acceptance)
  ])
  assert(duplicates.every((result) => result.repairWorkItemId === firstRepairId))
  assert.equal((await store.listWorkItems(source.projectId)).filter((item) => item.id === firstRepairId).length, 1)

  await expectCode(
    handlers.reviewWorkflowAcceptance({
      acceptanceId: acceptance.id,
      criterionEvidence: [],
      decision: 'retest'
    }, authority('reviewer', 1_500), userData),
    'WORKFLOW_REPAIR_INCOMPLETE'
  )
  await verifyBoundaryFailures(repairRuntime, failedResult.acceptance, source)

  const repairEvidence = await createEvidence(api, firstRepair, 'repair-completion-evidence', 'c')
  const wrongRepairEvidence = await api.createWorkflowEvidence({
    evidenceId: 'repair-wrong-kind-evidence',
    projectId: firstRepair.projectId,
    goalId: firstRepair.goalId,
    workItemId: firstRepair.id,
    kind: 'observation',
    title: 'repair-wrong-kind-evidence',
    contentDigest: 'd'.repeat(64)
  }, userData, { source: 'runtime', verifier: 'acceptance-repair-smoke', observedAt: Date.now() })
  await assert.rejects(
    handlers.reviewWorkflowAcceptance({
      acceptanceId: firstRepairAcceptanceId,
      criterionEvidence: [{ criterionIndex: 0, evidenceRefs: [wrongRepairEvidence.evidenceId] }],
      decision: 'passed'
    }, authority('repair-reviewer', 1_625), userData),
    (error) => error?.code === 'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID' &&
      error?.details?.reason === 'criterion_policy_kind_mismatch',
    'repair Acceptance must enforce the propagated criterion policy'
  )
  const repairAcceptance = await handlers.reviewWorkflowAcceptance({
    acceptanceId: firstRepairAcceptanceId,
    criterionEvidence: [{ criterionIndex: 0, evidenceRefs: [repairEvidence.evidenceId] }],
    decision: 'passed',
    notes: 'repair work verified'
  }, authority('repair-reviewer', 1_650), userData)
  assert.equal(repairAcceptance.acceptance.status, 'passed')

  let completedRepair = await commands.setWorkItemAcceptance(firstRepairId, {
    status: 'passed',
    evidenceRefs: ['repair-result-proof'],
    verifiedBy: 'repair-reviewer',
    verifiedAt: 1_700
  })
  completedRepair = await commands.acquireWorkItemLease(firstRepairId, {
    expectedRevision: completedRepair.revision,
    ownerId: completedRepair.owner.id
  })
  completedRepair = await commands.transitionWorkItem(firstRepairId, 'running', completedRepair.revision)
  completedRepair = await commands.transitionWorkItem(firstRepairId, 'verifying', completedRepair.revision)
  completedRepair = await commands.transitionWorkItem(firstRepairId, 'done', completedRepair.revision)
  assert.equal(completedRepair.status, 'done')

  const authorizedPlan = await coordinator.prepareRetest(failedResult.acceptance, { updatedAt: 1_900 })
  assert.deepEqual(authorizedPlan.acceptanceInput.criterionPolicies, acceptance.criterionPolicies)
  repairRuntime.assertWorkflowAcceptanceRetestPlanCurrent(failedResult.acceptance, authorizedPlan)
  assert.throws(
    () => repairRuntime.assertWorkflowAcceptanceRetestPlanCurrent({
      ...failedResult.acceptance,
      revision: failedResult.acceptance.revision + 1
    }, authorizedPlan),
    (error) => error?.code === 'WORKFLOW_REPAIR_REVISION_CONFLICT'
  )

  const retested = await handlers.reviewWorkflowAcceptance({
    acceptanceId: acceptance.id,
    criterionEvidence: [],
    decision: 'retest',
    notes: 'repair completed'
  }, authority('reviewer', 2_000), userData)
  assert.equal(retested.acceptance.status, 'verifying')
  assert.deepEqual(retested.acceptance.criterionPolicies, acceptance.criterionPolicies)
  assert.deepEqual(retested.acceptance.evidenceRefs, [])
  assert.equal(retested.acceptance.criterionEvidence, undefined)
  assert.equal(retested.acceptance.verifier, undefined)
  assert.equal(retested.repair?.workItemId, firstRepairId)
  assert.equal(retested.repair?.disposition, 'completed')

  const secondEvidence = await createEvidence(api, source, 'repair-review-evidence-2', 'b')
  const failedAgain = await handlers.reviewWorkflowAcceptance({
    acceptanceId: acceptance.id,
    criterionEvidence: [{ criterionIndex: 0, evidenceRefs: [secondEvidence.evidenceId] }],
    decision: 'failed',
    notes: 'fixture failed again'
  }, authority('reviewer', 3_000), userData)
  assert.equal(failedAgain.acceptance.status, 'failed')
  assert.notEqual(failedAgain.repair?.workItemId, firstRepairId)
  assert.equal(failedAgain.repair?.failedAcceptanceRevision, failedAgain.acceptance.revision)

  const crashSource = await commands.createWorkItem({
    id: 'repair-crash-source',
    projectId: source.projectId,
    goalId: source.goalId,
    type: 'testing',
    title: 'Crash recovery source',
    status: 'verifying',
    acceptanceSpec: [{ id: 'crash-criterion', criterion: 'crash recovery passes', required: true }]
  })
  const crashPending = await api.saveWorkflowAcceptance({
    id: 'acceptance-repair-crash',
    projectId: crashSource.projectId,
    goalId: crashSource.goalId,
    workItemId: crashSource.id,
    criteria: ['crash recovery passes'],
    criterionPolicies: [{
      criterionId: 'crash-criterion',
      criterionIndex: 0,
      evidenceKind: 'test_result',
      allowedSources: ['runtime']
    }]
  }, userData)
  const crashVerifying = await api.saveWorkflowAcceptance({
    ...crashPending,
    status: 'verifying',
    revision: crashPending.revision + 1,
    updatedAt: 3_500
  }, userData)
  const crashFailed = await api.saveWorkflowAcceptance({
    ...crashVerifying,
    status: 'failed',
    revision: crashVerifying.revision + 1,
    updatedAt: 3_600
  }, userData)
  const crashRepairId = repairRuntime.workflowAcceptanceRepairWorkItemId(crashFailed.id, crashFailed.revision)
  assert.equal(await store.getWorkItem(crashRepairId), undefined)
  const recovery = await handlers.recoverWorkflowAcceptanceRepairs(userData)
  assert.equal(recovery.failures.length, 0)
  assert(recovery.recovered.some((result) => result.repairWorkItemId === crashRepairId))
  const crashRepair = await store.getWorkItem(crashRepairId)
  assert(crashRepair)
  const crashRepairAcceptanceId = repairRuntime.workflowAcceptanceRepairAcceptanceId(crashRepairId)
  const ledger = await api.listWorkflowLedger({ projectId: source.projectId }, userData)
  const crashRepairAcceptance = ledger.acceptances.items.find((item) => item.id === crashRepairAcceptanceId)
  assert(crashRepairAcceptance)
  assert.deepEqual(crashRepairAcceptance.criterionPolicies, [{
    criterionId: crashRepair.acceptanceSpec[0].id,
    criterionIndex: 0,
    evidenceKind: 'test_result',
    allowedSources: ['runtime']
  }], 'startup repair recovery must propagate criterion policy')

  console.log('acceptance repair/retest smoke: pass')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

async function createEvidence(api, source, evidenceId, digestCharacter) {
  return api.createWorkflowEvidence({
    evidenceId,
    projectId: source.projectId,
    goalId: source.goalId,
    workItemId: source.id,
    kind: 'test_result',
    source: 'runtime',
    title: evidenceId,
    verifier: 'acceptance-repair-smoke',
    observedAt: Date.now(),
    contentDigest: digestCharacter.repeat(64)
  }, userData)
}

async function verifyBoundaryFailures(runtime, acceptance, source) {
  const repairId = runtime.workflowAcceptanceRepairWorkItemId(acceptance.id, acceptance.revision)
  const crossProject = { ...source, projectId: 'other-project' }
  const boundary = new runtime.WorkflowAcceptanceRepairCoordinator({
    commands: { createWorkItem: async () => { throw new Error('must not create') } },
    reader: { getWorkItem: async (id) => id === source.id ? crossProject : undefined }
  })
  await expectCode(boundary.ensureRepairWorkItem(acceptance), 'WORKFLOW_REPAIR_PROJECT_BOUNDARY')

  const collision = new runtime.WorkflowAcceptanceRepairCoordinator({
    commands: { createWorkItem: async () => { throw new Error('must not create') } },
    reader: {
      getWorkItem: async (id) => {
        if (id === source.id) return source
        if (id === repairId) return { ...source, id: repairId, parentId: 'wrong-parent', type: 'custom' }
        return undefined
      }
    }
  })
  await expectCode(collision.ensureRepairWorkItem(acceptance), 'WORKFLOW_REPAIR_CONFLICT')
}

function authority(actorId, reviewedAt) {
  return { actorId, verifier: actorId, reviewedAt }
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code, `expected ${code}`)
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/task/task-snapshot.ts',
    'src/main/task/workflow-ledger-api.ts',
    'src/main/task/workflow-ledger-store.ts',
    'src/main/task/workflow-acceptance-guard.ts',
    'src/main/task/workflow-acceptance-repair-coordinator.ts',
    'src/main/project-workspace/store.ts',
    'src/main/project-workspace/command-service.ts',
    'src/main/ipc/workflow-ledger-handlers.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), [
    `export const app = { getPath: () => ${JSON.stringify(userData)} }`,
    'export const ipcMain = { handle() {} }',
    'export const BrowserWindow = { getAllWindows: () => [] }'
  ].join('\n') + '\n')
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

async function loadCompiled(fileName) {
  return import(pathToFileURL(findCompiled(outDir, fileName)).href)
}

async function loadCompiledAt(relativePath) {
  return import(pathToFileURL(path.join(outDir, relativePath)).href)
}

function findCompiled(root, fileName) {
  for (const entry of require('node:fs').readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledMaybe(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  throw new Error(`compiled ${fileName} not found`)
}

function findCompiledMaybe(root, fileName) {
  try {
    return findCompiled(root, fileName)
  } catch {
    return undefined
  }
}
