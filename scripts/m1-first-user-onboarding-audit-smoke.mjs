#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-m1-first-user-'))
const scriptPath = path.join(repoRoot, 'scripts', 'm1-first-user-onboarding-audit.mjs')
const releaseTag = 'v0.1.7'
const candidateCommit = 'b'.repeat(40)
const installerPath = writeFixture('CaoGen-0.1.7.dmg', 'signed-intel-dmg-fixture')
const installerSha256 = sha256('signed-intel-dmg-fixture')
const baseArgs = [
  '--expected-release-tag', releaseTag,
  '--expected-candidate-commit', candidateCommit,
  '--expected-asset-sha256', installerSha256
]

try {
  const validRecord = makeRecord()
  const valid = runAudit('valid', validRecord, ['--required', ...baseArgs])
  assert.equal(valid.exitCode, 0)
  assert.equal(valid.report.status, 'passed')
  assert.equal(valid.report.summary.completedStepCount, 5)
  assert.equal(valid.report.summary.evidenceFiles.length, 4)
  assert.equal(valid.report.summary.installer.sha256, installerSha256)
  assert.equal(JSON.stringify(valid.report).includes(validRecord.testerId), false)
  assert.equal(JSON.stringify(valid.report).includes(installerPath), false)

  const failedObservationRecord = makeRecord()
  failedObservationRecord.result = 'fail'
  failedObservationRecord.totalMinutes = 37
  failedObservationRecord.finishedAt = '2026-07-26T09:37:00+08:00'
  failedObservationRecord.steps[4].completed = false
  failedObservationRecord.readOnlyTask.completed = false
  failedObservationRecord.readOnlyTask.responseUseful = false
  failedObservationRecord.blockers = ['Provider setup was unclear']
  const observation = runAudit('observation', failedObservationRecord, ['--observation', ...baseArgs])
  assert.equal(observation.exitCode, 0)
  assert.equal(observation.report.status, 'observed_failed')
  assert.match(observation.report.gateFailures.join('\n'), /totalMinutes must be <= 30/)
  assert.match(observation.report.gateFailures.join('\n'), /blockers must be empty/)
  assert.equal(JSON.stringify(observation.report).includes('Provider setup was unclear'), false)

  const requiredFailure = runAudit('required-failure', failedObservationRecord, ['--required', ...baseArgs])
  assert.equal(requiredFailure.exitCode, 1)
  assert.equal(requiredFailure.report.status, 'failed')

  const wrongHash = runAudit('wrong-hash', makeRecord(), [
    '--required',
    '--expected-release-tag', releaseTag,
    '--expected-candidate-commit', candidateCommit,
    '--expected-asset-sha256', 'a'.repeat(64)
  ])
  assert.equal(wrongHash.exitCode, 1)
  assert.match(wrongHash.report.gateFailures.join('\n'), /installer SHA-256/)

  const bypassRecord = makeRecord()
  bypassRecord.securityBypassUsed = true
  const bypass = runAudit('security-bypass', bypassRecord, ['--required', ...baseArgs])
  assert.equal(bypass.exitCode, 1)
  assert.match(bypass.report.gateFailures.join('\n'), /securityBypassUsed must be false/)

  const armRecord = makeRecord()
  armRecord.platform = 'macos-arm64'
  armRecord.architecture = 'arm64'
  const arm = runAudit('wrong-architecture', armRecord, ['--required', ...baseArgs])
  assert.equal(arm.exitCode, 1)
  assert.match(arm.report.gateFailures.join('\n'), /real macOS Intel x64 machine/)

  const secretRecord = makeRecord()
  secretRecord.apiKey = 'secret-for-smoke-m1-canary'
  const secret = runAudit('forbidden-secret-field', secretRecord, ['--required', ...baseArgs])
  assert.equal(secret.exitCode, 1)
  assert.match(secret.report.schemaFailures.join('\n'), /apiKey is forbidden/)
  assert.equal(JSON.stringify(secret.report).includes(secretRecord.apiKey), false)

  const symlinkRecord = makeRecord()
  const target = writeFixture('real-recording.txt', 'private-screen-recording')
  const link = path.join(tempRoot, 'recording-link.txt')
  symlinkSync(target, link)
  symlinkRecord.evidenceFiles[0].path = link
  const symlink = runAudit('symlink-evidence', symlinkRecord, ['--required', ...baseArgs])
  assert.equal(symlink.exitCode, 1)
  assert.match(symlink.report.schemaFailures.join('\n'), /not a symlink/)

  const missingBinding = runAudit('missing-binding', makeRecord(), ['--required'])
  assert.equal(missingBinding.exitCode, 1)
  assert.match(missingBinding.report.gateFailures.join('\n'), /expected release tag/)

  const duplicateEvidenceRecord = makeRecord()
  duplicateEvidenceRecord.evidenceFiles[1].path = duplicateEvidenceRecord.evidenceFiles[0].path
  const duplicateEvidence = runAudit('duplicate-evidence', duplicateEvidenceRecord, ['--required', ...baseArgs])
  assert.equal(duplicateEvidence.exitCode, 1)
  assert.match(duplicateEvidence.report.schemaFailures.join('\n'), /distinct file/)

  const missing = runWithoutRecord(['--report-root', path.join(tempRoot, 'missing-report')])
  assert.equal(missing.exitCode, 0)
  assert.equal(missing.report.status, 'skipped')

  const missingObservation = runWithoutRecord(['--observation', '--report-root', path.join(tempRoot, 'missing-observation-report')])
  assert.equal(missingObservation.exitCode, 1)
  assert.equal(missingObservation.report.status, 'failed')

  console.log('M1 first-user onboarding audit smoke: pass')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function makeRecord() {
  return {
    schemaVersion: 1,
    gateId: 'm1_first_user_onboarding',
    testerId: 'private-tester-001',
    projectContributor: false,
    previousCaoGenUser: false,
    releaseTag,
    releaseUrl: `https://github.com/ChaoYuZhang001/CaoGen/releases/tag/${releaseTag}`,
    websiteUrl: 'https://caogen.dev/',
    platform: 'macos-x64',
    architecture: 'x86_64',
    installedVersion: '0.1.7',
    installedCandidateCommit: candidateCommit,
    installerAssetName: 'CaoGen-0.1.7.dmg',
    installerPath,
    providerProtocol: 'openai-compatible',
    startedAt: '2026-07-26T09:00:00+08:00',
    finishedAt: '2026-07-26T09:12:00+08:00',
    totalMinutes: 12,
    result: 'pass',
    documentationUsed: 'quick_start_only',
    securityBypassUsed: false,
    operatorHelpUsed: false,
    steps: [
      { id: 1, name: 'open_website', completed: true, minutes: 1 },
      { id: 2, name: 'download_intel_dmg', completed: true, minutes: 2 },
      { id: 3, name: 'install_and_launch', completed: true, minutes: 3 },
      { id: 4, name: 'configure_provider', completed: true, minutes: 3 },
      { id: 5, name: 'complete_read_only_task', completed: true, minutes: 3 }
    ],
    readOnlyTask: {
      promptId: 'quick_start_project_read_only_v1',
      completed: true,
      responseUseful: true,
      mutationCount: 0,
      projectPathRedacted: true
    },
    evidenceFiles: [
      { role: 'screen_recording', path: writeFixture('screen-recording.txt', 'private-screen-recording') },
      { role: 'system_architecture', path: writeFixture('system-architecture.txt', 'x86_64') },
      { role: 'installed_app_identity', path: writeFixture('installed-app-identity.txt', `${releaseTag}:${candidateCommit}`) },
      { role: 'read_only_task', path: writeFixture('read-only-task.txt', 'completed-with-zero-mutations') }
    ],
    blockers: [],
    roughEdges: []
  }
}

function runAudit(name, record, args) {
  const recordPath = path.join(tempRoot, `${name}.json`)
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return runWithoutRecord([
    '--record', recordPath,
    '--report-root', path.join(tempRoot, `${name}-report`),
    ...args
  ])
}

function runWithoutRecord(args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, CAOGEN_M1_FIRST_USER_RECORD: '' }
  })
  assert.equal(result.error, undefined)
  assert.doesNotMatch(result.stderr, /private-tester|secret-for-smoke/)
  return { exitCode: result.status, report: JSON.parse(result.stdout) }
}

function writeFixture(name, contents) {
  const target = path.join(tempRoot, name)
  writeFileSync(target, contents, 'utf8')
  return target
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
