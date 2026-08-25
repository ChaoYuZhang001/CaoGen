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
const reportRoot = path.join(repoRoot, 'test-results', 'artifact-lifecycle-content-recovery')
const reportDir = path.join(reportRoot, runId)
const tempRoot = workerMode ? '' : mkdtempSync(path.join(tmpdir(), 'caogen-artifact-content-recovery-'))
const compiledDir = path.join(tempRoot, 'compiled')

if (workerMode) await runWorker()
else await runParent()

async function runParent() {
  let report
  try {
    compileSources()
    const modulePath = path.join(compiledDir, 'main', 'task', 'artifact-lifecycle-content.js')
    const strongKill = []
    for (const checkpoint of ['after_write', 'after_file_sync', 'after_publish']) {
      strongKill.push(await verifyStrongKill(modulePath, checkpoint))
    }
    report = {
      schemaVersion: 1,
      gate: 'test:artifact-lifecycle-content-recovery',
      runId,
      status: 'passed',
      verification: 'runtime_store_verified',
      sourceRevision: git(['rev-parse', 'HEAD']),
      worktreeStatusCount: gitStatusCount(),
      writer: 'src/main/task/artifact-lifecycle-content.ts',
      scope: 'Immutable Artifact content publication and digest-bound recovery',
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
      gate: 'test:artifact-lifecycle-content-recovery',
      runId,
      status: 'failed',
      verification: 'not_verified',
      sourceRevision: git(['rev-parse', 'HEAD']),
      worktreeStatusCount: gitStatusCount(),
      writer: 'src/main/task/artifact-lifecycle-content.ts',
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
  const target = path.join(root, 'artifact.bin')
  const bytes = artifactBytes('strong-kill')
  const exit = await invokeWorker(modulePath, target, bytes, checkpoint, true)
  assert.equal(exit.signal, 'SIGKILL')
  const publishedBeforeKill = checkpoint === 'after_publish'
  assert.equal(existsSync(target), publishedBeforeKill)
  const runtime = require(modulePath)
  const created = await runtime.materializeArtifactSourceFile(contentInput(target, bytes))
  assert.deepEqual(readFileSync(target), bytes)
  assert.deepEqual(temporaryFiles(target), [])
  return {
    checkpoint,
    signal: exit.signal,
    publishedBeforeKill,
    replayCreated: created,
    canonicalDigest: sha256(readFileSync(target)),
    orphanTemporaryCount: 0
  }
}

async function verifyUnknownResult(modulePath) {
  const root = scenarioRoot('unknown-result')
  const target = path.join(root, 'artifact.bin')
  const bytes = artifactBytes('unknown-result')
  const exit = await invokeWorker(modulePath, target, bytes, 'post_directory_sync_throw', false)
  assert.equal(exit.code, 0)
  assert(exit.messages.some((message) => message?.type === 'fault' &&
    message.checkpoint === 'post_directory_sync_throw'))
  const completed = exit.messages.find((message) => message?.type === 'completed')
  assert.equal(completed?.created, true)
  assert.deepEqual(readFileSync(target), bytes)
  assert.deepEqual(temporaryFiles(target), [])
  const runtime = require(modulePath)
  const replay = await runtime.materializeArtifactSourceFile(contentInput(target, bytes))
  assert.equal(replay, false)
  return {
    injectedErrorCode: 'EUNKNOWNRESULT',
    reconciledByDigestReadback: true,
    replayByteStable: true,
    canonicalDigest: sha256(readFileSync(target)),
    orphanTemporaryCount: 0
  }
}

async function verifyDuplicate(modulePath) {
  const root = scenarioRoot('duplicate')
  const target = path.join(root, 'artifact.bin')
  const bytes = artifactBytes('duplicate')
  const runtime = require(modulePath)
  assert.equal(await runtime.materializeArtifactSourceFile(contentInput(target, bytes)), true)
  const before = fileIdentity(target)
  assert.equal(await runtime.materializeArtifactSourceFile(contentInput(target, bytes)), false)
  assert.deepEqual(fileIdentity(target), before)
  const conflicting = artifactBytes('duplicate-conflict')
  await assert.rejects(
    runtime.materializeArtifactSourceFile(contentInput(target, conflicting)),
    /digest mismatch/
  )
  assert.deepEqual(fileIdentity(target), before)
  assert.deepEqual(temporaryFiles(target), [])
  return {
    firstCreated: true,
    duplicateCreated: false,
    conflictingDuplicateRejected: true,
    byteStable: true,
    canonicalDigest: before.digest
  }
}

async function verifyOutOfOrder(modulePath) {
  const root = scenarioRoot('out-of-order')
  const target = path.join(root, 'artifact.bin')
  const alpha = artifactBytes('alpha')
  const beta = artifactBytes('beta')
  const runtime = require(modulePath)
  const race = await Promise.allSettled([
    runtime.materializeArtifactSourceFile(contentInput(target, alpha)),
    runtime.materializeArtifactSourceFile(contentInput(target, beta))
  ])
  const fulfilled = race.filter((result) => result.status === 'fulfilled')
  const rejected = race.filter((result) => result.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.match(String(rejected[0].reason?.message ?? rejected[0].reason), /digest mismatch/)
  const published = readFileSync(target)
  const winner = Buffer.compare(published, alpha) === 0 ? alpha : beta
  const stale = winner === alpha ? beta : alpha
  assert.deepEqual(published, winner)
  const before = fileIdentity(target)
  await assert.rejects(runtime.materializeArtifactSourceFile(contentInput(target, stale)), /digest mismatch/)
  assert.deepEqual(fileIdentity(target), before)
  assert.deepEqual(temporaryFiles(target), [])
  return {
    concurrentWinnerCount: 1,
    conflictingWriterRejected: true,
    staleReplayRejected: true,
    noReplacePublication: true,
    canonicalDigest: before.digest
  }
}

function invokeWorker(modulePath, target, bytes, checkpoint, killAtCheckpoint) {
  return new Promise((resolve, reject) => {
    const child = fork(scriptPath, ['--worker'], {
      cwd: repoRoot,
      execArgv: [],
      env: {
        ...process.env,
        CAOGEN_ARTIFACT_CONTENT_MODULE: modulePath,
        CAOGEN_ARTIFACT_CONTENT_TARGET: target,
        CAOGEN_ARTIFACT_CONTENT_BYTES: bytes.toString('base64'),
        CAOGEN_ARTIFACT_CONTENT_CHECKPOINT: checkpoint
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    const messages = []
    let settled = false
    const timeout = setTimeout(() => finish(new Error(`artifact worker timed out at ${checkpoint}`)), 15_000)
    child.on('message', (message) => {
      messages.push(message)
      if (killAtCheckpoint && message?.type === 'checkpoint' && message.checkpoint === checkpoint) {
        child.kill('SIGKILL')
      }
    })
    child.on('error', finish)
    child.on('exit', (code, signal) => finish(null, { code, signal, messages }))
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
  const realPromises = require('node:fs/promises')
  const originalLoad = Module._load
  const target = path.resolve(requiredEnv('CAOGEN_ARTIFACT_CONTENT_TARGET'))
  const parent = path.dirname(target)
  const checkpoint = requiredEnv('CAOGEN_ARTIFACT_CONTENT_CHECKPOINT')
  Module._load = function patchedLoad(request, owner, isMain) {
    if (request === 'node:fs/promises') {
      return faultInjectingPromises(realPromises, target, parent, checkpoint)
    }
    return originalLoad.call(this, request, owner, isMain)
  }
  try {
    const runtime = require(requiredEnv('CAOGEN_ARTIFACT_CONTENT_MODULE'))
    const bytes = Buffer.from(requiredEnv('CAOGEN_ARTIFACT_CONTENT_BYTES'), 'base64')
    const created = await runtime.materializeArtifactSourceFile(contentInput(target, bytes))
    process.send?.({ type: 'completed', created })
  } catch (error) {
    process.send?.({ type: 'error', code: error?.code, message: String(error?.message ?? error) })
    process.exitCode = 2
  } finally {
    Module._load = originalLoad
  }
}

function faultInjectingPromises(realPromises, target, parent, checkpoint) {
  return {
    ...realPromises,
    open: async (...args) => wrapHandle(
      await realPromises.open(...args),
      path.resolve(String(args[0])),
      target,
      parent,
      checkpoint
    ),
    link: async (...args) => {
      const result = await realPromises.link(...args)
      if (checkpoint === 'after_publish' && path.resolve(String(args[1])) === target) {
        await pauseAt(checkpoint)
      }
      return result
    }
  }
}

function wrapHandle(handle, openedPath, target, parent, checkpoint) {
  const temporary = openedPath !== target && path.dirname(openedPath) === parent && openedPath.endsWith('.tmp')
  const directory = openedPath === parent
  return new Proxy(handle, {
    get(owner, property) {
      if (property === 'writeFile' && temporary) return async (...args) => {
        const result = await owner.writeFile(...args)
        if (checkpoint === 'after_write') await pauseAt(checkpoint)
        return result
      }
      if (property === 'sync') return async (...args) => {
        const result = await owner.sync(...args)
        if (temporary && checkpoint === 'after_file_sync') await pauseAt(checkpoint)
        if (directory && checkpoint === 'post_directory_sync_throw') {
          process.send?.({ type: 'fault', checkpoint, code: 'EUNKNOWNRESULT' })
          throw Object.assign(new Error('injected Artifact publication unknown result'), {
            code: 'EUNKNOWNRESULT'
          })
        }
        return result
      }
      const value = Reflect.get(owner, property, owner)
      return typeof value === 'function' ? value.bind(owner) : value
    }
  })
}

async function pauseAt(checkpoint) {
  await new Promise((resolve) => process.send?.({ type: 'checkpoint', checkpoint }, resolve))
  await new Promise(() => undefined)
}

function contentInput(target, bytes) {
  return {
    locationPath: target,
    bytes,
    digest: `sha256:${sha256(bytes)}`,
    sizeBytes: bytes.byteLength
  }
}

function artifactBytes(marker) {
  return Buffer.from(`CaoGen immutable Artifact recovery: ${marker}\n`, 'utf8')
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/task/artifact-lifecycle-content.ts',
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

function temporaryFiles(target) {
  const parent = path.dirname(target)
  if (!existsSync(parent)) return []
  const prefix = `.${path.basename(target)}.`
  return readdirSync(parent).filter((name) => name.startsWith(prefix) && name.endsWith('.tmp')).sort()
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
