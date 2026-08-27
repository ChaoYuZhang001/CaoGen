#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readSourceEvidenceState, sourceEvidenceDrift } from './lib/source-evidence-binding.mjs'

const root = mkdtempSync(path.join(tmpdir(), 'caogen-source-evidence-'))
const tracked = path.join(root, 'tracked.txt')
const renamed = path.join(root, 'renamed.txt')
const unusual = path.join(root, 'untracked\nname.txt')

try {
  git(['init', '--quiet'])
  git(['config', 'user.name', 'CaoGen Test'])
  git(['config', 'user.email', 'caogen-test@invalid.local'])
  writeFileSync(tracked, 'baseline\n')
  git(['add', 'tracked.txt'])
  git(['commit', '--quiet', '-m', 'fixture'])

  const clean = readSourceEvidenceState(root)
  assert.equal(clean.worktreeClean, true)
  assert.equal(clean.statusEntryCount, 0)

  writeFileSync(tracked, 'first change\n')
  const firstTracked = readSourceEvidenceState(root)
  writeFileSync(tracked, 'second change\n')
  const secondTracked = readSourceEvidenceState(root)
  assert.equal(firstTracked.statusEntryCount, 1)
  assert.notEqual(firstTracked.checkoutDigest, secondTracked.checkoutDigest)
  assert(sourceEvidenceDrift(firstTracked, secondTracked).includes('worktree contents changed during the run'))

  writeFileSync(tracked, 'baseline\n')
  writeFileSync(unusual, 'first untracked bytes\n')
  const firstUntracked = readSourceEvidenceState(root)
  writeFileSync(unusual, 'second untracked bytes\n')
  const secondUntracked = readSourceEvidenceState(root)
  assert.equal(firstUntracked.statusEntryCount, 1)
  assert.notEqual(firstUntracked.checkoutDigest, secondUntracked.checkoutDigest)
  rmSync(unusual)

  renameSync(tracked, renamed)
  git(['add', '-A'])
  const rename = readSourceEvidenceState(root)
  assert.equal(rename.statusEntryCount, 1, 'one Git rename must remain one status entry')
  assert.equal(rename.worktreeClean, false)
  console.log(JSON.stringify({ status: 'passed', checks: 10 }))
} finally {
  rmSync(root, { recursive: true, force: true })
}

function git(args) {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' })
}
