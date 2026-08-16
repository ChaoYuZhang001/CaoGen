#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-studio-result-contract-'))
const outDir = path.join(tempRoot, 'compiled')

try {
  compile()
  const service = await import(pathToFileURL(path.join(outDir, 'main', 'studio-result', 'studio-result-service.js')).href)
  const aggregate = fixtureAggregate()
  const session = fixtureSession()
  const snapshot = service.buildStudioResultSnapshot(session, aggregate, [
    { id: 'session-primary', costUsd: 0.125 },
    { id: 'session-sibling', costUsd: 99 }
  ], 10_000)

  assert.equal(snapshot.state, 'ready')
  assert.equal(snapshot.scope.level, 'work_item')
  assert.equal(snapshot.workspace.id, 'project-1')
  assert.equal(snapshot.goal.id, 'goal-1')
  assert.deepEqual(snapshot.workItems.map((item) => item.id), ['work-1'])
  assert.deepEqual(snapshot.runs.map((run) => run.id), ['run-1'])
  assert.deepEqual(snapshot.artifacts.map((artifact) => artifact.id), ['artifact-1'])
  assert.deepEqual(snapshot.artifacts[0].currentArtifactIds, ['artifact-1'])
  assert.equal(snapshot.artifacts[0].deliveryScope, 'current')
  assert.deepEqual(snapshot.evidence.map((evidence) => evidence.id), ['evidence-1', 'approval-1'])
  assert.deepEqual(snapshot.acceptances.map((acceptance) => acceptance.id), ['acceptance-1'])
  assert.equal(snapshot.tests.length, 2)
  assert(snapshot.tests.every((test) => test.status === 'passed'))
  assert.equal(snapshot.cost.knownUsd, 0.125)
  assert.equal(snapshot.cost.coverage, 'complete')
  assert.equal(snapshot.summary.changes, 0)
  assert.equal(snapshot.summary.availableArtifacts, 1)
  assert.equal(snapshot.summary.currentArtifacts, 1)
  assert.equal(snapshot.summary.historicalArtifacts, 0)
  assert.equal(snapshot.approvals.length, 1)
  assert.equal(snapshot.openItems.length, 1)
  assert.equal(snapshot.risks.length, 1)
  assert(snapshot.timeline.every((item) => item.entityId !== 'work-2'))
  assert.match(snapshot.verification.resultDigest, /^sha256:[a-f0-9]{64}$/)
  assert.match(snapshot.verification.aggregateDigest, /^[a-f0-9]{64}$/)

  const repairedOutsideScope = fixtureAggregate()
  repairedOutsideScope.workflow.artifacts.push({
    ...repairedOutsideScope.workflow.artifacts[0],
    id: 'artifact-repair-2',
    workItemId: 'work-2',
    runId: 'run-2',
    title: 'artifact-repair-2 report',
    version: 2,
    digest: `sha256:${'r'.repeat(64)}`,
    supersedesId: 'artifact-1',
    updatedAt: 9
  })
  const historical = service.buildStudioResultSnapshot(session, repairedOutsideScope, [], 10_000)
  assert.deepEqual(historical.artifacts.map((artifact) => artifact.id), ['artifact-1'])
  assert.equal(historical.artifacts[0].deliveryScope, 'historical')
  assert.deepEqual(historical.artifacts[0].currentArtifactIds, ['artifact-repair-2'])
  assert.equal(historical.summary.currentArtifacts, 0)
  assert.equal(historical.summary.historicalArtifacts, 1)

  const exported = service.buildStudioResultExport(snapshot)
  const bundle = JSON.parse(exported.json)
  assert.equal(bundle.exportDigest, exported.exportDigest)
  assert.equal(bundle.snapshot.verification.resultDigest, snapshot.verification.resultDigest)
  assert.equal(exported.json.includes('provider diagnostic must remain private'), false)
  assert.equal(exported.json.includes('session-sibling'), false)

  const partial = service.buildStudioResultSnapshot(session, aggregate, [], 10_000)
  assert.equal(partial.cost.coverage, 'unavailable')
  assert.equal(partial.cost.knownUsd, 0)

  const unbound = service.buildStudioResultSnapshot({ ...session, workspaceId: undefined, goalId: undefined, workItemId: undefined }, undefined, [], 10_000)
  assert.equal(unbound.state, 'unbound')
  assert.equal(unbound.scope.level, 'conversation')
  assert.throws(() => service.buildStudioResultExport(unbound), /STUDIO_RESULT_UNBOUND/)
  assert.throws(() => service.buildStudioResultSnapshot({ ...session, workspaceId: undefined }, undefined, [], 10_000), /without a Project/)
  assert.throws(() => service.buildStudioResultSnapshot({ ...session, goalId: 'goal-2' }, aggregate, [], 10_000), /Goal goal-2 is missing/)

  const wrongOwner = fixtureAggregate()
  wrongOwner.workItems[0].goalId = 'goal-other'
  assert.throws(() => service.buildStudioResultSnapshot(session, wrongOwner, [], 10_000), /not owned by Goal/)

  const unsafe = fixtureAggregate()
  unsafe.goals[0].objective = 'Bearer synthetic-runtime-credential-material'
  assert.throws(() => service.buildStudioResultSnapshot(session, unsafe, [], 10_000), /unredacted credential material/)

  verifyProductionWiring()
  console.log('studio result contract smoke: PASS (28 checks)')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function fixtureSession() {
  return {
    id: 'session-primary', title: 'Primary', cwd: '/fixture', workspaceId: 'project-1', goalId: 'goal-1', workItemId: 'work-1',
    model: 'fixture', providerId: 'provider-fixture', taskStrategy: 'execute', permissionMode: 'default', status: 'idle',
    costUsd: 0.125, usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, contextTokens: 2, createdAt: 1
  }
}

function fixtureAggregate() {
  const workItem = (id, title) => ({
    schemaVersion: 1, id, projectId: 'project-1', goalId: 'goal-1', type: 'testing', title, dependencyIds: [], priority: 1,
    status: id === 'work-1' ? 'done' : 'ready', acceptanceSpec: [], artifactRefs: [`artifact-${id === 'work-1' ? '1' : '2'}`],
    runRefs: [`run-${id === 'work-1' ? '1' : '2'}`], createdAt: 1, updatedAt: 8, revision: 2
  })
  const run = (id, sessionId, workItemId) => ({
    schemaVersion: 1, id, projectId: 'project-1', goalId: 'goal-1', workItemId, sessionId, taskId: id, status: 'completed',
    revision: 3, attempt: 1, createdAt: 2, updatedAt: 6, startedAt: 3, finishedAt: 6,
    error: 'provider diagnostic must remain private', taskRunDigest: `${id === 'run-1' ? '1' : '2'}`.repeat(64)
  })
  const artifact = (id, workItemId, runId) => ({
    schemaVersion: 1, id, projectId: 'project-1', goalId: 'goal-1', workItemId, runId, kind: 'test_report',
    title: `${id} report`, version: 1, digest: `sha256:${id === 'artifact-1' ? 'a' : 'b'}`.padEnd(71, id === 'artifact-1' ? 'a' : 'b'),
    provenance: 'explicit', createdAt: 5, updatedAt: 6
  })
  return {
    schemaVersion: 1,
    format: 'caogen.project-aggregate.v1',
    projectId: 'project-1',
    identityDigest: 'c'.repeat(64),
    projectRevision: 3,
    workspace: { schemaVersion: 1, id: 'project-1', name: 'Canonical project', kind: 'software', status: 'active', resources: [], createdAt: 1, updatedAt: 8, revision: 3 },
    resources: [],
    goals: [{
      schemaVersion: 1, id: 'goal-1', projectId: 'project-1', title: 'Deliver verified result', objective: 'Produce a canonical delivery report',
      constraints: [], successCriteria: ['Tests pass'], riskLevel: 'medium', forbiddenActions: [], acceptance: [],
      contract: { objective: 'Produce a canonical delivery report', constraints: [], successCriteria: ['Tests pass'], forbiddenActions: [], acceptance: [], riskLevel: 'medium' },
      status: 'verifying', createdAt: 1, updatedAt: 8, revision: 2
    }],
    workItems: [workItem('work-1', 'Verify primary result'), workItem('work-2', 'Sibling must stay isolated')],
    digitalWorkers: [], assignments: [], leases: [],
    workflow: {
      runs: [run('run-1', 'session-primary', 'work-1'), run('run-2', 'session-sibling', 'work-2')],
      artifacts: [artifact('artifact-1', 'work-1', 'run-1'), artifact('artifact-2', 'work-2', 'run-2')],
      artifactEdges: [],
      artifactLocations: [
        { schemaVersion: 1, id: 'location-1', artifactId: 'artifact-1', projectId: 'project-1', goalId: 'goal-1', workItemId: 'work-1', runId: 'run-1', kind: 'file', path: 'report.json', availability: 'available', createdAt: 5, updatedAt: 5 },
        { schemaVersion: 1, id: 'location-1-preview', artifactId: 'artifact-1', projectId: 'project-1', goalId: 'goal-1', workItemId: 'work-1', runId: 'run-1', kind: 'preview', availability: 'pending', createdAt: 5, updatedAt: 5 },
        { schemaVersion: 1, id: 'location-2', artifactId: 'artifact-2', projectId: 'project-1', goalId: 'goal-1', workItemId: 'work-2', runId: 'run-2', kind: 'file', path: 'sibling.json', availability: 'available', createdAt: 5, updatedAt: 5 }
      ],
      acceptances: [
        { schemaVersion: 1, id: 'acceptance-1', projectId: 'project-1', goalId: 'goal-1', workItemId: 'work-1', criteria: ['Tests pass'], status: 'passed', evidenceRefs: ['evidence-1'], criterionEvidence: [{ criterionId: 'criterion-1', criterionIndex: 0, evidenceRefs: ['evidence-1'] }], verifier: 'fixture', verifiedAt: 7, revision: 2, createdAt: 5, updatedAt: 7 },
        { schemaVersion: 1, id: 'acceptance-2', projectId: 'project-1', goalId: 'goal-1', workItemId: 'work-2', criteria: ['Sibling'], status: 'pending', evidenceRefs: [], revision: 1, createdAt: 5, updatedAt: 5 }
      ],
      evidenceLinks: [
        { schemaVersion: 1, id: 'link-1', evidenceId: 'evidence-1', evidenceOrigin: 'workflow', projectId: 'project-1', runId: 'run-1', artifactId: 'artifact-1', acceptanceId: 'acceptance-1', relation: 'verifies', createdAt: 6 },
        { schemaVersion: 1, id: 'link-2', evidenceId: 'evidence-2', evidenceOrigin: 'workflow', projectId: 'project-1', runId: 'run-2', artifactId: 'artifact-2', acceptanceId: 'acceptance-2', relation: 'supports', createdAt: 6 }
      ],
      taskEvidence: [],
      workflowEvidence: [
        { schemaVersion: 1, seq: 1, id: 'workflow-evidence-1', evidenceId: 'evidence-1', projectId: 'project-1', goalId: 'goal-1', workItemId: 'work-1', runId: 'run-1', artifactId: 'artifact-1', kind: 'test_result', source: 'runtime', title: 'Primary tests', verifier: 'fixture', observedAt: 6, contentDigest: 'd'.repeat(64), createdAt: 6, prevDigest: '0'.repeat(64), digest: 'e'.repeat(64) },
        { schemaVersion: 1, seq: 2, id: 'workflow-evidence-2', evidenceId: 'evidence-2', projectId: 'project-1', goalId: 'goal-1', workItemId: 'work-2', runId: 'run-2', artifactId: 'artifact-2', kind: 'test_result', source: 'runtime', title: 'Sibling tests', verifier: 'fixture', observedAt: 6, contentDigest: 'f'.repeat(64), createdAt: 6, prevDigest: 'e'.repeat(64), digest: '1'.repeat(64) },
        { schemaVersion: 1, seq: 3, id: 'workflow-approval-1', evidenceId: 'approval-1', projectId: 'project-1', goalId: 'goal-1', workItemId: 'work-1', runId: 'run-1', kind: 'approval', source: 'human', title: 'Release approved', verifier: 'local-user', observedAt: 7, contentDigest: '2'.repeat(64), createdAt: 7, prevDigest: '1'.repeat(64), digest: '3'.repeat(64) }
      ]
    },
    memory: [], budgets: [], policies: [],
    audit: [
      { id: 'audit-1', projectId: 'project-1', source: 'workflow_ledger', occurredAt: 6, value: { kind: 'run.completed', entityType: 'run', entityId: 'run-1' } },
      { id: 'audit-2', projectId: 'project-1', source: 'workflow_ledger', occurredAt: 6, value: { kind: 'run.completed', entityType: 'run', entityId: 'run-2' } }
    ],
    objectCounts: {}, objectDigests: {}, aggregateDigest: '4'.repeat(64), sanitized: true
  }
}

function compile() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/studio-result/studio-result-service.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function verifyProductionWiring() {
  const types = source('src/shared/studio-result-types.ts')
  const ipc = source('src/main/ipc/studio-result-handlers.ts')
  const preload = source('src/preload/studio-result.ts')
  const panel = source('src/renderer/src/components/workbench/StudioResultPanel.tsx')
  const tabs = source('src/renderer/src/components/experience/StudioProjectionTabs.tsx')
  const workbench = source('src/renderer/src/components/workbench/WorkbenchRoot.tsx')
  assert.match(types, /caogen\.studio-result\.export\.v1/)
  assert.match(ipc, /verifyLiveProject\(session\.workspaceId\)/)
  assert.match(ipc, /writeDurableFile/)
  assert.match(preload, /'appFeatures:invoke', 'studio-result'/)
  assert.match(panel, /data-studio-result-artifact/)
  assert.match(panel, /saveStudioResultSnapshot/)
  assert.match(tabs, /'workspace' \| 'result' \| 'session'/)
  assert.match(workbench, /key: 'memory'/)
}

function source(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}
