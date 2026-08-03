import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter)
require('node:module').Module._initPaths()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-project-import-'))
const outDir = path.join(tempRoot, 'compiled')
const sourceRoot = path.join(tempRoot, 'source')
const destinationRoot = path.join(tempRoot, 'destination')
const conflictingDestinationRoot = path.join(tempRoot, 'conflicting-destination')

try {
  mkdirSync(sourceRoot, { recursive: true })
  mkdirSync(destinationRoot, { recursive: true })
  mkdirSync(conflictingDestinationRoot, { recursive: true })
  compileSources()
  installElectronStub()
  const workspaceApi = await importCompiled('main/project-workspace/index.js')
  const workerApi = await importCompiled('main/digital-worker/index.js')
  const aggregateApi = await importCompiled('main/project-aggregate/index.js')
  const workflowApi = await importCompiled('main/task/workflow-ledger-api.js')
  const workflowStore = await importCompiled('main/task/workflow-ledger-store.js')
  const snapshotApi = await importCompiled('main/task/task-snapshot.js')
  const taskEvidenceApi = await importCompiled('main/task/task-evidence-store.js')
  const evidenceProjectionApi = await importCompiled('main/task/workflow-ledger-evidence-projection.js')
  const importApi = await importCompiled('main/data-lifecycle/project-import-coordinator.js')
  const journalApi = await importCompiled('main/data-lifecycle/project-import-journal.js')

  const fixture = await seedSource({
    workspaceApi, workerApi, aggregateApi, workflowApi, workflowStore, snapshotApi,
    taskEvidenceApi, evidenceProjectionApi
  })
  const sourceService = new aggregateApi.ProjectAggregateService(aggregateRoots(sourceRoot))
  const sourceSeal = await sourceService.sealProject(fixture.project.id, { expectedAggregateRevision: 0, now: 10_000 })
  const exported = await sourceService.exportProject(fixture.project.id, {
    expectedAggregateRevision: sourceSeal.aggregateRevision,
    expectedAggregateDigest: sourceSeal.aggregateDigest
  })
  assert(exported.bundle.aggregate.workflow.runs[0].taskRun.id === fixture.run.id,
    'Project export contains the restorable TaskRun payload')
  assertEqual(exported.bundle.dependencies.roleTemplates.length, 1,
    'Project export contains exactly one required RoleTemplate dependency')
  assertEqual(exported.bundle.dependencies.roleTemplates[0].id, 'role-project-import',
    'Project export identifies the required RoleTemplate dependency')

  const conflictingWorkers = new workerApi.DigitalWorkerStore(conflictingDestinationRoot)
  await conflictingWorkers.createRoleTemplate({ ...roleInput(), purpose: 'Conflicting installed role' })
  await assertRejects(
    importApi.importProjectAggregate(exported.bundle, conflictingDestinationRoot),
    (error) => /RoleTemplate.*conflict/i.test(String(error?.message)),
    'conflicting installed RoleTemplate dependency'
  )
  const conflictingWorkspace = await new workspaceApi.ProjectWorkspaceStore(conflictingDestinationRoot).open()
  assertEqual(await conflictingWorkspace.getWorkspace(fixture.project.id), undefined,
    'RoleTemplate conflict is rejected before Workspace mutation')
  assertEqual(conflictingWorkers.read().roleTemplates[0]?.purpose, 'Conflicting installed role',
    'RoleTemplate conflict does not overwrite the installed template')

  const destinationWorkspace = await new workspaceApi.ProjectWorkspaceStore(destinationRoot).open()
  await destinationWorkspace.createWorkspace({ id: 'project-existing', name: 'Existing Project' })
  const destinationWorkers = new workerApi.DigitalWorkerStore(destinationRoot)

  await assertRejects(
    importApi.importProjectAggregate(exported.bundle, destinationRoot, { failBeforeJournalPhase: 'workflow_imported' }),
    (error) => String(error?.message).includes('injected Project import failure before journal'),
    'write-before-journal import failure injection'
  )
  const pending = new journalApi.ProjectImportJournal(destinationRoot).listPending()
  assertEqual(pending.length, 1, 'one import remains pending after the injected crash')
  assertEqual(pending[0].phase, 'workforce_imported', 'journal remains at the last durable phase before the crash window')
  const recovery = await importApi.recoverPendingProjectImports(destinationRoot)
  assertEqual(recovery.failures.length, 0, `restart recovery has no failures: ${JSON.stringify(recovery.failures)}`)
  assertEqual(recovery.recovered.length, 1, 'restart recovery completes one import')
  const result = recovery.recovered[0]
  assert(result.sourceEquivalent === true, 'semantic readback matches the source export')
  assert(/^[a-f0-9]{64}$/.test(result.importedAggregateDigest), 'import emits a sealed aggregate digest')
  assertEqual((await importApi.verifyProjectImport(destinationRoot, result.operationId)).semanticDigest,
    result.semanticDigest, 'completed import verifies after another read')
  assert((await destinationWorkspace.getWorkspace('project-existing'))?.id === 'project-existing',
    'an unrelated destination Project survives the merge')
  assert((await destinationWorkspace.getWorkspace(fixture.project.id))?.name === fixture.project.name,
    'imported Workspace is readable')

  const destinationService = new aggregateApi.ProjectAggregateService(aggregateRoots(destinationRoot))
  const imported = await destinationService.queryProject(fixture.project.id)
  assertEqual(imported.workflow.runs[0].taskRun.id, fixture.run.id, 'imported TaskRun is readable')
  assertEqual(imported.workflow.artifacts[0].id, fixture.artifact.id, 'imported Artifact is readable')
  assertEqual(imported.workflow.taskEvidence[0].evidenceId, fixture.taskEvidenceId, 'imported Task Evidence is readable')
  assertEqual(imported.workflow.workflowEvidence[0].evidenceId, fixture.evidence.evidenceId,
    'imported Workflow Evidence is readable')
  assertEqual(imported.workflow.artifactLocations[0].id, fixture.location.id, 'imported Artifact Location is readable')
  assertEqual(imported.workflow.acceptances[0].id, fixture.acceptance.id, 'imported Acceptance is readable')
  assertEqual(imported.digitalWorkers[0].id, fixture.worker.id, 'imported DigitalWorker is readable')
  assertEqual(destinationWorkers.read().roleTemplates[0]?.id, 'role-project-import',
    'missing RoleTemplate dependency is installed without destination setup')
  assertEqual(imported.assignments[0].id, fixture.assignment.id, 'imported Assignment is readable')
  assertEqual(imported.leases[0].assignmentId, fixture.assignment.id, 'imported Lease is readable')
  assertEqual(imported.memory[0].id, fixture.memory.id, 'imported Memory is readable')
  if (process.platform !== 'win32') assertEqual(statSync(result.sourcePath).mode & 0o777, 0o600, 'private source mode')

  const beforeDuplicate = readFileSync(path.join(destinationRoot, 'project-workspace.json'), 'utf8')
  await assertRejects(
    importApi.importProjectAggregate(exported.bundle, destinationRoot),
    (error) => /identity conflict|seal conflict/i.test(String(error?.message)),
    'duplicate Project import fails closed'
  )
  assertEqual(readFileSync(path.join(destinationRoot, 'project-workspace.json'), 'utf8'), beforeDuplicate,
    'duplicate rejection does not mutate the Workspace store')

  const sourceText = readFileSync(result.sourcePath, 'utf8')
  const tampered = JSON.parse(sourceText)
  tampered.bundle.aggregate.workspace.name = 'tampered'
  writeFileSync(result.sourcePath, `${JSON.stringify(tampered)}\n`)
  await assertRejects(
    importApi.verifyProjectImport(destinationRoot, result.operationId),
    (error) => /source|digest|aggregate/i.test(String(error?.message)),
    'tampered private source fails readback verification'
  )

  console.log(JSON.stringify({
    status: 'PASS',
    projectId: result.projectId,
    aggregateRevision: result.aggregateRevision,
    objectCounts: result.objectCounts,
    checks: [
      'restorable-task-run-export',
      'role-template-dependency-auto-install',
      'role-template-dependency-conflict-fail-closed',
      'private-source-0600',
      'phase-journal',
      'write-before-journal-replay',
      'restart-resume',
      'merge-preserves-existing-project',
      'semantic-readback',
      'sealed-import',
      'duplicate-fail-closed',
      'source-tamper-rejection'
    ]
  }, null, 2))
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

async function seedSource({
  workspaceApi, workerApi, aggregateApi, workflowApi, workflowStore, snapshotApi,
  taskEvidenceApi, evidenceProjectionApi
}) {
  const workspace = await new workspaceApi.ProjectWorkspaceStore(sourceRoot).open()
  const project = await workspace.createWorkspace({
    id: 'project-importable',
    name: 'Importable Project',
    kind: 'research',
    budgetPolicy: { monthlyUsd: 20 },
    permissionPolicy: { classification: 'project-internal' },
    retentionPolicy: { auditDays: 30 },
    createdAt: 100,
    updatedAt: 100
  })
  const goal = await workspace.createGoal({
    id: 'goal-importable', projectId: project.id, title: 'Import Goal', objective: 'Prove Project import',
    createdAt: 101, updatedAt: 101
  })
  const workItem = await workspace.createWorkItem({
    id: 'work-item-importable', projectId: project.id, goalId: goal.id, title: 'Import WorkItem',
    type: 'testing', runRefs: ['run-importable'], artifactRefs: ['artifact-importable'],
    createdAt: 102, updatedAt: 102
  })
  await workflowApi.createWorkflowGoal({
    id: goal.id, projectId: project.id, title: goal.title, objective: goal.objective,
    status: goal.status, revision: goal.revision, source: 'explicit', createdAt: goal.createdAt, updatedAt: goal.updatedAt
  }, sourceRoot)
  await workflowApi.createWorkflowWorkItem({
    id: workItem.id, projectId: project.id, goalId: goal.id, type: workItem.type, title: workItem.title,
    status: workItem.status, revision: workItem.revision, source: 'explicit', runIds: workItem.runRefs,
    currentRunId: workItem.runRefs.at(-1), createdAt: workItem.createdAt, updatedAt: workItem.updatedAt
  }, sourceRoot)
  const run = taskRunFixture()
  await snapshotApi.mutateTaskSnapshotDatabase(sourceRoot, (db) => {
    workflowStore.setupWorkflowLedgerSchema(db)
    workflowStore.projectTaskRun(db, run, {
      projectId: project.id,
      goalId: goal.id,
      workItemId: workItem.id,
      source: 'explicit',
      canonicalSourceAuthority: true
    })
    taskEvidenceApi.backfillTaskEvidence(db, [run], [{ sessionId: run.sessionId, projectId: project.id }])
    evidenceProjectionApi.projectTaskEvidenceIntoWorkflow(db, { runId: run.id })
  })
  const artifact = await workflowApi.createWorkflowArtifact({
    id: 'artifact-importable', projectId: project.id, goalId: goal.id, workItemId: workItem.id,
    runId: run.id, kind: 'test_report', title: 'Import report', digest: 'a'.repeat(64),
    createdAt: 104, updatedAt: 104
  }, sourceRoot)
  const location = await workflowApi.createWorkflowArtifactLocation({
    id: 'artifact-location-importable', artifactId: artifact.id, projectId: project.id,
    goalId: goal.id, workItemId: workItem.id, runId: run.id, kind: 'external',
    uri: 'https://example.test/importable', availability: 'available', createdAt: 105, updatedAt: 105
  }, sourceRoot)
  const acceptance = await workflowApi.saveWorkflowAcceptance({
    id: 'acceptance-importable', projectId: project.id, goalId: goal.id, workItemId: workItem.id,
    criteria: ['Import is complete'], status: 'pending', evidenceRefs: [], revision: 1,
    createdAt: 106, updatedAt: 106
  }, sourceRoot)
  const evidence = await workflowApi.createWorkflowEvidence({
    evidenceId: 'workflow-evidence-importable', projectId: project.id, goalId: goal.id,
    workItemId: workItem.id, runId: run.id, artifactId: artifact.id, kind: 'test_result',
    title: 'Project import evidence', contentDigest: 'b'.repeat(64)
  }, sourceRoot, { source: 'runtime', verifier: 'project-import-smoke', observedAt: 107 })
  const evidenceLink = await workflowApi.createWorkflowEvidenceLink({
    id: 'evidence-link-importable', evidenceId: evidence.evidenceId, evidenceOrigin: 'workflow',
    projectId: project.id, runId: run.id, artifactId: artifact.id, acceptanceId: acceptance.id,
    relation: 'supports', createdAt: 108
  }, sourceRoot)
  const workerStore = new workerApi.DigitalWorkerStore(sourceRoot)
  const role = await workerStore.createRoleTemplate(roleInput())
  const proposed = await workerStore.createDigitalWorker({
    id: 'worker-importable', projectId: project.id, roleTemplateId: role.id,
    displayName: 'Import Worker', memoryNamespace: 'project:importable:worker',
    toolPolicy: { allowedTools: ['search'] }, budgetPolicy: { maxUsd: 5 }, concurrencyLimit: 1,
    createdAt: 109, updatedAt: 109
  })
  const worker = await workerStore.activateDigitalWorker(proposed.id, { expectedRevision: proposed.revision, now: 110 })
  const assignment = await workerStore.createAssignment({
    id: 'assignment-importable', projectId: project.id, workItemId: workItem.id,
    assigneeKind: 'digital_worker', assigneeId: worker.id, assignedBy: 'project-import-smoke', assignedAt: 111
  })
  const lease = await workerStore.acquireLease({
    projectId: project.id, workItemId: workItem.id, workerId: worker.id,
    assignmentId: assignment.id, ttlMs: 60_000, now: 112
  })
  const memory = await aggregateApi.createProjectMemoryDraft(project.id, path.join(sourceRoot, 'learning'), {
    id: 'memory-importable', source: 'project-import-smoke',
    payload: { memoryKind: 'decision', title: 'Import memory', body: 'Portable memory', reason: 'Import regression' }
  })
  return {
    project, goal, workItem, run, artifact, location, acceptance, evidence, evidenceLink,
    worker, assignment, lease, memory, taskEvidenceId: `effect-evidence-${run.id}`
  }
}

function roleInput() {
  return {
    id: 'role-project-import',
    name: 'Project Import Role',
    purpose: 'Project import fixture',
    instructions: 'Synthetic fixture only'
  }
}

function taskRunFixture() {
  return {
    schemaVersion: 1,
    id: 'run-importable',
    sessionId: 'session-importable',
    taskId: 'task-importable',
    status: 'failed',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: 103,
    updatedAt: 104,
    error: 'synthetic terminal Run',
    steps: [],
    toolExecutions: [],
    effects: [{
      schemaVersion: 1,
      id: 'effect-run-importable',
      effectKey: 'effect-key-run-importable',
      resourceKey: 'resource-key-run-importable',
      sessionId: 'session-importable',
      runId: 'run-importable',
      toolUseId: 'tool-run-importable',
      toolName: 'fixture_tool',
      generation: 1,
      revision: 1,
      status: 'confirmed',
      reconcilability: 'queryable',
      target: { kind: 'unsupported', toolName: 'fixture_tool' },
      targetDigest: 'target-run-importable',
      intentDigest: 'intent-run-importable',
      inputDigest: 'input-run-importable',
      evidence: [{
        id: 'effect-evidence-run-importable',
        kind: 'execution_result',
        digest: 'effect-evidence-digest-run-importable',
        observedAt: 104,
        verifier: 'project-import-smoke',
        generation: 1
      }],
      createdAt: 103,
      updatedAt: 104
    }]
  }
}

function aggregateRoots(root) {
  return {
    workspaceRoot: root,
    workflowRoot: root,
    digitalWorkerRoot: root,
    learningRoot: path.join(root, 'learning'),
    aggregateRoot: root
  }
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/data-lifecycle/project-import-coordinator.ts',
    'src/main/project-workspace/index.ts',
    'src/main/digital-worker/index.ts',
    'src/main/project-aggregate/index.ts',
    'src/main/task/workflow-ledger-api.ts',
    'src/main/task/workflow-ledger-store.ts',
    'src/main/task/task-snapshot.ts',
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
  writeFileSync(path.join(electronDir, 'index.js'), `export const app = { getPath: () => ${JSON.stringify(sourceRoot)} }\n`)
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

function importCompiled(relativePath) {
  return import(pathToFileURL(path.join(outDir, relativePath)).href)
}

async function assertRejects(promise, predicate, label) {
  try {
    await promise
  } catch (error) {
    if (predicate(error)) return
    throw new Error(`${label}: unexpected rejection: ${String(error?.stack ?? error)}`)
  }
  throw new Error(`${label}: expected rejection`)
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`)
}
