#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  expectedMacosX64ReleaseAssets,
  macosX64ReleaseEvidenceChecks
} from './lib/macos-x64-release-evidence.mjs'

const version = '0.1.7'
const commit = 'a'.repeat(40)
const artifactSetSha256 = 'b'.repeat(64)
const assets = expectedMacosX64ReleaseAssets(version)
const provenance = {
  schemaVersion: 1,
  gitCommit: commit,
  worktreeClean: true,
  packageVersion: version
}
const criticalNames = [
  'app uses a Developer ID Application identity',
  'Gatekeeper accepts the app for execution',
  'the app has a valid stapled notarization ticket',
  'DMG detaches cleanly',
  'Claude Agent SDK and CLI are absent from packaged Mach-O files',
  'macOS x64 update metadata matches the signed assets'
]
const releaseChecks = criticalNames.map((name) => ({ name, status: 'passed' }))
const macosAudit = {
  status: 'passed',
  required: true,
  mode: 'post_build',
  platform: 'darwin',
  targetArch: 'x64',
  packageVersion: version,
  git: { commit, worktreeClean: true },
  summary: { total: releaseChecks.length, counts: { passed: releaseChecks.length, failed: 0 } },
  checks: releaseChecks,
  forbiddenRuntimeAudit: { count: 0, paths: [] },
  artifacts: { app: { architectures: ['x86_64'] } },
  archiveAudits: {
    dmg: { checks: { counts: { passed: 1, failed: 0 } } },
    zip: { checks: { counts: { passed: 1, failed: 0 } } }
  },
  artifactSetSha256,
  artifactSet: {
    complete: true,
    files: Object.fromEntries(assets.map((name) => [name, { size: 100, sha256: 'c'.repeat(64) }]))
  },
  buildProvenance: { app: provenance, dmg: provenance, zip: provenance }
}
const packagedApp = {
  status: 'passed',
  platform: 'darwin',
  targetArch: 'x64',
  packageVersion: version,
  git: { commit, worktreeClean: true },
  installation: { status: 'passed' },
  releaseAudit: { status: 'passed' },
  cleanup: { status: 'passed' },
  target: { type: 'page', title: 'CaoGen' },
  artifactSetSha256,
  buildProvenance: provenance
}
const deep = {
  status: 'pass',
  exitCode: 0,
  git: {
    commit,
    unchanged: true,
    start: { worktreeClean: true },
    end: { worktreeClean: true }
  },
  summary: {
    required: { total: 155, counts: { pass: 155 }, blocking: 0 }
  }
}
const p2 = {
  status: 'passed',
  required: true,
  packageVersion: version,
  git: {
    commit,
    unchanged: true,
    start: { worktreeClean: true },
    end: { worktreeClean: true }
  },
  failures: []
}

const validInput = {
  macosAudit,
  packagedApp,
  deep,
  p2,
  expectedVersion: version,
  candidateIsAncestor: true
}
assertAllPassed(macosX64ReleaseEvidenceChecks(validInput).checks)

const missingMetadata = structuredClone(macosAudit)
delete missingMetadata.artifactSet.files['latest-mac.yml']
assert.equal(checks({ macosAudit: missingMetadata }).artifactSetHasExactFiles, false)
assert.equal(checks({ p2: { ...p2, status: 'failed' } }).p2Passed, false)
assert.equal(
  checks({ deep: { ...deep, summary: { required: { total: 155, counts: { pass: 154 }, blocking: 0 } } } })
    .deepRequiredAllPassed,
  false
)
assert.equal(checks({ candidateIsAncestor: false }).candidateCommitIsCurrentOrAncestor, false)

const failedDetach = structuredClone(macosAudit)
failedDetach.checks.find((item) => item.name === 'DMG detaches cleanly').status = 'failed'
failedDetach.summary.counts = { passed: releaseChecks.length - 1, failed: 1 }
assert.equal(checks({ macosAudit: failedDetach }).macosAuditAllChecksPassed, false)
assert.equal(checks({ macosAudit: failedDetach }).macosAuditCriticalChecksPassed, false)

console.log('macOS x64 release evidence smoke: passed')

function checks(overrides = {}) {
  return macosX64ReleaseEvidenceChecks({ ...validInput, ...overrides }).checks
}

function assertAllPassed(result) {
  assert.deepEqual(Object.entries(result).filter(([, passed]) => !passed), [])
}
