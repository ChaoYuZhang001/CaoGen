#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const required = process.env.CAOGEN_VSCODE_EXTENSION_HOST_REQUIRED === '1' || process.argv.includes('--required')

if (!required) {
  console.log('SKIP set CAOGEN_VSCODE_EXTENSION_HOST_REQUIRED=1 to run the VS Code Extension Host smoke')
  process.exit(0)
}

const codeCommand = resolveCodeCommand(process.env.CAOGEN_VSCODE_CMD || 'code.cmd')
const pluginDir = path.join(repoRoot, 'plugins', 'vscode')
const testPath = path.join(pluginDir, 'out', 'test')
const require = createRequire(import.meta.url)
const { runTests } = require(path.join(pluginDir, 'node_modules', '@vscode', 'test-electron'))
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'vscode-extension-host', runId)
const lockDir = path.join(repoRoot, 'test-results', 'vscode-extension-host', '.lock')
const runRoot = mkdtempSync(path.join(tmpdir(), 'caogen-vscode-extension-host-'))
const workspaceDir = path.join(runRoot, 'workspace')
const userDataDir = path.join(runRoot, 'user-data')
const extensionsDir = path.join(runRoot, 'extensions')
const markerPath = path.join(runRoot, 'extension-host-marker.json')

mkdirSync(reportDir, { recursive: true })
mkdirSync(workspaceDir, { recursive: true })
writeFileSync(path.join(workspaceDir, 'sample.ts'), 'export const caogen = true\n', 'utf8')
const releaseRunLock = acquireRunLock(lockDir)

if (!existsSync(testPath)) {
  console.error(`FAIL VS Code Extension Host smoke: compiled test is missing: ${testPath}`)
  process.exit(1)
}

const launchArgs = [
  workspaceDir,
  '--user-data-dir',
  userDataDir,
  '--extensions-dir',
  extensionsDir,
  '--disable-gpu',
  '--disable-workspace-trust',
  '--skip-welcome'
]

let statusCode
let runError
try {
  closeExtensionDevelopmentHosts()
  const runPromise = runTests({
    vscodeExecutablePath: codeCommand,
    extensionDevelopmentPath: pluginDir,
    extensionTestsPath: testPath,
    extensionTestsEnv: {
      CAOGEN_VSCODE_EXTENSION_HOST_MARKER: markerPath
    },
    launchArgs
  })
    .then((code) => {
      statusCode = code
      return { type: 'runComplete' }
    })
    .catch((error) => {
      runError = error instanceof Error ? error.message : String(error)
      return { type: 'runComplete' }
    })
  const outcome = await withTimeout(
    Promise.race([
      waitForMarkerFile(markerPath).then(() => ({ type: 'marker' })),
      runPromise
    ]),
    120_000
  )
  if (outcome?.type === 'runComplete' && !existsSync(markerPath)) {
    throw new Error(runError ?? `VS Code Extension Host exited before writing smoke marker; statusCode=${statusCode ?? 'unknown'}`)
  }
  closeExtensionDevelopmentHosts()
  await Promise.race([runPromise, sleep(10_000)])
} catch (error) {
  runError = error instanceof Error ? error.message : String(error)
  closeExtensionDevelopmentHosts()
} finally {
  releaseRunLock()
}

const marker = readMarker(markerPath)
const requiredMarkerChecks = [
  'sidebarChecked',
  'selectedCodeModificationChecked',
  'oneClickDiffMergeChecked',
  'realtimeSyncChecked',
  'openDesktopChecked',
  'sessionWorkflowChecked'
]
const markerFailures = requiredMarkerChecks.filter((key) => marker?.[key] !== true)
const markerPassed = marker?.ok === true && marker.bridgeChecked === true && markerFailures.length === 0
const normalizedError = markerPassed && runError?.includes('4294967295') ? undefined : runError
const report = {
  status: markerPassed ? 'passed' : 'failed',
  required,
  reportDir,
  codeCommand,
  launchArgs,
  statusCode,
  error: normalizedError,
  runnerExitNote: markerPassed && runError ? 'VS Code was closed after the extension-host marker was written.' : undefined,
  markerFailures,
  marker
}
writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
writeFileSync(path.join(repoRoot, 'test-results', 'vscode-extension-host', 'latest.json'), JSON.stringify(report, null, 2), 'utf8')

if (report.status === 'passed') {
  console.log('PASS VS Code Extension Host smoke loaded CaoGen extension, executed command checks, and completed mock bridge session workflow')
} else {
  console.error(`FAIL VS Code Extension Host smoke: report written to ${path.join(reportDir, 'report.json')}`)
  process.exitCode = 1
}

process.exit(report.status === 'passed' ? 0 : 1)

function readMarker(file) {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function resolveCodeCommand(command) {
  const trimmed = command.trim()
  if (process.platform !== 'win32') return trimmed
  if (/code\.cmd$/i.test(trimmed)) {
    const candidate = codeExeFromCmd(trimmed)
    if (candidate) return candidate
  }
  return trimmed
}

function codeExeFromCmd(command) {
  const cmdPath = findCommandPath(command)
  if (!cmdPath) return undefined
  const candidate = path.resolve(path.dirname(cmdPath), '..', 'Code.exe')
  return existsSync(candidate) ? candidate : undefined
}

function findCommandPath(command) {
  if (path.isAbsolute(command) && existsSync(command)) return command
  const probe = spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true })
  if (probe.status !== 0 || !probe.stdout) return undefined
  return probe.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && existsSync(line))
}

function withTimeout(promise, timeoutMs) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`VS Code Extension Host smoke timed out after ${timeoutMs}ms`)), timeoutMs)
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function waitForMarkerFile(file) {
  while (!existsSync(file)) await sleep(250)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function closeExtensionDevelopmentHosts() {
  if (process.platform !== 'win32') return
  spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      "Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '[[]Extension Development Host[]]*' } | ForEach-Object { Stop-Process -Id $_.Id -Force }"
    ],
    { windowsHide: true, stdio: 'ignore' }
  )
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
  throw new Error('another VS Code Extension Host smoke run is still active')
}

function isStaleLock(targetDir) {
  try {
    return Date.now() - statSync(targetDir).mtimeMs > 10 * 60 * 1000
  } catch {
    return true
  }
}
