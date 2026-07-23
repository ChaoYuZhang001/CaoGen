#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const startedAt = new Date().toISOString()
const runId = startedAt.replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'supervisor-taskrun-bridge-smoke')
const reportDir = path.join(reportRoot, runId)
const reportPath = path.join(reportDir, 'report.json')
const latestPath = path.join(reportRoot, 'latest.json')
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-supervisor-bridge-'))
const outDir = path.join(tempRoot, 'compiled')
const rootDir = path.join(tempRoot, 'user-data')
let smokeResult
let failure

try {
  compileSources()
  installElectronStub()
  const bridge = await import(pathToFileURL(path.join(outDir, 'main/task/supervisor-taskrun-bridge.js')).href)
  const workspace = await import(pathToFileURL(path.join(outDir, 'main/project-workspace/store.js')).href)
  const commandsModule = await import(pathToFileURL(path.join(outDir, 'main/project-workspace/command-service.js')).href)
  const supervisorModule = await import(pathToFileURL(path.join(outDir, 'main/task/supervisor-state.js')).href)
  const snapshotModule = await import(pathToFileURL(path.join(outDir, 'main/task/task-snapshot.js')).href)
  const activationModule = await import(pathToFileURL(path.join(outDir, 'main/session-domain-activation.js')).href)

  mkdirSync(rootDir, { recursive: true })
  const store = await new workspace.ProjectWorkspaceStore(rootDir).open()
  const project = await store.createWorkspace({ id: 'bridge-project', name: 'Bridge Project', kind: 'software' })
  const goal = await store.createGoal({
    id: 'bridge-goal', projectId: project.id, title: 'Bridge Goal', objective: 'Bind a TaskRun'
  })
  const commands = commandsModule.createProjectWorkspaceCommandService(store, { rootDir })
  const workItem = await commands.createWorkItem({
    id: 'bridge-work-item', projectId: project.id, goalId: goal.id, title: 'Bridge WorkItem'
  })
  const meta = {
    id: 'bridge-session', title: 'Bridge Session', cwd: rootDir, model: 'fixture-model',
    providerId: 'fixture-provider', permissionMode: 'default', status: 'running',
    sdkSessionId: 'bridge-sdk-session', costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, contextTokens: 0,
    createdAt: 1, childTaskId: 'bridge-run', projectId: project.id, workspaceId: project.id,
    goalId: goal.id, workItemId: workItem.id
  }
  const run = taskRun('bridge-run', meta.id)
  const supervisor = new supervisorModule.SupervisorStateStore(rootDir)

  await activationModule.prepareSessionDomainOwnershipForActivation(meta, rootDir)
  const snapshot = snapshotModule.buildTaskSnapshot({
    meta,
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run,
    now: 1_000
  })
  await snapshotModule.saveTaskSnapshot(snapshot, rootDir)

  const first = await bridge.ensureSupervisorRunBinding(meta, run, { rootDir, store: supervisor })
  assert.equal(first.disposition, 'attached')
  assert.equal(first.supervisorRun?.id, run.id)
  assert.deepEqual((await store.getWorkItem(workItem.id)).runRefs, [run.id])

  const second = await bridge.ensureSupervisorRunBinding(meta, run, { rootDir, store: supervisor })
  assert.equal(second.disposition, 'existing')
  assert.equal(second.supervisorRun?.revision, first.supervisorRun?.revision)
  assert.deepEqual((await store.getWorkItem(workItem.id)).runRefs, [run.id])
  assert.equal((await supervisor.listRuns()).length, 1)

  await assert.rejects(
    bridge.ensureSupervisorRunBinding({ ...meta, id: 'different-session' }, run, { rootDir, store: supervisor }),
    /crosses session ownership/
  )

  const unresolved = {
    ...run,
    status: 'executing',
    effects: [{ id: 'effect-1', status: 'executing' }]
  }
  assert.equal(
    bridge.classifySupervisorRestart({ supervisor: { status: 'running' }, taskRun: unresolved }).disposition,
    'waiting_reconciliation'
  )
  assert.equal(
    bridge.classifySupervisorRestart({ supervisor: { status: 'running' }, taskRun: run }).disposition,
    'retryable'
  )
  assert.equal(
    bridge.classifySupervisorRestart({ supervisor: { status: 'waiting_approval' }, taskRun: run }).disposition,
    'manual_approval'
  )
  assert.equal(
    bridge.classifySupervisorRestart({ supervisor: { status: 'completed' }, taskRun: run }).disposition,
    'terminal'
  )

  const result = {
    status: 'PASS',
    workItemRunRefs: (await store.getWorkItem(workItem.id)).runRefs,
    supervisorRuns: (await supervisor.listRuns()).length,
    classifications: ['waiting_reconciliation', 'retryable', 'manual_approval', 'terminal']
  }
  smokeResult = result
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  failure = serializeError(error)
  throw error
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
  writeReport({
    schemaVersion: 1,
    status: smokeResult ? 'passed' : 'failed',
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    gate: 'test:supervisor-taskrun-bridge',
    result: smokeResult ?? null,
    error: failure,
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version
    }
  })
}

function taskRun(id, sessionId) {
  const now = 1_000
  return {
    schemaVersion: 1,
    id,
    sessionId,
    taskId: id,
    status: 'executing',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    steps: [],
    toolExecutions: [],
    effects: []
  }
}

function compileSources() {
  mkdirSync(outDir, { recursive: true })
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules/typescript/bin/tsc'),
    'src/main/task/supervisor-taskrun-bridge.ts',
    'src/main/session-domain-activation.ts',
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
  writeFileSync(path.join(electronDir, 'index.js'), `module.exports = {
  app: { getPath: () => ${JSON.stringify(rootDir)} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value) => Buffer.from(String(value), 'utf8'),
    decryptString: (value) => Buffer.from(value).toString('utf8')
  },
  powerSaveBlocker: { start: () => 1, stop: () => undefined, isStarted: () => false }
}\n`)
}

function writeReport(report) {
  try {
    mkdirSync(reportDir, { recursive: true })
    const body = `${JSON.stringify({
      ...report,
      reportDir: path.relative(repoRoot, reportDir),
      reportPath: path.relative(repoRoot, reportPath)
    }, null, 2)}\n`
    writeFileSync(reportPath, body, 'utf8')
    writeFileSync(latestPath, body, 'utf8')
  } catch (error) {
    console.error(`Supervisor TaskRun bridge report could not be written: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    code: error && typeof error === 'object' && 'code' in error ? error.code : undefined
  }
}
