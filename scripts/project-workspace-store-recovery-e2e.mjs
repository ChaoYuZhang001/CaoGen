#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import { createHash } from 'node:crypto'
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
const reportRoot = path.join(repoRoot, 'test-results', 'project-workspace-store-recovery')
const reportDir = path.join(reportRoot, runId)
const tempRoot = workerMode ? '' : mkdtempSync(path.join(tmpdir(), 'caogen-project-workspace-recovery-'))
const compiledDir = path.join(tempRoot, 'compiled')
const writer = 'src/main/project-workspace/persistence.ts'
const workspaceInput = {
  id: 'project-workspace-recovery-project',
  name: 'Recovery Project',
  kind: 'software',
  resources: [{ kind: 'directory', path: '/tmp/caogen-recovery-project', label: 'Recovery source' }],
  createdAt: Date.UTC(2026, 7, 26, 0, 0, 0),
  updatedAt: Date.UTC(2026, 7, 26, 0, 0, 0)
}
const goalInput = {
  id: 'project-workspace-recovery-goal',
  projectId: workspaceInput.id,
  title: 'Prove Project recovery',
  objective: 'Keep Project, Goal, and WorkItem identity stable across retries',
  createdAt: Date.UTC(2026, 7, 26, 0, 1, 0),
  updatedAt: Date.UTC(2026, 7, 26, 0, 1, 0)
}
const workItemInput = {
  id: 'project-workspace-recovery-item',
  projectId: workspaceInput.id,
  goalId: goalInput.id,
  title: 'Run recovery evidence',
  type: 'testing',
  createdAt: Date.UTC(2026, 7, 26, 0, 2, 0),
  updatedAt: Date.UTC(2026, 7, 26, 0, 2, 0)
}

if (workerMode) await runWorker()
else await runParent()

async function runParent() {
  let report
  try {
    compileSources()
    const modulePath = path.join(compiledDir, 'main', 'project-workspace', 'store.js')
    const strongKill = []
    for (const checkpoint of ['after_write', 'after_file_sync', 'after_rename']) {
      strongKill.push(await verifyStrongKill(modulePath, checkpoint))
    }
    report = {
      schemaVersion: 1,
      gate: 'test:project-workspace-store-recovery',
      runId,
      status: 'passed',
      verification: 'runtime_store_verified',
      sourceRevision: git(['rev-parse', 'HEAD']),
      worktreeStatusCount: gitStatusCount(),
      writer,
      scope: 'ProjectWorkspace Project, Goal, and WorkItem persistence',
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
      gate: 'test:project-workspace-store-recovery',
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
    const serialized = `${JSON.stringify(report, null, 2)}\n`
    writeFileSync(path.join(reportDir, 'report.json'), serialized, 'utf8')
    writeFileSync(path.join(reportRoot, 'latest.json'), serialized, 'utf8')
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
  await openStore(modulePath, root)
  const before = readDocument(root)
  const exit = await invokeWorker(modulePath, root, checkpoint, true)
  assert.equal(exit.signal, 'SIGKILL', `${checkpoint} worker must receive SIGKILL`)
  const observed = readDocument(root)
  assert([before.revision, before.revision + 1].includes(observed.revision), `${checkpoint} left an invalid revision`)

  const store = await openStore(modulePath, root)
  const recovered = await store.createWorkspace(workspaceInput, { expectedStoreRevision: before.revision })
  assert.equal(recovered.id, workspaceInput.id)
  const finalDocument = readDocument(root)
  assert.equal(finalDocument.revision, before.revision + 1)
  assert.equal(finalDocument.workspaces.length, 1)
  assert.equal(finalDocument.workspaces[0].id, workspaceInput.id)
  assert.deepEqual(temporaryFiles(root), [])
  assert.equal(existsSync(lockPath(root)), false, 'dead worker lock must be reaped')
  return {
    checkpoint,
    signal: exit.signal,
    publishedBeforeKill: observed.revision === before.revision + 1,
    recoveredRevision: finalDocument.revision,
    workspaceId: recovered.id,
    canonicalDigest: sha256(readFileSync(storePath(root))),
    orphanTemporaryCount: 0
  }
}

async function verifyUnknownResult(modulePath) {
  const root = scenarioRoot('unknown-result')
  await openStore(modulePath, root)
  const exit = await invokeWorker(modulePath, root, 'post_directory_sync_throw', false)
  assert.equal(exit.code, 2, 'unknown result must remain visible to the caller')
  assert.equal(exit.message?.code, 'EUNKNOWNRESULT')
  assert.equal(exit.message?.replayByteStable, true, 'same request retry must not republish the Store')
  assert.equal(exit.message?.recoveredRevision, 1)
  const document = readDocument(root)
  assert.equal(document.workspaces.length, 1)
  assert.equal(document.workspaces[0].id, workspaceInput.id)
  assert.deepEqual(temporaryFiles(root), [])
  return {
    errorCode: exit.message.code,
    recoveredRevision: document.revision,
    replayByteStable: true,
    workspaceCount: document.workspaces.length,
    orphanTemporaryCount: 0
  }
}

async function verifyDuplicate(modulePath) {
  const root = scenarioRoot('duplicate')
  const store = await openStore(modulePath, root)
  const workspace = await store.createWorkspace(workspaceInput, { expectedStoreRevision: 0 })
  const goal = await store.createGoal(goalInput, { expectedStoreRevision: 1 })
  const workItem = await store.createWorkItem(workItemInput, { expectedStoreRevision: 2 })
  const before = fileIdentity(storePath(root))
  const beforeDocument = readDocument(root)

  const repeatedWorkspace = await store.createWorkspace(workspaceInput, { expectedStoreRevision: 0 })
  const repeatedGoal = await store.createGoal(goalInput, { expectedStoreRevision: 1 })
  const repeatedWorkItem = await store.createWorkItem(workItemInput, { expectedStoreRevision: 2 })
  assert.deepEqual(repeatedWorkspace, workspace)
  assert.deepEqual(repeatedGoal, goal)
  assert.deepEqual(repeatedWorkItem, workItem)
  assert.deepEqual(fileIdentity(storePath(root)), before, 'duplicate creates must not republish the Store')
  assert.equal(readDocument(root).revision, beforeDocument.revision)

  await assert.rejects(
    store.createWorkspace(workspaceInput, {
      expectedStoreRevision: 0,
      actor: { type: 'human', id: 'unregistered-replay-actor' }
    }),
    (error) => error?.code === 'actor_forbidden'
  )

  await assert.rejects(
    store.createWorkspace({ ...workspaceInput, name: 'Conflicting Project' }),
    /already exists with different content/
  )
  await assert.rejects(
    store.createGoal({ ...goalInput, title: 'Conflicting Goal' }),
    /already exists with different content/
  )
  await assert.rejects(
    store.createWorkItem({ ...workItemInput, title: 'Conflicting WorkItem' }),
    /already exists with different content/
  )
  assert.deepEqual(fileIdentity(storePath(root)), before, 'identity conflicts must preserve canonical bytes')
  return {
    storeRevision: beforeDocument.revision,
    workspaceCount: 1,
    goalCount: 1,
    workItemCount: 1,
    revisionStable: true,
    identityStable: true,
    unauthorizedReplayRejected: true,
    identityConflictsRejected: 3,
    canonicalDigest: before.digest
  }
}

async function verifyOutOfOrder(modulePath) {
  const root = scenarioRoot('out-of-order')
  const store = await openStore(modulePath, root)
  const workspace = await store.createWorkspace(workspaceInput, { expectedStoreRevision: 0 })
  const current = await store.updateWorkspace(workspace.id, { name: 'Current Project' }, {
    expectedStoreRevision: 1,
    expectedRevision: 1
  })
  assert.equal(current.revision, 2)
  const before = readFileSync(storePath(root))
  await assert.rejects(
    store.updateWorkspace(workspace.id, { name: 'Delayed stale Project' }, {
      expectedStoreRevision: 1,
      expectedRevision: 1
    }),
    (error) => error?.code === 'stale_revision'
  )
  const after = readFileSync(storePath(root))
  assert.deepEqual(after, before, 'delayed mutation replaced canonical bytes')
  const recovered = await (await openStore(modulePath, root)).getWorkspace(workspace.id)
  assert.equal(recovered.name, 'Current Project')
  assert.equal(recovered.revision, 2)
  return {
    delayedStoreRevision: 1,
    canonicalStoreRevision: 2,
    delayedEntityRevision: 1,
    canonicalEntityRevision: recovered.revision,
    staleMutationRejected: true,
    storeByteStable: true
  }
}

function invokeWorker(modulePath, root, checkpoint, killAtCheckpoint) {
  return new Promise((resolve, reject) => {
    const child = fork(process.argv[1], ['worker'], {
      cwd: repoRoot,
      execArgv: [],
      env: {
        ...process.env,
        CAOGEN_PROJECT_WORKSPACE_MODULE: modulePath,
        CAOGEN_PROJECT_WORKSPACE_ROOT: root,
        CAOGEN_PROJECT_WORKSPACE_CHECKPOINT: checkpoint
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    let settled = false
    let message
    let stderr = ''
    const timeout = setTimeout(() => finish(new Error(`Project Workspace worker timed out at ${checkpoint}`)), 15_000)
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
  const root = requiredEnv('CAOGEN_PROJECT_WORKSPACE_ROOT')
  const target = path.resolve(storePath(root))
  const parent = path.dirname(target)
  const checkpoint = requiredEnv('CAOGEN_PROJECT_WORKSPACE_CHECKPOINT')
  Module._load = function patchedLoad(request, owner, isMain) {
    if (request === 'node:fs/promises') return faultInjectingPromises(realPromises, target, parent, checkpoint)
    return originalLoad.call(this, request, owner, isMain)
  }
  let store
  try {
    store = await openStore(requiredEnv('CAOGEN_PROJECT_WORKSPACE_MODULE'), root)
    await store.createWorkspace(workspaceInput, { expectedStoreRevision: 0 })
    process.send?.({ type: 'completed' })
  } catch (error) {
    if (checkpoint === 'post_directory_sync_throw' && store) {
      const before = readFileSync(target)
      const recovered = await store.createWorkspace(workspaceInput, { expectedStoreRevision: 0 })
      const after = readFileSync(target)
      process.send?.({
        type: 'error',
        code: error?.code,
        message: String(error?.message ?? error),
        recoveredId: recovered.id,
        recoveredRevision: JSON.parse(String(after)).revision,
        replayByteStable: before.equals(after)
      })
    } else {
      process.send?.({ type: 'error', code: error?.code, message: String(error?.message ?? error) })
    }
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
      if (path.resolve(String(args[1])) === target && checkpoint === 'after_rename') await pauseAt(checkpoint)
      return result
    }
  }
}

function wrapHandle(handle, openedPath, target, parent, checkpoint) {
  const temporary = openedPath !== target && path.dirname(openedPath) === parent &&
    path.basename(openedPath).startsWith(`${path.basename(target)}.`) && openedPath.endsWith('.tmp')
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
          throw Object.assign(new Error('injected Project Workspace unknown result'), { code: 'EUNKNOWNRESULT' })
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

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/project-workspace/store.ts',
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
  return new (require(modulePath).ProjectWorkspaceStore)(root)
}

async function openStore(modulePath, root) {
  return createStore(modulePath, root).open()
}

function scenarioRoot(name) {
  const root = path.join(tempRoot, name)
  mkdirSync(root, { recursive: true })
  return root
}

function storePath(root) {
  return path.join(root, 'project-workspace.json')
}

function lockPath(root) {
  return `${storePath(root)}.lock`
}

function readDocument(root) {
  return JSON.parse(readFileSync(storePath(root), 'utf8'))
}

function temporaryFiles(root) {
  if (!existsSync(root)) return []
  return readdirSync(root).filter((name) => name.startsWith('project-workspace.json.') && name.endsWith('.tmp')).sort()
}

function fileIdentity(file) {
  const info = statSync(file)
  return { device: String(info.dev), inode: String(info.ino), size: info.size, digest: sha256(readFileSync(file)) }
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
