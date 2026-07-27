import { execFileSync, fork } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const workerMode = process.argv[2]
const tempRoot = process.env.CAOGEN_ATTACHMENT_EFFECT_ROOT
  ?? mkdtempSync(path.join(tmpdir(), 'caogen-attachment-effect-'))
const outDir = process.env.CAOGEN_ATTACHMENT_EFFECT_COMPILED ?? path.join(tempRoot, 'compiled')
const userData = process.env.CAOGEN_ATTACHMENT_EFFECT_USER_DATA ?? path.join(tempRoot, 'user-data')
const base64Input = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
const imageBytes = Buffer.from(base64Input, 'base64')

process.env.CAOGEN_TEST_USER_DATA = userData
process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter)
require('node:module').Module._initPaths()

if (workerMode) {
  await runWorker(workerMode)
} else {
  try {
    compileSources()
    installElectronStub()
    await successAndFailureCases()
    await crashRecoveryCase()
    console.log('attachment effect crash e2e: PASS')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function successAndFailureCases() {
  const modules = await loadModules()
  const project = path.join(tempRoot, 'project')
  const sourceDir = path.join(project, 'source')
  mkdirSync(sourceDir, { recursive: true })
  const sourcePath = path.join(sourceDir, 'source-path-canary.png')
  writeFileSync(sourcePath, imageBytes)

  const preparedFile = await modules.attachmentOps.prepareImageAttachmentFile(sourcePath)
  let durableBarrierObserved = false
  let persistedToolInput
  const observingGateway = (spec) => modules.gateway.executeInteractiveOperationEffect({
    ...spec,
    execute: async (effect) => {
      const snapshot = await modules.snapshotStore.getTaskSnapshot(effect.sessionId)
      const persisted = snapshot?.run?.effects?.find((item) => item.id === effect.id)
      assertEqual(persisted?.status, 'executing', 'attachment mutation must start after durable executing state')
      assertEqual(snapshot?.run?.operation?.kind, 'attachment_write')
      assertEqual(snapshot?.run?.operation?.sourceSessionId, 'attachment-copy-source')
      assertEqual(snapshot?.run?.operation?.projectId, 'attachment-project')
      durableBarrierObserved = true
      persistedToolInput = spec.toolInput
      return spec.execute(effect)
    }
  })
  const copyResult = await modules.attachmentEffect.executePreparedImageAttachmentEffect(
    effectContext('attachment-copy-source', project, path.join(userData, 'attachments', 'copy')),
    preparedFile,
    'user_file',
    observingGateway
  )
  assert(copyResult.ok, JSON.stringify(copyResult))
  assert(durableBarrierObserved, 'copy attachment durable barrier was not observed')
  assertEqual(persistedToolInput.source, 'user_file')
  assertEqual(persistedToolInput.contentSha256, preparedFile.hash)
  assertEqual(persistedToolInput.bytes, imageBytes.byteLength)
  assert(!JSON.stringify(persistedToolInput).includes(sourcePath), 'source path must not enter Effect tool input')
  assertEqual((await terminalEffect(modules.snapshotStore, 'attachment-copy-source')).status, 'confirmed')

  const preparedBytes = modules.attachmentOps.prepareImageAttachmentBytes(base64Input, { mime: 'image/png' })
  const bytesResult = await modules.attachmentEffect.executePreparedImageAttachmentEffect(
    effectContext('attachment-bytes-source', project, path.join(userData, 'attachments', 'bytes')),
    preparedBytes,
    'renderer_bytes',
    modules.gateway.executeInteractiveOperationEffect
  )
  assert(bytesResult.ok, JSON.stringify(bytesResult))
  assertEqual((await terminalEffect(modules.snapshotStore, 'attachment-bytes-source')).toolName, 'attachment_save_image_bytes')

  const blockedRoot = path.join(userData, 'blocked-root')
  writeFileSync(blockedRoot, 'not a directory', 'utf8')
  const failed = await modules.attachmentEffect.executePreparedImageAttachmentEffect(
    effectContext('attachment-failure-source', project, blockedRoot),
    preparedBytes,
    'renderer_bytes',
    modules.gateway.executeInteractiveOperationEffect
  )
  assert(!failed.ok, 'opaque attachment persistence failure must not report success')
  assertEqual(failed.effectStatus, 'waiting_reconciliation')
  assert(typeof failed.snapshotId === 'string' && failed.snapshotId.length > 0, 'failure must expose recovery snapshot')
  const failedSnapshot = await modules.snapshotStore.getTaskSnapshot(failed.snapshotId)
  assertEqual(failedSnapshot?.run?.status, 'waiting_reconciliation')
  assertEqual(failedSnapshot?.run?.effects?.[0]?.target?.kind, 'unsupported')
  assertEqual(failedSnapshot?.run?.effects?.[0]?.reconcilability, 'opaque')

  assertDatabaseExcludesSensitiveInput(sourcePath)
  assertDatabaseExcludesSensitiveInput(base64Input)
}

async function crashRecoveryCase() {
  const crashed = await runChild('crash', true)
  assertEqual(crashed.message.type, 'mutation-boundary')
  assertEqual(crashed.message.effectStatus, 'executing')
  assertEqual(crashed.message.targetKind, 'unsupported')
  assertEqual(crashed.message.attachmentExists, true)

  const resumed = await runChild('resume', false)
  assertEqual(resumed.message.effectStatus, 'waiting_reconciliation')
  assertEqual(resumed.message.runStatus, 'waiting_reconciliation')
  assertEqual(resumed.message.snapshotExists, true)
  assertEqual(resumed.message.attachmentExists, true)
  assertEqual(counterLines(), 1, 'opaque attachment crash recovery must never replay the write callback')
  assertDatabaseExcludesSensitiveInput(base64Input)
}

async function runWorker(mode) {
  const modules = await loadModules()
  if (mode === 'crash') return crashWorker(modules)
  if (mode === 'resume') return resumeWorker(modules)
  throw new Error(`unknown worker mode: ${mode}`)
}

async function crashWorker(modules) {
  const project = path.join(tempRoot, 'crash-project')
  mkdirSync(project, { recursive: true })
  const prepared = modules.attachmentOps.prepareImageAttachmentBytes(base64Input, { mime: 'image/png' })
  const result = await modules.attachmentEffect.executePreparedImageAttachmentEffect(
    effectContext('attachment-crash-source', project, crashAttachmentsRoot()),
    prepared,
    'renderer_bytes',
    (spec) => modules.gateway.executeInteractiveOperationEffect({
      ...spec,
      operationId: 'attachment-crash',
      execute: async (effect) => {
        appendFileSync(counterFile(), 'callback\n')
        const value = await spec.execute(effect)
        assert(value.ok, JSON.stringify(value))
        const snapshot = await modules.snapshotStore.getTaskSnapshot(effect.sessionId)
        const persisted = snapshot?.run?.effects?.find((item) => item.id === effect.id)
        process.send?.({
          type: 'mutation-boundary',
          effectStatus: persisted?.status,
          targetKind: persisted?.target?.kind,
          attachmentExists: existsSync(value.path)
        })
        await new Promise(() => {})
      }
    })
  )
  throw new Error(`crash worker unexpectedly completed: ${JSON.stringify(result)}`)
}

async function resumeWorker(modules) {
  const scopeId = 'operation:attachment-crash'
  const snapshot = await modules.snapshotStore.getTaskSnapshot(scopeId)
  assert(snapshot?.run, 'attachment crash recovery snapshot missing')
  const attachmentPath = attachmentPathFor(snapshot.run.effects[0])
  const reconciled = await modules.effectRuntime.reconcilePersistedTaskSnapshot(snapshot)
  await modules.gateway.settleStoppedInteractiveOperationSnapshot(reconciled)
  const current = await modules.snapshotStore.getTaskSnapshot(scopeId)
  const effect = current?.run?.effects?.[0]
  process.send?.({
    type: 'resume-result',
    effectStatus: effect?.status,
    runStatus: current?.run?.status,
    snapshotExists: current !== null,
    attachmentExists: existsSync(attachmentPath)
  })
}

function attachmentPathFor(effect) {
  const digest = effect?.inputDigest
  assert(typeof digest === 'string', 'attachment effect input digest missing')
  const files = readdirSync(crashAttachmentsRoot()).filter((item) => !item.startsWith('.'))
  assertEqual(files.length, 1, 'crash attachment root should contain one durable object')
  return path.join(crashAttachmentsRoot(), files[0])
}

function effectContext(sourceSessionId, cwd, attachmentsRoot) {
  return { sourceSessionId, projectId: 'attachment-project', cwd, attachmentsRoot }
}

async function terminalEffect(snapshotStore, sourceSessionId) {
  const runs = await snapshotStore.listTaskRuns()
  const run = runs.find((item) => item.operation?.sourceSessionId === sourceSessionId)
  assert(run, `terminal attachment run missing for ${sourceSessionId}`)
  assertEqual(run.status, 'completed')
  assertEqual(run.operation?.kind, 'attachment_write')
  assertEqual(run.effects.length, 1)
  return run.effects[0]
}

function runChild(mode, killAfterMessage) {
  return new Promise((resolve, reject) => {
    const child = fork(process.argv[1], [mode], {
      env: {
        ...process.env,
        CAOGEN_ATTACHMENT_EFFECT_ROOT: tempRoot,
        CAOGEN_ATTACHMENT_EFFECT_COMPILED: outDir,
        CAOGEN_ATTACHMENT_EFFECT_USER_DATA: userData
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    let stdout = ''
    let stderr = ''
    let message
    let killed = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${mode} timed out\n${stdout}\n${stderr}`))
    }, 30_000)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('message', (value) => {
      message = value
      if (killAfterMessage && !killed) {
        killed = true
        child.kill('SIGKILL')
      }
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (!message) return reject(new Error(`${mode} exited without evidence (${code}/${signal})\n${stdout}\n${stderr}`))
      if (killAfterMessage && signal !== 'SIGKILL') {
        return reject(new Error(`${mode} expected SIGKILL, got ${code}/${signal}`))
      }
      if (!killAfterMessage && code !== 0) return reject(new Error(`${mode} failed (${code})\n${stdout}\n${stderr}`))
      resolve({ message, stdout, stderr })
    })
  })
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/attachmentEffect.ts',
    'src/main/attachmentOps.ts',
    'src/main/task/operation-effect-gateway.ts',
    '--outDir', outDir,
    '--rootDir', 'src',
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'),
    'export const app = { getPath: () => process.env.CAOGEN_TEST_USER_DATA }\n')
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

async function loadModules() {
  return {
    attachmentEffect: await importModule('main/attachmentEffect.js'),
    attachmentOps: await importModule('main/attachmentOps.js'),
    gateway: await importModule('main/task/operation-effect-gateway.js'),
    effectRuntime: await importModule('main/task/effect-runtime.js'),
    snapshotStore: await importModule('main/task/task-snapshot.js')
  }
}

async function importModule(relativePath) {
  return import(pathToFileURL(path.join(outDir, relativePath)).href)
}

function assertDatabaseExcludesSensitiveInput(value) {
  const dbPath = path.join(userData, 'task-snapshots.db')
  assert(existsSync(dbPath), 'task snapshot database missing')
  assert(!readFileSync(dbPath).includes(Buffer.from(value)), `sensitive attachment input leaked into task database: ${value}`)
}

function crashAttachmentsRoot() {
  return path.join(userData, 'attachments', 'crash')
}

function counterFile() {
  return path.join(tempRoot, 'attachment-write-count.txt')
}

function counterLines() {
  if (!existsSync(counterFile())) return 0
  return readFileSync(counterFile(), 'utf8').split('\n').filter(Boolean).length
}

function assertEqual(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(`${message ? `${message}: ` : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
