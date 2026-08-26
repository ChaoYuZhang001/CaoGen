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
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const scriptPath = fileURLToPath(import.meta.url)
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
const workerMode = process.argv[2] === '--worker'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'workflow-artifact-delivery-recovery')
const reportDir = path.join(reportRoot, runId)
const tempRoot = workerMode ? '' : mkdtempSync(path.join(tmpdir(), 'caogen-delivery-recovery-'))
const compiledDir = path.join(tempRoot, 'compiled')
const writer = 'src/main/task/workflow-artifact-delivery.ts'

if (workerMode) await runWorker()
else await runParent()

async function runParent() {
  let report
  try {
    compileSources()
    installElectronStub()
    const modulePath = path.join(compiledDir, 'main', 'task', 'workflow-artifact-delivery.js')
    const runtime = await import(pathToFileURL(modulePath).href)
    const strongKill = []
    for (const checkpoint of ['after_write', 'after_file_sync', 'after_publish']) {
      strongKill.push(await verifyStrongKill(modulePath, runtime, checkpoint))
    }
    report = {
      schemaVersion: 1,
      gate: 'test:workflow-artifact-delivery-recovery',
      runId,
      status: 'passed',
      verification: 'runtime_publication_verified',
      sourceRevision: git(['rev-parse', 'HEAD']),
      worktreeStatusCount: gitStatusCount(),
      writer,
      scope: 'Verified Artifact delivery manifest and shared package publication boundary',
      faults: {
        strong_kill: { status: 'verified', scenarios: strongKill },
        network_unknown_result: { status: 'verified', scenario: await verifyUnknownResult(modulePath, runtime) },
        duplicate_idempotency: { status: 'verified', scenario: await verifyDuplicate(runtime) },
        out_of_order: { status: 'verified', scenario: await verifyOutOfOrder(runtime) }
      },
      packagePublication: {
        finalPublisher: 'src/main/durable-file.ts',
        normalZipPathCoveredBy: 'test-results/verified-delivery-flow/latest.json'
      }
    }
  } catch (error) {
    report = {
      schemaVersion: 1,
      gate: 'test:workflow-artifact-delivery-recovery',
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

async function verifyStrongKill(modulePath, runtime, checkpoint) {
  const root = scenarioRoot(`strong-kill-${checkpoint}`)
  const target = path.join(root, 'delivery-manifest.json')
  const exit = await invokeWorker(modulePath, root, checkpoint, true, 'strong')
  assert.equal(exit.signal, 'SIGKILL', `${checkpoint} worker must receive SIGKILL`)
  const publishedBeforeKill = checkpoint === 'after_publish'
  assert.equal(existsSync(target), publishedBeforeKill)
  const replay = await publish(runtime, target, manifest('replay'))
  assert.equal(replay.fileName, 'delivery-manifest.json')
  assert.deepEqual(temporaryFiles(root), [])
  return {
    checkpoint,
    signal: exit.signal,
    publishedBeforeKill,
    restartPublishSucceeded: true,
    orphanTemporaryCount: 0,
    finalDigest: sha256(readFileSync(target))
  }
}

async function verifyUnknownResult(modulePath, runtime) {
  const root = scenarioRoot('unknown-result')
  const target = path.join(root, 'delivery-manifest.json')
  const exit = await invokeWorker(modulePath, root, 'post_directory_sync_throw', false, 'unknown')
  assert.equal(exit.code, 2)
  assert.equal(exit.messages.find((message) => message?.type === 'error')?.code, 'EUNKNOWNRESULT')
  const published = JSON.parse(readFileSync(target, 'utf8'))
  assert.equal(published.artifact.id, 'artifact-unknown')
  await publish(runtime, target, manifest('reconciled'))
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).artifact.id, 'artifact-reconciled')
  assert.deepEqual(temporaryFiles(root), [])
  return {
    injectedErrorCode: 'EUNKNOWNRESULT',
    publishedBytesReadBack: true,
    restartReconciled: true,
    finalDigest: sha256(readFileSync(target))
  }
}

async function verifyDuplicate(runtime) {
  const root = scenarioRoot('duplicate')
  const target = path.join(root, 'delivery-manifest.json')
  const body = manifest('duplicate')
  await publish(runtime, target, body)
  const first = fileIdentity(target)
  await publish(runtime, target, body)
  const second = fileIdentity(target)
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')).artifact.id, 'artifact-duplicate')
  assert.equal(second.digest, first.digest)
  return {
    sameManifestReplayed: true,
    byteStable: true,
    finalDigest: second.digest
  }
}

async function verifyOutOfOrder(runtime) {
  const root = scenarioRoot('out-of-order')
  const target = path.join(root, 'delivery-manifest.json')
  const alpha = manifest('alpha')
  const beta = manifest('beta')
  const race = await Promise.allSettled([publish(runtime, target, alpha), publish(runtime, target, beta)])
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(race.filter((result) => result.status === 'rejected').length, 1)
  assert.match(String(race.find((result) => result.status === 'rejected')?.reason?.message), /bytes changed after export/)
  const bytes = readFileSync(target)
  const parsed = JSON.parse(bytes)
  assert(['artifact-alpha', 'artifact-beta'].includes(parsed.artifact.id))
  assert(bytes.equals(Buffer.from(canonicalJson(alpha) + '\n')) || bytes.equals(Buffer.from(canonicalJson(beta) + '\n')))
  assert.deepEqual(temporaryFiles(root), [])
  return {
    concurrentWriters: 2,
    completeGenerationCount: 1,
    winnerArtifactId: parsed.artifact.id,
    noPartialBytes: true,
    finalDigest: sha256(bytes)
  }
}

async function publish(runtime, target, body) {
  return runtime.exportWorkflowArtifactManifestToPath(body, target)
}

function invokeWorker(modulePath, root, checkpoint, killAtCheckpoint, marker) {
  return new Promise((resolve, reject) => {
    const child = fork(scriptPath, ['--worker'], {
      cwd: repoRoot,
      execArgv: [],
      env: {
        ...process.env,
        CAOGEN_DELIVERY_MODULE: modulePath,
        CAOGEN_DELIVERY_ROOT: root,
        CAOGEN_DELIVERY_CHECKPOINT: checkpoint,
        CAOGEN_DELIVERY_MARKER: marker
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    const messages = []
    let settled = false
    let stderr = ''
    const timeout = setTimeout(() => finish(new Error(`delivery worker timed out at ${checkpoint}`)), 20_000)
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('message', (message) => {
      messages.push(message)
      if (killAtCheckpoint && message?.type === 'checkpoint' && message.checkpoint === checkpoint) child.kill('SIGKILL')
    })
    child.on('error', finish)
    child.on('exit', (code, signal) => finish(null, { code, signal, messages, stderr }))
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
  const root = path.resolve(requiredEnv('CAOGEN_DELIVERY_ROOT'))
  const target = path.join(root, 'delivery-manifest.json')
  const parent = path.dirname(target)
  const checkpoint = requiredEnv('CAOGEN_DELIVERY_CHECKPOINT')
  const marker = requiredEnv('CAOGEN_DELIVERY_MARKER')
  Module._load = function patchedLoad(request, owner, isMain) {
    if (request === 'node:fs/promises') return faultInjectingPromises(realPromises, target, parent, checkpoint)
    return originalLoad.call(this, request, owner, isMain)
  }
  try {
    const runtime = require(requiredEnv('CAOGEN_DELIVERY_MODULE'))
    await runtime.exportWorkflowArtifactManifestToPath(manifest(marker), target)
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
    open: async (...args) => wrapHandle(
      await realPromises.open(...args), path.resolve(String(args[0])), target, parent, checkpoint
    ),
    rename: async (...args) => {
      const result = await realPromises.rename(...args)
      if (checkpoint === 'after_publish' && path.resolve(String(args[1])) === target) await pauseAt(checkpoint)
      return result
    }
  }
}

function wrapHandle(handle, openedPath, target, parent, checkpoint) {
  const temporary = openedPath !== target && path.dirname(openedPath) === parent &&
    path.basename(openedPath).startsWith(`.${path.basename(target)}.`) && openedPath.endsWith('.tmp')
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
          throw Object.assign(new Error('injected delivery publication unknown result'), { code: 'EUNKNOWNRESULT' })
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

function manifest(marker) {
  const artifact = {
    id: `artifact-${marker}`,
    projectId: 'delivery-project',
    kind: 'document',
    title: `Delivery ${marker}`,
    version: 1,
    digest: `sha256:${marker.padEnd(64, '0').slice(0, 64)}`,
    sizeBytes: marker.length,
    createdAt: 1_000
  }
  const verification = { verdict: 'blocked', artifact }
  const body = {
    schemaVersion: 1,
    format: 'caogen.artifact-delivery-manifest.v1',
    generatedAt: 1_000,
    artifact,
    lineage: { artifactId: artifact.id, versions: [1] },
    evidence: [],
    acceptances: [],
    verification
  }
  return { ...body, manifestDigest: `sha256:${sha256(Buffer.from(canonicalJson(body)))}` }
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function installElectronStub() {
  const electronDir = path.join(compiledDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), 'module.exports = { app: { getPath: () => process.cwd() } }\n')
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"commonjs"}\n')
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/task/workflow-artifact-delivery.ts',
    '--outDir', compiledDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
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
function temporaryFiles(root) {
  if (!existsSync(root)) return []
  return readdirSync(root).filter((name) => name.startsWith('.delivery-manifest.json.') && name.endsWith('.tmp')).sort()
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
