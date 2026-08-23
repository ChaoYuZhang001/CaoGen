#!/usr/bin/env node
import { execFileSync, fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
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
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const mode = process.argv[2]
const tempRoot = process.env.CAOGEN_CC_SWITCH_RESTART_ROOT
  ?? mkdtempSync(path.join(tmpdir(), 'caogen-cc-switch-restart-'))
const outDir = path.join(tempRoot, 'compiled')
const userDataDir = path.join(tempRoot, 'user-data')
const sourceDir = path.join(tempRoot, 'cc-switch')
const secret = ['restart', 'credential', 'canary', '91'].join('-')

if (mode) {
  await runWorker(mode)
} else {
  const checks = []
  try {
    compile()
    installRuntimeStubs()
    createFixture()
    const sourceBefore = sha256File(path.join(sourceDir, 'cc-switch.db'))

    const beforeCommit = await runChild('apply-before-commit', true)
    equal(beforeCommit.checkpoint, 'after_prepare', 'apply reaches durable prepare before the Store write')
    const aborted = await runChild('recover', false)
    equal(aborted.providerCount, 0, 'restart after prepare preserves the complete pre-import Store')
    equal(aborted.backupCount, 0, 'aborted apply is not offered as a rollback batch')

    const afterCommit = await runChild('apply-after-commit', true)
    equal(afterCommit.checkpoint, 'after_store_commit', 'apply reaches the atomic Store commit before confirmation')
    const applied = await runChild('recover', false)
    equal(applied.providerCount, 1, 'restart after Store commit preserves the complete imported batch')
    equal(applied.backupCount, 1, 'restart recovers the committed batch rollback record')
    equal(applied.keyCount, 1, 'restart preserves the imported credential record')
    assert(!backupText().includes(secret), 'durable batch backup excludes the plaintext credential')

    const rollbackCommit = await runChild('rollback-after-commit', true)
    equal(rollbackCommit.checkpoint, 'after_store_commit', 'rollback reaches the atomic Store commit before confirmation')
    const rolledBack = await runChild('recover', false)
    equal(rolledBack.providerCount, 0, 'restart after rollback commit restores the complete pre-import Store')
    equal(rolledBack.backupCount, 0, 'recovered rollback is not offered a second time')
    equal(sha256File(path.join(sourceDir, 'cc-switch.db')), sourceBefore, 'source CC Switch database remains byte-identical')

    console.log(`CC Switch import restart E2E passed: ${checks.length}/${checks.length}`)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }

  function assert(condition, message) {
    checks.push({ name: message, status: condition ? 'pass' : 'fail' })
    if (!condition) throw new Error(message)
  }

  function equal(actual, expected, message) {
    assert(actual === expected, `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

async function runWorker(workerMode) {
  process.env.CAOGEN_CC_SWITCH_HOME = sourceDir
  const service = await importCompiled('ccSwitchProviderImport.js')
  const providers = await importCompiled('providers.js')
  if (workerMode === 'recover') {
    service.reconcileCcSwitchProviderImportOperations()
    const providerViews = providers.listProviders()
    process.send?.({
      providerCount: providerViews.length,
      backupCount: service.listCcSwitchProviderImportBackups().length,
      keyCount: providerViews.reduce((total, provider) => total + (provider.keyCount ?? 0), 0)
    })
    return
  }
  if (workerMode === 'apply-before-commit') {
    return crashApply(service, 'after_prepare', 'cc-switch-apply-before')
  }
  if (workerMode === 'apply-after-commit') {
    return crashApply(service, 'after_store_commit', 'cc-switch-apply-after')
  }
  if (workerMode === 'rollback-after-commit') {
    const backup = service.listCcSwitchProviderImportBackups()[0]
    if (!backup) throw new Error('committed CC Switch backup is missing before rollback')
    return service.rollbackCcSwitchProviderImportBackup(backup.id, crashOptions(
      'after_store_commit',
      'cc-switch-rollback-after'
    ))
  }
  throw new Error(`unknown worker mode: ${workerMode}`)
}

function crashApply(service, checkpoint, operationId) {
  const preview = service.previewCcSwitchProviderImport()
  return service.applyCcSwitchProviderImport(preview.previewId, [], crashOptions(checkpoint, operationId))
}

function crashOptions(checkpoint, operationId) {
  return {
    operationId,
    onCheckpoint(current) {
      if (current !== checkpoint) return
      process.send?.({ checkpoint: current })
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
    }
  }
}

function runChild(workerMode, killAfterMessage) {
  return new Promise((resolvePromise, reject) => {
    const child = fork(process.argv[1], [workerMode], {
      env: {
        ...process.env,
        CAOGEN_CC_SWITCH_RESTART_ROOT: tempRoot
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    let stdout = ''
    let stderr = ''
    let message
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${workerMode} timed out\n${stdout}\n${stderr}`))
    }, 30_000)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('message', (value) => {
      message = value
      if (killAfterMessage) child.kill('SIGKILL')
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (!message) return reject(new Error(`${workerMode} exited without evidence (${code}/${signal})\n${stdout}\n${stderr}`))
      if (killAfterMessage && signal !== 'SIGKILL') {
        return reject(new Error(`${workerMode} expected SIGKILL, got ${code}/${signal}`))
      }
      if (!killAfterMessage && code !== 0) {
        return reject(new Error(`${workerMode} failed (${code})\n${stdout}\n${stderr}`))
      }
      resolvePromise(message)
    })
  })
}

function compile() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/provider/ccSwitchProviderImport.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installRuntimeStubs() {
  const electronRoot = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronRoot, { recursive: true })
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(path.join(electronRoot, 'package.json'), JSON.stringify({
    name: 'electron', version: '0.0.0', main: 'index.js'
  }))
  writeFileSync(path.join(electronRoot, 'index.js'), `'use strict'\nmodule.exports = {
  app: { getPath(name) {
    if (name === 'userData') return ${JSON.stringify(userDataDir)}
    if (name === 'home') return ${JSON.stringify(tempRoot)}
    throw new Error('unsupported Electron path: ' + name)
  } },
  safeStorage: {
    isEncryptionAvailable() { return true },
    encryptString(value) { return Buffer.from(value, 'utf8') },
    decryptString(value) { return Buffer.from(value).toString('utf8') },
    getSelectedStorageBackend() { return 'keychain' }
  }
}\n`)
  cpSync(
    path.join(repoRoot, 'node_modules', '@iarna', 'toml'),
    path.join(outDir, 'node_modules', '@iarna', 'toml'),
    { recursive: true }
  )
  cpSync(path.join(repoRoot, 'node_modules', 'sql.js'), path.join(outDir, 'node_modules', 'sql.js'), { recursive: true })
}

function createFixture() {
  mkdirSync(sourceDir, { recursive: true })
  const database = new DatabaseSync(path.join(sourceDir, 'cc-switch.db'))
  database.exec(`
    CREATE TABLE providers (
      id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL, settings_config TEXT NOT NULL,
      notes TEXT, meta TEXT NOT NULL, sort_index INTEGER, cost_multiplier TEXT NOT NULL,
      limit_daily_usd TEXT, limit_monthly_usd TEXT
    );
    CREATE TABLE provider_endpoints (
      id INTEGER PRIMARY KEY, provider_id TEXT NOT NULL, app_type TEXT NOT NULL, url TEXT NOT NULL
    );
    CREATE TABLE model_pricing (
      model_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, input_cost_per_million TEXT NOT NULL,
      output_cost_per_million TEXT NOT NULL, cache_read_cost_per_million TEXT NOT NULL,
      cache_creation_cost_per_million TEXT NOT NULL
    );
    CREATE TABLE proxy_config (
      app_type TEXT NOT NULL, proxy_enabled INTEGER, listen_address TEXT, listen_port INTEGER,
      enable_logging INTEGER, enabled INTEGER, auto_failover_enabled INTEGER, max_retries INTEGER,
      streaming_first_byte_timeout INTEGER, streaming_idle_timeout INTEGER, non_streaming_timeout INTEGER,
      circuit_failure_threshold INTEGER, circuit_success_threshold INTEGER, circuit_timeout_seconds INTEGER,
      circuit_error_rate_threshold REAL, circuit_min_requests INTEGER, live_takeover_active INTEGER
    );
  `)
  database.prepare(`
    INSERT INTO providers (
      id, app_type, name, settings_config, notes, meta, sort_index,
      cost_multiplier, limit_daily_usd, limit_monthly_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('restart-codex', 'codex', 'Restart Fixture', JSON.stringify({
    auth: { OPENAI_API_KEY: secret },
    config: [
      'model_provider = "restart"',
      'model = "restart-model"',
      '[model_providers.restart]',
      'name = "Restart"',
      'base_url = "https://restart-fixture.invalid/v1"',
      'wire_api = "responses"'
    ].join('\n')
  }), null, '{}', 1, '1', null, '20')
  database.close()
}

function importCompiled(fileName) {
  return import(pathToFileURL(findCompiled(fileName)).href)
}

function findCompiled(fileName) {
  const visit = (root) => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const full = path.join(root, entry.name)
      if (entry.isDirectory()) {
        const found = visit(full)
        if (found) return found
      } else if (entry.name === fileName) return full
    }
    return ''
  }
  const found = visit(outDir)
  if (!found) throw new Error(`compiled ${fileName} not found`)
  return found
}

function backupText() {
  const root = path.join(userDataDir, 'cc-switch-provider-import-backups')
  if (!existsSync(root)) return ''
  return readdirSync(root).filter((name) => name.endsWith('.json'))
    .map((name) => readFileSync(path.join(root, name), 'utf8')).join('\n')
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}
