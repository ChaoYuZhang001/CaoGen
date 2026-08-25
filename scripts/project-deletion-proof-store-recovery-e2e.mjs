#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = process.cwd()
const scriptPath = fileURLToPath(import.meta.url)
const require = createRequire(import.meta.url)
const workerMode = process.argv[2] === '--worker'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'project-deletion-proof-store-recovery')
const reportDir = path.join(reportRoot, runId)
const tempRoot = workerMode ? '' : mkdtempSync(path.join(tmpdir(), 'caogen-project-deletion-proof-recovery-'))
const compiledDir = path.join(tempRoot, 'compiled')

if (workerMode) await runWorker()
else await runParent()

async function runParent() {
  let report
  try {
    compileSources()
    const proofModule = path.join(compiledDir, 'main', 'data-lifecycle', 'project-deletion-proof-store.js')
    const backupModule = path.join(compiledDir, 'main', 'data-lifecycle', 'project-deletion-backup-store.js')
    const exportModule = path.join(compiledDir, 'main', 'project-aggregate', 'project-aggregate-export.js')
    const strongKill = []
    for (const checkpoint of ['after_write', 'after_file_sync', 'after_rename']) {
      strongKill.push(await verifyStrongKill(proofModule, backupModule, exportModule, checkpoint))
    }
    report = {
      schemaVersion: 1,
      gate: 'test:project-deletion-proof-store-recovery',
      runId,
      status: 'passed',
      verification: 'runtime_store_verified',
      sourceRevision: git(['rev-parse', 'HEAD']),
      worktreeStatusCount: gitStatusCount(),
      writer: 'src/main/data-lifecycle/project-deletion-proof-store.ts',
      scope: 'Digest-bound Project deletion terminal proof publication and recovery',
      faults: {
        strong_kill: { status: 'verified', scenarios: strongKill },
        network_unknown_result: { status: 'verified', scenario: await verifyUnknownResult(proofModule, backupModule, exportModule) },
        duplicate_idempotency: { status: 'verified', scenario: await verifyDuplicate(proofModule, backupModule, exportModule) },
        out_of_order: { status: 'verified', scenario: await verifyStaleWriter(proofModule, backupModule, exportModule) }
      }
    }
  } catch (error) {
    report = {
      schemaVersion: 1,
      gate: 'test:project-deletion-proof-store-recovery',
      runId,
      status: 'failed',
      verification: 'not_verified',
      sourceRevision: git(['rev-parse', 'HEAD']),
      worktreeStatusCount: gitStatusCount(),
      writer: 'src/main/data-lifecycle/project-deletion-proof-store.ts',
      error: serializeError(error)
    }
    process.exitCode = 1
  } finally {
    mkdirSync(reportDir, { recursive: true })
    const body = `${JSON.stringify(report, null, 2)}\n`
    writeFileSync(path.join(reportDir, 'report.json'), body, 'utf8')
    writeFileSync(path.join(reportRoot, 'latest.json'), body, 'utf8')
    rmSync(tempRoot, { recursive: true, force: true })
  }
  console.log(JSON.stringify({
    status: report.status,
    verification: report.verification,
    sourceRevision: report.sourceRevision,
    verifiedFaults: report.status === 'passed' ? 4 : 0,
    reportPath: path.relative(repoRoot, path.join(reportDir, 'report.json')),
    error: report.error
  }, null, 2))
}

async function verifyStrongKill(proofModule, backupModule, exportModule, checkpoint) {
  const root = scenarioRoot(`strong-kill-${checkpoint}`)
  const exit = await invokeWorker(proofModule, backupModule, exportModule, root, checkpoint, true, 'alpha')
  assert.equal(exit.signal, 'SIGKILL')
  const input = createInput(backupModule, exportModule, root, 'alpha')
  const store = createStore(proofModule, root)
  const receipt = store.write(input)
  assert.deepEqual(temporaryFiles(root), [])
  if (checkpoint === 'after_rename') {
    const replay = store.write(input)
    assert.deepEqual(fileIdentity(receipt.path), fileIdentity(replay.path))
  }
  return {
    checkpoint,
    signal: exit.signal,
    publishedBeforeKill: checkpoint === 'after_rename',
    recovered: true,
    orphanTemporaryCount: 0,
    replayByteStable: checkpoint === 'after_rename'
  }
}

async function verifyUnknownResult(proofModule, backupModule, exportModule) {
  const root = scenarioRoot('unknown-result')
  const exit = await invokeWorker(proofModule, backupModule, exportModule, root, 'post_directory_sync_throw', false, 'alpha')
  assert.equal(exit.code, 2)
  assert.equal(exit.message?.code, 'EUNKNOWNRESULT')
  const input = createInput(backupModule, exportModule, root, 'alpha')
  const before = findProofFile(root)
  assert(before)
  const replay = createStore(proofModule, root).write(input)
  assert.deepEqual(fileIdentity(replay.path), fileIdentity(before))
  assert.deepEqual(temporaryFiles(root), [])
  return { errorCode: exit.message.code, replayByteStable: true, recovered: true, orphanTemporaryCount: 0 }
}

async function verifyDuplicate(proofModule, backupModule, exportModule) {
  const root = scenarioRoot('duplicate')
  const input = createInput(backupModule, exportModule, root, 'alpha')
  const store = createStore(proofModule, root)
  const first = store.write(input)
  const before = fileIdentity(first.path)
  const second = store.write(input)
  assert.deepEqual(fileIdentity(second.path), before)
  assert.deepEqual(second, first)
  assert.deepEqual(temporaryFiles(root), [])
  return { operationCount: 1, revisionStable: true, identityStable: true, canonicalDigest: before.digest }
}

async function verifyStaleWriter(proofModule, backupModule, exportModule) {
  const root = scenarioRoot('stale-writer')
  const input = createInput(backupModule, exportModule, root, 'alpha')
  const store = createStore(proofModule, root)
  const first = store.write(input)
  const before = fileIdentity(first.path)
  await assert.rejects(
    Promise.resolve().then(() => store.write({ ...input, expectedWorkspaceRevision: input.expectedWorkspaceRevision + 1 })),
    /frozen deletion facts/
  )
  assert.deepEqual(fileIdentity(first.path), before)
  return { rejectedStaleFacts: true, byteStable: true, finalDigest: before.digest }
}

function invokeWorker(proofModule, backupModule, exportModule, root, checkpoint, killAtCheckpoint, marker) {
  return new Promise((resolve, reject) => {
    const child = fork(scriptPath, ['--worker'], {
      cwd: repoRoot,
      execArgv: [],
      env: {
        ...process.env,
        CAOGEN_PROJECT_DELETION_PROOF_MODULE: proofModule,
        CAOGEN_PROJECT_DELETION_BACKUP_MODULE: backupModule,
        CAOGEN_PROJECT_AGGREGATE_EXPORT_MODULE: exportModule,
        CAOGEN_PROJECT_DELETION_PROOF_ROOT: root,
        CAOGEN_PROJECT_DELETION_PROOF_CHECKPOINT: checkpoint,
        CAOGEN_PROJECT_DELETION_PROOF_MARKER: marker
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    let message
    let settled = false
    const timeout = setTimeout(() => finish(new Error(`proof worker timed out at ${checkpoint}`)), 15_000)
    child.on('message', (value) => {
      message = value
      if (killAtCheckpoint && value?.type === 'checkpoint' && value.checkpoint === checkpoint) child.kill('SIGKILL')
    })
    child.on('error', finish)
    child.on('exit', (code, signal) => finish(null, { code, signal, message }))
    function finish(error, value) {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve(value)
    }
  })
}

async function runWorker() {
  const Module = require('node:module').Module
  const realFs = require('node:fs')
  const originalLoad = Module._load
  const root = requiredEnv('CAOGEN_PROJECT_DELETION_PROOF_ROOT')
  const checkpoint = requiredEnv('CAOGEN_PROJECT_DELETION_PROOF_CHECKPOINT')
  const descriptors = new Map()
  Module._load = function patchedLoad(request, owner, isMain) {
    if (request === 'node:fs') return faultFs(realFs, checkpoint, descriptors)
    return originalLoad.call(this, request, owner, isMain)
  }
  try {
    const proofModule = requiredEnv('CAOGEN_PROJECT_DELETION_PROOF_MODULE')
    const backupModule = requiredEnv('CAOGEN_PROJECT_DELETION_BACKUP_MODULE')
    const exportModule = requiredEnv('CAOGEN_PROJECT_AGGREGATE_EXPORT_MODULE')
    createStore(proofModule, root).write(createInput(
      backupModule,
      exportModule,
      root,
      requiredEnv('CAOGEN_PROJECT_DELETION_PROOF_MARKER')
    ))
    process.send?.({ type: 'completed' })
  } catch (error) {
    process.send?.({ type: 'error', code: error?.code, message: String(error?.message ?? error) })
    process.exitCode = 2
  } finally {
    Module._load = originalLoad
  }
}

function faultFs(realFs, checkpoint, descriptors) {
  return {
    ...realFs,
    openSync: (...args) => {
      const descriptor = realFs.openSync(...args)
      descriptors.set(descriptor, path.resolve(String(args[0])))
      return descriptor
    },
    closeSync: (descriptor) => {
      try { return realFs.closeSync(descriptor) } finally { descriptors.delete(descriptor) }
    },
    writeFileSync: (...args) => {
      const result = realFs.writeFileSync(...args)
      const opened = typeof args[0] === 'number' ? descriptors.get(args[0]) : path.resolve(String(args[0]))
      if (checkpoint === 'after_write' && opened?.includes('project-deletion-proofs') && opened.endsWith('.tmp')) pauseAt(checkpoint)
      return result
    },
    fsyncSync: (descriptor) => {
      const result = realFs.fsyncSync(descriptor)
      const opened = descriptors.get(descriptor)
      if (checkpoint === 'after_file_sync' && opened?.includes('project-deletion-proofs') && opened.endsWith('.tmp')) pauseAt(checkpoint)
      if (checkpoint === 'post_directory_sync_throw' && opened?.includes('project-deletion-proofs') &&
          !opened.endsWith('.json') && realFs.statSync(opened).isDirectory()) {
        throw Object.assign(new Error('injected proof unknown result'), { code: 'EUNKNOWNRESULT' })
      }
      return result
    },
    renameSync: (...args) => {
      const result = realFs.renameSync(...args)
      if (checkpoint === 'after_rename' && String(args[1]).includes('project-deletion-proofs')) pauseAt(checkpoint)
      return result
    }
  }
}

function pauseAt(checkpoint) {
  process.send?.({ type: 'checkpoint', checkpoint })
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}

function createStore(modulePath, root) {
  return new (require(modulePath).ProjectDeletionProofStore)(root)
}

function createInput(backupModule, exportModule, root, marker) {
  const operationId = 'project-delete-proof-request'
  const projectId = 'project-proof-recovery'
  const aggregate = createAggregate(exportModule, marker)
  const backup = new (require(backupModule).ProjectDeletionBackupStore)(root)
    .write(operationId, projectId, aggregate)
  const removed = {
    taskRuns: 0,
    workflowRuns: 0,
    workflowEvents: 0,
    taskEvidence: 0,
    conversationStreams: 0,
    conversationGenerations: 0,
    conversationEvents: 0
  }
  const withoutDigest = {
    schemaVersion: 1,
    seq: 1,
    operationId,
    projectId,
    removed,
    prevDigest: '0'.repeat(64)
  }
  return {
    operationId,
    projectId,
    expectedWorkspaceRevision: 1,
    backupPath: backup.path,
    backupDigest: backup.backupDigest,
    exportDigest: backup.exportDigest,
    sessionIds: [],
    sdkSessionIds: [],
    artifactBlobDigests: [],
    effectArtifactRefs: [],
    authorizedPurge: { ...withoutDigest, digest: sha256(JSON.stringify(withoutDigest)) },
    residuals: { residualRecords: 0 },
    externalResourcesBefore: []
  }
}

function createAggregate(exportModule, marker) {
  const { buildProjectAggregateExport } = require(exportModule)
  const projectId = 'project-proof-recovery'
  const identityDigest = sha256(`identity:${marker}`)
  const aggregateDigest = sha256(`aggregate:${marker}`)
  const snapshot = {
    schemaVersion: 1,
    format: 'caogen.project-aggregate.v1',
    projectId,
    identityDigest,
    projectRevision: 1,
    workspace: { id: projectId, name: `Proof ${marker}` },
    resources: [], goals: [], workItems: [], squads: [], members: [], invitations: [], comments: [],
    sharedApprovals: [], inboxReceipts: [], digitalWorkers: [], assignments: [], leases: [],
    workflow: { runs: [], artifacts: [], artifactEdges: [], artifactLocations: [], acceptances: [], evidenceLinks: [], taskEvidence: [], workflowEvidence: [] },
    memory: [], budgets: [], policies: [], audit: [], objectCounts: {}, objectDigests: {}, aggregateDigest, sanitized: true
  }
  const seal = {
    schemaVersion: 1,
    projectId,
    aggregateRevision: 1,
    projectRevision: 1,
    identityDigest,
    aggregateDigest,
    objectCounts: {},
    objectDigests: {},
    sealedAt: 1
  }
  return buildProjectAggregateExport(
    snapshot,
    seal,
    { roleTemplates: [] },
    { routines: [], runs: [] },
    { dependencies: [], milestones: [] },
    {
      schemaVersion: 1,
      sessionIds: [], sdkSessionIds: [], sessionHistory: [], activeSessions: [], sessionCreationJournal: [],
      taskPlans: [], sessionFiles: [], taskSnapshots: [], modelAttempts: [], artifactLifecycles: [], artifactPurges: [],
      artifactBlobs: [], runtimeDigest: sha256(`runtime:${marker}`)
    }
  )
}

function scenarioRoot(name) {
  const root = path.join(tempRoot, name)
  mkdirSync(root, { recursive: true })
  return root
}

function temporaryFiles(root) {
  const result = []
  const walk = (directory) => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(target)
      else if (entry.name.endsWith('.tmp')) result.push(target)
    }
  }
  walk(root)
  return result
}

function findProofFile(root) {
  const files = []
  const walk = (directory) => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(target)
      else if (entry.name.endsWith('.json')) files.push(target)
    }
  }
  walk(root)
  return files.find((file) => file.includes('project-deletion-proofs'))
}

function fileIdentity(file) {
  const info = statSync(file)
  return { device: String(info.dev), inode: String(info.ino), size: info.size, digest: sha256(readFileSync(file)) }
}

function sha256(value) { return createHash('sha256').update(value).digest('hex') }

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/data-lifecycle/project-deletion-proof-store.ts',
    'src/main/project-aggregate/project-aggregate-export.ts',
    '--outDir', compiledDir,
    '--rootDir', 'src',
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'pipe' })
}

function git(args) { try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim() } catch { return '' } }
function gitStatusCount() { return git(['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean).length }
function requiredEnv(name) { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value }
function serializeError(error) { return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { name: 'Error', message: String(error) } }
