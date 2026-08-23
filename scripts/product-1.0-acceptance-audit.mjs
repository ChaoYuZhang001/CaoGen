#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  buildAcceptanceMap,
  parseRequirements,
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
const reportRoot = path.join(repoRoot, 'test-results', 'product-1.0-acceptance-audit')
const reportDir = path.join(reportRoot, runId)
const packageJson = readJson(path.join(repoRoot, 'package.json'))
const packageScripts = packageJson.scripts ?? {}
const input = loadProductAcceptanceInput({ repoRoot, required })
const expectedCounts = validInventory(input.contract?.inventory)
  ? input.contract.inventory
  : PRODUCT_1_0_EXPECTED_COUNTS
const criticalRecoveryRequirementIds = Array.isArray(input.contract?.closurePolicy?.criticalRecoveryRequirementIds)
  ? input.contract.closurePolicy.criticalRecoveryRequirementIds
  : PRODUCT_1_0_CRITICAL_RECOVERY_REQUIREMENT_IDS
const requirements = input.privateInputsComplete
  ? parseRequirements(input.requirements.markdown)
  : []
const p0 = requirements.filter((item) => item.priority === 'P0')
const p1 = requirements.filter((item) => item.priority === 'P1')
const verifiedP0 = p0.filter((item) => item.status === '当前已验证')
const openP0 = p0.filter((item) => item.status !== '当前已验证')
const openP1 = p1.filter((item) => item.status === '立项目标')
const acceptanceMap = input.privateInputsComplete
  ? buildAcceptanceMap({
      prdMarkdown: input.requirements.markdown,
      matrixMarkdown: input.matrix.markdown,
      packageScripts,
      expectedCounts,
      criticalRecoveryRequirementIds
    })
  : emptyAcceptanceMap(expectedCounts, criticalRecoveryRequirementIds)
const structuralFailures = [
  ...input.contractFailures,
  ...checkAcceptanceContractScripts(input.contract, packageScripts),
  ...input.inputResolutionFailures,
  ...acceptanceMap.structuralFailures
]
const closureFailures = [
  ...(!input.privateInputsComplete
    ? ['private acceptance ledger was not provided; formal 1.0 product closure is unavailable']
    : []),
  ...input.closureInputFailures,
  ...(openP0.length > 0 ? [`${openP0.length} P0 requirements are not fully verified`] : []),
  ...acceptanceMap.closureFailures
]
const structuralStatus = structuralFailures.length === 0 ? 'passed' : 'failed'
const closureStatus = structuralStatus === 'passed' &&
  input.privateInputsComplete &&
  closureFailures.length === 0
  ? 'passed'
  : 'failed'
const failures = [...structuralFailures, ...closureFailures]

const report = {
  schemaVersion: 1,
  status: closureStatus === 'passed' ? 'passed' : 'failed',
  required,
  requirement: required ? 'required' : 'informational',
  runId,
  reportDir,
  packageVersion: packageJson.version,
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
  summary: {
    p0: input.privateInputsComplete
      ? { total: p0.length, verified: verifiedP0.length, open: openP0.length, statuses: countStatuses(p0) }
      : { total: expectedCounts.P0, verified: 0, open: expectedCounts.P0, statuses: {} },
    p1: input.privateInputsComplete
      ? { total: p1.length, openTargets: openP1.length, statuses: countStatuses(p1) }
      : { total: expectedCounts.P1, openTargets: expectedCounts.P1, statuses: {} }
  },
  acceptanceMap: {
    structuralStatus,
    closureStatus,
    summary: acceptanceMap.summary,
    structuralFailures,
    closureFailureCount: closureFailures.length
  },
  openP0,
  openP1,
  structuralFailures,
  closureFailures,
  failures
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 2))
if (required && report.status !== 'passed') process.exitCode = 1

function countStatuses(items) {
  return Object.fromEntries(
    [...new Set(items.map((item) => item.status))]
      .sort()
      .map((status) => [status, items.filter((item) => item.status === status).length])
  )
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function validInventory(value) {
  return Number.isInteger(value?.P0) && Number.isInteger(value?.P1)
}

function emptyAcceptanceMap(inventory, criticalRecoveryRequirementIds) {
  const criticalRecoveryTotal = Array.isArray(criticalRecoveryRequirementIds)
    ? criticalRecoveryRequirementIds.length
    : 0
  return {
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
      criticalRecovery: { total: criticalRecoveryTotal, complete: 0 }
    }
  }
}

function emptyPrioritySummary(total) {
  return { total, mapped: 0, verified: 0, conditional: 0, targets: 0, open: total }
}
