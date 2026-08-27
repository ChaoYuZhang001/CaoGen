#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { verifyBuildEvidence } from './lib/build-evidence.mjs'
import { bindSourceEvidence, readSourceEvidenceState } from './lib/source-evidence-binding.mjs'

const repoRoot = process.cwd()
const sourceEvidenceAtStart = readSourceEvidenceState(repoRoot)
const require = createRequire(path.join(repoRoot, 'package.json'))
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')
const runner = path.join(repoRoot, 'scripts', 'provider-usage-dashboard-runner.cjs')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'provider-usage-dashboard-e2e')
const reportDir = path.join(reportRoot, runId)
let tempRoot
let report = {
  schemaVersion: 1,
  runId,
  gate: 'test:provider-usage:e2e',
  status: 'failed',
  failures: [],
  warnings: []
}
let runError

try {
  mkdirSync(reportDir, { recursive: true })
  report.buildEvidence = verifyBuildEvidence(repoRoot, sourceEvidenceAtStart)
  if (report.buildEvidence.status !== 'pass') {
    throw new Error(`Provider Usage build evidence failed: ${report.buildEvidence.errors.join('; ')}`)
  }
  if (!existsSync(mainEntry)) throw new Error('Built Electron main entry not found. Run npm run build first.')
  tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-usage-dashboard-'))
  const userDataDir = path.join(tempRoot, 'userData')
  const statePath = path.join(tempRoot, 'state.json')
  const electron = require('electron')
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
  const runnerReport = JSON.parse(readFileSync(statePath, 'utf8'))
  if (!runnerReport.ok || runnerReport.pass !== runnerReport.total || runnerReport.total < 20) {
    throw new Error(`provider usage dashboard E2E incomplete: ${JSON.stringify({ pass: runnerReport.pass, total: runnerReport.total })}`)
  }
  report = {
    ...runnerReport,
    schemaVersion: 1,
    runId,
    gate: 'test:provider-usage:e2e',
    status: 'passed',
    buildEvidence: report.buildEvidence,
    failures: [],
    warnings: []
  }
} catch (error) {
  runError = error
  report.failures.push({ message: error instanceof Error ? error.stack || error.message : String(error) })
  process.exitCode = 1
} finally {
  const provenance = bindSourceEvidence(
    report,
    sourceEvidenceAtStart,
    readSourceEvidenceState(repoRoot),
    'Provider Usage Electron'
  )
  if (provenance.status !== 'pass') {
    report.status = 'failed'
    process.exitCode = 1
  }
  mkdirSync(reportDir, { recursive: true })
  const body = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(reportDir, 'report.json'), body, 'utf8')
  writeFileSync(path.join(reportRoot, 'latest.json'), body, 'utf8')
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
}

if (runError) throw runError
if (report.status !== 'passed') throw new Error(report.error || 'Provider Usage evidence provenance failed')
console.log(`provider usage dashboard E2E ok: ${reportDir}`)
console.log(`${report.pass}/${report.total} checks passed`)
