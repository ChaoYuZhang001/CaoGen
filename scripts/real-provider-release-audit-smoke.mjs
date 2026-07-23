#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-real-provider-release-'))
const scriptPath = path.join(repoRoot, 'scripts', 'real-provider-release-audit.mjs')
const candidateVersion = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version
const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()

try {
  checkValidHashedTarget()
  checkMissingField()
  checkCandidateBinding()
  checkSecretRejection()
  checkPublicTarget()
  checkInvalidPublicTarget()
  checkTimelineAndDigestValidation()
  checkOptionalMissing()
  checkRequiredMissing()
  console.log('real provider release audit smoke: pass')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function checkValidHashedTarget() {
  const recordPath = writeRecord('valid-hash.json', makeValidRecord())
  const reportRoot = path.join(tempRoot, 'valid-hash-report')
  const result = runAudit(['--required', '--record', recordPath, '--report-root', reportRoot])
  assert.equal(result.exitCode, 0)
  assert.equal(result.report.status, 'passed')
  assert.equal(result.report.candidateVersion, candidateVersion)
  assert.equal(result.report.gitCommit, gitCommit)
  assert.equal(result.report.worktreeClean, true)
  assert.equal(result.report.protocol, 'openai-compatible')
  assert.equal(result.report.redacted, true)
  assert.equal(result.report.summary.providerTarget.kind, 'sha256')
  assert.equal(result.report.summary.requestCount, 2)
  assert.equal(result.report.summary.toolCallCount, 1)
  assert.equal(existsSync(path.join(reportRoot, `${result.report.runId}.json`)), true)
  assert.deepEqual(readJson(path.join(reportRoot, 'latest.json')), result.report)
}

function checkMissingField() {
  const record = makeValidRecord()
  delete record.billingPassed
  const result = runRecordCase('missing-field', record)
  assert.equal(result.exitCode, 1)
  assert.equal(result.report.status, 'failed')
  assert.match(result.report.failures.join('\n'), /billingPassed must be true/)
}

function checkCandidateBinding() {
  const record = makeValidRecord()
  record.candidateVersion = '9.9.9'
  record.gitCommit = 'f'.repeat(40)
  const result = runRecordCase('wrong-identity', record)
  assert.equal(result.exitCode, 1)
  assert.match(result.report.failures.join('\n'), /candidateVersion must match package\.json version/)
  assert.match(result.report.failures.join('\n'), /gitCommit must match current HEAD/)
}

function checkSecretRejection() {
  const record = makeValidRecord()
  const syntheticCredential = ['sk', 'proj', 'secret-for-smoke-real-provider-canary'].join('-')
  record.apiKey = syntheticCredential
  const result = runRecordCase('secret', record)
  assert.equal(result.exitCode, 1)
  assert.match(result.report.failures.join('\n'), /forbidden credential field/)
  assert.match(result.report.failures.join('\n'), /suspicious credential value/)
  assert.equal(result.stdout.includes(syntheticCredential), false)
  assert.equal(JSON.stringify(result.report).includes(syntheticCredential), false)
}

function checkPublicTarget() {
  const record = makeValidRecord()
  record.providerTarget = {
    kind: 'public_https',
    publicHttpsOrigin: 'https://api.openai.com'
  }
  const result = runRecordCase('public-target', record)
  assert.equal(result.exitCode, 0)
  assert.equal(result.report.status, 'passed')
  assert.deepEqual(result.report.summary.providerTarget, record.providerTarget)
}

function checkInvalidPublicTarget() {
  const record = makeValidRecord()
  record.providerTarget = {
    kind: 'public_https',
    publicHttpsOrigin: 'http://127.0.0.1:8080'
  }
  const result = runRecordCase('private-http-target', record)
  assert.equal(result.exitCode, 1)
  assert.match(result.report.failures.join('\n'), /must use HTTPS/)
  assert.match(result.report.failures.join('\n'), /must name a public network target/)
}

function checkTimelineAndDigestValidation() {
  const record = makeValidRecord()
  record.recoverySha256 = 'sha256:not-a-digest'
  record.toolCompletedAt = record.sendCompletedAt
  const result = runRecordCase('bad-evidence', record)
  assert.equal(result.exitCode, 1)
  assert.match(result.report.failures.join('\n'), /recoverySha256 must use sha256/)
  assert.match(result.report.failures.join('\n'), /toolCompletedAt must be after record\.sendCompletedAt/)
}

function checkOptionalMissing() {
  const reportRoot = path.join(tempRoot, 'optional-missing-report')
  const result = runAudit(['--report-root', reportRoot])
  assert.equal(result.exitCode, 0)
  assert.equal(result.report.status, 'skipped')
  assert.equal(result.report.recordProvided, false)
  assert.deepEqual(readJson(path.join(reportRoot, 'latest.json')), result.report)
}

function checkRequiredMissing() {
  const reportRoot = path.join(tempRoot, 'required-missing-report')
  const result = runAudit(['--required', '--report-root', reportRoot])
  assert.equal(result.exitCode, 1)
  assert.equal(result.report.status, 'failed')
  assert.match(result.report.failures.join('\n'), /missing real-provider release record/)
  assert.deepEqual(readJson(path.join(reportRoot, 'latest.json')), result.report)
}

function makeValidRecord() {
  return {
    schemaVersion: 1,
    candidateVersion,
    gitCommit,
    worktreeClean: true,
    protocol: 'openai-compatible',
    redacted: true,
    providerTarget: {
      kind: 'sha256',
      sha256: `sha256:${'d'.repeat(64)}`
    },
    sendPassed: true,
    toolPassed: true,
    artifactPassed: true,
    recoveryPassed: true,
    usagePassed: true,
    billingPassed: true,
    requestCount: 2,
    toolCallCount: 1,
    transcriptSha256: `sha256:${'a'.repeat(64)}`,
    artifactSha256: `sha256:${'b'.repeat(64)}`,
    recoverySha256: `sha256:${'c'.repeat(64)}`,
    startedAt: '2026-07-20T01:00:00.000Z',
    sendCompletedAt: '2026-07-20T01:00:01.000Z',
    toolCompletedAt: '2026-07-20T01:00:02.000Z',
    artifactVerifiedAt: '2026-07-20T01:00:03.000Z',
    recoveryVerifiedAt: '2026-07-20T01:00:04.000Z',
    usageVerifiedAt: '2026-07-20T01:00:05.000Z',
    billingVerifiedAt: '2026-07-20T01:00:06.000Z',
    finishedAt: '2026-07-20T01:00:07.000Z'
  }
}

function runRecordCase(name, record) {
  const recordPath = writeRecord(`${name}.json`, record)
  return runAudit([
    '--required',
    '--record', recordPath,
    '--report-root', path.join(tempRoot, `${name}-report`)
  ])
}

function writeRecord(name, value) {
  const target = path.join(tempRoot, name)
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return target
}

function runAudit(args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      CAOGEN_REAL_PROVIDER_RELEASE_RECORD: '',
      CAOGEN_REAL_PROVIDER_RELEASE_AUDIT_REQUIRED: ''
    }
  })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null, result.stderr)
  assert(result.stdout.trim(), result.stderr)
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    report: JSON.parse(result.stdout)
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}
