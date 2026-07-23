#!/usr/bin/env node
import { spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const { readPackagedReleaseProvenanceFromAsar, releaseProvenanceChecks } = require('./lib/release-provenance.cjs')
const required = process.argv.includes('--required')
const configOnly = process.argv.includes('--config-only')
const targetArch = argValue('--arch') || 'x64'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'windows-release-audit')
const reportDir = path.join(reportRoot, runId)
const checks = []

const packageJson = readJson(path.join(repoRoot, 'package.json')) || {}
const packageLock = readJson(path.join(repoRoot, 'package-lock.json')) || {}
const version = typeof packageJson.version === 'string' ? packageJson.version : 'unknown'
const appDir = resolvePath(argValue('--app-dir') || 'dist/win-unpacked')
const appExecutable = resolvePath(argValue('--app') || path.join(appDir, 'CaoGen.exe'))
const installer = resolvePath(argValue('--installer') || `dist/CaoGen Setup ${version}.exe`)
const installerBlockmap = resolvePath(argValue('--blockmap') || `dist/CaoGen Setup ${version}.exe.blockmap`)
const updateMetadata = resolvePath(argValue('--metadata') || 'dist/latest.yml')
const asarPath = path.join(appDir, 'resources', 'app.asar')
const git = readGitState()
const config = inspectReleaseConfig()

let buildProvenance = null
let signing = {
  app: emptySignature(),
  installer: emptySignature()
}
let architectures = []
const artifactSet = inspectArtifactSet()

if (!configOnly) inspectArtifacts()

const failures = checks.filter((item) => item.status === 'failed')
const report = {
  status: failures.length === 0 ? 'passed' : 'failed',
  mode: configOnly ? 'config_only' : 'post_build',
  required,
  runId,
  reportDir,
  packageVersion: version,
  targetArch,
  platform: process.platform,
  git,
  artifactSetSha256: artifactSet.artifactSetSha256,
  artifactSet,
  config,
  artifacts: {
    appExecutable: reportPath(appExecutable),
    installer: reportPath(installer),
    installerBlockmap: reportPath(installerBlockmap),
    updateMetadata: reportPath(updateMetadata),
    architectures
  },
  signing,
  buildProvenance: { app: buildProvenance },
  summary: summarizeChecks(checks),
  checks,
  failures: failures.map((item) => `${item.scope}: ${item.name}`),
  redactionPolicy: 'Certificate contents, passwords, private keys, and credential environment values are never emitted.'
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
if (configOnly) {
  writeFileSync(path.join(reportRoot, 'latest-config.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
} else {
  writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(path.join(reportRoot, `latest-${targetArch}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}
console.log(JSON.stringify(report, null, 2))

if (required && report.status !== 'passed') process.exitCode = 1
if (!required && !configOnly && report.status !== 'passed') process.exitCode = 1

function inspectReleaseConfig() {
  const configPath = path.join(repoRoot, 'electron-builder.release.cjs')
  const result = {
    path: reportPath(configPath),
    present: existsSync(configPath),
    loaded: false,
    forceCodeSigning: false,
    nsisTarget: false,
    releaseProvenance: null
  }
  check('config', 'package version is stable semver', /^\d+\.\d+\.\d+$/.test(version))
  check(
    'config',
    'package and lock versions match',
    packageLock.version === version && packageLock.packages?.['']?.version === version
  )
  check('config', 'electron-builder.release.cjs exists', result.present)
  if (!result.present) return result
  try {
    delete require.cache[configPath]
    const releaseConfig = require(configPath)
    result.loaded = isRecord(releaseConfig)
    const win = isRecord(releaseConfig?.win) ? releaseConfig.win : {}
    result.forceCodeSigning = win.forceCodeSigning === true
    result.nsisTarget = hasTarget(win.target, 'nsis')
    result.releaseProvenance = releaseConfig.extraMetadata?.caogenReleaseProvenance || null
    check('config', 'electron-builder.release.cjs exports an object', result.loaded)
    check('config', 'Windows release requires code signing', result.forceCodeSigning)
    check('config', 'Windows release includes the NSIS target', result.nsisTarget)
    check('config', 'Windows release provenance schema is supported', result.releaseProvenance?.schemaVersion === 1)
    check('config', 'Windows release provenance commit is resolved', /^[0-9a-f]{40}$/i.test(result.releaseProvenance?.gitCommit || ''))
    check('config', 'Windows release provenance version matches package.json', result.releaseProvenance?.packageVersion === version)
    check('config', 'Windows release provenance clean state is explicit', typeof result.releaseProvenance?.worktreeClean === 'boolean')
  } catch (error) {
    check('config', 'electron-builder.release.cjs loads', false, errorMessage(error))
  }
  return result
}

function inspectArtifacts() {
  check('invocation', 'target architecture is x64', targetArch === 'x64')
  check('platform', 'post-build audit runs on Windows', process.platform === 'win32')
  check('platform', 'post-build audit runs natively on x64', process.arch === 'x64')
  check('git', 'release audit runs from a clean worktree', git.worktreeClean)
  check('app', 'unpacked application executable exists', isFile(appExecutable), reportPath(appExecutable))
  check('installer', 'NSIS installer exists', isFile(installer), reportPath(installer))
  check('installer', 'NSIS installer blockmap exists', isFile(installerBlockmap), reportPath(installerBlockmap))
  check('metadata', 'Windows update metadata exists', isFile(updateMetadata), reportPath(updateMetadata))
  check('artifact_set', 'all Windows uploadable assets exist', artifactSet.complete, artifactSet.missing.join(', '))
  if (isFile(updateMetadata)) {
    const metadata = readFileSync(updateMetadata, 'utf8')
    check('metadata', 'Windows update metadata matches package version', metadata.includes(`version: ${version}`))
  }

  if (isFile(appExecutable)) {
    architectures = inspectPeArchitectures(appExecutable)
    check('app', 'application executable is PE x64', architectures.length === 1 && architectures[0] === 'x64', architectures.join(', '))
  }

  const inspected = readPackagedReleaseProvenanceFromAsar(asarPath)
  buildProvenance = inspected.value
    ? { asarPath: reportPath(asarPath), ...inspected.value, error: null }
    : { asarPath: reportPath(asarPath), present: false, error: inspected.error }
  const provenance = releaseProvenanceChecks(inspected.value, {
    gitCommit: git.commit,
    packageVersion: version
  })
  check('app', 'release build provenance is readable', !inspected.error, inspected.error || undefined)
  for (const [name, passed] of Object.entries(provenance)) check('app', `release build provenance ${name}`, passed)

  if (process.platform === 'win32') {
    signing = {
      app: inspectAuthenticode(appExecutable),
      installer: inspectAuthenticode(installer)
    }
    check('app', 'application Authenticode signature is valid', signing.app.status === 'Valid', signing.app.failure)
    check('app', 'application Authenticode signature is timestamped', signing.app.timestamped === true)
    check('installer', 'installer Authenticode signature is valid', signing.installer.status === 'Valid', signing.installer.failure)
    check('installer', 'installer Authenticode signature is timestamped', signing.installer.timestamped === true)
  }
}

function inspectArtifactSet() {
  const files = [installer, installerBlockmap, updateMetadata]
  const missing = files.filter((file) => !isFile(file))
  const digests = Object.fromEntries(files.filter(isFile).map((file) => [reportPath(file), {
    size: statSync(file).size,
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex')
  }]))
  return {
    complete: missing.length === 0,
    missing: missing.map(reportPath),
    files: digests,
    artifactSetSha256: missing.length === 0
      ? createHash('sha256').update(JSON.stringify(digests)).digest('hex')
      : null
  }
}

function inspectAuthenticode(filePath) {
  if (!isFile(filePath)) return emptySignature('Missing')
  const script = `
$ErrorActionPreference = 'Stop'
$Signature = Get-AuthenticodeSignature -LiteralPath ${powerShellLiteral(filePath)}
@{
  Status = [string]$Signature.Status
  HasCertificate = $null -ne $Signature.SignerCertificate
  Timestamped = $null -ne $Signature.TimeStamperCertificate
} | ConvertTo-Json -Compress
`
  const result = spawnSync('powershell.exe', [
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
  if (result.status !== 0) {
    return {
      ...emptySignature('InspectionFailed'),
      failure: redact(result.stderr || result.stdout || `PowerShell exited ${result.status}`)
    }
  }
  try {
    const data = JSON.parse(String(result.stdout || '').trim())
    return {
      status: typeof data.Status === 'string' ? data.Status : 'Unknown',
      hasCertificate: data.HasCertificate === true,
      timestamped: data.Timestamped === true,
      failure: null
    }
  } catch (error) {
    return { ...emptySignature('InspectionFailed'), failure: errorMessage(error) }
  }
}

function inspectPeArchitectures(filePath) {
  try {
    const bytes = readFileSync(filePath)
    if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return []
    const peOffset = bytes.readUInt32LE(0x3c)
    if (peOffset + 6 > bytes.length || bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return []
    const machine = bytes.readUInt16LE(peOffset + 4)
    return machine === 0x8664 ? ['x64'] : machine === 0xaa64 ? ['arm64'] : [`unknown-0x${machine.toString(16)}`]
  } catch {
    return []
  }
}

function readGitState() {
  const commit = gitOutput(['rev-parse', 'HEAD'])
  const status = gitOutput(['status', '--porcelain=v1', '--untracked-files=all'])
  return {
    commit,
    worktreeClean: status.length === 0,
    statusEntryCount: status ? status.split(/\r?\n/).filter(Boolean).length : 0
  }
}

function gitOutput(args) {
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

function emptySignature(status = 'NotInspected') {
  return { status, hasCertificate: false, timestamped: false, failure: null }
}

function check(scope, name, passed, detail) {
  checks.push({ scope, name, status: passed ? 'passed' : 'failed', ...(detail ? { detail: redact(detail) } : {}) })
}

function summarizeChecks(items) {
  return {
    total: items.length,
    counts: {
      passed: items.filter((item) => item.status === 'passed').length,
      failed: items.filter((item) => item.status === 'failed').length
    }
  }
}

function hasTarget(value, target) {
  const values = Array.isArray(value) ? value : value ? [value] : []
  return values.some((item) => item === target || item?.target === target)
}

function isFile(filePath) {
  try {
    return statSync(filePath).isFile()
  } catch {
    return false
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function resolvePath(value) {
  return path.isAbsolute(value) ? value : path.join(repoRoot, value)
}

function reportPath(value) {
  return path.relative(repoRoot, value) || '.'
}

function powerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function redact(value) {
  return String(value)
    .replace(/(CSC_KEY_PASSWORD|WIN_CSC_KEY_PASSWORD|CSC_LINK|WIN_CSC_LINK)\s*[=:]\s*\S+/gi, '$1=[REDACTED]')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 3)
    .join(' | ')
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  const prefix = `${name}=`
  const inline = process.argv.find((item) => item.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : undefined
}
