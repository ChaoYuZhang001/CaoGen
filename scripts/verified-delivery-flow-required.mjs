#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-verified-delivery-'))
const outDir = path.join(tempRoot, 'compiled')
const rootDir = path.join(tempRoot, 'user-data')
const workspaceRoot = path.join(tempRoot, 'workspace')
const reportRoot = path.join(repoRoot, 'test-results', 'verified-delivery-flow')
const reportDir = path.join(reportRoot, runId)
const workerPath = fileURLToPath(new URL('./lib/verified-delivery-flow-worker.mjs', import.meta.url))

process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter)
require('node:module').Module._initPaths()

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
  mkdirSync(rootDir, { recursive: true })
  mkdirSync(workspaceRoot, { recursive: true })
  compileProductionSources()
  installElectronStub()
  runGate()
  report.status = 'passed'
} catch (error) {
  report.failures.push(sanitizedFailure(error))
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

function runGate() {
  runCheck('seed canonical staged workflow', 'seed')

  runCrashCheck('persist Artifact then strong-kill', 'create-artifact', { stage: 'research' })
  runCheck('fresh-process Artifact readback blocks handoff', 'probe', { checkpoint: 'artifact' })
  runCrashCheck('persist Evidence then strong-kill', 'create-evidence', { stage: 'research' })
  runCheck('fresh-process Evidence readback', 'probe', { checkpoint: 'evidence' })
  runCrashCheck('persist Acceptance then strong-kill', 'create-acceptance', { stage: 'research' })
  runCheck('fresh-process pending Acceptance blocks handoff', 'probe', { checkpoint: 'acceptance' })
  runCrashCheck('persist Evidence Link then strong-kill', 'create-link', { stage: 'research' })
  runCheck('fresh-process Link readback still blocks pending handoff', 'probe', { checkpoint: 'link' })
  runCheck('pass byte-backed Acceptance', 'pass-acceptance', { stage: 'research' })
  runStageHandoffCrashCheck('persist stage prepared then strong-kill', 'research', 'prepared')
  runCheck('fresh-process recovers prepared stage operation', 'recover-stage-handoff', {
    stage: 'research', handoffCheckpoint: 'prepared'
  })
  runCheck('fresh-process attachment and prompt handoff', 'probe', { checkpoint: 'attachment' })

  runStageHandoffCrashCheck('persist input edges then strong-kill', 'requirements', 'input_edges')
  runCheck('fresh-process recovers input-edge checkpoint', 'recover-stage-handoff', {
    stage: 'requirements', handoffCheckpoint: 'input_edges'
  })
  runStageHandoffCrashCheck(
    'persist WorkItem Artifact reference then strong-kill',
    'design',
    'workitem_reference'
  )
  runCheck('fresh-process recovers WorkItem-reference checkpoint', 'recover-stage-handoff', {
    stage: 'design', handoffCheckpoint: 'workitem_reference'
  })
  runStageHandoffCrashCheck('persist stage committed then strong-kill', 'implementation', 'committed')
  runCheck('fresh-process preserves committed stage without replay', 'recover-stage-handoff', {
    stage: 'implementation', handoffCheckpoint: 'committed'
  })
  runCheck('review stage receives implementation Artifact without user restatement', 'prepare-review')
  runCheck('failed review creates repair WorkItem and Acceptance', 'fail-review')
  runCheck('fresh-process failed Acceptance excludes its Artifact', 'probe', { checkpoint: 'failed-review' })
  runCheck('repair produces v2, rejects tampered bytes, retests, and passes', 'repair-review')
  runCheck('fresh-process supersession history and repaired handoff', 'probe', {
    checkpoint: 'repaired-review'
  })
  runCheck('test stage consumes only current repaired Artifact', 'complete-stage', { stage: 'test' })
  runCheck('delivery stage consumes verified test Artifact', 'complete-stage', { stage: 'delivery' })

  const first = runCheck('fresh-process final ownership and Evidence readback', 'final-readback')
  const second = runCheck('second fresh-process readback is identical', 'final-readback')
  assert.deepEqual(second, first)
  report.summary = {
    ...first,
    strongKillCheckpoints: [
      'artifact',
      'evidence',
      'acceptance',
      'link',
      'stage_prepared',
      'stage_input_edges',
      'stage_workitem_reference',
      'stage_committed'
    ],
    strongKillBoundary: 'exact cross-Store stage checkpoints and production API boundaries',
    freshProcessReadbacks: 13,
    reportRedaction: 'production Studio Result export excludes raw Run error material'
  }
}

function runCheck(id, action, extra = {}) {
  const result = runWorker({ action, ...extra })
  report.checks.push({ id, status: 'passed' })
  return result
}

function runCrashCheck(id, action, extra = {}) {
  const result = runWorker({ action, ...extra, crashAfterCommit: true }, {
    expectStrongKill: true
  })
  report.checks.push({ id, status: 'passed', mode: 'strong_kill_after_commit' })
  return result
}

function runStageHandoffCrashCheck(id, stage, handoffCheckpoint) {
  const result = runWorker({
    action: 'crash-stage-handoff',
    stage,
    handoffCheckpoint
  }, {
    expectStrongKill: true,
    expectedCheckpoint: handoffCheckpoint
  })
  report.checks.push({
    id,
    status: 'passed',
    mode: 'strong_kill_at_stage_checkpoint',
    checkpoint: handoffCheckpoint
  })
  return result
}

function runWorker(input, options = {}) {
  const payload = Buffer.from(JSON.stringify({
    ...input,
    outDir,
    rootDir,
    workspaceRoot
  })).toString('base64url')
  const child = spawnSync(process.execPath, [workerPath, payload], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      CAOGEN_USER_DATA: rootDir,
      NODE_PATH: process.env.NODE_PATH
    },
    maxBuffer: 16 * 1024 * 1024
  })
  const response = parseWorkerResponse(child.stdout)
  const strongKillObserved = process.platform === 'win32'
    ? child.signal === null && child.status !== 0
    : child.signal === 'SIGKILL'
  const expectedCheckpoint = options.expectedCheckpoint ?? 'after_commit'
  if (options.expectStrongKill && strongKillObserved &&
      response.ok && response.checkpoint === expectedCheckpoint) {
    return { signal: child.signal, status: child.status, checkpoint: response.checkpoint }
  }
  if (options.expectStrongKill || child.status !== 0 || !response.ok) {
    if (process.env.CAOGEN_VERIFIED_DELIVERY_DEBUG === '1' && child.stderr) {
      process.stderr.write(child.stderr)
    }
    const error = new Error('verified-delivery worker failed')
    Object.assign(error, {
      code: response.failure?.code ?? (options.expectStrongKill
        ? 'VERIFIED_DELIVERY_STRONG_KILL_NOT_OBSERVED'
        : 'VERIFIED_DELIVERY_WORKER_FAILED'),
      workerFingerprint: response.failure?.fingerprint
    })
    throw error
  }
  return response.result
}

function parseWorkerResponse(stdout) {
  try {
    return JSON.parse(stdout)
  } catch {
    return {
      ok: false,
      failure: {
        code: 'VERIFIED_DELIVERY_WORKER_PROTOCOL_FAILED',
        fingerprint: sha256(stdout || 'empty-worker-output')
      }
    }
  }
}

function compileProductionSources() {
  const compiler = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
  const result = spawnSync(process.execPath, [
    compiler,
    'src/main/task/task-snapshot.ts',
    'src/main/task/task-run.ts',
    'src/main/task/artifact-lifecycle-api.ts',
    'src/main/task/workflow-ledger-api.ts',
    'src/main/task/workflow-stage-handoff.ts',
    'src/main/task/workflow-acceptance-repair-coordinator.ts',
    'src/main/project-workspace/store.ts',
    'src/main/project-workspace/command-service.ts',
    'src/main/project-aggregate/project-aggregate-factory.ts',
    'src/main/studio-result/studio-result-service.ts',
    'src/main/ipc/workflow-ledger-handlers.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop',
    '--strict'
  ], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (result.status !== 0) {
    const error = new Error('verified-delivery production source compilation failed')
    Object.assign(error, { code: 'VERIFIED_DELIVERY_COMPILE_FAILED' })
    throw error
  }
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), [
    // Keep the app singleton's own startup store separate from the explicit
    // fixture root passed to each action; this prevents auto-repair startup
    // from racing the staged-flow protocol.
    `export const app = { getPath: () => ${JSON.stringify(path.join(rootDir, 'app-user-data'))}, focus() {} }`,
    'export const ipcMain = { handle() {} }',
    'export const BrowserWindow = { getAllWindows: () => [] }',
    'export const dialog = {}',
    'export const Notification = class { static isSupported() { return false } once() {} show() {} }'
  ].join('\n') + '\n', 'utf8')
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n', 'utf8')
}

function sanitizedFailure(error) {
  const material = error instanceof Error ? error.stack ?? error.message : String(error)
  return {
    code: typeof error?.code === 'string' ? error.code : 'VERIFIED_DELIVERY_GATE_FAILED',
    fingerprint: typeof error?.workerFingerprint === 'string'
      ? error.workerFingerprint
      : sha256(material)
  }
}

function gitOutput(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : 'unknown'
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
