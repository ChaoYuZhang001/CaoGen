#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const EVIDENCE_PURPOSE = 'm1_onboarding_acceptance_and_friction_review'
const MAX_RETENTION_DAYS = 30
const required = process.argv.includes('--required')
const observation = process.argv.includes('--observation')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = resolvePath(argValue('--report-root') || 'test-results/m1-first-user-onboarding-audit')
const reportDir = path.join(reportRoot, runId)
const recordPath = resolveRecordPath()
const expected = {
  releaseTag: argValue('--expected-release-tag') || process.env.CAOGEN_M1_EXPECTED_RELEASE_TAG,
  candidateCommit: argValue('--expected-candidate-commit') || process.env.CAOGEN_M1_EXPECTED_CANDIDATE_COMMIT,
  assetSha256: normalizeSha256(argValue('--expected-asset-sha256') || process.env.CAOGEN_M1_EXPECTED_ASSET_SHA256)
}
const schemaFailures = []
const gateFailures = []

if (required && observation) schemaFailures.push('--required and --observation cannot be used together')
const loaded = recordPath ? readJson(recordPath) : undefined
if (!recordPath) {
  if (required || observation) schemaFailures.push('missing M1 first-user record; pass --record <private-json-path>')
} else if (loaded?.error) {
  schemaFailures.push(`M1 first-user record is not valid JSON: ${loaded.error}`)
}

const record = loaded?.data
if (record) validateSchema(record)
const installer = record && schemaFailures.length === 0
  ? await inspectFile(record.installerPath, 'installerPath', schemaFailures)
  : undefined
const evidenceFiles = record && schemaFailures.length === 0
  ? await inspectEvidenceFiles(record.evidenceFiles, schemaFailures)
  : []
if (record && schemaFailures.length === 0) validateGate(record, installer, expected)

const status = determineStatus()
const report = {
  status,
  required,
  observation,
  runId,
  reportDir,
  recordProvided: Boolean(recordPath),
  schemaTemplate: 'docs/M1-FIRST-USER-RESULT.template.json',
  drillGuide: 'docs/M1-FIRST-USER-DRILL.md',
  releaseBinding: {
    releaseTag: expected.releaseTag || null,
    candidateCommit: expected.candidateCommit || null,
    assetSha256: expected.assetSha256 || null
  },
  summary: summarize(record, installer, evidenceFiles),
  redactionPolicy: 'The report omits tester identity, local paths, project names, provider identity, prompts, notes, blockers, and rough-edge text.',
  schemaFailures,
  gateFailures,
  failures: [...schemaFailures, ...gateFailures]
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 2))
if (status === 'failed') process.exitCode = 1

function validateSchema(value) {
  if (!isRecord(value)) return schemaFailures.push('record must be a JSON object')
  if (value.schemaVersion !== 2) schemaFailures.push('schemaVersion must be 2')
  if (value.gateId !== 'm1_first_user_onboarding') schemaFailures.push('gateId must be m1_first_user_onboarding')
  for (const key of ['testerId', 'releaseTag', 'releaseUrl', 'websiteUrl', 'platform', 'architecture', 'installedVersion', 'installedCandidateCommit', 'installerAssetName', 'installerPath', 'providerProtocol', 'startedAt', 'finishedAt', 'result']) {
    requireString(value, key)
  }
  requireBoolean(value, 'projectContributor')
  requireBoolean(value, 'previousCaoGenUser')
  requireBoolean(value, 'securityBypassUsed')
  requireBoolean(value, 'operatorHelpUsed')
  if (value.documentationUsed !== 'quick_start_only') schemaFailures.push('documentationUsed must be quick_start_only')
  const totalMinutes = numberField(value, 'totalMinutes')
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) schemaFailures.push('totalMinutes must be greater than 0')
  validateSteps(value.steps)
  validateReadOnlyTask(value.readOnlyTask)
  validateEvidenceGovernanceSchema(value.evidenceGovernance)
  validateStringArray(value.blockers, 'blockers')
  validateStringArray(value.roughEdges, 'roughEdges')
  validateEvidenceSchema(value.evidenceFiles)
  findForbiddenKeys(value)
}

function validateSteps(steps) {
  const names = ['open_website', 'download_intel_dmg', 'install_and_launch', 'configure_provider', 'complete_read_only_task']
  if (!Array.isArray(steps) || steps.length !== names.length) {
    schemaFailures.push(`steps must contain ${names.length} items`)
    return
  }
  for (let index = 0; index < names.length; index += 1) {
    const step = steps[index]
    if (!isRecord(step)) {
      schemaFailures.push(`step ${index + 1} must be an object`)
      continue
    }
    if (step.id !== index + 1) schemaFailures.push(`step ${index + 1} id must be ${index + 1}`)
    if (step.name !== names[index]) schemaFailures.push(`step ${index + 1} name must be ${names[index]}`)
    requireBoolean(step, 'completed', `step ${index + 1}`)
    const minutes = numberField(step, 'minutes')
    if (!Number.isFinite(minutes) || minutes < 0) schemaFailures.push(`step ${index + 1} minutes must be non-negative`)
  }
}

function validateReadOnlyTask(task) {
  if (!isRecord(task)) return schemaFailures.push('readOnlyTask must be an object')
  if (task.promptId !== 'quick_start_project_read_only_v1') schemaFailures.push('readOnlyTask.promptId must identify the published Quick Start prompt')
  requireBoolean(task, 'completed', 'readOnlyTask')
  requireBoolean(task, 'responseUseful', 'readOnlyTask')
  requireBoolean(task, 'projectPathRedacted', 'readOnlyTask')
  const mutationCount = numberField(task, 'mutationCount')
  if (!Number.isInteger(mutationCount) || mutationCount < 0) schemaFailures.push('readOnlyTask.mutationCount must be a non-negative integer')
}

function validateEvidenceSchema(files) {
  const roles = ['screen_recording', 'system_architecture', 'installed_app_identity', 'read_only_task']
  if (!Array.isArray(files) || files.length !== roles.length) {
    schemaFailures.push(`evidenceFiles must contain ${roles.length} items`)
    return
  }
  for (let index = 0; index < roles.length; index += 1) {
    const item = files[index]
    if (!isRecord(item)) {
      schemaFailures.push(`evidenceFiles item ${index + 1} must be an object`)
      continue
    }
    if (item.role !== roles[index]) schemaFailures.push(`evidenceFiles item ${index + 1} role must be ${roles[index]}`)
    if (!stringField(item, 'path')) schemaFailures.push(`evidenceFiles ${roles[index]} path must be non-empty`)
  }
  const resolvedPaths = files.map((item) => stringField(item, 'path')).filter(Boolean).map(resolvePath)
  if (new Set(resolvedPaths).size !== resolvedPaths.length) schemaFailures.push('each evidenceFiles role must use a distinct file')
}

function validateEvidenceGovernanceSchema(governance) {
  if (!isRecord(governance)) return schemaFailures.push('evidenceGovernance must be an object')
  requireBoolean(governance, 'screenRecordingConsent', 'evidenceGovernance')
  requireBoolean(governance, 'redactionReviewCompleted', 'evidenceGovernance')
  for (const key of ['consentRecordedAt', 'purpose', 'deleteBy', 'redactionReviewedAt', 'deletionStatus']) {
    requireString(governance, key, 'evidenceGovernance')
  }
  const retentionDays = numberField(governance, 'maximumRetentionDays')
  if (!Number.isInteger(retentionDays) || retentionDays <= 0 || retentionDays > MAX_RETENTION_DAYS) {
    schemaFailures.push(`evidenceGovernance.maximumRetentionDays must be an integer from 1 to ${MAX_RETENTION_DAYS}`)
  }
  if (governance.deletedAt !== null && !stringField(governance, 'deletedAt')) {
    schemaFailures.push('evidenceGovernance.deletedAt must be null or a non-empty timestamp')
  }
}

function validateGate(value, installer, binding) {
  validateExpectedBinding(binding)
  validateReleaseBinding(value, installer, binding)
  validateDistributionBinding(value, binding)
  validateParticipantAndTiming(value)
  validateEvidenceGovernance(value)
  validatePassOutcome(value)
}

function validateExpectedBinding(binding) {
  for (const [key, label] of [['releaseTag', 'expected release tag'], ['candidateCommit', 'expected candidate commit'], ['assetSha256', 'expected asset SHA-256']]) {
    if (!binding[key]) gateFailures.push(`${label} must be supplied on the command line or environment`)
  }
  if (binding.releaseTag && !/^v\d+\.\d+\.\d+$/.test(binding.releaseTag)) gateFailures.push('expected release tag must use vMAJOR.MINOR.PATCH')
  if (binding.candidateCommit && !/^[a-f0-9]{40}$/i.test(binding.candidateCommit)) gateFailures.push('expected candidate commit must be a full 40-character hexadecimal SHA')
}

function validateReleaseBinding(value, installer, binding) {
  if (!/^[a-f0-9]{40}$/i.test(value.installedCandidateCommit)) gateFailures.push('installedCandidateCommit must be a full 40-character hexadecimal SHA')
  if (value.releaseTag !== binding.releaseTag) gateFailures.push('record releaseTag does not match the expected release')
  if (value.installedCandidateCommit !== binding.candidateCommit) gateFailures.push('installedCandidateCommit does not match the expected candidate')
  if (installer?.sha256 !== binding.assetSha256) gateFailures.push('installer SHA-256 does not match the expected public DMG')
}

function validateDistributionBinding(value, binding) {
  const version = String(binding.releaseTag || '').replace(/^v/, '')
  if (value.releaseUrl !== `https://github.com/ChaoYuZhang001/CaoGen/releases/tag/${binding.releaseTag}`) gateFailures.push('releaseUrl must be the exact official GitHub Release')
  if (value.websiteUrl !== 'https://caogen.dev/') gateFailures.push('websiteUrl must be https://caogen.dev/')
  if (value.platform !== 'macos-x64' || value.architecture !== 'x86_64') gateFailures.push('the M1 gate requires a real macOS Intel x64 machine')
  if (value.installedVersion !== version || value.installerAssetName !== `CaoGen-${version}.dmg`) gateFailures.push('installed version and DMG name must match the expected release tag')
  if (path.basename(value.installerPath) !== value.installerAssetName) gateFailures.push('installerPath basename must match installerAssetName')
  if (value.evidenceFiles.some((item) => resolvePath(item.path) === resolvePath(value.installerPath))) gateFailures.push('installer and evidence files must be distinct')
  if (!['openai-compatible', 'anthropic-messages'].includes(value.providerProtocol)) gateFailures.push('providerProtocol must be openai-compatible or anthropic-messages')
}

function validateParticipantAndTiming(value) {
  if (value.projectContributor !== false || value.previousCaoGenUser !== false) gateFailures.push('tester must be a non-project participant and first-time CaoGen user')
  if (value.securityBypassUsed !== false) gateFailures.push('securityBypassUsed must be false')
  if (value.operatorHelpUsed !== false) gateFailures.push('operatorHelpUsed must be false')
  const start = Date.parse(value.startedAt)
  const finish = Date.parse(value.finishedAt)
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish <= start) gateFailures.push('startedAt and finishedAt must define a positive interval')
  const measuredMinutes = (finish - start) / 60000
  if (Number.isFinite(finish) && finish > Date.now() + 60 * 1000) gateFailures.push('finishedAt cannot be in the future')
  const totalMinutes = numberField(value, 'totalMinutes')
  if (Number.isFinite(measuredMinutes) && Math.abs(measuredMinutes - totalMinutes) > 0.25) gateFailures.push('totalMinutes must match the timestamp interval within 15 seconds')
  if (totalMinutes > 30) gateFailures.push(`totalMinutes must be <= 30, got ${totalMinutes}`)
  const stepMinutes = Array.isArray(value.steps) ? value.steps.reduce((sum, step) => sum + numberField(step, 'minutes'), 0) : 0
  if (stepMinutes > totalMinutes + 0.25) gateFailures.push('sum of step minutes must not exceed totalMinutes')
}

function validateEvidenceGovernance(value) {
  const governance = value.evidenceGovernance
  if (!isRecord(governance)) return

  validateEvidenceGovernanceStatus(governance)
  validateEvidenceGovernanceTimeline(governance, value)
}

function validateEvidenceGovernanceStatus(governance) {
  if (governance.screenRecordingConsent !== true) gateFailures.push('explicit screen-recording consent must be recorded before capture')
  if (governance.purpose !== EVIDENCE_PURPOSE) gateFailures.push(`evidenceGovernance.purpose must be ${EVIDENCE_PURPOSE}`)
  if (governance.redactionReviewCompleted !== true) gateFailures.push('private evidence must pass redaction review before audit')
  if (governance.deletionStatus !== 'scheduled') gateFailures.push('evidenceGovernance.deletionStatus must remain scheduled while evidence is present and under audit')
  if (governance.deletedAt !== null) gateFailures.push('evidenceGovernance.deletedAt must remain null until private evidence has actually been deleted')
}

function validateEvidenceGovernanceTimeline(governance, value) {
  const consentAt = Date.parse(governance.consentRecordedAt)
  const startedAt = Date.parse(value.startedAt)
  const finishedAt = Date.parse(value.finishedAt)
  const redactionReviewedAt = Date.parse(governance.redactionReviewedAt)
  const deleteBy = Date.parse(governance.deleteBy)
  const retentionDays = numberField(governance, 'maximumRetentionDays')
  if (!Number.isFinite(consentAt) || !Number.isFinite(startedAt) || consentAt > startedAt) {
    gateFailures.push('consentRecordedAt must be a valid timestamp no later than startedAt')
  }
  if (!Number.isFinite(redactionReviewedAt) || !Number.isFinite(finishedAt) || redactionReviewedAt < finishedAt) {
    gateFailures.push('redactionReviewedAt must be a valid timestamp no earlier than finishedAt')
  }
  if (Number.isFinite(redactionReviewedAt) && redactionReviewedAt > Date.now() + 60 * 1000) {
    gateFailures.push('redactionReviewedAt cannot be in the future')
  }
  if (!Number.isFinite(deleteBy) || !Number.isFinite(finishedAt) || deleteBy <= finishedAt) {
    gateFailures.push('deleteBy must be a valid timestamp after finishedAt')
  } else {
    const retentionMilliseconds = retentionDays * 24 * 60 * 60 * 1000
    if (Number.isFinite(retentionMilliseconds) && deleteBy - finishedAt > retentionMilliseconds) {
      gateFailures.push('deleteBy exceeds the declared maximum evidence-retention period')
    }
    if (deleteBy <= Date.now()) gateFailures.push('deleteBy has passed while private evidence is still present')
  }
}

function validatePassOutcome(value) {
  if (!passLike(value.result)) gateFailures.push('result must be pass/passed for the M1 gate')
  for (const step of value.steps) {
    if (step.completed !== true) gateFailures.push(`step ${step.id} completed must be true`)
  }
  if (value.readOnlyTask.completed !== true || value.readOnlyTask.responseUseful !== true) gateFailures.push('the published read-only Quick Start task must complete with a useful response')
  if (value.readOnlyTask.projectPathRedacted !== true) gateFailures.push('readOnlyTask.projectPathRedacted must be true')
  if (numberField(value.readOnlyTask, 'mutationCount') !== 0) gateFailures.push('the first task must remain read-only with zero observed mutations')
  if (value.blockers.length > 0) gateFailures.push('blockers must be empty for a passed M1 record')
}

async function inspectEvidenceFiles(files, failures) {
  const summaries = []
  for (const item of files) {
    const inspected = await inspectFile(item.path, `evidenceFiles.${item.role}`, failures)
    if (inspected) summaries.push({ role: item.role, size: inspected.size, sha256: inspected.sha256 })
  }
  return summaries
}

async function inspectFile(filePath, label, failures) {
  const absolute = resolvePath(filePath)
  if (!existsSync(absolute)) {
    failures.push(`${label} does not exist`)
    return undefined
  }
  const canonical = realpathSync.native(absolute)
  const stat = lstatSync(absolute)
  if (!samePath(canonical, absolute) || stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) {
    failures.push(`${label} must be a non-empty regular file and not a symlink`)
    return undefined
  }
  return { size: stat.size, sha256: await sha256File(absolute) }
}

function samePath(left, right) {
  const normalizedLeft = path.normalize(left)
  const normalizedRight = path.normalize(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

function summarize(value, installer, evidenceFiles) {
  if (!isRecord(value)) return undefined
  return {
    gateId: stringField(value, 'gateId'),
    releaseTag: stringField(value, 'releaseTag'),
    platform: stringField(value, 'platform'),
    architecture: stringField(value, 'architecture'),
    providerProtocol: stringField(value, 'providerProtocol'),
    totalMinutes: numberField(value, 'totalMinutes'),
    result: stringField(value, 'result'),
    completedStepCount: Array.isArray(value.steps) ? value.steps.filter((step) => step?.completed === true).length : 0,
    securityBypassUsed: value.securityBypassUsed === true,
    operatorHelpUsed: value.operatorHelpUsed === true,
    evidenceGovernance: isRecord(value.evidenceGovernance) ? {
      purpose: stringField(value.evidenceGovernance, 'purpose'),
      maximumRetentionDays: numberField(value.evidenceGovernance, 'maximumRetentionDays'),
      redactionReviewCompleted: value.evidenceGovernance.redactionReviewCompleted === true,
      deletionStatus: stringField(value.evidenceGovernance, 'deletionStatus')
    } : undefined,
    installer: installer ? { name: stringField(value, 'installerAssetName'), ...installer } : undefined,
    evidenceFiles
  }
}

function findForbiddenKeys(value, prefix = '') {
  if (Array.isArray(value)) return value.forEach((item, index) => findForbiddenKeys(item, `${prefix}[${index}]`))
  if (!isRecord(value)) return
  const forbidden = /^(apiKey|token|secret|password|baseUrl|providerUrl|privateRepo|projectPath)$/i
  for (const [key, nested] of Object.entries(value)) {
    const field = prefix ? `${prefix}.${key}` : key
    if (forbidden.test(key)) schemaFailures.push(`${field} is forbidden in the M1 record`)
    findForbiddenKeys(nested, field)
  }
}

function determineStatus() {
  if (!recordPath && !required && !observation) return 'skipped'
  if (schemaFailures.length > 0) return 'failed'
  if (gateFailures.length === 0) return 'passed'
  return observation ? 'observed_failed' : 'failed'
}

function resolveRecordPath() {
  const candidate = argValue('--record') || process.env.CAOGEN_M1_FIRST_USER_RECORD
  return candidate ? resolvePath(candidate) : undefined
}

function readJson(filePath) {
  try {
    return { data: JSON.parse(readFileSync(filePath, 'utf8')) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
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

function requireString(value, key, prefix = '') {
  if (!stringField(value, key)) schemaFailures.push(`${prefix ? `${prefix}.` : ''}${key} must be a non-empty string`)
}

function requireBoolean(value, key, prefix = '') {
  if (typeof value?.[key] !== 'boolean') schemaFailures.push(`${prefix ? `${prefix}.` : ''}${key} must be boolean`)
}

function validateStringArray(value, key) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) schemaFailures.push(`${key} must be an array of non-empty strings`)
}

function normalizeSha256(value) {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase().replace(/^sha256:/, '')
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined
}

function passLike(value) {
  return typeof value === 'string' && ['pass', 'passed'].includes(value.trim().toLowerCase())
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  const inline = process.argv.find((item) => item.startsWith(`${name}=`))
  return inline ? inline.slice(name.length + 1) : undefined
}

function resolvePath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value, key) {
  return typeof value?.[key] === 'string' && value[key].trim() ? value[key].trim() : undefined
}

function numberField(value, key) {
  return typeof value?.[key] === 'number' ? value[key] : Number(value?.[key])
}
