#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { verifyBuildEvidence } from './lib/build-evidence.mjs'
import { bindSourceEvidence, readSourceEvidenceState } from './lib/source-evidence-binding.mjs'

const repoRoot = process.cwd()
const sourceEvidenceAtStart = readSourceEvidenceState(repoRoot)
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')
const runner = path.join(repoRoot, 'scripts', 'provider-profile-electron-runner.cjs')
const electron = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'provider-profile-e2e', runId)
// Provider Profile's UI phase includes multiple renderer reloads, catalog calls,
// sync panels and credential transitions. Keep the timeout bounded but allow
// the real Electron phase enough time on a loaded development machine.
let phaseTimeoutMs = 180_000
const phaseResults = []
let evidenceReport = {
  schemaVersion: 1,
  runId,
  gate: 'test:provider-profile:e2e',
  status: 'failed',
  failures: [],
  warnings: []
}
let runError
let tempRoot
let userDataDir
let statePath
let importPath
let exportPath

try {
  mkdirSync(reportDir, { recursive: true })
  evidenceReport.buildEvidence = verifyBuildEvidence(repoRoot, sourceEvidenceAtStart)
  if (evidenceReport.buildEvidence.status !== 'pass') {
    throw new Error(`Provider Profile build evidence failed: ${evidenceReport.buildEvidence.errors.join('; ')}`)
  }
  if (!existsSync(mainEntry)) throw new Error('Built Electron main entry not found. Run npm run build first.')
  phaseTimeoutMs = positiveInteger(process.env.CAOGEN_PROVIDER_PROFILE_PHASE_TIMEOUT_MS, 180_000)
  tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-profile-e2e-'))
  userDataDir = path.join(tempRoot, 'userData')
  statePath = path.join(tempRoot, 'state.json')
  importPath = path.join(tempRoot, 'import.json')
  exportPath = path.join(tempRoot, 'export.json')
  for (const phase of ['apply', 'rollback', 'ui']) {
    runPhase(phase)
  }
  const runnerReport = JSON.parse(readFileSync(statePath, 'utf8'))
  if (!runnerReport.ok || runnerReport.pass !== runnerReport.total || runnerReport.total < 44) {
    throw new Error(`provider profile E2E incomplete: ${JSON.stringify({ pass: runnerReport.pass, total: runnerReport.total })}`)
  }
  evidenceReport = {
    ...runnerReport,
    schemaVersion: 1,
    runId,
    gate: 'test:provider-profile:e2e',
    status: 'passed',
    buildEvidence: evidenceReport.buildEvidence,
    failures: [],
    warnings: []
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  runError = error
  process.exitCode = 1
  evidenceReport.status = 'failed'
  evidenceReport.phaseTimeoutMs = phaseTimeoutMs
  evidenceReport.phaseResults = phaseResults
  evidenceReport.failures.push({ phase: phaseResults.at(-1)?.phase ?? 'setup', message })
} finally {
  const provenance = bindSourceEvidence(
    evidenceReport,
    sourceEvidenceAtStart,
    readSourceEvidenceState(repoRoot),
    'Provider Profile Electron'
  )
  if (provenance.status !== 'pass') {
    evidenceReport.status = 'failed'
    process.exitCode = 1
  }
  const output = `${JSON.stringify(evidenceReport, null, 2)}\n`
  writeFileSync(path.join(reportDir, 'report.json'), output)
  writeFileSync(path.join(repoRoot, 'test-results', 'provider-profile-e2e', 'latest.json'), output)
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
}

if (runError) throw runError
if (evidenceReport.status !== 'passed') throw new Error(evidenceReport.error || 'Provider Profile evidence provenance failed')
console.log(`provider profile E2E ok: ${reportDir}`)
console.log(`${evidenceReport.pass}/${evidenceReport.total} checks passed`)

function runPhase(phase) {
  console.log(`[PHASE] ${phase} (timeout ${phaseTimeoutMs}ms)`)
  phaseResults.push({ phase, status: 'running' })
  try {
    execFileSync(electron, [runner], {
      cwd: repoRoot,
      stdio: 'inherit',
      timeout: phaseTimeoutMs,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        CAOGEN_PROVIDER_PROFILE_PHASE: phase,
        CAOGEN_PROVIDER_PROFILE_USER_DATA: userDataDir,
        CAOGEN_PROVIDER_PROFILE_STATE: statePath,
        CAOGEN_PROVIDER_PROFILE_IMPORT: importPath,
        CAOGEN_PROVIDER_PROFILE_EXPORT: exportPath,
        CAOGEN_PROVIDER_PROFILE_SCREENSHOT_DIR: reportDir
      }
    })
    phaseResults[phaseResults.length - 1].status = 'passed'
  } catch (error) {
    phaseResults[phaseResults.length - 1].status = error?.code === 'ETIMEDOUT' ? 'timed_out' : 'failed'
    throw new Error(`Provider Profile phase ${phase} ${phaseResults.at(-1).status}`)
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('phase timeout must be a positive integer')
  return parsed
}
