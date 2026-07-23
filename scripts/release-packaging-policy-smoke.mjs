#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import {
  requiresTrustedMacDistribution,
  trustedMacDistributionChecks
} from './lib/release-packaging-policy.mjs'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const { releaseProvenanceChecks } = require('./lib/release-provenance.cjs')
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()

assert.equal(requiresTrustedMacDistribution('0.1.6'), false)
assert.equal(requiresTrustedMacDistribution('0.1.7'), true)
assert.equal(requiresTrustedMacDistribution('0.2.0'), true)
assert.equal(requiresTrustedMacDistribution('1.0.0'), true)
assert.equal(requiresTrustedMacDistribution('invalid'), false)

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

console.log('release packaging policy smoke: pass')

function assertAllPassed(checks) {
  assert.deepEqual(Object.entries(checks).filter(([, passed]) => !passed), [])
}
