#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
if (!existsSync(path.join(repoRoot, 'out', 'main', 'index.js'))) {
  throw new Error('Built Electron main entry not found. Run npm run build first.')
}

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-native-import-e2e-'))
const userDataDir = path.join(tempRoot, 'userData')
const codexHome = path.join(tempRoot, 'codexHome')
const statePath = path.join(tempRoot, 'state.json')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'provider-native-import-e2e', runId)
const runner = path.join(repoRoot, 'scripts', 'provider-native-import-runner.cjs')
const electron = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const secret = ['native', 'electron', 'secret', 'canary'].join('-')

try {
  mkdirSync(codexHome, { recursive: true })
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(path.join(codexHome, 'config.toml'), [
    'model_provider = "gateway"',
    'model = "gpt-native-e2e"',
    'model_reasoning_effort = "high"',
    'model_verbosity = "low"',
    'disable_response_storage = true',
    '',
    '[model_providers.gateway]',
    'name = "Codex Native E2E"',
    'base_url = "https://native-e2e.invalid/v1"',
    'wire_api = "responses"',
    `experimental_bearer_token = ${JSON.stringify(secret)}`,
    '',
    '[features]',
    'multi_agent = true',
    ''
  ].join('\n'), 'utf8')
  writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: secret }), 'utf8')
  execFileSync(electron, [runner], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CAOGEN_PROVIDER_NATIVE_USER_DATA: userDataDir,
      CAOGEN_PROVIDER_NATIVE_STATE: statePath,
      CAOGEN_PROVIDER_NATIVE_SCREENSHOT_DIR: reportDir,
      CAOGEN_PROVIDER_NATIVE_SECRET: secret
    }
  })
  const report = JSON.parse(readFileSync(statePath, 'utf8'))
  if (!report.ok || report.pass !== report.total || report.total < 14) {
    throw new Error(`provider native import E2E incomplete: ${JSON.stringify({ pass: report.pass, total: report.total })}`)
  }
  if (JSON.stringify(report).includes(secret)) throw new Error('provider native import E2E report contains secret material')
  console.log(`provider native import E2E ok: ${reportDir}`)
  console.log(`${report.pass}/${report.total} checks passed`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
