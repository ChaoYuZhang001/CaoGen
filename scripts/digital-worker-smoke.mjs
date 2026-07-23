import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const require = createRequire(import.meta.url)
process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter)
require('node:module').Module._initPaths()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-digital-worker-'))
const outDir = path.join(tempRoot, 'compiled')
const storeRoot = path.join(tempRoot, 'user-data')
process.env.CAOGEN_DIGITAL_WORKER_TEST_RENDERER_URL = pathToFileURL(
  path.join(outDir, 'main', 'renderer', 'index.html')
).href
process.env.ELECTRON_RENDERER_URL = process.env.CAOGEN_DIGITAL_WORKER_TEST_RENDERER_URL

try {
  assertProviderNeutralDomainTypes()
  assertNoExternalAgentCli()
  assertRendererBridgeWiring()
  compileSources()
  const domain = require(path.join(outDir, 'main', 'digital-worker', 'index.js'))
  const bridgeResult = await exerciseRendererBridge(domain)
  const {
    DigitalWorkerStore,
    DigitalWorkerStoreError,
    digitalWorkerStorePath,
    DIGITAL_WORKER_SCHEMA_VERSION,
    DIGITAL_WORKER_STORE_VERSION
  } = domain

  const first = new DigitalWorkerStore(storeRoot)
  const role = await first.createRoleTemplate({
    id: 'role-research',
    name: 'Researcher',
    purpose: 'Find and verify relevant evidence',
    instructions: 'Cite sources and preserve uncertainty.',
    capabilityRefs: ['research', 'citation'],
    skillRefs: ['web-search'],
    routingRequirements: { capability: 'text', privacy: 'local-first' },
    source: 'user'
  })
  assertEqual(role.version, 1, 'RoleTemplate starts at version 1')
  assertEqual(role.revision, 1, 'RoleTemplate starts at revision 1')

  const updatedRole = await first.updateRoleTemplate(role.id, { purpose: 'Find, verify, and summarize evidence' }, role.revision)
  assertEqual(updatedRole.version, 2, 'RoleTemplate update increments semantic version')
  assertEqual(updatedRole.revision, 2, 'RoleTemplate update increments revision')
  await assertRejects(
    first.updateRoleTemplate(role.id, { purpose: 'stale write' }, role.revision),
    (error) => error?.code === 'REVISION_CONFLICT',
    'stale RoleTemplate update must fail closed'
  )

  const disposableRole = await first.createRoleTemplate({
    id: 'role-disposable',
    name: 'Disposable fixture',
    purpose: 'Exercise unreferenced RoleTemplate deletion'
  })
  const disposableWorker = await first.createDigitalWorker({
    id: 'worker-disposable',
    projectId: 'project-disposable',
    roleTemplateId: disposableRole.id,
    displayName: 'Disposable worker',
    memoryNamespace: 'project:project-disposable:worker:disposable'
  })
  assertEqual(await first.deleteDigitalWorker(disposableWorker.id, disposableWorker.revision), true, 'history-free worker can be deleted')
  assertEqual(await first.deleteRoleTemplate(disposableRole.id, disposableRole.revision), true, 'unreferenced RoleTemplate can be deleted')
  assertEqual(await first.getRoleTemplate(disposableRole.id), null, 'deleted RoleTemplate is absent')

  const worker = await first.createDigitalWorker({
    id: 'worker-research-a',
    projectId: 'project-a',
    roleTemplateId: role.id,
    displayName: 'Evidence Researcher',
    responsibilityScope: ['market research', 'source review'],
    memoryNamespace: 'project:project-a:worker:research-a',
    budgetPolicy: { monthlyUsd: 20 },
    concurrencyLimit: 2
  })
  assertEqual(worker.status, 'proposed', 'new DigitalWorker starts proposed')
  assert(!('providerId' in worker) && !('model' in worker), 'DigitalWorker identity has no provider/model fields')
  const neutralCreateRevision = first.read().revision
  await assertRejects(
    first.createDigitalWorker({
      id: 'worker-provider-bound',
      projectId: 'project-a',
      roleTemplateId: role.id,
      displayName: 'Provider-bound worker',
      capabilityOverrides: { providerId: 'provider-a' }
    }),
    (error) => error?.code === 'VALIDATION_ERROR' && /Provider\/model identity field/.test(String(error?.message)),
    'DigitalWorker create must reject nested Provider identity'
  )
  assertEqual(first.read().revision, neutralCreateRevision, 'rejected Provider-bound create must not mutate the store')
  const activeWorker = await first.activateDigitalWorker(worker.id, { expectedRevision: worker.revision, now: 100 })
  assertEqual(activeWorker.status, 'active', 'DigitalWorker can become active')
  const neutralPatchStoreRevision = first.read().revision
  await assertRejects(
    first.updateDigitalWorker(
      activeWorker.id,
      { performanceProfile: { engineId: 'anthropic' } },
      activeWorker.revision
    ),
    (error) => error?.code === 'VALIDATION_ERROR' && /Provider\/model identity field/.test(String(error?.message)),
    'DigitalWorker update must reject nested engine identity'
  )
  assertEqual(first.read().revision, neutralPatchStoreRevision, 'rejected engine-bound update must not mutate the store')
  assertEqual(
    (await first.getDigitalWorker(activeWorker.id))?.revision,
    activeWorker.revision,
    'rejected engine-bound update must preserve Worker identity revision'
  )

  const secondWorker = await first.createDigitalWorker({
    id: 'worker-research-b',
    projectId: 'project-b',
    roleTemplateId: role.id,
    displayName: 'Other Project Researcher',
    memoryNamespace: 'project:project-b:worker:research-b'
  })
  await first.activateDigitalWorker(secondWorker.id, { expectedRevision: secondWorker.revision, now: 101 })

  const assignment = await first.createAssignment({
    id: 'assignment-a-1',
    projectId: 'project-a',
    workItemId: 'work-a-1',
    assigneeKind: 'digital_worker',
    assigneeId: activeWorker.id,
    assignedBy: 'owner-a',
    scope: { dataClass: 'project-internal' },
    reason: 'Research kickoff'
  })
  assertEqual(assignment.status, 'active', 'Assignment starts active')
  await assertRejects(
    first.createAssignment({
      projectId: 'project-a',
      workItemId: 'work-a-2',
      assigneeKind: 'digital_worker',
      assigneeId: secondWorker.id,
      assignedBy: 'owner-a'
    }),
    (error) => error?.code === 'PROJECT_SCOPE_CONFLICT',
    'cross-project Assignment must fail closed'
  )

  const restarted = new DigitalWorkerStore(storeRoot)
  assertEqual((await restarted.getRoleTemplate(role.id))?.id, role.id, 'RoleTemplate survives restart')
  assertEqual((await restarted.getDigitalWorker(activeWorker.id))?.status, 'active', 'DigitalWorker survives restart')
  assertEqual((await restarted.getAssignment(assignment.id))?.id, assignment.id, 'Assignment survives restart')
  await assertRejects(
    restarted.updateDigitalWorker(activeWorker.id, {
      dataScope: {
        requireExplicitScope: true,
        allowedDataClasses: ['restricted'],
        deniedDataClasses: [],
        allowedResourceIds: []
      }
    }, activeWorker.revision),
    (error) => error?.code === 'POLICY_DENIED',
    'a Worker policy update must not invalidate an active Assignment'
  )

  const lease = await restarted.acquireLease({
    projectId: 'project-a',
    workItemId: 'work-a-1',
    workerId: activeWorker.id,
    assignmentId: assignment.id,
    ttlMs: 10_000,
    now: 1_000
  })
  assert(lease.fencingToken > 0, 'lease has a fencing token')
  const outcomes = await Promise.allSettled([
    restarted.acquireLease({
      projectId: 'project-a',
      workItemId: 'work-a-1',
      workerId: activeWorker.id,
      assignmentId: assignment.id,
      now: 1_001
    }),
    restarted.acquireLease({
      projectId: 'project-a',
      workItemId: 'work-a-1',
      workerId: activeWorker.id,
      assignmentId: assignment.id,
      now: 1_001
    })
  ])
  assertEqual(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 0, 'duplicate concurrent lease attempts must fail closed')
  assert(
    outcomes.every((outcome) => outcome.status === 'rejected' && ['LEASE_CONFLICT', 'CONFLICT'].includes(outcome.reason?.code)),
    'duplicate lease errors must be explicit conflicts'
  )
  await assertRejects(
    restarted.acquireLease({ projectId: 'project-b', workItemId: 'work-a-1', workerId: activeWorker.id, now: 1_002 }),
    (error) => error?.code === 'PROJECT_SCOPE_CONFLICT',
    'cross-project lease must fail closed'
  )
  await assertRejects(
    restarted.releaseLease({ leaseId: lease.id, fencingToken: lease.fencingToken + 1, now: 1_003 }),
    (error) => error?.code === 'STALE_FENCE',
    'stale fencing token must fail closed'
  )
  await restarted.releaseLease({ leaseId: lease.id, fencingToken: lease.fencingToken, now: 1_004 })

  const released = await restarted.releaseAssignment(assignment.id, assignment.revision, { now: 1_005, reason: 'hand-off' })
  const reassigned = await restarted.createAssignment({
    id: 'assignment-a-2',
    projectId: 'project-a',
    workItemId: 'work-a-1',
    assigneeKind: 'human',
    assigneeId: 'owner-a',
    assignedBy: 'owner-a',
    reason: 'Human review'
  })
  assertEqual(released.status, 'released', 'released Assignment remains historical')
  assertEqual(reassigned.status, 'active', 'reassignment creates a new active history row')
  const history = await restarted.listAssignmentHistory({ projectId: 'project-a', workItemId: 'work-a-1' })
  assertEqual(history.length, 2, 'Assignment history retains both owner records')

  const inFlightAssignment = await restarted.createAssignment({
    id: 'assignment-a-in-flight',
    projectId: 'project-a',
    workItemId: 'work-a-in-flight',
    assigneeKind: 'digital_worker',
    assigneeId: activeWorker.id,
    assignedBy: 'owner-a'
  })
  const retired = await restarted.retireDigitalWorker(activeWorker.id, { now: 1_006 })
  assertEqual(retired.status, 'retired', 'DigitalWorker supports retirement')
  assertEqual((await restarted.getAssignment(inFlightAssignment.id))?.status, 'active', 'retirement does not delete an in-flight Assignment')
  await assertRejects(
    restarted.createAssignment({
      projectId: 'project-a',
      workItemId: 'work-a-3',
      assigneeKind: 'digital_worker',
      assigneeId: activeWorker.id,
      assignedBy: 'owner-a'
    }),
    (error) => error?.code === 'CONFLICT',
    'retired DigitalWorker cannot receive new Assignment'
  )
  assertEqual((await restarted.listAssignmentHistory({ assigneeId: activeWorker.id })).length, 2, 'retirement preserves worker Assignment history')
  await assertRejects(
    restarted.deleteDigitalWorker(activeWorker.id, retired.revision),
    (error) => error?.code === 'IMMUTABLE_HISTORY',
    'worker with Assignment history must not be hard-deleted'
  )

  const staleWriter = new DigitalWorkerStore(storeRoot)
  const staleSnapshot = await staleWriter.getDigitalWorker(secondWorker.id)
  assert(staleSnapshot, 'second worker must be readable for revision test')
  await restarted.updateDigitalWorker(secondWorker.id, { displayName: 'Renamed worker' }, staleSnapshot.revision)
  await assertRejects(
    staleWriter.updateDigitalWorker(secondWorker.id, { displayName: 'Stale rename' }, staleSnapshot.revision),
    (error) => error?.code === 'REVISION_CONFLICT',
    'stale DigitalWorker writer must fail closed'
  )

  const storePath = digitalWorkerStorePath(storeRoot)
  assert(existsSync(storePath), 'atomic store file must exist')
  const persisted = JSON.parse(readFileSync(storePath, 'utf8'))
  assertEqual(persisted.schemaVersion, DIGITAL_WORKER_SCHEMA_VERSION, 'persisted schema version')
  assertEqual(persisted.storeVersion, DIGITAL_WORKER_STORE_VERSION, 'persisted store version')
  assert(Number.isSafeInteger(persisted.revision) && persisted.revision > 0, 'persisted store revision')
  assertEqual(restarted.verify().valid, true, 'store verification must pass after all operations')

  const migrationRoot = path.join(tempRoot, 'migration-user-data')
  const migrationPath = digitalWorkerStorePath(migrationRoot)
  mkdirSync(migrationRoot, { recursive: true })
  writeFileSync(migrationPath, `${JSON.stringify({ ...persisted, storeVersion: 1 }, null, 2)}\n`)
  const migrationStore = new DigitalWorkerStore(migrationRoot)
  assertEqual(migrationStore.read().storeVersion, DIGITAL_WORKER_STORE_VERSION, 'v1 store must migrate explicitly in memory')
  await migrationStore.createRoleTemplate({
    id: 'role-after-v1-migration',
    name: 'Migrated role',
    purpose: 'Persist the explicit v1 to v2 migration'
  })
  assertEqual(
    JSON.parse(readFileSync(migrationPath, 'utf8')).storeVersion,
    DIGITAL_WORKER_STORE_VERSION,
    'the first post-migration mutation must persist v2'
  )

  for (const storeVersion of [1, DIGITAL_WORKER_STORE_VERSION]) {
    const providerBoundRoot = path.join(tempRoot, `provider-bound-v${storeVersion}-user-data`)
    const providerBoundPath = digitalWorkerStorePath(providerBoundRoot)
    const providerBound = JSON.parse(JSON.stringify({ ...persisted, storeVersion }))
    providerBound.workers[0].performanceProfile = { modelId: 'provider-owned-model' }
    mkdirSync(providerBoundRoot, { recursive: true })
    writeFileSync(providerBoundPath, `${JSON.stringify(providerBound, null, 2)}\n`)
    await assertRejects(
      Promise.resolve().then(() => new DigitalWorkerStore(providerBoundRoot).read()),
      (error) => error?.code === 'STORE_CORRUPT' && /Provider\/model identity field/.test(String(error?.message)),
      `v${storeVersion} store must reject Provider/model-bound Worker identity during read or migration`
    )
  }

  const corruptRoot = path.join(tempRoot, 'corrupt-v1-user-data')
  const corruptPath = digitalWorkerStorePath(corruptRoot)
  const corruptV1 = JSON.parse(JSON.stringify({ ...persisted, storeVersion: 1 }))
  delete corruptV1.workers[0].dataScope
  mkdirSync(corruptRoot, { recursive: true })
  writeFileSync(corruptPath, `${JSON.stringify(corruptV1, null, 2)}\n`)
  await assertRejects(
    Promise.resolve().then(() => new DigitalWorkerStore(corruptRoot).read()),
    (error) => error?.code === 'STORE_CORRUPT' && /dataScope/.test(String(error?.message)),
    'v1 migration must reject a Worker missing dataScope instead of defaulting open'
  )

  const report = {
    runId,
    status: 'pass',
    sourceRevision: gitOutput(['rev-parse', 'HEAD']),
    worktreeStatusCount: gitOutput(['status', '--porcelain']).split('\n').filter(Boolean).length,
    checks: [
      'role-template-crud-and-revision',
      'worker-project-scope-and-lifecycle',
      'assignment-history-and-retirement',
      'restart-persistence',
      'cross-project-fail-closed',
      'duplicate-lease-fail-closed',
      'fencing-token-rejection',
      'atomic-schema-persistence',
      'explicit-v1-to-v2-policy-migration',
      'provider-model-neutral-create-update-and-migration',
      'provider-model-neutral-goal-workitem-schema',
      'worker-policy-update-revalidation',
      'trusted-user-data-renderer-bridge',
      'renderer-ipc-runtime-validation',
      'no-external-agent-cli-static-assertion'
    ],
    storePath,
    bridgeStorePath: bridgeResult.storePath,
    revision: persisted.revision,
    counts: {
      roleTemplates: persisted.roleTemplates.length,
      workers: persisted.workers.length,
      assignments: persisted.assignments.length,
      leases: persisted.leases.length,
      audit: persisted.audit.length
    }
  }
  writeReport(report)
  console.log(JSON.stringify(report, null, 2))
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function writeReport(report) {
  const reportRoot = path.join(repoRoot, 'test-results', 'digital-worker-domain')
  const reportDir = path.join(reportRoot, runId)
  mkdirSync(reportDir, { recursive: true })
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(reportDir, 'report.json'), serialized, 'utf8')
  writeFileSync(path.join(reportRoot, 'latest.json'), serialized, 'utf8')
}

function gitOutput(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}

function compileSources() {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/digital-worker/index.ts',
      'src/main/project-workspace/index.ts',
      'src/main/ipc/digital-worker-handlers.ts',
      '--outDir', outDir,
      '--target', 'ES2022',
      '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext',
      '--types', 'node',
      '--skipLibCheck',
      '--esModuleInterop',
      '--strict'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )
}

async function exerciseRendererBridge(domain) {
  const context = await prepareRendererBridge()
  await assertRendererGatewayBoundaries(context)
  const activeWorker = await createActiveRendererWorker(context.invoke)
  await exerciseRendererAssignmentFlow(context.projectStore, context.invoke, activeWorker)
  const storePath = domain.digitalWorkerStorePath(context.ipcRoot)
  assert(existsSync(storePath), 'DigitalWorker IPC must persist under the fixed userData root')
  return { storePath }
}

async function prepareRendererBridge() {
  const ipcRoot = path.join(tempRoot, 'ipc-user-data')
  process.env.CAOGEN_DIGITAL_WORKER_TEST_USER_DATA = ipcRoot
  installElectronShim()
  const projectDomain = require(path.join(outDir, 'main', 'project-workspace', 'index.js'))
  const projectStore = new projectDomain.ProjectWorkspaceStore(ipcRoot)
  await projectStore.open()
  await projectStore.createWorkspace({ id: 'ipc-project', name: 'IPC project', kind: 'software' })
  await projectStore.createWorkItem({ id: 'ipc-work-item', projectId: 'ipc-project', title: 'IPC work item' })
  const electron = require(path.join(outDir, 'node_modules', 'electron', 'index.js'))
  const bridge = require(findCompiledModule(outDir, 'digital-worker-handlers.js'))
  bridge.registerDigitalWorkerIpc()

  const trustedEvent = {
    sender: electron.__trustedSender,
    senderFrame: electron.__trustedSender.mainFrame
  }
  const gateway = electron.__handlers.get('digitalWorker:invoke')
  assert(gateway, 'missing DigitalWorker action gateway')
  const invoke = async (action, payload) => {
    const request = payload === undefined ? { action } : { action, payload }
    return gateway(trustedEvent, request)
  }
  return { electron, gateway, invoke, ipcRoot, projectStore }
}

async function assertRendererGatewayBoundaries({ electron, gateway, invoke }) {
  await assertRejects(
    Promise.resolve().then(() => gateway({
      sender: { isDestroyed: () => false, getURL: () => 'file:///tmp/unowned.html' },
      senderFrame: { url: 'file:///tmp/unowned.html' }
    }, { action: 'verifyDigitalWorkerStore' })),
    (error) => /not trusted/.test(String(error?.message)),
    'an unowned renderer must not access DigitalWorker IPC'
  )
  await assertRejects(
    Promise.resolve().then(() => gateway({
      sender: electron.__trustedSender,
      senderFrame: { url: electron.__trustedSender.mainFrame.url }
    }, { action: 'verifyDigitalWorkerStore' })),
    (error) => /not trusted/.test(String(error?.message)),
    'an owned renderer subframe must not access DigitalWorker IPC'
  )
  const packagedFrame = electron.__trustedSender.mainFrame
  const arbitraryFileFrame = { url: 'file:///tmp/arbitrary-owned-page.html' }
  electron.__trustedSender.mainFrame = arbitraryFileFrame
  await assertRejects(
    Promise.resolve().then(() => gateway({
      sender: electron.__trustedSender,
      senderFrame: arbitraryFileFrame
    }, { action: 'verifyDigitalWorkerStore' })),
    (error) => /not trusted/.test(String(error?.message)),
    'an arbitrary owned file page must not access DigitalWorker IPC'
  )
  const loopbackFrame = { url: 'http://127.0.0.1:4173/attacker.html' }
  electron.__trustedSender.mainFrame = loopbackFrame
  await assertRejects(
    Promise.resolve().then(() => gateway({
      sender: electron.__trustedSender,
      senderFrame: loopbackFrame
    }, { action: 'verifyDigitalWorkerStore' })),
    (error) => /not trusted/.test(String(error?.message)),
    'an arbitrary loopback page must not access DigitalWorker IPC'
  )
  process.env.ELECTRON_RENDERER_URL = 'http://127.0.0.1:5173/app/'
  const developmentFrame = { url: process.env.ELECTRON_RENDERER_URL }
  electron.__trustedSender.mainFrame = developmentFrame
  const developmentVerification = await gateway({
    sender: electron.__trustedSender,
    senderFrame: developmentFrame
  }, { action: 'verifyDigitalWorkerStore' })
  assertEqual(developmentVerification.valid, true, 'the exact configured development renderer must be trusted')
  const wrongDevelopmentPath = { url: 'http://127.0.0.1:5173/attacker/' }
  electron.__trustedSender.mainFrame = wrongDevelopmentPath
  await assertRejects(
    Promise.resolve().then(() => gateway({
      sender: electron.__trustedSender,
      senderFrame: wrongDevelopmentPath
    }, { action: 'verifyDigitalWorkerStore' })),
    (error) => /not trusted/.test(String(error?.message)),
    'a same-origin development page with the wrong path must not be trusted'
  )
  process.env.ELECTRON_RENDERER_URL = process.env.CAOGEN_DIGITAL_WORKER_TEST_RENDERER_URL
  electron.__trustedSender.mainFrame = packagedFrame
  await assertRejects(
    invoke('createDigitalWorkerRoleTemplate', {
      input: { name: 'Invalid role', purpose: 'Must fail', unknownField: true }
    }),
    (error) => /unknown field/.test(String(error?.message)),
    'unknown renderer fields must fail closed'
  )
  await assertRejects(
    invoke('notAnAgentDeskAction', {}),
    (error) => /action is invalid/.test(String(error?.message)),
    'unknown gateway actions must fail closed'
  )
}

async function createActiveRendererWorker(invoke) {
  const role = await invoke('createDigitalWorkerRoleTemplate', {
    input: {
      id: 'ipc-role',
      name: 'IPC role',
      purpose: 'Verify the renderer bridge\nwithout flattening instructions.',
      instructions: 'Line one.\nLine two.'
    }
  })
  await assertRejects(
    invoke('createDigitalWorker', {
      input: {
        id: 'ipc-orphan-worker',
        projectId: 'missing-project',
        roleTemplateId: role.id,
        displayName: 'Orphan worker'
      }
    }),
    (error) => /project is not active/.test(String(error?.message)),
    'DigitalWorker IPC must reject a missing ProjectWorkspace'
  )
  const worker = await invoke('createDigitalWorker', {
    input: {
      id: 'ipc-worker',
      projectId: 'ipc-project',
      roleTemplateId: role.id,
      displayName: 'IPC worker',
      memoryNamespace: 'project:ipc-project:worker:ipc-worker'
    }
  })
  const activeWorker = await invoke('activateDigitalWorker', {
    id: worker.id,
    options: { expectedRevision: worker.revision, now: 200 }
  })
  return activeWorker
}

async function exerciseRendererAssignmentFlow(projectStore, invoke, activeWorker) {
  await projectStore.createWorkspace({ id: 'ipc-foreign-project', name: 'Foreign project' })
  await projectStore.createWorkItem({
    id: 'ipc-foreign-work-item',
    projectId: 'ipc-foreign-project',
    title: 'Foreign work item'
  })
  await assertRejects(
    invoke('createDigitalWorkerAssignment', {
      input: {
        id: 'ipc-cross-project-assignment',
        projectId: 'ipc-project',
        workItemId: 'ipc-foreign-work-item',
        assigneeKind: 'digital_worker',
        assigneeId: activeWorker.id,
        assignedBy: 'ipc-owner'
      }
    }),
    (error) => /does not belong to project/.test(String(error?.message)),
    'DigitalWorker IPC must reject a WorkItem from another ProjectWorkspace'
  )
  const assignment = await invoke('createDigitalWorkerAssignment', {
    input: {
      id: 'ipc-assignment',
      projectId: 'ipc-project',
      workItemId: 'ipc-work-item',
      assigneeKind: 'digital_worker',
      assigneeId: activeWorker.id,
      assignedBy: 'ipc-owner'
    }
  })
  const reassigned = await invoke('reassignDigitalWorkerAssignment', {
    input: {
      currentAssignmentId: assignment.id,
      nextInput: {
        id: 'ipc-human-assignment',
        projectId: 'ipc-project',
        workItemId: 'ipc-work-item',
        assigneeKind: 'human',
        assigneeId: 'ipc-owner',
        assignedBy: 'ipc-owner'
      },
      expectedRevision: assignment.revision,
      now: 201,
      reason: 'Human verification\nrequired.'
    }
  })
  assertEqual(reassigned.released.status, 'released', 'IPC reassignment must retain released history')
  assertEqual(reassigned.assigned.status, 'active', 'IPC reassignment must create an active owner')
}

function installElectronShim() {
  const shimDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(shimDir, { recursive: true })
  writeFileSync(path.join(shimDir, 'index.js'), `
const handlers = new Map()
const mainFrame = { url: process.env.CAOGEN_DIGITAL_WORKER_TEST_RENDERER_URL }
const trustedSender = {
  mainFrame,
  isDestroyed: () => false,
  getURL: () => mainFrame.url
}
module.exports = {
  __handlers: handlers,
  __trustedSender: trustedSender,
  app: {
    getPath(name) {
      if (name !== 'userData') throw new Error('unexpected app path request: ' + name)
      return process.env.CAOGEN_DIGITAL_WORKER_TEST_USER_DATA
    }
  },
  BrowserWindow: {
    getAllWindows: () => [{ webContents: trustedSender }]
  },
  ipcMain: {
    handle(channel, handler) {
      if (handlers.has(channel)) throw new Error('duplicate IPC handler: ' + channel)
      handlers.set(channel, handler)
    }
  }
}
`)
}

function assertNoExternalAgentCli() {
  const files = [
    path.join(repoRoot, 'scripts', 'digital-worker-smoke.mjs'),
    path.join(repoRoot, 'src', 'main', 'digital-worker', 'index.ts'),
    path.join(repoRoot, 'src', 'main', 'digital-worker', 'store.ts'),
    path.join(repoRoot, 'src', 'main', 'ipc', 'digital-worker-handlers.ts'),
    path.join(repoRoot, 'src', 'preload', 'digital-worker.ts')
  ]
  const text = files.map((file) => readFileSync(file, 'utf8')).join('\n')
  const forbidden = [
    /(?:spawn|exec|execFile|fork)\s*\([^)]*['"`](?:claude|codex|aider|cursor|goose)['"`]/i,
    /(?:install|register|launch|start)\s+(?:an?\s+)?external\s+agent\s+cli/i
  ]
  for (const pattern of forbidden) {
    assert(!pattern.test(text), `external Agent CLI invocation matched ${pattern}`)
  }
}

function assertProviderNeutralDomainTypes() {
  const interfaceGroups = [
    {
      file: 'src/shared/digital-worker-types.ts',
      names: ['DigitalWorker', 'DigitalWorkerInput', 'DigitalWorkerPatch']
    },
    {
      file: 'src/shared/project-workspace-types.ts',
      names: ['Goal', 'GoalInput', 'GoalPatch', 'WorkItem', 'WorkItemInput', 'WorkItemPatch']
    }
  ]
  const providerIdentityField = /\b(?:provider|model|engine)(?:Id|Name|Key|Ref)?\s*:/i
  for (const group of interfaceGroups) {
    const typeSource = readFileSync(path.join(repoRoot, group.file), 'utf8')
    for (const interfaceName of group.names) {
      const interfaceStart = typeSource.indexOf(`export interface ${interfaceName} {`)
      const interfaceEnd = typeSource.indexOf('\n}', interfaceStart)
      assert(interfaceStart >= 0 && interfaceEnd > interfaceStart, `${interfaceName} interface must be present`)
      const interfaceSource = typeSource.slice(interfaceStart, interfaceEnd)
      assert(!providerIdentityField.test(interfaceSource), `${interfaceName} must not bind Provider/model/engine identity`)
    }
  }
}

function assertRendererBridgeWiring() {
  const handler = readFileSync(path.join(repoRoot, 'src', 'main', 'ipc', 'digital-worker-handlers.ts'), 'utf8')
  const preload = readFileSync(path.join(repoRoot, 'src', 'preload', 'digital-worker.ts'), 'utf8')
  const preloadIndex = readFileSync(path.join(repoRoot, 'src', 'preload', 'index.ts'), 'utf8')
  const mainIpc = readFileSync(path.join(repoRoot, 'src', 'main', 'ipc.ts'), 'utf8')
  const sharedTypes = readFileSync(path.join(repoRoot, 'src', 'shared', 'types.ts'), 'utf8')

  assert(
    handler.includes("new DigitalWorkerStore(app.getPath('userData'))"),
    'DigitalWorker IPC store must be rooted exclusively in Electron userData'
  )
  assert(
    handler.includes('assertTrustedDigitalWorkerSender(event)') &&
      handler.includes('BrowserWindow.getAllWindows()') &&
      handler.includes('frame !== mainFrame') &&
      handler.includes('process.env.ELECTRON_RENDERER_URL') &&
      handler.includes("pathToFileURL(join(__dirname, '../renderer/index.html'))"),
    'every DigitalWorker IPC path must use the trusted renderer boundary'
  )
  assert(
    handler.includes('assertAllowedKeys(record') && handler.includes('contains an unknown field'),
    'DigitalWorker IPC inputs must reject unknown fields'
  )
  assert(
    handler.includes("ipcMain.handle('digitalWorker:invoke'") &&
      preload.includes("ipcRenderer.invoke('digitalWorker:invoke'"),
    'DigitalWorker must use one main/preload action gateway'
  )
  for (const action of [
    'createDigitalWorkerRoleTemplate',
    'createDigitalWorker',
    'createDigitalWorkerAssignment',
    'acquireDigitalWorkerLease',
    'listDigitalWorkerAuditEvents'
  ]) {
    assert(handler.includes(`${action}:`), `main action gateway must register ${action}`)
    assert(preload.includes(`invokeDigitalWorker('${action}'`), `preload must expose ${action}`)
  }
  assert(
    mainIpc.includes('registerDigitalWorkerIpc') && mainIpc.includes('export function registerIpc'),
    'main IPC bootstrap must register DigitalWorker handlers'
  )
  assert(preloadIndex.includes('...digitalWorkerApi'), 'preload root must expose the DigitalWorker API')
  assert(/AgentDeskApi extends[^\n]+DigitalWorkerApi/.test(sharedTypes), 'AgentDeskApi must include DigitalWorkerApi')
}

function findCompiledModule(root, fileName) {
  const found = searchCompiledModule(root, fileName)
  if (found) return found
  throw new Error(`compiled ${fileName} not found under ${root}`)
}

function searchCompiledModule(root, fileName) {
  for (const entry of require('node:fs').readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = searchCompiledModule(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  return undefined
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
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
