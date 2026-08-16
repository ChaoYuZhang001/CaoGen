#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-cc-switch-import-'))
const outDir = path.join(tempRoot, 'compiled')
const userDataDir = path.join(tempRoot, 'user-data')
const sourceDir = path.join(tempRoot, 'cc-switch')
const checks = []
const codexSecret = ['cc', 'switch', 'codex', 'secret', 'canary'].join('-')
const claudeSecret = ['cc', 'switch', 'claude', 'secret', 'canary'].join('-')
const existingSecret = ['caogen', 'existing', 'secret', 'canary'].join('-')

try {
  compile()
  installRuntimeStubs()
  createFixture()
  process.env.CAOGEN_CC_SWITCH_HOME = sourceDir

  const service = await import(pathToFileURL(findCompiled('ccSwitchProviderImport.js')).href)
  const providers = await import(pathToFileURL(findCompiled('providers.js')).href)

  const preview = service.previewCcSwitchProviderImport()
  equal(preview.providerCount, 3, 'all supported CC Switch rows are counted')
  equal(preview.importableCount, 2, 'empty templates are skipped')
  equal(preview.credentialCount, 2, 'credential presence is counted without exposing values')
  assert(!JSON.stringify(preview).includes(codexSecret), 'Codex credential never enters preview')
  assert(!JSON.stringify(preview).includes(claudeSecret), 'Claude credential never enters preview')
  const codex = preview.items.find((item) => item.sourceApp === 'codex')
  const claude = preview.items.find((item) => item.sourceApp === 'claude' && item.models.length > 0)
  assert(codex, 'Codex item is present')
  assert(claude, 'Claude item is present')
  equal(codex.openaiProtocol, 'chat', 'CC Switch apiFormat overrides client-facing Codex wire_api')
  equal(codex.monthlyBudgetUsd, 25, 'monthly limit maps to CaoGen budget')
  equal(codex.costMultiplier, 2, 'Provider cost multiplier is retained')
  equal(codex.pricedModelCount, 1, 'matching CC Switch model pricing is imported')
  assert(codex.warnings.includes('daily_limit_not_enforced'), 'daily limit is disclosed as not enforced')
  assert(codex.warnings.includes('proxy_listener_not_imported'), 'local proxy listener is explicitly ignored')
  assert(codex.warnings.includes('proxy_takeover_not_imported'), 'proxy takeover is explicitly ignored')
  equal(claude.engine, 'anthropic', 'default Claude provider maps to Anthropic Messages')

  const applied = service.applyCcSwitchProviderImport(preview.previewId, [])
  equal(applied.created, 2, 'default decisions create both importable Providers')
  equal(applied.skipped, 1, 'default decisions skip the empty template')
  const importedCodex = applied.providers.find((provider) => provider.name === 'Fixture Codex')
  const importedClaude = applied.providers.find((provider) => provider.name === 'Fixture Claude')
  assert(importedCodex?.hasToken, 'Codex credential is usable after import')
  assert(importedClaude?.hasToken, 'Claude credential is usable after import')
  equal(providers.resolveProviderToken(providers.getProvider(importedCodex.id)).token, codexSecret,
    'Codex credential remains inside the main process broker')
  equal(importedCodex.advancedConfig.modelProfiles[0].pricing.inputPerMillion, 3,
    'cost multiplier is applied to imported input price')
  equal(importedCodex.advancedConfig.modelProfiles[0].pricing.outputPerMillion, 20,
    'cost multiplier is applied to imported output price')
  equal(importedCodex.advancedConfig.reliability.failoverEnabled, true,
    'Codex automatic failover policy is imported')
  equal(importedCodex.advancedConfig.reliability.maxRetries, 3,
    'Codex recovery limit is imported')
  equal(importedCodex.advancedConfig.reliability.circuitBreaker.failureThreshold, 4,
    'Codex circuit threshold is imported')
  equal(importedClaude.advancedConfig.reliability.failoverEnabled, false,
    'Claude automatic failover policy remains independent')
  equal(importedClaude.advancedConfig.reliability.circuitBreaker.failureThreshold, 8,
    'Claude circuit threshold remains independent')
  assert(/^[a-f0-9]{24}$/.test(importedCodex.advancedConfig.metadata.sourceProviderId),
    'imported Provider retains a stable non-secret CC Switch source identity')
  const backupText = readBackupText()
  assert(!backupText.includes(codexSecret) && !backupText.includes(claudeSecret),
    'CC Switch backup excludes plaintext credentials')
  service.rollbackCcSwitchProviderImportBackup(applied.backup.id)
  equal(providers.listProviders().length, 0, 'rollback removes newly imported Providers')

  const existing = providers.createProvider({
    name: 'Existing Gateway',
    baseUrl: 'https://fixture-codex.invalid/v1',
    models: ['before-model'],
    engine: 'openai',
    openaiProtocol: 'chat',
    authMode: 'api-key',
    token: existingSecret
  })
  const updatePreview = service.previewCcSwitchProviderImport()
  const updateItem = updatePreview.items.find((item) => item.sourceApp === 'codex')
  equal(updateItem.defaultAction, 'update', 'exact existing target defaults to update')
  equal(updateItem.credentialImportable, false, 'existing credential is preserved')
  const updated = service.applyCcSwitchProviderImport(updatePreview.previewId, updatePreview.items.map((item) => ({
    itemId: item.id,
    action: item.id === updateItem.id ? 'update' : 'skip'
  })))
  equal(providers.resolveProviderToken(providers.getProvider(existing.id)).token, existingSecret,
    'CC Switch import never replaces an existing CaoGen credential')
  service.rollbackCcSwitchProviderImportBackup(updated.backup.id)
  equal(providers.getProvider(existing.id).models[0], 'before-model', 'update rollback restores prior models')
  providers.deleteProvider(existing.id)

  const staleSource = service.previewCcSwitchProviderImport()
  addPricingRow('source-drift-model')
  assertThrows(() => service.applyCcSwitchProviderImport(staleSource.previewId, []),
    'source database drift is rejected after preview')
  equal(providers.listProviders().length, 0, 'source drift rejection does not mutate CaoGen Providers')

  const staleProvider = service.previewCcSwitchProviderImport()
  const unrelated = providers.createProvider({
    name: 'Unrelated', baseUrl: 'https://unrelated.invalid/v1', models: ['x'],
    engine: 'openai', openaiProtocol: 'responses', authMode: 'api-key'
  })
  assertThrows(() => service.applyCcSwitchProviderImport(staleProvider.previewId, []),
    'CaoGen Provider drift is rejected after preview')
  providers.deleteProvider(unrelated.id)

  console.log(`CC Switch import smoke passed: ${checks.length}/${checks.length}`)
} finally {
  delete process.env.CAOGEN_CC_SWITCH_HOME
  rmSync(tempRoot, { recursive: true, force: true })
}

function compile() {
  symlinkSync(path.join(repoRoot, 'node_modules'), path.join(tempRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
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
  writeFileSync(path.join(electronRoot, 'package.json'), JSON.stringify({ name: 'electron', version: '0.0.0', main: 'index.js' }))
  writeFileSync(path.join(electronRoot, 'index.js'), `'use strict'\nmodule.exports = {\n  app: { getPath(name) {\n    if (name === 'userData') return ${JSON.stringify(userDataDir)}\n    if (name === 'home') return ${JSON.stringify(tempRoot)}\n    throw new Error('unsupported Electron path: ' + name)\n  } },\n  safeStorage: {\n    isEncryptionAvailable() { return true },\n    encryptString(value) { return Buffer.from(value, 'utf8') },\n    decryptString(value) { return Buffer.from(value).toString('utf8') },\n    getSelectedStorageBackend() { return 'keychain' }\n  }\n}\n`)
  cpSync(path.join(repoRoot, 'node_modules', '@iarna', 'toml'), path.join(outDir, 'node_modules', '@iarna', 'toml'), { recursive: true })
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
  const insert = database.prepare(`
    INSERT INTO providers (
      id, app_type, name, settings_config, notes, meta, sort_index,
      cost_multiplier, limit_daily_usd, limit_monthly_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  insert.run('codex-1', 'codex', 'Fixture Codex', JSON.stringify({
    auth: { OPENAI_API_KEY: codexSecret },
    config: [
      'model_provider = "fixture"',
      'model = "fixture-model"',
      'model_reasoning_effort = "high"',
      '[model_providers.fixture]',
      'name = "Fixture"',
      'base_url = "https://fixture-codex.invalid/v1"',
      'wire_api = "responses"'
    ].join('\n')
  }), 'imported note', JSON.stringify({ apiFormat: 'openai_chat' }), 1, '2', '5', '25')
  insert.run('claude-1', 'claude', 'Fixture Claude', JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: 'https://fixture-claude.invalid',
      ANTHROPIC_AUTH_TOKEN: claudeSecret,
      ANTHROPIC_MODEL: 'claude-fixture'
    }
  }), null, JSON.stringify({ apiFormat: 'anthropic' }), 2, '1', null, null)
  insert.run('empty-1', 'claude', 'Empty Template', '{}', null, '{}', 3, '1', null, null)
  database.prepare('INSERT INTO provider_endpoints (provider_id, app_type, url) VALUES (?, ?, ?)')
    .run('codex-1', 'codex', 'https://fixture-backup.invalid/v1')
  database.prepare('INSERT INTO model_pricing VALUES (?, ?, ?, ?, ?, ?)')
    .run('fixture-model', 'Fixture Model', '1.5', '10', '0.2', '2')
  const insertPolicy = database.prepare('INSERT INTO proxy_config VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  insertPolicy.run('codex', 1, '127.0.0.1', 15721, 1, 1, 1, 3, 60, 120, 600, 4, 2, 60, 0.6, 10, 1)
  insertPolicy.run('claude', 0, '127.0.0.1', 15722, 0, 0, 0, 6, 90, 180, 600, 8, 3, 90, 0.7, 15, 0)
  database.close()
}

function addPricingRow(model) {
  const database = new DatabaseSync(path.join(sourceDir, 'cc-switch.db'))
  database.prepare('INSERT INTO model_pricing VALUES (?, ?, ?, ?, ?, ?)')
    .run(model, model, '1', '1', '1', '1')
  database.close()
}

function readBackupText() {
  const root = path.join(userDataDir, 'cc-switch-provider-import-backups')
  return readdirSync(root).filter((name) => name.endsWith('.json'))
    .map((name) => readFileSync(path.join(root, name), 'utf8')).join('\n')
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

function assert(condition, message) {
  checks.push({ name: message, status: condition ? 'pass' : 'fail' })
  if (!condition) throw new Error(message)
}

function equal(actual, expected, message) {
  assert(actual === expected, `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assertThrows(action, message) {
  let threw = false
  try { action() } catch { threw = true }
  assert(threw, message)
}
