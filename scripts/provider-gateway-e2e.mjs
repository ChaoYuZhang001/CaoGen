#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')
if (!existsSync(mainEntry)) throw new Error('Built Electron main entry not found. Run npm.cmd run build first.')

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-gateway-'))
const statePath = path.join(tempRoot, 'state.json')
const restartStatePath = path.join(tempRoot, 'restart-state.json')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'provider-gateway-e2e', runId)
const screenshotPath = path.join(reportDir, 'provider-gateway-settings.png')

try {
  mkdirSync(reportDir, { recursive: true })
  execFileSync(path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe'), [
    path.join(repoRoot, 'scripts', 'provider-gateway-runner.cjs')
  ], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      CAOGEN_PROVIDER_GATEWAY_USER_DATA: path.join(tempRoot, 'userData'),
      CAOGEN_PROVIDER_GATEWAY_STATE: statePath,
      CAOGEN_PROVIDER_GATEWAY_SCREENSHOT: screenshotPath
    }
  })
  const report = JSON.parse(readFileSync(statePath, 'utf8'))
  if (!report.ok || report.pass !== report.total || report.total < 20 || !/^[a-f0-9]{64}$/.test(report.tokenDigest)) {
    throw new Error(`provider gateway E2E incomplete: ${JSON.stringify({ pass: report.pass, total: report.total })}`)
  }
  execFileSync(path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe'), [
    path.join(repoRoot, 'scripts', 'provider-gateway-restart-runner.cjs')
  ], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      CAOGEN_PROVIDER_GATEWAY_USER_DATA: path.join(tempRoot, 'userData'),
      CAOGEN_PROVIDER_GATEWAY_RESTART_STATE: restartStatePath,
      CAOGEN_PROVIDER_GATEWAY_TOKEN_DIGEST: report.tokenDigest
    }
  })
  const restart = JSON.parse(readFileSync(restartStatePath, 'utf8'))
  if (!restart.ok || restart.pass !== restart.total || restart.total < 5) {
    throw new Error(`provider gateway restart E2E incomplete: ${JSON.stringify({ pass: restart.pass, total: restart.total })}`)
  }
  console.log(`provider gateway E2E ok: ${reportDir}`)
  console.log(`${report.pass + restart.pass}/${report.total + restart.total} checks passed`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
