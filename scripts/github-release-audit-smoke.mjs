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
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

console.log('GitHub release audit smoke: passed')

function releaseFixture() {
  return [{
    tag_name: tag,
    name: `CaoGen ${tag}`,
    html_url: `https://example.invalid/releases/${tag}`,
    draft: false,
    prerelease: false,
    published_at: '2026-07-25T00:00:00.000Z',
    body: 'Synthetic release audit fixture.',
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

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
