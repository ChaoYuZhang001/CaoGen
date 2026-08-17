#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')
if (!existsSync(mainEntry)) throw new Error('Built Electron main entry not found. Run npm run build first.')

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-project-test-panel-'))
const statePath = path.join(tempRoot, 'state.json')
const runner = path.join(repoRoot, 'scripts', 'project-test-panel-runner.cjs')
const electron = require('electron')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'project-test-panel-e2e', runId)

try {
  mkdirSync(reportDir, { recursive: true })
  execFileSync(electron, [runner], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      CAOGEN_PROJECT_TEST_PANEL_ROOT: tempRoot,
      CAOGEN_PROJECT_TEST_PANEL_STATE: statePath,
      CAOGEN_PROJECT_TEST_PANEL_SCREENSHOTS: reportDir
    }
  })
  const report = JSON.parse(readFileSync(statePath, 'utf8'))
  if (!report.ok || report.pass !== report.total || report.total < 10) {
    throw new Error(`project test panel E2E incomplete: ${JSON.stringify(report)}`)
  }
  console.log(`project test panel E2E ok: ${reportDir}`)
  console.log(`${report.pass}/${report.total} checks passed`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
