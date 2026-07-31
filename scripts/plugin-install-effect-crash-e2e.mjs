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
const caseName = process.argv[3]
const tempRoot = process.env.CAOGEN_PLUGIN_EFFECT_ROOT
  ?? mkdtempSync(path.join(tmpdir(), 'caogen-plugin-effect-'))
const outDir = process.env.CAOGEN_PLUGIN_EFFECT_COMPILED ?? path.join(tempRoot, 'compiled')

process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter)
require('node:module').Module._initPaths()

if (workerMode) {
  await runWorker(workerMode, requireCaseName(caseName))
} else {
  try {
    compileSources()
    installElectronStub()
    await successCases()
    await crashRecoveryCase('install-complete', 'installed', 'confirmed')
    await crashRecoveryCase('install-staged', 'staged', 'waiting_reconciliation')
    await crashRecoveryCase('overwrite-partial', 'previous_trashed', 'waiting_reconciliation')
    await crashRecoveryCase('uninstall-complete', 'uninstalled', 'confirmed')
    console.log('plugin install effect crash e2e: PASS')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function successCases() {
  const currentCase = 'success'
  setupCase(currentCase)
  setWorkerEnvironment(currentCase)
  const modules = await loadModules()
  const sourceV1 = createSource(currentCase, 'v1', 'PLUGIN_SUCCESS_V1_SENSITIVE_CONTENT')
  const sourceV2 = createSource(currentCase, 'v2', 'PLUGIN_SUCCESS_V2_SENSITIVE_CONTENT')
  const root = pluginsRoot(currentCase)

  const installed = await modules.pluginEffect.installLocalPluginWithEffect(sourceV1, root)
  assert(installed.ok, JSON.stringify(installed))
  assertEqual(installed.effectStatus, 'confirmed')
  assert(existsSync(activePluginPath(currentCase)), 'installed plugin is missing')

  const overwritten = await modules.pluginEffect.installLocalPluginWithEffect(sourceV2, root, true)
  assert(overwritten.ok, JSON.stringify(overwritten))
  assertEqual(overwritten.effectStatus, 'confirmed')
  assertEqual(readFileSync(path.join(activePluginPath(currentCase), 'index.md'), 'utf8'), 'PLUGIN_SUCCESS_V2_SENSITIVE_CONTENT')
  assertEqual(trashEntries(currentCase).length, 1, 'overwrite must retain the previous plugin')

  const uninstalled = await modules.pluginEffect.uninstallPluginWithEffect(activePluginPath(currentCase), root)
  assert(uninstalled.ok, JSON.stringify(uninstalled))
  assertEqual(uninstalled.effectStatus, 'confirmed')
  assert(!existsSync(activePluginPath(currentCase)), 'uninstall must remove the active plugin path')
  assertEqual(trashEntries(currentCase).length, 2, 'uninstall must retain both recoverable versions')

  const confirmedCanaries = await confirmedResultProjectionCases(modules, currentCase, root)

  const errorCanary = 'PLUGIN_INSTALL_RAW_ERROR_SENSITIVE_CANARY'
  const failedSource = createSource(currentCase, 'failure', 'PLUGIN_FAILURE_SOURCE_SENSITIVE_CONTENT', 'failure-plugin')
  const failed = await modules.pluginEffect.installLocalPluginWithEffect(failedSource, root, false, {
    installRunner: () => ({ ok: false, error: errorCanary })
  })
  assert(!failed.ok && failed.error === errorCanary, 'caller must receive the execution failure')
  assertTargetValidation(modules, failedSource, root)
  assertDatabaseExcludes(currentCase, [
    path.basename(sourceV1),
    path.basename(sourceV2),
    path.basename(failedSource),
    'PLUGIN_SUCCESS_V1_SENSITIVE_CONTENT',
    'PLUGIN_SUCCESS_V2_SENSITIVE_CONTENT',
    'PLUGIN_FAILURE_SOURCE_SENSITIVE_CONTENT',
    errorCanary,
    ...confirmedCanaries
  ])
}

async function confirmedResultProjectionCases(modules, currentCase, root) {
  const sourceContent = 'PLUGIN_CONFIRMED_AFTER_ERROR_SENSITIVE_CONTENT'
  const errorCanary = 'PLUGIN_CONFIRMED_AFTER_ERROR_RAW_CANARY'
  const source = createSource(currentCase, 'confirmed-after-error', sourceContent)
  const installed = await modules.pluginEffect.installLocalPluginWithEffect(source, root, false, {
    installRunner: (target, sourcePath) => {
      const applied = modules.pluginDirectory.executeManagedPluginInstallTarget(target, sourcePath)
      assert(applied.ok, `projection fixture install failed: ${JSON.stringify(applied)}`)
      return { ok: false, error: errorCanary }
    }
  })
  assert(installed.ok && installed.effectStatus === 'confirmed', `confirmed install was projected as failure: ${JSON.stringify(installed)}`)

  const uninstalled = await modules.pluginEffect.uninstallPluginWithEffect(activePluginPath(currentCase), root, {
    uninstallRunner: (target) => {
      const applied = modules.pluginDirectory.executeManagedPluginUninstallTarget(target)
      assert(applied.ok, `projection fixture uninstall failed: ${JSON.stringify(applied)}`)
      return { ok: false, error: errorCanary }
    }
  })
  assert(uninstalled.ok && uninstalled.effectStatus === 'confirmed', `confirmed uninstall was projected as failure: ${JSON.stringify(uninstalled)}`)
  return [path.basename(source), sourceContent, errorCanary]
}

async function crashRecoveryCase(currentCase, checkpoint, expectedStatus) {
  prepareCrashCase(currentCase)
  await runCrashChild(currentCase, checkpoint)
  assertEqual(counterLines(currentCase), 1, 'crashed mutation must execute exactly once')
  const resumed = await runResumeChild(currentCase)
  assertRecoveredOperation(currentCase, resumed, expectedStatus)
  assertRecoveredPluginState(currentCase, resumed)
  assertDatabaseExcludes(currentCase, crashCaseSensitiveValues(currentCase))
}

function prepareCrashCase(currentCase) {
  setupCase(currentCase)
  const prefix = crashCaseCanaryPrefix(currentCase)
  if (currentCase !== 'uninstall-complete') createSource(currentCase, 'source', `${prefix}_SENSITIVE_CONTENT`)
  if (currentCase === 'overwrite-partial' || currentCase === 'uninstall-complete') {
    createActivePlugin(currentCase, `${prefix}_OLD_SENSITIVE_CONTENT`)
  }
}

function assertRecoveredOperation(currentCase, resumed, expectedStatus) {
  assertEqual(resumed.effectStatus, expectedStatus)
  assertEqual(resumed.snapshotExists, expectedStatus === 'waiting_reconciliation')
  assertEqual(resumed.runStatus, expectedStatus === 'confirmed' ? 'completed' : 'waiting_reconciliation')
  assertEqual(counterLines(currentCase), 1, 'recovery must not replay the plugin mutation')
}

function assertRecoveredPluginState(currentCase, resumed) {
  if (currentCase === 'install-complete') {
    assert(resumed.activeExists && !resumed.stagingExists, 'completed install postcondition must remain active')
  }
  if (currentCase === 'install-staged') {
    assert(!resumed.activeExists && resumed.stagingExists, 'staged-only install must remain unresolved')
  }
  if (currentCase === 'overwrite-partial') {
    assert(!resumed.activeExists && resumed.stagingExists && resumed.trashExists,
      'partial overwrite must preserve staging and previous version for manual recovery')
  }
  if (currentCase === 'uninstall-complete') {
    assert(!resumed.activeExists && resumed.trashExists, 'completed uninstall must remain recoverable in trash')
  }
}

function crashCaseSensitiveValues(currentCase) {
  const prefix = crashCaseCanaryPrefix(currentCase)
  const values = [`${prefix}_SENSITIVE_CONTENT`, `source-${currentCase}-PATH_SENSITIVE`]
  if (currentCase === 'overwrite-partial' || currentCase === 'uninstall-complete') {
    values.push(`${prefix}_OLD_SENSITIVE_CONTENT`)
  }
  return values
}

function crashCaseCanaryPrefix(currentCase) {
  return `PLUGIN_${currentCase.toUpperCase().replaceAll('-', '_')}`
}

async function runWorker(mode, currentCase) {
  setWorkerEnvironment(currentCase)
  const modules = await loadModules()
  if (mode === 'crash') return crashWorker(modules, currentCase)
  if (mode === 'resume') return resumeWorker(modules, currentCase)
  throw new Error(`unknown worker mode: ${mode}`)
}

async function crashWorker(modules, currentCase) {
  appendFileSync(counterFile(currentCase), 'execute\n')
  const checkpoint = checkpointForCase(currentCase)
  const hooks = {
    checkpoint(name) {
      if (name !== checkpoint) return
      writeFileSync(markerFile(currentCase), name, 'utf8')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
    }
  }
  const root = pluginsRoot(currentCase)
  if (currentCase === 'uninstall-complete') {
    await modules.pluginEffect.uninstallPluginWithEffect(activePluginPath(currentCase), root, { hooks })
  } else {
    await modules.pluginEffect.installLocalPluginWithEffect(
      sourcePath(currentCase, 'source'),
      root,
      currentCase === 'overwrite-partial',
      { hooks }
    )
  }
  throw new Error('crash checkpoint was not reached')
}

async function resumeWorker(modules, currentCase) {
  const snapshots = await modules.snapshotStore.listTaskSnapshots()
  assertEqual(snapshots.length, 1, 'crash case must have one recovery snapshot')
  const reconciled = await modules.effectRuntime.reconcilePersistedTaskSnapshot(snapshots[0])
  const effect = reconciled.run?.effects?.[0]
  assert(effect, 'reconciled plugin effect is missing')
  await modules.gateway.settleStoppedInteractiveOperationSnapshot(reconciled)
  const current = await modules.snapshotStore.getTaskSnapshot(snapshots[0].id)
  const terminal = (await modules.snapshotStore.listTaskRuns()).find((run) => run.id === snapshots[0].run?.id)
  const state = observedPaths(effect.target)
  process.send?.({
    effectStatus: effect.status,
    snapshotExists: current !== null,
    runStatus: current?.run?.status ?? terminal?.status,
    ...state
  })
}

function observedPaths(target) {
  assert(target.kind === 'managed_plugin_install' || target.kind === 'managed_plugin_uninstall')
  const root = target.rootPath
  const staging = target.kind === 'managed_plugin_install'
    ? path.resolve(root, target.stagingRelativePath)
    : ''
  const trash = target.trashRelativePath ? path.resolve(root, target.trashRelativePath) : ''
  return {
    activeExists: existsSync(path.join(root, target.pluginName)),
    stagingExists: staging ? existsSync(staging) : false,
    trashExists: trash ? existsSync(trash) : false
  }
}

function runCrashChild(currentCase, expectedCheckpoint) {
  return new Promise((resolve, reject) => {
    const child = spawnWorker('crash', currentCase)
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const started = Date.now()
    const poll = setInterval(() => {
      if (!existsSync(markerFile(currentCase))) {
        if (Date.now() - started < 30_000) return
        clearInterval(poll)
        child.kill('SIGKILL')
        reject(new Error(`crash checkpoint timed out: ${stderr}`))
        return
      }
      const actual = readFileSync(markerFile(currentCase), 'utf8')
      if (actual !== expectedCheckpoint) {
        clearInterval(poll)
        child.kill('SIGKILL')
        reject(new Error(`expected checkpoint ${expectedCheckpoint}, got ${actual}`))
        return
      }
      clearInterval(poll)
      child.kill('SIGKILL')
    }, 10)
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      clearInterval(poll)
      if (signal !== 'SIGKILL') return reject(new Error(`crash worker exited ${code}/${signal}: ${stderr}`))
      resolve()
    })
  })
}

function runResumeChild(currentCase) {
  return new Promise((resolve, reject) => {
    const child = spawnWorker('resume', currentCase)
    let message
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`resume worker timed out: ${stderr}`))
    }, 30_000)
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('message', (value) => { message = value })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (code !== 0 || signal) return reject(new Error(`resume worker exited ${code}/${signal}: ${stderr}`))
      if (!message) return reject(new Error('resume worker returned no evidence'))
      resolve(message)
    })
  })
}

function spawnWorker(mode, currentCase) {
  return fork(process.argv[1], [mode, currentCase], {
    env: {
      ...process.env,
      CAOGEN_PLUGIN_EFFECT_ROOT: tempRoot,
      CAOGEN_PLUGIN_EFFECT_COMPILED: outDir,
      CAOGEN_PLUGIN_EFFECT_USER_DATA: userData(currentCase)
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  })
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/pluginInstallEffect.ts',
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
    pluginEffect: await importModule('main/pluginInstallEffect.js'),
    pluginDirectory: await importModule('main/plugin/plugin-directory-effect.js'),
    targetValidation: await importModule('main/task/effect-target-validation.js'),
    gateway: await importModule('main/task/operation-effect-gateway.js'),
    effectRuntime: await importModule('main/task/effect-runtime.js'),
    snapshotStore: await importModule('main/task/task-snapshot.js')
  }
}

function assertTargetValidation(modules, source, root) {
  const prepared = modules.pluginDirectory.preparePluginInstall(source, root, false, 'validation01')
  assert(!('ok' in prepared), `install target preparation failed: ${JSON.stringify(prepared)}`)
  const target = modules.pluginDirectory.buildManagedPluginEffectTarget(
    prepared.operationCwd,
    'managed_plugin_install',
    modules.pluginDirectory.pluginInstallToolInput(prepared)
  )
  assert(modules.targetValidation.isEffectTarget(target), 'valid plugin install target was rejected')
  const invalidTargets = [
    { ...target, rootPath: '../escape' },
    { ...target, pluginName: '../../escape' },
    { ...target, expectedDigest: '0'.repeat(63) },
    { ...target, stagingRelativePath: '../stage' },
    { ...target, targetPreIdentity: { device: '1', inode: '2' } },
    { ...target, rootPreState: 'absent' },
    { ...target, pluginName: '.TRASH' },
    { ...target, pluginName: '.CAOGEN-OPERATIONS' }
  ]
  for (const invalid of invalidTargets) {
    assert(!modules.targetValidation.isEffectTarget(invalid), `invalid plugin target was accepted: ${JSON.stringify(invalid)}`)
  }

  const validationPlugin = path.join(root, 'validation-plugin')
  mkdirSync(validationPlugin, { recursive: true })
  writeFileSync(path.join(validationPlugin, 'SKILL.md'), 'VALIDATION_PLUGIN_CONTENT')
  const uninstallPrepared = modules.pluginDirectory.preparePluginUninstall(
    validationPlugin,
    root,
    'validation02'
  )
  assert(!('ok' in uninstallPrepared), `uninstall target preparation failed: ${JSON.stringify(uninstallPrepared)}`)
  const uninstallTarget = modules.pluginDirectory.buildManagedPluginEffectTarget(
    uninstallPrepared.operationCwd,
    'managed_plugin_uninstall',
    modules.pluginDirectory.pluginUninstallToolInput(uninstallPrepared)
  )
  assert(modules.targetValidation.isEffectTarget(uninstallTarget), 'valid plugin uninstall target was rejected')
  assert(!modules.targetValidation.isEffectTarget({ ...uninstallTarget, trashRelativePath: '../trash' }),
    'escaping plugin trash target was accepted')
}

function importModule(relativePath) {
  return import(pathToFileURL(path.join(outDir, relativePath)).href)
}

function setupCase(currentCase) {
  mkdirSync(caseRoot(currentCase), { recursive: true })
  mkdirSync(userData(currentCase), { recursive: true })
}

function setWorkerEnvironment(currentCase) {
  process.env.CAOGEN_TEST_USER_DATA = userData(currentCase)
}

function createSource(currentCase, suffix, content, pluginName = 'demo-plugin') {
  const source = sourcePath(currentCase, suffix)
  mkdirSync(source, { recursive: true })
  writeFileSync(path.join(source, 'plugin.json'), JSON.stringify({ name: pluginName, version: suffix }))
  writeFileSync(path.join(source, 'index.md'), content)
  return source
}

function createActivePlugin(currentCase, content) {
  const active = activePluginPath(currentCase)
  mkdirSync(active, { recursive: true })
  writeFileSync(path.join(active, 'plugin.json'), JSON.stringify({ name: 'demo-plugin', version: 'old' }))
  writeFileSync(path.join(active, 'index.md'), content)
}

function trashEntries(currentCase) {
  const trash = path.join(pluginsRoot(currentCase), '.trash')
  return existsSync(trash) ? readdirSync(trash) : []
}

function assertDatabaseExcludes(currentCase, values) {
  const databasePath = path.join(userData(currentCase), 'task-snapshots.db')
  assert(existsSync(databasePath), 'task snapshot database is missing')
  const database = readFileSync(databasePath)
  for (const value of values) {
    assert(!database.includes(Buffer.from(value)), `sensitive plugin value leaked into database: ${value}`)
  }
}

function checkpointForCase(currentCase) {
  if (currentCase === 'install-complete') return 'installed'
  if (currentCase === 'install-staged') return 'staged'
  if (currentCase === 'overwrite-partial') return 'previous_trashed'
  if (currentCase === 'uninstall-complete') return 'uninstalled'
  throw new Error(`unknown crash case: ${currentCase}`)
}

function caseRoot(currentCase) { return path.join(tempRoot, currentCase) }
function pluginsRoot(currentCase) { return path.join(caseRoot(currentCase), 'plugins') }
function activePluginPath(currentCase) { return path.join(pluginsRoot(currentCase), 'demo-plugin') }
function sourcePath(currentCase, suffix) { return path.join(caseRoot(currentCase), `source-${currentCase}-PATH_SENSITIVE-${suffix}`) }
function userData(currentCase) { return path.join(caseRoot(currentCase), 'user-data') }
function markerFile(currentCase) { return path.join(caseRoot(currentCase), 'checkpoint.txt') }
function counterFile(currentCase) { return path.join(caseRoot(currentCase), 'execution-count.txt') }

function counterLines(currentCase) {
  if (!existsSync(counterFile(currentCase))) return 0
  return readFileSync(counterFile(currentCase), 'utf8').split('\n').filter(Boolean).length
}

function requireCaseName(value) {
  if (!value) throw new Error('worker case name is required')
  return value
}

function assertEqual(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(`${message ? `${message}: ` : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
