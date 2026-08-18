#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')
if (!existsSync(mainEntry)) throw new Error('Built Electron main entry not found. Run npm run build first.')

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-composer-attachments-e2e-'))
const statePath = path.join(tempRoot, 'state.json')
const runner = path.join(repoRoot, 'scripts', 'composer-attachments-runner.cjs')
const electron = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'composer-attachments-e2e', runId)

try {
  mkdirSync(reportDir, { recursive: true })
  execFileSync(electron, [runner], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      CAOGEN_COMPOSER_ATTACHMENTS_ROOT: tempRoot,
      CAOGEN_COMPOSER_ATTACHMENTS_STATE: statePath,
      CAOGEN_COMPOSER_ATTACHMENTS_SCREENSHOTS: reportDir
    }
  })
  const report = JSON.parse(readFileSync(statePath, 'utf8'))
  if (!report.ok || report.pass !== report.total || report.total < 20) {
    throw new Error(`composer attachments E2E incomplete: ${JSON.stringify({ pass: report.pass, total: report.total })}`)
  }
  console.log(`composer attachments E2E ok: ${reportDir}`)
  console.log(`${report.pass}/${report.total} checks passed`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
