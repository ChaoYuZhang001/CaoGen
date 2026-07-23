import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
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
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-project-ownership-'))
const outDir = path.join(tempRoot, 'compiled')
const stateRoot = path.join(tempRoot, 'state')
const roots = aggregateRoots(stateRoot)
const reportDir = path.join(repoRoot, 'test-results', 'project-ownership', timestamp())
const latestReportPath = path.join(repoRoot, 'test-results', 'project-ownership', 'latest.json')
const credentialCanary = 'SYNTHETIC_PROJECT_OWNERSHIP_CREDENTIAL_CANARY'
let report

try {
  assertProductionMutationIngressCutover()
  compileSources()
  installElectronStub()
  const aggregateApi = await importCompiled('main/project-aggregate/index.js')
  const aggregateCodec = await importCompiled('main/project-aggregate/codec.js')
  const memoryStore = await importCompiled('main/memoryStore.js')
  const workspaceApi = await importCompiled('main/project-workspace/index.js')
  const workflowApi = await importCompiled('main/task/workflow-ledger-api.js')
  const snapshotApi = await importCompiled('main/task/task-snapshot.js')
  const workflowStore = await importCompiled('main/task/workflow-ledger-store.js')
  const workerApi = await importCompiled('main/digital-worker/index.js')
  const learningApi = await importCompiled('main/learning/learning-lifecycle.js')
  await assertSharedReferenceCredentialInspection(aggregateCodec)

  const workspaceStore = new workspaceApi.ProjectWorkspaceStore(roots.workspaceRoot)
  await workspaceStore.open()
  const workerStore = new workerApi.DigitalWorkerStore(roots.digitalWorkerRoot)
  const role = await workerStore.createRoleTemplate({
    id: 'role-global-project-ownership',
    name: 'Global role must not be embedded',
    purpose: 'Prove RoleTemplate remains global rather than Project-owned',
    instructions: 'Global role instructions must not be copied into an aggregate.'
  })

  const fixtures = []
  for (const suffix of ['alpha', 'bravo']) {
    fixtures.push(await seedProject({
      suffix,
      workspaceStore,
      workerStore,
      role,
      aggregateApi,
      workflowApi,
      snapshotApi,
      workflowStore,
      learningApi,
      memoryStore
    }))
  }
  const [alpha, bravo] = fixtures
  const service = new aggregateApi.ProjectAggregateService(roots)
  const competingService = new aggregateApi.ProjectAggregateService(roots)
  const initialSealOutcomes = await Promise.allSettled([
    service.sealProject(alpha.project.id, { now: 10_000 }),
    competingService.sealProject(alpha.project.id, { now: 10_000 })
  ])
  assertEqual(
    initialSealOutcomes.filter((outcome) => outcome.status === 'fulfilled').length,
    1,
    'concurrent first seal has exactly one winner'
  )
  assert(
    initialSealOutcomes.some((outcome) =>
      outcome.status === 'rejected' && outcome.reason?.code === 'REVISION_CONFLICT'
    ),
    'concurrent first seal loser receives a revision conflict'
  )
  const alphaSeal0 = initialSealOutcomes.find((outcome) => outcome.status === 'fulfilled').value
  const bravoSeal = await service.sealProject(bravo.project.id, { now: 10_001 })
  assertEqual(alphaSeal0.aggregateRevision, 1, 'first Project seal revision')
  assertEqual(bravoSeal.aggregateRevision, 1, 'second Project seal revision')

  const alphaZero = await service.queryProject(alpha.project.id)
  const bravoZero = await service.queryProject(bravo.project.id)
  assertEqual(alphaZero.resources.length, 0, 'alpha starts without a directory or Resource')
  assertEqual(bravoZero.resources.length, 0, 'bravo starts without a directory or Resource')
  assertCompleteDomain(alphaZero)
  assertCompleteDomain(bravoZero)
  assert(Number.isSafeInteger(alphaZero.leases[0].fencingToken), 'lease fencing token remains typed aggregate data')
  assert(
    alphaZero.memory.some((memory) => memory.namespace === 'legacy_path'),
    'legacy path-root Memory is included through explicit compatibility mapping'
  )
  const identityDigest = alphaZero.identityDigest

  await assertRejects(
    service.sealProject(alpha.project.id),
    (error) => error?.code === 'REVISION_CONFLICT',
    'reseal without aggregate CAS must fail closed'
  )

  const alphaWithOne = await workspaceStore.updateWorkspace(alpha.project.id, {
    resources: [{ id: 'resource-alpha-one', kind: 'connector', uri: 'connector://alpha' }]
  }, alpha.project.revision)
  await assertRejects(
    service.queryProject(alpha.project.id),
    (error) => error?.code === 'AGGREGATE_INTEGRITY_FAILED',
    'a domain mutation must make the old aggregate seal fail closed'
  )
  const alphaSeal1 = await service.sealProject(alpha.project.id, {
    expectedAggregateRevision: alphaSeal0.aggregateRevision,
    now: 10_002
  })
  const oneResource = await service.queryProject(alpha.project.id)
  assertEqual(oneResource.resources.length, 1, 'one Resource is included')
  assertEqual(oneResource.identityDigest, identityDigest, 'one Resource does not change Project identity')

  const alphaWithMany = await workspaceStore.updateWorkspace(alpha.project.id, {
    resources: [
      { id: 'resource-alpha-one', kind: 'connector', uri: 'connector://alpha' },
      { id: 'resource-alpha-two', kind: 'url', uri: 'https://example.test/alpha' },
      { id: 'resource-alpha-three', kind: 'knowledge_base', uri: 'kb://alpha' }
    ]
  }, alphaWithOne.revision)
  await assertRejects(
    service.sealProject(alpha.project.id, {
      expectedAggregateRevision: alphaSeal0.aggregateRevision,
      now: 10_003
    }),
    (error) => error?.code === 'REVISION_CONFLICT',
    'stale aggregate CAS must fail closed'
  )
  const alphaSeal2 = await service.sealProject(alpha.project.id, {
    expectedAggregateRevision: alphaSeal1.aggregateRevision,
    now: 10_004
  })
  const alphaMany = await service.queryProject(alpha.project.id, {
    expectedAggregateRevision: alphaSeal2.aggregateRevision,
    expectedAggregateDigest: alphaSeal2.aggregateDigest
  })
  assertEqual(alphaMany.resources.length, 3, 'multiple Resources are included')
  assertEqual(alphaMany.identityDigest, identityDigest, 'multiple Resources do not change Project identity')
  assertEqual(alphaMany.projectRevision, alphaWithMany.revision, 'aggregate binds the current Project revision')

  const productionRoots = aggregateApi.projectAggregateRootsForUserData(path.join(stateRoot, 'production-root-check'))
  assertEqual(productionRoots.workspaceRoot, productionRoots.workflowRoot, 'production factory shares userData ownership root')
  assertEqual(productionRoots.workspaceRoot, productionRoots.digitalWorkerRoot, 'production factory shares worker ownership root')
  assertEqual(productionRoots.learningRoot, path.join(productionRoots.workspaceRoot, 'learning'), 'production Learning root')
  await assertProjectIdMemoryCutover(memoryStore, aggregateApi, alpha)

  await assertRealMutationIngressRejects({
    workspaceStore,
    workerStore,
    workflowApi,
    snapshotApi,
    workflowStore,
    alpha,
    bravo
  })

  const beforeRejectedReferences = digestTree(stateRoot)
  const foreignReferences = requiredForeignReferences(bravoZero)
  for (const reference of foreignReferences) {
    await assertRejects(
      service.authorizeReferences(alpha.project.id, [reference]),
      (error) => error?.code === 'PROJECT_SCOPE_CONFLICT',
      `cross-Project ${reference.kind} reference must fail closed`
    )
  }
  assertEqual(
    digestTree(stateRoot),
    beforeRejectedReferences,
    'all durable store digests remain unchanged after every rejected cross-Project reference'
  )

  const ownGrant = await service.authorizeReferences(alpha.project.id, [
    { kind: 'project', id: alpha.project.id },
    { kind: 'goal', id: alpha.goal.id },
    { kind: 'work_item', id: alpha.workItem.id },
    { kind: 'digital_worker', id: alpha.worker.id },
    { kind: 'assignment', id: alpha.assignment.id },
    { kind: 'run', id: alpha.run.id },
    { kind: 'artifact', id: alpha.artifact.id },
    { kind: 'evidence', id: alpha.evidence.evidenceId },
    { kind: 'acceptance', id: alpha.acceptance.id },
    { kind: 'memory', id: alpha.memory.id }
  ])
  assertEqual(ownGrant.references.length, 10, 'same-Project ownership authorization succeeds')
  const liveGrant = await service.authorizeLiveReferences(alpha.project.id, [
    { kind: 'project', id: alpha.project.id },
    { kind: 'work_item', id: alpha.workItem.id },
    { kind: 'digital_worker', id: alpha.worker.id },
    { kind: 'artifact', id: alpha.artifact.id },
    { kind: 'memory', id: alpha.memory.id }
  ])
  assertEqual(liveGrant.references.length, 5, 'production mutation boundary authorizes live Project references')

  const firstExport = await service.exportProject(alpha.project.id)
  const secondExport = await service.exportProject(alpha.project.id)
  assertEqual(firstExport.exportDigest, secondExport.exportDigest, 'aggregate export is deterministic')
  assertEqual(firstExport.json, secondExport.json, 'aggregate JSON is deterministic')
  for (const foreignId of [
    bravo.project.id,
    bravo.goal.id,
    bravo.workItem.id,
    bravo.worker.id,
    bravo.assignment.id,
    bravo.run.id,
    bravo.artifact.id,
    bravo.evidence.evidenceId,
    bravo.acceptance.id,
    bravo.memory.id
  ]) {
    assert(!firstExport.json.includes(foreignId), `aggregate export excludes foreign object ${foreignId}`)
  }
  assert(!firstExport.json.includes('Global role must not be embedded'), 'aggregate export excludes global RoleTemplate bodies')
  assert(!firstExport.json.includes(credentialCanary), 'aggregate export excludes credential values')
  assert(firstExport.json.includes('[REDACTED]'), 'aggregate export marks excluded credential fields')
  assertDigest(firstExport.exportDigest, 'export digest')
  assertDigest(alphaMany.aggregateDigest, 'aggregate digest')
  assertDigest(alphaMany.identityDigest, 'identity digest')
  assertObjectDigests(alphaMany)

  const restarted = new aggregateApi.ProjectAggregateService(roots)
  const afterRestart = await restarted.queryProject(alpha.project.id)
  assertEqual(afterRestart.aggregateDigest, alphaMany.aggregateDigest, 'aggregate survives service restart')
  assertEqual(
    (await restarted.exportProject(alpha.project.id)).exportDigest,
    firstExport.exportDigest,
    'export survives service restart'
  )

  await proveMissingObjectFailsClosed(aggregateApi, roots, alpha, afterRestart)
  await proveOwnershipTamperFailsClosed(aggregateApi, roots, alpha)
  await proveSealTamperFailsClosed(aggregateApi, roots, alpha)
  await proveTornSnapshotFailsClosed(aggregateApi, workspaceApi, alpha, alphaSeal2.aggregateRevision)

  report = {
    status: 'pass',
    criterion: 'PROJ-003',
    checks: [
      'two-directory-free-projects',
      'all-domain-project-ownership',
      'cross-project-reference-rejection-by-domain',
      'rejected-write-store-digests-unchanged',
      'closed-aggregate-query-and-export',
      'global-role-template-not-embedded',
      'credential-value-exclusion',
      'schema-object-aggregate-digests',
      'aggregate-seal-cas',
      'concurrent-initial-seal-single-winner',
      'double-collect-and-post-seal-stability',
      'real-domain-mutation-cross-project-rejection',
      'production-user-data-root-factory',
      'memory-ipc-project-id-cutover',
      'memory-identity-survives-path-change',
      'project-workspace-production-mutation-ingress',
      'digital-worker-production-mutation-ingress',
      'workflow-ledger-production-mutation-ingress',
      'memory-production-mutation-ingress',
      'live-aggregate-mutation-authorization',
      'restart-persistence',
      'missing-object-fail-closed',
      'ownership-tamper-fail-closed',
      'seal-tamper-fail-closed',
      'torn-snapshot-failure-injection',
      'zero-one-many-resource-identity-stability',
      'legacy-path-learning-namespace-compatibility'
    ],
    projectIds: [alpha.project.id, bravo.project.id],
    aggregateRevision: alphaSeal2.aggregateRevision,
    aggregateDigest: alphaMany.aggregateDigest,
    identityDigest: alphaMany.identityDigest,
    exportDigest: firstExport.exportDigest,
    objectCounts: alphaMany.objectCounts,
    crossProjectKinds: foreignReferences.map((reference) => reference.kind),
    scope: {
      proved: 'sealed aggregate plus current renderer production mutation ingress and Project-ID Memory cutover',
      notProved: [],
      acceptanceRecommendation: 'current_verified_on_dirty_worktree'
    }
  }
  writeReport(report)
  assertEqual(
    readFileSync(path.join(reportDir, 'report.json'), 'utf8'),
    readFileSync(latestReportPath, 'utf8'),
    'timestamped report and latest.json are byte-identical'
  )
  console.log(JSON.stringify({ ...report, reportPath: path.join(reportDir, 'report.json') }, null, 2))
} catch (error) {
  report = {
    status: 'fail',
    criterion: 'PROJ-003',
    error: error instanceof Error ? error.stack ?? error.message : String(error)
  }
  writeReport(report)
  throw error
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

async function seedProject(deps) {
  const workspace = await seedWorkspaceFixture(deps)
  const workflow = await seedWorkflowFixture(deps, workspace)
  const worker = await seedWorkerFixture(deps, workspace)
  const memory = await seedMemoryFixture(deps, workspace)
  return { ...workspace, ...workflow, ...worker, ...memory }
}

async function seedWorkspaceFixture({ suffix, workspaceStore }) {
  const projectId = `project-${suffix}`
  const goalId = `goal-${suffix}`
  const workItemId = `work-item-${suffix}`
  const runId = `run-${suffix}`
  const artifactId = `artifact-${suffix}`
  const base = suffix === 'alpha' ? 1_000 : 2_000
  const project = await workspaceStore.createWorkspace({
    id: projectId,
    name: `Directory-free ${suffix}`,
    kind: 'research',
    resources: [],
    budgetPolicy: { monthlyUsd: 25, apiKey: credentialCanary },
    permissionPolicy: { classification: 'project-internal', accessToken: credentialCanary },
    retentionPolicy: { auditDays: 90 },
    rulesRef: `rules:${suffix}`,
    createdAt: base,
    updatedAt: base
  })
  const goal = await workspaceStore.createGoal({
    id: goalId,
    projectId,
    title: `Goal ${suffix}`,
    objective: `Close aggregate ${suffix}`,
    budget: { amount: 10, currency: 'USD', maxRuns: 2 },
    acceptance: [{ id: `criterion-${suffix}`, criterion: 'Aggregate is closed' }],
    createdAt: base + 1,
    updatedAt: base + 1
  })
  const workItem = await workspaceStore.createWorkItem({
    id: workItemId,
    projectId,
    goalId,
    title: `WorkItem ${suffix}`,
    type: 'testing',
    runRefs: [runId],
    artifactRefs: [artifactId],
    acceptanceSpec: [{ id: `criterion-${suffix}`, criterion: 'Aggregate is closed' }],
    createdAt: base + 2,
    updatedAt: base + 2
  })
  return { suffix, projectId, runId, artifactId, base, project, goal, workItem }
}

async function seedWorkflowFixture({ workflowApi, snapshotApi, workflowStore }, fixture) {
  const { suffix, projectId, runId, artifactId, base, goal, workItem } = fixture
  await workflowApi.createWorkflowGoal({
    id: goal.id,
    projectId,
    title: goal.title,
    objective: goal.objective,
    status: goal.status,
    revision: goal.revision,
    source: 'explicit',
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt
  }, roots.workflowRoot)
  await workflowApi.createWorkflowWorkItem({
    id: workItem.id,
    projectId,
    goalId: goal.id,
    type: workItem.type,
    title: workItem.title,
    status: workItem.status,
    revision: workItem.revision,
    source: 'explicit',
    runIds: [runId],
    currentRunId: runId,
    createdAt: workItem.createdAt,
    updatedAt: workItem.updatedAt
  }, roots.workflowRoot)

  const run = taskRunFixture(suffix, base + 3)
  await snapshotApi.mutateTaskSnapshotDatabase(roots.workflowRoot, (db) => {
    workflowStore.setupWorkflowLedgerSchema(db)
    workflowStore.projectTaskRun(db, run, {
      projectId,
      goalId: goal.id,
      workItemId: workItem.id,
      source: 'explicit',
      canonicalSourceAuthority: true
    })
  })
  const artifact = await workflowApi.createWorkflowArtifact({
    id: artifactId,
    projectId,
    goalId: goal.id,
    workItemId: workItem.id,
    runId: run.id,
    kind: 'test_report',
    title: `Artifact ${suffix}`,
    digest: 'a'.repeat(64),
    metadata: { classification: 'project-internal' },
    createdAt: base + 4,
    updatedAt: base + 4
  }, roots.workflowRoot)
  await workflowApi.createWorkflowArtifactLocation({
    id: `artifact-location-${suffix}`,
    artifactId: artifact.id,
    projectId,
    goalId: goal.id,
    workItemId: workItem.id,
    runId: run.id,
    kind: 'external',
    uri: `https://example.test/${suffix}`,
    availability: 'available',
    createdAt: base + 5,
    updatedAt: base + 5
  }, roots.workflowRoot)
  const acceptance = await workflowApi.saveWorkflowAcceptance({
    id: `acceptance-${suffix}`,
    projectId,
    goalId: goal.id,
    workItemId: workItem.id,
    criteria: ['Aggregate is closed'],
    status: 'pending',
    evidenceRefs: [],
    revision: 1,
    createdAt: base + 6,
    updatedAt: base + 6
  }, roots.workflowRoot)
  const evidence = await workflowApi.createWorkflowEvidence({
    evidenceId: `evidence-${suffix}`,
    projectId,
    goalId: goal.id,
    workItemId: workItem.id,
    runId: run.id,
    artifactId: artifact.id,
    kind: 'test_result',
    title: `Evidence ${suffix}`,
    summary: 'Aggregate smoke evidence',
    contentDigest: 'a'.repeat(64),
    metadata: { classification: 'project-internal' }
  }, roots.workflowRoot, {
    source: 'runtime',
    verifier: 'project-ownership-smoke',
    observedAt: base + 7
  })
  await workflowApi.createWorkflowEvidenceLink({
    id: `evidence-link-${suffix}`,
    evidenceId: evidence.evidenceId,
    evidenceOrigin: 'workflow',
    projectId,
    runId: run.id,
    artifactId: artifact.id,
    acceptanceId: acceptance.id,
    relation: 'supports',
    createdAt: base + 8
  }, roots.workflowRoot)
  return { run, artifact, acceptance, evidence }
}

async function seedWorkerFixture({ suffix, workerStore, role }, fixture) {
  const { projectId, base, workItem } = fixture
  const proposed = await workerStore.createDigitalWorker({
    id: `worker-${suffix}`,
    projectId,
    roleTemplateId: role.id,
    displayName: `Worker ${suffix}`,
    memoryNamespace: `project:${projectId}:worker:${suffix}`,
    toolPolicy: { allowedTools: ['search'], clientSecret: credentialCanary },
    budgetPolicy: { maxUsd: 10 },
    concurrencyLimit: 1,
    createdAt: base + 9,
    updatedAt: base + 9
  })
  const worker = await workerStore.activateDigitalWorker(proposed.id, {
    expectedRevision: proposed.revision,
    now: base + 10
  })
  const assignment = await workerStore.createAssignment({
    id: `assignment-${suffix}`,
    projectId,
    workItemId: workItem.id,
    assigneeKind: 'digital_worker',
    assigneeId: worker.id,
    assignedBy: `owner-${suffix}`,
    assignedAt: base + 11
  })
  await workerStore.acquireLease({
    projectId,
    workItemId: workItem.id,
    workerId: worker.id,
    assignmentId: assignment.id,
    ttlMs: 60_000,
    now: base + 12
  })
  return { worker, assignment }
}

async function seedMemoryFixture({ suffix, learningApi, memoryStore }, fixture) {
  const { projectId } = fixture
  const memoryProjectRoot = path.join(stateRoot, `session-root-${suffix}`)
  const memory = await memoryStore.proposeMemoryDraft({ projectRoot: memoryProjectRoot, projectId }, path.join(stateRoot, 'memory'), {
    kind: 'decision',
    title: `Memory ${suffix}`,
    body: `Project ${suffix} owns this memory without a directory`,
    source: 'project-ownership-smoke',
    reason: 'PROJ-003 acceptance'
  }, {
    confidence: 0.9,
    actor: { type: 'runtime', id: 'project-ownership-smoke', source: 'required-gate' }
  })
  if (suffix === 'alpha') {
    await learningApi.createLearningDraft(
      roots.legacyLearningRoots[projectId][0],
      roots.learningRoot,
      {
        kind: 'memory',
        source: 'legacy-path-fixture',
        confidence: 0.8,
        payload: {
          type: 'memory',
          memoryKind: 'compatibility',
          title: 'Legacy path-root Memory',
          body: 'This record proves explicit legacy namespace compatibility.',
          reason: 'PROJ-003 migration compatibility'
        }
      },
      {
        requestedId: 'memory-alpha-legacy',
        requestedLogicalId: 'memory-logical-alpha-legacy',
        actor: { type: 'system', id: 'legacy-fixture', source: 'required-gate' }
      }
    )
  }
  return { memory, memoryProjectRoot }
}

async function assertProjectIdMemoryCutover(memoryStore, aggregateApi, fixture) {
  const movedProjectRoot = path.join(stateRoot, 'moved-session-root-alpha')
  const memoryRoot = path.join(stateRoot, 'memory')
  const byProjectId = await memoryStore.readProjectMemory({
    projectRoot: movedProjectRoot,
    projectId: fixture.project.id
  }, memoryRoot)
  assertEqual(
    byProjectId.projectHash,
    aggregateApi.projectLearningNamespaceDigest(fixture.project.id),
    'Memory IPC target resolves the canonical ProjectWorkspace identity'
  )
  assert(
    byProjectId.drafts.some((draft) => draft.id === fixture.memory.id),
    'Project-ID Memory remains visible after the session path changes'
  )
  const pathOnly = await memoryStore.readProjectMemory(movedProjectRoot, memoryRoot)
  assert(
    !pathOnly.drafts.some((draft) => draft.id === fixture.memory.id),
    'legacy path identity cannot impersonate the canonical ProjectWorkspace namespace'
  )
}

function assertProductionMutationIngressCutover() {
  const workspace = sourceText('src/main/ipc/project-workspace-handlers.ts')
  const worker = sourceText('src/main/ipc/digital-worker-handlers.ts')
  const workerMutation = sourceText('src/main/ipc/digital-worker-project-mutation.ts')
  const workflow = sourceText('src/main/ipc/workflow-ledger-handlers.ts')
  const memory = sourceText('src/main/ipc/memory-handlers.ts')
  const service = sourceText('src/main/project-aggregate/project-aggregate-service.ts')
  assert(workspace.includes('PROJECT_WORKSPACE_MUTATIONS') && workspace.includes('verifyProjectWorkspaceMutation('),
    'ProjectWorkspace production writes must traverse the aggregate mutation boundary')
  assert(workerMutation.includes('PROJECT_OWNED_ACTIONS') && workerMutation.includes('verifyDigitalWorkerMutation(') &&
    worker.includes("from './digital-worker-project-mutation'") && worker.includes('await verifyDigitalWorkerMutation('),
    'DigitalWorker production writes must traverse the aggregate mutation boundary')
  for (const writer of [
    'createWorkflowArtifact(', 'createWorkflowArtifactEdge(', 'createWorkflowArtifactLocation(',
    'createWorkflowEvidence(', 'saveWorkflowAcceptance(', 'reviewWorkflowAcceptance(',
    'createWorkflowEvidenceLink('
  ]) {
    const start = workflow.indexOf(writer)
    assert(start >= 0 && workflow.slice(Math.max(0, start - 80), start).includes('verifyWorkflowMutation('),
      `Workflow writer ${writer} must traverse the aggregate mutation boundary`)
  }
  for (const channel of ['memory:propose', 'memory:accept', 'memory:delete']) {
    const start = memory.indexOf(channel)
    assert(start >= 0 && memory.slice(start, start + 400).includes('verifiedMemoryMutation('),
      `${channel} must traverse the aggregate mutation boundary`)
  }
  assert(service.includes('async verifyLiveProject(') && service.includes('async authorizeLiveReferences('),
    'ProjectAggregateService must expose the live production mutation boundary')
}

function sourceText(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

async function assertSharedReferenceCredentialInspection(codec) {
  let reads = 0
  const shared = {}
  Object.defineProperty(shared, 'value', {
    enumerable: true,
    get() {
      reads += 1
      return reads === 1 ? 'safe fixture value' : 'Bearer SYNTHETIC_PROJECT_OWNERSHIP_CREDENTIAL'
    }
  })
  await assertRejects(
    Promise.resolve().then(() => codec.assertNoCredentialMaterial({ first: shared, second: shared })),
    (error) => /unredacted credential material/i.test(String(error?.message)),
    'credential inspection must revisit a shared object outside the active recursion stack'
  )
}

async function assertRealMutationIngressRejects(deps) {
  const { workspaceStore, workerStore, workflowApi, snapshotApi, workflowStore, alpha, bravo } = deps
  const before = digestTree(stateRoot)
  const attempts = [
    workspaceStore.createWorkItem({
      id: 'forged-cross-project-work-item',
      projectId: alpha.project.id,
      goalId: bravo.goal.id,
      title: 'Must reject foreign Goal'
    }),
    workerStore.createAssignment({
      id: 'forged-cross-project-assignment',
      projectId: alpha.project.id,
      workItemId: alpha.workItem.id,
      assigneeKind: 'digital_worker',
      assigneeId: bravo.worker.id,
      assignedBy: 'project-ownership-smoke'
    }),
    workerStore.acquireLease({
      projectId: alpha.project.id,
      workItemId: alpha.workItem.id,
      workerId: bravo.worker.id,
      assignmentId: bravo.assignment.id,
      now: 20_000
    }),
    workflowApi.createWorkflowArtifact({
      id: 'forged-cross-project-artifact',
      projectId: alpha.project.id,
      runId: bravo.run.id,
      kind: 'report',
      title: 'Must reject foreign Run',
      digest: 'b'.repeat(64)
    }, roots.workflowRoot),
    workflowApi.createWorkflowEvidence({
      evidenceId: 'forged-cross-project-evidence',
      projectId: alpha.project.id,
      artifactId: bravo.artifact.id,
      kind: 'test_result',
      title: 'Must reject foreign Artifact',
      contentDigest: 'b'.repeat(64)
    }, roots.workflowRoot),
    workflowApi.saveWorkflowAcceptance({
      id: 'forged-cross-project-acceptance',
      projectId: alpha.project.id,
      goalId: bravo.goal.id,
      criteria: ['Must reject foreign Goal'],
      status: 'pending'
    }, roots.workflowRoot),
    workflowApi.createWorkflowEvidenceLink({
      id: 'forged-cross-project-evidence-link',
      evidenceId: bravo.evidence.evidenceId,
      evidenceOrigin: 'workflow',
      projectId: alpha.project.id,
      acceptanceId: alpha.acceptance.id,
      relation: 'supports'
    }, roots.workflowRoot),
    workflowApi.createWorkflowArtifactEdge({
      id: 'forged-cross-project-artifact-edge',
      fromArtifactId: alpha.artifact.id,
      toArtifactId: bravo.artifact.id,
      projectId: alpha.project.id,
      relation: 'related_to'
    }, roots.workflowRoot),
    workflowApi.createWorkflowArtifactLocation({
      id: 'forged-cross-project-artifact-location',
      artifactId: bravo.artifact.id,
      projectId: alpha.project.id,
      kind: 'external',
      uri: 'https://example.test/forged'
    }, roots.workflowRoot),
    snapshotApi.mutateTaskSnapshotDatabase(roots.workflowRoot, (db) => {
      workflowStore.setupWorkflowLedgerSchema(db)
      return workflowStore.projectTaskRun(db, taskRunFixture('forged-cross-project', 30_000), {
        projectId: alpha.project.id,
        goalId: bravo.goal.id,
        workItemId: bravo.workItem.id,
        source: 'explicit',
        canonicalSourceAuthority: true
      })
    })
  ]
  const outcomes = await Promise.allSettled(attempts)
  assertEqual(outcomes.length, 10, 'real cross-Project mutation attempt count')
  for (const outcome of outcomes) {
    assert(outcome.status === 'rejected', 'every real cross-Project mutation must reject')
    assert(crossProjectError(outcome.reason), `unexpected cross-Project rejection: ${String(outcome.reason)}`)
  }
  assertEqual(digestTree(stateRoot), before, 'real cross-Project mutation rejection leaves every store unchanged')
}

function crossProjectError(error) {
  const code = String(error?.code ?? '')
  const message = String(error?.message ?? error)
  return /(?:PROJECT|SCOPE|CROSS|WORKFLOW|CONFLICT|CORRUPT)/i.test(code) ||
    /(?:project|scope|ownership|boundary|foreign)/i.test(message)
}

function taskRunFixture(suffix, now) {
  return {
    schemaVersion: 1,
    id: `run-${suffix}`,
    sessionId: `session-${suffix}`,
    taskId: `task-${suffix}`,
    status: 'failed',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: now,
    updatedAt: now + 1,
    error: 'fixture terminal Run',
    steps: [],
    toolExecutions: [],
    effects: []
  }
}

function assertCompleteDomain(aggregate) {
  for (const kind of [
    'project', 'goal', 'work_item', 'digital_worker', 'assignment', 'lease', 'run',
    'artifact', 'artifact_location', 'evidence', 'evidence_link', 'acceptance',
    'memory', 'budget', 'policy', 'audit'
  ]) {
    assert(aggregate.objectCounts[kind] > 0, `Project aggregate must contain ${kind}`)
  }
  assertEqual(aggregate.objectCounts.resource, 0, 'directory-free Project starts with zero Resources')
}

function requiredForeignReferences(aggregate) {
  const firstId = (kind) => Object.keys(aggregate.objectDigests[kind]).sort()[0]
  return [
    'project', 'goal', 'work_item', 'digital_worker', 'assignment', 'run', 'artifact',
    'evidence', 'acceptance', 'memory', 'budget', 'policy', 'audit'
  ].map((kind) => ({ kind, id: firstId(kind) }))
}

async function proveMissingObjectFailsClosed(aggregateApi, sourceRoots, fixture, baseline) {
  const scenario = copyScenario('missing-memory')
  const scenarioRoots = aggregateRoots(scenario)
  const memoryDigest = baseline.memory.find((entry) => entry.id === fixture.memory.id).namespaceDigest
  const memoryPath = path.join(scenarioRoots.learningRoot, 'projects', memoryDigest, 'learning.json')
  const state = JSON.parse(readFileSync(memoryPath, 'utf8'))
  state.records = state.records.filter((record) => record.id !== fixture.memory.id)
  state.audit = state.audit.filter((event) => event.recordId !== fixture.memory.id)
  writeFileSync(memoryPath, `${JSON.stringify(state, null, 2)}\n`)
  await assertRejects(
    new aggregateApi.ProjectAggregateService(scenarioRoots).queryProject(fixture.project.id),
    (error) => error?.code === 'AGGREGATE_INTEGRITY_FAILED',
    'a structurally valid store with a missing standalone Memory must fail its Project seal'
  )
}

async function proveOwnershipTamperFailsClosed(aggregateApi, sourceRoots, fixture) {
  const scenario = copyScenario('tampered-owner')
  const scenarioRoots = aggregateRoots(scenario)
  const workerPath = path.join(scenarioRoots.digitalWorkerRoot, 'digital-workers.json')
  const document = JSON.parse(readFileSync(workerPath, 'utf8'))
  document.workers.find((worker) => worker.id === fixture.worker.id).projectId = 'project-bravo'
  writeFileSync(workerPath, `${JSON.stringify(document, null, 2)}\n`)
  await assertRejects(
    new aggregateApi.ProjectAggregateService(scenarioRoots).queryProject(fixture.project.id),
    (error) => ['AGGREGATE_INTEGRITY_FAILED', 'STORE_CORRUPT', 'PROJECT_SCOPE_CONFLICT'].includes(error?.code),
    'tampered DigitalWorker ownership must fail closed'
  )
}

async function proveSealTamperFailsClosed(aggregateApi, sourceRoots, fixture) {
  const scenario = copyScenario('tampered-seal')
  const scenarioRoots = aggregateRoots(scenario)
  const sealPath = path.join(scenarioRoots.aggregateRoot, 'project-aggregate-seals.json')
  const document = JSON.parse(readFileSync(sealPath, 'utf8'))
  document.projects.find((project) => project.projectId === fixture.project.id).aggregateDigest = '0'.repeat(64)
  writeFileSync(sealPath, `${JSON.stringify(document, null, 2)}\n`)
  await assertRejects(
    new aggregateApi.ProjectAggregateService(scenarioRoots).queryProject(fixture.project.id),
    (error) => error?.code === 'STORE_CORRUPT',
    'tampered aggregate seal must fail closed'
  )
}

async function proveTornSnapshotFailsClosed(aggregateApi, workspaceApi, fixture, aggregateRevision) {
  const scenario = copyScenario('torn-snapshot')
  const scenarioRoots = aggregateRoots(scenario)
  const service = new aggregateApi.ProjectAggregateService(scenarioRoots)
  const originalCollect = service.collectProject.bind(service)
  let reads = 0
  service.collectProject = async (projectId) => {
    const snapshot = await originalCollect(projectId)
    reads += 1
    if (reads === 1) {
      const workspace = new workspaceApi.ProjectWorkspaceStore(scenarioRoots.workspaceRoot)
      await workspace.open()
      const current = await workspace.getWorkspace(projectId)
      await workspace.updateWorkspace(projectId, { name: `${current.name} changed during seal` }, current.revision)
    }
    return snapshot
  }
  await assertRejects(
    service.sealProject(fixture.project.id, {
      expectedAggregateRevision: aggregateRevision,
      now: 40_000
    }),
    (error) => error?.code === 'REVISION_CONFLICT' && /stable read/i.test(String(error?.message)),
    'a mutation between cross-store collections must abort the seal'
  )
  assertEqual(
    service.seals.readProject(fixture.project.id).aggregateRevision,
    aggregateRevision,
    'a torn snapshot does not advance the aggregate seal'
  )
}

function copyScenario(name) {
  const scenario = path.join(tempRoot, name)
  cpSync(stateRoot, scenario, { recursive: true })
  return scenario
}

function aggregateRoots(root) {
  return {
    workspaceRoot: path.join(root, 'workspace'),
    workflowRoot: path.join(root, 'workflow'),
    digitalWorkerRoot: path.join(root, 'digital-worker'),
    learningRoot: path.join(root, 'learning'),
    aggregateRoot: path.join(root, 'aggregate'),
    legacyLearningRoots: {
      'project-alpha': [path.join(root, 'legacy-project-alpha')]
    }
  }
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/shared/project-aggregate-types.ts',
    'src/main/project-aggregate/index.ts',
    'src/main/memoryStore.ts',
    'src/main/project-workspace/index.ts',
    'src/main/digital-worker/index.ts',
    'src/main/task/workflow-ledger-api.ts',
    'src/main/task/task-snapshot.ts',
    'src/main/task/workflow-ledger-store.ts',
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
  writeFileSync(path.join(electronDir, 'index.js'), `export const app = { getPath: () => ${JSON.stringify(stateRoot)} }\n`)
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

function importCompiled(relativePath) {
  return import(pathToFileURL(path.join(outDir, relativePath)).href)
}

function digestTree(root) {
  const hash = createHash('sha256')
  walk(root, root, hash)
  return hash.digest('hex')
}

function walk(root, current, hash) {
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const fullPath = path.join(current, entry.name)
    const relative = path.relative(root, fullPath)
    hash.update(relative)
    if (entry.isDirectory()) walk(root, fullPath, hash)
    else if (entry.isFile()) hash.update(readFileSync(fullPath))
  }
}

function assertObjectDigests(aggregate) {
  for (const [kind, count] of Object.entries(aggregate.objectCounts)) {
    const digests = Object.values(aggregate.objectDigests[kind])
    assertEqual(digests.length, count, `${kind} object digest count`)
    for (const digest of digests) assertDigest(digest, `${kind} object digest`)
  }
}

function writeReport(value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`
  atomicWriteReport(path.join(reportDir, 'report.json'), payload)
  atomicWriteReport(latestReportPath, payload)
}

function atomicWriteReport(filePath, payload) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  renameSync(temporary, filePath)
}

function timestamp() {
  return new Date().toISOString().replace(/[:]/g, '-').replace(/\.\d{3}Z$/, 'Z')
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

function assertDigest(value, label) {
  assert(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), `${label} must be SHA-256`)
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
