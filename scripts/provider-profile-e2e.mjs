#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')
if (!existsSync(mainEntry)) throw new Error('Built Electron main entry not found. Run npm run build first.')

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-profile-e2e-'))
const userDataDir = path.join(tempRoot, 'userData')
const statePath = path.join(tempRoot, 'state.json')
const importPath = path.join(tempRoot, 'import.json')
const exportPath = path.join(tempRoot, 'export.json')
const runner = path.join(repoRoot, 'scripts', 'provider-profile-electron-runner.cjs')
const electron = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'provider-profile-e2e', runId)
const phaseTimeoutMs = positiveInteger(process.env.CAOGEN_PROVIDER_PROFILE_PHASE_TIMEOUT_MS, 120_000)
const phaseResults = []

try {
  mkdirSync(reportDir, { recursive: true })
  for (const phase of ['apply', 'rollback', 'ui']) {
    runPhase(phase)
  }
  const report = JSON.parse(readFileSync(statePath, 'utf8'))
  if (!report.ok || report.pass !== report.total || report.total < 44) {
    throw new Error(`provider profile E2E incomplete: ${JSON.stringify({ pass: report.pass, total: report.total })}`)
  }
  const evidenceReport = {
    ...report,
    schemaVersion: 1,
    runId,
    gate: 'test:provider-profile:e2e',
    status: 'passed',
    sourceRevision: gitOutput(['rev-parse', 'HEAD']),
    worktreeStatusCount: gitOutput([
      'status', '--porcelain=v1', '--untracked-files=all'
    ]).split('\n').filter(Boolean).length,
    failures: []
  }
  writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(evidenceReport, null, 2)}\n`)
  console.log(`provider profile E2E ok: ${reportDir}`)
  console.log(`${report.pass}/${report.total} checks passed`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify({
    schemaVersion: 1,
    runId,
    gate: 'test:provider-profile:e2e',
    status: 'failed',
    sourceRevision: gitOutput(['rev-parse', 'HEAD']),
    phaseTimeoutMs,
    phaseResults,
    failures: [{ phase: phaseResults.at(-1)?.phase ?? 'setup', message }]
  }, null, 2)}\n`)
  throw error
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

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

function gitOutput(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}

function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('phase timeout must be a positive integer')
  return parsed
}
