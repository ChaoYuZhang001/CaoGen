#!/usr/bin/env node

import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  BUILD_EVIDENCE_FILE,
  REQUIRED_BUILD_ENTRIES,
  snapshotBuildOutput,
  validateBuildOutput,
  verifyBuildEvidence
} from './lib/build-evidence.mjs'

const root = mkdtempSync(path.join(tmpdir(), 'caogen-build-evidence-'))
const outRoot = path.join(root, 'out')
const source = {
  commit: 'a'.repeat(40),
  worktreeClean: true,
  statusEntryCount: 0,
  checkoutDigest: 'b'.repeat(64)
}

try {
  for (const relativePath of REQUIRED_BUILD_ENTRIES) {
    const target = path.join(outRoot, relativePath)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, `fixture:${relativePath}\n`, 'utf8')
  }
  assert.deepEqual(validateBuildOutput(root), [])

  const output = snapshotBuildOutput(root)
  writeFileSync(path.join(outRoot, BUILD_EVIDENCE_FILE), `${JSON.stringify({
    schemaVersion: 1,
    kind: 'caogen-build-evidence',
    status: 'passed',
    source: { status: 'pass', start: source, end: source, drift: [] },
    output,
    outputValidation: { status: 'pass', errors: [] }
  }, null, 2)}\n`, 'utf8')
  assert.equal(verifyBuildEvidence(root, source).status, 'pass')

  const mainEntry = path.join(outRoot, REQUIRED_BUILD_ENTRIES[0])
  writeFileSync(mainEntry, 'tampered\n', 'utf8')
  assert(verifyBuildEvidence(root, source).errors.includes('built output digest does not match the recorded output'))
  writeFileSync(mainEntry, `fixture:${REQUIRED_BUILD_ENTRIES[0]}\n`, 'utf8')

  const external = path.join(root, 'external.js')
  const linkedAsset = path.join(outRoot, 'renderer', 'linked-asset.js')
  writeFileSync(external, 'external\n', 'utf8')
  symlinkSync(external, linkedAsset)
  assert(validateBuildOutput(root).some((error) => error.includes('unsafe build output symbolic link')))
  rmSync(linkedAsset, { force: true })

  rmSync(mainEntry, { force: true })
  symlinkSync(external, mainEntry)
  const requiredLinkErrors = validateBuildOutput(root)
  assert(requiredLinkErrors.some((error) => error.includes('required build entry is empty or not a file')))
  assert(requiredLinkErrors.some((error) => error.includes('unsafe build output symbolic link')))

  console.log(JSON.stringify({ status: 'passed', checks: 6 }))
} finally {
  rmSync(root, { recursive: true, force: true })
}
