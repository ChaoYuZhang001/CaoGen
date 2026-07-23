#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import {
  artifactReportChecks,
  candidateIdentityChecks,
  macUpdateMetadataChecks,
  renderMacUpdateMetadata
} from './lib/release-matrix-evidence.mjs'

const repoRoot = process.cwd()
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'release-candidate-evidence.yml')
const source = readFileSync(workflowPath, 'utf8')
const workflow = yaml.load(source)
const triggers = workflow.on

assert.deepEqual(Object.keys(triggers), ['workflow_dispatch'], 'release workflow must be manual-only')
assert.deepEqual(workflow.permissions, { contents: 'read' }, 'workflow permissions must be read-only')
assert.equal(workflow.concurrency['cancel-in-progress'], false, 'an in-flight signing run must not be cancelled')
assert.match(workflow.concurrency.group, /inputs\.commit/, 'concurrency must be scoped to the candidate commit')
assert.deepEqual(Object.keys(workflow.jobs).sort(), ['aggregate', 'candidate', 'macos-arm64', 'macos-x64', 'windows-x64'])
assert.equal(workflow.jobs['macos-x64']['runs-on'], 'macos-15-intel')
assert.equal(workflow.jobs['macos-arm64']['runs-on'], 'macos-15-arm64')
assert.equal(workflow.jobs['windows-x64']['runs-on'], 'windows-2025')
assert.deepEqual(workflow.jobs.aggregate.needs, ['candidate', 'macos-x64', 'macos-arm64', 'windows-x64'])
assert(!/(^|\n)\s*(push|pull_request|schedule|release):/m.test(source), 'automatic or release triggers are forbidden')
assert(!/gh\s+release|create-release|softprops\/action-gh-release|contents:\s*write/i.test(source), 'workflow must not publish')
assert.match(source, /release-candidate-preflight\.mjs --commit/, 'candidate identity preflight is required')
assert.match(source, /npm run test:deep/, 'the exact candidate must run Deep')
assert.match(source, /npm run release:matrix:assemble/, 'cross-runner evidence must be independently assembled')
assert.match(source, /npm run test:release-packaging-audit:required/, 'the final 12-asset audit is required')
assert.match(source, /npm run test:product-positioning:required/, 'the candidate must revalidate public positioning')
assert.match(source, /npm run test:release-notes-audit:required/, 'the aggregate must produce a release-notes audit')
assert.match(source, /npm run test:github-release-audit:required/, 'the aggregate must audit current public releases')
assert.match(source, /Required release secret is missing/, 'missing signing secrets must fail closed')
for (const secret of [
  'MACOS_CERTIFICATE_P12_BASE64',
  'MACOS_CERTIFICATE_PASSWORD',
  'APPLE_API_KEY_P8',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'WINDOWS_CERTIFICATE_P12_BASE64',
  'WINDOWS_CERTIFICATE_PASSWORD'
]) {
  assert(source.includes(`secrets.${secret}`), `workflow must consume ${secret}`)
}
for (const action of allActions(workflow.jobs)) {
  assert.match(action, /^[^@]+@[0-9a-f]{40}$/i, `action must be pinned to a full commit: ${action}`)
}
const candidateStepNames = workflow.jobs.candidate.steps.map((step) => step.name)
assert(
  candidateStepNames.indexOf('Install exact dependencies') < candidateStepNames.indexOf('Verify candidate identity'),
  'the dependency-backed identity preflight must run after npm ci'
)

const validIdentity = candidateIdentityChecks({
  requestedCommit: 'a'.repeat(40),
  actualCommit: 'a'.repeat(40),
  requestedVersion: '0.1.7',
  packageVersion: '0.1.7',
  lockVersion: '0.1.7',
  rootLockVersion: '0.1.7',
  worktreeClean: true,
  commitOnMain: true
})
assert(Object.values(validIdentity).every(Boolean), 'valid candidate identity must pass')
assert.equal(candidateIdentityChecks({
  requestedCommit: 'main',
  actualCommit: 'a'.repeat(40),
  requestedVersion: '0.1.7',
  packageVersion: '0.1.7',
  lockVersion: '0.1.7',
  rootLockVersion: '0.1.7',
  worktreeClean: true,
  commitOnMain: true
}).requestedCommitIsFullSha, false, 'branch names must not satisfy candidate identity')

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-release-workflow-'))
try {
  for (const name of [
    'CaoGen-0.1.7-mac.zip',
    'CaoGen-0.1.7.dmg',
    'CaoGen-0.1.7-arm64-mac.zip',
    'CaoGen-0.1.7-arm64.dmg'
  ]) writeFileSync(path.join(tempRoot, name), `fixture:${name}\n`, 'utf8')
  const metadata = renderMacUpdateMetadata({
    version: '0.1.7',
    distDir: tempRoot,
    releaseDate: '2026-07-23T00:00:00.000Z'
  })
  const metadataChecks = macUpdateMetadataChecks(metadata, { version: '0.1.7', distDir: tempRoot })
  assert(Object.values(metadataChecks).every(Boolean), 'generated dual-architecture update metadata must verify')

  const artifactName = 'CaoGen-0.1.7.dmg'
  const artifactPath = path.join(tempRoot, artifactName)
  const artifactReport = {
    artifactSetSha256: 'b'.repeat(64),
    artifactSet: {
      complete: true,
      files: {
        [artifactName]: {
          size: readFileSync(artifactPath).length,
          sha256: createHash('sha256').update(readFileSync(artifactPath)).digest('hex')
        }
      }
    }
  }
  assert(Object.values(artifactReportChecks(artifactReport, [artifactName], tempRoot)).every(Boolean))
  writeFileSync(artifactPath, 'tampered\n', 'utf8')
  assert.equal(
    artifactReportChecks(artifactReport, [artifactName], tempRoot)[`artifact:${artifactName}:sha256`],
    false,
    'downloaded asset tampering must fail the evidence contract'
  )
  runMatrixAssemblyFixture(tempRoot)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function runMatrixAssemblyFixture(parentRoot) {
  const fixtureRoot = path.join(parentRoot, 'matrix-fixture')
  const inputRoot = path.join(fixtureRoot, 'test-results', 'release-matrix-input')
  mkdirSync(fixtureRoot, { recursive: true })
  writeFileSync(path.join(fixtureRoot, '.gitignore'), 'dist/\ntest-results/\n', 'utf8')
  writeJson(path.join(fixtureRoot, 'package.json'), { name: 'matrix-fixture', version: '0.1.7' })
  writeJson(path.join(fixtureRoot, 'package-lock.json'), {
    name: 'matrix-fixture',
    version: '0.1.7',
    lockfileVersion: 3,
    packages: { '': { name: 'matrix-fixture', version: '0.1.7' } }
  })
  execFileSync('git', ['init', '-q'], { cwd: fixtureRoot })
  execFileSync('git', ['config', 'user.name', 'CaoGen fixture'], { cwd: fixtureRoot })
  execFileSync('git', ['config', 'user.email', 'fixture@invalid.example'], { cwd: fixtureRoot })
  execFileSync('git', ['add', '.gitignore', 'package.json', 'package-lock.json'], { cwd: fixtureRoot })
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: fixtureRoot })
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixtureRoot, encoding: 'utf8' }).trim()

  const definitions = [
    {
      id: 'macos-x64',
      platform: 'darwin',
      arch: 'x64',
      names: ['CaoGen-0.1.7.dmg', 'CaoGen-0.1.7.dmg.blockmap', 'CaoGen-0.1.7-mac.zip', 'CaoGen-0.1.7-mac.zip.blockmap'],
      audit: 'macos-release-audit/latest-x64.json',
      launch: 'packaged-app-smoke/latest-macos-x64.json'
    },
    {
      id: 'macos-arm64',
      platform: 'darwin',
      arch: 'arm64',
      names: ['CaoGen-0.1.7-arm64.dmg', 'CaoGen-0.1.7-arm64.dmg.blockmap', 'CaoGen-0.1.7-arm64-mac.zip', 'CaoGen-0.1.7-arm64-mac.zip.blockmap'],
      audit: 'macos-release-audit/latest-arm64.json',
      launch: 'packaged-app-smoke/latest-macos-arm64.json'
    },
    {
      id: 'windows-x64',
      platform: 'win32',
      arch: 'x64',
      names: ['CaoGen Setup 0.1.7.exe', 'CaoGen Setup 0.1.7.exe.blockmap', 'latest.yml'],
      audit: 'windows-release-audit/latest-x64.json',
      launch: 'packaged-app-smoke/latest-windows-x64.json'
    }
  ]

  for (const definition of definitions) {
    const targetRoot = path.join(inputRoot, definition.id)
    for (const name of definition.names) {
      const filePath = path.join(targetRoot, 'dist', name)
      mkdirSync(path.dirname(filePath), { recursive: true })
      writeFileSync(filePath, `synthetic release fixture:${definition.id}:${name}\n`, 'utf8')
    }
    const artifactFiles = Object.fromEntries([...definition.names].sort().map((name) => {
      const filePath = path.join(targetRoot, 'dist', name)
      const key = definition.platform === 'win32' ? `dist/${name}` : name
      return [key, { size: statSync(filePath).size, sha256: digestFile(filePath) }]
    }))
    const artifactSetSha256 = createHash('sha256').update(JSON.stringify(artifactFiles)).digest('hex')
    const provenance = { gitCommit: commit, worktreeClean: true, packageVersion: '0.1.7' }
    const audit = {
      status: 'passed',
      required: true,
      mode: 'post_build',
      packageVersion: '0.1.7',
      targetArch: definition.arch,
      platform: definition.platform,
      git: { commit, worktreeClean: true, statusEntryCount: 0 },
      artifactSetSha256,
      artifactSet: { complete: true, missing: [], files: artifactFiles, artifactSetSha256 },
      buildProvenance: { app: provenance },
      ...(definition.platform === 'win32'
        ? { signing: { app: { status: 'Valid' }, installer: { status: 'Valid' } } }
        : {})
    }
    const launch = {
      status: 'passed',
      packageVersion: '0.1.7',
      platform: definition.platform,
      targetArch: definition.arch,
      git: { commit, worktreeClean: true, statusEntryCount: 0 },
      artifactSetSha256,
      buildProvenance: provenance,
      installation: { status: 'passed' }
    }
    writeJson(path.join(targetRoot, 'test-results', definition.audit), audit)
    writeJson(path.join(targetRoot, 'test-results', definition.launch), launch)
  }
  const asarPath = path.join(inputRoot, 'macos-x64', 'dist', 'mac', 'CaoGen.app', 'Contents', 'Resources', 'app.asar')
  mkdirSync(path.dirname(asarPath), { recursive: true })
  writeFileSync(asarPath, 'synthetic asar placeholder\n', 'utf8')
  writeJson(path.join(inputRoot, 'macos-x64', 'test-results', 'caogen-deep', 'latest.json'), {
    status: 'pass',
    exitCode: 0,
    git: {
      commit,
      unchanged: true,
      start: { commit, worktreeClean: true, statusEntryCount: 0 },
      end: { commit, worktreeClean: true, statusEntryCount: 0 }
    },
    summary: {
      required: { total: 1, counts: { pass: 1, skip: 0, blocked: 0, fail: 0 }, blocking: 0 }
    }
  })

  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts', 'release-matrix-assemble.mjs'),
    '--input', inputRoot,
    '--commit', commit,
    '--version', '0.1.7'
  ], { cwd: fixtureRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(result.status, 0, `matrix assembly fixture failed: ${result.stderr || result.stdout}`)
  const report = JSON.parse(readFileSync(path.join(fixtureRoot, 'test-results', 'release-matrix-assemble', 'latest.json'), 'utf8'))
  assert.equal(report.status, 'passed')
  assert.equal(Object.keys(report.artifacts.files).length, 12)
}

function digestFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

console.log('release workflow contract smoke: passed')

function allActions(jobs) {
  const result = []
  for (const job of Object.values(jobs)) {
    for (const step of job.steps || []) if (typeof step.uses === 'string') result.push(step.uses.replace(/\s+#.*$/, ''))
  }
  return result
}
