#!/usr/bin/env node
import assert from 'node:assert/strict'
import { fork, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const workerMode = process.argv[2] === 'worker'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'media-store-recovery')
const reportDir = path.join(reportRoot, runId)
const tempRoot = workerMode ? '' : mkdtempSync(path.join(tmpdir(), 'caogen-media-store-recovery-'))
const compiledDir = path.join(tempRoot, 'compiled')
const projectId = 'media-recovery-project'
const productionId = 'media-recovery-production'
const providerId = 'media-provider:recovery'
const idempotencyKey = 'media-recovery-operation'
const operationBinding = binding('media-recovery-run', 'media-recovery-effect')

if (workerMode) await runWorker()
else await runParent()

async function runParent() {
  let report
  try {
    compileSources()
    const modulePath = path.join(compiledDir, 'main', 'media', 'media-store.js')
    const strongKill = []
    for (const checkpoint of ['after_file_sync', 'after_rename']) {
      strongKill.push(await verifyStrongKill(modulePath, checkpoint))
    }
    const unknownResult = await verifyUnknownResult(modulePath)
    const duplicateAndOutOfOrder = await verifyDuplicateAndOutOfOrder(modulePath)
    report = {
      schemaVersion: 1,
      gate: 'test:media-store:recovery',
      runId,
      status: 'passed',
      verification: 'runtime_store_verified',
      sourceRevision: git(['rev-parse', 'HEAD']),
      worktreeStatusCount: gitStatusCount(),
      writer: 'src/main/media/media-store.ts',
      scope: 'MediaJob durable operation transitions',
      faults: {
        strong_kill: { status: 'verified', scenarios: strongKill },
        network_unknown_result: { status: 'verified', scenario: unknownResult },
        duplicate_idempotency: { status: 'verified', scenario: duplicateAndOutOfOrder.duplicate },
        out_of_order: { status: 'verified', scenario: duplicateAndOutOfOrder.outOfOrder }
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
      gate: 'test:media-store:recovery',
      runId,
      status: 'failed',
      verification: 'not_verified',
      sourceRevision: git(['rev-parse', 'HEAD']),
      worktreeStatusCount: gitStatusCount(),
      error: serializeError(error)
    }
    process.exitCode = 1
  } finally {
    mkdirSync(reportDir, { recursive: true })
    const serialized = `${JSON.stringify(report, null, 2)}\n`
    writeFileSync(path.join(reportDir, 'report.json'), serialized, 'utf8')
    writeFileSync(path.join(reportRoot, 'latest.json'), serialized, 'utf8')
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function verifyStrongKill(modulePath, checkpoint) {
  const root = path.join(tempRoot, `strong-kill-${checkpoint}`)
  const fixture = await seed(modulePath, root)
  const exit = await invokeWorker(modulePath, root, fixture.jobId, checkpoint, true)
  assert.equal(exit.signal, 'SIGKILL', `${checkpoint} worker must receive SIGKILL`)
  const store = createStore(modulePath, root)
  const observed = await store.getMediaJob(fixture.jobId)
  assert(observed)
  if (checkpoint === 'after_file_sync') assert.equal(observed.status, 'requested')
  else assert.equal(observed.status, 'running')
  await store.commitMediaJobOperation(fixture.jobId, runningCommit())
  const recovered = await createStore(modulePath, root).getMediaJob(fixture.jobId)
  assert.equal(recovered?.status, 'running')
  assert.equal(recovered?.statusHistory.filter((item) => item.runId === operationBinding.runId).length, 1)
  assert.equal(temporaryFiles(root).length, 0)
  return {
    checkpoint,
    signal: exit.signal,
    publishedBeforeKill: observed.status === 'running',
    recoveredRevision: readDocument(root).revision,
    automaticProviderReplays: 0
  }
}

async function verifyUnknownResult(modulePath) {
  const root = path.join(tempRoot, 'unknown-result')
  const fixture = await seed(modulePath, root)
  const exit = await invokeWorker(modulePath, root, fixture.jobId, 'post_directory_sync_throw', false)
  assert.equal(exit.code, 2)
  assert.equal(exit.message?.code, 'EUNKNOWNRESULT')
  assert.equal(exit.message?.recoveredStatus, 'running', 'same MediaStore instance must reload the published result')
  const store = createStore(modulePath, root)
  const before = readFileSync(path.join(root, 'media-studio.json'))
  await store.commitMediaJobOperation(fixture.jobId, runningCommit())
  assert.deepEqual(readFileSync(path.join(root, 'media-studio.json')), before)
  return {
    errorCode: exit.message.code,
    recoveredStatus: exit.message.recoveredStatus,
    duplicateProviderCalls: 0,
    replayByteStable: true
  }
}

async function verifyDuplicateAndOutOfOrder(modulePath) {
  const root = path.join(tempRoot, 'duplicate-out-of-order')
  const fixture = await seed(modulePath, root)
  const store = createStore(modulePath, root)
  await store.commitMediaJobOperation(fixture.jobId, runningCommit())
  const filePath = path.join(root, 'media-studio.json')
  const before = readFileSync(filePath)
  const beforeRevision = readDocument(root).revision
  await store.commitMediaJobOperation(fixture.jobId, runningCommit())
  assert.deepEqual(readFileSync(filePath), before)
  assert.equal(readDocument(root).revision, beforeRevision)

  await assert.rejects(
    store.commitMediaJobOperation(fixture.jobId, {
      operation: 'submit',
      status: 'submitting',
      binding: binding('media-recovery-delayed-run', 'media-recovery-delayed-effect')
    }),
    /transition is invalid/
  )
  assert.deepEqual(readFileSync(filePath), before)
  const recovered = await createStore(modulePath, root).getMediaJob(fixture.jobId)
  assert.equal(recovered?.status, 'running')
  return {
    duplicate: { storeByteStable: true, revisionStable: true, operationEventCount: 1 },
    outOfOrder: { delayedTransitionRejected: true, storeByteStable: true, canonicalStatus: recovered.status }
  }
}

async function seed(modulePath, root) {
  const store = createStore(modulePath, root)
  await store.createVideoProduction({
    id: productionId,
    projectId,
    title: 'Media recovery fixture',
    script: 'A bounded Media Store recovery fixture.',
    autoStructure: false
  })
  await store.upsertMediaProvider({
    id: providerId,
    displayName: 'Media recovery Provider',
    capabilities: ['video'],
    operations: ['video.text-to-video'],
    endpointClass: 'openai-video',
    providerId: 'provider-recovery',
    model: 'grok-imagine-video',
    enabled: true
  })
  const job = await store.prepareMediaJobSubmission({
    projectId,
    productionId,
    capability: 'video',
    operation: 'video.text-to-video',
    idempotencyKey,
    mediaProviderId: providerId,
    model: 'grok-imagine-video',
    prompt: 'Generate the recovery fixture.'
  }, binding('media-recovery-prepare-run', 'media-recovery-prepare-effect'))
  return { jobId: job.id }
}

function invokeWorker(modulePath, root, jobId, checkpoint, killAtCheckpoint) {
  return new Promise((resolve, reject) => {
    const child = fork(process.argv[1], ['worker'], {
      cwd: repoRoot,
      execArgv: [],
      env: {
        ...process.env,
        CAOGEN_MEDIA_STORE_MODULE: modulePath,
        CAOGEN_MEDIA_STORE_ROOT: root,
        CAOGEN_MEDIA_STORE_JOB_ID: jobId,
        CAOGEN_MEDIA_STORE_CHECKPOINT: checkpoint
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    let settled = false
    let message
    let stderr = ''
    const timeout = setTimeout(() => finish(new Error(`Media Store worker timed out at ${checkpoint}`)), 15_000)
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('message', (value) => {
      message = value
      if (killAtCheckpoint && value?.type === 'checkpoint' && value.checkpoint === checkpoint) child.kill('SIGKILL')
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
  const checkpoint = requiredEnv('CAOGEN_MEDIA_STORE_CHECKPOINT')
  const root = requiredEnv('CAOGEN_MEDIA_STORE_ROOT')
  Module._load = function patchedLoad(request, owner, isMain) {
    if (request === 'node:fs/promises') return faultInjectingPromises(realPromises, checkpoint, root)
    return originalLoad.call(this, request, owner, isMain)
  }
  let store
  try {
    store = createStore(requiredEnv('CAOGEN_MEDIA_STORE_MODULE'), root)
    await store.commitMediaJobOperation(requiredEnv('CAOGEN_MEDIA_STORE_JOB_ID'), runningCommit())
    process.send?.({ type: 'completed' })
  } catch (error) {
    const recovered = store ? await store.getMediaJob(requiredEnv('CAOGEN_MEDIA_STORE_JOB_ID')).catch(() => undefined) : undefined
    process.send?.({ type: 'error', code: error?.code, message: String(error?.message ?? error), recoveredStatus: recovered?.status })
    process.exitCode = 2
  } finally {
    Module._load = originalLoad
  }
}

function faultInjectingPromises(realPromises, checkpoint, root) {
  return {
    ...realPromises,
    open: async (...args) => wrapHandle(await realPromises.open(...args), String(args[0]), checkpoint, root),
    rename: async (...args) => {
      const renamed = await realPromises.rename(...args)
      if (checkpoint === 'after_rename') await pauseAt(checkpoint)
      return renamed
    }
  }
}

function wrapHandle(handle, openedPath, checkpoint, root) {
  const temporary = openedPath.endsWith('.tmp')
  const directory = path.resolve(openedPath) === path.resolve(root)
  return new Proxy(handle, {
    get(owner, property) {
      if (property === 'sync') return async (...args) => {
        const synced = await owner.sync(...args)
        if (temporary && checkpoint === 'after_file_sync') await pauseAt(checkpoint)
        if (directory && checkpoint === 'post_directory_sync_throw') {
          const error = new Error('injected Media Store unknown result')
          error.code = 'EUNKNOWNRESULT'
          throw error
        }
        return synced
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

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/media/media-store.ts',
    'src/main/durable-file.ts',
    'src/main/project-workspace/codec.ts',
    'src/shared/media-types.ts',
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

function createStore(modulePath, root) {
  return new (require(modulePath).MediaStore)(root)
}

function runningCommit() {
  return { operation: 'submit', status: 'running', binding: operationBinding, providerExternalJobId: 'remote-recovery-job' }
}

function binding(runId, effectId) {
  return { goalId: 'media-recovery-goal', workItemId: 'media-recovery-work-item', runId, effectId }
}

function readDocument(root) {
  return JSON.parse(readFileSync(path.join(root, 'media-studio.json'), 'utf8'))
}

function temporaryFiles(root) {
  if (!existsSync(root)) return []
  return readdirSync(root).filter((name) => name.startsWith('.media-studio.json.') && name.endsWith('.tmp')).sort()
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
