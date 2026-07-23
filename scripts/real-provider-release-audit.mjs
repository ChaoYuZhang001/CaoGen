#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import path from 'node:path'

const SECRET_PATTERNS = [
  { name: 'provider-api-key', pattern: /(?<![A-Za-z0-9_])sk-(?:proj-|ant-api03-)?[A-Za-z0-9_-]{16,}/g },
  { name: 'github-token', pattern: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})/g },
  { name: 'aws-access-key', pattern: /(?<![A-Za-z0-9_])AKIA[0-9A-Z]{16}/g },
  { name: 'google-api-key', pattern: /(?<![A-Za-z0-9_])AIza[0-9A-Za-z_-]{20,}/g },
  { name: 'slack-token', pattern: /(?<![A-Za-z0-9_])xox[baprs]-[A-Za-z0-9-]{16,}/g },
  { name: 'authorization-value', pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  { name: 'jwt', pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g }
]
const RECORD_FIELDS = new Set([
  'schemaVersion',
  'candidateVersion',
  'gitCommit',
  'worktreeClean',
  'protocol',
  'redacted',
  'providerTarget',
  'sendPassed',
  'toolPassed',
  'artifactPassed',
  'recoveryPassed',
  'usagePassed',
  'billingPassed',
  'requestCount',
  'toolCallCount',
  'transcriptSha256',
  'artifactSha256',
  'recoverySha256',
  'startedAt',
  'sendCompletedAt',
  'toolCompletedAt',
  'artifactVerifiedAt',
  'recoveryVerifiedAt',
  'usageVerifiedAt',
  'billingVerifiedAt',
  'finishedAt'
])
const NON_PUBLIC_IPV4_RANGES = [
  ['0.0.0.0', '0.255.255.255'],
  ['10.0.0.0', '10.255.255.255'],
  ['100.64.0.0', '100.127.255.255'],
  ['127.0.0.0', '127.255.255.255'],
  ['169.254.0.0', '169.254.255.255'],
  ['172.16.0.0', '172.31.255.255'],
  ['192.0.0.0', '192.0.0.255'],
  ['192.0.2.0', '192.0.2.255'],
  ['192.88.99.0', '192.88.99.255'],
  ['192.168.0.0', '192.168.255.255'],
  ['198.18.0.0', '198.19.255.255'],
  ['198.51.100.0', '198.51.100.255'],
  ['203.0.113.0', '203.0.113.255'],
  ['224.0.0.0', '255.255.255.255']
].map(([start, end]) => [ipv4ToInteger(start), ipv4ToInteger(end)])

const repoRoot = process.cwd()
const required = process.argv.includes('--required') || process.env.CAOGEN_REAL_PROVIDER_RELEASE_AUDIT_REQUIRED === '1'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = resolvePath(
  argValue('--report-root')
    || process.env.CAOGEN_REAL_PROVIDER_RELEASE_REPORT_ROOT
    || 'test-results/real-provider-release'
)
const recordArgument = argValue('--record') || process.env.CAOGEN_REAL_PROVIDER_RELEASE_RECORD
const recordPath = recordArgument ? resolvePath(recordArgument) : undefined
const expectedCandidateVersion = readPackageVersion()
const expectedGitCommit = gitOutput(['rev-parse', 'HEAD'])
const failures = []
let record

if (!recordPath) {
  failures.push('missing real-provider release record; pass --record <path>')
} else if (!existsSync(recordPath)) {
  failures.push('real-provider release record does not exist')
} else {
  const loaded = readRecord(recordPath)
  if (loaded.error) {
    failures.push(`real-provider release record is not valid JSON: ${loaded.error}`)
  } else {
    record = loaded.data
    scanForSecrets(record, loaded.raw)
    validateRecord(record)
  }
}

const uniqueFailures = [...new Set(failures)]
const status = uniqueFailures.length === 0
  ? 'passed'
  : !required && !recordPath
    ? 'skipped'
    : 'failed'
const reportFile = path.join(reportRoot, `${runId}.json`)
const summary = summarizeRecord(record)
const report = {
  schemaVersion: 1,
  status,
  required,
  runId,
  reportFile: relativeToRepo(reportFile),
  recordProvided: Boolean(recordPath),
  recordSchema: 'docs/1.0-REAL-PROVIDER-RESULT.template.json',
  expectedCandidateVersion,
  expectedGitCommit,
  candidateVersion: summary?.candidateVersion,
  gitCommit: summary?.gitCommit,
  worktreeClean: summary?.worktreeClean,
  protocol: summary?.protocol,
  redacted: summary?.redacted,
  redactionPolicy: 'The report never stores request content, credentials, headers, Base URLs, or private provider targets; private targets must be represented by SHA-256.',
  summary,
  failures: uniqueFailures
}

mkdirSync(reportRoot, { recursive: true })
writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log(JSON.stringify(report, null, 2))
if (status === 'failed') process.exitCode = 1

function validateRecord(value) {
  if (!isRecord(value)) {
    failures.push('record must be a JSON object')
    return
  }

  for (const key of Object.keys(value)) {
    if (!RECORD_FIELDS.has(key)) failures.push('record contains a field not allowed by schema v1')
  }

  if (value.schemaVersion !== 1) failures.push('record.schemaVersion must equal 1')
  validateReleaseIdentity(value)
  validateProviderTarget(value.providerTarget)
  validateRequiredChecks(value)
  validateEvidenceFields(value)
  validateTimeline(value)
}

function validateReleaseIdentity(value) {
  const candidateVersion = requireString(value, 'candidateVersion')
  if (candidateVersion && candidateVersion !== expectedCandidateVersion) {
    failures.push(`record.candidateVersion must match package.json version ${expectedCandidateVersion}`)
  }

  const gitCommit = requireString(value, 'gitCommit')
  if (gitCommit && !/^[0-9a-f]{40}$/i.test(gitCommit)) {
    failures.push('record.gitCommit must be a full 40-character hexadecimal commit')
  } else if (gitCommit && gitCommit.toLowerCase() !== expectedGitCommit.toLowerCase()) {
    failures.push(`record.gitCommit must match current HEAD ${expectedGitCommit}`)
  }

  if (value.worktreeClean !== true) failures.push('record.worktreeClean must be true')
  if (value.protocol !== 'openai-compatible') failures.push('record.protocol must equal openai-compatible')
  if (value.redacted !== true) failures.push('record.redacted must be true')
}

function validateRequiredChecks(value) {
  for (const field of [
    'sendPassed',
    'toolPassed',
    'artifactPassed',
    'recoveryPassed',
    'usagePassed',
    'billingPassed'
  ]) {
    if (value[field] !== true) failures.push(`record.${field} must be true`)
  }
}

function validateEvidenceFields(value) {
  requirePositiveInteger(value, 'requestCount')
  requirePositiveInteger(value, 'toolCallCount')
  requireSha256(value, 'transcriptSha256')
  requireSha256(value, 'artifactSha256')
  requireSha256(value, 'recoverySha256')
}

function validateProviderTarget(value) {
  if (!isRecord(value)) {
    failures.push('record.providerTarget must be an object')
    return
  }

  const allowedFields = new Set(['kind', 'publicHttpsOrigin', 'sha256'])
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) failures.push('record.providerTarget contains a field not allowed by schema v1')
  }

  if (value.kind === 'public_https') {
    if (Object.hasOwn(value, 'sha256')) {
      failures.push('record.providerTarget.sha256 must be omitted for a public_https target')
    }
    validatePublicHttpsOrigin(value.publicHttpsOrigin)
    return
  }

  if (value.kind === 'sha256') {
    if (Object.hasOwn(value, 'publicHttpsOrigin')) {
      failures.push('record.providerTarget.publicHttpsOrigin must be omitted for a sha256 target')
    }
    if (!isSha256(value.sha256)) {
      failures.push('record.providerTarget.sha256 must use sha256:<64 hex> format')
    }
    return
  }

  failures.push('record.providerTarget.kind must equal public_https or sha256')
}

function validatePublicHttpsOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) {
    failures.push('record.providerTarget.publicHttpsOrigin must be a non-empty string')
    return
  }

  let url
  try {
    url = new URL(value)
  } catch {
    failures.push('record.providerTarget.publicHttpsOrigin must be a valid public HTTPS origin')
    return
  }

  if (url.protocol !== 'https:') {
    failures.push('record.providerTarget.publicHttpsOrigin must use HTTPS')
  }
  if (url.username || url.password) {
    failures.push('record.providerTarget.publicHttpsOrigin must not contain user information')
  }
  if (url.pathname !== '/' || url.search || url.hash || value !== url.origin) {
    failures.push('record.providerTarget.publicHttpsOrigin must contain only a normalized origin')
  }
  if (!isPublicHostname(url.hostname)) {
    failures.push('record.providerTarget.publicHttpsOrigin must name a public network target')
  }
}

function isPublicHostname(value) {
  const hostname = value.replace(/^\[|\]$/g, '').toLowerCase()
  if (!hostname || hostname === 'localhost') return false
  if (/\.(?:localhost|local|internal|home|lan|test|invalid|example)$/.test(hostname)) return false
  if (/^(?:.+\.)?example\.(?:com|net|org)$/.test(hostname)) return false

  const ipVersion = isIP(hostname)
  if (ipVersion === 4) return isPublicIpv4(hostname)
  if (ipVersion === 6) return isPublicIpv6(hostname)
  return hostname.includes('.')
}

function isPublicIpv4(value) {
  const address = ipv4ToInteger(value)
  return !NON_PUBLIC_IPV4_RANGES.some(([start, end]) => address >= start && address <= end)
}

function isPublicIpv6(value) {
  return /^[23][0-9a-f]{3}:/.test(value) && !/^2001:db8(?::|$)/.test(value)
}

function validateTimeline(value) {
  const fields = [
    'startedAt',
    'sendCompletedAt',
    'toolCompletedAt',
    'artifactVerifiedAt',
    'recoveryVerifiedAt',
    'usageVerifiedAt',
    'billingVerifiedAt',
    'finishedAt'
  ]
  const timestamps = fields.map((field) => parseTimestamp(value[field], `record.${field}`))
  for (let index = 1; index < timestamps.length; index += 1) {
    const previous = timestamps[index - 1]
    const current = timestamps[index]
    if (previous !== undefined && current !== undefined && current <= previous) {
      failures.push(`record.${fields[index]} must be after record.${fields[index - 1]}`)
    }
  }
}

function scanForSecrets(value, raw) {
  const forbiddenRawField = /"((?:[^"\\]|\\.)*)"\s*:/g
  let fieldMatch
  while ((fieldMatch = forbiddenRawField.exec(raw)) !== null) {
    const key = decodeJsonString(fieldMatch[1])
    if (key && isForbiddenCredentialField(key)) {
      failures.push('record contains a forbidden credential field')
    }
  }

  const secretKinds = new Set()
  visit(value)
  for (const { name, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(raw)) secretKinds.add(name)
  }
  for (const name of secretKinds) failures.push(`record contains a suspicious credential value (${name})`)

  function visit(item) {
    if (Array.isArray(item)) {
      for (const child of item) visit(child)
      return
    }
    if (isRecord(item)) {
      for (const [key, child] of Object.entries(item)) {
        if (isForbiddenCredentialField(key)) failures.push('record contains a forbidden credential field')
        visit(child)
      }
      return
    }
    if (typeof item !== 'string') return
    if (/^https?:\/\//i.test(item)) {
      try {
        const url = new URL(item)
        if (url.username || url.password || [...url.searchParams.keys()].some(isForbiddenCredentialField)) {
          failures.push('record contains credentials in a URL')
        }
      } catch {
        // Schema validation reports malformed public target URLs.
      }
    }
  }
}

function isForbiddenCredentialField(value) {
  const normalized = String(value).replace(/[^a-z0-9]/gi, '').toLowerCase()
  return normalized === 'key'
    || normalized.startsWith('key')
    || normalized.endsWith('key')
    || normalized.includes('apikey')
    || normalized.includes('token')
    || normalized.includes('header')
    || normalized.includes('baseurl')
    || normalized.includes('authorization')
    || normalized.includes('password')
    || normalized.includes('passwd')
    || normalized.includes('cookie')
    || normalized.includes('credential')
    || normalized.includes('privatekey')
    || normalized.includes('secretkey')
    || normalized.includes('secret')
}

function summarizeRecord(value) {
  if (!isRecord(value)) return undefined
  const target = isRecord(value.providerTarget) ? value.providerTarget : {}
  return {
    schemaVersion: value.schemaVersion === 1 ? 1 : undefined,
    candidateVersion: value.candidateVersion === expectedCandidateVersion ? expectedCandidateVersion : undefined,
    gitCommit: safeCommit(value.gitCommit),
    worktreeClean: value.worktreeClean === true,
    protocol: value.protocol === 'openai-compatible' ? value.protocol : undefined,
    redacted: value.redacted === true,
    providerTarget: summarizeTarget(target),
    checks: {
      send: value.sendPassed === true,
      tool: value.toolPassed === true,
      artifact: value.artifactPassed === true,
      recovery: value.recoveryPassed === true,
      usage: value.usagePassed === true,
      billing: value.billingPassed === true
    },
    requestCount: safePositiveInteger(value.requestCount),
    toolCallCount: safePositiveInteger(value.toolCallCount),
    transcriptSha256: safeSha256(value.transcriptSha256),
    artifactSha256: safeSha256(value.artifactSha256),
    recoverySha256: safeSha256(value.recoverySha256),
    startedAt: safeTimestamp(value.startedAt),
    finishedAt: safeTimestamp(value.finishedAt)
  }
}

function summarizeTarget(value) {
  if (value.kind === 'public_https' && isSafePublicOrigin(value.publicHttpsOrigin)) {
    return { kind: 'public_https', publicHttpsOrigin: value.publicHttpsOrigin }
  }
  if (value.kind === 'sha256' && isSha256(value.sha256)) {
    return { kind: 'sha256', sha256: value.sha256.toLowerCase() }
  }
  return { kind: 'invalid' }
}

function isSafePublicOrigin(value) {
  if (typeof value !== 'string' || containsSuspiciousSecret(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && url.pathname === '/'
      && !url.search
      && !url.hash
      && value === url.origin
      && isPublicHostname(url.hostname)
  } catch {
    return false
  }
}

function requireString(value, key) {
  const result = stringField(value, key)
  if (!result) failures.push(`record.${key} must be a non-empty string`)
  return result
}

function requirePositiveInteger(value, key) {
  if (!Number.isInteger(value[key]) || value[key] <= 0) {
    failures.push(`record.${key} must be an integer greater than 0`)
  }
}

function requireSha256(value, key) {
  if (!isSha256(value[key])) failures.push(`record.${key} must use sha256:<64 hex> format`)
}

function parseTimestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    failures.push(`${label} must be an ISO 8601 timestamp with timezone`)
    return undefined
  }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    failures.push(`${label} must be a valid timestamp`)
    return undefined
  }
  return timestamp
}

function readRecord(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8')
    return { raw, data: JSON.parse(raw), error: undefined }
  } catch (error) {
    return { raw: '', data: undefined, error: error instanceof Error ? error.message : String(error) }
  }
}

function readPackageVersion() {
  try {
    const value = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
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

function relativeToRepo(value) {
  const relative = path.relative(repoRoot, value)
  return relative && !relative.startsWith('..') ? relative : path.basename(value)
}

function decodeJsonString(value) {
  try {
    return JSON.parse(`"${value}"`)
  } catch {
    return undefined
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value, key) {
  return typeof value?.[key] === 'string' && value[key].trim() ? value[key].trim() : undefined
}

function isSha256(value) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/i.test(value)
}

function safeSha256(value) {
  return isSha256(value) ? value.toLowerCase() : undefined
}

function safeCommit(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : undefined
}

function safePositiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined
}

function safeTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value))
    ? value
    : undefined
}

function ipv4ToInteger(value) {
  return value.split('.').reduce((result, octet) => (result * 256) + Number(octet), 0)
}

function containsSuspiciousSecret(value) {
  return SECRET_PATTERNS.some(({ pattern }) => {
    pattern.lastIndex = 0
    return pattern.test(value)
  })
}
