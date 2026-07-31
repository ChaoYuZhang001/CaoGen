#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const required = process.argv.includes('--required')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'p2-release-scope')
const reportDir = path.join(reportRoot, runId)
const startGit = gitState()

const checks = [
  {
    name: 'p2_default_smoke',
    command: [npmCommand(), 'run', 'test:p2'],
    timeoutMs: timeoutMs('P2_DEFAULT', 180_000)
  },
  {
    name: 'ide_build_and_vscode_required',
    command: [npmCommand(), 'run', 'test:p2-ide-build-and-vscode:required'],
    timeoutMs: timeoutMs('IDE_BUILD_AND_VSCODE', 180_000)
  },
  {
    name: 'jetbrains_recorder_e2e_required',
    command: [npmCommand(), 'run', 'test:jetbrains-recorder-e2e:required'],
    timeoutMs: timeoutMs('JETBRAINS_RECORDER_E2E', 360_000)
  },
  {
    name: 'jetbrains_ide_interaction_required',
    command: [npmCommand(), 'run', 'test:jetbrains-ide-interaction:required'],
    timeoutMs: timeoutMs('JETBRAINS_IDE_INTERACTION', 60_000)
  }
]

const results = checks.map(runCheck)
const byName = Object.fromEntries(results.map((result) => [result.name, result]))
const sourceReports = {
  idePlugins: readReport('test-results/ide-plugins/latest.json'),
  vscodeExtensionHost: readReport('test-results/vscode-extension-host/latest.json'),
  jetbrainsRecorder: readReport('test-results/jetbrains-recorder-e2e/latest.json'),
  jetbrainsInteraction: readReport('test-results/jetbrains-ide-interaction/latest.json')
}
const endGit = gitState()
const gitEvidence = {
  commit: startGit.commit,
  worktreeClean: startGit.worktreeClean,
  unchanged:
    startGit.commit === endGit.commit &&
    startGit.worktreeClean &&
    endGit.worktreeClean,
  start: startGit,
  end: endGit
}

const requirements = [
  requirement(
    'P2-002',
    'Skill learning, review, optimization, and invocation',
    passed(byName.p2_default_smoke) && hasMarkers(byName.p2_default_smoke, [
      'skillLearner smoke ok',
      'autoSkillReview smoke ok',
      'skillOptimizer smoke ok',
      'skillInvocation smoke ok'
    ])
  ),
  requirement(
    'P2-003',
    'Model routing, optimization, and cross validation',
    passed(byName.p2_default_smoke) && hasMarkers(byName.p2_default_smoke, [
      'model-router smoke ok',
      'modelOptimization smoke ok',
      'modelCrossValidation smoke ok'
    ])
  ),
  requirement(
    'P2-005',
    'IDE integrations: VS Code host workflow and JetBrains real IDE interaction',
    passed(byName.ide_build_and_vscode_required) &&
      passed(byName.jetbrains_recorder_e2e_required) &&
      passed(byName.jetbrains_ide_interaction_required) &&
      sourceReports.idePlugins.status === 'completed' &&
      sourceReports.vscodeExtensionHost.status === 'passed' &&
      sourceReports.jetbrainsRecorder.status === 'passed' &&
      sourceReports.jetbrainsInteraction.status === 'passed'
  )
]

const failures = [
  ...results.filter((result) => result.status !== 'pass').map((result) => result.name),
  ...requirements.filter((item) => item.status !== 'proved').map((item) => item.id),
  ...(!gitEvidence.unchanged ? ['git_state_changed'] : [])
]
const report = {
  status: failures.length === 0 ? 'passed' : 'failed',
  required,
  runId,
  reportDir,
  packageVersion: readJson(path.join(repoRoot, 'package.json'))?.version,
  releaseRequired: ['P2-002', 'P2-003', 'P2-005'],
  git: gitEvidence,
  requirements,
  results,
  sourceReports,
  failures: [...new Set(failures)]
}

mkdirSync(reportDir, { recursive: true })
const json = `${JSON.stringify(report, null, 2)}\n`
writeFileSync(path.join(reportDir, 'report.json'), json, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), json, 'utf8')
console.log(JSON.stringify(report, null, 2))
if (required && report.status !== 'passed') process.exitCode = 1

function runCheck(check) {
  const started = Date.now()
  const result = spawnSync(check.command[0], check.command.slice(1), {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: check.timeoutMs,
    windowsHide: true
  })
  return {
    name: check.name,
    status: result.status === 0 ? 'pass' : 'fail',
    command: check.command.join(' '),
    timeoutMs: check.timeoutMs,
    durationMs: Date.now() - started,
    timedOut: result.error?.code === 'ETIMEDOUT',
    exitCode: result.status,
    signal: result.signal,
    error: result.error ? String(result.error.message || result.error) : undefined,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr)
  }
}

function requirement(id, title, proved) {
  return { id, title, status: proved ? 'proved' : 'missing_evidence' }
}

function passed(result) {
  return result?.status === 'pass'
}

function hasMarkers(result, markers) {
  const output = `${result?.stdoutTail || ''}\n${result?.stderrTail || ''}`
  return markers.every((marker) => output.includes(marker))
}

function readReport(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath)
  if (!existsSync(absolutePath)) return { path: relativePath, exists: false, status: 'missing' }
  try {
    const data = readJson(absolutePath)
    return {
      path: relativePath,
      exists: true,
      status: typeof data?.status === 'string' ? data.status : 'unknown',
      runId: typeof data?.runId === 'string' ? data.runId : undefined,
      failures: Array.isArray(data?.failures) ? data.failures : undefined
    }
  } catch (error) {
    return {
      path: relativePath,
      exists: true,
      status: 'unreadable',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function gitState() {
  const commit = git(['rev-parse', 'HEAD'])
  const status = git(['status', '--porcelain=v1', '--untracked-files=all'])
  const entries = status ? status.split(/\r?\n/).filter(Boolean) : []
  return {
    commit,
    worktreeClean: entries.length === 0,
    statusEntryCount: entries.length
  }
}

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch {
    return ''
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function tail(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length > 12_000 ? text.slice(-12_000) : text || undefined
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function timeoutMs(name, fallback) {
  const value = Number(process.env[`CAOGEN_P2_RELEASE_${name}_TIMEOUT_MS`])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}
