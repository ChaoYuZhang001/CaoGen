#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
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
const reportRoot = path.join(repoRoot, 'test-results', 'git-index-artifact-store-recovery')
const reportDir = path.join(reportRoot, runId)
const tempRoot = workerMode
  ? ''
  : realpathSync(mkdtempSync(path.join(tmpdir(), 'caogen-git-index-artifact-recovery-')))
const compiledDir = path.join(tempRoot, 'compiled')
const writer = 'src/main/git/git-index-artifact.ts'

if (workerMode) runWorker()
else void runParent()

async function runParent() {
  let report
  try {
    compileSources()
    const modulePath = path.join(compiledDir, 'main', 'git', 'git-index-artifact.js')
    const artifactKills = []
    for (const checkpoint of ['after_write', 'after_file_sync', 'after_rename']) {
      artifactKills.push(await verifyArtifactStrongKill(modulePath, checkpoint))
    }
    const objectKills = []
    for (const checkpoint of ['after_object_file_sync', 'after_link']) {
      objectKills.push(await verifyObjectStrongKill(modulePath, checkpoint))
    }
    report = {
      schemaVersion: 1,
      gate: 'test:git-index-artifact-store-recovery',
      runId,
      status: 'passed',
      verification: 'runtime_store_verified',
      sourceRevision: git(['rev-parse', 'HEAD']),
      worktreeStatusCount: gitStatusCount(),
      writer,
      scope: 'immutable Git index artifact directories and loose-object promotion',
      faults: {
        strong_kill: { status: 'verified', scenarios: [...artifactKills, ...objectKills] },
        network_unknown_result: {
          status: 'verified',
          scenario: {
            artifact: await verifyArtifactUnknownResult(modulePath),
            looseObject: await verifyObjectUnknownResult(modulePath)
          }
        },
        duplicate_idempotency: { status: 'verified', scenario: verifyDuplicate(modulePath) },
        out_of_order: { status: 'verified', scenario: verifyOutOfOrder(modulePath) }
      }
    }
  } catch (error) {
    report = {
      schemaVersion: 1,
      gate: 'test:git-index-artifact-store-recovery',
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

async function verifyArtifactStrongKill(modulePath, checkpoint) {
  const fixture = createFixture(`artifact-kill-${checkpoint}`)
  const exit = await invokeWorker(modulePath, fixture, 'persist', checkpoint, true)
  assert.equal(exit.signal, 'SIGKILL', `${checkpoint} artifact worker must receive SIGKILL`)
  const published = existsSync(fixture.artifactRoot)
  assert.equal(published, checkpoint === 'after_rename')
  if (published) validateArtifactTree(fixture)

  const runtime = loadRuntime(modulePath, fixture.userData)
  const view = runtime.persistGitIndexArtifact(fixture.intent, fixture.indexBytes, fixture.tempObjects)
  assert.equal(view.artifactRoot, fixture.artifactRoot)
  validateArtifactTree(fixture)
  assert.deepEqual(artifactTemps(fixture), [])
  return {
    boundary: 'artifact_directory',
    checkpoint,
    signal: exit.signal,
    publishedBeforeKill: published,
    artifactDigest: digestTree(fixture.artifactRoot),
    orphanTemporaryCount: 0
  }
}

async function verifyObjectStrongKill(modulePath, checkpoint) {
  const fixture = createFixture(`object-kill-${checkpoint}`)
  const runtime = loadRuntime(modulePath, fixture.userData)
  const view = runtime.persistGitIndexArtifact(fixture.intent, fixture.indexBytes, fixture.tempObjects)
  const target = targetFor(fixture, view)
  const exit = await invokeWorker(modulePath, fixture, 'promote', checkpoint, true, target)
  assert.equal(exit.signal, 'SIGKILL', `${checkpoint} object worker must receive SIGKILL`)
  assert.equal(existsSync(fixture.looseDestination), checkpoint === 'after_link')

  const restarted = loadRuntime(modulePath, fixture.userData)
  const frozen = restarted.readFrozenGitIndexArtifact(target)
  restarted.promoteGitIndexArtifactObjects(target, frozen)
  assert.deepEqual(readFileSync(fixture.looseDestination), fixture.objectBytes)
  assert.deepEqual(looseTemps(fixture), [])
  return {
    boundary: 'loose_object',
    checkpoint,
    signal: exit.signal,
    publishedBeforeKill: checkpoint === 'after_link',
    objectDigest: sha256(readFileSync(fixture.looseDestination)),
    orphanTemporaryCount: 0
  }
}

async function verifyArtifactUnknownResult(modulePath) {
  const fixture = createFixture('artifact-unknown-result')
  const exit = await invokeWorker(modulePath, fixture, 'persist', 'post_artifact_directory_sync_throw', false)
  assert.equal(exit.code, 2)
  assert.equal(exit.message?.code, 'EUNKNOWNRESULT')
  assert.equal(exit.message?.retryIdentityStable, true)
  validateArtifactTree(fixture)
  return {
    errorCode: exit.message.code,
    retryIdentityStable: true,
    artifactDigest: digestTree(fixture.artifactRoot)
  }
}

async function verifyObjectUnknownResult(modulePath) {
  const fixture = createFixture('object-unknown-result')
  const runtime = loadRuntime(modulePath, fixture.userData)
  const view = runtime.persistGitIndexArtifact(fixture.intent, fixture.indexBytes, fixture.tempObjects)
  const target = targetFor(fixture, view)
  const exit = await invokeWorker(modulePath, fixture, 'promote', 'post_object_directory_sync_throw', false, target)
  assert.equal(exit.code, 2)
  assert.equal(exit.message?.code, 'EUNKNOWNRESULT')
  assert.equal(exit.message?.retryIdentityStable, true)
  assert.deepEqual(readFileSync(fixture.looseDestination), fixture.objectBytes)
  return {
    errorCode: exit.message.code,
    retryIdentityStable: true,
    objectDigest: sha256(readFileSync(fixture.looseDestination))
  }
}

function verifyDuplicate(modulePath) {
  const fixture = createFixture('duplicate')
  const runtime = loadRuntime(modulePath, fixture.userData)
  const first = runtime.persistGitIndexArtifact(fixture.intent, fixture.indexBytes, fixture.tempObjects)
  const artifactBefore = artifactIdentity(fixture)
  const second = runtime.persistGitIndexArtifact(fixture.intent, fixture.indexBytes, fixture.tempObjects)
  assert.deepEqual(artifactIdentity(fixture), artifactBefore)
  assert.equal(second.indexArtifactSha256, first.indexArtifactSha256)

  const target = targetFor(fixture, first)
  const frozen = runtime.readFrozenGitIndexArtifact(target)
  runtime.promoteGitIndexArtifactObjects(target, frozen)
  const objectBefore = fileIdentity(fixture.looseDestination)
  runtime.promoteGitIndexArtifactObjects(target, frozen)
  assert.deepEqual(fileIdentity(fixture.looseDestination), objectBefore)
  return {
    artifactIdentityStable: true,
    looseObjectIdentityStable: true,
    artifactDigest: artifactBefore.digest,
    objectDigest: objectBefore.digest
  }
}

function verifyOutOfOrder(modulePath) {
  const fixture = createFixture('out-of-order')
  const runtime = loadRuntime(modulePath, fixture.userData)
  const view = runtime.persistGitIndexArtifact(fixture.intent, fixture.indexBytes, fixture.tempObjects)
  const before = artifactIdentity(fixture)
  assert.throws(
    () => runtime.persistGitIndexArtifact(fixture.intent, Buffer.from('delayed conflicting index bytes\n'), fixture.tempObjects),
    /Git index artifact identity conflict/
  )
  assert.deepEqual(artifactIdentity(fixture), before)

  const target = targetFor(fixture, view)
  const frozen = runtime.readFrozenGitIndexArtifact(target)
  mkdirSync(path.dirname(fixture.looseDestination), { recursive: true })
  const conflictingLoose = looseObjectBytes(Buffer.from('conflicting loose object'))
  writeFileSync(fixture.looseDestination, conflictingLoose.compressed)
  const conflictingBefore = readFileSync(fixture.looseDestination)
  assert.throws(
    () => runtime.promoteGitIndexArtifactObjects(target, frozen),
    /Git loose object OID 不匹配/
  )
  assert.deepEqual(readFileSync(fixture.looseDestination), conflictingBefore)
  return {
    delayedArtifactRejected: true,
    conflictingLooseObjectRejected: true,
    artifactByteStable: true,
    looseObjectByteStable: true
  }
}

function runWorker() {
  const Module = require('node:module').Module
  const realFs = require('node:fs')
  const originalLoad = Module._load
  const fixture = deserializeFixture(JSON.parse(requiredEnv('CAOGEN_GIT_ARTIFACT_FIXTURE')))
  const mode = requiredEnv('CAOGEN_GIT_ARTIFACT_MODE')
  const checkpoint = requiredEnv('CAOGEN_GIT_ARTIFACT_CHECKPOINT')
  Module._load = function patchedLoad(request, owner, isMain) {
    if (request === 'electron') return { app: { getPath: () => fixture.userData } }
    if (request === 'node:fs') return faultInjectingFs(realFs, fixture, checkpoint)
    return originalLoad.call(this, request, owner, isMain)
  }
  let runtime
  try {
    runtime = require(requiredEnv('CAOGEN_GIT_ARTIFACT_MODULE'))
    if (mode === 'persist') runtime.persistGitIndexArtifact(fixture.intent, fixture.indexBytes, fixture.tempObjects)
    else promote(runtime, fixture, JSON.parse(requiredEnv('CAOGEN_GIT_ARTIFACT_TARGET')))
    process.send?.({ type: 'completed' })
  } catch (error) {
    try {
      const before = mode === 'persist' ? artifactIdentity(fixture) : fileIdentity(fixture.looseDestination)
      if (mode === 'persist') runtime.persistGitIndexArtifact(fixture.intent, fixture.indexBytes, fixture.tempObjects)
      else promote(runtime, fixture, JSON.parse(requiredEnv('CAOGEN_GIT_ARTIFACT_TARGET')))
      const after = mode === 'persist' ? artifactIdentity(fixture) : fileIdentity(fixture.looseDestination)
      process.send?.({
        type: 'error',
        code: error?.code,
        message: String(error?.message ?? error),
        retryIdentityStable: JSON.stringify(before) === JSON.stringify(after)
      })
    } catch (retryError) {
      process.send?.({
        type: 'error',
        code: error?.code,
        message: String(error?.message ?? error),
        retryError: String(retryError?.message ?? retryError),
        retryIdentityStable: false
      })
    }
    process.exitCode = 2
  } finally {
    Module._load = originalLoad
  }
}

function promote(runtime, fixture, target) {
  const frozen = runtime.readFrozenGitIndexArtifact(target)
  runtime.promoteGitIndexArtifactObjects(target, frozen)
}

async function invokeWorker(modulePath, fixture, mode, checkpoint, killAtCheckpoint, target) {
  const result = await execWorker(modulePath, fixture, mode, checkpoint, killAtCheckpoint, target)
  if (result.error) throw result.error
  return result
}

function execWorker(modulePath, fixture, mode, checkpoint, killAtCheckpoint, target) {
  return new Promise((resolve) => {
    const child = fork(process.argv[1], ['worker'], {
      cwd: repoRoot,
      execArgv: [],
      env: {
        ...process.env,
        CAOGEN_GIT_ARTIFACT_MODULE: modulePath,
        CAOGEN_GIT_ARTIFACT_MODE: mode,
        CAOGEN_GIT_ARTIFACT_CHECKPOINT: checkpoint,
        CAOGEN_GIT_ARTIFACT_FIXTURE: JSON.stringify(serializeFixture(fixture)),
        ...(target ? { CAOGEN_GIT_ARTIFACT_TARGET: JSON.stringify(target) } : {})
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    let message
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ error: new Error(`Git index artifact worker timed out at ${checkpoint}`) })
    }, 15_000)
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('message', (value) => {
      message = value
      if (killAtCheckpoint && value?.type === 'checkpoint' && value.checkpoint === checkpoint) {
        child.kill('SIGKILL')
      }
    })
    child.once('error', (error) => finish({ error }))
    child.once('exit', (code, signal) => finish({ code, signal, message, stderr }))
  })
}

function faultInjectingFs(realFs, fixture, checkpoint) {
  const descriptors = new Map()
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
    writeFileSync: (target, ...args) => {
      const result = realFs.writeFileSync(target, ...args)
      const openedPath = typeof target === 'number' ? descriptors.get(target) : path.resolve(String(target))
      if (checkpoint === 'after_write' && isArtifactIndexCandidate(openedPath, fixture)) pauseAt(checkpoint)
      return result
    },
    fsyncSync: (descriptor) => {
      const result = realFs.fsyncSync(descriptor)
      const openedPath = descriptors.get(descriptor)
      if (checkpoint === 'after_file_sync' && isArtifactIndexCandidate(openedPath, fixture)) pauseAt(checkpoint)
      if (checkpoint === 'after_object_file_sync' && path.basename(openedPath ?? '').startsWith('.caogen-')) pauseAt(checkpoint)
      if (checkpoint === 'post_artifact_directory_sync_throw' && openedPath === fixture.artifactBase) throw unknownResultError()
      if (checkpoint === 'post_object_directory_sync_throw' && openedPath === path.dirname(fixture.looseDestination)) throw unknownResultError()
      return result
    },
    renameSync: (...args) => {
      const result = realFs.renameSync(...args)
      if (checkpoint === 'after_rename' && path.resolve(String(args[1])) === fixture.artifactRoot) pauseAt(checkpoint)
      return result
    },
    linkSync: (...args) => {
      const result = realFs.linkSync(...args)
      if (checkpoint === 'after_link' && path.resolve(String(args[1])) === fixture.looseDestination) pauseAt(checkpoint)
      return result
    }
  }
}

function isArtifactIndexCandidate(openedPath, fixture) {
  return Boolean(openedPath && path.basename(openedPath) === 'index' &&
    path.dirname(openedPath).startsWith(`${fixture.artifactBase}${path.sep}.`))
}

function unknownResultError() {
  return Object.assign(new Error('injected Git index artifact unknown result'), { code: 'EUNKNOWNRESULT' })
}

function pauseAt(checkpoint) {
  process.send?.({ type: 'checkpoint', checkpoint })
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}

function createFixture(name) {
  const root = path.join(tempRoot, name)
  const userData = path.join(root, 'user-data')
  const tempObjects = path.join(root, 'temporary-objects')
  const objectDir = path.join(root, 'repository-objects')
  mkdirSync(userData, { recursive: true })
  mkdirSync(tempObjects, { recursive: true })
  mkdirSync(objectDir, { recursive: true })
  const object = looseObjectBytes(Buffer.from(`Git index artifact recovery object: ${name}\n`))
  const objectPath = `${object.id.slice(0, 2)}/${object.id.slice(2)}`
  mkdirSync(path.join(tempObjects, object.id.slice(0, 2)), { recursive: true })
  writeFileSync(path.join(tempObjects, objectPath), object.compressed)
  const indexBytes = Buffer.from(`Git index artifact recovery index: ${name}\n`)
  const intent = {
    repoRoot: path.join(root, 'repo'),
    worktreeGitDir: path.join(root, 'repo', '.git'),
    preIndexState: 'absent',
    preEntriesDigest: `pre-entries-${name}`,
    expectedEntriesDigest: `expected-entries-${name}`,
    operation: 'stage_paths',
    paths: ['recovery.txt']
  }
  const key = sha256(Buffer.from(JSON.stringify({ schemaVersion: 1, ...intent }), 'utf8'))
  const artifactBase = path.join(userData, 'effect-artifacts', 'git-index')
  const artifactRoot = path.join(artifactBase, key)
  const looseDestination = path.join(objectDir, objectPath)
  return {
    root,
    userData,
    tempObjects,
    objectDir,
    objectId: object.id,
    objectPath,
    objectBytes: object.compressed,
    indexBytes,
    intent,
    key,
    artifactBase,
    artifactRoot,
    looseDestination
  }
}

function targetFor(fixture, view) {
  return {
    kind: 'git_index_update',
    objectDir: path.resolve(fixture.objectDir),
    objectDirIdentity: fileIdentityRecord(fixture.objectDir),
    objectFormat: 'sha1',
    expectedIndexEntriesDigest: fixture.intent.expectedEntriesDigest,
    ...view
  }
}

function loadRuntime(modulePath, userData) {
  const Module = require('node:module').Module
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, owner, isMain) {
    if (request === 'electron') return { app: { getPath: () => userData } }
    return originalLoad.call(this, request, owner, isMain)
  }
  try {
    delete require.cache[require.resolve(modulePath)]
    return require(modulePath)
  } finally {
    Module._load = originalLoad
  }
}

function validateArtifactTree(fixture) {
  assert(existsSync(path.join(fixture.artifactRoot, 'index')))
  assert(existsSync(path.join(fixture.artifactRoot, 'manifest.json')))
  assert(existsSync(path.join(fixture.artifactRoot, 'objects', fixture.objectPath)))
  assert.deepEqual(readFileSync(path.join(fixture.artifactRoot, 'index')), fixture.indexBytes)
  assert.deepEqual(readFileSync(path.join(fixture.artifactRoot, 'objects', fixture.objectPath)), fixture.objectBytes)
}

function artifactIdentity(fixture) {
  return {
    root: fileIdentityRecord(fixture.artifactRoot),
    index: fileIdentity(path.join(fixture.artifactRoot, 'index')),
    manifest: fileIdentity(path.join(fixture.artifactRoot, 'manifest.json')),
    digest: digestTree(fixture.artifactRoot)
  }
}

function artifactTemps(fixture) {
  if (!existsSync(fixture.artifactBase)) return []
  return readdirSync(fixture.artifactBase).filter((entry) => entry.startsWith(`.${fixture.key}-`) && entry.endsWith('.tmp')).sort()
}

function looseTemps(fixture) {
  const directory = path.dirname(fixture.looseDestination)
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter((entry) => entry.startsWith('.caogen-') && entry.endsWith('.tmp')).sort()
}

function digestTree(root) {
  const hash = createHash('sha256')
  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      hash.update(relative).update('\0')
      if (entry.isDirectory()) visit(path.join(directory, entry.name), relative)
      else hash.update(readFileSync(path.join(directory, entry.name))).update('\0')
    }
  }
  visit(root)
  return hash.digest('hex')
}

function looseObjectBytes(content) {
  const loose = Buffer.concat([Buffer.from(`blob ${content.byteLength}\0`, 'ascii'), content])
  return { id: createHash('sha1').update(loose).digest('hex'), compressed: deflateSync(loose) }
}

function fileIdentity(file) {
  const info = statSync(file)
  return { device: String(info.dev), inode: String(info.ino), size: info.size, digest: sha256(readFileSync(file)) }
}

function fileIdentityRecord(file) {
  const info = statSync(file)
  return { device: String(info.dev), inode: String(info.ino) }
}

function serializeFixture(fixture) {
  return { ...fixture, indexBytes: fixture.indexBytes.toString('base64'), objectBytes: fixture.objectBytes.toString('base64') }
}

function deserializeFixture(fixture) {
  return { ...fixture, indexBytes: Buffer.from(fixture.indexBytes, 'base64'), objectBytes: Buffer.from(fixture.objectBytes, 'base64') }
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/git/git-index-artifact.ts',
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function git(args) {
  try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim() } catch { return '' }
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
