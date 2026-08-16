#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')
if (!existsSync(mainEntry)) throw new Error('Built Electron main entry not found. Run npm run build first.')

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-usage-dashboard-'))
const userDataDir = path.join(tempRoot, 'userData')
const statePath = path.join(tempRoot, 'state.json')
const runner = path.join(repoRoot, 'scripts', 'provider-usage-dashboard-runner.cjs')
const electron = require('electron')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'provider-usage-dashboard-e2e', runId)

try {
  mkdirSync(reportDir, { recursive: true })
  execFileSync(electron, [runner], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      CAOGEN_PROVIDER_USAGE_USER_DATA: userDataDir,
      CAOGEN_PROVIDER_USAGE_STATE: statePath,
      CAOGEN_PROVIDER_USAGE_SCREENSHOT_DIR: reportDir
    }
  })
  const report = JSON.parse(readFileSync(statePath, 'utf8'))
  if (!report.ok || report.pass !== report.total || report.total < 20) {
    throw new Error(`provider usage dashboard E2E incomplete: ${JSON.stringify({ pass: report.pass, total: report.total })}`)
  }
  console.log(`provider usage dashboard E2E ok: ${reportDir}`)
  console.log(`${report.pass}/${report.total} checks passed`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
