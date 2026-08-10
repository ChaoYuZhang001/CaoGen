#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-cc-switch-assets-'))
const outDir = path.join(tempRoot, 'compiled')
const home = path.join(tempRoot, 'home')
const sourceRoot = path.join(home, '.cc-switch')
const databasePath = path.join(sourceRoot, 'cc-switch.db')
const backupRoot = path.join(tempRoot, 'backups')
const secret = ['cc', 'switch', 'asset', 'secret', 'canary'].join('-')
const checks = []

try {
  compile()
  createFixture()
  const migration = await import(pathToFileURL(findCompiled('migration.js')).href)

  const scan = migration.scanMigration(undefined, home)
  const assets = scan.assets.filter((asset) => asset.agent === 'CC Switch')
  equal(assets.length, 5, 'CC Switch MCP, Prompts, Skill, and usage are scanned')
  equal(assets.filter((asset) => asset.kind === 'mcp').length, 1, 'MCP asset is classified')
  equal(assets.filter((asset) => asset.kind === 'prompt').length, 2, 'Prompt assets are classified')
  equal(assets.filter((asset) => asset.kind === 'skill').length, 1, 'Skill asset is classified')
  equal(assets.filter((asset) => asset.kind === 'usage').length, 1, 'historical usage is classified')
  assert(!JSON.stringify(scan).includes(secret), 'secret-bearing fields never enter Renderer scan data')
  const blockedPrompt = assets.find((asset) => asset.kind === 'prompt' && !asset.importable)
  assert(blockedPrompt?.risk === 'blocked', 'secret-bearing Prompt is blocked')
  const mcp = assets.find((asset) => asset.kind === 'mcp')
  assert(mcp?.ignoredFields.includes('env'), 'MCP environment is explicitly excluded')

  const selected = assets.filter((asset) => asset.importable)
  const applied = migration.applyMigration({
    scanId: scan.scanId,
    decisions: assets.map((asset) => ({ assetId: asset.id, action: asset.importable ? 'import' : 'skip' }))
  }, { backupRoot })
  assert(applied.ok && applied.status === 'applied', 'four safe assets apply as one batch')
  equal(applied.applied.length, 4, 'batch applies MCP, Prompt, Skill, and usage')

  const mcpTarget = JSON.parse(readFileSync(mcp.targetPath, 'utf8'))
  assert(Object.hasOwn(mcpTarget.mcpServers, mcp.name), 'MCP is written to managed configuration')
  assert(!JSON.stringify(mcpTarget).includes(secret) && !Object.hasOwn(mcpTarget.mcpServers[mcp.name], 'env'),
    'MCP target excludes credentials and environment')
  const prompt = selected.find((asset) => asset.kind === 'prompt')
  const skill = selected.find((asset) => asset.kind === 'skill')
  const usage = selected.find((asset) => asset.kind === 'usage')
  assert(readFileSync(path.join(prompt.targetPath, 'SKILL.md'), 'utf8').includes('Safe migration prompt body'),
    'Prompt becomes a CaoGen prompt-only Skill')
  assert(readFileSync(path.join(skill.targetPath, 'SKILL.md'), 'utf8').includes('Fixture reusable skill'),
    'CC Switch Skill is copied into the CaoGen global Skill root')
  const usageDocument = JSON.parse(readFileSync(usage.targetPath, 'utf8'))
  assert(usageDocument.rows.length === 1 && usageDocument.rows[0].requestCount === 3,
    'CC Switch daily usage is stored as a bounded external rollup')
  assert(!allBackupText().includes(secret), 'migration backup excludes stripped source credentials')

  const rolledBack = migration.rollbackMigration(applied.backupId, backupRoot)
  assert(rolledBack.ok, 'batch rollback succeeds')
  assert(!exists(mcp.targetPath) && !exists(prompt.targetPath) && !exists(skill.targetPath) && !exists(usage.targetPath),
    'rollback removes all migration-created targets')

  const sourceDriftScan = migration.scanMigration(undefined, home)
  const sourceDriftPrompt = sourceDriftScan.assets.find((asset) => asset.agent === 'CC Switch' && asset.kind === 'prompt' && asset.importable)
  updatePrompt('Safe migration prompt body changed after preview')
  const sourceDrift = migration.applyMigration({
    scanId: sourceDriftScan.scanId,
    decisions: [{ assetId: sourceDriftPrompt.id, action: 'import' }]
  }, { backupRoot })
  assert(!sourceDrift.ok && sourceDrift.errorCode === 'migration_source_changed', 'database row drift is rejected')
  assert(!exists(sourceDriftPrompt.targetPath), 'source drift rejection does not mutate the target')

  const targetDriftScan = migration.scanMigration(undefined, home)
  const targetDriftMcp = targetDriftScan.assets.find((asset) => asset.agent === 'CC Switch' && asset.kind === 'mcp')
  mkdirSync(path.dirname(targetDriftMcp.targetPath), { recursive: true })
  writeFileSync(targetDriftMcp.targetPath, '{"mcpServers":{}}\n')
  const targetDrift = migration.applyMigration({
    scanId: targetDriftScan.scanId,
    decisions: [{ assetId: targetDriftMcp.id, action: 'import' }]
  }, { backupRoot })
  assert(!targetDrift.ok && targetDrift.errorCode === 'migration_target_changed', 'target drift is rejected')
  equal(readFileSync(targetDriftMcp.targetPath, 'utf8'), '{"mcpServers":{}}\n', 'target drift preserves external bytes')

  console.log(`CC Switch asset migration smoke passed: ${checks.length}/${checks.length}`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compile() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/migration.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function createFixture() {
  mkdirSync(sourceRoot, { recursive: true })
  const skillDirectory = path.join(sourceRoot, 'skills', 'fixture-skill')
  mkdirSync(skillDirectory, { recursive: true })
  writeFileSync(path.join(skillDirectory, 'SKILL.md'), '# Fixture reusable skill\n\n## Steps\n\n- Verify the input.\n')
  const database = new DatabaseSync(databasePath)
  database.exec(`
    CREATE TABLE mcp_servers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, server_config TEXT NOT NULL,
      enabled_claude BOOLEAN NOT NULL, enabled_codex BOOLEAN NOT NULL
    );
    CREATE TABLE prompts (
      id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL,
      description TEXT, enabled BOOLEAN NOT NULL, PRIMARY KEY (id, app_type)
    );
    CREATE TABLE skills (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, directory TEXT NOT NULL,
      enabled_claude BOOLEAN NOT NULL, enabled_codex BOOLEAN NOT NULL, content_hash TEXT
    );
    CREATE TABLE usage_daily_rollups (
      date TEXT NOT NULL, app_type TEXT NOT NULL, provider_id TEXT NOT NULL,
      model TEXT, request_model TEXT, pricing_model TEXT, request_count INTEGER NOT NULL,
      success_count INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
      total_cost_usd TEXT NOT NULL, avg_latency_ms INTEGER, input_token_semantics INTEGER
    );
    CREATE TABLE providers (
      id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL
    );
  `)
  database.prepare('INSERT INTO mcp_servers VALUES (?, ?, ?, ?, ?)').run(
    'mcp-fixture', 'Fixture MCP', JSON.stringify({
      command: 'fixture-mcp', args: ['--safe'], env: { API_KEY: secret }, type: 'stdio'
    }), 1, 1
  )
  database.prepare('INSERT INTO prompts VALUES (?, ?, ?, ?, ?, ?)').run(
    'prompt-safe', 'codex', 'Safe Prompt', 'Safe migration prompt body', 'Reusable safe prompt', 1
  )
  database.prepare('INSERT INTO prompts VALUES (?, ?, ?, ?, ?, ?)').run(
    'prompt-secret', 'claude', 'Secret Prompt', `API_KEY=${secret}`, 'Must remain blocked', 1
  )
  database.prepare('INSERT INTO skills VALUES (?, ?, ?, ?, ?, ?)').run(
    'skill-fixture', 'Fixture Skill', path.relative(sourceRoot, skillDirectory), 1, 1, null
  )
  database.prepare('INSERT INTO providers VALUES (?, ?, ?)').run('provider-fixture', 'codex', 'Fixture Provider')
  database.prepare('INSERT INTO usage_daily_rollups VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    '2026-08-09', 'codex', 'provider-fixture', 'fixture-model', 'fixture-model', 'fixture-model',
    3, 2, 120, 40, 10, 5, '0.0012', 250, 1
  )
  database.close()
}

function updatePrompt(content) {
  const database = new DatabaseSync(databasePath)
  database.prepare("UPDATE prompts SET content = ? WHERE id = 'prompt-safe' AND app_type = 'codex'").run(content)
  database.close()
}

function allBackupText() {
  const files = []
  const visit = (directory) => {
    if (!exists(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(target)
      else files.push(readFileSync(target, 'utf8'))
    }
  }
  visit(backupRoot)
  return files.join('\n')
}

function findCompiled(fileName) {
  const queue = [outDir]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name)
      if (entry.isDirectory()) queue.push(candidate)
      else if (entry.name === fileName) return candidate
    }
  }
  throw new Error(`compiled module missing: ${fileName}`)
}

function exists(target) {
  try { readFileSync(target); return true } catch {}
  try { readdirSync(target); return true } catch { return false }
}

function assert(condition, name) {
  checks.push(name)
  if (!condition) throw new Error(name)
}

function equal(actual, expected, name) {
  assert(actual === expected, `${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
