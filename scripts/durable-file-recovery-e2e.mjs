#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, fork } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const workerMode = process.argv[2] === 'worker'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'durable-file-recovery')
const reportDir = path.join(reportRoot, runId)
const latestPath = path.join(reportRoot, 'latest.json')
const tempRoot = workerMode ? '' : mkdtempSync(path.join(tmpdir(), 'caogen-durable-file-recovery-'))
const compiledDir = path.join(tempRoot, 'compiled')
const oldBody = `${JSON.stringify({ revision: 1, value: 'old' })}\n`
const newBody = `${JSON.stringify({ revision: 2, value: 'new' })}\n`

if (workerMode) {
  await runWorker()
} else {
  await runParent()
}

async function runParent() {
  let report
  try {
    compileSource()
    const modulePath = path.join(compiledDir, 'main', 'durable-file.js')
    const strongKill = []
    for (const checkpoint of ['after_write', 'after_file_sync', 'after_rename']) {
      strongKill.push(await verifyStrongKill(modulePath, checkpoint))
    }
    const unknownResult = await verifyUnknownResult(modulePath)
    const duplicate = await verifyImmutableDuplicate(modulePath)
    const orphanOwnership = await verifyOrphanOwnership(modulePath)
    report = {
      schemaVersion: 1,
      gate: 'test:durable-file-recovery:required',
      runId,
      status: 'passed',
      verification: 'runtime_kernel_verified',
      sourceRevision: git(['rev-parse', 'HEAD']),
      worktreeStatusCount: gitStatusCount(),
      kernel: 'src/main/durable-file.ts',
      orphanOwnership,
      faults: {
        strong_kill: { status: 'verified', scenarios: strongKill },
        network_unknown_result: { status: 'verified', scenario: unknownResult },
        duplicate_idempotency: { status: 'verified', scenario: duplicate },
        out_of_order: {
          status: 'not_applicable',
          reason: 'The byte publication primitive has no domain revision; each mutable Store must prove CAS separately.'
        }
      }
    }
    console.log(JSON.stringify({
      status: report.status,
      verification: report.verification,
      sourceRevision: report.sourceRevision,
      verifiedFaults: 3,
      reportPath: path.relative(repoRoot, path.join(reportDir, 'report.json'))
    }, null, 2))
  } catch (error) {
    report = {
      schemaVersion: 1,
      gate: 'test:durable-file-recovery:required',
      runId,
      status: 'failed',
      verification: 'not_verified',
      sourceRevision: git(['rev-parse', 'HEAD']),
      worktreeStatusCount: gitStatusCount(),
      error: serializeError(error)
    }
    process.exitCode = 1
  } finally {
    writeReport(report)
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function verifyStrongKill(modulePath, checkpoint) {
  const root = path.join(tempRoot, `strong-kill-${checkpoint}`)
  const target = path.join(root, 'store.json')
  mkdirSync(root, { recursive: true })
  writeFileSync(target, oldBody, 'utf8')
  const exit = await invokeWorker(modulePath, target, checkpoint, true)
  assert.equal(exit.signal, 'SIGKILL', `${checkpoint} worker must receive SIGKILL`)
  const published = readFileSync(target, 'utf8')
  const expected = checkpoint === 'after_rename' ? newBody : oldBody
  assert.equal(published, expected, `${checkpoint} must leave one complete canonical generation`)
  assert.deepEqual(JSON.parse(published), JSON.parse(expected))

  const runtime = require(modulePath)
  const recoveredBody = `${JSON.stringify({ revision: 3, value: 'recovered' })}\n`
  await runtime.writeDurableFile(target, recoveredBody)
  assert.equal(readFileSync(target, 'utf8'), recoveredBody)
  const orphanTemporaryCount = temporaryFiles(root, target).length
  assert.equal(orphanTemporaryCount, 0, `${checkpoint} restart must remove dead-writer candidates`)
  return {
    checkpoint,
    signal: exit.signal,
    canonicalDigestAfterKill: sha256(published),
    restartDigest: sha256(recoveredBody),
    orphanTemporaryCount
  }
}

async function verifyUnknownResult(modulePath) {
  const root = path.join(tempRoot, 'post-publication-unknown-result')
  const target = path.join(root, 'store.json')
  mkdirSync(root, { recursive: true })
  writeFileSync(target, oldBody, 'utf8')
  const exit = await invokeWorker(modulePath, target, 'post_directory_sync_throw', false)
  assert.equal(exit.code, 2, 'post-publication uncertainty must be reported as an error')
  assert.equal(exit.message?.code, 'EUNKNOWNRESULT')
  const published = readFileSync(target, 'utf8')
  assert.equal(published, newBody, 'unknown result must still leave complete published bytes')
  assert.equal(sha256(published), sha256(newBody), 'restart must reconcile the published digest')
  return {
    errorCode: exit.message.code,
    publishedDigest: sha256(published),
    expectedDigest: sha256(newBody),
    digestReconciled: true
  }
}

async function verifyImmutableDuplicate(modulePath) {
  const root = path.join(tempRoot, 'immutable-duplicate')
  const target = path.join(root, 'artifact.bin')
  const runtime = require(modulePath)
  await runtime.writeDurableFile(target, newBody, { replace: false })
  const before = readFileSync(target)
  await assert.rejects(
    runtime.writeDurableFile(target, newBody, { replace: false }),
    (error) => error?.code === 'EEXIST'
  )
  const after = readFileSync(target)
  assert.deepEqual(after, before, 'duplicate no-replace publication must preserve canonical bytes')
  assert.deepEqual(temporaryFiles(root, target), [], 'duplicate publication must remove its candidate')
  return { errorCode: 'EEXIST', canonicalDigest: sha256(after), storeByteStable: true }
}

async function verifyOrphanOwnership(modulePath) {
  const root = path.join(tempRoot, 'orphan-ownership')
  const target = path.join(root, 'store.json')
  const runtime = require(modulePath)
  mkdirSync(root, { recursive: true })

  const asyncDeadWriter = durableTemporaryPath(target, '00000000-0000-4000-8000-000000000001')
  const asyncLookalike = path.join(root, `.${path.basename(target)}.2000000000.not-a-caogen-uuid.tmp`)
  writeFileSync(asyncDeadWriter, 'dead async writer', 'utf8')
  writeFileSync(asyncLookalike, 'preserve async lookalike', 'utf8')
  await runtime.cleanupDurableFileOrphans(target)
  assert.equal(existsSync(asyncDeadWriter), false)
  assert.equal(readFileSync(asyncLookalike, 'utf8'), 'preserve async lookalike')
  rmSync(asyncLookalike, { force: true })

  const syncDeadWriter = durableTemporaryPath(target, '00000000-0000-4000-8000-000000000002')
  const syncLookalike = path.join(root, `.${path.basename(target)}.2000000000.still-not-a-uuid.tmp`)
  writeFileSync(syncDeadWriter, 'dead sync writer', 'utf8')
  writeFileSync(syncLookalike, 'preserve sync lookalike', 'utf8')
  runtime.cleanupDurableFileOrphansSync(target)
  assert.equal(existsSync(syncDeadWriter), false)
  assert.equal(readFileSync(syncLookalike, 'utf8'), 'preserve sync lookalike')
  rmSync(syncLookalike, { force: true })

  assert.deepEqual(temporaryFiles(root, target), [])
  return {
    asyncDeadWriterReaped: true,
    syncDeadWriterReaped: true,
    malformedLookalikesPreserved: 2
  }
}

function durableTemporaryPath(target, uuid) {
  return path.join(path.dirname(target), `.${path.basename(target)}.2000000000.${uuid}.tmp`)
}

function invokeWorker(modulePath, target, checkpoint, killAtCheckpoint) {
  return new Promise((resolve, reject) => {
    const child = fork(process.argv[1], ['worker'], {
      cwd: repoRoot,
      execArgv: [],
      env: {
        ...process.env,
        CAOGEN_DURABLE_FILE_MODULE: modulePath,
        CAOGEN_DURABLE_FILE_TARGET: target,
        CAOGEN_DURABLE_FILE_CHECKPOINT: checkpoint,
        CAOGEN_DURABLE_FILE_BODY: newBody
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    let settled = false
    let message
    let stderr = ''
    const timeout = setTimeout(() => finish(new Error(`durable-file worker timed out at ${checkpoint}`)), 15_000)
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('message', (value) => {
      message = value
      if (killAtCheckpoint && value?.type === 'checkpoint' && value.checkpoint === checkpoint) {
        child.kill('SIGKILL')
      }
    })
    child.on('error', finish)
    child.on('exit', (code, signal) => finish(null, { code, signal, message, stderr }))

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
  const target = path.resolve(requiredEnv('CAOGEN_DURABLE_FILE_TARGET'))
  const parent = path.dirname(target)
  const checkpoint = requiredEnv('CAOGEN_DURABLE_FILE_CHECKPOINT')
  Module._load = function patchedLoad(request, owner, isMain) {
    if (request === 'node:fs/promises') return faultInjectingPromises(realPromises, target, parent, checkpoint)
    return originalLoad.call(this, request, owner, isMain)
  }
  try {
    const runtime = require(requiredEnv('CAOGEN_DURABLE_FILE_MODULE'))
    await runtime.writeDurableFile(target, requiredEnv('CAOGEN_DURABLE_FILE_BODY'))
    process.send?.({ type: 'completed' })
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
    open: async (...args) => wrapHandle(await realPromises.open(...args), path.resolve(String(args[0])), target, parent, checkpoint),
    rename: async (...args) => {
      const result = await realPromises.rename(...args)
      if (checkpoint === 'after_rename' && path.resolve(String(args[1])) === target) await pauseAt(checkpoint)
      return result
    }
  }
}

function wrapHandle(handle, openedPath, target, parent, checkpoint) {
  const temporary = openedPath !== target && path.dirname(openedPath) === parent
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
          const error = new Error('injected post-publication unknown result')
          error.code = 'EUNKNOWNRESULT'
          throw error
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

function compileSource() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/durable-file.ts',
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

function temporaryFiles(root, target) {
  if (!existsSync(root)) return []
  const prefix = `.${path.basename(target)}.`
  return readdirSync(root).filter((name) => name.startsWith(prefix) && name.endsWith('.tmp')).sort()
}

function writeReport(report) {
  mkdirSync(reportDir, { recursive: true })
  const body = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(reportDir, 'report.json'), body, 'utf8')
  writeFileSync(latestPath, body, 'utf8')
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function gitStatusCount() {
  return git(['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean).length
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function serializeError(error) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: 'Error', message: String(error) }
}
