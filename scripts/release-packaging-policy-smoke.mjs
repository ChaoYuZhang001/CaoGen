#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import {
  requiresReleasePlatformMatrix,
  requiresTrustedMacDistribution,
  trustedMacDistributionChecks,
  trustedPackagedLaunchChecks,
  trustedWindowsDistributionChecks
} from './lib/release-packaging-policy.mjs'
import {
  releasePlatformArtifactNames,
  releasePlatformMatrixChecks
} from './lib/release-platform-matrix.mjs'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const { releaseProvenanceChecks } = require('./lib/release-provenance.cjs')
const timestampRetry = require('./macos-sign-with-retry.cjs')
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()

assert.equal(requiresTrustedMacDistribution('0.1.6'), false)
assert.equal(requiresTrustedMacDistribution('0.1.7'), true)
assert.equal(requiresTrustedMacDistribution('0.2.0'), true)
assert.equal(requiresTrustedMacDistribution('1.0.0'), true)
assert.equal(requiresTrustedMacDistribution('invalid'), false)
assert.equal(requiresReleasePlatformMatrix('0.1.6'), false)
assert.equal(requiresReleasePlatformMatrix('0.1.7'), true)

const artifactSetSha256 = 'a'.repeat(64)
const releaseVersion = '0.1.7'
const gitState = { commit, worktreeClean: true }
const buildProvenance = {
  schemaVersion: 1,
  gitCommit: commit,
  worktreeClean: true,
  packageVersion: releaseVersion
}
const passedAudit = {
  status: 'passed',
  required: true,
  mode: 'post_build',
  packageVersion: releaseVersion,
  targetArch: 'x64',
  platform: 'darwin',
  git: gitState,
  artifactSetSha256,
  buildProvenance: { app: buildProvenance }
}

assertAllPassed(trustedMacDistributionChecks({
  audit: passedAudit,
  releaseVersion,
  gitState,
  artifactSetSha256
}))

const failedNotarization = {
  ...passedAudit,
  status: 'failed',
  failures: ['app: the app has a valid stapled notarization ticket']
}
assert.equal(
  trustedMacDistributionChecks({ audit: failedNotarization, releaseVersion, gitState, artifactSetSha256 })
    .macosDistributionAuditPassed,
  false
)

const passedWindowsAudit = {
  status: 'passed',
  required: true,
  mode: 'post_build',
  packageVersion: releaseVersion,
  targetArch: 'x64',
  platform: 'win32',
  git: gitState,
  artifactSetSha256,
  buildProvenance: { app: buildProvenance },
  signing: {
    app: { status: 'Valid' },
    installer: { status: 'Valid' }
  }
}
assertAllPassed(trustedWindowsDistributionChecks({
  audit: passedWindowsAudit,
  releaseVersion,
  gitState
}))

const passedLaunch = {
  status: 'passed',
  installation: { status: 'passed' },
  packageVersion: releaseVersion,
  platform: 'darwin',
  targetArch: 'x64',
  git: gitState,
  artifactSetSha256,
  buildProvenance
}
assertAllPassed(trustedPackagedLaunchChecks({
  audit: passedLaunch,
  releaseVersion,
  gitState,
  platform: 'darwin',
  targetArch: 'x64',
  artifactSetSha256
}))
assert.equal(
  trustedPackagedLaunchChecks({
    audit: { ...passedLaunch, targetArch: 'arm64' },
    releaseVersion,
    gitState,
    platform: 'darwin',
    targetArch: 'x64',
    artifactSetSha256
  }).launchTargetArchMatches,
  false
)

const passedArmAudit = { ...passedAudit, targetArch: 'arm64' }
const passedArmLaunch = { ...passedLaunch, targetArch: 'arm64' }
const passedWindowsLaunch = { ...passedLaunch, platform: 'win32' }
assertAllPassed(releasePlatformMatrixChecks({
  releaseVersion,
  gitState,
  macosX64ArtifactSetSha256: artifactSetSha256,
  macosX64Audit: passedAudit,
  macosArm64Audit: passedArmAudit,
  windowsX64Audit: passedWindowsAudit,
  macosX64LaunchAudit: passedLaunch,
  macosArm64LaunchAudit: passedArmLaunch,
  windowsX64LaunchAudit: passedWindowsLaunch
}))
assert.equal(
  releasePlatformMatrixChecks({
    releaseVersion,
    gitState,
    macosX64ArtifactSetSha256: artifactSetSha256,
    macosX64Audit: passedAudit,
    macosArm64Audit: passedArmAudit,
    windowsX64Audit: null,
    macosX64LaunchAudit: passedLaunch,
    macosArm64LaunchAudit: passedArmLaunch,
    windowsX64LaunchAudit: null
  }).windowsX64DistributionAuditPassed,
  false
)
assert.deepEqual(releasePlatformArtifactNames(releaseVersion, 'windows-x64'), [
  `CaoGen Setup ${releaseVersion}.exe`,
  `CaoGen Setup ${releaseVersion}.exe.blockmap`,
  'latest.yml'
])

const staleBuild = {
  ...passedAudit,
  buildProvenance: { app: { ...buildProvenance, gitCommit: 'f'.repeat(40) } }
}
assert.equal(
  trustedMacDistributionChecks({ audit: staleBuild, releaseVersion, gitState, artifactSetSha256 })
    .macosDistributionBuildCommitMatches,
  false
)

assertAllPassed(releaseProvenanceChecks(buildProvenance, {
  gitCommit: commit,
  packageVersion: releaseVersion
}))
assert.equal(
  releaseProvenanceChecks({ ...buildProvenance, worktreeClean: false }, {
    gitCommit: commit,
    packageVersion: releaseVersion
  }).worktreeWasClean,
  false
)

const releaseConfigPath = path.join(repoRoot, 'electron-builder.release.cjs')
delete require.cache[releaseConfigPath]
const releaseConfig = require(releaseConfigPath)
assert.equal(releaseConfig.extraMetadata.caogenReleaseProvenance.schemaVersion, 1)
assert.equal(releaseConfig.extraMetadata.caogenReleaseProvenance.gitCommit, commit)
assert.equal(releaseConfig.extraMetadata.caogenReleaseProvenance.packageVersion, releaseVersion)
assert.equal(typeof releaseConfig.extraMetadata.caogenReleaseProvenance.worktreeClean, 'boolean')
assert.equal(releaseConfig.win.forceCodeSigning, true)
assert.deepEqual(releaseConfig.win.target, ['nsis'])
assert.equal(releaseConfig.mac.sign, 'scripts/macos-sign-with-retry.cjs')
assert.equal(timestampRetry.MAX_TIMESTAMP_ATTEMPTS, 5)
assert.equal(timestampRetry.isTimestampFailure(new Error('A timestamp was expected but was not found.')), true)
assert.equal(timestampRetry.isTimestampFailure(new Error('The specified item could not be found in the keychain.')), false)
let timestampAttempts = 0
const retryDelays = []
await timestampRetry.signWithTimestampRetry({}, async () => {
  timestampAttempts += 1
  if (timestampAttempts < 3) throw new Error('A timestamp was expected but was not found.')
}, {
  wait: async (delayMs) => retryDelays.push(delayMs),
  write: () => {}
})
assert.equal(timestampAttempts, 3)
assert.deepEqual(retryDelays, [5_000, 10_000])
let keychainAttempts = 0
await assert.rejects(
  timestampRetry.signWithTimestampRetry({}, async () => {
    keychainAttempts += 1
    throw new Error('The specified item could not be found in the keychain.')
  }, { wait: async () => {}, write: () => {} }),
  /keychain/
)
assert.equal(keychainAttempts, 1)

console.log('release packaging policy smoke: pass')

function assertAllPassed(checks) {
  assert.deepEqual(Object.entries(checks).filter(([, passed]) => !passed), [])
}
