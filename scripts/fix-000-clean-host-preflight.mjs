#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const required = process.argv.includes('--required')
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
const reportRoot = path.join(repoRoot, 'test-results', 'fix-000-clean-host-preflight')
const reportDir = path.join(reportRoot, runId)
const baselinePath = path.join(repoRoot, 'docs', 'SPRINT-01-GATE-BASELINE.md')
const baseline = readFileSync(baselinePath, 'utf8')
const expected = parseDocumentedD0(baseline)
const artifactPath = path.resolve(repoRoot, argValue('--artifact') || expected?.path || '')
const checks = []

check('host platform is Windows', process.platform === 'win32', { actual: process.platform })
check('host architecture is x64', process.arch === 'x64', { actual: process.arch })
check('Sprint baseline declares an exact FIX-000 D0', expected !== undefined, expected || { status: 'missing_or_invalid' })

let artifact = null
if (expected && existsSync(artifactPath)) {
  const size = statSync(artifactPath).size
  const sha256 = createHash('sha256').update(readFileSync(artifactPath)).digest('hex')
  artifact = { size, sha256 }
  check('artifact size matches the Sprint baseline', size === expected.size, { expected: expected.size, actual: size })
  check('artifact SHA-256 matches the Sprint baseline', sha256 === expected.sha256, { expected: expected.sha256, actual: sha256 })
} else {
  check('artifact exists', false, { expectedPath: expected?.path || null })
}

let host = null
if (process.platform === 'win32') {
  try {
    host = inspectWindowsHost()
    check('interactive desktop is available', host.userInteractive && host.explorerProcessCount > 0, {
      userInteractive: host.userInteractive,
      explorerProcessCount: host.explorerProcessCount,
      sessionKind: host.sessionKind
    })
    check('no CaoGen process is running', host.caogenProcessCount === 0, { count: host.caogenProcessCount })
    check('no CaoGen uninstall registration exists', host.existingInstallations.length === 0, {
      count: host.existingInstallations.length,
      installations: host.existingInstallations
    })
  } catch (error) {
    check('Windows host inspection completed', false, { status: 'inspection_failed' })
  }
}

const failures = checks.filter((item) => item.status === 'failed')
const report = {
  status: failures.length === 0 ? 'passed' : 'failed',
  evidenceClass: 'clean_host_preflight',
  required,
  runId,
  reportDir: path.relative(repoRoot, reportDir),
  artifact: {
    expectedSize: expected?.size || null,
    actualSize: artifact?.size || null,
    expectedSha256: expected?.sha256 || null,
    actualSha256: artifact?.sha256 || null,
    artifactSetSha256: expected?.artifactSetSha256 || null
  },
  host: host
    ? {
        platform: process.platform,
        architecture: process.arch,
        userInteractive: host.userInteractive,
        explorerProcessCount: host.explorerProcessCount,
        sessionKind: host.sessionKind,
        caogenProcessCount: host.caogenProcessCount,
        existingInstallations: host.existingInstallations
      }
    : { platform: process.platform, architecture: process.arch },
  checks,
  failureCount: failures.length,
  redactionPolicy: 'The report emits no absolute/private artifact path, user identity, Provider data, project path, or credential value.'
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 2))
if (required && report.status !== 'passed') process.exitCode = 1

function inspectWindowsHost() {
  const script = `
$ErrorActionPreference = 'Stop'
$Locations = @(
  @{ Scope = 'current-user'; Path = 'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' },
  @{ Scope = 'all-users'; Path = 'Registry::HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' },
  @{ Scope = 'all-users-wow64'; Path = 'Registry::HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' }
)
$Installations = foreach ($Location in $Locations) {
  Get-ItemProperty -Path $Location.Path -ErrorAction SilentlyContinue |
    Where-Object { [string]$_.DisplayName -like 'CaoGen*' } |
    ForEach-Object {
      @{
        Scope = $Location.Scope
        RegistryKey = [string]$_.PSChildName
        DisplayName = [string]$_.DisplayName
        DisplayVersion = [string]$_.DisplayVersion
      }
    }
}
@{
  UserInteractive = [Environment]::UserInteractive
  ExplorerProcessCount = @(Get-Process -Name explorer -ErrorAction SilentlyContinue).Count
  SessionKind = if ([string]::IsNullOrWhiteSpace([string]$env:SESSIONNAME)) { 'unknown' } elseif ([string]$env:SESSIONNAME -like 'RDP-*') { 'remote-interactive' } else { 'local-interactive' }
  CaoGenProcessCount = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { [string]$_.ProcessName -like 'CaoGen*' }).Count
  ExistingInstallations = @($Installations)
} | ConvertTo-Json -Compress -Depth 5
`
  const result = spawnSync(powerShellExecutable(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024
  })
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || `PowerShell exit ${result.status}`).trim())
  const value = JSON.parse(String(result.stdout || '').trim())
  return {
    userInteractive: value.UserInteractive === true,
    explorerProcessCount: Number(value.ExplorerProcessCount || 0),
    sessionKind: typeof value.SessionKind === 'string' ? value.SessionKind : 'unknown',
    caogenProcessCount: Number(value.CaoGenProcessCount || 0),
    existingInstallations: Array.isArray(value.ExistingInstallations) ? value.ExistingInstallations.map((item) => ({
      scope: item.Scope,
      registryKey: item.RegistryKey,
      displayName: item.DisplayName,
      displayVersion: item.DisplayVersion
    })) : []
  }
}

function parseDocumentedD0(markdown) {
  const match = markdown.match(/The current FIX-000 D0 artifact is `([^`]+)`, size ([\d,]+) bytes, SHA-256 `([a-f0-9]{64})`, and artifact-set SHA-256 `([a-f0-9]{64})`\./)
  if (!match) return undefined
  return {
    path: match[1],
    size: Number(match[2].replaceAll(',', '')),
    sha256: match[3],
    artifactSetSha256: match[4]
  }
}

function check(name, passed, detail) {
  checks.push({ name, status: passed ? 'passed' : 'failed', ...(detail !== undefined ? { detail } : {}) })
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  const prefix = `${name}=`
  const inline = process.argv.find((item) => item.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : undefined
}

function powerShellExecutable() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}
