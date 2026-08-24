#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const required = process.argv.includes('--required')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'critical-recovery-matrix')
const reportDir = path.join(reportRoot, runId)
const reportPath = path.join(reportDir, 'report.json')
const latestPath = path.join(reportRoot, 'latest.json')
const matrixPath = path.join(repoRoot, 'scripts', 'contracts', 'critical-recovery-fault-matrix.json')
const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'))
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const packageScripts = packageJson.scripts ?? {}

const expectedIds = [
  'RUN-004', 'RUN-005',
  'TRUST-002', 'TRUST-003', 'TRUST-004',
  'ART-002',
  'NFR-REC-001', 'NFR-REC-002', 'NFR-REC-003', 'NFR-REC-004', 'NFR-REC-005'
]
const expectedFaults = ['strong_kill', 'network_unknown_result', 'duplicate_idempotency', 'out_of_order']
const expectedContinuity = [
  'identity',
  'revision',
  'ownership',
  'effect',
  'artifact_evidence_acceptance',
  'replay_resend_count',
  'final_digest'
]
const errors = []
const checks = []

assert.equal(matrix.schemaVersion, 1, 'recovery matrix schemaVersion must be 1')
assert.equal(matrix.matrixId, 'caogen-critical-recovery-11-fault-matrix', 'recovery matrix identity is invalid')
assert.deepEqual(matrix.failureClasses, expectedFaults, 'recovery fault classes drifted')
assert.deepEqual(matrix.continuityFields, expectedContinuity, 'recovery continuity fields drifted')
assert.equal(matrix.requirements?.length, expectedIds.length, 'recovery matrix must contain exactly 11 requirements')
assert.deepEqual(matrix.requirements.map((item) => item.id), expectedIds, 'recovery requirement order or IDs drifted')
checks.push('fixed 11 requirement IDs and four fault classes')
checks.push('fixed seven continuity fields')

for (const requirement of matrix.requirements) {
  if (!['open', 'partial', 'verified'].includes(requirement.status)) errors.push(`${requirement.id}: invalid requirement status`)
  if (typeof requirement.owner !== 'string' || !requirement.owner.trim()) errors.push(`${requirement.id}: owner is missing`)
  if (!Array.isArray(requirement.openGaps)) errors.push(`${requirement.id}: openGaps must be an array`)
  if (!requirement.faults || typeof requirement.faults !== 'object') {
    errors.push(`${requirement.id}: faults are missing`)
    continue
  }
  const faultKeys = Object.keys(requirement.faults).sort()
  if (JSON.stringify(faultKeys) !== JSON.stringify([...expectedFaults].sort())) {
    errors.push(`${requirement.id}: fault classes do not cover all four required cases`)
  }
  for (const fault of expectedFaults) {
    const cell = requirement.faults[fault]
    if (!cell || !['open', 'partial', 'verified'].includes(cell.status)) {
      errors.push(`${requirement.id}/${fault}: invalid status`)
      continue
    }
    if (typeof cell.gate !== 'string' || !cell.gate.trim()) errors.push(`${requirement.id}/${fault}: gate is missing`)
    if (cell.gate && packageScripts[cell.gate] === undefined) errors.push(`${requirement.id}/${fault}: package script ${cell.gate} is missing`)
    if (!Array.isArray(cell.evidence)) errors.push(`${requirement.id}/${fault}: evidence must be an array`)
  }
}
checks.push('every requirement has all four fault cells and a package gate')

const git = readGitState()
const cells = matrix.requirements.flatMap((requirement) => expectedFaults.map((fault) => ({
  requirementId: requirement.id,
  faultClass: fault,
  ...requirement.faults[fault]
})))
const verifiedCells = cells.filter((cell) => cell.status === 'verified' && cell.evidence.length > 0)
const complete = matrix.status === 'verified' && verifiedCells.length === cells.length && git.worktreeClean
const structuralStatus = errors.length === 0 ? 'passed' : 'failed'
const status = structuralStatus === 'passed' && complete ? 'passed' : required ? 'failed' : 'contract_only'
const report = {
  schemaVersion: 1,
  gate: 'test:critical-recovery-matrix',
  runId,
  required,
  status,
  verification: complete ? 'verified' : 'not_verified',
  structuralStatus,
  matrix: matrixPath,
  matrixStatus: matrix.status,
  requirementCount: matrix.requirements.length,
  faultCellCount: cells.length,
  verifiedCellCount: verifiedCells.length,
  checks,
  errors,
  git,
  openRequirements: matrix.requirements.filter((requirement) => requirement.status !== 'verified').map((requirement) => requirement.id),
  explicitlyNotVerified: complete ? [] : [
    'per-requirement strong-kill, network/unknown-result, duplicate/idempotency and out-of-order runtime evidence',
    'same clean candidate SHA binding for every referenced report',
    'cross-domain Artifact/Evidence/Acceptance continuity across all 11 requirements'
  ]
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(latestPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 2))
if (status === 'failed') process.exitCode = 1

function readGitState() {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    const porcelain = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    }).trim()
    return { commit, worktreeClean: porcelain.length === 0 }
  } catch {
    return { commit: '', worktreeClean: false }
  }
}
