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

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-pricing-e2e-'))
const userDataDir = path.join(tempRoot, 'userData')
const statePath = path.join(tempRoot, 'state.json')
const runner = path.join(repoRoot, 'scripts', 'provider-profile-electron-runner.cjs')
const electron = require('electron')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'provider-pricing-catalog-e2e', runId)

try {
  mkdirSync(reportDir, { recursive: true })
  execFileSync(electron, [runner], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      CAOGEN_PROVIDER_PROFILE_PHASE: 'pricing',
      CAOGEN_PROVIDER_PROFILE_USER_DATA: userDataDir,
      CAOGEN_PROVIDER_PROFILE_STATE: statePath,
      CAOGEN_PROVIDER_PROFILE_IMPORT: path.join(tempRoot, 'unused-import.json'),
      CAOGEN_PROVIDER_PROFILE_EXPORT: path.join(tempRoot, 'unused-export.json'),
      CAOGEN_PROVIDER_PROFILE_SCREENSHOT_DIR: reportDir
    }
  })
  const report = JSON.parse(readFileSync(statePath, 'utf8'))
  if (!report.ok || report.pass !== report.total || report.total < 11) {
    throw new Error(`provider pricing catalog E2E incomplete: ${JSON.stringify({ pass: report.pass, total: report.total })}`)
  }
  console.log(`provider pricing catalog E2E ok: ${reportDir}`)
  console.log(`${report.pass}/${report.total} checks passed`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
