#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, fork } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
const reportRoot = path.join(repoRoot, 'test-results', 'code-forge-patch-store-recovery')
const reportDir = path.join(reportRoot, runId)
const latestPath = path.join(reportRoot, 'latest.json')
const tempRoot = workerMode ? '' : mkdtempSync(path.join(tmpdir(), 'caogen-code-forge-patch-recovery-'))
const compiledDir = path.join(tempRoot, 'compiled')
const patchText = 'diff --git a/example.txt b/example.txt\nnew file mode 100644\nindex 0000000..ce01362\n--- /dev/null\n+++ b/example.txt\n@@ -0,0 +1 @@\n+hello\n'

if (workerMode) await runWorker()
else await runParent()

async function runParent() {
  let report
  try {
    compileSource()
    const modulePath = path.join(compiledDir, 'main', 'code-forge', 'patch-artifact.js')
    const strongKill = []
    for (const checkpoint of ['after_write', 'after_file_sync', 'after_link']) {
      strongKill.push(await verifyStrongKill(modulePath, checkpoint))
    }
    const unknownResult = await verifyUnknownResult(modulePath)
    const duplicate = verifyDuplicate(modulePath)
    const outOfOrder = verifyOutOfOrder(modulePath)
    report = {
      schemaVersion: 1,
      gate: 'test:code-forge-patch-store-recovery',
      runId,
      status: 'passed',
      verification: 'runtime_store_verified',
      sourceRevision: git(['rev-parse', 'HEAD']),
      worktreeStatusCount: gitStatusCount(),
      writer: 'src/main/code-forge/patch-artifact.ts',
      faults: {
        strong_kill: { status: 'verified', scenarios: strongKill },
        network_unknown_result: { status: 'verified', scenario: unknownResult },
        duplicate_idempotency: { status: 'verified', scenario: duplicate },
        out_of_order: { status: 'verified', scenario: outOfOrder }
      }
    }
    console.log(JSON.stringify({
      status: report.status,
      verification: report.verification,
      sourceRevision: report.sourceRevision,
      verifiedFaults: 4,
      reportPath: path.relative(repoRoot, path.join(reportDir, 'report.json'))
    }, null, 2))
  } catch (error) {
    report = {
      schemaVersion: 1,
      gate: 'test:code-forge-patch-store-recovery',
      runId,
      status: 'failed',
      verification: 'not_verified',
      sourceRevision: git(['rev-parse', 'HEAD']),
      worktreeStatusCount: gitStatusCount(),
      writer: 'src/main/code-forge/patch-artifact.ts',
      error: serializeError(error)
    }
    process.exitCode = 1
  } finally {
    writeReport(report)
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function verifyStrongKill(modulePath, checkpoint) {
  const root = scenarioRoot(`strong-kill-${checkpoint}`)
  const runtime = require(modulePath)
  const target = buildTarget(runtime, root, patchText)
  const exit = await invokeWorker(modulePath, target, checkpoint, true)
  assert.equal(exit.signal, 'SIGKILL', `${checkpoint} worker must receive SIGKILL: ${JSON.stringify(exit)}`)
  const shouldExist = checkpoint === 'after_link'
  assert.equal(existsSync(target.artifactPath), shouldExist, `${checkpoint} canonical publication state drifted`)
  if (shouldExist) assert.equal(sha256(readFileSync(target.artifactPath)), target.patchSha256)

  runtime.publishCodeForgePatchArtifact(target, patchText)
  const recovered = runtime.observeCodeForgePatchArtifact(target.artifactPath)
  assert.equal(recovered.state, 'file')
  assert.equal(recovered.sha256, target.patchSha256)
  assert.equal(recovered.bytes, target.patchBytes)
  const orphanTemporaryCount = temporaryFiles(root).length
  assert.equal(orphanTemporaryCount, 0, `${checkpoint} retry must remove dead-writer candidates`)
  return {
    checkpoint,
    signal: exit.signal,
    canonicalExistedAfterKill: shouldExist,
    finalDigest: recovered.sha256,
    orphanTemporaryCount
  }
}

async function verifyUnknownResult(modulePath) {
  const root = scenarioRoot('unknown-result')
  const runtime = require(modulePath)
  const target = buildTarget(runtime, root, patchText)
  const exit = await invokeWorker(modulePath, target, 'post_directory_sync_throw', false)
  assert.equal(exit.code, 2, 'post-publication uncertainty must surface as an error')
  assert.equal(exit.message?.code, 'EUNKNOWNRESULT')
  const published = runtime.observeCodeForgePatchArtifact(target.artifactPath)
  assert.equal(published.state, 'file')
  assert.equal(published.sha256, target.patchSha256)
  runtime.publishCodeForgePatchArtifact(target, patchText)
  const reconciled = runtime.observeCodeForgePatchArtifact(target.artifactPath)
  assert.deepEqual(reconciled, published, 'retry must reconcile the already-published immutable artifact')
  assert.deepEqual(temporaryFiles(root), [])
  return {
    errorCode: exit.message.code,
    publishedDigest: published.sha256,
    retryIdentityStable: sameIdentity(published.identity, reconciled.identity),
    orphanTemporaryCount: 0
  }
}

function verifyDuplicate(modulePath) {
  const root = scenarioRoot('duplicate')
  const runtime = require(modulePath)
  const target = buildTarget(runtime, root, patchText)
  runtime.publishCodeForgePatchArtifact(target, patchText)
  const first = runtime.observeCodeForgePatchArtifact(target.artifactPath)
  runtime.publishCodeForgePatchArtifact(target, patchText)
  const second = runtime.observeCodeForgePatchArtifact(target.artifactPath)
  assert.deepEqual(second, first, 'duplicate publication must reuse one immutable artifact')
  assert.deepEqual(temporaryFiles(root), [])
  return {
    artifactCount: canonicalPatchFiles(root).length,
    identityStable: sameIdentity(first.identity, second.identity),
    canonicalDigest: second.sha256
  }
}

function verifyOutOfOrder(modulePath) {
  const root = scenarioRoot('out-of-order')
  const runtime = require(modulePath)
  const current = buildTarget(runtime, root, patchText)
  runtime.publishCodeForgePatchArtifact(current, patchText)
  const before = readFileSync(current.artifactPath)
  const staleText = `${patchText}# stale\n`
  const stale = { ...buildTarget(runtime, root, staleText), artifactPath: current.artifactPath }
  assert.throws(
    () => runtime.publishCodeForgePatchArtifact(stale, staleText),
    /target .*偏离|冻结路径或文件系统身份/
  )
  const after = readFileSync(current.artifactPath)
  assert.deepEqual(after, before, 'delayed stale publication must not replace the current artifact')
  assert.deepEqual(temporaryFiles(root), [])
  return {
    staleDigest: stale.patchSha256,
    canonicalDigest: current.patchSha256,
    storeByteStable: true
  }
}

function buildTarget(runtime, artifactRoot, text) {
  const patchSha256 = sha256(Buffer.from(text, 'utf8'))
  const patchBytes = Buffer.byteLength(text, 'utf8')
  const seed = {
    repoRoot: artifactRoot,
    worktreePath: artifactRoot,
    baseSha: '1'.repeat(40),
    headSha: '2'.repeat(40),
    patchSha256,
    patchBytes
  }
  return {
    kind: 'code_forge_patch',
    targetKind: 'repository',
    repoRoot: artifactRoot,
    repoRootIdentity: identity(artifactRoot),
    gitCommonDir: artifactRoot,
    gitCommonDirIdentity: identity(artifactRoot),
    worktreePath: artifactRoot,
    worktreeRootIdentity: identity(artifactRoot),
    worktreeGitDir: artifactRoot,
    worktreeGitDirIdentity: identity(artifactRoot),
    baseSha: seed.baseSha,
    headSha: seed.headSha,
    changedPaths: ['example.txt'],
    insertions: 1,
    deletions: 0,
    sourceStateDigest: sha256(Buffer.from('source-state', 'utf8')),
    artifactRoot,
    artifactRootIdentity: identity(artifactRoot),
    artifactPath: runtime.codeForgePatchArtifactPath(seed, artifactRoot),
    artifactPreState: 'absent',
    patchSha256,
    patchBytes
  }
}

function invokeWorker(modulePath, target, checkpoint, killAtCheckpoint) {
  return new Promise((resolve, reject) => {
    const child = fork(process.argv[1], ['worker'], {
      cwd: repoRoot,
      execArgv: [],
      env: {
        ...process.env,
        CAOGEN_PATCH_MODULE: modulePath,
        CAOGEN_PATCH_TARGET: JSON.stringify(target),
        CAOGEN_PATCH_TEXT: Buffer.from(patchText, 'utf8').toString('base64'),
        CAOGEN_PATCH_CHECKPOINT: checkpoint
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    let settled = false
    let message
    let stderr = ''
    const timeout = setTimeout(() => finish(new Error(`patch writer timed out at ${checkpoint}`)), 15_000)
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
  const realFs = require('node:fs')
  const originalLoad = Module._load
  const target = JSON.parse(requiredEnv('CAOGEN_PATCH_TARGET'))
  const checkpoint = requiredEnv('CAOGEN_PATCH_CHECKPOINT')
  let candidateDescriptor
  let directoryDescriptor
  let published = false
  Module._load = function patchedLoad(request, owner, isMain) {
    if (request === 'node:fs') {
      return {
        ...realFs,
        openSync(file, ...args) {
          const descriptor = realFs.openSync(file, ...args)
          const resolved = path.resolve(String(file))
          if (resolved === path.resolve(target.artifactRoot)) directoryDescriptor = descriptor
          if (resolved !== path.resolve(target.artifactPath) && path.dirname(resolved) === path.resolve(target.artifactRoot) && resolved.endsWith('.tmp')) {
            candidateDescriptor = descriptor
          }
          return descriptor
        },
        writeFileSync(descriptor, ...args) {
          const result = realFs.writeFileSync(descriptor, ...args)
          if (descriptor === candidateDescriptor && checkpoint === 'after_write') pauseAt(checkpoint)
          return result
        },
        fsyncSync(descriptor) {
          const result = realFs.fsyncSync(descriptor)
          if (descriptor === candidateDescriptor && checkpoint === 'after_file_sync') pauseAt(checkpoint)
          if (descriptor === directoryDescriptor && published && checkpoint === 'post_directory_sync_throw') {
            throw Object.assign(new Error('injected post-publication unknown result'), { code: 'EUNKNOWNRESULT' })
          }
          return result
        },
        linkSync(source, destination) {
          const result = realFs.linkSync(source, destination)
          if (path.resolve(String(destination)) === path.resolve(target.artifactPath)) {
            published = true
            if (checkpoint === 'after_link') pauseAt(checkpoint)
          }
          return result
        }
      }
    }
    return originalLoad.call(this, request, owner, isMain)
  }
  try {
    const runtime = require(requiredEnv('CAOGEN_PATCH_MODULE'))
    const text = Buffer.from(requiredEnv('CAOGEN_PATCH_TEXT'), 'base64').toString('utf8')
    runtime.publishCodeForgePatchArtifact(target, text)
    process.send?.({ type: 'completed' })
  } catch (error) {
    process.send?.({ type: 'error', code: error?.code, message: String(error?.message ?? error) })
    process.exitCode = 2
  } finally {
    Module._load = originalLoad
  }
}

function pauseAt(checkpoint) {
  process.send?.({ type: 'checkpoint', checkpoint })
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}

function compileSource() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/code-forge/patch-artifact.ts',
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
  return realpathSync(root)
}

function canonicalPatchFiles(root) {
  return readdirSync(root).filter((name) => /^caogen-code-forge-[a-f0-9]{64}\.patch$/.test(name)).sort()
}

function temporaryFiles(root) {
  return readdirSync(root).filter((name) => name.endsWith('.tmp')).sort()
}

function identity(file) {
  const info = statSync(file)
  return { device: String(info.dev), inode: String(info.ino) }
}

function sameIdentity(left, right) {
  return left?.device === right?.device && left?.inode === right?.inode
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
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
