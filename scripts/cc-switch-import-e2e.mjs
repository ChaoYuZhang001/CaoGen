#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const repoRoot = process.cwd()
if (!existsSync(path.join(repoRoot, 'out', 'main', 'index.js'))) {
  throw new Error('Built Electron main entry not found. Run npm run build first.')
}

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-cc-switch-import-e2e-'))
const userDataDir = path.join(tempRoot, 'userData')
const sourceDir = path.join(tempRoot, 'cc-switch')
const statePath = path.join(tempRoot, 'state.json')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'cc-switch-import-e2e', runId)
const runner = path.join(repoRoot, 'scripts', 'cc-switch-import-runner.cjs')
const electron = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const secret = ['cc', 'switch', 'electron', 'secret', 'canary'].join('-')

try {
  mkdirSync(sourceDir, { recursive: true })
  mkdirSync(reportDir, { recursive: true })
  createFixture()
  execFileSync(electron, [runner], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      CAOGEN_CC_SWITCH_HOME: sourceDir,
      CAOGEN_CC_SWITCH_E2E_USER_DATA: userDataDir,
      CAOGEN_CC_SWITCH_E2E_STATE: statePath,
      CAOGEN_CC_SWITCH_E2E_SCREENSHOT_DIR: reportDir,
      CAOGEN_CC_SWITCH_E2E_SECRET: secret
    }
  })
  const report = JSON.parse(readFileSync(statePath, 'utf8'))
  if (!report.ok || report.pass !== report.total || report.total < 12) {
    throw new Error(`CC Switch import E2E incomplete: ${JSON.stringify({ pass: report.pass, total: report.total })}`)
  }
  if (JSON.stringify(report).includes(secret)) throw new Error('CC Switch import E2E report contains secret material')
  console.log(`CC Switch import E2E passed: ${report.pass}/${report.total}`)
  console.log(reportDir)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function createFixture() {
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
  `)
  const insert = database.prepare(`
    INSERT INTO providers (
      id, app_type, name, settings_config, notes, meta, sort_index,
      cost_multiplier, limit_daily_usd, limit_monthly_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  insert.run('codex-e2e', 'codex', 'CC Switch Codex E2E', JSON.stringify({
    auth: { OPENAI_API_KEY: secret },
    config: [
      'model_provider = "fixture"',
      'model = "cc-switch-model"',
      '[model_providers.fixture]',
      'name = "Fixture"',
      'base_url = "https://cc-switch-e2e.invalid/v1"',
      'wire_api = "responses"'
    ].join('\n')
  }), null, JSON.stringify({ apiFormat: 'openai_chat' }), 1, '1.5', '3', '20')
  insert.run('claude-e2e', 'claude', 'CC Switch Claude E2E', JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: 'https://cc-switch-anthropic-e2e.invalid',
      ANTHROPIC_AUTH_TOKEN: secret,
      ANTHROPIC_MODEL: 'claude-e2e'
    }
  }), null, JSON.stringify({ apiFormat: 'anthropic' }), 2, '1', null, null)
  database.prepare('INSERT INTO model_pricing VALUES (?, ?, ?, ?, ?, ?)')
    .run('cc-switch-model', 'CC Switch Model', '2', '8', '0.5', '2.5')
  database.close()
}
