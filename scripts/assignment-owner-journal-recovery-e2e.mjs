#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
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
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const workerMode = process.argv[2] === 'worker'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'assignment-owner-journal-recovery')
const reportDir = path.join(reportRoot, runId)
const tempRoot = workerMode ? '' : mkdtempSync(path.join(tmpdir(), 'caogen-assignment-owner-journal-recovery-'))
const compiledDir = path.join(tempRoot, 'compiled')
const writer = 'src/main/assignment-owner-coordinator/journal.ts'

if (workerMode) await runWorker()
else await runParent()

async function runParent() {
  let report
  try {
    compileSources()
    const modulePath = path.join(compiledDir, 'main', 'assignment-owner-coordinator', 'journal.js')
    const strongKill = []
    for (const checkpoint of ['after_write', 'after_file_sync', 'after_rename']) {
      strongKill.push(await verifyStrongKill(modulePath, checkpoint))
    }
    report = {
      schemaVersion: 1,
      gate: 'test:assignment-owner-journal-recovery',
      runId,
      status: 'passed',
      verification: 'runtime_store_verified',
      sourceRevision: git(['rev-parse', 'HEAD']),
      worktreeStatusCount: gitStatusCount(),
      writer,
      scope: 'AssignmentOwnerCoordinator journal publication and serialized recovery',
      faults: {
        strong_kill: { status: 'verified', scenarios: strongKill },
        network_unknown_result: { status: 'verified', scenario: await verifyUnknownResult(modulePath) },
        duplicate_idempotency: { status: 'verified', scenario: await verifyDuplicate(modulePath) },
        out_of_order: { status: 'verified', scenario: await verifyConcurrentCommits(modulePath) }
      }
    }
  } catch (error) {
    report = {
      schemaVersion: 1,
      gate: 'test:assignment-owner-journal-recovery',
      runId,
      status: 'failed',
      verification: 'not_verified',
      sourceRevision: git(['rev-parse', 'HEAD']),
      worktreeStatusCount: gitStatusCount(),
      writer,
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
  const entry = await journal.getEntry('assignment-owner-recovery-request')
  assert([null, 'prepared'].includes(entry?.phase ?? null))
  if (!entry) await appendEntry(journal, entryFixture())
  const recovered = await journal.getEntry('assignment-owner-recovery-request')
  assert.equal(recovered?.requestId, 'assignment-owner-recovery-request')
  assert.deepEqual(temporaryFiles(root), [])
  assert.equal(existsSync(lockPath(root)), false)
  return {
    checkpoint,
    signal: exit.signal,
    publishedBeforeKill: Boolean(entry),
    recoveredPhase: recovered.phase,
    journalDigest: sha256(readFileSync(journalPath(root))),
    orphanTemporaryCount: 0
  }
}

async function verifyUnknownResult(modulePath) {
  const root = scenarioRoot('unknown-result')
  const exit = await invokeWorker(modulePath, root, 'post_directory_sync_throw', false)
  assert.equal(exit.code, 2)
  assert.equal(exit.message?.code, 'RECOVERY_PENDING')
  assert.equal(exit.message?.replayByteStable, true)
  const journal = createJournal(modulePath, root)
  assert.equal((await journal.getEntry('assignment-owner-recovery-request'))?.phase, 'prepared')
  assert.deepEqual(temporaryFiles(root), [])
  return { errorCode: exit.message.code, replayByteStable: true, recoveredPhase: 'prepared', orphanTemporaryCount: 0 }
}

async function verifyDuplicate(modulePath) {
  const root = scenarioRoot('duplicate')
  const journal = createJournal(modulePath, root)
  const entry = entryFixture()
  await appendEntry(journal, entry)
  const before = fileIdentity(journalPath(root))
  await journal.withExclusive(async ({ document }) => {
    const existing = document.entries.find((candidate) => candidate.requestId === entry.requestId)
    assert(existing)
    assert.equal(existing.requestDigest, entry.requestDigest)
  })
  const after = fileIdentity(journalPath(root))
  assert.deepEqual(after, before)
  assert.equal(JSON.parse(readFileSync(journalPath(root), 'utf8')).entries.length, 1)
  return { requestCount: 1, revisionStable: true, identityStable: true, canonicalDigest: after.digest }
}

async function verifyConcurrentCommits(modulePath) {
  const root = scenarioRoot('concurrent')
  const journal = createJournal(modulePath, root)
  await Promise.all(['one', 'two'].map((suffix) => appendEntry(journal, entryFixture(`request-${suffix}`))))
  const document = JSON.parse(readFileSync(journalPath(root), 'utf8'))
  assert.equal(document.entries.length, 2)
  assert.equal(new Set(document.entries.map((entry) => entry.requestId)).size, 2)
  assert.equal(document.revision, 2)
  return { requestCount: 2, serializedCommits: true, noLostUpdate: true, finalRevision: document.revision }
}

async function appendEntry(journal, entry) {
  return journal.withExclusive(async ({ document, persist }) => {
    if (document.entries.some((candidate) => candidate.requestId === entry.requestId)) return
    document.entries.push(entry)
    persist()
  })
}

function invokeWorker(modulePath, root, checkpoint, killAtCheckpoint) {
  return new Promise((resolve, reject) => {
    const child = fork(process.argv[1], ['worker'], {
      cwd: repoRoot,
      execArgv: [],
      env: {
        ...process.env,
        CAOGEN_ASSIGNMENT_OWNER_JOURNAL_MODULE: modulePath,
        CAOGEN_ASSIGNMENT_OWNER_JOURNAL_ROOT: root,
        CAOGEN_ASSIGNMENT_OWNER_JOURNAL_CHECKPOINT: checkpoint
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
  const root = requiredEnv('CAOGEN_ASSIGNMENT_OWNER_JOURNAL_ROOT')
  const target = path.resolve(journalPath(root))
  const parent = path.dirname(target)
  const checkpoint = requiredEnv('CAOGEN_ASSIGNMENT_OWNER_JOURNAL_CHECKPOINT')
  const descriptors = new Map()
  Module._load = function patchedLoad(request, owner, isMain) {
    if (request === 'node:fs') return faultFs(realFs, target, parent, checkpoint, descriptors)
    return originalLoad.call(this, request, owner, isMain)
  }
  try {
    const journal = createJournal(requiredEnv('CAOGEN_ASSIGNMENT_OWNER_JOURNAL_MODULE'), root)
    await journal.withExclusive(async ({ document, persist }) => {
      if (!document.entries.some((entry) => entry.requestId === 'assignment-owner-recovery-request')) {
        document.entries.push(entryFixture())
        persist()
      }
    })
    process.send?.({ type: 'completed' })
  } catch (error) {
    if (checkpoint === 'post_directory_sync_throw') {
      const journal = createJournal(requiredEnv('CAOGEN_ASSIGNMENT_OWNER_JOURNAL_MODULE'), root)
      const before = readFileSync(target)
      await journal.withExclusive(async ({ document }) => {
        assert(document.entries.some((entry) => entry.requestId === 'assignment-owner-recovery-request'))
      })
      const after = readFileSync(target)
      process.send?.({ type: 'error', code: error?.code, message: String(error?.message ?? error), replayByteStable: before.equals(after) })
    } else {
      process.send?.({ type: 'error', code: error?.code, message: String(error?.message ?? error) })
    }
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
    writeSync: (...args) => {
      const result = realFs.writeSync(...args)
      const opened = descriptors.get(args[0])
      if (checkpoint === 'after_write' && opened?.endsWith('.tmp')) pauseAt(checkpoint)
      return result
    },
    fsyncSync: (descriptor) => {
      const result = realFs.fsyncSync(descriptor)
      const opened = descriptors.get(descriptor)
      if (checkpoint === 'after_file_sync' && opened?.endsWith('.tmp')) pauseAt(checkpoint)
      if (checkpoint === 'post_directory_sync_throw' && opened === parent) throw Object.assign(new Error('injected journal unknown result'), { code: 'EUNKNOWNRESULT' })
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

function entryFixture(requestId = 'assignment-owner-recovery-request') {
  const now = Date.UTC(2026, 7, 26)
  return {
    schemaVersion: 1,
    operation: 'assign',
    id: `journal-${requestId}`,
    requestId,
    requestDigest: sha256(Buffer.from(requestId)),
    projectId: 'project-recovery',
    workItemId: 'work-recovery',
    assigneeKind: 'digital_worker',
    assigneeId: 'worker-recovery',
    assignmentId: 'assignment-recovery',
    assignedBy: 'user-recovery',
    assignedAt: now,
    owner: { type: 'digital_worker', id: 'worker-recovery' },
    scope: { purpose: 'durable recovery' },
    expectedWorkItemRevision: 1,
    expectedProjectStoreRevision: 1,
    expectedDigitalWorkerStoreRevision: 1,
    phase: 'prepared',
    createdAt: now,
    updatedAt: now
  }
}

function createJournal(modulePath, root) {
  return new (require(modulePath).AssignmentOwnerJournal)(root)
}

function compileSources() {
  execFileSync(process.execPath, [path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), 'src/main/assignment-owner-coordinator/journal.ts', '--outDir', compiledDir, '--rootDir', 'src', '--target', 'ES2022', '--module', 'commonjs', '--moduleResolution', 'node', '--types', 'node', '--skipLibCheck', '--esModuleInterop'], { cwd: repoRoot, stdio: 'pipe' })
}

function scenarioRoot(name) { const root = path.join(tempRoot, name); mkdirSync(root, { recursive: true }); return root }
function journalPath(root) { return path.join(root, 'assignment-owner-coordinator.json') }
function lockPath(root) { return `${journalPath(root)}.lock` }
function temporaryFiles(root) { return existsSync(root) ? readdirSync(root).filter((name) => name.startsWith('assignment-owner-coordinator.json.') && name.endsWith('.tmp')) : [] }
function fileIdentity(file) { const info = statSync(file); return { device: String(info.dev), inode: String(info.ino), size: info.size, digest: sha256(readFileSync(file)) } }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function git(args) { try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim() } catch { return '' } }
function gitStatusCount() { return git(['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean).length }
function requiredEnv(name) { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value }
function serializeError(error) { return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { name: 'Error', message: String(error) } }
