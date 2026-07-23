import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { assertAcceptanceCriterionPolicies } from './lib/acceptance-criterion-policy-smoke.mjs'
import { assertDeletedEvidenceRowsFailClosed } from './lib/acceptance-evidence-deletion-smoke.mjs'
import { assertRendererCannotSelfAuthorize } from './lib/workflow-renderer-authority-smoke.mjs'
// Compile the main-process modules directly, then exercise both internal gate
// authority and the registered renderer IPC boundary.
const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-acceptance-gate-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
mkdirSync(userData, { recursive: true })

try {
  compileSources()
  installElectronStub()
  const snapshotStore = await import(pathToFileURL(findCompiledModule(outDir, 'task-snapshot.js')).href)
  const rawApi = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-ledger-api.js')).href)
  const guard = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-acceptance-guard.js')).href)
  const digitalWorker = await import(pathToFileURL(
    path.join(outDir, 'main', 'digital-worker', 'domain-store.js')
  ).href)
  const projectStoreApi = await import(pathToFileURL(
    path.join(outDir, 'main', 'project-workspace', 'store.js')
  ).href)
  const projectCommandApi = await import(pathToFileURL(
    path.join(outDir, 'main', 'project-workspace', 'command-service.js')
  ).href)
  const projectStore = new projectStoreApi.ProjectWorkspaceStore(userData)
  await projectStore.open()
  await projectStore.createWorkspace({ id: 'project-a', name: 'Acceptance gate project', kind: 'software' })
  const mirrorWorkItem = async (item) => {
    if (await projectStore.getWorkItem(item.id)) return
    await projectStore.createWorkItem({
      id: item.id,
      projectId: item.projectId,
      ...(item.goalId ? { goalId: item.goalId } : {}),
      ...(item.parentId ? { parentId: item.parentId } : {}),
      type: item.type,
      title: item.title,
      ...(item.description ? { description: item.description } : {}),
      status: ['running', 'done'].includes(item.status) ? 'ready' : item.status,
      runRefs: item.runIds
    })
  }
  const api = {
    ...rawApi,
    createWorkflowWorkItem: async (input, rootDir) => {
      const item = await rawApi.createWorkflowWorkItem(input, rootDir)
      if (rootDir === userData && item.projectId === 'project-a') await mirrorWorkItem(item)
      return item
    },
    createWorkflowGoal: async (input, rootDir) => {
      const goal = await rawApi.createWorkflowGoal(input, rootDir)
      if (rootDir === userData && goal.projectId === 'project-a' && !(await projectStore.getGoal(goal.id))) {
        await projectStore.createGoal({
          id: goal.id,
          projectId: goal.projectId,
          title: goal.title,
          objective: goal.objective,
          status: goal.status
        })
      }
      return goal
    }
  }
  const handlers = await import(pathToFileURL(findCompiledModule(outDir, 'workflow-ledger-handlers.js')).href)
  const electron = await import(pathToFileURL(path.join(outDir, 'node_modules', 'electron', 'index.js')).href)
  handlers.registerWorkflowLedgerIpc()
  process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173/'
  const trustedFrame = { url: process.env.ELECTRON_RENDERER_URL }
  const trustedSender = {
    getURL: () => trustedFrame.url,
    isDestroyed: () => false,
    mainFrame: trustedFrame
  }
  electron.windows.push({ webContents: trustedSender })
  const trustedEvent = {
    sender: trustedSender,
    senderFrame: trustedFrame
  }
  const saveAcceptanceIpc = globalThis.__acceptanceGateHandlers.get('workflowLedger:saveAcceptance')
  const createEvidenceIpc = globalThis.__acceptanceGateHandlers.get('workflowLedger:createEvidence')
  const createEvidenceLinkIpc = globalThis.__acceptanceGateHandlers.get('workflowLedger:createEvidenceLink')
  assert(typeof saveAcceptanceIpc === 'function', 'Acceptance IPC handler must be registered')
  assert(typeof createEvidenceIpc === 'function', 'Evidence IPC handler must be registered')
  assert(typeof createEvidenceLinkIpc === 'function', 'Evidence link IPC handler must be registered')

  await assertRendererCannotSelfAuthorize({
    createEvidenceIpc,
    createEvidenceLinkIpc,
    projectCommandApi,
    projectStoreApi,
    saveAcceptanceIpc,
    trustedEvent,
    userData
  })
  await assertDeletedEvidenceRowsFailClosed({
    api,
    buildMeta,
    buildRun,
    projectCommandApi,
    projectStoreApi,
    snapshotStore,
    tempRoot
  })

  const callerAliases = [
    ['user', 'user'],
    ['human', 'user'],
    ['manual', 'user'],
    ['explicit-user', 'user'],
    ['model', 'model'],
    ['agent', 'model'],
    ['llm', 'model'],
    ['automatic', 'automatic'],
    ['automated', 'automatic'],
    ['system-automatic', 'automatic'],
    ['system', 'system'],
    ['internal', 'system']
  ]
  for (const [alias, expected] of callerAliases) {
    assertEqual(guard.normalizeWorkflowCaller(alias), expected, `caller alias ${alias} must remain stable`)
  }
  assertEqual(
    guard.normalizeWorkflowCaller({ type: { type: ' MANUAL ' } }),
    'user',
    'nested caller objects must remain case-insensitive and whitespace-tolerant'
  )
  assertEqual(guard.normalizeWorkflowCaller(undefined), 'unknown', 'missing caller must remain unknown')

  await api.createWorkflowWorkItem({
    id: 'work-dw-evidence-policy',
    projectId: 'project-a',
    title: 'DigitalWorker evidence policy',
    type: 'testing',
    status: 'running'
  }, userData)
  await api.createWorkflowWorkItem({
    id: 'work-dw-approval-policy',
    projectId: 'project-a',
    title: 'DigitalWorker approval policy',
    type: 'testing',
    status: 'running'
  }, userData)

  // A real TaskRun projection supplies a Run and Task evidence record for the
  // pass/cross-project checks. Other cases deliberately use no Run so a waiver
  // cannot accidentally inherit evidence from another project.
  await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
    meta: buildMeta('session-pass', 'project-a', { childTaskId: 'task-pass' }),
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run: buildRun('run-pass', 'session-pass', 'task-pass', 1, 100)
  }), userData)
  await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
    meta: buildMeta('session-pass-2', 'project-a', { childTaskId: 'task-pass-2' }),
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run: buildRun('run-pass-2', 'session-pass-2', 'task-pass-2', 1, 101)
  }), userData)
  await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
    meta: buildMeta('session-dw-evidence-policy', 'project-a', {
      workspaceId: 'project-a',
      workItemId: 'work-dw-evidence-policy',
      childTaskId: 'task-dw-evidence-policy'
    }),
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run: buildRun('run-dw-evidence-policy', 'session-dw-evidence-policy', 'task-dw-evidence-policy', 1, 102)
  }), userData)
  for (const [suffix, updatedAt] of [['1', 103], ['2', 104]]) {
    const sessionId = `session-dw-approval-policy-${suffix}`
    await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
      meta: buildMeta(sessionId, 'project-a', {
        workspaceId: 'project-a',
        workItemId: 'work-dw-approval-policy',
        childTaskId: `task-dw-approval-policy-${suffix}`
      }),
      transcript: [],
      lastSeq: 0,
      eventCount: 0,
      reason: 'created',
      run: buildRun(`run-dw-approval-policy-${suffix}`, sessionId, `task-dw-approval-policy-${suffix}`, 1, updatedAt)
    }), userData)
  }

  const initial = await api.listPersistedWorkflowLedger({}, userData)
  const passRun = initial.runs.items.find((run) => run.id === 'run-pass')
  const passItem = initial.workItems.items.find((item) => item.id === passRun?.workItemId)
  const originCollisionRun = initial.runs.items.find((run) => run.id === 'run-pass-2')
  const originCollisionItem = initial.workItems.items.find((item) => item.id === originCollisionRun?.workItemId)
  const projectedEvidencePolicyItem = initial.workItems.items.find((item) => item.id === 'work-dw-evidence-policy')
  const projectedApprovalPolicyItem = initial.workItems.items.find((item) => item.id === 'work-dw-approval-policy')
  assert(passItem && passRun && originCollisionItem && originCollisionRun, 'fixture projection must create pass WorkItems and Runs')
  assert(projectedEvidencePolicyItem && projectedApprovalPolicyItem, 'DigitalWorker policy fixtures must project canonical WorkItems')
  await mirrorWorkItem(passItem)
  await mirrorWorkItem(originCollisionItem)
  const evidencePolicyItem = await api.transitionWorkflowWorkItem(
    projectedEvidencePolicyItem.id,
    'verifying',
    projectedEvidencePolicyItem.revision,
    userData
  )
  const approvalPolicyItem = await api.transitionWorkflowWorkItem(
    projectedApprovalPolicyItem.id,
    'verifying',
    projectedApprovalPolicyItem.revision,
    userData
  )

  await assertAcceptanceCriterionPolicies({
    api,
    handlers,
    saveAcceptanceIpc,
    taskEvidence: {
      evidenceId: 'evidence-run-pass',
      runId: passRun.id,
      workItemId: passItem.id
    },
    trustedEvent,
    userData
  })

  const pending = await api.saveWorkflowAcceptance({
    id: 'acceptance-pass',
    projectId: 'project-a',
    workItemId: passItem.id,
    criteria: ['run and artifact are verifiable']
  }, userData)

  // fail: a terminal WorkItem without a passed/waived Acceptance is rejected
  const verifying = await api.transitionWorkflowWorkItem(passItem.id, 'verifying', passItem.revision, userData)
  await expectGate(
    api.transitionWorkflowWorkItem(verifying.id, 'done', verifying.revision, userData),
    'WORKFLOW_ACCEPTANCE_REQUIRED',
    'pending Acceptance must block done'
  )

  // missing-evidence: a passed Acceptance cannot point at a made-up evidence id
  await expectGate(
    api.saveWorkflowAcceptance({
      ...pending,
      status: 'passed',
      evidenceRefs: ['does-not-exist'],
      verifier: 'smoke',
      verifiedAt: 200,
      revision: pending.revision + 1
    }, userData),
    'WORKFLOW_ACCEPTANCE_EVIDENCE_MISSING',
    'missing evidence must fail closed'
  )

  // cross-project: even an existing evidence/Run cannot be linked through a
  // different project or Acceptance owner.
  await expectGate(
    api.createWorkflowEvidenceLink({
      id: 'link-cross-project',
      evidenceId: 'evidence-run-pass',
      projectId: 'project-b',
      runId: 'run-pass',
      acceptanceId: pending.id,
      relation: 'verifies'
    }, userData),
    'WORKFLOW_PROJECT_BOUNDARY',
    'cross-project evidence link must fail closed'
  )

  const artifact = await api.createWorkflowArtifact({
    id: 'artifact-pass',
    projectId: 'project-a',
    workItemId: passItem.id,
    runId: passRun.id,
    kind: 'test_report',
    title: 'Acceptance gate smoke report',
    digest: 'sha256:acceptance-gate-smoke'
  }, userData)

  const workflowEvidenceItem = await api.createWorkflowWorkItem({
    id: 'work-workflow-evidence',
    projectId: 'project-a',
    title: 'Workflow evidence acceptance',
    type: 'testing',
    status: 'verifying'
  }, userData)
  const workflowEvidenceBytes = Buffer.from('workflow evidence report\n')
  const workflowEvidenceDigest = createHash('sha256').update(workflowEvidenceBytes).digest('hex')
  const workflowEvidencePath = path.join(tempRoot, 'workflow-evidence-report.txt')
  writeFileSync(workflowEvidencePath, workflowEvidenceBytes)
  const workflowEvidenceArtifact = await api.createWorkflowArtifact({
    id: 'artifact-workflow-evidence',
    projectId: 'project-a',
    workItemId: workflowEvidenceItem.id,
    kind: 'test_report',
    title: 'Workflow evidence report',
    digest: `sha256:${workflowEvidenceDigest}`
  }, userData)
  await api.createWorkflowArtifactLocation({
    id: 'location-workflow-evidence',
    artifactId: workflowEvidenceArtifact.id,
    projectId: 'project-a',
    workItemId: workflowEvidenceItem.id,
    kind: 'file',
    path: workflowEvidencePath,
    availability: 'available',
    checksum: `sha256:${workflowEvidenceDigest}`,
    sizeBytes: workflowEvidenceBytes.byteLength
  }, userData)
  const workflowEvidencePending = await api.saveWorkflowAcceptance({
    id: 'acceptance-workflow-evidence',
    projectId: 'project-a',
    workItemId: workflowEvidenceItem.id,
    criteria: ['generic Workflow evidence verifies delivery']
  }, userData)
  const workflowEvidence = await api.createWorkflowEvidence({
    evidenceId: 'workflow-evidence-pass',
    projectId: 'project-a',
    workItemId: workflowEvidenceItem.id,
    artifactId: workflowEvidenceArtifact.id,
    kind: 'test_result',
    source: 'runtime',
    title: 'Workflow evidence acceptance result',
    verifier: 'acceptance-gate-smoke',
    observedAt: 210,
    contentDigest: workflowEvidenceDigest
  }, userData)
  const workflowEvidenceLink = await api.createWorkflowEvidenceLink({
    id: 'link-workflow-evidence-pass',
    evidenceId: workflowEvidence.evidenceId,
    evidenceOrigin: 'workflow',
    projectId: 'project-a',
    artifactId: workflowEvidenceArtifact.id,
    acceptanceId: workflowEvidencePending.id,
    relation: 'verifies'
  }, userData)
  const workflowEvidenceChecking = await api.saveWorkflowAcceptance({
    ...workflowEvidencePending,
    status: 'verifying',
    evidenceRefs: [workflowEvidenceLink.evidenceId],
    revision: workflowEvidencePending.revision + 1,
    updatedAt: 220
  }, userData)
  const workflowEvidencePassed = await api.saveWorkflowAcceptance({
    ...workflowEvidenceChecking,
    status: 'passed',
    verifier: 'acceptance-gate-smoke',
    verifiedAt: 230,
    revision: workflowEvidenceChecking.revision + 1,
    updatedAt: 230
  }, userData)
  assertEqual(workflowEvidencePassed.status, 'passed', 'generic Workflow evidence must satisfy Acceptance')
  const workflowEvidenceDone = await api.transitionWorkflowWorkItem(
    workflowEvidenceItem.id,
    'done',
    workflowEvidenceItem.revision,
    userData
  )
  assertEqual(workflowEvidenceDone.status, 'done', 'Workflow evidence-backed Acceptance must permit done')

  await expectRejects(
    api.createWorkflowEvidenceLink({
      id: 'link-workflow-evidence-wrong-origin',
      evidenceId: workflowEvidence.evidenceId,
      evidenceOrigin: 'task_effect',
      projectId: 'project-a',
      artifactId: workflowEvidenceArtifact.id,
      acceptanceId: workflowEvidencePending.id,
      relation: 'supports'
    }, userData),
    (error) => error?.code === 'WORKFLOW_LEDGER_CORRUPTION' &&
      String(error?.message).includes('missing Task evidence'),
    'explicit task_effect origin must not fall back to Workflow evidence'
  )

  const crossProjectEvidence = await api.createWorkflowEvidence({
    evidenceId: 'workflow-evidence-project-b',
    projectId: 'project-b',
    kind: 'test_result',
    source: 'runtime',
    title: 'Cross-project Workflow evidence',
    verifier: 'acceptance-gate-smoke',
    observedAt: 240,
    contentDigest: 'c'.repeat(64)
  }, userData)
  await expectGate(
    api.createWorkflowEvidenceLink({
      id: 'link-workflow-evidence-cross-project',
      evidenceId: crossProjectEvidence.evidenceId,
      evidenceOrigin: 'workflow',
      projectId: 'project-a',
      acceptanceId: workflowEvidencePending.id,
      relation: 'verifies'
    }, userData),
    'WORKFLOW_PROJECT_BOUNDARY',
    'Workflow evidence must not cross project boundaries'
  )

  await api.createWorkflowEvidence({
    evidenceId: 'evidence-run-pass-2',
    projectId: 'project-a',
    workItemId: originCollisionItem.id,
    kind: 'observation',
    source: 'runtime',
    title: 'Same id in the Workflow evidence store',
    verifier: 'acceptance-gate-smoke',
    observedAt: 245,
    contentDigest: 'd'.repeat(64)
  }, userData)

  const taskOriginAcceptance = await api.saveWorkflowAcceptance({
    id: 'acceptance-origin-task-effect',
    projectId: 'project-a',
    workItemId: originCollisionItem.id,
    criteria: ['legacy omitted origin resolves Task evidence']
  }, userData)
  const defaultOriginLink = await api.createWorkflowEvidenceLink({
    id: 'link-origin-default-task-effect',
    evidenceId: 'evidence-run-pass-2',
    projectId: 'project-a',
    runId: originCollisionRun.id,
    acceptanceId: taskOriginAcceptance.id,
    relation: 'verifies'
  }, userData)
  assertEqual(defaultOriginLink.evidenceOrigin, undefined, 'omitted evidence origin must remain legacy task_effect')
  const taskOriginChecking = await api.saveWorkflowAcceptance({
    ...taskOriginAcceptance,
    status: 'verifying',
    evidenceRefs: [defaultOriginLink.evidenceId],
    revision: taskOriginAcceptance.revision + 1
  }, userData)
  assertEqual(taskOriginChecking.status, 'verifying', 'omitted origin must resolve the Task evidence store')

  const workflowOriginAcceptance = await api.saveWorkflowAcceptance({
    id: 'acceptance-origin-workflow',
    projectId: 'project-a',
    workItemId: originCollisionItem.id,
    criteria: ['explicit workflow origin resolves Workflow evidence']
  }, userData)
  const workflowOriginLink = await api.createWorkflowEvidenceLink({
    id: 'link-origin-explicit-workflow-only',
    evidenceId: 'evidence-run-pass-2',
    evidenceOrigin: 'workflow',
    projectId: 'project-a',
    acceptanceId: workflowOriginAcceptance.id,
    relation: 'verifies'
  }, userData)
  const workflowOriginChecking = await api.saveWorkflowAcceptance({
    ...workflowOriginAcceptance,
    status: 'verifying',
    evidenceRefs: [workflowOriginLink.evidenceId],
    revision: workflowOriginAcceptance.revision + 1
  }, userData)
  assertEqual(workflowOriginChecking.status, 'verifying', 'explicit workflow origin must resolve the Workflow evidence store')

  const originCollisionAcceptance = await api.saveWorkflowAcceptance({
    id: 'acceptance-origin-collision',
    projectId: 'project-a',
    workItemId: originCollisionItem.id,
    criteria: ['one evidence id cannot claim conflicting origins']
  }, userData)
  await api.createWorkflowEvidenceLink({
    id: 'link-origin-collision-task-effect',
    evidenceId: 'evidence-run-pass-2',
    projectId: 'project-a',
    runId: originCollisionRun.id,
    acceptanceId: originCollisionAcceptance.id,
    relation: 'verifies'
  }, userData)
  await api.createWorkflowEvidenceLink({
    id: 'link-origin-collision-workflow',
    evidenceId: 'evidence-run-pass-2',
    evidenceOrigin: 'workflow',
    projectId: 'project-a',
    acceptanceId: originCollisionAcceptance.id,
    relation: 'verifies'
  }, userData)
  await expectGate(
    api.saveWorkflowAcceptance({
      ...originCollisionAcceptance,
      status: 'verifying',
      evidenceRefs: ['evidence-run-pass-2'],
      revision: originCollisionAcceptance.revision + 1
    }, userData),
    'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID',
    'same-project links with conflicting evidence origins must fail closed',
    'evidence_origin_ambiguous'
  )

  // A generic supporting or superseding relation is useful provenance, but it
  // is not verification authority for a terminal Acceptance.
  const supportOnlyPending = await api.saveWorkflowAcceptance({
    id: 'acceptance-support-only',
    projectId: 'project-a',
    workItemId: passItem.id,
    criteria: ['supporting evidence alone is not verification']
  }, userData)
  const supportLink = await api.createWorkflowEvidenceLink({
    id: 'link-support-only',
    evidenceId: 'evidence-run-pass',
    projectId: 'project-a',
    runId: passRun.id,
    artifactId: artifact.id,
    acceptanceId: supportOnlyPending.id,
    relation: 'supports'
  }, userData)
  await api.createWorkflowEvidenceLink({
    id: 'link-supersedes-only',
    evidenceId: 'evidence-run-pass',
    projectId: 'project-a',
    runId: passRun.id,
    artifactId: artifact.id,
    acceptanceId: supportOnlyPending.id,
    relation: 'supersedes'
  }, userData)
  const supportOnlyChecking = await api.saveWorkflowAcceptance({
    ...supportOnlyPending,
    status: 'verifying',
    evidenceRefs: [supportLink.evidenceId],
    revision: supportOnlyPending.revision + 1,
    updatedAt: 250
  }, userData)
  await expectGate(
    api.saveWorkflowAcceptance({
      ...supportOnlyChecking,
      status: 'passed',
      verifier: 'acceptance-gate-smoke',
      verifiedAt: 275,
      revision: supportOnlyChecking.revision + 1,
      updatedAt: 275
    }, userData),
    'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID',
    'supports/supersedes evidence must not authorize pass',
    'verification_link_missing'
  )
  await api.createWorkflowEvidenceLink({
    id: 'link-support-then-verify',
    evidenceId: 'evidence-run-pass',
    projectId: 'project-a',
    runId: passRun.id,
    artifactId: artifact.id,
    acceptanceId: supportOnlyPending.id,
    relation: 'verifies'
  }, userData)
  const supportThenVerifyPassed = await api.saveWorkflowAcceptance({
    ...supportOnlyChecking,
    status: 'passed',
    verifier: 'acceptance-gate-smoke',
    verifiedAt: 290,
    revision: supportOnlyChecking.revision + 1,
    updatedAt: 290
  }, userData)
  assertEqual(
    supportThenVerifyPassed.status,
    'passed',
    'a supports link created first must not shadow a later verifies link for the same evidence'
  )

  const link = await api.createWorkflowEvidenceLink({
    id: 'link-pass',
    evidenceId: 'evidence-run-pass',
    projectId: 'project-a',
    runId: passRun.id,
    artifactId: artifact.id,
    acceptanceId: pending.id,
    relation: 'verifies'
  }, userData)
  const checking = await api.saveWorkflowAcceptance({
    ...pending,
    status: 'verifying',
    evidenceRefs: [link.evidenceId],
    revision: pending.revision + 1,
    updatedAt: 300
  }, userData)
  await expectGate(
    api.saveWorkflowAcceptance({
      ...checking,
      status: 'passed',
      verifiedAt: 350,
      revision: checking.revision + 1,
      updatedAt: 350
    }, userData),
    'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID',
    'passed Acceptance must name a verifier',
    'verifier_missing'
  )
  await expectGate(
    api.saveWorkflowAcceptance({
      ...checking,
      status: 'passed',
      verifier: 'acceptance-gate-smoke',
      revision: checking.revision + 1,
      updatedAt: 375
    }, userData),
    'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID',
    'passed Acceptance must record verifiedAt',
    'verified_at_missing'
  )
  const passed = await api.saveWorkflowAcceptance({
    ...checking,
    status: 'passed',
    verifier: 'acceptance-gate-smoke',
    verifiedAt: 400,
    revision: checking.revision + 1,
    updatedAt: 400
  }, userData)
  assertEqual(passed.status, 'passed', 'evidence-backed Acceptance must pass')

  // revision: the transition API is a compare-and-swap, not last-write-wins.
  await expectGate(
    api.transitionWorkflowWorkItem(passItem.id, 'done', verifying.revision - 1, userData),
    'WORKFLOW_REVISION_CONFLICT',
    'stale WorkItem revision must fail closed'
  )
  const done = await api.transitionWorkflowWorkItem(passItem.id, 'done', verifying.revision, userData)
  assertEqual(done.status, 'done', 'passed Acceptance must permit done')

  const workerStore = new digitalWorker.DigitalWorkerStore(userData)
  const workerRole = await workerStore.createRoleTemplate({
    id: 'role-acceptance-policy',
    name: 'Acceptance policy worker',
    purpose: 'Exercise DigitalWorker terminal acceptance policy'
  })
  const proposedWorker = await workerStore.createDigitalWorker({
    id: 'worker-acceptance-policy',
    projectId: 'project-a',
    roleTemplateId: workerRole.id,
    displayName: 'Acceptance policy worker',
    acceptancePolicy: { minimumEvidenceCount: 2, requireUserApproval: true }
  })
  const policyWorker = await workerStore.activateDigitalWorker(proposedWorker.id, {
    expectedRevision: proposedWorker.revision
  })

  await workerStore.createAssignment({
    id: 'assignment-dw-evidence-policy',
    projectId: evidencePolicyItem.projectId,
    workItemId: evidencePolicyItem.id,
    assigneeKind: 'digital_worker',
    assigneeId: policyWorker.id,
    assignedBy: 'qa-user'
  })
  const evidencePolicyAcceptance = await api.saveWorkflowAcceptance({
    id: 'acceptance-dw-evidence-policy',
    projectId: 'project-a',
    workItemId: evidencePolicyItem.id,
    criteria: ['two distinct evidence records are required']
  }, userData)
  const singleEvidenceLink = await api.createWorkflowEvidenceLink({
    id: 'link-dw-evidence-policy-1',
    evidenceId: 'evidence-run-dw-evidence-policy',
    projectId: 'project-a',
    runId: 'run-dw-evidence-policy',
    acceptanceId: evidencePolicyAcceptance.id,
    relation: 'verifies'
  }, userData)
  const evidencePolicyChecking = await api.saveWorkflowAcceptance({
    ...evidencePolicyAcceptance,
    status: 'verifying',
    evidenceRefs: [singleEvidenceLink.evidenceId],
    revision: evidencePolicyAcceptance.revision + 1
  }, userData)
  await api.saveWorkflowAcceptance({
    ...evidencePolicyChecking,
    status: 'passed',
    verifier: 'acceptance-gate-smoke',
    verifiedAt: 800,
    revision: evidencePolicyChecking.revision + 1
  }, userData)
  const minimumEvidenceError = await expectGate(
    api.transitionWorkflowWorkItem(
      evidencePolicyItem.id,
      'done',
      evidencePolicyItem.revision,
      userData,
      { caller: 'user', actorId: 'qa-user' }
    ),
    'WORKFLOW_DIGITAL_WORKER_POLICY_DENIED',
    'DigitalWorker minimumEvidenceCount must block terminal transition',
    'minimum_evidence_count'
  )
  assertEqual(minimumEvidenceError.details.assignmentId, 'assignment-dw-evidence-policy', 'DigitalWorker denial details must retain assignmentId')
  assertEqual(minimumEvidenceError.details.workerId, policyWorker.id, 'DigitalWorker denial details must retain workerId')
  assertEqual(minimumEvidenceError.audit.assignmentId, minimumEvidenceError.details.assignmentId, 'DigitalWorker denial audit must retain assignmentId')
  assertEqual(minimumEvidenceError.audit.workerId, minimumEvidenceError.details.workerId, 'DigitalWorker denial audit must retain workerId')

  await workerStore.createAssignment({
    id: 'assignment-dw-approval-policy',
    projectId: approvalPolicyItem.projectId,
    workItemId: approvalPolicyItem.id,
    assigneeKind: 'digital_worker',
    assigneeId: policyWorker.id,
    assignedBy: 'qa-user'
  })
  const approvalPolicyAcceptance = await api.saveWorkflowAcceptance({
    id: 'acceptance-dw-approval-policy',
    projectId: 'project-a',
    workItemId: approvalPolicyItem.id,
    criteria: ['two evidence records and explicit user approval are required']
  }, userData)
  const approvalLinks = []
  for (const [suffix, evidenceId, runId] of [
    ['1', 'evidence-run-dw-approval-policy-1', 'run-dw-approval-policy-1'],
    ['2', 'evidence-run-dw-approval-policy-2', 'run-dw-approval-policy-2']
  ]) {
    approvalLinks.push(await api.createWorkflowEvidenceLink({
      id: `link-dw-approval-policy-${suffix}`,
      evidenceId,
      projectId: 'project-a',
      runId,
      acceptanceId: approvalPolicyAcceptance.id,
      relation: 'verifies'
    }, userData))
  }
  const approvalPolicyChecking = await api.saveWorkflowAcceptance({
    ...approvalPolicyAcceptance,
    status: 'verifying',
    evidenceRefs: approvalLinks.map((link) => link.evidenceId),
    revision: approvalPolicyAcceptance.revision + 1
  }, userData)
  await api.saveWorkflowAcceptance({
    ...approvalPolicyChecking,
    status: 'passed',
    verifier: 'acceptance-gate-smoke',
    verifiedAt: 900,
    revision: approvalPolicyChecking.revision + 1
  }, userData)
  const workerStoreContents = readFileSync(workerStore.getPath(), 'utf8')
  writeFileSync(workerStore.getPath(), '{"invalid":true}\n')
  try {
    const invalidStoreError = await expectGate(
      api.transitionWorkflowWorkItem(
        approvalPolicyItem.id,
        'done',
        approvalPolicyItem.revision,
        userData,
        { caller: 'user', actorId: 'qa-user' }
      ),
      'WORKFLOW_DIGITAL_WORKER_POLICY_DENIED',
      'invalid DigitalWorker store must fail closed with diagnostic details',
      'digital_worker_store_invalid'
    )
    assert(
      typeof invalidStoreError.details.cause === 'string' && invalidStoreError.details.cause.length > 0,
      'DigitalWorker store denial details must retain cause'
    )
    assertEqual(invalidStoreError.audit.cause, invalidStoreError.details.cause, 'DigitalWorker store denial audit must retain cause')
    assertEqual(invalidStoreError.audit.reason, invalidStoreError.details.reason, 'DigitalWorker store denial audit must retain reason')
  } finally {
    writeFileSync(workerStore.getPath(), workerStoreContents)
  }
  const modelApprovalError = await expectGate(
    api.transitionWorkflowWorkItem(
      approvalPolicyItem.id,
      'done',
      approvalPolicyItem.revision,
      userData,
      { caller: 'model', actorId: 'model-1' }
    ),
    'WORKFLOW_DIGITAL_WORKER_POLICY_DENIED',
    'DigitalWorker user approval must reject model authority',
    'user_approval_required'
  )
  assertEqual(modelApprovalError.details.assignmentId, 'assignment-dw-approval-policy', 'user approval denial details must retain assignmentId')
  assertEqual(modelApprovalError.details.workerId, policyWorker.id, 'user approval denial details must retain workerId')
  assertEqual(modelApprovalError.audit.assignmentId, modelApprovalError.details.assignmentId, 'user approval denial audit must retain assignmentId')
  assertEqual(modelApprovalError.audit.workerId, modelApprovalError.details.workerId, 'user approval denial audit must retain workerId')
  await expectGate(
    api.transitionWorkflowWorkItem(
      approvalPolicyItem.id,
      'done',
      approvalPolicyItem.revision,
      userData,
      { caller: 'user' }
    ),
    'WORKFLOW_DIGITAL_WORKER_POLICY_DENIED',
    'DigitalWorker user approval must require a main-process actor id',
    'user_approval_required'
  )
  const approvalDone = await api.transitionWorkflowWorkItem(
    approvalPolicyItem.id,
    'done',
    approvalPolicyItem.revision,
    userData,
    { caller: 'user', actorId: 'qa-user' }
  )
  assertEqual(approvalDone.status, 'done', 'explicit user authority must satisfy DigitalWorker approval policy')

  // criteria coverage: every criterion in a multi-criterion Acceptance must
  // bind to its own verifies link. Aggregate evidenceRefs alone are not enough.
  const coveragePending = await api.saveWorkflowAcceptance({
    id: 'acceptance-criteria-coverage',
    projectId: 'project-a',
    workItemId: approvalPolicyItem.id,
    criteria: ['unit verification passes', 'integration verification passes']
  }, userData)
  const coverageLinks = []
  for (const [suffix, evidenceId, runId, criterionId] of [
    ['1', 'evidence-run-dw-approval-policy-1', 'run-dw-approval-policy-1', 'criterion-unit'],
    ['2', 'evidence-run-dw-approval-policy-1', 'run-dw-approval-policy-1', 'criterion-integration']
  ]) {
    coverageLinks.push(await api.createWorkflowEvidenceLink({
      id: `link-criteria-coverage-${suffix}`,
      evidenceId,
      projectId: 'project-a',
      runId,
      acceptanceId: coveragePending.id,
      criterionId,
      relation: 'verifies'
    }, userData))
  }
  const coverageChecking = await api.saveWorkflowAcceptance({
    ...coveragePending,
    status: 'verifying',
    evidenceRefs: coverageLinks.map((link) => link.evidenceId),
    criterionEvidence: [{
      criterionId: 'criterion-unit',
      criterionIndex: 0,
      evidenceRefs: [coverageLinks[0].evidenceId]
    }],
    revision: coveragePending.revision + 1
  }, userData)
  await expectGate(
    api.saveWorkflowAcceptance({
      ...coverageChecking,
      status: 'passed',
      verifier: 'acceptance-gate-smoke',
      verifiedAt: 950,
      revision: coverageChecking.revision + 1
    }, userData),
    'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID',
    'multi-criterion Acceptance must reject incomplete coverage',
    'criterion_coverage_incomplete'
  )
  await expectGate(
    api.saveWorkflowAcceptance({
      ...coverageChecking,
      status: 'passed',
      criterionEvidence: [
        ...coverageChecking.criterionEvidence,
        {
          criterionId: 'criterion-wrong-link',
          criterionIndex: 1,
          evidenceRefs: [coverageLinks[1].evidenceId]
        }
      ],
      verifier: 'acceptance-gate-smoke',
      verifiedAt: 975,
      revision: coverageChecking.revision + 1
    }, userData),
    'WORKFLOW_ACCEPTANCE_EVIDENCE_INVALID',
    'criterion coverage must match the verifies link criterionId',
    'criterion_verification_link_missing'
  )
  const coveragePassed = await api.saveWorkflowAcceptance({
    ...coverageChecking,
    status: 'passed',
    criterionEvidence: [
      ...coverageChecking.criterionEvidence,
      {
        criterionId: 'criterion-integration',
        criterionIndex: 1,
        evidenceRefs: [coverageLinks[1].evidenceId]
      }
    ],
    verifier: 'acceptance-gate-smoke',
    verifiedAt: 1_000,
    revision: coverageChecking.revision + 1
  }, userData)
  assertEqual(coveragePassed.status, 'passed', 'complete per-criterion coverage must pass')
  assertEqual(
    coveragePassed.evidenceRefs.length,
    1,
    'one evidence record may verify multiple criteria through distinct verifies links'
  )

  // retest: failed -> verifying is explicitly permitted, retaining the same
  // Acceptance identity while incrementing its revision.
  const retestItem = await api.createWorkflowWorkItem({
    id: 'work-retest',
    projectId: 'project-a',
    title: 'Repair and retest',
    type: 'testing',
    status: 'verifying'
  }, userData)
  const retestAcceptance = await api.saveWorkflowAcceptance({
    id: 'acceptance-retest',
    projectId: 'project-a',
    workItemId: retestItem.id,
    criteria: ['repair is rechecked']
  }, userData)
  const failed = await api.saveWorkflowAcceptance({
    ...retestAcceptance,
    status: 'verifying',
    revision: retestAcceptance.revision + 1,
    updatedAt: 500
  }, userData)
  const failedAcceptance = await api.saveWorkflowAcceptance({
    ...failed,
    status: 'failed',
    notes: 'fixture defect',
    revision: failed.revision + 1,
    updatedAt: 600
  }, userData)
  const retesting = await api.saveWorkflowAcceptance({
    ...failedAcceptance,
    status: 'verifying',
    revision: failedAcceptance.revision + 1,
    updatedAt: 700
  }, userData)
  assertEqual(retesting.status, 'verifying', 'failed Acceptance must permit repair retest')

  // waive: only an explicit user caller may create/use a waiver. A model is
  // rejected even when it supplies both waiver fields.
  const waiverItem = await api.createWorkflowWorkItem({
    id: 'work-waive',
    projectId: 'project-a',
    title: 'User-waived delivery',
    type: 'delivery',
    status: 'verifying'
  }, userData)
  const waiverPending = await api.saveWorkflowAcceptance({
    id: 'acceptance-waive',
    projectId: 'project-a',
    workItemId: waiverItem.id,
    criteria: ['user may explicitly accept residual risk']
  }, userData)
  const forgedIdentityFields = [
    ['caller', 'user'],
    ['callerType', 'user'],
    ['actorType', 'user'],
    ['actor', { type: 'user', id: 'forged-user' }],
    ['actorId', 'forged-user']
  ]
  for (const [field, value] of forgedIdentityFields) {
    await expectRejects(
      Promise.resolve().then(() => saveAcceptanceIpc(trustedEvent, {
        ...waiverPending,
        status: 'waived',
        waiverReason: 'forged renderer waiver',
        waivedBy: 'forged-user',
        revision: waiverPending.revision + 1,
        [field]: value
      })),
      (error) => String(error?.message).includes('Acceptance input') && String(error?.message).includes('未知字段'),
      `renderer Acceptance payload must not self-report ${field}`
    )
  }
  await expectGate(
    api.saveWorkflowAcceptance({
      ...waiverPending,
      status: 'waived',
      waiverReason: 'forged direct API waiver',
      waivedBy: 'forged-user',
      revision: waiverPending.revision + 1,
      caller: 'user',
      actorId: 'forged-user'
    }, userData),
    'WORKFLOW_ACCEPTANCE_WAIVER_UNAUTHORIZED',
    'Acceptance payload identity fields must not become direct API authority',
    'non_user_waiver'
  )
  await expectRejects(
    Promise.resolve().then(() => saveAcceptanceIpc(trustedEvent, {
      ...waiverPending,
      status: 'waived',
      waiverReason: 'renderer has no user authority',
      waivedBy: 'forged-user',
      revision: waiverPending.revision + 1
    })),
    (error) => String(error?.message).includes('waiverReason') && String(error?.message).includes('主进程授权'),
    'generic renderer Acceptance IPC must fail closed for waiver without main-process user authority'
  )
  await expectGate(
    api.saveWorkflowAcceptance({
      ...waiverPending,
      status: 'waived',
      waiverReason: 'known fixture limitation',
      waivedBy: 'qa-user',
      revision: waiverPending.revision + 1
    }, userData, { caller: 'model', actorId: 'model-1' }),
    'WORKFLOW_ACCEPTANCE_WAIVER_UNAUTHORIZED',
    'model caller must not waive'
  )
  const waived = await api.saveWorkflowAcceptance({
    ...waiverPending,
    status: 'waived',
    waiverReason: 'known fixture limitation',
    waivedBy: 'qa-user',
    revision: waiverPending.revision + 1
  }, userData, { caller: 'user', actorId: 'qa-user' })
  const waivedDone = await api.transitionWorkflowWorkItem(
    waiverItem.id,
    'done',
    waiverItem.revision,
    userData,
    { caller: 'user', actorId: waived.waivedBy }
  )
  assertEqual(waivedDone.status, 'done', 'explicit user waiver must permit done')

  // Goal completed has the same gate. This case uses a user waiver to prove
  // the Goal path is not an unguarded shortcut around the WorkItem path.
  const goal = await api.createWorkflowGoal({
    id: 'goal-waive',
    projectId: 'project-a',
    title: 'Goal gate',
    objective: 'Complete only with Acceptance'
  }, userData)
  const goalAcceptance = await api.saveWorkflowAcceptance({
    id: 'acceptance-goal-waive',
    projectId: 'project-a',
    goalId: goal.id,
    criteria: ['explicit user decision']
  }, userData)
  const goalWaived = await api.saveWorkflowAcceptance({
    ...goalAcceptance,
    status: 'waived',
    waiverReason: 'operator accepted residual risk',
    waivedBy: 'qa-user',
    revision: goalAcceptance.revision + 1
  }, userData, { caller: 'user', actorId: 'qa-user' })
  const completedGoal = await api.transitionWorkflowGoal(
    goal.id,
    'completed',
    goal.revision,
    userData,
    { caller: 'user', actorId: goalWaived.waivedBy }
  )
  assertEqual(completedGoal.status, 'completed', 'Goal completed must use the Acceptance gate')

  const verification = await api.verifyPersistedWorkflowLedger(userData)
  assertEqual(verification.valid, true, 'acceptance gate fixture ledger must verify')
  assert(guard.WorkflowAcceptanceGateError, 'guard must export an auditable error type')
  console.log('acceptance gate smoke: PASS')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/task/task-snapshot.ts',
    'src/main/task/workflow-ledger-api.ts',
    'src/main/task/workflow-ledger-store.ts',
    'src/main/task/workflow-acceptance-guard.ts',
    'src/main/digital-worker/domain-store.ts',
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
  const moduleSource = [
    'const windows = globalThis.__acceptanceGateWindows ??= []',
    `export const app = { getPath: () => ${JSON.stringify(userData)} }`,
    'export const ipcMain = { handle: (name, handler) => { globalThis.__acceptanceGateHandlers ??= new Map(); globalThis.__acceptanceGateHandlers.set(name, handler) } }',
    'export const BrowserWindow = { getAllWindows: () => globalThis.__acceptanceGateWindows ?? [] }',
    'export { windows }'
  ].join('\n') + '\n'
  writeFileSync(path.join(electronDir, 'index.js'), moduleSource)
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

function findCompiledModule(root, name) {
  const found = searchCompiledModule(root, name)
  if (found) return found
  throw new Error(`compiled ${name} not found under ${root}`)
}

function searchCompiledModule(root, name) {
  for (const entry of require('node:fs').readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = searchCompiledModule(fullPath, name)
      if (found) return found
    } else if (entry.isFile() && entry.name === name) {
      return fullPath
    }
  }
  return undefined
}

async function expectGate(promise, code, message, reason) {
  try {
    await promise
  } catch (error) {
    assertEqual(error?.code, code, `${message} (code)`)
    assert(error?.audit && error.audit.operation, `${message} must expose audit operation`)
    if (reason !== undefined) {
      assertEqual(error?.details?.reason, reason, `${message} (reason)`)
    }
    return error
  }
  throw new Error(`${message}: operation unexpectedly succeeded`)
}

async function expectRejects(promise, predicate, message) {
  try {
    await promise
  } catch (error) {
    if (predicate(error)) return
    throw new Error(`${message}: unexpected error ${error instanceof Error ? error.stack : String(error)}`)
  }
  throw new Error(`${message}: operation unexpectedly succeeded`)
}

function buildMeta(id, projectId, extra = {}) {
  return {
    id,
    title: `Acceptance ${id}`,
    cwd: userData,
    projectId,
    model: 'fixture-model',
    providerId: 'fixture-provider',
    permissionMode: 'default',
    status: 'running',
    sdkSessionId: `sdk-${id}`,
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: 1,
    ...extra
  }
}

function buildRun(id, sessionId, taskId, revision, updatedAt) {
  return {
    schemaVersion: 1,
    id,
    sessionId,
    taskId,
    status: 'executing',
    revision,
    attempt: 1,
    recoveryCount: 0,
    createdAt: 1,
    updatedAt,
    steps: [],
    toolExecutions: [],
    effects: [{
      schemaVersion: 1,
      id: `effect-${id}`,
      effectKey: `effect-key-${id}`,
      resourceKey: `resource-key-${id}`,
      sessionId,
      runId: id,
      toolUseId: `tool-${id}`,
      toolName: 'fixture_tool',
      generation: 1,
      revision,
      status: 'confirmed',
      reconcilability: 'queryable',
      target: { kind: 'unsupported', toolName: 'fixture_tool' },
      targetDigest: `target-${id}`,
      intentDigest: `intent-${id}`,
      inputDigest: `input-${id}`,
      evidence: [{
        id: `evidence-${id}`,
        kind: 'execution_result',
        digest: `evidence-digest-${id}`,
        observedAt: 1,
        verifier: 'acceptance-gate-smoke',
        generation: 1
      }],
      createdAt: 1,
      updatedAt
    }]
  }
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
