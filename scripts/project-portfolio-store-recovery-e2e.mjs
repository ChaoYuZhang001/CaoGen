#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const workerMode = process.argv[2] === 'worker'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'project-portfolio-store-recovery')
const reportDir = path.join(reportRoot, runId)
const tempRoot = workerMode ? '' : mkdtempSync(path.join(tmpdir(), 'caogen-project-portfolio-recovery-'))
const compiledDir = path.join(tempRoot, 'compiled')
const writer = 'src/main/project-portfolio/store.ts'
const dependencyInput = {
  id: 'portfolio-recovery-dependency',
  fromProjectId: 'portfolio-project-alpha',
  toProjectId: 'portfolio-project-beta',
  label: 'Recovery dependency'
}
const milestoneInput = {
  id: 'portfolio-recovery-milestone',
  projectId: 'portfolio-project-alpha',
  title: 'Baseline milestone',
  dueAt: Date.UTC(2026, 8, 1)
}

if (workerMode) await runWorker()
else await runParent()

async function runParent() {
  let report
  try {
    compileSources()
    const modulePath = path.join(compiledDir, 'main', 'project-portfolio', 'store.js')
    const strongKill = []
    for (const checkpoint of ['after_write', 'after_file_sync', 'after_rename']) {
      strongKill.push(await verifyStrongKill(modulePath, checkpoint))
    }
    report = {
      schemaVersion: 1,
      gate: 'test:project-portfolio-store-recovery',
      runId,
      status: 'passed',
      verification: 'runtime_store_verified',
      sourceRevision: git(['rev-parse', 'HEAD']),
      worktreeStatusCount: gitStatusCount(),
      writer,
      scope: 'Project Portfolio dependency and milestone mutations',
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
      gate: 'test:project-portfolio-store-recovery',
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
  await seed(modulePath, root)
  const before = readDocument(root)
  const exit = await invokeWorker(modulePath, root, checkpoint, true)
  assert.equal(exit.signal, 'SIGKILL', `${checkpoint} worker must receive SIGKILL`)
  const observed = readDocument(root)
  assert([before.revision, before.revision + 1].includes(observed.revision), `${checkpoint} left an invalid revision`)
  assert.equal(observed.dependencies.length, observed.revision === before.revision ? 0 : 1)

  const store = createStore(modulePath, root)
  const recovered = await store.createDependency(dependencyInput)
  assert.equal(recovered.id, dependencyInput.id)
  const finalDocument = readDocument(root)
  assert.equal(finalDocument.dependencies.length, 1)
  assert.equal(finalDocument.dependencies[0].id, dependencyInput.id)
  assert.equal(finalDocument.revision, before.revision + 1)
  assert.deepEqual(temporaryFiles(root), [])
  return {
    checkpoint,
    signal: exit.signal,
    publishedBeforeKill: observed.revision === before.revision + 1,
    recoveredRevision: finalDocument.revision,
    canonicalDigest: sha256(readFileSync(portfolioPath(root))),
    orphanTemporaryCount: 0
  }
}

async function verifyUnknownResult(modulePath) {
  const root = scenarioRoot('unknown-result')
  await seed(modulePath, root)
  const exit = await invokeWorker(modulePath, root, 'post_directory_sync_throw', false)
  assert.equal(exit.code, 2, 'unknown result must remain visible to the caller')
  assert.equal(exit.message?.code, 'EUNKNOWNRESULT')
  assert.equal(exit.message?.replayByteStable, true, 'same-instance retry must reconcile published bytes')
  assert.equal(exit.message?.recoveredRevision, 2)
  const document = readDocument(root)
  assert.equal(document.dependencies.length, 1)
  assert.equal(document.dependencies[0].id, dependencyInput.id)
  assert.deepEqual(temporaryFiles(root), [])
  return {
    errorCode: exit.message.code,
    recoveredRevision: document.revision,
    replayByteStable: true,
    dependencyCount: document.dependencies.length,
    orphanTemporaryCount: 0
  }
}

async function verifyDuplicate(modulePath) {
  const root = scenarioRoot('duplicate')
  await seed(modulePath, root)
  const store = createStore(modulePath, root)
  const first = await store.createDependency(dependencyInput)
  const before = fileIdentity(portfolioPath(root))
  const beforeDocument = readDocument(root)
  const second = await store.createDependency(dependencyInput)
  const repeatedMilestone = await store.createMilestone(milestoneInput)
  const after = fileIdentity(portfolioPath(root))
  const afterDocument = readDocument(root)
  assert.deepEqual(second, first)
  assert.equal(repeatedMilestone.id, milestoneInput.id)
  assert.deepEqual(after, before, 'duplicate request must not republish the Store')
  assert.equal(afterDocument.revision, beforeDocument.revision)
  assert.equal(afterDocument.dependencies.length, 1)
  await assert.rejects(
    store.createMilestone({ ...milestoneInput, title: 'Conflicting duplicate milestone' }),
    /already exists with different content/
  )
  assert.deepEqual(fileIdentity(portfolioPath(root)), after, 'identity conflict must preserve canonical bytes')
  return {
    dependencyCount: 1,
    milestoneCount: 1,
    revisionStable: true,
    identityStable: true,
    identityConflictRejected: true,
    canonicalDigest: sha256(readFileSync(portfolioPath(root)))
  }
}

async function verifyOutOfOrder(modulePath) {
  const root = scenarioRoot('out-of-order')
  const fixture = await seed(modulePath, root)
  const store = createStore(modulePath, root)
  const current = await store.updateMilestone(fixture.milestone.id, { title: 'Current milestone' }, {
    expectedStoreRevision: 1,
    expectedRevision: 1
  })
  assert.equal(current.revision, 2)
  const before = readFileSync(portfolioPath(root))
  await assert.rejects(
    store.updateMilestone(fixture.milestone.id, { title: 'Delayed stale milestone' }, {
      expectedStoreRevision: 1,
      expectedRevision: 1
    }),
    /Project Portfolio revision conflict/
  )
  const after = readFileSync(portfolioPath(root))
  assert.deepEqual(after, before, 'delayed mutation replaced canonical bytes')
  const recovered = await createStore(modulePath, root).exportProjectSlice('portfolio-project-alpha')
  assert.equal(recovered.milestones.length, 1)
  assert.equal(recovered.milestones[0].title, 'Current milestone')
  assert.equal(recovered.milestones[0].revision, 2)
  return {
    delayedStoreRevision: 1,
    canonicalStoreRevision: 2,
    delayedEntityRevision: 1,
    canonicalEntityRevision: 2,
    staleMutationRejected: true,
    storeByteStable: true
  }
}

async function seed(modulePath, root) {
  const workspaceModule = require(path.join(compiledDir, 'main', 'project-workspace', 'store.js'))
  const workspace = await new workspaceModule.ProjectWorkspaceStore(root).open()
  await workspace.createWorkspace({ id: 'portfolio-project-alpha', name: 'Portfolio Alpha', kind: 'software' })
  await workspace.createWorkspace({ id: 'portfolio-project-beta', name: 'Portfolio Beta', kind: 'software' })
  const store = createStore(modulePath, root)
  const milestone = await store.createMilestone(milestoneInput)
  return { milestone }
}

function invokeWorker(modulePath, root, checkpoint, killAtCheckpoint) {
  return new Promise((resolve, reject) => {
    const child = fork(process.argv[1], ['worker'], {
      cwd: repoRoot,
      execArgv: [],
      env: {
        ...process.env,
        CAOGEN_PROJECT_PORTFOLIO_MODULE: modulePath,
        CAOGEN_PROJECT_PORTFOLIO_ROOT: root,
        CAOGEN_PROJECT_PORTFOLIO_CHECKPOINT: checkpoint
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    let settled = false
    let message
    let stderr = ''
    const timeout = setTimeout(() => finish(new Error(`Project Portfolio worker timed out at ${checkpoint}`)), 15_000)
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
  const root = requiredEnv('CAOGEN_PROJECT_PORTFOLIO_ROOT')
  const target = path.resolve(portfolioPath(root))
  const parent = path.dirname(target)
  const checkpoint = requiredEnv('CAOGEN_PROJECT_PORTFOLIO_CHECKPOINT')
  Module._load = function patchedLoad(request, owner, isMain) {
    if (request === 'node:fs/promises') return faultInjectingPromises(realPromises, target, parent, checkpoint)
    return originalLoad.call(this, request, owner, isMain)
  }
  let store
  try {
    store = createStore(requiredEnv('CAOGEN_PROJECT_PORTFOLIO_MODULE'), root)
    await store.createDependency(dependencyInput)
    process.send?.({ type: 'completed' })
  } catch (error) {
    if (checkpoint === 'post_directory_sync_throw' && store) {
      const before = readFileSync(target)
      const recovered = await store.createDependency(dependencyInput)
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
          throw Object.assign(new Error('injected Project Portfolio unknown result'), { code: 'EUNKNOWNRESULT' })
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
    'src/main/project-portfolio/store.ts',
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
  return new (require(modulePath).ProjectPortfolioStore)(root)
}

function scenarioRoot(name) {
  const root = path.join(tempRoot, name)
  mkdirSync(root, { recursive: true })
  return root
}

function portfolioPath(root) {
  return path.join(root, 'project-portfolio.json')
}

function readDocument(root) {
  return JSON.parse(readFileSync(portfolioPath(root), 'utf8'))
}

function temporaryFiles(root) {
  if (!existsSync(root)) return []
  return readdirSync(root).filter((name) => name.startsWith('.project-portfolio.json.') && name.endsWith('.tmp')).sort()
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
