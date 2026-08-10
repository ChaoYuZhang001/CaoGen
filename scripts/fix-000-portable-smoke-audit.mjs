#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const required = process.argv.includes('--required')
const recordArg = argValue('--record')
const recordPath = recordArg ? path.resolve(repoRoot, recordArg) : null
const descriptor = JSON.parse(readFileSync(path.join(repoRoot, 'docs', 'FIX-000-D0.json'), 'utf8'))
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
const reportRoot = path.join(repoRoot, 'test-results', 'fix-000-portable-smoke-audit')
const reportDir = path.join(reportRoot, runId)
const failures = []
const expectedPreflightChecks = [
  'private evidence directory was provided',
  'private evidence directory is outside the portable kit',
  'D0 descriptor is valid',
  'host platform is Windows',
  'host architecture is x64',
  'D0 installer file name matches',
  'D0 installer size matches',
  'D0 installer SHA-256 matches',
  'D0 installer is intentionally unsigned',
  'interactive desktop is available in this session',
  'no CaoGen process is running',
  'no CaoGen uninstall registration exists',
  'Owner explicitly authorized the disposable installed smoke'
]

if (!recordPath) failures.push('missing portable smoke record; pass --record <private-json-path>')
if (recordPath && isInsideRepo(recordPath)) failures.push('portable smoke record must remain outside the repository')

let record
let recordSha256 = null
if (recordPath && existsSync(recordPath)) {
  try {
    const text = readFileSync(recordPath, 'utf8')
    record = JSON.parse(text)
    recordSha256 = createHash('sha256').update(text).digest('hex')
  } catch {
    failures.push('portable smoke record could not be read or parsed as JSON')
  }
} else if (recordPath) {
  failures.push('portable smoke record does not exist')
}

let screenshot = null
if (record !== undefined && failures.length === 0) {
  validateRecord(record)
  if (failures.length === 0) screenshot = await inspectScreenshot(record)
}

const status = failures.length === 0 ? 'passed' : 'failed'
const report = {
  status,
  evidenceClass: 'fix_000_portable_installed_smoke_audit',
  required,
  runId,
  reportDir: path.relative(repoRoot, reportDir),
  recordProvided: Boolean(recordPath),
  recordSha256,
  artifactBinding: {
    size: descriptor.size,
    sha256: descriptor.sha256,
    artifactSetSha256: descriptor.artifactSetSha256
  },
  summary: record && typeof record === 'object'
    ? {
        sourceStatus: record.status || null,
        durationMs: Number.isFinite(record.durationMs) ? record.durationMs : null,
        preflightCheckCount: Array.isArray(record.checks) ? record.checks.length : 0,
        installationStatus: record.installation?.status || null,
        rendererStatus: record.renderer?.status || null,
        timeToInteractiveMs: Number.isFinite(record.renderer?.timeToInteractiveMs) ? record.renderer.timeToInteractiveMs : null,
        uninstallStatus: record.uninstall?.status || null,
        cleanupStatus: record.cleanup?.status || null,
        screenshot: screenshot ? { size: screenshot.size, sha256: screenshot.sha256 } : null
      }
    : null,
  failures,
  privacy: 'The audit emits no record, screenshot, install, user-data, Provider, credential, project, Office, or user path/value.'
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 2))
if (required && status !== 'passed') process.exitCode = 1

function validateRecord(value) {
  if (!isRecord(value)) return failures.push('portable smoke record must be a JSON object')
  if (value.schemaVersion !== 1) failures.push('schemaVersion must be 1')
  if (value.evidenceClass !== 'fix_000_portable_installed_smoke') failures.push('evidenceClass must be fix_000_portable_installed_smoke')
  if (value.status !== 'passed') failures.push('portable smoke status must be passed')
  if (value.required !== true || value.preflightOnly !== false || value.ownerAuthorized !== true) {
    failures.push('portable smoke must be an Owner-authorized required run, not preflight-only')
  }

  if (!isRecord(value.artifact)) {
    failures.push('artifact must be an object')
  } else {
    if (value.artifact.size !== descriptor.size) failures.push('artifact size does not match FIX-000 D0')
    if (value.artifact.sha256 !== descriptor.sha256) failures.push('artifact SHA-256 does not match FIX-000 D0')
    if (value.artifact.artifactSetSha256 !== descriptor.artifactSetSha256) failures.push('artifact-set SHA-256 does not match FIX-000 D0')
  }

  if (
    value.environment?.platform !== 'windows-x64' ||
    value.environment?.interactiveDesktop !== true ||
    value.environment?.existingInstallCountBefore !== 0 ||
    value.environment?.caogenProcessCountBefore !== 0
  ) failures.push('portable smoke environment was not a clean interactive Windows x64 host')

  if (!Array.isArray(value.checks) || value.checks.length !== expectedPreflightChecks.length) {
    failures.push(`checks must contain ${expectedPreflightChecks.length} ordered passed items`)
  } else {
    for (let index = 0; index < expectedPreflightChecks.length; index += 1) {
      if (value.checks[index]?.name !== expectedPreflightChecks[index] || value.checks[index]?.status !== 'passed') {
        failures.push(`preflight check ${index + 1} must pass as ${expectedPreflightChecks[index]}`)
      }
    }
  }

  if (value.installerInvoked !== true) failures.push('installerInvoked must be true')
  if (
    value.installation?.status !== 'passed' ||
    value.installation?.installerAuthenticodeStatus !== 'NotSigned' ||
    value.installation?.appExecutablePresent !== true ||
    value.installation?.uninstallerPresent !== true ||
    value.installation?.appAuthenticodeStatus !== 'NotSigned'
  ) failures.push('installed application and unsigned-state checks must pass')

  if (
    value.renderer?.status !== 'passed' ||
    value.renderer?.title !== 'CaoGen' ||
    value.renderer?.rootChildCount <= 0 ||
    value.renderer?.bodyTextLength <= 0 ||
    value.renderer?.preloadReady !== true ||
    !Number.isFinite(value.renderer?.timeToInteractiveMs) ||
    value.renderer.timeToInteractiveMs <= 0
  ) failures.push('installed renderer must be non-empty, preload-ready, and timed')

  if (
    value.uninstall?.status !== 'passed' ||
    value.uninstall?.installRootAbsent !== true ||
    value.uninstall?.registryAbsent !== true ||
    value.uninstall?.userDataPreserved !== true
  ) failures.push('silent uninstall must remove the app and registration while preserving user data')
  if (value.cleanup?.status !== 'passed') failures.push('successful smoke temporary cleanup must pass')
  if (value.diagnosticStatePreserved !== false || value.diagnostic !== null || value.failure !== null) {
    failures.push('a passing smoke must have no failure or preserved diagnostic state')
  }

  const started = Date.parse(value.startedAt)
  const finished = Date.parse(value.finishedAt)
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished <= started) failures.push('smoke timestamps must be valid and ordered')
  if (finished > Date.now() + 60_000) failures.push('smoke finishedAt cannot be in the future')
  if (!Number.isFinite(value.durationMs) || value.durationMs <= 0 || value.durationMs !== finished - started) {
    failures.push('smoke durationMs must exactly match timestamps')
  }
  if (Number.isFinite(value.durationMs) && value.durationMs > 20 * 60_000) failures.push('installed smoke duration must not exceed 20 minutes')

  if (
    !isRecord(value.evidence) ||
    value.evidence.rendererScreenshot !== 'fix-000-packaged-smoke-renderer.png' ||
    !Number.isInteger(value.evidence.rendererScreenshotSize) ||
    value.evidence.rendererScreenshotSize <= 0 ||
    !/^[a-f0-9]{64}$/.test(value.evidence.rendererScreenshotSha256 || '')
  ) failures.push('renderer screenshot metadata is missing or invalid')
}

async function inspectScreenshot(value) {
  const fileName = value.evidence.rendererScreenshot
  if (path.basename(fileName) !== fileName) {
    failures.push('renderer screenshot must be a report-relative file name')
    return null
  }
  const screenshotPath = path.join(path.dirname(recordPath), fileName)
  if (isInsideRepo(screenshotPath)) {
    failures.push('renderer screenshot must remain outside the repository')
    return null
  }
  if (!existsSync(screenshotPath)) {
    failures.push('renderer screenshot does not exist')
    return null
  }
  try {
    const stat = lstatSync(screenshotPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
      failures.push('renderer screenshot must be a non-empty regular file, not a symlink')
      return null
    }
    const sha256 = await sha256File(screenshotPath)
    const pngSignature = readFileSync(screenshotPath).subarray(0, 8).toString('hex')
    if (pngSignature !== '89504e470d0a1a0a') failures.push('renderer screenshot is not a PNG file')
    if (stat.size !== value.evidence.rendererScreenshotSize) failures.push('renderer screenshot size does not match the record')
    if (sha256 !== value.evidence.rendererScreenshotSha256) failures.push('renderer screenshot SHA-256 does not match the record')
    return { size: stat.size, sha256 }
  } catch {
    failures.push('renderer screenshot could not be audited')
    return null
  }
}

function isInsideRepo(filePath) {
  const relative = path.relative(repoRoot, path.resolve(filePath))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) return process.argv[index + 1]
  const prefix = `${name}=`
  const inline = process.argv.find((item) => item.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : undefined
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}
