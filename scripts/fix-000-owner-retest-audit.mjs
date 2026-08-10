#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const required = process.argv.includes('--required')
const observation = process.argv.includes('--observation')
const recordArg = argValue('--record')
const recordPath = recordArg ? path.resolve(repoRoot, recordArg) : null
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
const reportRoot = path.join(repoRoot, 'test-results', 'fix-000-owner-retest-audit')
const reportDir = path.join(reportRoot, runId)
const baseline = readFileSync(path.join(repoRoot, 'docs', 'SPRINT-01-GATE-BASELINE.md'), 'utf8')
const expectedArtifact = parseDocumentedD0(baseline)
const stepIds = Object.freeze([
  'artifact_preflight',
  'install',
  'first_launch',
  'provider',
  'project',
  'read_only_task',
  'studio_recruitment',
  'task_status',
  'office_artifact',
  'restart',
  'uninstall_cancel',
  'uninstall_confirm'
])
const schemaFailures = []
const gateFailures = []

if (required && observation) schemaFailures.push('--required and --observation cannot be used together')
if (!recordPath) schemaFailures.push('missing Owner retest record; pass --record <private-json-path>')
if (recordPath && isInsideRepo(recordPath)) schemaFailures.push('Owner retest record must remain outside the repository')

let record
let recordSha256 = null
if (recordPath && existsSync(recordPath)) {
  try {
    const recordText = readFileSync(recordPath, 'utf8')
    record = JSON.parse(recordText)
    recordSha256 = createHash('sha256').update(recordText).digest('hex')
  } catch {
    schemaFailures.push('Owner retest record could not be read or parsed as JSON')
  }
} else if (recordPath) {
  schemaFailures.push('Owner retest record does not exist')
}

if (record !== undefined) validateSchema(record)
let evidence = []
if (record && schemaFailures.length === 0) {
  evidence = await inspectEvidenceFiles(record.evidenceFiles)
  if (schemaFailures.length === 0) {
    validateRun(record, evidence)
    if (!observation || record.result === 'passed') validatePassGate(record)
  }
}

const status = schemaFailures.length > 0 || gateFailures.length > 0
  ? 'failed'
  : record?.result === 'passed'
    ? 'passed'
    : observation
      ? 'observed_failed'
      : 'failed'
const report = {
  status,
  evidenceClass: 'installed_owner_retest',
  required,
  observation,
  runId,
  reportDir: path.relative(repoRoot, reportDir),
  recordProvided: Boolean(recordPath),
  recordSha256,
  schemaTemplate: 'docs/OWNER-FIX-000-RESULT.template.json',
  retestGuide: 'docs/OWNER-FIX-000-RETEST.md',
  artifactBinding: expectedArtifact
    ? {
        size: expectedArtifact.size,
        sha256: expectedArtifact.sha256,
        artifactSetSha256: expectedArtifact.artifactSetSha256
      }
    : null,
  summary: record
    ? {
        result: record.result || null,
        durationMinutes: measuredMinutes(record.startedAt, record.finishedAt),
        portableSmokeRecordSha256: typeof record.environment?.portableSmokeRecordSha256 === 'string'
          ? record.environment.portableSmokeRecordSha256.toLowerCase()
          : null,
        stepCounts: countStepStatuses(record.steps),
        findingCounts: countFindingSeverities(record.findings),
        evidence: evidence.map((item) => ({ role: item.role, size: item.size, sha256: item.sha256 }))
      }
    : null,
  schemaFailures,
  gateFailures,
  failures: [...schemaFailures, ...gateFailures],
  redactionPolicy: 'The audit omits record/evidence paths, finding text, Provider identity, project identity, Office path, and all credential values.'
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 2))
if (required && status !== 'passed') process.exitCode = 1

function validateSchema(value) {
  if (!isRecord(value)) return schemaFailures.push('record must be a JSON object')
  if (value.schemaVersion !== 1) schemaFailures.push('schemaVersion must be 1')
  if (value.gateId !== 'fix_000_owner_retest') schemaFailures.push('gateId must be fix_000_owner_retest')
  validateArtifact(value.artifact)
  validateEnvironment(value.environment)
  requireString(value, 'startedAt')
  requireString(value, 'finishedAt')
  if (!['passed', 'failed', 'not_run'].includes(value.result)) schemaFailures.push('result must be passed, failed, or not_run')
  validateSteps(value.steps)
  validateAssertions(value.assertions)
  validatePrivacy(value.privacy)
  validateEvidenceSchema(value.evidenceFiles, value.steps)
  validateFindings(value.findings)
  findForbiddenKeys(value)
}

function validateArtifact(value) {
  if (!isRecord(value)) return schemaFailures.push('artifact must be an object')
  if (!Number.isInteger(value.size) || value.size <= 0) schemaFailures.push('artifact.size must be a positive integer')
  for (const key of ['sha256', 'artifactSetSha256']) {
    if (!/^[a-f0-9]{64}$/i.test(value[key] || '')) schemaFailures.push(`artifact.${key} must be SHA-256`)
  }
}

function validateEnvironment(value) {
  if (!isRecord(value)) return schemaFailures.push('environment must be an object')
  if (value.platform !== 'windows-x64') schemaFailures.push('environment.platform must be windows-x64')
  requireBoolean(value, 'cleanPreflightPassed', 'environment')
  requireBoolean(value, 'portableSmokePassed', 'environment')
  if (value.portableSmokeRecordSha256 !== '' && !/^[a-f0-9]{64}$/i.test(value.portableSmokeRecordSha256 || '')) {
    schemaFailures.push('environment.portableSmokeRecordSha256 must be empty or SHA-256')
  }
  requireBoolean(value, 'interactiveDesktop', 'environment')
  if (!Number.isInteger(value.existingInstallCount) || value.existingInstallCount < 0) {
    schemaFailures.push('environment.existingInstallCount must be a non-negative integer')
  }
}

function validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length !== stepIds.length) {
    schemaFailures.push(`steps must contain ${stepIds.length} ordered items`)
    return
  }
  for (let index = 0; index < stepIds.length; index += 1) {
    const step = steps[index]
    if (!isRecord(step)) {
      schemaFailures.push(`step ${index + 1} must be an object`)
      continue
    }
    if (step.id !== stepIds[index]) schemaFailures.push(`step ${index + 1} id must be ${stepIds[index]}`)
    if (!['passed', 'failed', 'not_run'].includes(step.status)) schemaFailures.push(`step ${stepIds[index]} status is invalid`)
  }
}

function validateAssertions(value) {
  if (!isRecord(value)) return schemaFailures.push('assertions must be an object')
  for (const key of [
    'firstLaunchUsable',
    'providerEncryptedAtRest',
    'readOnlyGitUnchanged',
    'officeArtifactExists',
    'officeArtifactNonEmpty',
    'restartUsable',
    'restartLanguageStable',
    'cancelLeavesAppLaunchable',
    'confirmedInstallDirAbsent',
    'confirmedRegistryAbsent',
    'userDataPreserved'
  ]) requireBoolean(value, key, 'assertions')
  for (const key of ['firstLaunchTimeMs', 'restartTimeMs']) {
    if (value[key] !== null && (!Number.isFinite(value[key]) || value[key] < 0)) schemaFailures.push(`assertions.${key} must be null or non-negative`)
  }
  if (!Number.isInteger(value.uninstallPromptCountOnCancelRun) || value.uninstallPromptCountOnCancelRun < 0) {
    schemaFailures.push('assertions.uninstallPromptCountOnCancelRun must be a non-negative integer')
  }
  if (!['no', 'yes', 'unknown'].includes(value.uninstallDefaultChoice)) schemaFailures.push('assertions.uninstallDefaultChoice is invalid')
  if (value.officeArtifactSha256 !== '' && !/^[a-f0-9]{64}$/i.test(value.officeArtifactSha256 || '')) {
    schemaFailures.push('assertions.officeArtifactSha256 must be empty or SHA-256')
  }
}

function validatePrivacy(value) {
  if (!isRecord(value)) return schemaFailures.push('privacy must be an object')
  for (const key of ['redactionReviewCompleted', 'noApiKeyRecorded', 'noProviderUrlRecorded', 'noProjectPathPublished', 'noOfficePathPublished']) {
    requireBoolean(value, key, 'privacy')
  }
}

function validateEvidenceSchema(files, steps) {
  if (!Array.isArray(files) || files.length !== stepIds.length) {
    schemaFailures.push(`evidenceFiles must contain ${stepIds.length} ordered items`)
    return
  }
  for (let index = 0; index < stepIds.length; index += 1) {
    const item = files[index]
    if (!isRecord(item)) {
      schemaFailures.push(`evidenceFiles item ${index + 1} must be an object`)
      continue
    }
    if (item.role !== stepIds[index]) schemaFailures.push(`evidenceFiles item ${index + 1} role must be ${stepIds[index]}`)
    if (typeof item.path !== 'string') {
      schemaFailures.push(`evidenceFiles ${stepIds[index]} path must be a string`)
      continue
    }
    const stepStatus = Array.isArray(steps) ? steps[index]?.status : undefined
    if (stepStatus === 'not_run' && item.path.trim()) schemaFailures.push(`evidenceFiles ${stepIds[index]} path must be empty when the step was not run`)
    if ((stepStatus === 'passed' || stepStatus === 'failed') && !item.path.trim()) {
      schemaFailures.push(`evidenceFiles ${stepIds[index]} path must be non-empty when the step ran`)
    }
  }
  const paths = files.map((item) => typeof item?.path === 'string' && item.path.trim() ? path.resolve(item.path) : '').filter(Boolean)
  if (new Set(paths).size !== paths.length) schemaFailures.push('each evidence role must use a distinct file')
}

function validateFindings(findings) {
  if (!Array.isArray(findings)) return schemaFailures.push('findings must be an array')
  for (const [index, finding] of findings.entries()) {
    if (!isRecord(finding)) {
      schemaFailures.push(`finding ${index + 1} must be an object`)
      continue
    }
    if (!['Critical', 'High', 'Medium', 'Low'].includes(finding.severity)) schemaFailures.push(`finding ${index + 1} severity is invalid`)
    if (!stepIds.includes(finding.stepId)) schemaFailures.push(`finding ${index + 1} stepId is invalid`)
    if (!stepIds.includes(finding.evidenceRole)) schemaFailures.push(`finding ${index + 1} evidenceRole is invalid`)
    for (const key of ['id', 'reproduction', 'expected', 'actual', 'impact', 'evidenceRole']) requireString(finding, key, `finding ${index + 1}`)
  }
  const ids = findings.map((finding) => finding?.id).filter((id) => typeof id === 'string' && id.trim())
  if (new Set(ids).size !== ids.length) schemaFailures.push('finding ids must be unique')
}

async function inspectEvidenceFiles(files) {
  const results = []
  for (const item of files) {
    if (!item.path.trim()) continue
    const filePath = path.resolve(item.path)
    if (isInsideRepo(filePath)) {
      schemaFailures.push(`evidence ${item.role} must remain outside the repository`)
      continue
    }
    if (!existsSync(filePath)) {
      schemaFailures.push(`evidence ${item.role} does not exist`)
      continue
    }
    try {
      const stat = lstatSync(filePath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
        schemaFailures.push(`evidence ${item.role} must be a non-empty regular file, not a symlink`)
        continue
      }
      results.push({ role: item.role, size: stat.size, sha256: await sha256File(filePath) })
    } catch {
      schemaFailures.push(`evidence ${item.role} could not be audited`)
    }
  }
  return results
}

function validateRun(value, evidence) {
  if (!expectedArtifact) return gateFailures.push('Sprint baseline does not declare the expected D0')
  if (value.artifact.size !== expectedArtifact.size) gateFailures.push('record artifact size does not match the current D0')
  if (value.artifact.sha256.toLowerCase() !== expectedArtifact.sha256) gateFailures.push('record artifact SHA-256 does not match the current D0')
  if (value.artifact.artifactSetSha256.toLowerCase() !== expectedArtifact.artifactSetSha256) gateFailures.push('record artifact-set SHA-256 does not match the current D0')
  if (value.environment.cleanPreflightPassed !== true || value.environment.interactiveDesktop !== true || value.environment.existingInstallCount !== 0) {
    gateFailures.push('Owner retest requires a passed clean-host preflight on an interactive Windows x64 environment')
  }
  if (value.environment.portableSmokePassed !== true || !/^[a-f0-9]{64}$/i.test(value.environment.portableSmokeRecordSha256 || '')) {
    gateFailures.push('Owner retest must bind a passed private portable-smoke record SHA-256')
  }
  const duration = measuredMinutes(value.startedAt, value.finishedAt)
  if (!Number.isFinite(duration) || duration <= 0 || duration > 60) gateFailures.push('Owner retest timestamps must define a duration greater than 0 and no more than 60 minutes')
  if (Date.parse(value.finishedAt) > Date.now() + 60_000) gateFailures.push('finishedAt cannot be in the future')
  if (value.result === 'not_run') gateFailures.push('an audited Owner observation must be passed or failed, not not_run')

  const executedSteps = value.steps.filter((step) => step.status !== 'not_run')
  if (evidence.length !== executedSteps.length || evidence.some((item, index) => item.role !== executedSteps[index]?.id)) {
    gateFailures.push('every executed step must have one ordered, private, auditable evidence file')
  }
  if (value.result === 'failed' && !value.steps.some((step) => step.status === 'failed')) {
    gateFailures.push('a failed Owner observation must contain at least one failed step')
  }
  for (const step of value.steps.filter((item) => item.status === 'failed')) {
    if (!value.findings.some((finding) => finding.stepId === step.id)) gateFailures.push(`failed step ${step.id} must have a finding`)
  }
  const evidenceRoles = new Set(evidence.map((item) => item.role))
  for (const [index, finding] of value.findings.entries()) {
    if (!evidenceRoles.has(finding.evidenceRole)) gateFailures.push(`finding ${index + 1} must reference an audited evidence role`)
  }
  for (const [key, flag] of Object.entries(value.privacy)) if (flag !== true) gateFailures.push(`privacy.${key} must be true`)
}

function validatePassGate(value) {
  if (value.result !== 'passed') gateFailures.push('record result must be passed')
  if (!Array.isArray(value.steps) || value.steps.some((step) => step.status !== 'passed')) gateFailures.push('all 12 Owner retest steps must pass')

  const assertions = value.assertions
  for (const key of [
    'firstLaunchUsable',
    'providerEncryptedAtRest',
    'readOnlyGitUnchanged',
    'officeArtifactExists',
    'officeArtifactNonEmpty',
    'restartUsable',
    'restartLanguageStable',
    'cancelLeavesAppLaunchable',
    'confirmedInstallDirAbsent',
    'confirmedRegistryAbsent',
    'userDataPreserved'
  ]) if (assertions[key] !== true) gateFailures.push(`assertions.${key} must be true`)
  if (!Number.isFinite(assertions.firstLaunchTimeMs) || assertions.firstLaunchTimeMs <= 0) gateFailures.push('firstLaunchTimeMs must be recorded and greater than zero')
  if (!Number.isFinite(assertions.restartTimeMs) || assertions.restartTimeMs <= 0) gateFailures.push('restartTimeMs must be recorded and greater than zero')
  if (!/^[a-f0-9]{64}$/i.test(assertions.officeArtifactSha256 || '')) gateFailures.push('Office artifact SHA-256 must be recorded')
  if (assertions.uninstallPromptCountOnCancelRun !== 1) gateFailures.push('cancel run must show exactly one uninstall confirmation')
  if (assertions.uninstallDefaultChoice !== 'no') gateFailures.push('uninstall confirmation must default to No')
  if (value.findings.some((finding) => finding.severity === 'Critical' || finding.severity === 'High')) {
    gateFailures.push('Critical/High findings must be zero')
  }
}

function findForbiddenKeys(value, prefix = '') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbiddenKeys(item, `${prefix}[${index}]`))
    return
  }
  if (!isRecord(value)) return
  const forbidden = /^(api.?key|token|secret|password|base.?url|provider.?url|project.?path|office.?path|local.?path)$/i
  for (const [key, nested] of Object.entries(value)) {
    const location = prefix ? `${prefix}.${key}` : key
    if (forbidden.test(key)) schemaFailures.push(`forbidden sensitive key in record: ${location}`)
    findForbiddenKeys(nested, location)
  }
}

function parseDocumentedD0(markdown) {
  const match = markdown.match(/The current FIX-000 D0 artifact is `([^`]+)`, size ([\d,]+) bytes, SHA-256 `([a-f0-9]{64})`, and artifact-set SHA-256 `([a-f0-9]{64})`\./)
  if (!match) return undefined
  return {
    size: Number(match[2].replaceAll(',', '')),
    sha256: match[3],
    artifactSetSha256: match[4]
  }
}

function measuredMinutes(startedAt, finishedAt) {
  const start = Date.parse(startedAt)
  const finish = Date.parse(finishedAt)
  return Number.isFinite(start) && Number.isFinite(finish) && finish > start
    ? Number(((finish - start) / 60_000).toFixed(3))
    : null
}

function countStepStatuses(steps) {
  const counts = { passed: 0, failed: 0, not_run: 0 }
  if (Array.isArray(steps)) for (const step of steps) if (step?.status in counts) counts[step.status] += 1
  return counts
}

function countFindingSeverities(findings) {
  const counts = { Critical: 0, High: 0, Medium: 0, Low: 0 }
  if (Array.isArray(findings)) for (const finding of findings) if (finding?.severity in counts) counts[finding.severity] += 1
  return counts
}

function requireString(value, key, prefix = '') {
  if (typeof value?.[key] !== 'string' || !value[key].trim()) schemaFailures.push(`${prefix ? `${prefix}.` : ''}${key} must be a non-empty string`)
}

function requireBoolean(value, key, prefix = '') {
  if (typeof value?.[key] !== 'boolean') schemaFailures.push(`${prefix ? `${prefix}.` : ''}${key} must be boolean`)
}

function isInsideRepo(filePath) {
  const relative = path.relative(repoRoot, filePath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
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
