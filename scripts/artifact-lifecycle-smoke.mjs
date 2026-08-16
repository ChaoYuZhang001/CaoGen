#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter)
require('node:module').Module._initPaths()
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-artifact-lifecycle-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
process.env.CAOGEN_USER_DATA = userData
const reportRoot = path.join(repoRoot, 'test-results', 'artifact-lifecycle')
const reportDir = path.join(reportRoot, runId)
const report = {
  schemaVersion: 1,
  runId,
  status: 'failed',
  sourceRevision: gitOutput(['rev-parse', 'HEAD']),
  worktreeStatusCount: gitOutput(['status', '--porcelain']).split('\n').filter(Boolean).length,
  checks: [],
  summary: {},
  failures: []
}

try {
  mkdirSync(userData, { recursive: true })
  compileSources()
  installElectronStub()
  await runLifecycleGate()
  report.status = 'passed'
} catch (error) {
  report.failures.push(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
} finally {
  mkdirSync(reportDir, { recursive: true })
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(reportDir, 'report.json'), serialized, 'utf8')
  writeFileSync(path.join(reportRoot, 'latest.json'), serialized, 'utf8')
  rmSync(tempRoot, { recursive: true, force: true })
}

console.log(JSON.stringify({
  status: report.status,
  runId,
  checks: report.checks.length,
  summary: report.summary,
  failures: report.failures,
  reportDir
}, null, 2))

async function runLifecycleGate() {
  const workspaceApi = await importCompiled('main/project-workspace/index.js')
  const workspaceCommands = await importCompiled('main/project-workspace/command-service.js')
  const lifecycleApi = await importCompiled('main/task/artifact-lifecycle-api.js')
  const lifecycleTypes = await importCompiled('main/task/artifact-lifecycle-types.js')
  const lifecycleContent = await importCompiled('main/task/artifact-lifecycle-content.js')
  const workflowApi = await importCompiled('main/task/workflow-ledger-api.js')
  const snapshotApi = await importCompiled('main/task/task-snapshot.js')
  const effectRuntime = await importCompiled('main/task/effect-runtime.js')
  const runtimeRegistry = await importCompiled('main/task/task-runtime-registry.js')
  const gitTools = await importCompiled('main/agent/tools/git-tools.js')
  const requiredKindCount = lifecycleTypes.REQUIRED_ARTIFACT_KINDS.length

  const fixture = await seedCanonicalRun(workspaceApi, workspaceCommands, snapshotApi)
  check('canonical ProjectWorkspace owns the creating Run and WorkItem')
  const registered = await registerRequiredArtifactKinds({
    fixture,
    lifecycleApi,
    lifecycleTypes,
    lifecycleContent
  })
  const reportV2 = await verifyRegistrationContracts({
    ...registered,
    fixture,
    snapshotApi,
    lifecycleApi,
    lifecycleTypes,
    lifecycleContent
  })
  await verifyRetentionAndContentIntegrity({
    ...registered,
    fixture,
    reportV2,
    lifecycleApi,
    lifecycleTypes
  })

  const production = await runProductionPatchProducer({
    fixture,
    lifecycleApi,
    snapshotApi,
    effectRuntime,
    runtimeRegistry,
    gitTools
  })
  assertEqual(production.kind, 'patch', 'production Artifact kind')
  assertEqual(production.runId, fixture.runId, 'production Artifact creating Run')
  assertEqual(production.storageKind, 'source_ref', 'production Artifact storage kind')
  assert(production.digest.startsWith('sha256:'), 'production Artifact digest')
  check('production Code Forge patch crosses Effect confirmation into Artifact lifecycle')

  const final = await lifecycleApi.verifyPersistedArtifactLifecycle(
    userData,
    lifecycleTypes.REQUIRED_ARTIFACT_KINDS
  )
  assertEqual(final.artifacts, requiredKindCount + 2, 'final Artifact count including production output')
  assertEqual(final.available, requiredKindCount - 2, 'final available Artifact count including production output')
  check('later Run revisions preserve historical creating-Run lifecycle validity')

  await runLegacyDagFileProducer({ snapshotApi, effectRuntime, runtimeRegistry, lifecycleApi, workflowApi })
  await runConfirmedProjectionFailureProbe({
    workspaceApi, workspaceCommands, snapshotApi, effectRuntime, runtimeRegistry, workflowApi
  })

  report.summary = {
    requiredKinds: lifecycleTypes.REQUIRED_ARTIFACT_KINDS.length,
    artifacts: final.artifacts,
    available: final.available,
    purged: final.purged,
    blobArtifacts: final.blobs,
    sourceRefArtifacts: final.sourceRefs,
    supersessionEdges: 1,
    productionArtifacts: 1
  }
}

async function runLegacyDagFileProducer({ snapshotApi, effectRuntime, runtimeRegistry, lifecycleApi, workflowApi }) {
  const legacyRoot = path.join(tempRoot, 'legacy-dag-user-data')
  const repo = path.join(tempRoot, 'legacy-dag-repo')
  const projectId = 'legacy-dag-project'
  const sessionId = 'legacy-dag-session'
  const runId = 'legacy-dag-run'
  const outputPath = path.join(repo, 'legacy.txt')
  mkdirSync(repo, { recursive: true })
  const run = {
    schemaVersion: 1,
    id: runId,
    sessionId,
    taskId: 'legacy-write',
    status: 'queued',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: 2_000,
    updatedAt: 2_000,
    steps: [],
    toolExecutions: [],
    effects: []
  }
  const snapshot = snapshotApi.buildTaskSnapshot({
    meta: {
      id: sessionId,
      title: 'Legacy DAG Artifact fixture',
      cwd: repo,
      projectId,
      orchestrationId: 'legacy-dag-orchestration',
      childTaskId: 'legacy-write',
      childRole: 'backend',
      model: 'fixture-model',
      providerId: 'fixture-provider',
      permissionMode: 'default',
      status: 'running',
      sdkSessionId: 'sdk-legacy-dag',
      engine: 'openai',
      costUsd: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      contextTokens: 0,
      createdAt: run.createdAt
    },
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run,
    now: run.updatedAt
  })
  const persisted = await snapshotApi.saveTaskSnapshot(snapshot, legacyRoot)
  runtimeRegistry.taskRuntimeRegistry.set(sessionId, persisted.run ?? run)
  const effectInput = {
    rootDir: legacyRoot,
    sessionId,
    cwd: repo,
    toolUseId: 'legacy-write-call',
    toolName: 'write_file',
    toolInput: { path: 'legacy.txt', content: 'legacy DAG output\n' }
  }
  const handle = await effectRuntime.prepareEffectExecution(effectInput)
  await effectRuntime.markEffectExecutionStarted(handle, effectInput)
  mkdirSync(repo, { recursive: true })
  writeFileSync(outputPath, 'legacy DAG output\n', 'utf8')
  const effect = await effectRuntime.completeEffectExecution(handle, {
    ok: true,
    output: '已写入 legacy.txt'
  })
  assertEqual(effect?.status, 'confirmed', 'legacy DAG file Effect remains confirmed')
  const ledger = await workflowApi.listPersistedWorkflowLedger({ projectId, limit: 100 }, legacyRoot)
  const artifact = ledger.artifacts.items.find((item) => item.runId === runId)
  assert(artifact, 'legacy DAG file must retain an Artifact record')
  assertEqual(artifact.provenance, 'legacy-derived', 'legacy DAG Artifact provenance')
  assertEqual(
    ledger.events.items.filter((event) => event.kind.startsWith('workflow.artifact.stage.')).length,
    0,
    'legacy DAG Artifact must not attach a canonical stage event'
  )
  await lifecycleApi.verifyPersistedArtifactLifecycle(legacyRoot)
  check('legacy DAG file output keeps confirmed Effect and compatibility Artifact without canonical stage attachment')
}

async function runConfirmedProjectionFailureProbe({
  workspaceApi,
  workspaceCommands,
  snapshotApi,
  effectRuntime,
  runtimeRegistry,
  workflowApi
}) {
  const root = path.join(tempRoot, 'missing-canonical-workspace')
  const repo = path.join(tempRoot, 'missing-canonical-repo')
  const projectId = 'missing-canonical-project'
  const workItemId = 'missing-canonical-work-item'
  const sessionId = 'missing-canonical-session'
  const runId = 'missing-canonical-run'
  mkdirSync(repo, { recursive: true })
  const run = {
    schemaVersion: 1,
    id: runId,
    sessionId,
    taskId: 'missing-canonical-task',
    status: 'queued',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: 3_000,
    updatedAt: 3_000,
    steps: [],
    toolExecutions: [],
    effects: []
  }
  const workspaceStore = new workspaceApi.ProjectWorkspaceStore(root)
  await workspaceStore.open()
  await workspaceStore.createWorkspace({ id: projectId, name: 'Missing canonical Workspace fixture', kind: 'software' })
  const commands = workspaceCommands.createProjectWorkspaceCommandService(workspaceStore, { rootDir: root })
  await commands.reconcileShadowProjection()
  const workItem = await commands.createWorkItem({
    id: workItemId,
    projectId,
    title: 'Missing canonical Workspace WorkItem',
    type: 'writing'
  })
  const persisted = await snapshotApi.saveTaskSnapshot(snapshotApi.buildTaskSnapshot({
    meta: {
      id: sessionId,
      title: 'Missing canonical Workspace fixture',
      cwd: repo,
      projectId,
      workspaceId: projectId,
      workItemId,
      childTaskId: 'missing-canonical-task',
      model: 'fixture-model',
      providerId: 'fixture-provider',
      permissionMode: 'default',
      status: 'running',
      sdkSessionId: 'sdk-missing-canonical',
      engine: 'openai',
      costUsd: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      contextTokens: 0,
      createdAt: run.createdAt
    },
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run,
    now: run.updatedAt
  }), root)
  const currentWorkItem = await workspaceStore.getWorkItem(workItem.id)
  if (!currentWorkItem) throw new Error(`missing canonical fixture WorkItem disappeared:${workItem.id}`)
  await commands.updateWorkItem(workItem.id, {
    runRefs: [...currentWorkItem.runRefs, runId]
  }, { expectedRevision: currentWorkItem.revision })
  rmSync(path.join(root, 'project-workspace.json'), { force: true })
  runtimeRegistry.taskRuntimeRegistry.set(sessionId, persisted.run ?? run)
  const effectInput = {
    rootDir: root,
    sessionId,
    cwd: repo,
    toolUseId: 'missing-canonical-write-call',
    toolName: 'write_file',
    toolInput: { path: 'confirmed.txt', content: 'confirmed before projection\n' }
  }
  const handle = await effectRuntime.prepareEffectExecution(effectInput)
  await effectRuntime.markEffectExecutionStarted(handle, effectInput)
  writeFileSync(path.join(repo, 'confirmed.txt'), 'confirmed before projection\n', 'utf8')
  let projectionError
  try {
    await effectRuntime.completeEffectExecution(handle, { ok: true, output: '已写入 confirmed.txt' })
  } catch (error) {
    projectionError = error
  }
  const confirmedEffect = effectRuntime.confirmedEffectFromArtifactProjectionError(projectionError)
  assert(confirmedEffect, 'missing canonical Workspace must expose a post-confirmation projection error')
  assertEqual(confirmedEffect.status, 'confirmed', 'post-confirmation projection error Effect status')
  const durable = await snapshotApi.getTaskSnapshot(sessionId, root)
  assertEqual(
    durable?.run?.effects?.find((effect) => effect.id === confirmedEffect.id)?.status,
    'confirmed',
    'durable Effect must remain confirmed after Artifact projection failure'
  )
  const ledger = await workflowApi.listPersistedWorkflowLedger({ projectId, limit: 100 }, root)
  assertEqual(ledger.artifacts.total, 0, 'failed canonical projection must not leave a partial Artifact')
  check('post-confirmation Artifact failure remains distinct from unknown external Effect outcome')
}

async function registerRequiredArtifactKinds({ fixture, lifecycleApi, lifecycleTypes, lifecycleContent }) {
  const requiredKindCount = lifecycleTypes.REQUIRED_ARTIFACT_KINDS.length
  const sourcePath = path.join(tempRoot, 'source-input.txt')
  writeFileSync(sourcePath, 'source-ref artifact bytes\n', 'utf8')
  const registrations = new Map()
  const results = []
  for (const [index, kind] of lifecycleTypes.REQUIRED_ARTIFACT_KINDS.entries()) {
    const input = registrationForKind(kind, index, fixture, sourcePath, lifecycleContent)
    registrations.set(input.id, input)
    results.push(await lifecycleApi.registerPersistedArtifactLifecycle(input, userData))
  }
  check(`all ${requiredKindCount} required Artifact kinds register through the production persistence API`)
  assertEqual(
    new Set(results.map((item) => item.artifact.kind)).size,
    requiredKindCount,
    'required Artifact kind count'
  )
  for (const result of results) {
    assertEqual(result.artifact.runId, fixture.runId, 'Artifact creating Run identity')
    assertEqual(result.lifecycle.runRevision, 1, 'Artifact creating Run revision')
    assert(result.lifecycle.digest.startsWith('sha256:'), 'Artifact digest must be content addressed')
    assert(result.lifecycle.provenance === 'explicit', 'Artifact provenance must be explicit')
  }
  check('every Artifact records digest, provenance, version, and creating Run revision')
  return { registrations, results, sourcePath }
}

async function verifyRegistrationContracts(input) {
  const requiredKindCount = input.lifecycleTypes.REQUIRED_ARTIFACT_KINDS.length
  const reportV1 = input.results.find((item) => item.lifecycle.kind === 'report')
  assert(reportV1, 'report v1 fixture is required')
  const reportV2Input = {
    ...input.registrations.get(reportV1.lifecycle.artifactId),
    id: 'artifact-report-v2',
    version: 2,
    supersedesId: reportV1.lifecycle.artifactId,
    content: { storageKind: 'blob', bytes: Buffer.from('report version two\n') },
    createdAt: 1_100
  }
  const reportV2 = await input.lifecycleApi.registerPersistedArtifactLifecycle(reportV2Input, userData)
  assertEqual(reportV2.supersedesEdge?.relation, 'supersedes', 'supersession relation')
  assertEqual(reportV2.lifecycle.version, 2, 'supersession version')
  check('continuous lineage creates an immutable supersedes edge')
  const idempotent = await input.lifecycleApi.registerPersistedArtifactLifecycle(reportV2Input, userData)
  assertEqual(idempotent.lifecycle.digest, reportV2.lifecycle.digest, 'idempotent registration digest')
  check('identical Artifact registration is idempotent')
  await verifyRunRevisionReplay(input, reportV2Input, reportV2)
  await verifyRegistrationRejections(input, reportV2Input)
  const initial = await input.lifecycleApi.verifyPersistedArtifactLifecycle(
    userData,
    input.lifecycleTypes.REQUIRED_ARTIFACT_KINDS
  )
  assertEqual(initial.artifacts, requiredKindCount + 1, 'initial Artifact count')
  assertEqual(initial.available, requiredKindCount + 1, 'initial available Artifact count')
  assertEqual(initial.kinds.length, requiredKindCount, 'verified required kind count')
  check('restart-safe verification covers all kinds, graph rows, events, and physical bytes')
  return reportV2
}

async function verifyRunRevisionReplay(input, reportV2Input, firstRegistration) {
  const snapshot = await input.snapshotApi.getTaskSnapshot(input.fixture.run.sessionId, userData)
  assert(snapshot?.run, 'Artifact replay fixture Run must persist')
  const revisedRun = {
    ...snapshot.run,
    revision: 2,
    updatedAt: snapshot.run.updatedAt + 1
  }
  await input.snapshotApi.saveTaskSnapshot({
    ...snapshot,
    run: revisedRun,
    updatedAt: revisedRun.updatedAt
  }, userData)
  const replayed = await input.lifecycleApi.registerPersistedArtifactLifecycle(reportV2Input, userData)
  assertEqual(replayed.lifecycle.runRevision, 1, 'idempotent replay creating Run revision')
  assertEqual(
    replayed.lifecycle.projectRevision,
    firstRegistration.lifecycle.projectRevision,
    'idempotent replay creating Project revision'
  )
  assertEqual(replayed.lifecycle.createdAt, firstRegistration.lifecycle.createdAt, 'idempotent replay creation time')
  check('Run revision 2 replay preserves the Artifact creation identity from Run revision 1')
}

async function verifyRegistrationRejections(input, reportV2Input) {
  await assertRejects(
    input.lifecycleApi.registerPersistedArtifactLifecycle({
      ...reportV2Input,
      content: { storageKind: 'blob', bytes: Buffer.from('mutated report bytes\n') }
    }, userData),
    /immutable|changed|digest|content/i,
    'same Artifact identity with changed bytes must fail closed'
  )
  check('immutable Artifact identity rejects changed content')
  await assertRejects(
    input.lifecycleApi.registerPersistedArtifactLifecycle({
      ...registrationForKind('custom', 30, input.fixture, input.sourcePath, input.lifecycleContent),
      id: 'artifact-digest-mismatch',
      content: {
        storageKind: 'blob', bytes: Buffer.from('digest mismatch\n'), expectedDigest: `sha256:${'0'.repeat(64)}`
      }
    }, userData),
    /expectedDigest/i,
    'wrong expected digest must reject before persistence'
  )
  check('declared digest mismatch rejects before persistence')
  await verifyOwnershipRejections(input)
}

async function verifyOwnershipRejections(input) {
  await assertRejects(
    input.lifecycleApi.registerPersistedArtifactLifecycle({
      ...registrationForKind('custom', 31, input.fixture, input.sourcePath, input.lifecycleContent),
      id: 'artifact-cross-project',
      projectId: 'project-b'
    }, userData),
    /Project|ownership|boundary/i,
    'cross-Project Artifact registration must fail closed'
  )
  await assertRejects(
    input.lifecycleApi.registerPersistedArtifactLifecycle({
      ...registrationForKind('custom', 32, input.fixture, input.sourcePath, input.lifecycleContent),
      id: 'artifact-missing-run',
      runId: 'run-missing'
    }, userData),
    /Run|run/i,
    'missing creating Run must fail closed'
  )
  check('cross-Project and missing-Run registrations fail closed')
}

async function verifyRetentionAndContentIntegrity(input) {
  const requiredKindCount = input.lifecycleTypes.REQUIRED_ARTIFACT_KINDS.length
  const byKind = new Map(input.results.map((item) => [item.lifecycle.kind, item]))
  await assertRejects(
    input.lifecycleApi.purgePersistedArtifactContent({
      artifactId: byKind.get('document').lifecycle.artifactId,
      projectId: input.fixture.projectId,
      reason: 'retain policy rejection',
      purgedAt: 2_000
    }, userData),
    /retain|retention/i,
    'retain policy must reject purge'
  )
  check('retain policy blocks destructive purge')
  await purgeExpiringArtifacts(input, byKind)
  const afterPurge = await input.lifecycleApi.verifyPersistedArtifactLifecycle(
    userData,
    input.lifecycleTypes.REQUIRED_ARTIFACT_KINDS
  )
  assertEqual(afterPurge.artifacts, requiredKindCount + 1, 'post-purge Artifact count')
  assertEqual(afterPurge.purged, 4, 'post-purge tombstone count')
  assertEqual(afterPurge.available, requiredKindCount - 3, 'post-purge available count')
  check('later final-owner deletion preserves validity of earlier shared-blob purge evidence')
  await verifyPhysicalTamper(input)
}

async function purgeExpiringArtifacts(input, byKind) {
  const purge = (kind, reason, purgedAt) => input.lifecycleApi.purgePersistedArtifactContent({
    artifactId: byKind.get(kind).lifecycle.artifactId,
    projectId: input.fixture.projectId,
    reason,
    purgedAt
  }, userData)
  const sourcePurge = await purge('source', 'source retention expired', 2_001)
  assertEqual(sourcePurge.purge.disposition, 'source_detached', 'source purge disposition')
  assert(existsSync(input.sourcePath), 'source_ref purge must preserve the external source file')
  const sharedFirst = await purge('code', 'shared blob first owner expired', 2_002)
  assertEqual(sharedFirst.purge.disposition, 'shared_blob_retained', 'shared blob first purge disposition')
  await input.lifecycleApi.verifyPersistedArtifactLifecycle(
    userData,
    input.lifecycleTypes.REQUIRED_ARTIFACT_KINDS
  )
  const sharedLast = await purge('patch', 'shared blob final owner expired', 2_003)
  assertEqual(sharedLast.purge.disposition, 'blob_deleted', 'shared blob final purge disposition')
  const unique = await purge('diff', 'unique blob expired', 2_004)
  assertEqual(unique.purge.disposition, 'blob_deleted', 'unique blob purge disposition')
  check('expired source, shared blob, and final blob retention paths write tombstones')
}

async function verifyPhysicalTamper(input) {
  const reportBlob = path.join(
    userData,
    'artifact-blobs',
    'sha256',
    input.reportV2.lifecycle.digest.slice('sha256:'.length)
  )
  const originalBytes = readFileSync(reportBlob)
  writeFileSync(reportBlob, 'tampered\n', 'utf8')
  await assertRejects(
    input.lifecycleApi.verifyPersistedArtifactLifecycle(userData, input.lifecycleTypes.REQUIRED_ARTIFACT_KINDS),
    /digest mismatch/i,
    'physical Artifact byte tampering must fail closed'
  )
  writeFileSync(reportBlob, originalBytes)
  await input.lifecycleApi.verifyPersistedArtifactLifecycle(
    userData,
    input.lifecycleTypes.REQUIRED_ARTIFACT_KINDS
  )
  check('physical Artifact byte tampering fails closed and restoration verifies')
}

async function runProductionPatchProducer({
  fixture,
  lifecycleApi,
  snapshotApi,
  effectRuntime,
  runtimeRegistry,
  gitTools
}) {
  const repo = path.join(tempRoot, 'production-repo')
  mkdirSync(repo, { recursive: true })
  writeFileSync(path.join(repo, 'artifact.txt'), 'before\n', 'utf8')
  git(repo, ['init'])
  git(repo, ['add', 'artifact.txt'])
  git(repo, ['-c', 'user.name=CaoGen Gate', '-c', 'user.email=gate@caogen.test', 'commit', '-m', 'seed'])
  writeFileSync(path.join(repo, 'artifact.txt'), 'after\n', 'utf8')

  const snapshot = snapshotApi.buildTaskSnapshot({
    meta: {
      id: fixture.run.sessionId,
      title: 'Production Artifact producer',
      cwd: repo,
      projectId: fixture.projectId,
      workspaceId: fixture.projectId,
      goalId: fixture.goalId,
      workItemId: fixture.workItemId,
      childTaskId: fixture.run.taskId,
      model: 'fixture-model',
      providerId: 'fixture-provider',
      permissionMode: 'default',
      status: 'running',
      sdkSessionId: 'sdk-artifact-production',
      costUsd: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      contextTokens: 0,
      createdAt: fixture.run.createdAt
    },
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run: fixture.run,
    now: fixture.run.updatedAt
  })
  const persisted = await snapshotApi.saveTaskSnapshot(snapshot, userData)
  runtimeRegistry.taskRuntimeRegistry.set(fixture.run.sessionId, persisted.run ?? fixture.run)
  const execution = {
    sessionId: fixture.run.sessionId,
    cwd: repo,
    toolUseId: 'artifact-production-patch',
    toolName: 'code_forge_delivery',
    toolInput: { mode: 'patch' }
  }
  const handle = await effectRuntime.prepareEffectExecution(execution)
  assert(handle?.target.kind === 'code_forge_patch', 'production Effect must freeze a Code Forge patch target')
  await effectRuntime.markEffectExecutionStarted(handle, execution)
  const result = await gitTools.executeGitTool('code_forge_delivery', execution.toolInput, repo, {
    sessionId: execution.sessionId,
    effectTarget: handle.target
  })
  assertEqual(result.ok, true, `production Code Forge result: ${result.output}`)
  const effect = await effectRuntime.completeEffectExecution(handle, result)
  assertEqual(effect?.status, 'confirmed', 'production Code Forge Effect status')
  const record = await lifecycleApi.getPersistedArtifactLifecycle(
    `artifact:code-forge-patch:${effect.id}`,
    userData
  )
  assert(record, 'production Code Forge output must have an Artifact lifecycle')
  assertEqual(record.sourceRef, handle.target.artifactPath, 'production Artifact sourceRef')
  assertEqual(record.digest, `sha256:${handle.target.patchSha256}`, 'production Artifact digest')
  return record
}

async function seedCanonicalRun(workspaceApi, workspaceCommands, snapshotApi) {
  const projectId = 'project-a'
  const goalId = 'goal-a'
  const workItemId = 'work-item-a'
  const runId = 'run-a'
  const workspace = new workspaceApi.ProjectWorkspaceStore(userData)
  await workspace.open()
  await workspace.createWorkspace({ id: projectId, name: 'Artifact Project', kind: 'software', resources: [] })
  await workspace.createWorkspace({ id: 'project-b', name: 'Foreign Project', kind: 'software', resources: [] })
  const commands = workspaceCommands.createProjectWorkspaceCommandService(workspace, { rootDir: userData })
  await commands.reconcileShadowProjection()
  const goal = await commands.createGoal({
    id: goalId,
    projectId,
    title: 'Artifact Goal',
    objective: 'Prove Artifact lifecycle'
  })
  let workItem = await commands.createWorkItem({
    id: workItemId,
    projectId,
    goalId,
    title: 'Create versioned Artifacts',
    type: 'documentation'
  })
  const run = {
    schemaVersion: 1,
    id: runId,
    sessionId: 'session-a',
    taskId: 'task-a',
    status: 'completed',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: 900,
    updatedAt: 901,
    steps: [],
    toolExecutions: [],
    effects: []
  }
  await snapshotApi.saveTaskSnapshot(snapshotApi.buildTaskSnapshot({
    meta: {
      id: run.sessionId,
      title: 'Artifact lifecycle fixture',
      cwd: tempRoot,
      projectId,
      workspaceId: projectId,
      goalId,
      workItemId,
      childTaskId: run.taskId,
      model: 'fixture-model',
      providerId: 'fixture-provider',
      permissionMode: 'default',
      status: 'running',
      sdkSessionId: 'sdk-artifact-fixture',
      costUsd: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      contextTokens: 0,
      createdAt: run.createdAt
    },
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run,
    now: run.updatedAt
  }), userData)
  const current = await workspace.getWorkItem(workItem.id)
  if (!current) throw new Error(`Artifact fixture WorkItem disappeared:${workItem.id}`)
  if (!current.runRefs.includes(runId)) {
    workItem = await commands.updateWorkItem(current.id, {
      runRefs: [...current.runRefs, runId]
    }, { expectedRevision: current.revision })
  } else {
    workItem = current
  }
  return { projectId, goalId, workItemId, runId, run }
}

function registrationForKind(kind, index, fixture, sourcePath, contentApi) {
  const sharedBytes = Buffer.from('shared code and patch bytes\n')
  const bytes = kind === 'code' || kind === 'patch'
    ? sharedBytes
    : Buffer.from(`${kind} artifact bytes\n`)
  const content = kind === 'source'
    ? { storageKind: 'source_ref', sourceRef: sourcePath }
    : { storageKind: 'blob', bytes, expectedDigest: contentApi.contentDigest(bytes) }
  const expires = kind === 'source' || kind === 'code' || kind === 'patch' || kind === 'diff'
  return {
    id: kind === 'report' ? 'artifact-report-v1' : `artifact-${kind.replaceAll('_', '-')}`,
    projectId: fixture.projectId,
    goalId: fixture.goalId,
    workItemId: fixture.workItemId,
    runId: fixture.runId,
    lineageId: `lineage-${kind}`,
    kind,
    title: `${kind} Artifact`,
    version: 1,
    provenance: 'explicit',
    mediaType: kind === 'source' || kind === 'code' ? 'text/plain' : 'application/octet-stream',
    retention: expires ? { mode: 'expire', retainUntil: 1_500 } : { mode: 'retain' },
    content,
    metadata: { gate: 'artifact-lifecycle' },
    createdAt: 1_000 + index
  }
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/task/artifact-lifecycle-api.ts',
    'src/main/task/effect-runtime.ts',
    'src/main/agent/tools/git-tools.ts',
    'src/main/project-workspace/index.ts',
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

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), `export const app = { getPath: () => ${JSON.stringify(userData)} }\n`)
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

async function importCompiled(suffix) {
  const file = findCompiled(outDir, suffix)
  if (!file) throw new Error(`compiled module not found: ${suffix}`)
  return import(pathToFileURL(file).href)
}

function findCompiled(root, suffix) {
  const target = suffix.split('/').join(path.sep)
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of require('node:fs').readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(fullPath)
      else if (entry.isFile() && fullPath.endsWith(target)) return fullPath
    }
  }
  return null
}

async function assertRejects(promise, pattern, message) {
  try {
    await promise
  } catch (error) {
    const rendered = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    if (pattern.test(rendered)) return
    throw new Error(`${message}: unexpected error ${rendered}`)
  }
  throw new Error(`${message}: operation unexpectedly succeeded`)
}

function check(name) {
  report.checks.push(name)
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function gitOutput(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}
