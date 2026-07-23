#!/usr/bin/env node
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-1-0-soak-'))
const scriptPath = path.join(repoRoot, 'scripts', 'product-1.0-soak-audit.mjs')
const doctorScriptPath = path.join(repoRoot, 'scripts', 'workos-release-doctor.mjs')

try {
  const validPath = writeRecord('valid.json', makeValidRecord())
  const valid = runAudit(['--required', '--version', '1.0.0', '--record', validPath, '--no-waiver', '--report-root', path.join(tempRoot, 'valid-report')])
  assert.equal(valid.exitCode, 0)
  assert.equal(valid.report.status, 'passed')
  assert.equal(valid.report.summary.dayCount, 7)
  assert.equal(valid.report.summary.totalMinutes, 420)

  const changedCandidate = makeValidRecord()
  changedCandidate.days[4].artifactSetDigest = `sha256:${'b'.repeat(64)}`
  const changedPath = writeRecord('changed.json', changedCandidate)
  const changed = runAudit(['--required', '--version', '1.0.0', '--record', changedPath, '--no-waiver', '--report-root', path.join(tempRoot, 'changed-report')])
  assert.equal(changed.exitCode, 1)
  assert.equal(changed.report.status, 'failed')
  assert.match(changed.report.failures.join('\n'), /must match the frozen candidate/)

  const dataLoss = makeValidRecord()
  dataLoss.days[2].assetLossCount = 1
  const lossPath = writeRecord('loss.json', dataLoss)
  const loss = runAudit(['--required', '--version', '1.0.0', '--record', lossPath, '--no-waiver', '--report-root', path.join(tempRoot, 'loss-report')])
  assert.equal(loss.exitCode, 1)
  assert.match(loss.report.failures.join('\n'), /assetLossCount must be 0/)

  const validWaiverPath = writeRecord('valid-waiver.json', makeValidWaiver())
  const validWaiver = runAudit(['--required', '--version', '1.0.0', '--waiver', validWaiverPath, '--report-root', path.join(tempRoot, 'valid-waiver-report')])
  assert.equal(validWaiver.exitCode, 0)
  assert.equal(validWaiver.report.status, 'waived')
  assert.equal(validWaiver.report.decision, 'owner_waiver')
  assert.equal(validWaiver.report.waiver.releaseVersion, '1.0.0')
  assert.equal(validWaiver.report.waiver.appliesToFutureVersions, false)

  const futureVersion = runAudit(['--required', '--version', '1.0.1', '--waiver', validWaiverPath, '--report-root', path.join(tempRoot, 'future-version-report')])
  assert.equal(futureVersion.exitCode, 1)
  assert.equal(futureVersion.report.status, 'failed')
  assert.match(futureVersion.report.failures.join('\n'), /valid only.*exactly 1\.0\.0/)

  const ownerlessWaiver = makeValidWaiver()
  ownerlessWaiver.owner = ''
  const ownerlessWaiverPath = writeRecord('ownerless-waiver.json', ownerlessWaiver)
  const ownerless = runAudit(['--required', '--version', '1.0.0', '--waiver', ownerlessWaiverPath, '--report-root', path.join(tempRoot, 'ownerless-report')])
  assert.equal(ownerless.exitCode, 1)
  assert.match(ownerless.report.failures.join('\n'), /waiver\.owner must be a non-empty string/)

  const genericWaiver = makeValidWaiver()
  genericWaiver.scope = 'all_1_x_releases'
  genericWaiver.appliesToFutureVersions = true
  const genericWaiverPath = writeRecord('generic-waiver.json', genericWaiver)
  const generic = runAudit(['--required', '--version', '1.0.0', '--waiver', genericWaiverPath, '--report-root', path.join(tempRoot, 'generic-report')])
  assert.equal(generic.exitCode, 1)
  assert.match(generic.report.failures.join('\n'), /exact_release_version_only/)
  assert.match(generic.report.failures.join('\n'), /appliesToFutureVersions must be false/)

  const missing = runAudit(['--no-waiver', '--report-root', path.join(tempRoot, 'missing-report')])
  assert.equal(missing.exitCode, 0)
  assert.equal(missing.report.status, 'skipped')

  const doctorRoot = path.join(tempRoot, 'doctor')
  mkdirSync(path.join(doctorRoot, 'test-results', 'product-1.0-soak-audit'), { recursive: true })
  mkdirSync(path.join(doctorRoot, 'docs'), { recursive: true })
  mkdirSync(path.join(doctorRoot, 'scripts'), { recursive: true })
  writeFileSync(path.join(doctorRoot, 'package.json'), `${JSON.stringify({ name: 'doctor-fixture', version: '1.0.0' })}\n`, 'utf8')
  writeFileSync(path.join(doctorRoot, 'docs', '1.0-SOAK-WAIVER.json'), `${JSON.stringify(makeValidWaiver(), null, 2)}\n`, 'utf8')
  copyFileSync(scriptPath, path.join(doctorRoot, 'scripts', 'product-1.0-soak-audit.mjs'))
  writeFileSync(
    path.join(doctorRoot, 'test-results', 'product-1.0-soak-audit', 'latest.json'),
    `${JSON.stringify(validWaiver.report, null, 2)}\n`,
    'utf8'
  )

  const doctor1_0_0 = runDoctor(doctorRoot, '1.0.0')
  const waivedDomain = doctor1_0_0.domains.find((domain) => domain.id === 'product_1_0_soak')
  assert.equal(waivedDomain.status, 'waived')
  assert.equal(waivedDomain.blocking, false)
  assert.equal(waivedDomain.acceptedBy, 'version_scoped_owner_waiver')
  assert.deepEqual(doctor1_0_0.waivedDomains, ['product_1_0_soak'])
  assert.equal(doctor1_0_0.openDomains.includes('product_1_0_soak'), false)

  const doctor1_0_1 = runDoctor(doctorRoot, '1.0.1')
  const rejectedDomain = doctor1_0_1.domains.find((domain) => domain.id === 'product_1_0_soak')
  assert.equal(rejectedDomain.status, 'open')
  assert.notEqual(rejectedDomain.blocking, false)
  assert.equal(doctor1_0_1.openDomains.includes('product_1_0_soak'), true)
  assert.equal(rejectedDomain.waiverChecks.releaseVersionIsExactly1_0_0, false)

  const refreshedDoctor = runDoctor(doctorRoot, '1.0.0', ['--refresh'])
  const refreshResult = refreshedDoctor.refresh.commands.find((item) => item.id === 'product_1_0_soak_audit')
  const refreshedDomain = refreshedDoctor.domains.find((domain) => domain.id === 'product_1_0_soak')
  assert.equal(refreshResult.status, 'completed')
  assert.equal(refreshedDomain.status, 'waived')
  assert.equal(refreshedDomain.blocking, false)

  console.log('product 1.0 soak audit smoke: pass')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function makeValidWaiver() {
  return {
    schemaVersion: 1,
    gateId: 'product_1_0_soak',
    decision: 'waive',
    releaseVersion: '1.0.0',
    scope: 'exact_release_version_only',
    owner: 'CaoGen release owner',
    decidedAt: '2026-07-22T00:00:00+08:00',
    decisionSource: 'Direct release-owner instruction recorded on 2026-07-22',
    reason: 'The release owner explicitly chose not to wait for the seven-day soak for 1.0.0.',
    acceptedRisk: 'Long-duration-only defects may require rollback or a hotfix.',
    approvedByOwner: true,
    riskAccepted: true,
    appliesToFutureVersions: false,
    expiresAfterReleaseVersion: '1.0.0',
    substituteEvidence: ['full required Deep test on the exact release candidate']
  }
}

function makeValidRecord() {
  const candidateVersion = '1.0.0'
  const gitCommit = '21051cab68632a5f92fd70d204a15b2e115801b0'
  const artifactSetDigest = `sha256:${'a'.repeat(64)}`
  const days = Array.from({ length: 7 }, (_, index) => ({
    date: `2026-07-${String(index + 1).padStart(2, '0')}`,
    candidateVersion,
    gitCommit,
    artifactSetDigest,
    minutes: 60,
    workflows: ['daily-primary-workflow'],
    launchPassed: true,
    assetLossCount: 0,
    duplicateHighRiskEffectCount: 0,
    unresolvedBlockingDefectCount: 0,
    defects: []
  }))
  return {
    schemaVersion: 1,
    candidateVersion,
    gitCommit,
    artifactSetDigest,
    platform: 'macos-x64',
    timezone: 'Asia/Shanghai',
    startedAt: '2026-07-01T09:00:00+08:00',
    finishedAt: '2026-07-07T18:00:00+08:00',
    featureFrozen: true,
    resetCount: 0,
    result: 'pass',
    zeroDataLoss: true,
    zeroDuplicateHighRiskEffects: true,
    evidenceRoot: '/private/caogen-1.0-soak',
    days
  }
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
    env: { ...process.env, CAOGEN_1_0_SOAK_RECORD: '' }
  })
  assert.equal(result.error, undefined)
  return {
    exitCode: result.status,
    report: JSON.parse(result.stdout)
  }
}

function runDoctor(cwd, version, extraArgs = []) {
  const result = spawnSync(process.execPath, [doctorScriptPath, '--version', version, ...extraArgs], {
    cwd,
    encoding: 'utf8'
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}
