#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'p2-required', runId)
const evidenceDir = path.join(reportDir, 'evidence')
const lockDir = path.join(repoRoot, 'test-results', 'p2-required', '.lock')
const externalConfigurationGuide = 'docs/P2-EXTERNAL-REQUIRED.md'
mkdirSync(path.dirname(lockDir), { recursive: true })
const releaseRunLock = acquireRunLock(lockDir)
mkdirSync(reportDir, { recursive: true })
mkdirSync(evidenceDir, { recursive: true })
let activeCheckName = undefined

const checks = [
  {
    name: 'p2_default_smoke',
    command: [npmCommand(), 'run', 'test:p2'],
    timeoutMs: checkTimeoutMs('p2_default_smoke', 180_000),
    evidence: []
  },
  {
    name: 'gui_desktop_e2e_required',
    command: [npmCommand(), 'run', 'test:gui-desktop-e2e:required'],
    timeoutMs: checkTimeoutMs('gui_desktop_e2e_required', 300_000),
    evidence: [
      'test-results/gui-input-preflight/latest.json',
      'test-results/gui-vscode-e2e/latest.json',
      'test-results/gui-cross-app-e2e/latest.json'
    ]
  },
  {
    name: 'gui_permission_required',
    command: [npmCommand(), 'run', 'test:gui-permission', '--', '--required'],
    timeoutMs: checkTimeoutMs('gui_permission_required', 60_000),
    evidence: ['test-results/gui-permission/latest.json']
  },
  {
    name: 'ide_build_and_vscode_required',
    command: [npmCommand(), 'run', 'test:p2-ide-build-and-vscode:required'],
    timeoutMs: checkTimeoutMs('ide_build_and_vscode_required', 150_000),
    evidence: [
      'test-results/ide-plugins/latest.json',
      'test-results/vscode-extension-host/latest.json'
    ]
  },
  {
    name: 'jetbrains_ide_interaction_required',
    command: [npmCommand(), 'run', 'test:jetbrains-ide-interaction:required'],
    timeoutMs: checkTimeoutMs('jetbrains_ide_interaction_required', 60_000),
    evidence: ['test-results/jetbrains-ide-interaction/latest.json']
  },
  {
    name: 'china_real_network_required',
    command: [npmCommand(), 'run', 'test:china-real-network:required'],
    timeoutMs: checkTimeoutMs('china_real_network_required', 60_000),
    evidence: ['test-results/china-real-network/latest.json']
  },
  {
    name: 'china_tool_call_parity_required',
    command: [npmCommand(), 'run', 'test:china-tool-call-parity:required'],
    timeoutMs: checkTimeoutMs('china_tool_call_parity_required', 60_000),
    evidence: ['test-results/china-tool-call-parity/latest.json']
  }
]

const results = []
try {
  writeReport(buildReport(results, false))
  for (const check of checks) {
    activeCheckName = check.name
    writeReport(buildReport(results, false))
    const started = Date.now()
    const result = spawnSync(check.command[0], check.command.slice(1), {
      cwd: repoRoot,
      shell: process.platform === 'win32',
      encoding: 'utf8',
      env: process.env,
      timeout: check.timeoutMs
    })
    results.push({
      name: check.name,
      status: result.status === 0 ? 'pass' : 'fail',
      durationMs: Date.now() - started,
      command: check.command.join(' '),
      timeoutMs: check.timeoutMs,
      timedOut: result.error?.code === 'ETIMEDOUT',
      error: result.error ? String(result.error.message || result.error) : undefined,
      exitCode: result.status,
      signal: result.signal,
      stdoutTail: tail(result.stdout),
      stderrTail: tail(result.stderr),
      evidence: check.evidence.map(readEvidence)
    })
    activeCheckName = undefined
    writeReport(buildReport(results, false))
  }

  const report = buildReport(results, true)
  writeReport(report)
  console.log(JSON.stringify(report, null, 2))
  if (report.failures.length > 0) process.exitCode = 1
} finally {
  releaseRunLock()
}

function readEvidence(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath)
  if (!existsSync(absolutePath)) return { path: relativePath, status: 'missing' }
  const snapshotPath = snapshotEvidence(relativePath, absolutePath)
  try {
    const parsed = JSON.parse(readFileSync(absolutePath, 'utf8'))
    return { path: relativePath, status: 'present', snapshotPath, summary: summarizeEvidence(parsed) }
  } catch (error) {
    return {
      path: relativePath,
      status: 'unreadable',
      snapshotPath,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function snapshotEvidence(relativePath, absolutePath) {
  const snapshotName = relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('__')
  const destination = path.join(evidenceDir, snapshotName)
  copyFileSync(absolutePath, destination)
  return path.relative(repoRoot, destination)
}

function summarizeEvidence(value) {
  if (!isRecord(value)) return value
  return {
    status: stringField(value, 'status'),
    required: value.required === true,
    reason: stringField(value, 'reason'),
    configurationGuide: stringField(value, 'configurationGuide'),
    requiredEnvironment: Array.isArray(value.requiredEnvironment) ? value.requiredEnvironment : undefined,
    failures: Array.isArray(value.failures) ? value.failures : undefined,
    parityFailures: Array.isArray(value.parityFailures) ? value.parityFailures : undefined,
    missingConfiguration: Array.isArray(value.missingConfiguration) ? value.missingConfiguration : undefined,
    filePath: stringField(value, 'filePath'),
    markerPath: stringField(value, 'markerPath'),
    notePath: stringField(value, 'notePath'),
    codePath: stringField(value, 'codePath'),
    reportDir: stringField(value, 'reportDir'),
    sourceChars: numberField(value, 'sourceChars'),
    markerChars: numberField(value, 'markerChars'),
    nativeStrictCreateMode: value.nativeStrictCreateMode === true,
    terminalCommandE2E: value.terminalCommandE2E === true,
    strictEditorInputE2E: value.strictEditorInputE2E === true,
    markerExecutionMode: stringField(value, 'markerExecutionMode'),
    prototypeOnlyLimitations: Array.isArray(value.prototypeOnlyLimitations) ? value.prototypeOnlyLimitations : undefined,
    noteChars: numberField(value, 'noteChars'),
    codeChars: numberField(value, 'codeChars'),
    marker: isRecord(value.marker) ? value.marker : undefined,
    preflight: isRecord(value.preflight) ? value.preflight : undefined,
    evidence: summarizeNestedEvidence(value.evidence),
    results: summarizeResults(value.results)
  }
}

function summarizeNestedEvidence(value) {
  if (!isRecord(value)) return undefined
  return {
    ideName: stringField(value, 'ideName'),
    ideVersion: stringField(value, 'ideVersion'),
    pluginVersion: stringField(value, 'pluginVersion'),
    workspace: stringField(value, 'workspace'),
    ideExecutable: stringField(value, 'ideExecutable'),
    steps: isRecord(value.steps) ? value.steps : undefined,
    bridgeEvents: isRecord(value.bridgeEvents) ? value.bridgeEvents : undefined,
    actionCounts: isRecord(value.actionCounts) ? value.actionCounts : undefined,
    artifacts: Array.isArray(value.artifacts) ? value.artifacts : undefined
  }
}

function summarizeResults(value) {
  if (!Array.isArray(value)) return undefined
  return value.map((item) => {
    if (!isRecord(item)) return item
    return {
      name: stringField(item, 'name'),
      status: stringField(item, 'status'),
      tasks: Array.isArray(item.tasks) ? item.tasks : undefined,
      ok: item.ok === true
    }
  })
}

function writeReport(report) {
  const json = JSON.stringify(report, null, 2)
  atomicWrite(path.join(reportDir, 'report.json'), json)
  if (report.completed === true) {
    atomicWrite(path.join(repoRoot, 'test-results', 'p2-required', 'latest.json'), json)
    atomicWrite(path.join(repoRoot, 'test-results', 'p2-required', 'latest-completed.json'), json)
  } else {
    atomicWrite(path.join(repoRoot, 'test-results', 'p2-required', 'latest-running.json'), json)
  }
}

function atomicWrite(filePath, content) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(tmp, content, 'utf8')
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        rmSync(filePath, { force: true })
        renameSync(tmp, filePath)
        return
      } catch (error) {
        if (!isRetryableFileReplaceError(error) || attempt === 7) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
      }
    }
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // ignore temp cleanup failure
    }
    throw error
  }
}

function isRetryableFileReplaceError(error) {
  return isRecord(error) && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY')
}

function buildReport(currentResults, completed) {
  const failures = currentResults
    .filter((item) => item.status !== 'pass')
    .map((item) => item.name)
  const activeCheck = !completed && activeCheckName
    ? checks.find((check) => check.name === activeCheckName)
    : undefined
  return {
    status: completed && failures.length === 0 ? 'passed' : completed ? 'failed' : 'running',
    reportDir,
    runId,
    completed,
    activeCheck: activeCheck
      ? {
          name: activeCheck.name,
          command: activeCheck.command.join(' '),
          timeoutMs: activeCheck.timeoutMs,
          evidence: activeCheck.evidence.map((relativePath) => ({
            path: relativePath,
            status: existsSync(path.join(repoRoot, relativePath)) ? 'present' : 'missing'
          }))
        }
      : undefined,
    failures,
    configurationGuide: externalConfigurationGuide,
    externalConfigurationFailures: failures.filter(isExternalConfigurationFailure),
    externalConfigurationGuidance: externalConfigurationGuidance(failures),
    environmentConfigurationFailures: failures.filter(isEnvironmentConfigurationFailure),
    results: currentResults
  }
}

function acquireRunLock(targetDir) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try {
      mkdirSync(targetDir, { recursive: false })
      writeFileSync(path.join(targetDir, 'owner.txt'), `${process.pid}\n${new Date().toISOString()}\n`, 'utf8')
      return () => rmSync(targetDir, { recursive: true, force: true })
    } catch {
      if (isStaleLock(targetDir)) {
        rmSync(targetDir, { recursive: true, force: true })
        continue
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
  }
  throw new Error('another P2 required gate run is still active')
}

function isStaleLock(targetDir) {
  try {
    return Date.now() - statSync(targetDir).mtimeMs > 15 * 60 * 1000
  } catch {
    return true
  }
}

function stringField(record, key) {
  return typeof record[key] === 'string' ? record[key] : undefined
}

function numberField(record, key) {
  return typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] : undefined
}

function isRecord(value) {
  return typeof value === 'object' && value !== null
}

function tail(text) {
  if (!text) return undefined
  const trimmed = text.trim()
  return trimmed.length > 4000 ? trimmed.slice(-4000) : trimmed
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function checkTimeoutMs(checkName, fallback) {
  const specific = positiveInteger(process.env[`CAOGEN_P2_REQUIRED_${checkName.toUpperCase()}_TIMEOUT_MS`])
  if (specific) return specific
  return positiveInteger(process.env.CAOGEN_P2_REQUIRED_CHECK_TIMEOUT_MS) ?? fallback
}

function positiveInteger(value) {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
}

function externalConfigurationGuidance(failures) {
  const failedChecks = failures.filter(isExternalConfigurationFailure)
  if (failedChecks.length === 0) return undefined
  return {
    guide: externalConfigurationGuide,
    failedChecks,
    commands: [
      'npm.cmd run test:china-real-network:required',
      'npm.cmd run test:china-tool-call-parity:required'
    ],
    note: 'External required checks need real credentials, real network, or real provider configuration; default smoke keeps local/mock/skip paths.'
  }
}

function isExternalConfigurationFailure(name) {
  return name === 'china_real_network_required' || name === 'china_tool_call_parity_required'
}

function isEnvironmentConfigurationFailure(name) {
  return (
    isExternalConfigurationFailure(name) ||
    name === 'jetbrains_ide_interaction_required' ||
    name === 'gui_desktop_e2e_required' ||
    name === 'gui_permission_required'
  )
}
