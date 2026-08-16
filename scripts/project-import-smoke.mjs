import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
const invalidSourceDestinationRoot = path.join(tempRoot, 'invalid-source-destination')
const invalidEffectDestinationRoot = path.join(tempRoot, 'invalid-effect-destination')
const invalidExternalDestinationRoot = path.join(tempRoot, 'invalid-external-destination')
const workflowReplayDestinationRoot = path.join(tempRoot, 'workflow-replay-destination')

try {
  mkdirSync(sourceRoot, { recursive: true })
  mkdirSync(destinationRoot, { recursive: true })
  mkdirSync(conflictingDestinationRoot, { recursive: true })
  mkdirSync(invalidSourceDestinationRoot, { recursive: true })
  mkdirSync(invalidEffectDestinationRoot, { recursive: true })
  mkdirSync(invalidExternalDestinationRoot, { recursive: true })
  mkdirSync(workflowReplayDestinationRoot, { recursive: true })
  compileSources()
  installElectronStub()
  const workspaceApi = await importCompiled('main/project-workspace/index.js')
  const workerApi = await importCompiled('main/digital-worker/index.js')
  const aggregateApi = await importCompiled('main/project-aggregate/index.js')
  const aggregateCodec = await importCompiled('main/project-aggregate/codec.js')
  const workflowApi = await importCompiled('main/task/workflow-ledger-api.js')
  const workflowQuery = await importCompiled('main/task/workflow-ledger-query.js')
  const workflowStore = await importCompiled('main/task/workflow-ledger-store.js')
  const snapshotApi = await importCompiled('main/task/task-snapshot.js')
  const modelAttemptApi = await importCompiled('main/task/model-attempt-api.js')
  const artifactLifecycleApi = await importCompiled('main/task/artifact-lifecycle-api.js')
  const gitIndexArtifactApi = await importCompiled('main/git/git-index-artifact.js')
  const learningApi = await importCompiled('main/learning/learning-lifecycle.js')
  const taskEvidenceApi = await importCompiled('main/task/task-evidence-store.js')
  const evidenceProjectionApi = await importCompiled('main/task/workflow-ledger-evidence-projection.js')
  const importApi = await importCompiled('main/data-lifecycle/project-import-coordinator.js')
  const externalFileManifestApi = await importCompiled('main/data-lifecycle/project-external-file-manifest.js')
  const importValidationApi = await importCompiled('main/data-lifecycle/project-import-validation.js')
  const journalApi = await importCompiled('main/data-lifecycle/project-import-journal.js')
  const taskPlanApi = await importCompiled('main/task/task-plan-contract-store.js')
  const importTargetApi = await importCompiled('main/project-import-effect-target.js')

  await assertSymlinkResourceRootRejected(externalFileManifestApi)

  const fixture = await seedSource({
    workspaceApi, workerApi, aggregateApi, workflowApi, workflowStore, snapshotApi,
    taskEvidenceApi, evidenceProjectionApi, modelAttemptApi, artifactLifecycleApi, learningApi, taskPlanApi
  })
  const sourceService = new aggregateApi.ProjectAggregateService(aggregateRoots(sourceRoot, fixture.legacyLearningRoot))
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
  assertEqual(exported.bundle.runtime?.taskSnapshots.length, 1, 'Project export contains its TaskSnapshot')
  assertEqual(exported.bundle.runtime?.modelAttempts.length, 1, 'Project export contains its ModelAttempt')
  assertEqual(exported.bundle.runtime?.artifactBlobs.length, 1, 'Project export contains its Artifact blob')
  assertEqual(exported.bundle.runtime?.artifactSourceFiles?.length, 1,
    'Project export contains its source_ref Artifact bytes')
  assertEqual(exported.bundle.runtime?.artifactSourceFiles?.[0]?.artifactId, fixture.sourceLifecycle.artifactId,
    'Project export binds source_ref bytes to the owned Artifact')
  assertEqual(exported.bundle.runtime?.effectArtifacts?.length, 1,
    'Project export contains its Project-owned Effect artifact')
  assertEqual(exported.bundle.runtime?.effectArtifacts?.[0]?.files.length, 3,
    'Project export contains the frozen Git index, manifest, and object bytes')
  assertEqual(exported.bundle.runtime?.externalFiles?.length, 2,
    'Project export inventories Skill and Office external files')
  const skillManifest = exported.bundle.runtime.externalFiles.find((file) => file.kind === 'learning_skill')
  assert(skillManifest?.relativePath === '.caogen/skills/importable/SKILL.md' &&
    skillManifest.content === 'external_manifest_only',
  'Project export records the Resource-owned Skill without copying external bytes')
  const officeManifest = exported.bundle.runtime.externalFiles.find((file) => file.kind === 'office_artifact')
  assert(officeManifest?.ownerId === fixture.sourceLifecycle.artifactId &&
    officeManifest.content === 'artifact_source_bytes' &&
    officeManifest.digest === fixture.sourceLifecycle.digest,
  'Project export binds the Office output manifest to its portable Artifact bytes')
  const legacyRuntimeBundle = structuredClone(exported.bundle)
  delete legacyRuntimeBundle.runtime.externalFiles
  const { runtimeDigest: _legacyRuntimeDigest, ...legacyRuntimeBody } = legacyRuntimeBundle.runtime
  legacyRuntimeBundle.runtime.runtimeDigest = aggregateCodec.projectAggregateDigest(legacyRuntimeBody)
  const { exportDigest: _legacyExportDigest, ...legacyExportBody } = legacyRuntimeBundle
  legacyRuntimeBundle.exportDigest = aggregateCodec.projectAggregateDigest(legacyExportBody)
  importValidationApi.parseProjectAggregateImport(legacyRuntimeBundle)
  assertEqual(exported.bundle.runtime?.sessionHistory.length, 1, 'Project export contains Session history')
  assertEqual(exported.bundle.runtime?.activeSessions.length, 1, 'Project export contains active Session recovery')
  assertEqual(exported.bundle.runtime?.taskPlans.length, 1, 'Project export contains its Task Plan')
  assert(exported.bundle.runtime?.sessionFiles.some((file) => file.path === 'transcripts/sdk-session-importable.jsonl'),
    'Project export contains its transcript bytes')
  assert(exported.bundle.runtime?.sessionFiles.some((file) => file.path.endsWith('/project-test-evidence-importable.json')),
    'Project export contains its Project-owned test evidence')
  assert(exported.bundle.aggregate.memory.some((entry) => entry.namespace === 'legacy_path'),
    'Project export identifies legacy-path Memory for canonical import')
  const connectorAuthorization = exported.bundle.aggregate.workspace.resources
    .find((resource) => resource.kind === 'connector')?.connector?.authorization
  assert(connectorAuthorization?.principalId === 'project-import-principal' && connectorAuthorization.status === 'active',
    'Project export preserves credential-free connector authorization metadata')

  const invalidSourceBundle = structuredClone(exported.bundle)
  invalidSourceBundle.runtime.artifactSourceFiles[0].data = Buffer.from('tampered source bytes\n').toString('base64')
  const { runtimeDigest: _runtimeDigest, ...runtimeBody } = invalidSourceBundle.runtime
  invalidSourceBundle.runtime.runtimeDigest = aggregateCodec.projectAggregateDigest(runtimeBody)
  const { exportDigest: _exportDigest, ...exportBody } = invalidSourceBundle
  invalidSourceBundle.exportDigest = aggregateCodec.projectAggregateDigest(exportBody)
  await assertRejects(
    importApi.importProjectAggregate(invalidSourceBundle, invalidSourceDestinationRoot),
    (error) => /source file digest mismatch/i.test(String(error?.message)),
    'tampered source_ref bytes fail before destination mutation'
  )
  const invalidSourceWorkspace = await new workspaceApi.ProjectWorkspaceStore(invalidSourceDestinationRoot).open()
  assertEqual(await invalidSourceWorkspace.getWorkspace(fixture.project.id), undefined,
    'tampered source_ref rejection leaves the destination Workspace untouched')

  const invalidEffectBundle = structuredClone(exported.bundle)
  invalidEffectBundle.runtime.effectArtifacts[0].files.find((file) => file.path === 'index').data =
    Buffer.from('tampered Effect artifact bytes\n').toString('base64')
  const { runtimeDigest: _effectRuntimeDigest, ...effectRuntimeBody } = invalidEffectBundle.runtime
  invalidEffectBundle.runtime.runtimeDigest = aggregateCodec.projectAggregateDigest(effectRuntimeBody)
  const { exportDigest: _effectExportDigest, ...effectExportBody } = invalidEffectBundle
  invalidEffectBundle.exportDigest = aggregateCodec.projectAggregateDigest(effectExportBody)
  await assertRejects(
    importApi.importProjectAggregate(invalidEffectBundle, invalidEffectDestinationRoot),
    (error) => /Effect artifact file digest mismatch/i.test(String(error?.message)),
    'tampered Effect artifact bytes fail before destination mutation'
  )
  const invalidEffectWorkspace = await new workspaceApi.ProjectWorkspaceStore(invalidEffectDestinationRoot).open()
  assertEqual(await invalidEffectWorkspace.getWorkspace(fixture.project.id), undefined,
    'tampered Effect artifact rejection leaves the destination Workspace untouched')

  const invalidExternalBundle = structuredClone(exported.bundle)
  invalidExternalBundle.runtime.externalFiles.find((file) => file.kind === 'office_artifact').digest =
    `sha256:${'f'.repeat(64)}`
  const { runtimeDigest: _externalRuntimeDigest, ...externalRuntimeBody } = invalidExternalBundle.runtime
  invalidExternalBundle.runtime.runtimeDigest = aggregateCodec.projectAggregateDigest(externalRuntimeBody)
  const { exportDigest: _externalExportDigest, ...externalExportBody } = invalidExternalBundle
  invalidExternalBundle.exportDigest = aggregateCodec.projectAggregateDigest(externalExportBody)
  await assertRejects(
    importApi.importProjectAggregate(invalidExternalBundle, invalidExternalDestinationRoot),
    (error) => /Office artifact manifest crosses Artifact ownership/i.test(String(error?.message)),
    'tampered external file manifest fails before destination mutation'
  )
  const invalidExternalWorkspace = await new workspaceApi.ProjectWorkspaceStore(invalidExternalDestinationRoot).open()
  assertEqual(await invalidExternalWorkspace.getWorkspace(fixture.project.id), undefined,
    'tampered external file manifest rejection leaves the destination Workspace untouched')

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

  await assertRejects(
    importApi.importProjectAggregate(exported.bundle, workflowReplayDestinationRoot, {
      failBeforeJournalPhase: 'workflow_imported'
    }),
    (error) => String(error?.message).includes('injected Project import failure before journal'),
    'Workflow write-before-journal import failure injection'
  )
  const workflowReplayPending = new journalApi.ProjectImportJournal(workflowReplayDestinationRoot).listPending()
  assertEqual(workflowReplayPending.length, 1, 'one Workflow import remains pending after the injected crash')
  assertEqual(workflowReplayPending[0].phase, 'workforce_imported',
    'journal remains before the Workflow phase after its write window')
  const workflowReplayRecovery = await importApi.recoverPendingProjectImports(workflowReplayDestinationRoot)
  assertEqual(workflowReplayRecovery.failures.length, 0,
    `Workflow write-before-journal recovery has no failures: ${JSON.stringify(workflowReplayRecovery.failures)}`)
  assertEqual(workflowReplayRecovery.recovered.length, 1,
    'Workflow write-before-journal recovery completes one import')

  const destinationWorkspace = await new workspaceApi.ProjectWorkspaceStore(destinationRoot).open()
  await destinationWorkspace.createWorkspace({ id: 'project-existing', name: 'Existing Project' })
  const destinationWorkers = new workerApi.DigitalWorkerStore(destinationRoot)

  await assertRejects(
    importApi.importProjectAggregate(exported.bundle, destinationRoot, { failBeforeJournalPhase: 'runtime_imported' }),
    (error) => String(error?.message).includes('injected Project import failure before journal'),
    'write-before-journal import failure injection'
  )
  const pending = new journalApi.ProjectImportJournal(destinationRoot).listPending()
  assertEqual(pending.length, 1, 'one import remains pending after the injected crash')
  assertEqual(pending[0].phase, 'workflow_imported', 'journal remains before the runtime phase after its write window')
  const recovery = await importApi.recoverPendingProjectImports(destinationRoot)
  assertEqual(recovery.failures.length, 0, `restart recovery has no failures: ${JSON.stringify(recovery.failures)}`)
  assertEqual(recovery.recovered.length, 1, 'restart recovery completes one import')
  const result = recovery.recovered[0]
  assert(result.sourceEquivalent === true, 'semantic readback matches the source export')
  assert(/^[a-f0-9]{64}$/.test(result.importedAggregateDigest), 'import emits a sealed aggregate digest')
  assertEqual((await importApi.verifyProjectImport(destinationRoot, result.operationId)).semanticDigest,
    result.semanticDigest, 'completed import verifies after another read')
  await assertImportReconciliationRootIsolation(importTargetApi, result)
  assert((await destinationWorkspace.getWorkspace('project-existing'))?.id === 'project-existing',
    'an unrelated destination Project survives the merge')
  assert((await destinationWorkspace.getWorkspace(fixture.project.id))?.name === fixture.project.name,
    'imported Workspace is readable')

  const destinationService = new aggregateApi.ProjectAggregateService(aggregateRoots(destinationRoot))
  const imported = await destinationService.queryProject(fixture.project.id)
  assert(imported.audit.some((entry) => entry.source === 'workflow_ledger' &&
    entry.value?.kind === 'workflow.task_plan.version.created'),
  'Runtime TaskPlan is replayed into the destination Workflow Ledger without changing aggregate semantics')
  assertEqual(imported.workflow.runs[0].taskRun.id, fixture.run.id, 'imported TaskRun is readable')
  assert(imported.workflow.artifacts.some((artifact) => artifact.id === fixture.artifact.id),
    'imported Artifact is readable')
  assertEqual(imported.workflow.taskEvidence[0].evidenceId, fixture.taskEvidenceId, 'imported Task Evidence is readable')
  assert(imported.workflow.workflowEvidence.some((evidence) => evidence.evidenceId === fixture.evidence.evidenceId),
    'imported Workflow Evidence is readable')
  assert(imported.workflow.artifactLocations.some((location) => location.id === fixture.location.id),
    'imported Artifact Location is readable')
  assertEqual(imported.workflow.acceptances[0].id, fixture.acceptance.id, 'imported Acceptance is readable')
  assertEqual(imported.digitalWorkers[0].id, fixture.worker.id, 'imported DigitalWorker is readable')
  assertEqual(destinationWorkers.read().roleTemplates[0]?.id, 'role-project-import',
    'missing RoleTemplate dependency is installed without destination setup')
  assertEqual(imported.assignments[0].id, fixture.assignment.id, 'imported Assignment is readable')
  assertEqual(imported.leases[0].assignmentId, fixture.assignment.id, 'imported Lease is readable')
  assertEqual(imported.memory.length, 2, 'canonical and legacy-path Memory are both readable')
  assert(imported.memory.every((entry) => entry.namespace === 'project_id'),
    'legacy-path Memory is rebound to the destination Project identity')
  assert(imported.memory.some((entry) => entry.id === fixture.memory.id), 'imported canonical Memory is readable')
  assert(imported.memory.some((entry) => entry.id === fixture.legacyMemory.id), 'imported legacy Memory is readable')
  const importedSnapshots = await snapshotApi.listTaskSnapshots(destinationRoot)
  assertEqual(importedSnapshots.length, 1, 'imported TaskSnapshot is readable')
  assertEqual(importedSnapshots[0].id, fixture.snapshot.id, 'imported TaskSnapshot preserves identity')
  const importAuthorityEvents = await snapshotApi.readTaskSnapshotDatabase(destinationRoot, (db) =>
    workflowQuery.readAndVerifyEvents(db).filter((event) => event.kind === 'workflow.project-workspace.imported')
  )
  assertEqual(importAuthorityEvents.length, 1, 'Project import persists one destination-local authority event')
  await snapshotApi.saveTaskSnapshot(importedSnapshots[0], destinationRoot)
  const afterSnapshotResave = await destinationService.queryProject(fixture.project.id)
  assertEqual(afterSnapshotResave.workItems[0].revision, fixture.workItem.revision,
    'resaving an imported Snapshot preserves the canonical WorkItem revision')
  assertEqual(afterSnapshotResave.workItems[0].title, fixture.workItem.title,
    'resaving an imported Snapshot cannot replace the canonical WorkItem title')
  assert(!afterSnapshotResave.audit.some((entry) =>
    entry.source === 'workflow_ledger' && entry.value?.kind === 'workflow.project-workspace.imported'),
  'destination-local import authority is excluded from portable Project audit')
  const importedAttempts = await modelAttemptApi.queryPersistedModelAttempts({ projectId: fixture.project.id }, destinationRoot)
  assertEqual(importedAttempts.total, 1, 'imported ModelAttempt is readable')
  assertEqual(importedAttempts.attempts[0].recordDigest, fixture.modelAttempt.recordDigest,
    'imported ModelAttempt preserves its immutable record')
  const importedLifecycle = await artifactLifecycleApi.getPersistedArtifactLifecycle(
    fixture.blobLifecycle.artifactId,
    { workflowRoot: destinationRoot, workspaceRoot: destinationRoot }
  )
  assertEqual(importedLifecycle?.digest, fixture.blobLifecycle.digest, 'imported Artifact lifecycle is readable')
  const importedBlob = readFileSync(path.join(
    destinationRoot,
    'artifact-blobs',
    'sha256',
    fixture.blobLifecycle.digest.slice('sha256:'.length)
  ))
  assertEqual(importedBlob.toString('utf8'), 'portable artifact bytes\n', 'imported Artifact blob preserves exact bytes')
  const importedSourceLifecycle = await artifactLifecycleApi.getPersistedArtifactLifecycle(
    fixture.sourceLifecycle.artifactId,
    { workflowRoot: destinationRoot, workspaceRoot: destinationRoot }
  )
  assert(importedSourceLifecycle?.sourceRef?.startsWith(path.join(destinationRoot, 'artifact-source-files')),
    'imported source_ref is rebound below the destination private Artifact root')
  assert(importedSourceLifecycle?.sourceRef !== fixture.sourceLifecycle.sourceRef,
    'imported source_ref never reuses the source host path')
  assertEqual(readFileSync(importedSourceLifecycle.sourceRef, 'utf8'), 'portable source artifact bytes\n',
    'imported source_ref preserves exact bytes')
  const importedSourceLocation = imported.workflow.artifactLocations.find(
    (location) => location.id === fixture.sourceLifecycle.locationId
  )
  assertEqual(importedSourceLocation?.path, importedSourceLifecycle.sourceRef,
    'imported Artifact Location is rebound with its lifecycle')
  const importedSourceEvidence = imported.workflow.workflowEvidence.find(
    (evidence) => evidence.evidenceId === fixture.sourceEvidence.evidenceId
  )
  assertEqual(importedSourceEvidence?.uri, pathToFileURL(importedSourceLifecycle.sourceRef).href,
    'imported Evidence URI is rebound to the private destination copy')
  assertEqual(readFileSync(fixture.sourceLifecycle.sourceRef, 'utf8'), 'portable source artifact bytes\n',
    'Project import leaves the user-owned source file untouched')
  const importedEffectArtifact = path.join(
    destinationRoot,
    'effect-artifacts',
    ...fixture.effectArtifact.artifactRef.split('/'),
    'index'
  )
  assertEqual(readFileSync(importedEffectArtifact, 'utf8'), fixture.effectArtifact.indexBytes.toString('utf8'),
    'imported Effect artifact preserves exact frozen Git index bytes')
  assertEqual(readFileSync(path.join(
    destinationRoot,
    'effect-artifacts',
    ...fixture.effectArtifact.artifactRef.split('/'),
    'objects',
    fixture.effectArtifact.objectPath
  ), 'utf8'), fixture.effectArtifact.objectBytes.toString('utf8'),
  'imported Effect artifact preserves exact loose Git object bytes')
  process.env.CAOGEN_TEST_USER_DATA_ROOT = destinationRoot
  const importedEffectTarget = imported.workflow.runs[0].taskRun.effects[0].target
  const frozenEffectArtifact = gitIndexArtifactApi.readFrozenGitIndexArtifact(importedEffectTarget)
  assertEqual(frozenEffectArtifact.artifactRoot, realpathSync(path.dirname(importedEffectArtifact)),
    'stable Effect artifactRef resolves below the destination userData root')
  assertEqual(frozenEffectArtifact.indexBytes.toString('utf8'), fixture.effectArtifact.indexBytes.toString('utf8'),
    'the unchanged imported Effect reads the destination frozen bytes')
  delete process.env.CAOGEN_TEST_USER_DATA_ROOT
  const importedHistory = JSON.parse(readFileSync(path.join(destinationRoot, 'sessions.json'), 'utf8'))
  assertEqual(importedHistory.entries[0].id, runSessionId(fixture.run), 'imported Session history preserves identity')
  const importedActive = JSON.parse(readFileSync(path.join(destinationRoot, 'active-sessions.json'), 'utf8'))
  assertEqual(importedActive.sessions[0].sdkSessionId, 'sdk-session-importable',
    'imported active Session preserves SDK identity')
  assertEqual(
    readFileSync(path.join(destinationRoot, 'transcripts', 'sdk-session-importable.jsonl'), 'utf8'),
    '{"portable":"transcript"}\n',
    'imported transcript preserves exact bytes'
  )
  assertEqual(
    readFileSync(path.join(destinationRoot, 'attachments', 'session-importable', 'fixture.txt'), 'utf8'),
    'portable attachment\n',
    'imported attachment preserves exact bytes'
  )
  const testEvidenceDigest = createHash('sha256').update(path.resolve(sourceRoot)).digest('hex').slice(0, 24)
  const importedTestEvidence = JSON.parse(readFileSync(path.join(
    destinationRoot,
    'project-test-evidence',
    testEvidenceDigest,
    'project-test-evidence-importable.json'
  ), 'utf8'))
  assertEqual(importedTestEvidence.projectId, fixture.project.id,
    'imported test evidence preserves its Project owner')
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
      'task-snapshot-portability',
      'model-attempt-portability',
      'artifact-blob-byte-portability',
      'artifact-source-ref-byte-portability',
      'artifact-source-ref-safe-rebind',
      'evidence-uri-safe-rebind',
      'source-owner-preservation',
      'artifact-source-ref-tamper-rejection',
      'effect-artifact-byte-portability',
      'effect-artifact-tamper-rejection',
      'effect-artifact-stable-reference-readback',
      'learning-skill-external-manifest',
      'learning-skill-resource-symlink-rejection',
      'office-output-manifest-byte-binding',
      'legacy-runtime-without-external-files',
      'external-file-manifest-tamper-rejection',
      'legacy-memory-canonical-rebind',
      'connector-authorization-metadata-portability',
      'session-history-active-journal-portability',
      'transcript-receipt-attachment-portability',
      'project-test-evidence-portability',
      'task-plan-portability',
      'role-template-dependency-auto-install',
      'role-template-dependency-conflict-fail-closed',
      'private-source-0600',
      'phase-journal',
      'write-before-journal-replay',
      'workflow-write-before-journal-replay',
      'restart-resume',
      'import-authority-preserves-canonical-work-item',
      'local-authority-nonportable',
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

async function assertSymlinkResourceRootRejected(externalFileManifestApi) {
  const realRoot = path.join(tempRoot, 'symlink-resource-target')
  const linkedRoot = path.join(tempRoot, 'symlink-resource-root')
  const skillPath = path.join(realRoot, '.caogen', 'skills', 'linked', 'SKILL.md')
  mkdirSync(path.dirname(skillPath), { recursive: true })
  writeFileSync(skillPath, '# Linked Skill\n')
  symlinkSync(realRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')
  await assertRejects(
    externalFileManifestApi.collectProjectExternalFileManifests({
      resources: [{ id: 'symlink-resource', kind: 'directory', path: linkedRoot }],
      workflow: { artifacts: [] }
    }, []),
    (error) => /Resource root must be a real directory/i.test(String(error?.message)),
    'Resource-root symlink is rejected before Skill manifest traversal'
  )
}

async function seedSource(apis) {
  const core = await seedProjectGraph(apis)
  const runtime = await seedRuntimeRecords(apis, core)
  const delivery = await seedDeliveryRecords(apis, core)
  const workforce = await seedWorkforceRecords(apis, core)
  const learning = await seedLearningRecords(apis, core)
  seedPortableSessionData(apis.taskPlanApi, core.project, core.goal, core.workItem, core.run)
  return {
    ...core,
    ...runtime,
    ...delivery,
    ...workforce,
    ...learning,
    taskEvidenceId: `effect-evidence-${core.run.id}`
  }
}

async function seedProjectGraph({
  workspaceApi, workflowApi, workflowStore, snapshotApi, taskEvidenceApi, evidenceProjectionApi
}) {
  const workspace = await new workspaceApi.ProjectWorkspaceStore(sourceRoot).open()
  const project = await workspace.createWorkspace({
    id: 'project-importable',
    name: 'Importable Project',
    kind: 'research',
    budgetPolicy: { monthlyUsd: 20 },
    permissionPolicy: { classification: 'project-internal' },
    retentionPolicy: { auditDays: 30 },
    resources: [{
      id: 'connector-project-importable',
      kind: 'connector',
      label: 'Importable connector',
      uri: 'mock-connector://account/project',
      connector: {
        schemaVersion: 1,
        usage: ['resource'],
        capabilities: ['resource:read'],
        dataDirection: 'read',
        authorization: {
          subject: 'personal',
          principalId: 'project-import-principal',
          scopes: ['resource:read'],
          status: 'active',
          grantedAt: 99
        },
        version: 'v1',
        revocation: { behavior: 'deny_new_operations', purgeCachedData: true },
        writePolicy: { effect: 'required', reconciliation: 'queryable' }
      }
    }, {
      id: 'directory-project-importable',
      kind: 'directory',
      label: 'Importable external files',
      path: sourceRoot
    }],
    createdAt: 100,
    updatedAt: 100
  })
  const goal = await workspace.createGoal({
    id: 'goal-importable', projectId: project.id, title: 'Import Goal', objective: 'Prove Project import',
    createdAt: 101, updatedAt: 101
  })
  const workItem = await workspace.createWorkItem({
    id: 'work-item-importable', projectId: project.id, goalId: goal.id, title: 'Import WorkItem',
    type: 'testing', runRefs: ['run-importable'],
    artifactRefs: ['artifact-importable', 'artifact-blob-importable', 'artifact-source-importable'],
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
  const runFixture = taskRunFixture()
  const run = runFixture.run
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
  return { project, goal, workItem, run, effectArtifact: runFixture.effectArtifact }
}

async function seedRuntimeRecords({ snapshotApi, modelAttemptApi }, { project, goal, workItem, run }) {
  const snapshot = await snapshotApi.saveTaskSnapshot(snapshotApi.buildTaskSnapshot({
    meta: {
      id: run.sessionId,
      title: 'Importable session',
      cwd: sourceRoot,
      projectId: project.id,
      workspaceId: project.id,
      goalId: goal.id,
      workItemId: workItem.id,
      childTaskId: run.taskId,
      model: 'fixture-model',
      providerId: 'fixture-provider',
      permissionMode: 'default',
      status: 'running',
      sdkSessionId: 'sdk-session-importable',
      costUsd: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      contextTokens: 0,
      createdAt: 103
    },
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    now: 104
  }), sourceRoot)
  await modelAttemptApi.startPersistedModelAttempt({
    id: 'attempt-importable',
    commandId: 'attempt-importable-start',
    requestId: 'request-importable',
    runId: run.id,
    providerId: 'fixture-provider',
    model: 'fixture-model',
    protocol: 'openai.responses',
    adapterVersion: 'adapter-v1',
    contextDigest: `sha256:${'c'.repeat(64)}`,
    routeReason: 'Synthetic Project portability fixture.',
    keyLabel: 'label:portable-fixture',
    startedAt: 105
  }, sourceRoot)
  const modelAttempt = await modelAttemptApi.completePersistedModelAttempt('attempt-importable', {
    commandId: 'attempt-importable-complete',
    expectedRevision: 1,
    status: 'failed',
    completedAt: 106,
    outcome: 'rate_limited',
    errorClass: 'provider_rate_limit'
  }, sourceRoot)
  return { snapshot, modelAttempt }
}

async function seedDeliveryRecords({ workflowApi, artifactLifecycleApi }, { project, goal, workItem, run }) {
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
  const blobRegistration = await artifactLifecycleApi.registerPersistedArtifactLifecycle({
    id: 'artifact-blob-importable',
    projectId: project.id,
    goalId: goal.id,
    workItemId: workItem.id,
    runId: run.id,
    lineageId: 'artifact-blob-lineage-importable',
    kind: 'document',
    title: 'Portable blob',
    version: 1,
    provenance: 'explicit',
    retention: { mode: 'retain' },
    content: { storageKind: 'blob', bytes: Buffer.from('portable artifact bytes\n') },
    createdAt: 108
  }, { workflowRoot: sourceRoot, workspaceRoot: sourceRoot })
  const sourceFile = path.join(sourceRoot, 'portable-source-artifact.docx')
  const sourceBytes = Buffer.from('portable source artifact bytes\n')
  writeFileSync(sourceFile, sourceBytes)
  const sourceRegistration = await artifactLifecycleApi.registerPersistedArtifactLifecycle({
    id: 'artifact-source-importable',
    projectId: project.id,
    goalId: goal.id,
    workItemId: workItem.id,
    runId: run.id,
    lineageId: 'artifact-source-lineage-importable',
    kind: 'document',
    title: 'Portable source reference',
    version: 1,
    provenance: 'explicit',
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    retention: { mode: 'retain' },
    content: { storageKind: 'source_ref', sourceRef: sourceFile },
    metadata: {
      producer: 'office_delivery',
      effectId: 'effect-office-importable',
      outputBindingVersion: 1,
      expectedSha256: `sha256:${createHash('sha256').update(sourceBytes).digest('hex')}`,
      expectedBytes: sourceBytes.byteLength
    },
    createdAt: 109
  }, { workflowRoot: sourceRoot, workspaceRoot: sourceRoot })
  const sourceEvidence = await workflowApi.createWorkflowEvidence({
    evidenceId: 'workflow-evidence-source-importable',
    projectId: project.id,
    goalId: goal.id,
    workItemId: workItem.id,
    runId: run.id,
    artifactId: sourceRegistration.artifact.id,
    kind: 'delivery_check',
    title: 'Portable source evidence',
    uri: pathToFileURL(sourceFile).href,
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    contentDigest: sourceRegistration.lifecycle.digest.slice('sha256:'.length)
  }, sourceRoot, { source: 'runtime', verifier: 'project-import-smoke', observedAt: 110 })
  return {
    artifact,
    location,
    acceptance,
    evidence,
    evidenceLink,
    blobLifecycle: blobRegistration.lifecycle,
    sourceLifecycle: sourceRegistration.lifecycle,
    sourceEvidence
  }
}

async function seedWorkforceRecords({ workerApi }, { project, workItem }) {
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
  return { worker, assignment, lease }
}

async function seedLearningRecords({ aggregateApi, learningApi }, { project }) {
  const skillPath = path.join(sourceRoot, '.caogen', 'skills', 'importable', 'SKILL.md')
  mkdirSync(path.dirname(skillPath), { recursive: true })
  writeFileSync(skillPath, '# Importable Skill\n\nPortable external Skill manifest.\n')
  const memory = await aggregateApi.createProjectMemoryDraft(project.id, path.join(sourceRoot, 'learning'), {
    id: 'memory-importable', source: 'project-import-smoke',
    payload: { memoryKind: 'decision', title: 'Import memory', body: 'Portable memory', reason: 'Import regression' }
  })
  const legacyLearningRoot = path.join(sourceRoot, 'legacy-project-root')
  const legacyMemory = await learningApi.createLearningDraft(legacyLearningRoot, path.join(sourceRoot, 'learning'), {
    kind: 'memory',
    source: 'project-import-smoke',
    payload: {
      type: 'memory',
      memoryKind: 'decision',
      title: 'Legacy import memory',
      body: 'Portable legacy memory',
      reason: 'Legacy namespace regression'
    }
  }, { requestedId: 'memory-legacy-importable', requestedLogicalId: 'memory-legacy-logical', now: () => 113 })
  return { memory, legacyMemory, legacyLearningRoot }
}

function seedPortableSessionData(taskPlanApi, project, goal, workItem, run) {
  const meta = {
    id: run.sessionId,
    sdkSessionId: 'sdk-session-importable',
    title: 'Importable session',
    cwd: sourceRoot,
    projectId: project.id,
    workspaceId: project.id,
    goalId: goal.id,
    workItemId: workItem.id,
    model: 'fixture-model',
    providerId: 'fixture-provider'
  }
  writeFileSync(path.join(sourceRoot, 'sessions.json'), `${JSON.stringify({ schemaVersion: 1, entries: [meta] }, null, 2)}\n`)
  writeFileSync(path.join(sourceRoot, 'active-sessions.json'), `${JSON.stringify({ schemaVersion: 1, sessions: [meta] }, null, 2)}\n`)
  writeFileSync(path.join(sourceRoot, 'session-creation-journal.json'), `${JSON.stringify({
    schemaVersion: 1,
    format: 'caogen.session-creation-journal.v1',
    records: [{
      requestId: 'creation-importable',
      sessionId: run.sessionId,
      draft: { baseMeta: meta, opts: { workspaceId: project.id, projectId: project.id } }
    }]
  }, null, 2)}\n`)
  mkdirSync(path.join(sourceRoot, 'transcripts'), { recursive: true })
  writeFileSync(path.join(sourceRoot, 'transcripts', 'sdk-session-importable.jsonl'), '{"portable":"transcript"}\n')
  mkdirSync(path.join(sourceRoot, 'event-receipts'), { recursive: true })
  writeFileSync(path.join(sourceRoot, 'event-receipts', 'sdk-session-importable.jsonl'), '{"portable":"receipt"}\n')
  mkdirSync(path.join(sourceRoot, 'attachments', run.sessionId), { recursive: true })
  writeFileSync(path.join(sourceRoot, 'attachments', run.sessionId, 'fixture.txt'), 'portable attachment\n')
  mkdirSync(path.join(sourceRoot, 'preview-annotations', run.sessionId), { recursive: true })
  writeFileSync(path.join(sourceRoot, 'preview-annotations', run.sessionId, 'annotation.json'), '{"portable":true}\n')
  mkdirSync(path.join(sourceRoot, 'task-audit'), { recursive: true })
  writeFileSync(path.join(sourceRoot, 'task-audit', `${run.sessionId}.jsonl`), '{"portable":"audit"}\n')
  mkdirSync(path.join(sourceRoot, 'patches'), { recursive: true })
  writeFileSync(path.join(sourceRoot, 'patches', `${run.sessionId}.patch`), 'portable patch\n')
  new taskPlanApi.TaskPlanContractStore(() => sourceRoot).createVersion({
    sessionId: run.sessionId,
    workspaceId: project.id,
    goalId: goal.id,
    workItemId: workItem.id
  }, {
    objective: 'Restore the complete portable Project runtime',
    steps: [{ id: 'restore', title: 'Restore Project data', description: 'Import and verify every owned record' }],
    expectedArtifacts: ['Verified Project import'],
    dataEgress: [],
    estimatedCostUsd: 0,
    riskLevel: 'medium',
    acceptanceCriteria: ['Imported Project is semantically equivalent to its source']
  }, 'local-user')
  const testEvidenceDigest = createHash('sha256').update(path.resolve(sourceRoot)).digest('hex').slice(0, 24)
  const testEvidenceId = 'project-test-evidence-importable'
  mkdirSync(path.join(sourceRoot, 'project-test-evidence', testEvidenceDigest), { recursive: true })
  writeFileSync(path.join(sourceRoot, 'project-test-evidence', testEvidenceDigest, `${testEvidenceId}.json`), `${JSON.stringify({
    kind: 'caogen-project-test-evidence',
    schemaVersion: 2,
    evidenceId: testEvidenceId,
    workspaceDigest: testEvidenceDigest,
    sessionId: run.sessionId,
    projectId: project.id,
    status: 'passed',
    outputDigest: createHash('sha256').update('portable project test evidence').digest('hex')
  }, null, 2)}\n`)
}

function runSessionId(run) {
  return run.sessionId
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
  const effectArtifact = seedEffectArtifact()
  const run = {
    schemaVersion: 1,
    id: 'run-importable',
    sessionId: 'session-importable',
    taskId: 'task-importable',
    status: 'executing',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: 103,
    updatedAt: 104,
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
      target: effectArtifact.target,
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
  return { run, effectArtifact }
}

function seedEffectArtifact() {
  const key = 'e'.repeat(64)
  const artifactRef = `git-index/${key}`
  const artifactRoot = path.join(sourceRoot, 'effect-artifacts', 'git-index', key)
  const indexBytes = Buffer.from('portable frozen Git index bytes\n')
  const indexSha256 = createHash('sha256').update(indexBytes).digest('hex')
  const expectedIndexEntriesDigest = 'expected-portable-index-entries'
  const objectPath = `ab/${'c'.repeat(38)}`
  const objectBytes = Buffer.from('portable frozen loose Git object bytes\n')
  const manifest = {
    schemaVersion: 1,
    expectedIndexEntriesDigest,
    indexSha256,
    indexBytes: indexBytes.byteLength,
    objects: [{
      path: objectPath,
      sha256: createHash('sha256').update(objectBytes).digest('hex'),
      bytes: objectBytes.byteLength
    }]
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  mkdirSync(artifactRoot, { recursive: true })
  writeFileSync(path.join(artifactRoot, 'index'), indexBytes)
  writeFileSync(path.join(artifactRoot, 'manifest.json'), manifestBytes)
  mkdirSync(path.join(artifactRoot, 'objects', path.dirname(objectPath)), { recursive: true })
  writeFileSync(path.join(artifactRoot, 'objects', objectPath), objectBytes)
  const identity = { device: 'fixture-device', inode: 'fixture-inode' }
  const target = {
    kind: 'git_index_update',
    repoRoot: sourceRoot,
    repoRootIdentity: identity,
    gitCommonDir: path.join(sourceRoot, '.git'),
    gitCommonDirIdentity: identity,
    worktreeGitDir: path.join(sourceRoot, '.git'),
    worktreeGitDirIdentity: identity,
    objectDir: path.join(sourceRoot, '.git', 'objects'),
    objectDirIdentity: identity,
    objectFormat: 'sha1',
    indexPath: path.join(sourceRoot, '.git', 'index'),
    preHeadState: 'unborn',
    headRef: 'refs/heads/main',
    preIndexState: 'absent',
    preIndexEntriesDigest: 'pre-portable-index-entries',
    expectedIndexEntriesDigest,
    operation: 'stage_all',
    paths: [],
    worktreeReadScope: 'all',
    artifactRef,
    artifactRoot,
    artifactRootIdentity: identity,
    indexArtifactPath: path.join(artifactRoot, 'index'),
    indexArtifactIdentity: identity,
    indexArtifactSha256: indexSha256,
    indexArtifactBytes: indexBytes.byteLength,
    objectManifestPath: path.join(artifactRoot, 'manifest.json'),
    objectManifestIdentity: identity,
    objectManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    objectCount: 1
  }
  return { artifactRef, artifactRoot, indexBytes, objectPath, objectBytes, target }
}

function aggregateRoots(root, legacyLearningRoot) {
  return {
    workspaceRoot: root,
    workflowRoot: root,
    digitalWorkerRoot: root,
    routineRoot: path.join(root, 'routines'),
    learningRoot: path.join(root, 'learning'),
    aggregateRoot: root,
    ...(legacyLearningRoot ? { legacyLearningRoots: { 'project-importable': [legacyLearningRoot] } } : {})
  }
}

async function assertImportReconciliationRootIsolation(importTargetApi, result) {
  const target = {
    kind: 'project_portable_import',
    operationId: result.operationId,
    importedProjectId: result.projectId,
    exportDigest: result.exportDigest,
    sourceAggregateDigest: result.sourceAggregateDigest,
    projectId: 'project-system-import-report',
    goalId: 'goal-system-import-report',
    workItemId: 'work-system-import-report',
    runId: `operation:${result.operationId}`,
    artifactId: `artifact:project-portable-import:${result.operationId}`,
    evidenceId: `evidence:project-portable-import:${result.operationId}`,
    acceptanceId: `acceptance:project-portable-import:${result.operationId}`,
    format: 'caogen.project-aggregate.v1'
  }
  const matchingRoot = await importTargetApi.reconcileProjectPortableImportEffectTarget(target, destinationRoot)
  assertEqual(matchingRoot.kind, 'unresolved',
    'matching import root reaches completed journal verification before the missing report check')
  const foreignRoot = await importTargetApi.reconcileProjectPortableImportEffectTarget(target, conflictingDestinationRoot)
  assertEqual(foreignRoot.kind, 'not_applied', 'foreign import root cannot observe another root journal')
  const unbound = await importTargetApi.reconcileProjectPortableImportEffectTarget(target)
  assertEqual(unbound.kind, 'unresolved', 'unbound import reconciliation fails closed')
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/data-lifecycle/project-import-coordinator.ts',
    'src/main/project-import-effect-target.ts',
    'src/main/project-workspace/index.ts',
    'src/main/digital-worker/index.ts',
    'src/main/project-aggregate/index.ts',
    'src/main/task/workflow-ledger-api.ts',
    'src/main/task/workflow-ledger-store.ts',
    'src/main/task/task-snapshot.ts',
    'src/main/task/model-attempt-api.ts',
    'src/main/task/artifact-lifecycle-api.ts',
    'src/main/git/git-index-artifact.ts',
    'src/main/learning/learning-lifecycle.ts',
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
  writeFileSync(path.join(electronDir, 'index.js'), `export const app = { getPath: () => process.env.CAOGEN_TEST_USER_DATA_ROOT || ${JSON.stringify(sourceRoot)} }\n`)
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
