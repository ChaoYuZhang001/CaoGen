#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  expectedMacosX64ReleaseAssets,
  macosX64ReleaseEvidenceChecks
} from './lib/macos-x64-release-evidence.mjs'
import { artifactReportChecks } from './lib/release-matrix-evidence.mjs'

const APPROVED_DESCENDANT_FILES = new Set([
  'README.md',
  'STATUS.md',
  'docs/PLAN.md',
  'docs/RELEASE-GATE-DRAFT.md',
  'docs/RELEASE-NOTES-FINAL.md'
])

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main()

function main() {
  const config = readPublicationConfig()
  const state = collectPublicationState(config)
  const checks = publicationPreflightChecks(buildCheckInput(config, state))
  const report = buildPublicationReport(config, state, checks)
  writeReport(config.repoRoot, report)
  console.log(JSON.stringify(report, null, 2))
  if (report.status !== 'passed') process.exitCode = 1
}

function readPublicationConfig() {
  const repoRoot = process.cwd()
  const artifactRoot = path.resolve(argValue('--artifact-root') || '')
  const candidateCommit = (argValue('--candidate-commit') || '').trim().toLowerCase()
  const packageJson = readJson(path.join(repoRoot, 'package.json')) || {}
  const packageLock = readJson(path.join(repoRoot, 'package-lock.json')) || {}
  const version = (argValue('--version') || packageJson.version || '').trim()
  return {
    repoRoot,
    artifactRoot,
    candidateCommit,
    candidateRunId: (argValue('--candidate-run') || '').trim(),
    remote: argValue('--remote') || 'origin',
    githubRepo: argValue('--repo') || 'ChaoYuZhang001/CaoGen',
    githubReleasesJson: argValue('--github-releases-json'),
    notesPath: path.resolve(argValue('--notes') || 'docs/RELEASE-NOTES-FINAL.md'),
    packageJson,
    packageLock,
    version,
    tag: `v${version}`,
    distDir: path.join(artifactRoot, 'dist'),
    evidencePaths: publicationEvidencePaths(artifactRoot)
  }
}

function collectPublicationState(config) {
  const readFailures = []
  const reports = Object.fromEntries(Object.entries(config.evidencePaths).map(([name, filePath]) => [
    name,
    readRequiredJson(filePath, name, readFailures)
  ]))
  const currentCommit = gitOutput(config.repoRoot, ['rev-parse', 'HEAD']).toLowerCase()
  const worktreeClean = gitOutput(config.repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']) === ''
  const candidateIsAncestor = gitIsAncestor(config.repoRoot, config.candidateCommit, currentCommit)
  const descendant = readDescendantChanges(config.repoRoot, config.candidateCommit, currentCommit)
  const remoteMain = readRemoteRef(config.repoRoot, config.remote, 'refs/heads/main')
  const remoteTag = readRemoteRef(config.repoRoot, config.remote, `refs/tags/${config.tag}`)
  const githubState = readGithubReleaseState(
    config.repoRoot,
    config.githubRepo,
    config.tag,
    config.githubReleasesJson
  )
  const evidence = macosX64ReleaseEvidenceChecks({
    macosAudit: reports.macosAudit,
    packagedApp: reports.packagedApp,
    deep: reports.deep,
    p2: reports.p2,
    expectedVersion: config.version,
    candidateIsAncestor
  })
  const expectedAssets = expectedMacosX64ReleaseAssets(config.version)
  return {
    reports,
    readFailures,
    currentCommit,
    worktreeClean,
    candidateIsAncestor,
    descendant,
    remoteMain,
    remoteTag,
    githubState,
    evidence,
    expectedAssets,
    artifactChecks: artifactReportChecks(reports.macosAudit, expectedAssets, config.distDir),
    artifactEntries: readDirectoryEntries(config.distDir),
    notesAudit: runFinalNotesAudit(config)
  }
}

function buildCheckInput(config, state) {
  return {
    version: config.version,
    packageVersion: config.packageJson.version,
    lockVersion: config.packageLock.version,
    rootLockVersion: config.packageLock.packages?.['']?.version,
    githubRepo: config.githubRepo,
    tag: config.tag,
    candidateCommit: config.candidateCommit,
    evidenceCommit: state.evidence.candidateCommit,
    currentCommit: state.currentCommit,
    worktreeClean: state.worktreeClean,
    candidateIsAncestor: state.candidateIsAncestor,
    descendantReadable: state.descendant.readable,
    changedFiles: state.descendant.files,
    remoteMainReadable: state.remoteMain.readable,
    remoteMainCommit: state.remoteMain.commit,
    localTagExists: gitRefExists(config.repoRoot, `refs/tags/${config.tag}`),
    remoteTagReadable: state.remoteTag.readable,
    remoteTagExists: Boolean(state.remoteTag.commit),
    githubReleaseStateReadable: state.githubState.readable,
    githubReleaseExists: state.githubState.exists,
    evidenceChecks: state.evidence.checks,
    artifactChecks: state.artifactChecks,
    artifactEntries: state.artifactEntries,
    expectedAssets: state.expectedAssets,
    notesAuditCommandPassed: state.notesAudit.commandPassed,
    notesAudit: state.notesAudit.report,
    artifactSetSha256: state.evidence.artifactSetSha256
  }
}

function buildPublicationReport(config, state, checks) {
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name)
  const failures = [...state.readFailures, ...state.notesAudit.failures, ...failedChecks]
  const status = failures.length === 0 ? 'passed' : 'failed'
  return {
    status,
    decision: status === 'passed' ? 'ready_for_owner_decision' : 'not_ready',
    runId: new Date().toISOString().replace(/[:.]/g, '-'),
    version: config.version,
    tag: config.tag,
    githubRepo: config.githubRepo,
    remote: config.remote,
    candidate: {
      commit: config.candidateCommit,
      runId: config.candidateRunId || null,
      artifactRoot: config.artifactRoot,
      artifactSetSha256: state.evidence.artifactSetSha256 || null
    },
    releaseCommit: state.currentCommit,
    notesPath: config.notesPath,
    changedFiles: state.descendant.files,
    approvedDescendantFiles: [...APPROVED_DESCENDANT_FILES].sort(),
    expectedAssets: state.expectedAssets,
    checks,
    sideEffects: {
      tagCreated: false,
      releaseCreated: false,
      assetsUploaded: false
    },
    handoff: status === 'passed'
      ? renderPublicationHandoff({
          version: config.version,
          tag: config.tag,
          githubRepo: config.githubRepo,
          remote: config.remote,
          releaseCommit: state.currentCommit,
          notesPath: config.notesPath,
          distDir: config.distDir,
          expectedAssets: state.expectedAssets
        })
      : null,
    redactionPolicy: 'No credential values are read or emitted. The preflight performs read-only checks and writes only test-results.',
    failures
  }
}

export function publicationPreflightChecks(input) {
  return {
    ...publicationIdentityChecks(input),
    ...publicationRemoteStateChecks(input),
    ...publicationEvidenceChecks(input),
    ...publicationNotesChecks(input)
  }
}

function publicationIdentityChecks(input) {
  return {
    requestedVersionIsStable: /^\d+\.\d+\.\d+$/.test(input.version || ''),
    packageVersionMatches: input.packageVersion === input.version,
    lockVersionMatches: input.lockVersion === input.version,
    rootLockVersionMatches: input.rootLockVersion === input.version,
    githubRepoIsValid: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.githubRepo || ''),
    releaseTagMatchesVersion: input.tag === `v${input.version}`,
    candidateCommitIsFullSha: /^[0-9a-f]{40}$/.test(input.candidateCommit || ''),
    evidenceCommitMatchesCandidate: input.evidenceCommit === input.candidateCommit,
    releaseCommitIsFullSha: /^[0-9a-f]{40}$/.test(input.currentCommit || ''),
    worktreeIsClean: input.worktreeClean === true,
    candidateIsReleaseAncestor: input.candidateIsAncestor === true,
    descendantChangesReadable: input.descendantReadable === true,
    descendantChangesArePublicationOnly: (input.changedFiles || []).every((file) => APPROVED_DESCENDANT_FILES.has(file))
  }
}

function publicationRemoteStateChecks(input) {
  return {
    remoteMainIsReadable: input.remoteMainReadable === true,
    releaseCommitIsRemoteMain: input.remoteMainCommit === input.currentCommit,
    localTagIsAbsent: input.localTagExists === false,
    remoteTagStateIsReadable: input.remoteTagReadable === true,
    remoteTagIsAbsent: input.remoteTagExists === false,
    githubReleaseStateIsReadable: input.githubReleaseStateReadable === true,
    githubReleaseIsAbsent: input.githubReleaseExists === false
  }
}

function publicationEvidenceChecks(input) {
  const evidenceValues = Object.values(input.evidenceChecks || {})
  const artifactValues = Object.values(input.artifactChecks || {})
  const expectedAssets = [...(input.expectedAssets || [])].sort()
  const actualAssets = (input.artifactEntries || [])
    .filter((entry) => entry.isFile)
    .map((entry) => entry.name)
    .sort()
  const allEntriesAreFiles = (input.artifactEntries || []).every((entry) => entry.isFile)
  return {
    candidateEvidenceChecksPresent: evidenceValues.length > 0,
    candidateEvidenceAllPassed: evidenceValues.length > 0 && evidenceValues.every(Boolean),
    artifactChecksPresent: artifactValues.length > 0,
    artifactFilesAllMatched: artifactValues.length > 0 && artifactValues.every(Boolean),
    artifactDirectoryContainsOnlyFiles: allEntriesAreFiles,
    artifactDirectoryHasExactAssets: JSON.stringify(actualAssets) === JSON.stringify(expectedAssets)
  }
}

function publicationNotesChecks(input) {
  const notesChecks = Object.values(input.notesAudit?.candidateEvidence?.checks || {})
  return {
    finalNotesAuditCommandPassed: input.notesAuditCommandPassed === true,
    finalNotesAuditPassed: input.notesAudit?.status === 'passed' && input.notesAudit?.required === true,
    finalNotesAuditIsMacosX64: input.notesAudit?.mode === 'final' && input.notesAudit?.platformScope === 'macos-x64',
    finalNotesAuditVersionMatches: input.notesAudit?.expectedVersion === input.version,
    finalNotesAuditReleaseCommitMatches: input.notesAudit?.git?.commit === input.currentCommit,
    finalNotesAuditWorktreeWasClean: input.notesAudit?.git?.worktreeClean === true,
    finalNotesAuditCandidateMatches: input.notesAudit?.candidateEvidence?.commit === input.candidateCommit,
    finalNotesAuditArtifactSetMatches: input.notesAudit?.artifactSetSha256 === input.artifactSetSha256,
    finalNotesAuditChecksPresent: notesChecks.length > 0,
    finalNotesAuditAllChecksPassed: notesChecks.length > 0 && notesChecks.every(Boolean),
    finalNotesAuditHasNoWarnings: Array.isArray(input.notesAudit?.warnings) && input.notesAudit.warnings.length === 0,
    finalNotesAuditHasNoFailures: Array.isArray(input.notesAudit?.failures) && input.notesAudit.failures.length === 0
  }
}

export function renderPublicationHandoff({
  version,
  tag,
  githubRepo,
  remote,
  releaseCommit,
  notesPath,
  distDir,
  expectedAssets
}) {
  const assetPaths = expectedAssets.map((name) => path.join(distDir, name))
  return {
    requiresExplicitOwnerAuthorization: true,
    executionMode: 'manual_after_authorization',
    commands: [
      `git tag --annotate ${shellQuote(tag)} ${shellQuote(releaseCommit)} --message ${shellQuote(`CaoGen ${tag}`)}`,
      `git push ${shellQuote(remote)} ${shellQuote(`refs/tags/${tag}`)}`,
      [
        'gh release create',
        shellQuote(tag),
        ...assetPaths.map(shellQuote),
        '--repo', shellQuote(githubRepo),
        '--title', shellQuote(`CaoGen ${tag}`),
        '--notes-file', shellQuote(notesPath),
        '--verify-tag'
      ].join(' '),
      [
        'npm run test:github-release-audit:read-text:required --',
        '--repo', shellQuote(githubRepo),
        '--tag', shellQuote(tag),
        '--expected-assets-dir', shellQuote(distDir)
      ].join(' ')
    ],
    expectedOutcome: `${tag} points to ${releaseCommit} and exposes exactly ${expectedAssets.length} hash-bound Intel assets`,
    version
  }
}

function publicationEvidencePaths(artifactRoot) {
  const resultRoot = path.join(artifactRoot, 'test-results')
  return {
    macosAudit: path.join(resultRoot, 'macos-release-audit', 'latest-x64.json'),
    packagedApp: path.join(resultRoot, 'packaged-app-smoke', 'latest-macos-x64.json'),
    deep: path.join(resultRoot, 'caogen-deep', 'latest.json'),
    p2: path.join(resultRoot, 'p2-release-scope', 'latest.json')
  }
}

function runFinalNotesAudit({ repoRoot, version, notesPath, evidencePaths }) {
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts', 'release-notes-audit.mjs'),
    '--required',
    '--final',
    '--platform-scope', 'macos-x64',
    '--version', version,
    '--notes', notesPath,
    '--macos-audit', evidencePaths.macosAudit,
    '--packaged-app', evidencePaths.packagedApp,
    '--deep', evidencePaths.deep,
    '--p2', evidencePaths.p2
  ], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    return {
      commandPassed: result.status === 0,
      report: JSON.parse(result.stdout),
      failures: result.status === 0 ? [] : ['finalNotesAuditCommand']
    }
  } catch {
    return {
      commandPassed: false,
      report: undefined,
      failures: ['finalNotesAuditOutputUnreadable']
    }
  }
}

function readGithubReleaseState(repoRoot, githubRepo, tag, fixturePath) {
  try {
    const text = fixturePath
      ? readFileSync(path.resolve(fixturePath), 'utf8')
      : execFileSync('gh', ['api', `repos/${githubRepo}/releases?per_page=100`], {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe']
        })
    const parsed = JSON.parse(text)
    const releases = Array.isArray(parsed) ? parsed : parsed?.releases
    if (!Array.isArray(releases)) return { readable: false, exists: false }
    return { readable: true, exists: releases.some((release) => release?.tag_name === tag) }
  } catch {
    return { readable: false, exists: false }
  }
}

function readRemoteRef(repoRoot, remote, ref) {
  try {
    const output = execFileSync('git', ['ls-remote', remote, ref], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    return { readable: true, commit: output.split(/\s+/)[0] || '' }
  } catch {
    return { readable: false, commit: '' }
  }
}

function readDescendantChanges(repoRoot, candidateCommit, currentCommit) {
  if (!/^[0-9a-f]{40}$/.test(candidateCommit) || !/^[0-9a-f]{40}$/.test(currentCommit)) {
    return { readable: false, files: [] }
  }
  try {
    const output = execFileSync('git', ['diff', '--name-only', `${candidateCommit}..${currentCommit}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    return { readable: true, files: output ? output.split(/\r?\n/).filter(Boolean) : [] }
  } catch {
    return { readable: false, files: [] }
  }
}

function readDirectoryEntries(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    isFile: entry.isFile()
  }))
}

function readRequiredJson(filePath, label, failures) {
  const value = readJson(filePath)
  if (!value) failures.push(`${label}EvidenceUnreadable`)
  return value
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return undefined
  }
}

function gitIsAncestor(repoRoot, ancestor, descendant) {
  if (!/^[0-9a-f]{40}$/.test(ancestor) || !/^[0-9a-f]{40}$/.test(descendant)) return false
  return spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: repoRoot,
    stdio: 'ignore'
  }).status === 0
}

function gitRefExists(repoRoot, ref) {
  return spawnSync('git', ['show-ref', '--verify', '--quiet', ref], {
    cwd: repoRoot,
    stdio: 'ignore'
  }).status === 0
}

function gitOutput(repoRoot, args) {
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

function writeReport(repoRoot, report) {
  const reportRoot = path.join(repoRoot, 'test-results', 'release-publication-preflight')
  const reportDir = path.join(reportRoot, report.runId)
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  const prefix = `${name}=`
  const inline = process.argv.find((item) => item.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : undefined
}
