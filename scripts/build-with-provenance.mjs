#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { BUILD_EVIDENCE_FILE, snapshotBuildOutput, validateBuildOutput } from './lib/build-evidence.mjs'
import { readSourceEvidenceState, sourceEvidenceDrift } from './lib/source-evidence-binding.mjs'

const repoRoot = process.cwd()
const outRoot = path.join(repoRoot, 'out')
const evidencePath = path.join(outRoot, BUILD_EVIDENCE_FILE)
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const sourceAtStart = readSourceEvidenceState(repoRoot)
let buildError

rmSync(evidencePath, { force: true })
try {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
    'build'
  ], { cwd: repoRoot, stdio: 'inherit' })
} catch (error) {
  buildError = error
}

const sourceAtEnd = readSourceEvidenceState(repoRoot)
const drift = sourceEvidenceDrift(sourceAtStart, sourceAtEnd)
const output = snapshotBuildOutput(repoRoot)
const outputErrors = validateBuildOutput(repoRoot)
const evidence = {
  schemaVersion: 1,
  kind: 'caogen-build-evidence',
  status: !buildError && drift.length === 0 && outputErrors.length === 0 ? 'passed' : 'failed',
  generatedAt: new Date().toISOString(),
  packageVersion: packageJson.version,
  source: {
    status: drift.length === 0 ? 'pass' : 'fail',
    start: sourceAtStart,
    end: sourceAtEnd,
    drift
  },
  output,
  outputValidation: {
    status: outputErrors.length === 0 ? 'pass' : 'fail',
    errors: outputErrors
  },
  error: buildError instanceof Error ? buildError.message : buildError ? String(buildError) : undefined
}
mkdirSync(outRoot, { recursive: true })
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

if (buildError) throw buildError
if (drift.length > 0) throw new Error(`Build evidence invalidated: ${drift.join('; ')}`)
if (outputErrors.length > 0) throw new Error(`Build output is incomplete: ${outputErrors.join('; ')}`)
console.log(`build evidence: ${path.relative(repoRoot, evidencePath)} (${evidence.output.fileCount} files)`)
