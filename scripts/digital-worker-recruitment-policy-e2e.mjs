import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter)
require('node:module').Module._initPaths()

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-digital-worker-recruitment-policy-'))
const outDir = path.join(tempRoot, 'compiled')
const storeRoot = path.join(tempRoot, 'user-data')
process.env.CAOGEN_RECRUITMENT_TEST_USER_DATA = storeRoot
process.env.CAOGEN_RECRUITMENT_TEST_RENDERER_URL = pathToFileURL(
  path.join(outDir, 'renderer', 'index.html')
).href
process.env.ELECTRON_RENDERER_URL = process.env.CAOGEN_RECRUITMENT_TEST_RENDERER_URL

try {
  assertNativeRecruitmentBoundary()
  compileDomain()
  installElectronShim()
  const domain = require(path.join(outDir, 'main', 'digital-worker', 'index.js'))
  const projectDomain = require(path.join(outDir, 'main', 'project-workspace', 'index.js'))
  const handlers = require(path.join(outDir, 'main', 'ipc', 'digital-worker-handlers.js'))
  const studioModel = require(path.join(outDir, 'renderer', 'src', 'components', 'studio', 'digital-worker-studio-model.js'))
  const studioForms = require(path.join(outDir, 'renderer', 'src', 'components', 'studio', 'DigitalWorkerForms.js'))
  const React = require('react')
  const ReactDomServer = require('react-dom/server')
  const store = new domain.DigitalWorkerStore(storeRoot)
  const projectStore = new projectDomain.ProjectWorkspaceStore(storeRoot)
  await projectStore.open()
  await projectStore.createWorkspace({ id: 'project-policy', name: 'Policy project', kind: 'software' })
  await projectStore.createWorkItem({
    id: 'work-ipc-policy',
    projectId: 'project-policy',
    title: 'IPC policy roundtrip'
  })
  await projectStore.createWorkItem({
    id: 'work-allowed',
    projectId: 'project-policy',
    title: 'Allowed policy assignment'
  })
  handlers.registerDigitalWorkerIpc()
  const electron = require(path.join(outDir, 'node_modules', 'electron', 'index.js'))
  const gateway = electron.__handlers.get('digitalWorker:invoke')
  assert(gateway, 'DigitalWorker IPC gateway must register')
  const event = { sender: electron.__trustedSender, senderFrame: electron.__trustedSender.mainFrame }
  const invoke = (action, payload) => gateway(event, payload === undefined ? { action } : { action, payload })

  const role = await store.createRoleTemplate({
    id: 'role-policy-reviewer',
    name: 'Policy Reviewer',
    purpose: 'Review project-internal evidence under explicit boundaries',
    instructions: 'Reject work outside the assigned data and tool scope.',
    toolPolicy: { workspaceRead: true, workspaceWrite: false, network: false },
    verificationPolicy: { minimumEvidenceCount: 2, requireUserApproval: true },
    escalationPolicy: { target: 'project-owner', afterFailures: 2 }
  })
  const proposed = await store.createDigitalWorker({
    id: 'worker-policy-reviewer',
    projectId: 'project-policy',
    roleTemplateId: role.id,
    displayName: 'Internal Policy Reviewer',
    responsibilityScope: ['review evidence', 'report policy violations'],
    toolPolicy: { workspaceRead: true, workspaceWrite: false, terminal: false, network: false },
    dataScope: {
      requireExplicitScope: true,
      allowedDataClasses: ['project-internal'],
      deniedDataClasses: ['credential'],
      allowedResourceIds: ['repo-main']
    },
    budgetPolicy: { monthlyUsd: 25 },
    concurrencyLimit: 1,
    acceptancePolicy: { minimumEvidenceCount: 2, requireUserApproval: true },
    escalationPolicy: { target: 'project-owner', afterFailures: 2 }
  })
  const worker = await store.activateDigitalWorker(proposed.id, {
    expectedRevision: proposed.revision,
    now: 100
  })

  assertEqual(worker.status, 'active', 'native recruitment activates the CaoGen DigitalWorker')
  assertDeepEqual(worker.responsibilityScope, ['review evidence', 'report policy violations'], 'responsibility persists')
  assertDeepEqual(worker.toolPolicy, {
    workspaceRead: true,
    workspaceWrite: false,
    terminal: false,
    network: false
  }, 'permissions persist')
  assertDeepEqual(worker.dataScope, {
    requireExplicitScope: true,
    allowedDataClasses: ['project-internal'],
    deniedDataClasses: ['credential'],
    allowedResourceIds: ['repo-main']
  }, 'data scope persists')
  assertDeepEqual(worker.budgetPolicy, { monthlyUsd: 25 }, 'budget persists')
  assertEqual(worker.concurrencyLimit, 1, 'concurrency persists')
  assertDeepEqual(worker.acceptancePolicy, {
    minimumEvidenceCount: 2,
    requireUserApproval: true
  }, 'acceptance policy persists')
  assertDeepEqual(worker.escalationPolicy, {
    target: 'project-owner',
    afterFailures: 2
  }, 'escalation policy persists')

  const restarted = new domain.DigitalWorkerStore(storeRoot)
  const recovered = await restarted.getDigitalWorker(worker.id)
  assert(recovered, 'restarted store must recover the recruited worker')
  for (const field of [
    'responsibilityScope', 'toolPolicy', 'dataScope', 'budgetPolicy',
    'concurrencyLimit', 'acceptancePolicy', 'escalationPolicy'
  ]) {
    assertDeepEqual(recovered[field], worker[field], `${field} must survive restart`)
  }

  await assertPolicyDenied(restarted.createAssignment({
    id: 'assignment-missing-scope',
    projectId: worker.projectId,
    workItemId: 'work-missing-scope',
    assigneeKind: 'digital_worker',
    assigneeId: worker.id,
    assignedBy: 'owner-policy'
  }), 'missing explicit scope')
  await assertPolicyDenied(restarted.createAssignment({
    id: 'assignment-denied-class',
    projectId: worker.projectId,
    workItemId: 'work-denied-class',
    assigneeKind: 'digital_worker',
    assigneeId: worker.id,
    assignedBy: 'owner-policy',
    scope: { dataClass: 'credential' }
  }), 'denied data class')
  await assertPolicyDenied(restarted.createAssignment({
    id: 'assignment-denied-resource',
    projectId: worker.projectId,
    workItemId: 'work-denied-resource',
    assigneeKind: 'digital_worker',
    assigneeId: worker.id,
    assignedBy: 'owner-policy',
    scope: { dataClass: 'project-internal', resourceIds: ['repo-other'] }
  }), 'resource outside allowed scope')
  await assertPolicyDenied(restarted.createAssignment({
    id: 'assignment-missing-resource',
    projectId: worker.projectId,
    workItemId: 'work-missing-resource',
    assigneeKind: 'digital_worker',
    assigneeId: worker.id,
    assignedBy: 'owner-policy',
    scope: { dataClass: 'project-internal' }
  }), 'missing explicit resource scope')

  const allowed = await restarted.createAssignment({
    id: 'assignment-allowed',
    projectId: worker.projectId,
    workItemId: 'work-allowed',
    assigneeKind: 'digital_worker',
    assigneeId: worker.id,
    assignedBy: 'owner-policy',
    scope: { dataClass: 'project-internal', resourceIds: ['repo-main'] }
  })
  assertEqual(allowed.status, 'active', 'allowed scoped Assignment succeeds')
  const ipcChecks = await exerciseIpcPolicyFlow({ invoke, projectStore, store: restarted, role, worker })
  const uiChecks = exerciseStudioPolicyModel({
    React,
    ReactDomServer,
    studioForms,
    studioModel,
    worker,
    role
  })
  assertAcceptancePolicyBehavior()

  console.log(JSON.stringify({
    status: 'PASS',
    workerId: worker.id,
    assignmentId: allowed.id,
    checks: [
      'native-role-and-worker-recruitment',
      'no-external-agent-cli-production-path',
      'complete-policy-persistence',
      'restart-policy-recovery',
      'assignment-policy-fail-closed',
      'allowed-assignment-succeeds',
      ...ipcChecks,
      ...uiChecks,
      'workflow-acceptance-policy-behavior'
    ]
  }, null, 2))
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compileDomain() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/digital-worker/index.ts',
    'src/main/project-workspace/index.ts',
    'src/main/ipc/digital-worker-handlers.ts',
    'src/renderer/src/components/studio/digital-worker-studio-model.ts',
    'src/renderer/src/components/studio/DigitalWorkerForms.tsx',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--jsx', 'react-jsx',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop',
    '--strict'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function assertNativeRecruitmentBoundary() {
  const files = [
    ...sourceFiles(path.join(repoRoot, 'src', 'main', 'digital-worker')),
    path.join(repoRoot, 'src', 'main', 'ipc', 'digital-worker-handlers.ts'),
    path.join(repoRoot, 'src', 'preload', 'digital-worker.ts'),
    ...sourceFiles(path.join(repoRoot, 'src', 'renderer', 'src', 'components', 'studio'))
      .filter((file) => path.basename(file).toLowerCase().includes('digitalworker'))
  ]
  const source = files.map((file) => readFileSync(file, 'utf8')).join('\n')
  for (const pattern of [
    /node:child_process/,
    /\b(?:spawn|execFile|fork)\s*\(/,
    /registerEngine\s*\(/,
    /(?:claude|codex|aider|cursor|goose)[-_ ]?(?:cli|process|binary)/i
  ]) {
    assert(!pattern.test(source), `native recruitment production path matched forbidden external Agent pattern ${pattern}`)
  }
}

async function exerciseIpcPolicyFlow({ invoke, projectStore, store, role, worker }) {
  const proposed = await store.createDigitalWorker({
    id: 'worker-ipc-permissive',
    projectId: worker.projectId,
    roleTemplateId: role.id,
    displayName: 'IPC permissive worker'
  })
  const permissive = await store.activateDigitalWorker(proposed.id, {
    expectedRevision: proposed.revision
  })
  const original = await invoke('createDigitalWorkerAssignment', {
    input: {
      id: 'assignment-ipc-permissive',
      projectId: worker.projectId,
      workItemId: 'work-ipc-policy',
      assigneeKind: 'digital_worker',
      assigneeId: permissive.id,
      assignedBy: 'owner-policy',
      scope: { dataClass: 'public' }
    }
  })
  const itemBefore = await projectStore.getWorkItem(original.workItemId)
  assertEqual(itemBefore.owner?.id, permissive.id, 'IPC coordinator must write the initial WorkItem owner')

  await assertPolicyDenied(invoke('reassignDigitalWorkerAssignment', {
    input: {
      currentAssignmentId: original.id,
      nextInput: {
        id: 'assignment-ipc-denied',
        projectId: worker.projectId,
        workItemId: original.workItemId,
        assigneeKind: 'digital_worker',
        assigneeId: worker.id,
        assignedBy: 'owner-policy',
        scope: { dataClass: 'credential', resourceIds: ['repo-main'] }
      },
      expectedRevision: original.revision,
      reason: 'must reject before owner write'
    }
  }), 'IPC reassignment outside policy')
  const itemAfterDenied = await projectStore.getWorkItem(original.workItemId)
  assertEqual(itemAfterDenied.owner?.id, permissive.id, 'denied IPC reassignment must preserve the previous owner')
  assertEqual(itemAfterDenied.revision, itemBefore.revision, 'denied IPC reassignment must not mutate WorkItem revision')

  const allowedScope = { dataClass: 'project-internal', resourceIds: ['repo-main'] }
  const reassigned = await invoke('reassignDigitalWorkerAssignment', {
    input: {
      currentAssignmentId: original.id,
      nextInput: {
        id: 'assignment-ipc-allowed',
        projectId: worker.projectId,
        workItemId: original.workItemId,
        assigneeKind: 'digital_worker',
        assigneeId: worker.id,
        assignedBy: 'owner-policy',
        scope: allowedScope
      },
      expectedRevision: original.revision,
      reason: 'scope satisfies policy'
    }
  })
  assertDeepEqual(reassigned.assigned.scope, allowedScope, 'IPC Assignment scope must roundtrip through coordinator')
  assertEqual(
    (await projectStore.getWorkItem(original.workItemId)).owner?.id,
    worker.id,
    'allowed IPC reassignment must atomically update the WorkItem owner'
  )
  return [
    'ipc-coordinator-policy-denial-before-owner-write',
    'ipc-assignment-scope-roundtrip'
  ]
}

function exerciseStudioPolicyModel({ React, ReactDomServer, studioForms, studioModel, worker, role }) {
  assertDeepEqual(
    studioModel.dataScopeLabels(worker),
    ['需显式声明', '允许: project-internal', '禁止: credential', 'Resource: repo-main'],
    'studio model must render persisted data scope'
  )
  assertDeepEqual(
    studioModel.acceptancePolicyLabels(worker),
    ['Evidence >= 2', '需用户确认'],
    'studio model must render persisted acceptance policy'
  )
  const markup = ReactDomServer.renderToStaticMarkup(React.createElement(studioForms.HireWorkerForm, {
    projectId: worker.projectId,
    roles: [role],
    busy: false,
    onCancel: () => undefined,
    onSubmit: async () => true
  }))
  for (const label of ['允许的数据类', '禁止的数据类', '允许的 Resource ID', '最少 Evidence 数', '验收需用户确认']) {
    assert(markup.includes(label), `rendered recruitment form must expose ${label}`)
  }
  return ['studio-policy-model-and-form-render']
}

function assertAcceptancePolicyBehavior() {
  const output = execFileSync(process.execPath, [
    path.join(repoRoot, 'scripts', 'acceptance-gate-smoke.mjs')
  ], { cwd: repoRoot, encoding: 'utf8' })
  assert(output.includes('acceptance gate smoke: PASS'), 'Workflow Acceptance policy behavior must pass')
}

function installElectronShim() {
  const shimDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(shimDir, { recursive: true })
  writeFileSync(path.join(shimDir, 'index.js'), `
const handlers = new Map()
const mainFrame = { url: process.env.CAOGEN_RECRUITMENT_TEST_RENDERER_URL }
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
      return process.env.CAOGEN_RECRUITMENT_TEST_USER_DATA
    }
  },
  BrowserWindow: { getAllWindows: () => [{ webContents: trustedSender }] },
  ipcMain: {
    handle(channel, handler) {
      if (handlers.has(channel)) throw new Error('duplicate IPC handler: ' + channel)
      handlers.set(channel, handler)
    }
  }
}
`)
}

function sourceFiles(root) {
  const result = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) result.push(...sourceFiles(file))
    else if (/\.(?:ts|tsx)$/.test(entry.name)) result.push(file)
  }
  return result
}

async function assertPolicyDenied(promise, label) {
  try {
    await promise
  } catch (error) {
    assertEqual(error?.code, 'POLICY_DENIED', `${label} error code`)
    return
  }
  throw new Error(`${label} must fail closed`)
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assertDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
