#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = process.cwd()
const scriptPath = path.join(repoRoot, 'scripts', 'prepare-m1-first-user-drill.mjs')
const tempRoot = mkdtempSync(path.join(realpathSync(tmpdir()), 'caogen-m1-prep-'))

try {
  const evidenceDir = path.join(tempRoot, 'private-evidence')
  const prepared = run(['--evidence-dir', evidenceDir])
  assert.equal(prepared.status, 0, prepared.stderr)

  const output = JSON.parse(prepared.stdout)
  assert.equal(output.status, 'prepared')
  assert.equal(output.evidenceDir, evidenceDir)
  assert.deepEqual(output.releaseBinding, {
    releaseTag: 'v0.1.8',
    candidateCommit: '9a00bb92e1bed90a6dbf644790d4c253375cef4a',
    assetSha256: 'e0362fc3fda196259a5c6b782eedcf62cbf45eaaea36336bb3eba4afc617553d'
  })
  assert.deepEqual(readdirSync(evidenceDir).sort(), ['HOST-CHECKLIST.txt', 'm1-first-user.json'])

  if (process.platform !== 'win32') {
    assert.equal(lstatSync(evidenceDir).mode & 0o777, 0o700)
    assert.equal(lstatSync(output.recordPath).mode & 0o777, 0o600)
    assert.equal(lstatSync(output.checklistPath).mode & 0o777, 0o600)
  }

  const record = JSON.parse(readFileSync(output.recordPath, 'utf8'))
  assert.equal(record.result, 'not_run')
  assert.equal(record.schemaVersion, 2)
  assert.equal(record.evidenceGovernance.screenRecordingConsent, false)
  assert.equal(record.evidenceGovernance.maximumRetentionDays, 30)
  assert.equal(record.evidenceGovernance.redactionReviewCompleted, false)
  assert.equal(record.evidenceGovernance.deletionStatus, 'scheduled')
  assert.equal(record.evidenceGovernance.deletedAt, null)
  assert.equal(record.installerPath, path.join(evidenceDir, 'CaoGen-0.1.8.dmg'))
  assert.equal(record.evidenceFiles.length, 4)
  assert.equal(new Set(record.evidenceFiles.map((item) => item.path)).size, 4)
  assert.ok(record.evidenceFiles.every((item) => item.path.startsWith(`${evidenceDir}${path.sep}`)))
  assert.equal(readdirSync(evidenceDir).some((name) => name.endsWith('.dmg')), false)

  const checklist = readFileSync(output.checklistPath, 'utf8')
  assert.match(checklist, /tester must download the DMG through https:\/\/caogen\.dev\//)
  assert.match(checklist, /Do not commit, upload, or paste this directory/)
  assert.match(checklist, /record explicit consent/)
  assert.match(checklist, /Delete sooner after the audit/)
  assert.match(checklist, /Never claim deletion before/)
  assert.match(checklist, /test:m1-first-user-onboarding:required/)

  const rerun = run(['--evidence-dir', evidenceDir])
  assert.notEqual(rerun.status, 0)
  assert.match(rerun.stderr, /must be new or empty/)

  const relative = run(['--evidence-dir', 'relative-evidence'])
  assert.notEqual(relative.status, 0)
  assert.match(relative.stderr, /must be an absolute path/)

  const insideRepo = run(['--evidence-dir', path.join(repoRoot, 'test-results', 'm1-private')])
  assert.notEqual(insideRepo.status, 0)
  assert.match(insideRepo.stderr, /outside the CaoGen repository/)

  const nonEmptyDir = path.join(tempRoot, 'non-empty')
  mkdirSync(nonEmptyDir)
  writeFileSync(path.join(nonEmptyDir, 'keep.txt'), 'do not overwrite')
  const nonEmpty = run(['--evidence-dir', nonEmptyDir])
  assert.notEqual(nonEmpty.status, 0)
  assert.match(nonEmpty.stderr, /existing evidence is never overwritten/)
  assert.equal(readFileSync(path.join(nonEmptyDir, 'keep.txt'), 'utf8'), 'do not overwrite')

  const realDir = path.join(tempRoot, 'real-dir')
  const linkedDir = path.join(tempRoot, 'linked-dir')
  mkdirSync(realDir)
  symlinkSync(realDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir')
  const symlink = run(['--evidence-dir', linkedDir])
  assert.notEqual(symlink.status, 0)
  assert.match(symlink.stderr, /symbolic-link ancestor|not a file or symbolic link/)

  console.log('M1 first-user drill preparation smoke: pass')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function run(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
}
