#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-acceptance-artifact-unknown-'))
const outDir = path.join(tempRoot, 'compiled')
const rootDir = path.join(tempRoot, 'user-data')
const cwd = path.join(tempRoot, 'workspace')
const reportRoot = path.join(repoRoot, 'test-results', 'acceptance-artifact-unknown-result')
const reportDir = path.join(reportRoot, runId)
const require = createRequire(import.meta.url)
const report = {
  schemaVersion: 1,
  gate: 'test:acceptance-artifact-unknown-result',
  runId,
  status: 'failed',
  sourceRevision: git(['rev-parse', 'HEAD']),
  worktreeStatusCount: git(['status', '--porcelain']).split('\n').filter(Boolean).length,
  checks: [],
  failures: []
}

process.env.CAOGEN_TEST_USER_DATA = rootDir
process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter)
require('node:module').Module._initPaths()

try {
  mkdirSync(rootDir, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  compileSources()
  installElectronStub()
  const modules = await loadModules()
  await runUnknownArtifactResultCase(modules)
  report.status = 'passed'
} catch (error) {
  report.failures.push({
    code: typeof error?.code === 'string' ? error.code : 'ACCEPTANCE_ARTIFACT_UNKNOWN_RESULT_FAILED',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    fingerprint: sha256(error instanceof Error ? error.stack ?? error.message : String(error))
  })
  process.exitCode = 1
} finally {
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  rmSync(tempRoot, { recursive: true, force: true })
}

console.log(JSON.stringify({
  status: report.status,
  runId,
  checks: report.checks.length,
  failures: report.failures,
  reportDir
}, null, 2))

async function runUnknownArtifactResultCase({ gateway, snapshot, registry, effectRuntime, workflow, lifecycle, storeApi, commandApi }) {
  const projectId = 'unknown-result-project'
  const goalId = 'unknown-result-goal'
  const workItemId = 'unknown-result-work-item'
  const acceptanceId = 'unknown-result-acceptance'
  const sourceSessionId = 'unknown-result-source'
  const operationId = 'acceptance-artifact-unknown-result'

  const store = await storeApi.openProjectWorkspaceStore(rootDir)
  await store.createWorkspace({ id: projectId, name: 'Unknown result project', kind: 'software' })
  const commands = commandApi.createProjectWorkspaceCommandService(store, { rootDir })
  await commands.reconcileShadowProjection()
  await commands.createGoal({
    id: goalId,
    projectId,
    title: 'Verify an external artifact before delivery',
    objective: 'An unknown provider result must never become a completed delivery',
    status: 'running'
  })
  const createdWorkItem = await commands.createWorkItem({
    id: workItemId,
    projectId,
    goalId,
    type: 'coding',
    title: 'External artifact verification',
    status: 'verifying',
    acceptanceSpec: [{ id: 'artifact-criterion', criterion: 'external artifact is verified', required: true }]
  })
  assert.equal((await store.getWorkItem(workItemId))?.id, createdWorkItem.id)
  const acceptance = await workflow.saveWorkflowAcceptance({
    id: acceptanceId,
    projectId,
    goalId,
    workItemId,
    criteria: ['external artifact is verified']
  }, rootDir)
  assert.equal((await store.getWorkItem(workItemId))?.id, workItemId)
  assert.equal(acceptance.status, 'pending')

  let callbackCount = 0
  const outcome = await gateway.executeInteractiveOperationEffect({
    rootDir,
    operationId,
    source: 'session_lifecycle',
    kind: 'media_generation',
    title: 'External artifact generation with unknown result',
    sourceSessionId,
    projectId,
    workspaceId: projectId,
    goalId,
    workItemId,
    cwd,
    toolName: 'unknown_external_artifact',
    toolInput: { operation: 'generate', artifactKind: 'video', requestId: 'unknown-result-request' },
    execute: async () => {
      callbackCount += 1
      return { acknowledged: false, reason: 'provider response was lost after execution began' }
    },
    isSuccess: (result) => result.acknowledged === true,
    resultSummary: () => 'provider result was not trustworthy'
  })

  assert.equal(outcome.status, 'waiting_reconciliation')
  assert.equal(callbackCount, 1)
  assert(typeof outcome.snapshotId === 'string' && outcome.snapshotId.length > 0)
  assert(typeof outcome.effectId === 'string' && outcome.effectId.length > 0)
  report.checks.push({ id: 'unknown-result-enters-reconciliation', status: 'passed' })

  const initialSnapshot = await snapshot.getTaskSnapshot(outcome.snapshotId, rootDir)
  assert(initialSnapshot?.run)
  assert.equal(initialSnapshot.run.status, 'waiting_reconciliation')
  const initialEffect = initialSnapshot.run.effects?.find((effect) => effect.id === outcome.effectId)
  assert.equal(initialEffect?.status, 'waiting_reconciliation')
  assert.equal(initialEffect?.target?.kind, 'unsupported')
  report.checks.push({ id: 'task-run-and-effect-are-blocked', status: 'passed' })

  const initialLedger = await workflow.listPersistedWorkflowLedger({ projectId, limit: 200 }, rootDir)
  const initialRun = initialLedger.runs.items.find((run) => run.id === initialSnapshot.run.id)
  const initialAcceptance = initialLedger.acceptances.items.find((item) => item.id === acceptanceId)
  const initialWorkItem = await store.getWorkItem(workItemId)
  assert.equal(initialRun?.status, 'waiting_reconciliation')
  assert.equal(initialRun?.acceptanceId, acceptanceId)
  assert.equal(initialAcceptance?.status, 'pending')
  assert.deepEqual(initialAcceptance?.evidenceRefs, [])
  assert.equal(initialWorkItem?.status, 'verifying')
  assert(initialWorkItem?.runRefs.includes(initialSnapshot.run.id))
  assert.deepEqual(initialWorkItem?.artifactRefs, [])
  report.checks.push({ id: 'canonical-acceptance-and-work-item-stay-nonterminal', status: 'passed' })

  const outputArtifact = await lifecycle.getPersistedArtifactLifecycle(
    'unknown-result-output-artifact',
    rootDir
  )
  assert.equal(outputArtifact, null, 'unknown results must not create an Artifact lifecycle')

  registry.taskRuntimeRegistry.delete(initialSnapshot.run.sessionId)
  const reconciled = await effectRuntime.reconcilePersistedTaskSnapshot(initialSnapshot, rootDir)
  assert(reconciled.run)
  assert.equal(reconciled.run.status, 'waiting_reconciliation')
  assert.equal(reconciled.run.effects?.find((effect) => effect.id === outcome.effectId)?.status, 'waiting_reconciliation')
  const persistedAfterRecovery = await snapshot.getTaskSnapshot(outcome.snapshotId, rootDir)
  assert(persistedAfterRecovery?.run)
  assert.equal(persistedAfterRecovery.run.status, 'waiting_reconciliation')
  assert.equal(callbackCount, 1, 'reconciliation must never replay the external callback')
  report.checks.push({ id: 'fresh-process-reconciliation-preserves-recovery-entry', status: 'passed' })

  const recoveredLedger = await workflow.listPersistedWorkflowLedger({ projectId, limit: 200 }, rootDir)
  const recoveredAcceptance = recoveredLedger.acceptances.items.find((item) => item.id === acceptanceId)
  const recoveredWorkItem = await store.getWorkItem(workItemId)
  assert.equal(recoveredAcceptance?.status, 'pending')
  assert.deepEqual(recoveredAcceptance?.evidenceRefs, [])
  assert.equal(recoveredWorkItem?.status, 'verifying')
  assert.deepEqual(recoveredWorkItem?.artifactRefs, [])
  const recoveredOutputArtifact = await lifecycle.getPersistedArtifactLifecycle(
    'unknown-result-output-artifact',
    rootDir
  )
  assert.equal(recoveredOutputArtifact, null)
  report.checks.push({ id: 'recovery-does-not-create-artifact-or-false-pass', status: 'passed' })

  report.summary = {
    operationId,
    snapshotId: outcome.snapshotId,
    effectId: outcome.effectId,
    canonicalRunId: initialSnapshot.run.id,
    acceptanceStatusBeforeAndAfter: 'pending',
    workItemStatusBeforeAndAfter: 'verifying',
    artifactCountCreated: 0,
    callbackCount
  }
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/task/operation-effect-gateway.ts',
    'src/main/task/workflow-ledger-api.ts',
    'src/main/task/artifact-lifecycle-api.ts',
    'src/main/project-workspace/store.ts',
    'src/main/project-workspace/command-service.ts',
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

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'),
    `export const app = { getPath: () => ${JSON.stringify(rootDir)} }\n`, 'utf8')
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n', 'utf8')
}

async function loadModules() {
  const load = (relativePath) => import(pathToFileURL(path.join(outDir, relativePath)).href)
  return {
    gateway: await load('main/task/operation-effect-gateway.js'),
    snapshot: await load('main/task/task-snapshot.js'),
    registry: await load('main/task/task-runtime-registry.js'),
    effectRuntime: await load('main/task/effect-runtime.js'),
    workflow: await load('main/task/workflow-ledger-api.js'),
    lifecycle: await load('main/task/artifact-lifecycle-api.js'),
    storeApi: await load('main/project-workspace/store.js'),
    commandApi: await load('main/project-workspace/command-service.js')
  }
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
