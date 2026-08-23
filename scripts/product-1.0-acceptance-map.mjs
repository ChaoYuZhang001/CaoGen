#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  buildAcceptanceMap,
  PRODUCT_1_0_CRITICAL_RECOVERY_REQUIREMENT_IDS,
  PRODUCT_1_0_EXPECTED_COUNTS
} from './lib/product-acceptance-map.mjs'
import {
  checkAcceptanceContractScripts,
  loadProductAcceptanceInput
} from './lib/product-acceptance-input.mjs'

const repoRoot = process.cwd()
const required = process.argv.includes('--required')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'product-1.0-acceptance-map')
const reportDir = path.join(reportRoot, runId)
const packageJson = readJson(path.join(repoRoot, 'package.json'))
const input = loadProductAcceptanceInput({ repoRoot, required })
const packageScripts = packageJson.scripts ?? {}
const expectedCounts = validInventory(input.contract?.inventory)
  ? input.contract.inventory
  : PRODUCT_1_0_EXPECTED_COUNTS
const criticalRecoveryRequirementIds = Array.isArray(input.contract?.closurePolicy?.criticalRecoveryRequirementIds)
  ? input.contract.closurePolicy.criticalRecoveryRequirementIds
  : PRODUCT_1_0_CRITICAL_RECOVERY_REQUIREMENT_IDS
const publicContractFailures = [
  ...input.contractFailures,
  ...checkAcceptanceContractScripts(input.contract, packageScripts)
]
const acceptanceMap = input.privateInputsComplete
  ? buildAcceptanceMap({
      prdMarkdown: input.requirements.markdown,
      matrixMarkdown: input.matrix.markdown,
      packageScripts,
      expectedCounts,
      criticalRecoveryRequirementIds
    })
  : emptyAcceptanceMap(expectedCounts, criticalRecoveryRequirementIds.length)
const git = readGitState()
const releaseBindingFailures = [
  ...(!git.commit ? ['release commit is unresolved'] : []),
  ...(!git.worktreeClean ? ['worktree is not clean'] : [])
]
const structuralFailures = [
  ...publicContractFailures,
  ...input.inputResolutionFailures,
  ...acceptanceMap.structuralFailures
]
const structuralStatus = structuralFailures.length === 0 ? 'passed' : 'failed'
const closureFailures = [
  ...(!input.privateInputsComplete
    ? ['private acceptance ledger was not provided; full 1.0 closure is unavailable']
    : []),
  ...input.closureInputFailures,
  ...acceptanceMap.closureFailures
]
const closureStatus = structuralStatus === 'passed' &&
  input.privateInputsComplete &&
  closureFailures.length === 0 &&
  releaseBindingFailures.length === 0
  ? 'passed'
  : 'failed'
const report = {
  schemaVersion: 1,
  status: required ? closureStatus : structuralStatus,
  structuralStatus,
  closureStatus,
  required,
  requirement: required ? 'required' : 'structural',
  runId,
  packageVersion: packageJson.version,
  git,
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version
  },
  inputMode: input.mode,
  coverage: input.privateInputsComplete ? 'full' : 'contract_only',
  publicContract: input.contractPath,
  source: input.privateInputsComplete ? input.requirements.path : null,
  matrix: input.privateInputsComplete ? input.matrix.path : null,
  privateInputsComplete: input.privateInputsComplete,
  summary: acceptanceMap.summary,
  structuralFailures,
  closureFailures,
  releaseBindingFailures,
  unexpectedMatrixIds: acceptanceMap.unexpectedMatrixIds,
  entries: acceptanceMap.entries
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({
  status: report.status,
  structuralStatus,
  closureStatus,
  required,
  inputMode: report.inputMode,
  privateInputsComplete: report.privateInputsComplete,
  summary: report.summary,
  structuralFailures: report.structuralFailures,
  closureFailureCount: report.closureFailures.length,
  releaseBindingFailures,
  reportDir
}, null, 2))
if (report.status !== 'passed') process.exitCode = 1

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function readGitState() {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    const porcelain = execFileSync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    ).trim()
    return { commit, worktreeClean: porcelain.length === 0 }
  } catch {
    return { commit: '', worktreeClean: false }
  }
}

function emptyAcceptanceMap(inventory, criticalRecoveryTotal) {
  return {
    entries: [],
    unexpectedMatrixIds: [],
    structuralFailures: [],
    closureFailures: [],
    summary: {
      total: inventory.P0 + inventory.P1,
      p0: emptyPrioritySummary(inventory.P0),
      p1: emptyPrioritySummary(inventory.P1),
      mapped: 0,
      requirementsWithImplementedGate: 0,
      declaredGateCommands: 0,
      implementedGateCommands: 0,
      releaseBound: 0,
      criticalRecovery: {
        total: criticalRecoveryTotal,
        complete: 0
      }
    }
  }
}

function emptyPrioritySummary(total) {
  return { total, mapped: 0, verified: 0, conditional: 0, targets: 0, open: total }
}

function validInventory(value) {
  return Number.isInteger(value?.P0) && Number.isInteger(value?.P1)
}
