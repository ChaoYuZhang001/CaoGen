#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-task-plan-projection-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')

try {
  compile()
  const [{ ProjectWorkspaceStore }, commandApi, readApi, planApi, projectionApi] = await Promise.all([
    imported('main/project-workspace/store.js'),
    imported('main/project-workspace/command-service.js'),
    imported('main/project-workspace/canonical-read-service.js'),
    imported('main/task/task-plan-contract-store.js'),
    imported('main/task/task-plan-canonical-projection.js')
  ])

  const projects = await new ProjectWorkspaceStore(userData).open()
  const workspace = await projects.createWorkspace({ id: 'project-1', name: 'Projection', kind: 'software' })
  const commands = await commandApi.openProjectWorkspaceCommandService(userData)
  const goal = await commands.createGoal({
    id: 'goal-1', projectId: workspace.id, title: 'Ship', objective: 'Ship safely'
  })
  const parent = await commands.createWorkItem({
    id: 'parent-1', projectId: workspace.id, goalId: goal.id, title: 'Approved plan'
  })
  const plans = new planApi.TaskPlanContractStore(() => userData)
  const projector = new projectionApi.TaskPlanCanonicalProjector(() => userData)
  const binding = {
    sessionId: 'session-1', workspaceId: workspace.id, goalId: goal.id, workItemId: parent.id
  }

  const first = plans.createVersion(binding, draft([
    { id: 'deliver', title: 'Deliver', dependsOn: ['inspect'], expectedArtifacts: ['release.zip'] },
    { id: 'inspect', title: 'Inspect', description: 'Read current state' }
  ]), 'local-user')
  const firstReceipt = await projector.project(first.currentVersion)
  const approved = plans.approve(binding.sessionId, approval(first), firstReceipt)
  assert.equal(approved.approvalStatus, 'approved')
  assert.equal(approved.projection?.mode, 'canonical')
  assert.equal(approved.projection?.steps.length, 2)

  const reads = readApi.createProjectWorkspaceReadService(userData, 'canonical')
  const inspectId = projectionApi.projectedWorkItemId(binding.sessionId, 'inspect')
  const deliverId = projectionApi.projectedWorkItemId(binding.sessionId, 'deliver')
  const inspect = await reads.getWorkItem(inspectId)
  const deliver = await reads.getWorkItem(deliverId)
  assert.equal(inspect?.parentId, parent.id)
  assert.equal(inspect?.goalId, goal.id)
  assert.deepEqual(deliver?.dependencyIds, [inspectId])
  assert.equal(deliver?.acceptanceSpec[0]?.criterion, '产出并提供证据：release.zip')

  const restartedPlans = new planApi.TaskPlanContractStore(() => userData)
  const restarted = restartedPlans.get(binding.sessionId)
  assert.deepEqual(restarted.projection, firstReceipt)
  const itemCount = (await reads.listWorkItems(workspace.id)).length
  const replayReceipt = await projector.project(restarted.currentVersion, restarted.projection, true)
  assert.deepEqual(replayReceipt, firstReceipt)
  assert.equal((await reads.listWorkItems(workspace.id)).length, itemCount)

  const second = restartedPlans.createVersion(binding, {
    ...draft([
      { id: 'inspect', title: 'Inspect repository' },
      { id: 'verify', title: 'Verify', dependsOn: ['inspect'], expectedArtifacts: ['report.json'] }
    ]),
    changeReason: 'Refine the approved decomposition'
  }, 'local-user')
  const secondReceipt = await projector.project(second.currentVersion, firstReceipt)
  restartedPlans.approve(binding.sessionId, approval(second), secondReceipt)
  assert.equal(secondReceipt.steps.find((entry) => entry.stepId === 'inspect')?.workItemId, inspectId)
  assert.equal((await reads.getWorkItem(inspectId))?.title, 'Inspect repository')
  assert.equal((await reads.getWorkItem(inspectId))?.description, '计划步骤: inspect')
  assert.equal((await reads.getWorkItem(deliverId))?.status, 'cancelled')
  const verifyId = projectionApi.projectedWorkItemId(binding.sessionId, 'verify')
  assert.deepEqual((await reads.getWorkItem(verifyId))?.dependencyIds, [inspectId])

  const readded = restartedPlans.createVersion(binding, {
    ...draft([
      { id: 'inspect', title: 'Inspect repository', description: 'Read verified current state' },
      { id: 'deliver', title: 'Deliver', dependsOn: ['inspect'], expectedArtifacts: ['release.zip'] },
      { id: 'verify', title: 'Verify', dependsOn: ['deliver'], expectedArtifacts: ['report.json'] }
    ]),
    changeReason: 'Cancelled-step reactivation fixture'
  }, 'local-user')
  await assert.rejects(
    projector.project(readded.currentVersion, secondReceipt),
    /已取消|cannot be reactivated/
  )

  let runningInspect = await commands.updateWorkItem(inspectId, {
    owner: { type: 'human', id: 'tester-1', displayName: 'Tester' }
  }, (await reads.getWorkItem(inspectId)).revision)
  runningInspect = await commands.transitionWorkItem(inspectId, 'ready', runningInspect.revision)
  runningInspect = await commands.acquireWorkItemLease(inspectId, {
    expectedRevision: runningInspect.revision,
    ownerId: 'tester-1',
    leaseId: 'inspect-lease',
    durationMs: 60_000
  })
  runningInspect = await commands.transitionWorkItem(inspectId, 'running', runningInspect.revision)
  assert.equal(runningInspect.status, 'running')
  const conflicted = restartedPlans.createVersion(binding, {
    ...draft([
      { id: 'inspect', title: 'Rewrite running step' },
      { id: 'verify', title: 'Verify', dependsOn: ['inspect'], expectedArtifacts: ['report.json'] }
    ]),
    changeReason: 'Conflict fixture'
  }, 'local-user')
  await assert.rejects(
    projector.project(conflicted.currentVersion, secondReceipt),
    /已启动或结束|cannot be rewritten/
  )
  assert.equal(restartedPlans.get(binding.sessionId).approvalStatus, 'pending')

  const local = restartedPlans.createVersion(
    { sessionId: 'conversation-1' },
    draft([{ id: 'answer', title: 'Answer locally' }]),
    'local-user'
  )
  const localReceipt = await projector.project(local.currentVersion)
  restartedPlans.approve('conversation-1', approval(local), localReceipt)
  assert.equal(localReceipt.mode, 'conversation')
  assert.equal((await projects.listWorkspaces()).length, 1)
  assert.equal((await reads.listWorkItems(workspace.id)).length, itemCount + 1)

  console.log('task plan canonical projection smoke: PASS')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function draft(steps) {
  return {
    objective: 'Ship a verified result',
    steps,
    expectedArtifacts: ['verified output'],
    dataEgress: [],
    estimatedCostUsd: 0,
    riskLevel: 'low',
    acceptanceCriteria: ['All steps have evidence']
  }
}

function approval(view) {
  return { version: view.currentVersion.version, digest: view.currentVersion.digest }
}

function compile() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/task/task-plan-canonical-projection.ts',
    'src/main/task/task-plan-contract-store.ts',
    'src/main/project-workspace/store.ts',
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

function imported(relativePath) {
  return import(pathToFileURL(path.join(outDir, relativePath)).href)
}
