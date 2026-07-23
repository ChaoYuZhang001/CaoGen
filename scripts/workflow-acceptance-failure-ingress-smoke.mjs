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
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-failure-ingress-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
const acceptanceBindings = new Map()

process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
mkdirSync(userData, { recursive: true })

try {
  compileSources()
  installElectronStub()
  const api = await loadCompiledAt('main/task/workflow-ledger-api.js')
  const ingress = await loadCompiledAt('main/task/workflow-acceptance-failure-ingress.js')
  const repairRuntime = await loadCompiledAt('main/task/workflow-acceptance-repair-coordinator.js')
  const repairService = await loadCompiledAt('main/task/workflow-acceptance-repair-service.js')
  const storeApi = await loadCompiledAt('main/project-workspace/store.js')
  const commandApi = await loadCompiledAt('main/project-workspace/command-service.js')

  const store = await storeApi.openProjectWorkspaceStore(userData)
  await store.createWorkspace({ id: 'failure-project', name: 'Failure project', kind: 'software' })
  await store.createWorkspace({ id: 'foreign-project', name: 'Foreign project', kind: 'software' })
  const commands = commandApi.createProjectWorkspaceCommandService(store, { rootDir: userData })
  await commands.reconcileShadowProjection()
  const goal = await commands.createGoal({
    id: 'failure-goal',
    projectId: 'failure-project',
    title: 'Close failures',
    objective: 'Every trusted failure creates a repair'
  })
  const foreignGoal = await commands.createGoal({
    id: 'foreign-goal',
    projectId: 'foreign-project',
    title: 'Foreign goal',
    objective: 'Stay isolated'
  })

  const cross = await createItem(commands, goal, 'cross-item', 'coding')
  const crossAcceptance = await createAcceptance(api, cross, 'cross-acceptance', ['review is clean', 'requested behavior is complete'])
  const crossInput = crossFailure(cross, 'cross-event-1', { observedAt: 1_000 })
  const crossResult = await ingress.ingestWorkflowAcceptanceFailure(crossInput, userData)
  assert.equal(crossResult.acceptance.status, 'failed')
  assert.equal(crossResult.acceptance.criteria.length, crossResult.evidenceLinks.length)
  assert.equal(crossResult.evidence.kind, 'review_result')
  assert.equal(crossResult.evidence.metadata.acceptanceId, crossAcceptance.id)
  assert.equal(crossResult.evidence.metadata.sourceAcceptanceRevision, crossAcceptance.revision)
  assert.equal(crossResult.evidence.metadata.failedAcceptanceRevision, crossResult.acceptance.revision)
  assert.deepEqual(crossResult.evidence.metadata.criterionIndexes, [0, 1])
  assert.equal(crossResult.audit.authority, 'system')
  assert.equal(crossResult.audit.acceptanceId, crossAcceptance.id)
  assert.equal(crossResult.repair.disposition, 'created')
  assert(await store.getWorkItem(crossResult.repair.workItemId))
  assert((await api.listWorkflowLedger({ acceptanceId: crossResult.repair.acceptanceId }, userData)).acceptances.items.length === 1)

  const beforeReplay = await counts(api, cross.projectId)
  const replay = await ingress.ingestWorkflowAcceptanceFailure(crossInput, userData)
  assert.equal(replay.replayed, true)
  assert.equal(replay.acceptance.revision, crossResult.acceptance.revision)
  assert.equal(replay.repair.workItemId, crossResult.repair.workItemId)
  assert.deepEqual(await counts(api, cross.projectId), beforeReplay)
  const reorderedReplay = await ingress.ingestWorkflowAcceptanceFailure({
    ...crossInput,
    criterionIndexes: [1, 0]
  }, userData)
  assert.equal(reorderedReplay.replayed, true)
  await expectCode(
    ingress.ingestWorkflowAcceptanceFailure({ ...crossInput, criterionIndexes: [0] }, userData),
    'WORKFLOW_FAILURE_REPLAY_CONFLICT'
  )
  await expectCode(
    ingress.ingestWorkflowAcceptanceFailure({ ...crossInput, contentDigest: 'b'.repeat(64) }, userData),
    'WORKFLOW_FAILURE_REPLAY_CONFLICT'
  )
  assert.deepEqual(await counts(api, cross.projectId), beforeReplay)

  const testItem = await createItem(commands, goal, 'test-item', 'testing')
  await createAcceptance(api, testItem, 'test-acceptance', ['targeted tests pass'])
  const testResult = await ingress.ingestWorkflowAcceptanceFailure(testFailure(testItem, 'test-event-1', {
    observedAt: 2_000,
    exitCode: 2
  }), userData)
  assert.equal(testResult.acceptance.status, 'failed')
  assert.equal(testResult.evidence.kind, 'test_result')
  assert.equal(testResult.evidence.metadata.exitCode, 2)

  const staleItem = await createItem(commands, goal, 'stale-first-arrival-item', 'coding')
  const staleAcceptance = await createAcceptance(
    api, staleItem, 'stale-first-arrival-acceptance', ['review remains current']
  )
  const staleFirstArrival = crossFailure(staleItem, 'stale-first-arrival-event', { observedAt: 2_000 })
  const staleAdvanced = await api.saveWorkflowAcceptance({
    ...staleAcceptance,
    status: 'verifying',
    revision: staleAcceptance.revision + 1,
    updatedAt: 2_001
  }, userData)
  await expectCode(
    ingress.persistWorkflowAcceptanceFailure(staleFirstArrival, userData),
    'WORKFLOW_FAILURE_TRANSITION_INVALID'
  )
  assert.equal((await api.queryWorkflowEvidence({ workItemId: staleItem.id }, userData)).total, 0)
  assert.equal(
    (await api.listWorkflowLedger({ acceptanceId: staleAcceptance.id }, userData)).acceptances.items[0].revision,
    staleAdvanced.revision,
    'a stale first arrival must not mutate the current Acceptance revision'
  )

  const mixedPolicies = [
    { criterionId: 'policy:test-runtime', criterionIndex: 0, evidenceKind: 'test_result', allowedSources: ['runtime'] },
    { criterionId: 'policy:review-runtime', criterionIndex: 1, evidenceKind: 'review_result', allowedSources: ['runtime'] }
  ]
  const mixedCrossItem = await createItem(commands, goal, 'mixed-policy-cross-item', 'coding')
  const mixedCrossAcceptance = await createAcceptance(
    api,
    mixedCrossItem,
    'mixed-policy-cross-acceptance',
    ['targeted tests pass', 'review is clean'],
    mixedPolicies
  )
  const mixedCrossResult = await ingress.ingestWorkflowAcceptanceFailure(
    crossFailure(mixedCrossItem, 'mixed-policy-cross-event', {
      acceptanceId: mixedCrossAcceptance.id,
      observedAt: 2_001
    }),
    userData
  )
  assert.deepEqual(mixedCrossResult.evidence.metadata.criterionIndexes, [1])
  assert.deepEqual(mixedCrossResult.evidenceLinks.map((link) => link.criterionId), ['policy:review-runtime'])
  assert.deepEqual(mixedCrossResult.acceptance.criterionEvidence, [{
    criterionId: 'policy:review-runtime',
    criterionIndex: 1,
    evidenceRefs: [mixedCrossResult.evidence.evidenceId]
  }])

  const mixedTestItem = await createItem(commands, goal, 'mixed-policy-test-item', 'testing')
  const mixedTestAcceptance = await createAcceptance(
    api,
    mixedTestItem,
    'mixed-policy-test-acceptance',
    ['targeted tests pass', 'review is clean'],
    mixedPolicies
  )
  const mixedTestResult = await ingress.ingestWorkflowAcceptanceFailure(
    testFailure(mixedTestItem, 'mixed-policy-test-event', {
      acceptanceId: mixedTestAcceptance.id,
      observedAt: 2_002
    }),
    userData
  )
  assert.deepEqual(mixedTestResult.evidence.metadata.criterionIndexes, [0])
  assert.deepEqual(mixedTestResult.evidenceLinks.map((link) => link.criterionId), ['policy:test-runtime'])
  assert.deepEqual(mixedTestResult.acceptance.criterionEvidence, [{
    criterionId: 'policy:test-runtime',
    criterionIndex: 0,
    evidenceRefs: [mixedTestResult.evidence.evidenceId]
  }])

  const incompatiblePolicyItem = await createItem(commands, goal, 'incompatible-policy-item', 'coding')
  const incompatiblePolicyAcceptance = await createAcceptance(
    api,
    incompatiblePolicyItem,
    'incompatible-policy-acceptance',
    ['human review is clean'],
    [{ criterionId: 'policy:review-human', criterionIndex: 0, evidenceKind: 'review_result', allowedSources: ['human'] }]
  )
  await expectCode(
    ingress.persistWorkflowAcceptanceFailure(crossFailure(incompatiblePolicyItem, 'incompatible-policy-event', {
      acceptanceId: incompatiblePolicyAcceptance.id,
      observedAt: 2_003
    }), userData),
    'WORKFLOW_FAILURE_INPUT_INVALID'
  )
  assert.equal((await api.queryWorkflowEvidence({ workItemId: incompatiblePolicyItem.id }, userData)).total, 0)
  assert.equal(
    (await api.listWorkflowLedger({ acceptanceId: incompatiblePolicyAcceptance.id }, userData)).acceptances.items[0].status,
    'pending'
  )

  const ambiguousPolicyItem = await createItem(commands, goal, 'ambiguous-policy-item', 'testing')
  const ambiguousPolicyAcceptance = await createAcceptance(
    api,
    ambiguousPolicyItem,
    'ambiguous-policy-acceptance',
    ['unit tests pass', 'integration tests pass'],
    [
      { criterionId: 'policy:test-runtime-unit', criterionIndex: 0, evidenceKind: 'test_result', allowedSources: ['runtime'] },
      { criterionId: 'policy:test-runtime-integration', criterionIndex: 1, evidenceKind: 'test_result', allowedSources: ['runtime'] }
    ]
  )
  await assert.rejects(
    ingress.persistWorkflowAcceptanceFailure(testFailure(ambiguousPolicyItem, 'ambiguous-policy-event', {
      acceptanceId: ambiguousPolicyAcceptance.id,
      observedAt: 2_004
    }), userData),
    (error) => {
      assert.equal(error?.code, 'WORKFLOW_FAILURE_INPUT_INVALID')
      assert.equal(error?.details?.matchCount, 2)
      return true
    }
  )
  assert.equal((await api.queryWorkflowEvidence({ workItemId: ambiguousPolicyItem.id }, userData)).total, 0)
  assert.equal(
    (await api.listWorkflowLedger({ acceptanceId: ambiguousPolicyAcceptance.id }, userData)).acceptances.items[0].status,
    'pending'
  )
  const explicitAmbiguousPolicyResult = await ingress.persistWorkflowAcceptanceFailure(
    testFailure(ambiguousPolicyItem, 'ambiguous-policy-explicit-event', {
      acceptanceId: ambiguousPolicyAcceptance.id,
      criterionIndexes: [1],
      observedAt: 2_005
    }),
    userData
  )
  assert.deepEqual(explicitAmbiguousPolicyResult.evidence.metadata.criterionIndexes, [1])
  assert.deepEqual(
    explicitAmbiguousPolicyResult.evidenceLinks.map((link) => link.criterionId),
    ['policy:test-runtime-integration']
  )
  assert.deepEqual(explicitAmbiguousPolicyResult.acceptance.criterionEvidence, [{
    criterionId: 'policy:test-runtime-integration',
    criterionIndex: 1,
    evidenceRefs: [explicitAmbiguousPolicyResult.evidence.evidenceId]
  }])

  const sharedCrossItem = await createItem(commands, goal, 'shared-cross-item', 'testing')
  const sharedTestItem = await createItem(commands, goal, 'shared-test-item', 'testing')
  await createAcceptance(api, sharedCrossItem, 'shared-cross-acceptance', ['cross source fails'])
  await createAcceptance(api, sharedTestItem, 'shared-test-acceptance', ['test source fails'])
  const sharedCross = await ingress.ingestWorkflowAcceptanceFailure(
    crossFailure(sharedCrossItem, 'shared-native-event', { observedAt: 2_010 }),
    userData
  )
  const sharedTest = await ingress.ingestWorkflowAcceptanceFailure(
    testFailure(sharedTestItem, 'shared-native-event', { observedAt: 2_020 }),
    userData
  )
  assert.notEqual(sharedCross.evidence.evidenceId, sharedTest.evidence.evidenceId, 'sourceEventId is namespaced by sourceKind')

  const wrongType = await createItem(commands, goal, 'wrong-test-type', 'coding')
  await createAcceptance(api, wrongType, 'wrong-test-acceptance', ['tests pass'])
  await expectCode(
    ingress.persistWorkflowAcceptanceFailure(testFailure(wrongType, 'wrong-test-event', { observedAt: 2_100 }), userData),
    'WORKFLOW_FAILURE_WORK_ITEM_BOUNDARY'
  )
  assert.equal((await api.queryWorkflowEvidence({ workItemId: wrongType.id }, userData)).total, 0)

  const ambiguous = await createItem(commands, goal, 'ambiguous-item', 'testing')
  await createAcceptance(api, ambiguous, 'ambiguous-a', ['first'])
  await createAcceptance(api, ambiguous, 'ambiguous-b', ['second'])
  await expectCode(
    ingress.persistWorkflowAcceptanceFailure(testFailure(ambiguous, 'ambiguous-event', {
      observedAt: 2_200,
      acceptanceId: undefined,
      acceptanceRevision: undefined
    }), userData),
    'WORKFLOW_FAILURE_TARGET_AMBIGUOUS'
  )
  assert.equal((await api.queryWorkflowEvidence({ workItemId: ambiguous.id }, userData)).total, 0)

  const foreignItem = await createItem(commands, foreignGoal, 'foreign-item', 'testing')
  const foreignAcceptance = await createAcceptance(api, foreignItem, 'foreign-acceptance', ['foreign tests pass'])
  await expectCode(
    ingress.persistWorkflowAcceptanceFailure({
      ...testFailure(testItem, 'boundary-event', { observedAt: 2_300 }),
      acceptanceId: foreignAcceptance.id
    }, userData),
    'WORKFLOW_FAILURE_TARGET_NOT_FOUND'
  )
  await expectCode(
    ingress.persistWorkflowAcceptanceFailure({
      ...testFailure(foreignItem, 'project-boundary-event', { observedAt: 2_400 }),
      projectId: goal.projectId
    }, userData),
    'WORKFLOW_FAILURE_PROJECT_BOUNDARY'
  )

  const rollbackItem = await createItem(commands, goal, 'rollback-item', 'testing')
  const rollbackAcceptance = await createAcceptance(api, rollbackItem, 'rollback-acceptance', ['rollback remains clean'])
  const rollbackInput = testFailure(rollbackItem, 'rollback-event', { observedAt: 3_000 })
  const rollbackEvidenceId = ingress.workflowAcceptanceFailureEvidenceId(rollbackInput.sourceKind, rollbackInput.sourceEventId)
  const conflictingLinkId = ingress.workflowAcceptanceFailureLinkId(rollbackEvidenceId, rollbackAcceptance.id, 0)
  const oldEvidence = await api.createWorkflowEvidence({
    evidenceId: 'rollback-old-evidence',
    projectId: rollbackItem.projectId,
    goalId: rollbackItem.goalId,
    workItemId: rollbackItem.id,
    kind: 'test_result',
    title: 'Old evidence',
    contentDigest: 'e'.repeat(64)
  }, userData)
  await api.createWorkflowEvidenceLink({
    id: conflictingLinkId,
    evidenceId: oldEvidence.evidenceId,
    projectId: rollbackItem.projectId,
    acceptanceId: rollbackAcceptance.id,
    criterionId: 'criterion:1',
    evidenceOrigin: 'workflow',
    relation: 'verifies'
  }, userData)
  await assert.rejects(ingress.persistWorkflowAcceptanceFailure(rollbackInput, userData))
  assert.equal((await api.queryWorkflowEvidence({ evidenceId: rollbackEvidenceId }, userData)).total, 0)
  assert.equal((await api.listWorkflowLedger({ acceptanceId: rollbackAcceptance.id }, userData)).acceptances.items[0].status, 'pending')

  const recoveryItem = await createItem(commands, goal, 'recovery-item', 'testing')
  const recoveryAcceptance = await createAcceptance(api, recoveryItem, 'recovery-acceptance', ['recovery test passes'])
  const persistedOnly = await ingress.persistWorkflowAcceptanceFailure(
    testFailure(recoveryItem, 'recovery-event', { observedAt: 4_000, acceptanceId: recoveryAcceptance.id }),
    userData
  )
  const recoveryRepairId = repairRuntime.workflowAcceptanceRepairWorkItemId(
    persistedOnly.acceptance.id,
    persistedOnly.acceptance.revision
  )
  assert.equal(await store.getWorkItem(recoveryRepairId), undefined)
  const recovered = await repairService.recoverWorkflowAcceptanceRepairMaterializations(userData)
  assert.equal(recovered.failures.length, 0)
  assert(recovered.recovered.some((entry) => entry.repairWorkItemId === recoveryRepairId))
  assert(await store.getWorkItem(recoveryRepairId))
  const recoveryRepairAcceptanceId = repairRuntime.workflowAcceptanceRepairAcceptanceId(recoveryRepairId)
  assert.equal((await api.listWorkflowLedger({ acceptanceId: recoveryRepairAcceptanceId }, userData)).acceptances.items.length, 1)

  const advanced = await api.saveWorkflowAcceptance({
    ...crossResult.acceptance,
    status: 'verifying',
    evidenceRefs: [],
    criterionEvidence: undefined,
    verifier: undefined,
    verifiedAt: undefined,
    revision: crossResult.acceptance.revision + 1,
    updatedAt: 5_000
  }, userData)
  const repairCountBeforeOldReplay = (await store.listWorkItems(cross.projectId)).filter((item) => item.parentId === cross.id).length
  await expectCode(ingress.ingestWorkflowAcceptanceFailure(crossInput, userData), 'WORKFLOW_FAILURE_REPLAY_CONFLICT')
  assert.equal(
    (await store.listWorkItems(cross.projectId)).filter((item) => item.parentId === cross.id).length,
    repairCountBeforeOldReplay,
    'an old source event must not materialize a repair for a later Acceptance revision'
  )
  const laterFailure = await ingress.ingestWorkflowAcceptanceFailure({
    ...crossInput,
    sourceEventId: 'cross-event-2',
    acceptanceId: advanced.id,
    acceptanceRevision: advanced.revision,
    observedAt: 5_100,
    contentDigest: 'f'.repeat(64)
  }, userData)
  assert(laterFailure.acceptance.revision > crossResult.acceptance.revision)
  assert.notEqual(laterFailure.repair.workItemId, crossResult.repair.workItemId)
  const repairCountAfterLaterFailure = (await store.listWorkItems(cross.projectId)).filter((item) => item.parentId === cross.id).length
  await expectCode(ingress.ingestWorkflowAcceptanceFailure(crossInput, userData), 'WORKFLOW_FAILURE_REPLAY_CONFLICT')
  assert.equal(
    (await store.listWorkItems(cross.projectId)).filter((item) => item.parentId === cross.id).length,
    repairCountAfterLaterFailure
  )

  await expectCode(
    ingress.persistWorkflowAcceptanceFailure({ ...testFailure(recoveryItem, 'strict-event', { observedAt: 4_100 }), unknown: true }, userData),
    'WORKFLOW_FAILURE_INPUT_INVALID'
  )
  await expectCode(
    ingress.persistWorkflowAcceptanceFailure({ ...testFailure(recoveryItem, 'pass-event', { observedAt: 4_200 }), outcome: 'passed' }, userData),
    'WORKFLOW_FAILURE_INPUT_INVALID'
  )

  console.log('workflow acceptance failure ingress smoke: pass')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

async function createItem(commands, goal, id, type) {
  return commands.createWorkItem({
    id,
    projectId: goal.projectId,
    goalId: goal.id,
    type,
    title: id,
    status: 'verifying',
    acceptanceSpec: [{ id: `${id}-criterion`, criterion: `${id} passes`, required: true }]
  })
}

async function createAcceptance(api, item, id, criteria, criterionPolicies) {
  const acceptance = await api.saveWorkflowAcceptance({
    id,
    projectId: item.projectId,
    goalId: item.goalId,
    workItemId: item.id,
    criteria,
    ...(criterionPolicies === undefined ? {} : { criterionPolicies })
  }, userData)
  acceptanceBindings.set(item.id, {
    acceptanceId: acceptance.id,
    acceptanceRevision: acceptance.revision
  })
  return acceptance
}

function crossFailure(item, sourceEventId, overrides = {}) {
  return {
    sourceKind: 'cross_validation',
    sourceEventId,
    projectId: item.projectId,
    goalId: item.goalId,
    workItemId: item.id,
    ...acceptanceBinding(item),
    title: 'Cross-validation blocked delivery',
    summary: 'The independent reviewer found a blocking defect.',
    verifier: 'cross-validator',
    verdict: 'blocked',
    observedAt: 1,
    contentDigest: 'a'.repeat(64),
    ...overrides
  }
}

function testFailure(item, sourceEventId, overrides = {}) {
  return {
    sourceKind: 'test',
    sourceEventId,
    projectId: item.projectId,
    goalId: item.goalId,
    workItemId: item.id,
    ...acceptanceBinding(item),
    title: 'Targeted test failed',
    summary: 'The canonical testing WorkItem reported a failed test.',
    verifier: 'test-runtime',
    outcome: 'failed',
    observedAt: 1,
    contentDigest: 'c'.repeat(64),
    ...overrides
  }
}

function acceptanceBinding(item) {
  const binding = acceptanceBindings.get(item.id)
  assert(binding, `Acceptance binding missing for ${item.id}`)
  return binding
}

async function counts(api, projectId) {
  const ledger = await api.listWorkflowLedger({ projectId }, userData)
  const evidence = await api.queryWorkflowEvidence({ projectId }, userData)
  return {
    acceptances: ledger.acceptances.total,
    evidenceLinks: ledger.evidenceLinks.total,
    events: ledger.events.total,
    evidence: evidence.total
  }
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code, `expected ${code}`)
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/task/workflow-acceptance-failure-ingress.ts',
    'src/main/task/workflow-acceptance-repair-service.ts',
    'src/main/task/workflow-ledger-api.ts',
    'src/main/task/workflow-acceptance-guard.ts',
    'src/main/task/workflow-acceptance-repair-coordinator.ts',
    'src/main/project-workspace/store.ts',
    'src/main/project-workspace/command-service.ts',
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

function loadCompiledAt(relativePath) {
  return import(pathToFileURL(path.join(outDir, relativePath)).href)
}
