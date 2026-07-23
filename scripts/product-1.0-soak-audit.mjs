#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const required = process.argv.includes('--required') || process.env.CAOGEN_1_0_SOAK_AUDIT_REQUIRED === '1'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = resolvePath(argValue('--report-root') || process.env.CAOGEN_1_0_SOAK_REPORT_ROOT || 'test-results/product-1.0-soak-audit')
const reportDir = path.join(reportRoot, runId)
const releaseVersion = argValue('--version') || process.env.CAOGEN_RELEASE_VERSION || readPackageVersion()
const recordPath = resolveRecordPath()
const record = recordPath ? readJsonFile(recordPath) : undefined
const waiverPath = recordPath ? undefined : resolveWaiverPath()
const waiver = waiverPath ? readJsonFile(waiverPath) : undefined
const failures = []
const decision = recordPath ? 'seven_day_soak' : waiverPath ? 'owner_waiver' : 'missing'

if (recordPath && record?.error) {
  failures.push(`seven-day soak record is not valid JSON: ${record.error}`)
} else if (recordPath) {
  validateRecord(record.data)
} else if (waiver?.error) {
  failures.push(`1.0.0 soak waiver is not valid JSON: ${waiver.error}`)
} else if (waiverPath) {
  validateWaiver(waiver.data)
} else {
  failures.push('missing seven-day soak record or explicit 1.0.0 owner waiver; pass --record <path> or --waiver <path>')
}

const acceptedStatus = decision === 'owner_waiver' ? 'waived' : 'passed'
const report = {
  status: failures.length === 0 ? acceptedStatus : required ? 'failed' : decision === 'missing' ? 'skipped' : 'failed',
  required,
  runId,
  reportDir,
  releaseVersion,
  decision,
  recordPath: recordPath ? path.relative(repoRoot, recordPath) : undefined,
  waiverPath: waiverPath ? path.relative(repoRoot, waiverPath) : undefined,
  schemaTemplate: 'docs/1.0-SOAK-RESULT.template.json',
  guide: 'docs/1.0-SOAK-GUIDE.md',
  redactionPolicy: 'Keep private logs, recordings, provider identifiers, user names, secrets, and private project paths outside the repository.',
  summary: summarizeRecord(record?.data),
  waiver: summarizeWaiver(waiver?.data),
  failures
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log(JSON.stringify(report, null, 2))
if (required && !['passed', 'waived'].includes(report.status)) process.exitCode = 1
if (!required && recordPath && report.status === 'failed') process.exitCode = 1
if (!required && waiverPath && report.status === 'failed') process.exitCode = 1

function validateWaiver(value) {
  if (!isRecord(value)) {
    failures.push('waiver must be a JSON object')
    return
  }

  if (value.schemaVersion !== 1) failures.push('waiver.schemaVersion must equal 1')
  validateExactWaiverFields(value)
  validateWaiverVersion(value)
  for (const field of ['owner', 'decisionSource', 'reason', 'acceptedRisk']) {
    requireString(value, field, 'waiver')
  }
  parseTimestamp(value.decidedAt, 'waiver.decidedAt')
  validateWaiverApproval(value)
  if (stringArray(value.substituteEvidence).length === 0) {
    failures.push('waiver.substituteEvidence must contain at least one explicit compensating gate')
  }
}

function validateExactWaiverFields(value) {
  const expected = {
    gateId: 'product_1_0_soak',
    decision: 'waive',
    scope: 'exact_release_version_only',
    expiresAfterReleaseVersion: '1.0.0'
  }
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (stringField(value, field) !== expectedValue) {
      failures.push(`waiver.${field} must equal ${expectedValue}`)
    }
  }
}

function validateWaiverVersion(value) {
  const waiverVersion = requireString(value, 'releaseVersion', 'waiver')
  if (waiverVersion && waiverVersion !== '1.0.0') {
    failures.push('waiver.releaseVersion must equal 1.0.0; this exception cannot authorize another release')
  }
  if (releaseVersion !== '1.0.0') {
    failures.push(`the owner waiver is valid only when the requested release version is exactly 1.0.0, got ${releaseVersion || 'unknown'}`)
  }
  if (waiverVersion && releaseVersion && waiverVersion !== releaseVersion) {
    failures.push('waiver.releaseVersion must match the requested release version')
  }
}

function validateWaiverApproval(value) {
  const expected = {
    approvedByOwner: true,
    riskAccepted: true,
    appliesToFutureVersions: false
  }
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (value[field] !== expectedValue) failures.push(`waiver.${field} must be ${expectedValue}`)
  }
}

function validateRecord(value) {
  if (!isRecord(value)) {
    failures.push('record must be a JSON object')
    return
  }

  if (value.schemaVersion !== 1) failures.push('schemaVersion must equal 1')
  const identity = readIdentity(value, 'record')
  if (identity.candidateVersion && identity.candidateVersion !== releaseVersion) {
    failures.push('record.candidateVersion must match the requested release version')
  }
  requireString(value, 'platform')
  requireString(value, 'timezone')
  requireString(value, 'evidenceRoot')
  if (!passLike(value.result)) failures.push('result must be pass/passed')
  if (value.featureFrozen !== true) failures.push('featureFrozen must be true')
  if (value.zeroDataLoss !== true) failures.push('zeroDataLoss must be true')
  if (value.zeroDuplicateHighRiskEffects !== true) failures.push('zeroDuplicateHighRiskEffects must be true')
  if (numberField(value, 'resetCount') !== 0) failures.push('resetCount must be 0; a candidate change restarts the seven-day soak')

  const startedAt = parseTimestamp(value.startedAt, 'startedAt')
  const finishedAt = parseTimestamp(value.finishedAt, 'finishedAt')
  if (startedAt !== undefined && finishedAt !== undefined && finishedAt <= startedAt) {
    failures.push('finishedAt must be after startedAt')
  }

  const days = Array.isArray(value.days) ? value.days : []
  if (days.length !== 7) failures.push(`days must contain exactly 7 entries, got ${days.length}`)
  const parsedDays = days.map((day, index) => validateDay(day, index, identity))
  validateConsecutiveDays(parsedDays)
}

function validateDay(value, index, identity) {
  const label = `day ${index + 1}`
  if (!isRecord(value)) {
    failures.push(`${label} must be an object`)
    return undefined
  }
  const date = parseIsoDay(value.date, `${label}.date`)
  const dayIdentity = readIdentity(value, label)
  for (const key of ['candidateVersion', 'gitCommit', 'artifactSetDigest']) {
    if (identity[key] && dayIdentity[key] && identity[key] !== dayIdentity[key]) {
      failures.push(`${label}.${key} must match the frozen candidate`)
    }
  }
  const minutes = numberField(value, 'minutes')
  if (!Number.isFinite(minutes) || minutes <= 0) failures.push(`${label}.minutes must be greater than 0`)
  const workflows = stringArray(value.workflows)
  if (workflows.length === 0) failures.push(`${label}.workflows must contain at least one workflow id`)
  if (value.launchPassed !== true) failures.push(`${label}.launchPassed must be true`)
  requireZero(value, 'assetLossCount', label)
  requireZero(value, 'duplicateHighRiskEffectCount', label)
  requireZero(value, 'unresolvedBlockingDefectCount', label)
  validateDefects(value.defects, label)
  return date
}

function readIdentity(value, label) {
  const candidateVersion = requireString(value, 'candidateVersion', label)
  const gitCommit = requireString(value, 'gitCommit', label)
  const artifactSetDigest = requireString(value, 'artifactSetDigest', label)
  if (gitCommit && !/^[0-9a-f]{7,40}$/i.test(gitCommit)) failures.push(`${label}.gitCommit must be a 7-40 character hexadecimal commit`)
  if (artifactSetDigest && !/^sha256:[0-9a-f]{64}$/i.test(artifactSetDigest)) {
    failures.push(`${label}.artifactSetDigest must use sha256:<64 hex> format`)
  }
  return { candidateVersion, gitCommit, artifactSetDigest }
}

function validateConsecutiveDays(days) {
  if (days.some((day) => day === undefined)) return
  const unique = new Set(days)
  if (unique.size !== days.length) failures.push('day dates must be unique')
  for (let index = 1; index < days.length; index += 1) {
    if (days[index] - days[index - 1] !== 24 * 60 * 60 * 1000) {
      failures.push(`day dates must be ordered and consecutive; entry ${index + 1} does not follow entry ${index}`)
    }
  }
}

function validateDefects(value, label) {
  if (!Array.isArray(value)) {
    failures.push(`${label}.defects must be an array`)
    return
  }
  for (const [index, defect] of value.entries()) {
    if (!isRecord(defect)) {
      failures.push(`${label}.defects[${index}] must be an object`)
      continue
    }
    requireString(defect, 'id', `${label}.defects[${index}]`)
    requireString(defect, 'severity', `${label}.defects[${index}]`)
    if (!['resolved', 'accepted_non_blocking'].includes(stringField(defect, 'status'))) {
      failures.push(`${label}.defects[${index}].status must be resolved or accepted_non_blocking`)
    }
    requireString(defect, 'resolution', `${label}.defects[${index}]`)
  }
}

function summarizeRecord(value) {
  if (!isRecord(value)) return undefined
  const days = Array.isArray(value.days) ? value.days.filter(isRecord) : []
  const workflows = new Set(days.flatMap((day) => stringArray(day.workflows)))
  return {
    schemaVersion: value.schemaVersion,
    candidateVersion: stringField(value, 'candidateVersion'),
    gitCommit: stringField(value, 'gitCommit'),
    artifactSetDigest: stringField(value, 'artifactSetDigest'),
    platform: stringField(value, 'platform'),
    startedAt: stringField(value, 'startedAt'),
    finishedAt: stringField(value, 'finishedAt'),
    featureFrozen: value.featureFrozen === true,
    zeroDataLoss: value.zeroDataLoss === true,
    zeroDuplicateHighRiskEffects: value.zeroDuplicateHighRiskEffects === true,
    resetCount: numberField(value, 'resetCount'),
    dayCount: days.length,
    totalMinutes: days.reduce((sum, day) => sum + Math.max(0, numberField(day, 'minutes') || 0), 0),
    workflowCount: workflows.size,
    defectCount: days.reduce((sum, day) => sum + (Array.isArray(day.defects) ? day.defects.length : 0), 0)
  }
}

function summarizeWaiver(value) {
  if (!isRecord(value)) return undefined
  return {
    schemaVersion: value.schemaVersion,
    gateId: stringField(value, 'gateId'),
    decision: stringField(value, 'decision'),
    releaseVersion: stringField(value, 'releaseVersion'),
    scope: stringField(value, 'scope'),
    owner: stringField(value, 'owner'),
    decidedAt: stringField(value, 'decidedAt'),
    decisionSource: stringField(value, 'decisionSource'),
    reason: stringField(value, 'reason'),
    acceptedRisk: stringField(value, 'acceptedRisk'),
    approvedByOwner: value.approvedByOwner === true,
    riskAccepted: value.riskAccepted === true,
    appliesToFutureVersions: value.appliesToFutureVersions === true,
    expiresAfterReleaseVersion: stringField(value, 'expiresAfterReleaseVersion'),
    substituteEvidence: stringArray(value.substituteEvidence)
  }
}

function resolveRecordPath() {
  const explicit = argValue('--record') || process.env.CAOGEN_1_0_SOAK_RECORD
  if (!explicit && (argValue('--waiver') || process.env.CAOGEN_1_0_SOAK_WAIVER)) return undefined
  const candidates = [explicit, 'test-results/1.0-soak/latest-private.json', 'docs/1.0-SOAK-RESULT.json'].filter(Boolean)
  for (const candidate of candidates) {
    const absolutePath = resolvePath(candidate)
    if (existsSync(absolutePath)) return absolutePath
  }
  return explicit ? resolvePath(explicit) : undefined
}

function resolveWaiverPath() {
  if (process.argv.includes('--no-waiver')) return undefined
  const explicit = argValue('--waiver') || process.env.CAOGEN_1_0_SOAK_WAIVER
  const candidates = [explicit, 'docs/1.0-SOAK-WAIVER.json'].filter(Boolean)
  for (const candidate of candidates) {
    const absolutePath = resolvePath(candidate)
    if (existsSync(absolutePath)) return absolutePath
  }
  return explicit ? resolvePath(explicit) : undefined
}

function readPackageVersion() {
  const packageJson = readJsonFile(path.join(repoRoot, 'package.json'))
  return stringField(packageJson.data, 'version') || 'unknown'
}

function readJsonFile(filePath) {
  try {
    return { data: JSON.parse(readFileSync(filePath, 'utf8')), error: undefined }
  } catch (error) {
    return { data: undefined, error: error instanceof Error ? error.message : String(error) }
  }
}

function requireString(value, key, label = 'record') {
  const result = stringField(value, key)
  if (!result) failures.push(`${label}.${key} must be a non-empty string`)
  return result
}

function requireZero(value, key, label) {
  const result = numberField(value, key)
  if (result !== 0) failures.push(`${label}.${key} must be 0`)
}

function parseTimestamp(value, label) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    failures.push(`${label} must be a valid timestamp`)
    return undefined
  }
  return timestamp
}

function parseIsoDay(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    failures.push(`${label} must use YYYY-MM-DD`)
    return undefined
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    failures.push(`${label} must be a real calendar date`)
    return undefined
  }
  return timestamp
}

function passLike(value) {
  return value === true || (typeof value === 'string' && ['pass', 'passed'].includes(value.trim().toLowerCase()))
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  const prefix = `${name}=`
  const inline = process.argv.find((item) => item.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : undefined
}

function resolvePath(value) {
  return path.isAbsolute(value) ? value : path.join(repoRoot, value)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value, key) {
  return typeof value?.[key] === 'string' && value[key].trim() ? value[key].trim() : undefined
}

function stringArray(value) {
  return Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()))] : []
}

function numberField(value, key) {
  return typeof value?.[key] === 'number' ? value[key] : Number(value?.[key])
}
