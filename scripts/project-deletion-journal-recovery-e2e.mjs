#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
const reportRoot = path.join(repoRoot, 'test-results', 'project-deletion-journal-recovery')
const reportDir = path.join(reportRoot, runId)
const tempRoot = workerMode ? '' : mkdtempSync(path.join(tmpdir(), 'caogen-project-deletion-journal-recovery-'))
const compiledDir = path.join(tempRoot, 'compiled')

if (workerMode) await runWorker()
else await runParent()

async function runParent() {
  let report
  try {
    compileSources()
    const modulePath = path.join(compiledDir, 'main', 'data-lifecycle', 'project-deletion-journal.js')
    const strongKill = []
    for (const checkpoint of ['after_write', 'after_file_sync', 'after_rename']) {
      strongKill.push(await verifyStrongKill(modulePath, checkpoint))
    }
    report = {
      schemaVersion: 1,
      gate: 'test:project-deletion-journal-recovery',
      runId,
      status: 'passed',
      verification: 'runtime_store_verified',
      sourceRevision: git(['rev-parse', 'HEAD']),
      worktreeStatusCount: gitStatusCount(),
      writer: 'src/main/data-lifecycle/project-deletion-journal.ts',
      scope: 'Project deletion journal publication and serialized recovery',
      faults: {
        strong_kill: { status: 'verified', scenarios: strongKill },
        network_unknown_result: { status: 'verified', scenario: await verifyUnknownResult(modulePath) },
        duplicate_idempotency: { status: 'verified', scenario: await verifyDuplicate(modulePath) },
        out_of_order: { status: 'verified', scenario: await verifyOutOfOrder(modulePath) }
      }
    }
  } catch (error) {
    report = {
      schemaVersion: 1,
      gate: 'test:project-deletion-journal-recovery',
      runId,
      status: 'failed',
      verification: 'not_verified',
      sourceRevision: git(['rev-parse', 'HEAD']),
      worktreeStatusCount: gitStatusCount(),
      writer: 'src/main/data-lifecycle/project-deletion-journal.ts',
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

async function verifyStrongKill(modulePath, checkpoint) {
  const root = scenarioRoot(`strong-kill-${checkpoint}`)
  const exit = await invokeWorker(modulePath, root, checkpoint, true)
  assert.equal(exit.signal, 'SIGKILL')
  const journal = createJournal(modulePath, root)
  const before = existsSync(journal.filePath) ? fileIdentity(journal.filePath) : undefined
  const recovered = await journal.begin(fixture())
  const after = fileIdentity(journal.filePath)
  assert.equal(recovered.operationId, 'project-delete-recovery-request')
  assert.deepEqual(temporaryFiles(root), [])
  assert.equal(existsSync(lockPath(journal.filePath)), false)
  if (checkpoint === 'after_rename') {
    assert(before)
    assert.deepEqual(after, before)
  } else {
    assert.equal(before, undefined)
  }
  return {
    checkpoint,
    signal: exit.signal,
    publishedBeforeKill: checkpoint === 'after_rename',
    recoveredPhase: recovered.phase,
    journalDigest: after.digest,
    orphanTemporaryCount: 0,
    revisionStableAfterReplay: checkpoint === 'after_rename' ? true : false
  }
}

async function verifyUnknownResult(modulePath) {
  const root = scenarioRoot('unknown-result')
  const exit = await invokeWorker(modulePath, root, 'post_directory_sync_throw', false)
  assert.equal(exit.code, 2)
  assert.equal(exit.message?.code, 'EUNKNOWNRESULT')
  const journal = createJournal(modulePath, root)
  const before = fileIdentity(journal.filePath)
  const replay = await journal.begin(fixture())
  const after = fileIdentity(journal.filePath)
  assert.equal(replay.phase, 'prepared')
  assert.deepEqual(after, before)
  assert.deepEqual(temporaryFiles(root), [])
  return { errorCode: exit.message.code, replayByteStable: true, recoveredPhase: replay.phase, orphanTemporaryCount: 0 }
}

async function verifyDuplicate(modulePath) {
  const root = scenarioRoot('duplicate')
  const journal = createJournal(modulePath, root)
  const first = await journal.begin(fixture())
  const before = fileIdentity(journal.filePath)
  const second = await journal.begin(fixture())
  const after = fileIdentity(journal.filePath)
  assert.deepEqual(second, first)
  assert.deepEqual(after, before)
  assert.equal(JSON.parse(readFileSync(journal.filePath, 'utf8')).revision, 1)
  await assert.rejects(journal.begin({ ...fixture(), expectedWorkspaceRevision: 2 }), /frozen deletion scope/)
  assert.deepEqual(fileIdentity(journal.filePath), before)
  return {
    operationCount: 1,
    revisionStable: true,
    identityStable: true,
    conflictingReplayRejected: true,
    canonicalDigest: after.digest
  }
}

async function verifyOutOfOrder(modulePath) {
  const root = scenarioRoot('out-of-order')
  const journal = createJournal(modulePath, root)
  await journal.begin(fixture())
  const before = fileIdentity(journal.filePath)
  await assert.rejects(journal.advance('project-delete-recovery-request', 'workflow_purged'), /cannot skip/)
  assert.deepEqual(fileIdentity(journal.filePath), before)
  const advanced = await journal.advance('project-delete-recovery-request', 'backup_written', {
    backupPath: '/private/backup.json',
    backupDigest: 'b'.repeat(64),
    exportDigest: 'e'.repeat(64)
  })
  assert.equal(advanced.phase, 'backup_written')
  const committed = fileIdentity(journal.filePath)
  const stale = await journal.advance('project-delete-recovery-request', 'prepared')
  assert.equal(stale.phase, 'backup_written')
  assert.deepEqual(fileIdentity(journal.filePath), committed)
  const replay = await journal.advance('project-delete-recovery-request', 'backup_written', {
    backupPath: '/private/backup.json',
    backupDigest: 'b'.repeat(64),
    exportDigest: 'e'.repeat(64)
  })
  assert.equal(replay.phase, 'backup_written')
  assert.deepEqual(fileIdentity(journal.filePath), committed)
  await assert.rejects(journal.advance('project-delete-recovery-request', 'backup_written', {
    backupPath: '/private/other-backup.json'
  }), /different receipt/)
  return { rejectedSkip: true, staleAdvanceByteStable: true, samePhaseReplayByteStable: true, finalPhase: replay.phase }
}

function invokeWorker(modulePath, root, checkpoint, killAtCheckpoint) {
  return new Promise((resolve, reject) => {
    const child = fork(scriptPath, ['--worker'], {
      cwd: repoRoot,
      execArgv: [],
      env: {
        ...process.env,
        CAOGEN_PROJECT_DELETION_JOURNAL_MODULE: modulePath,
        CAOGEN_PROJECT_DELETION_JOURNAL_ROOT: root,
        CAOGEN_PROJECT_DELETION_JOURNAL_CHECKPOINT: checkpoint
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    let message
    let settled = false
    const timeout = setTimeout(() => finish(new Error(`journal worker timed out at ${checkpoint}`)), 15_000)
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
  const root = requiredEnv('CAOGEN_PROJECT_DELETION_JOURNAL_ROOT')
  const target = path.resolve(path.join(root, 'private', 'project-deletion-journal.json'))
  const parent = path.dirname(target)
  const checkpoint = requiredEnv('CAOGEN_PROJECT_DELETION_JOURNAL_CHECKPOINT')
  const descriptors = new Map()
  Module._load = function patchedLoad(request, owner, isMain) {
    if (request === 'node:fs') return faultFs(realFs, target, parent, checkpoint, descriptors)
    return originalLoad.call(this, request, owner, isMain)
  }
  try {
    const journal = createJournal(requiredEnv('CAOGEN_PROJECT_DELETION_JOURNAL_MODULE'), root)
    await journal.begin(fixture())
    process.send?.({ type: 'completed' })
  } catch (error) {
    process.send?.({ type: 'error', code: error?.code, message: String(error?.message ?? error) })
    process.exitCode = 2
  } finally {
    Module._load = originalLoad
  }
}

function faultFs(realFs, target, parent, checkpoint, descriptors) {
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
      if (checkpoint === 'after_write' && opened?.endsWith('.tmp')) pauseAt(checkpoint)
      return result
    },
    fsyncSync: (descriptor) => {
      const result = realFs.fsyncSync(descriptor)
      const opened = descriptors.get(descriptor)
      if (checkpoint === 'after_file_sync' && opened?.endsWith('.tmp')) pauseAt(checkpoint)
      if (checkpoint === 'post_directory_sync_throw' && opened === parent) {
        throw Object.assign(new Error('injected journal unknown result'), { code: 'EUNKNOWNRESULT' })
      }
      return result
    },
    renameSync: (...args) => {
      const result = realFs.renameSync(...args)
      if (checkpoint === 'after_rename' && path.resolve(String(args[1])) === target) pauseAt(checkpoint)
      return result
    }
  }
}

function pauseAt(checkpoint) {
  process.send?.({ type: 'checkpoint', checkpoint })
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}

function fixture() {
  return {
    operationId: 'project-delete-recovery-request',
    projectId: 'project-recovery',
    expectedWorkspaceRevision: 1,
    sessionIds: ['session-recovery'],
    sdkSessionIds: ['sdk-recovery'],
    artifactBlobDigests: [`sha256:${'a'.repeat(64)}`],
    effectArtifactRefs: []
  }
}

function createJournal(modulePath, root) {
  return new (require(modulePath).ProjectDeletionJournal)(root)
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/data-lifecycle/project-deletion-journal.ts',
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

function scenarioRoot(name) {
  const root = path.join(tempRoot, name)
  mkdirSync(root, { recursive: true })
  return root
}

function lockPath(filePath) { return `${filePath}.lock` }
function temporaryFiles(root) {
  const directory = path.join(root, 'private')
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter((name) => name.startsWith('project-deletion-journal.json.') && name.endsWith('.tmp'))
}
function fileIdentity(file) {
  const info = statSync(file)
  return { device: String(info.dev), inode: String(info.ino), size: info.size, digest: sha256(readFileSync(file)) }
}
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function git(args) { try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim() } catch { return '' } }
function gitStatusCount() { return git(['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean).length }
function requiredEnv(name) { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value }
function serializeError(error) { return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { name: 'Error', message: String(error) } }
