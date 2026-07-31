#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  publicationPreflightChecks,
  renderPublicationHandoff
} from './release-publication-preflight.mjs'
import { expectedMacosX64ReleaseAssets } from './lib/macos-x64-release-evidence.mjs'

const version = '0.1.7'
const tag = `v${version}`
const candidateCommit = 'a'.repeat(40)
const releaseCommit = 'b'.repeat(40)
const artifactSetSha256 = 'c'.repeat(64)
const expectedAssets = expectedMacosX64ReleaseAssets(version)
const valid = {
  version,
  packageVersion: version,
  lockVersion: version,
  rootLockVersion: version,
  githubRepo: 'ChaoYuZhang001/CaoGen',
  tag,
  candidateCommit,
  evidenceCommit: candidateCommit,
  currentCommit: releaseCommit,
  worktreeClean: true,
  candidateIsAncestor: true,
  descendantReadable: true,
  changedFiles: ['STATUS.md', 'docs/RELEASE-NOTES-FINAL.md'],
  remoteMainReadable: true,
  remoteMainCommit: releaseCommit,
  localTagExists: false,
  remoteTagReadable: true,
  remoteTagExists: false,
  githubReleaseStateReadable: true,
  githubReleaseExists: false,
  evidenceChecks: { identity: true, deep: true, signing: true },
  artifactChecks: { exactNames: true, exactSizes: true, exactHashes: true },
  artifactEntries: expectedAssets.map((name) => ({ name, isFile: true })),
  expectedAssets,
  notesAuditCommandPassed: true,
  artifactSetSha256,
  notesAudit: {
    status: 'passed',
    required: true,
    mode: 'final',
    platformScope: 'macos-x64',
    expectedVersion: version,
    artifactSetSha256,
    git: { commit: releaseCommit, worktreeClean: true },
    candidateEvidence: {
      commit: candidateCommit,
      checks: { candidateCommitIsCurrentOrAncestor: true, artifactSetHasExactFiles: true }
    },
    warnings: [],
    failures: []
  }
}

assertAllPassed(publicationPreflightChecks(valid))
assert.equal(checks({ changedFiles: ['src/main/index.ts'] }).descendantChangesArePublicationOnly, false)
assert.equal(checks({ remoteMainCommit: candidateCommit }).releaseCommitIsRemoteMain, false)
assert.equal(checks({ localTagExists: true }).localTagIsAbsent, false)
assert.equal(checks({ remoteTagExists: true }).remoteTagIsAbsent, false)
assert.equal(checks({ githubReleaseExists: true }).githubReleaseIsAbsent, false)
assert.equal(checks({ evidenceChecks: { deep: false } }).candidateEvidenceAllPassed, false)
assert.equal(checks({ artifactChecks: { exactHashes: false } }).artifactFilesAllMatched, false)
assert.equal(
  checks({ artifactEntries: [...valid.artifactEntries, { name: 'unexpected.zip', isFile: true }] })
    .artifactDirectoryHasExactAssets,
  false
)
assert.equal(
  checks({ notesAudit: { ...valid.notesAudit, git: { commit: candidateCommit, worktreeClean: true } } })
    .finalNotesAuditReleaseCommitMatches,
  false
)
assert.equal(
  checks({ notesAudit: { ...valid.notesAudit, warnings: ['stale'] } }).finalNotesAuditHasNoWarnings,
  false
)

const handoff = renderPublicationHandoff({
  version,
  tag,
  githubRepo: valid.githubRepo,
  remote: 'origin',
  releaseCommit,
  notesPath: '/repo/docs/RELEASE-NOTES-FINAL.md',
  distDir: '/candidate/dist',
  expectedAssets
})
assert.equal(handoff.requiresExplicitOwnerAuthorization, true)
assert.equal(handoff.executionMode, 'manual_after_authorization')
assert.equal(handoff.commands.length, 4)
assert.match(handoff.commands[0], /git tag --annotate/)
assert.match(handoff.commands[1], /git push/)
assert.match(handoff.commands[2], /gh release create/)
assert.match(handoff.commands[2], /--verify-tag/)
assert.match(handoff.commands[3], /--expected-assets-dir/)
for (const name of expectedAssets) assert(handoff.commands[2].includes(name))

const source = readFileSync(new URL('./release-publication-preflight.mjs', import.meta.url), 'utf8')
assert.match(source, /release-notes-audit\.mjs/)
assert.match(source, /macosX64ReleaseEvidenceChecks/)
assert.match(source, /artifactReportChecks/)
assert.match(source, /git', \['ls-remote'/)
assert.match(source, /'gh', \['api'/)
assert.match(source, /tagCreated: false/)
assert.match(source, /releaseCreated: false/)
assert.match(source, /assetsUploaded: false/)

console.log('release publication preflight smoke: passed')

function checks(overrides) {
  return publicationPreflightChecks({ ...valid, ...overrides })
}

function assertAllPassed(result) {
  assert.deepEqual(Object.entries(result).filter(([, passed]) => !passed), [])
}
