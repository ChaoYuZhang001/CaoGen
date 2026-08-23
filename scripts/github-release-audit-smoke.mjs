#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expectedMacosX64ReleaseAssets } from './lib/macos-x64-release-evidence.mjs'

const repoRoot = process.cwd()
const version = '0.1.7'
const tag = `v${version}`
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-github-release-audit-'))
const distDir = path.join(tempRoot, 'dist')
const fixturePath = path.join(tempRoot, 'releases.json')
const notesPath = path.join(tempRoot, 'RELEASE-NOTES-FINAL.md')
const expectedAssets = expectedMacosX64ReleaseAssets(version)

try {
  mkdirSync(distDir, { recursive: true })
  for (const name of expectedAssets) {
    const content = name === 'latest-mac.yml'
      ? `version: ${version}\npath: CaoGen-${version}-mac.zip\n`
      : `synthetic public asset fixture:${name}\n`
    writeFileSync(path.join(distDir, name), content, 'utf8')
  }

  const validFixture = releaseFixture()
  writeJson(fixturePath, validFixture)
  const valid = runAudit()
  assert.equal(valid.status, 0, valid.stderr || valid.stdout)
  assert.equal(valid.report.status, 'passed')
  assert.deepEqual(valid.report.expectedAssets, expectedAssets)
  assert.equal(Object.keys(valid.report.expectedAssetEvidence).length, 5)
  assert.deepEqual(valid.report.failures, [])

  const tamperedPath = path.join(distDir, expectedAssets[0])
  const original = readFileSync(tamperedPath, 'utf8')
  writeFileSync(tamperedPath, original.replace(/^./, 'X'), 'utf8')
  const tampered = runAudit()
  assert.notEqual(tampered.status, 0)
  assert(tampered.report.failures.some((failure) => failure.includes('public digest')))
  writeFileSync(tamperedPath, original, 'utf8')

  const missingDigestFixture = releaseFixture()
  missingDigestFixture[0].assets[0].digest = null
  writeJson(fixturePath, missingDigestFixture)
  const missingDigest = runAudit()
  assert.notEqual(missingDigest.status, 0)
  assert(missingDigest.report.failures.some((failure) => failure.includes('public digest missing')))

  writeJson(fixturePath, releaseFixture())
  writeFileSync(path.join(distDir, '.env'), 'SYNTHETIC_FIXTURE_ONLY=yes\n', 'utf8')
  const unexpected = runAudit()
  assert.notEqual(unexpected.status, 0)
  assert(unexpected.report.failures.some((failure) => failure.includes('unapproved file: .env')))
  rmSync(path.join(distDir, '.env'))

  const notesBody = renderReleaseNotes()
  writeFileSync(notesPath, notesBody, 'utf8')
  writeJson(fixturePath, releaseFixture(notesBody))
  const notesValid = runNotesAudit()
  assert.equal(notesValid.status, 0, notesValid.stderr || notesValid.stdout)
  assert.equal(notesValid.report.tagFilter, tag)
  assert.equal(notesValid.report.releaseNotesContract.assetCount, 5)
  assert.equal(notesValid.report.checkedReleases[0].releaseNotesBodyMatches, true)

  const extraAssetFixture = releaseFixture(notesBody)
  extraAssetFixture[0].assets.push({
    name: 'latest.yml',
    size: 32,
    state: 'uploaded',
    content_type: 'text/yaml',
    digest: `sha256:${'f'.repeat(64)}`,
    textContent: `version: ${version}\n`,
    url: '',
    browser_download_url: ''
  })
  writeJson(fixturePath, extraAssetFixture)
  const extraAsset = runNotesAudit()
  assert.notEqual(extraAsset.status, 0)
  assert(extraAsset.report.failures.some((failure) => failure.includes('must exactly match release notes contract')))

  writeJson(fixturePath, releaseFixture(`${notesBody}\nRemote-only edit.\n`))
  const changedBody = runNotesAudit()
  assert.notEqual(changedBody.status, 0)
  assert(changedBody.report.failures.some((failure) => failure.includes('release notes body does not match')))

  const changedDigestFixture = releaseFixture(notesBody)
  changedDigestFixture[0].assets[0].digest = `sha256:${'e'.repeat(64)}`
  writeJson(fixturePath, changedDigestFixture)
  const changedDigest = runNotesAudit()
  assert.notEqual(changedDigest.status, 0)
  assert(changedDigest.report.failures.some((failure) => failure.includes('public digest')))

  writeFileSync(notesPath, notesBody.replace(/\| `latest-mac\.yml` \|.*\n/, ''), 'utf8')
  writeJson(fixturePath, releaseFixture(notesBody))
  const incompleteNotes = runNotesAudit()
  assert.notEqual(incompleteNotes.status, 0)
  assert(incompleteNotes.report.failures.some((failure) => failure.includes('must contain the same names')))

  writeJson(fixturePath, historicalReleaseFixture())
  const historical = runHistoricalAudit()
  assert.equal(historical.status, 0, historical.stderr || historical.stdout)
  assert.equal(historical.report.status, 'passed')
  assert.deepEqual(historical.report.failures, [])
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

console.log('GitHub release audit smoke: passed')

function releaseFixture(body = 'Synthetic release audit fixture.') {
  return [{
    tag_name: tag,
    name: `CaoGen ${tag}`,
    html_url: `https://example.invalid/releases/${tag}`,
    draft: false,
    prerelease: false,
    published_at: '2026-07-25T00:00:00.000Z',
    body,
    assets: expectedAssets.map((name) => {
      const filePath = path.join(distDir, name)
      return {
        name,
        size: statSync(filePath).size,
        state: 'uploaded',
        content_type: name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream',
        digest: `sha256:${sha256(filePath)}`,
        url: '',
        browser_download_url: '',
        ...(name === 'latest-mac.yml' ? { textContent: readFileSync(filePath, 'utf8') } : {})
      }
    })
  }]
}

function renderReleaseNotes() {
  const assetLines = expectedAssets.map((name) => `- \`${name}\``).join('\n')
  const digestLines = expectedAssets.map((name) => `| \`${name}\` | \`${sha256(path.join(distDir, name))}\` |`).join('\n')
  return `# CaoGen ${tag} Release Notes

## Release Decision

Synthetic fixture for the approved release contract.

## Uploaded Assets

${assetLines}

### SHA256

| Asset | SHA256 |
|---|---|
${digestLines}

## Truth Boundary

Synthetic fixture only.
`
}

function runAudit() {
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts', 'github-release-audit.mjs'),
    '--required',
    '--read-text-assets',
    '--repo', 'ChaoYuZhang001/CaoGen',
    '--tag', tag,
    '--json', fixturePath,
    '--expected-assets-dir', distDir
  ], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    report: JSON.parse(result.stdout)
  }
}

function runNotesAudit() {
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts', 'github-release-audit.mjs'),
    '--required',
    '--read-text-assets',
    '--repo', 'ChaoYuZhang001/CaoGen',
    '--json', fixturePath,
    '--expected-assets-from-notes', notesPath
  ], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    report: JSON.parse(result.stdout)
  }
}

function runHistoricalAudit() {
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts', 'github-release-audit.mjs'),
    '--required',
    '--repo', 'ChaoYuZhang001/CaoGen',
    '--json', fixturePath
  ], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    report: JSON.parse(result.stdout)
  }
}

function historicalReleaseFixture() {
  const asset = (name) => ({
    name,
    size: 32,
    state: 'uploaded',
    content_type: 'application/octet-stream',
    digest: `sha256:${'a'.repeat(64)}`,
    url: '',
    browser_download_url: ''
  })
  return [
    {
      tag_name: 'v0.1.8-windows-preview',
      name: 'CaoGen v0.1.8 Windows preview',
      html_url: 'https://example.invalid/releases/v0.1.8-windows-preview',
      draft: false,
      prerelease: true,
      published_at: '2026-08-01T00:00:00.000Z',
      body: 'Historical preview fixture.',
      assets: [
        asset('CaoGen-0.1.8-windows-x64-unsigned-preview.exe'),
        asset('CaoGen-0.1.8-windows-x64-unsigned-preview.exe.blockmap'),
        asset('SHA256SUMS.txt')
      ]
    },
    {
      tag_name: 'v0.1.7',
      name: 'CaoGen v0.1.7',
      html_url: 'https://example.invalid/releases/v0.1.7',
      draft: false,
      prerelease: false,
      published_at: '2026-07-25T00:00:00.000Z',
      body: 'Historical release fixture.',
      assets: [
        asset('CaoGen-Setup-0.1.7.exe'),
        asset('CaoGen-Setup-0.1.7.exe.blockmap')
      ]
    }
  ]
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
