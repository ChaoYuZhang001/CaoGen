#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const repoRoot = process.cwd()
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')
if (!existsSync(mainEntry)) throw new Error('Built Electron main entry not found. Run npm run build first.')

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-cc-switch-assets-e2e-'))
const home = path.join(tempRoot, 'home')
const sourceRoot = path.join(home, '.cc-switch')
const userDataDir = path.join(tempRoot, 'userData')
const statePath = path.join(tempRoot, 'state.json')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'cc-switch-assets-migration-e2e', runId)
const runner = path.join(repoRoot, 'scripts', 'cc-switch-assets-migration-runner.cjs')
const electron = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const secret = ['cc', 'switch', 'assets', 'electron', 'secret', 'canary'].join('-')

try {
  mkdirSync(sourceRoot, { recursive: true })
  mkdirSync(reportDir, { recursive: true })
  createFixture()
  execFileSync(electron, [runner], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      CAOGEN_USER_DATA_DIR: userDataDir,
      CAOGEN_MIGRATION_TEST_MODE: '1',
      CAOGEN_MIGRATION_TEST_HOME: home,
      CAOGEN_PROVIDER_USAGE_IMPORT_HOME: home,
      CAOGEN_CC_SWITCH_ASSETS_E2E_STATE: statePath,
      CAOGEN_CC_SWITCH_ASSETS_E2E_SCREENSHOT_DIR: reportDir,
      CAOGEN_CC_SWITCH_ASSETS_E2E_SECRET: secret
    }
  })
  const report = JSON.parse(readFileSync(statePath, 'utf8'))
  if (!report.ok || report.pass !== report.total || report.total < 13) {
    throw new Error(`CC Switch assets E2E incomplete: ${JSON.stringify({ pass: report.pass, total: report.total })}`)
  }
  if (JSON.stringify(report).includes(secret)) throw new Error('CC Switch assets E2E report contains secret material')
  console.log(`CC Switch assets migration E2E passed: ${report.pass}/${report.total}`)
  console.log(reportDir)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function createFixture() {
  const skillDirectory = path.join(sourceRoot, 'skills', 'fixture-skill')
  mkdirSync(skillDirectory, { recursive: true })
  writeFileSync(path.join(skillDirectory, 'SKILL.md'), [
    '---',
    'name: Fixture Skill',
    'description: Safe fixture skill',
    '---',
    '',
    '# Fixture Skill',
    '',
    'Use the safe fixture workflow.',
    ''
  ].join('\n'), 'utf8')

  const database = new DatabaseSync(path.join(sourceRoot, 'cc-switch.db'))
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
    'mcp-e2e', 'Fixture MCP E2E', JSON.stringify({
      command: 'fixture-mcp', args: ['--safe'], env: { API_KEY: secret }, type: 'stdio'
    }), 1, 1
  )
  database.prepare('INSERT INTO prompts VALUES (?, ?, ?, ?, ?, ?)').run(
    'prompt-safe-e2e', 'codex', 'Safe Prompt E2E', 'Safe prompt body from CC Switch.', 'Safe reusable prompt', 1
  )
  database.prepare('INSERT INTO prompts VALUES (?, ?, ?, ?, ?, ?)').run(
    'prompt-secret-e2e', 'claude', 'Secret Prompt E2E', `API_KEY=${secret}`, 'Must remain blocked', 1
  )
  database.prepare('INSERT INTO skills VALUES (?, ?, ?, ?, ?, ?)').run(
    'skill-e2e', 'Fixture Skill E2E', path.relative(sourceRoot, skillDirectory), 1, 1, null
  )
  database.prepare('INSERT INTO providers VALUES (?, ?, ?)').run('provider-e2e', 'codex', 'Fixture Provider E2E')
  database.prepare('INSERT INTO usage_daily_rollups VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    '2026-08-09', 'codex', 'provider-e2e', 'fixture-model', 'fixture-model', 'fixture-model',
    4, 3, 160, 50, 20, 8, '0.002', 320, 1
  )
  database.close()
}
