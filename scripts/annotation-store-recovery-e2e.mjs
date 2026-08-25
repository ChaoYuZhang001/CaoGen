#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, fork } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const workerMode = process.argv[2] === 'worker'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const tempRoot = workerMode ? '' : mkdtempSync(path.join(tmpdir(), 'caogen-annotation-store-recovery-'))
const compiledDir = path.join(tempRoot, 'compiled')
const stores = [
  {
    key: 'browser',
    writer: 'src/main/browserAnnotations.ts',
    module: 'browserAnnotations.js',
    reportRoot: 'browser-annotation-store-recovery',
    save: 'saveAnnotation',
    list: 'listAnnotations',
    input: {
      id: 'browser-annotation-recovery',
      sessionId: 'session-recovery',
      url: 'https://example.com/recovery',
      note: 'current browser annotation',
      consoleErrors: [],
      createdAt: '2026-08-25T00:00:00.000Z'
    }
  },
  {
    key: 'preview',
    writer: 'src/main/previewAnnotations.ts',
    module: 'previewAnnotations.js',
    reportRoot: 'preview-annotation-store-recovery',
    save: 'savePreviewAnnotation',
    list: 'listPreviewAnnotations',
    input: {
      id: 'preview-annotation-recovery',
      sessionId: 'session-recovery',
      path: 'src/example.ts',
      type: 'text',
      note: 'current preview annotation',
      createdAt: '2026-08-25T00:00:00.000Z'
    }
  }
]

if (workerMode) await runWorker()
else await runParent()

async function runParent() {
  const reports = []
  try {
    compileSources()
    for (const store of stores) reports.push(await verifyStore(store))
  } catch (error) {
    const selected = stores.find((store) => store.key === process.env.CAOGEN_ANNOTATION_STORE) ?? stores[0]
    const report = baseReport(selected, 'failed')
    report.verification = 'not_verified'
    report.error = serializeError(error)
    writeReport(selected, report)
    process.exitCode = 1
    return
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }

  for (const { store, report } of reports) writeReport(store, report)
  console.log(JSON.stringify({
    status: 'passed',
    sourceRevision: reports[0]?.report.sourceRevision,
    writers: reports.map(({ store, report }) => ({
      writer: store.writer,
      verification: report.verification,
      verifiedFaults: 4,
      reportPath: path.join('test-results', store.reportRoot, 'latest.json')
    }))
  }, null, 2))
}

async function verifyStore(store) {
  const modulePath = path.join(compiledDir, 'main', store.module)
  const strongKill = []
  for (const checkpoint of ['after_write', 'after_file_sync', 'after_link']) {
    strongKill.push(await verifyStrongKill(store, modulePath, checkpoint))
  }
  const report = baseReport(store, 'passed')
  report.verification = 'runtime_store_verified'
  report.faults = {
    strong_kill: { status: 'verified', scenarios: strongKill },
    network_unknown_result: { status: 'verified', scenario: await verifyUnknownResult(store, modulePath) },
    duplicate_idempotency: { status: 'verified', scenario: await verifyDuplicate(store, modulePath) },
    out_of_order: { status: 'verified', scenario: await verifyOutOfOrder(store, modulePath) }
  }
  return { store, report }
}

async function verifyStrongKill(store, modulePath, checkpoint) {
  const root = scenarioRoot(store, `strong-kill-${checkpoint}`)
  const targetPath = annotationPath(root, store.input)
  const exit = await invokeWorker(store, modulePath, root, checkpoint, true)
  assert.equal(exit.signal, 'SIGKILL', `${store.key}/${checkpoint} did not receive SIGKILL: ${JSON.stringify(exit)}`)
  const shouldExist = checkpoint === 'after_link'
  assert.equal(existsSync(targetPath), shouldExist, `${store.key}/${checkpoint} publication state drifted`)
  if (shouldExist) assert.equal(JSON.parse(readFileSync(targetPath, 'utf8')).id, store.input.id)

  const runtime = require(modulePath)
  const saved = await runtime[store.save](root, store.input)
  assert.equal(saved.id, store.input.id)
  const listed = await runtime[store.list](root, store.input.sessionId)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].note, store.input.note)
  assert.deepEqual(temporaryFiles(targetPath), [])
  return {
    checkpoint,
    signal: exit.signal,
    canonicalExistedAfterKill: shouldExist,
    finalDigest: sha256(readFileSync(targetPath)),
    recordCount: listed.length,
    orphanTemporaryCount: 0
  }
}

async function verifyUnknownResult(store, modulePath) {
  const root = scenarioRoot(store, 'unknown-result')
  const targetPath = annotationPath(root, store.input)
  const exit = await invokeWorker(store, modulePath, root, 'post_directory_sync_throw', false)
  assert.equal(exit.code, 2, `${store.key} unknown result must surface as an error`)
  assert.equal(exit.message?.code, 'EUNKNOWNRESULT')
  assert.equal(existsSync(targetPath), true)
  const before = fileIdentity(targetPath)
  const runtime = require(modulePath)
  const saved = await runtime[store.save](root, store.input)
  const after = fileIdentity(targetPath)
  assert.equal(saved.note, store.input.note)
  assert.deepEqual(after, before, `${store.key} retry must reuse the published annotation`)
  assert.deepEqual(temporaryFiles(targetPath), [])
  return {
    errorCode: exit.message.code,
    canonicalDigest: sha256(readFileSync(targetPath)),
    retryIdentityStable: true,
    orphanTemporaryCount: 0
  }
}

async function verifyDuplicate(store, modulePath) {
  const root = scenarioRoot(store, 'duplicate')
  const targetPath = annotationPath(root, store.input)
  const runtime = require(modulePath)
  const first = await runtime[store.save](root, store.input)
  const firstIdentity = fileIdentity(targetPath)
  const second = await runtime[store.save](root, store.input)
  const secondIdentity = fileIdentity(targetPath)
  assert.deepEqual(second, first)
  assert.deepEqual(secondIdentity, firstIdentity)
  assert.equal((await runtime[store.list](root, store.input.sessionId)).length, 1)
  assert.deepEqual(temporaryFiles(targetPath), [])
  return {
    recordCount: 1,
    identityStable: true,
    canonicalDigest: sha256(readFileSync(targetPath))
  }
}

async function verifyOutOfOrder(store, modulePath) {
  const root = scenarioRoot(store, 'out-of-order')
  const targetPath = annotationPath(root, store.input)
  const runtime = require(modulePath)
  await runtime[store.save](root, store.input)
  const before = readFileSync(targetPath)
  const delayed = { ...store.input, note: 'delayed stale annotation' }
  await assert.rejects(
    runtime[store.save](root, delayed),
    /annotation id 已存在且内容不同/
  )
  const after = readFileSync(targetPath)
  assert.deepEqual(after, before, `${store.key} delayed write replaced canonical bytes`)
  const listed = await runtime[store.list](root, store.input.sessionId)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].note, store.input.note)
  assert.deepEqual(temporaryFiles(targetPath), [])
  return {
    delayedNote: delayed.note,
    canonicalNote: listed[0].note,
    storeByteStable: true,
    canonicalDigest: sha256(after)
  }
}

function invokeWorker(store, modulePath, root, checkpoint, killAtCheckpoint) {
  return new Promise((resolve, reject) => {
    const child = fork(process.argv[1], ['worker'], {
      cwd: repoRoot,
      execArgv: [],
      env: {
        ...process.env,
        CAOGEN_ANNOTATION_STORE: store.key,
        CAOGEN_ANNOTATION_MODULE: modulePath,
        CAOGEN_ANNOTATION_ROOT: root,
        CAOGEN_ANNOTATION_INPUT: JSON.stringify(store.input),
        CAOGEN_ANNOTATION_TARGET: annotationPath(root, store.input),
        CAOGEN_ANNOTATION_CHECKPOINT: checkpoint
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    let settled = false
    let message
    let stderr = ''
    const timeout = setTimeout(() => finish(new Error(`${store.key} worker timed out at ${checkpoint}`)), 15_000)
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
  const target = path.resolve(requiredEnv('CAOGEN_ANNOTATION_TARGET'))
  const parent = path.dirname(target)
  const checkpoint = requiredEnv('CAOGEN_ANNOTATION_CHECKPOINT')
  Module._load = function patchedLoad(request, owner, isMain) {
    if (request === 'node:fs/promises') return faultInjectingPromises(realPromises, target, parent, checkpoint)
    return originalLoad.call(this, request, owner, isMain)
  }
  try {
    const runtime = require(requiredEnv('CAOGEN_ANNOTATION_MODULE'))
    const input = JSON.parse(requiredEnv('CAOGEN_ANNOTATION_INPUT'))
    const key = requiredEnv('CAOGEN_ANNOTATION_STORE')
    const method = key === 'browser' ? 'saveAnnotation' : 'savePreviewAnnotation'
    await runtime[method](requiredEnv('CAOGEN_ANNOTATION_ROOT'), input)
    process.send?.({ type: 'completed' })
  } catch (error) {
    process.send?.({ type: 'error', code: error?.code, message: String(error?.message ?? error) })
    process.exitCode = 2
  } finally {
    Module._load = originalLoad
  }
}

function faultInjectingPromises(realPromises, target, parent, checkpoint) {
  let published = false
  return {
    ...realPromises,
    open: async (...args) => wrapHandle(await realPromises.open(...args), path.resolve(String(args[0])), target, parent, checkpoint, () => published),
    link: async (...args) => {
      const result = await realPromises.link(...args)
      if (path.resolve(String(args[1])) === target) {
        published = true
        if (checkpoint === 'after_link') await pauseAt(checkpoint)
      }
      return result
    }
  }
}

function wrapHandle(handle, openedPath, target, parent, checkpoint, isPublished) {
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
        if (directory && isPublished() && checkpoint === 'post_directory_sync_throw') {
          throw Object.assign(new Error('injected post-publication unknown result'), { code: 'EUNKNOWNRESULT' })
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
    'src/main/browserAnnotations.ts',
    'src/main/previewAnnotations.ts',
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

function scenarioRoot(store, name) {
  const root = path.join(tempRoot, store.key, name)
  mkdirSync(root, { recursive: true })
  return root
}

function annotationPath(root, input) {
  return path.join(root, input.sessionId, `${input.id}.json`)
}

function temporaryFiles(target) {
  const parent = path.dirname(target)
  if (!existsSync(parent)) return []
  const prefix = `.${path.basename(target)}.`
  return readdirSync(parent).filter((name) => name.startsWith(prefix) && name.endsWith('.tmp')).sort()
}

function fileIdentity(file) {
  const info = statSync(file)
  return { device: String(info.dev), inode: String(info.ino), size: info.size }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function baseReport(store, status) {
  return {
    schemaVersion: 1,
    gate: 'test:annotation-store-recovery',
    runId,
    status,
    sourceRevision: git(['rev-parse', 'HEAD']),
    worktreeStatusCount: gitStatusCount(),
    writer: store.writer
  }
}

function writeReport(store, report) {
  const root = path.join(repoRoot, 'test-results', store.reportRoot)
  const dir = path.join(root, runId)
  mkdirSync(dir, { recursive: true })
  const body = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(dir, 'report.json'), body, 'utf8')
  writeFileSync(path.join(root, 'latest.json'), body, 'utf8')
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
