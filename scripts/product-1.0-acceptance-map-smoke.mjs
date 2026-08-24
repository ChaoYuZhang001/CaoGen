#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildAcceptanceMap } from './lib/product-acceptance-map.mjs'
import {
  checkAcceptanceContractScripts,
  hasPublicAcceptanceGate,
  loadProductAcceptanceInput,
  validateProductAcceptanceContract
} from './lib/product-acceptance-input.mjs'

const packageScripts = {
  'test:exp': 'node exp.mjs',
  'test:run': 'node run.mjs',
  'test:secret-canary-all-outputs:required': 'node secret-canary.mjs'
}

verifyPublicContractAndPrivateInputModes()

const valid = buildAcceptanceMap({
  prdMarkdown: requirementRows([
    ['EXP-001', 'P0', '当前已验证', 'Switch modes'],
    ['RUN-004', 'P1', '当前已验证', 'Recover runs']
  ]),
  matrixMarkdown: matrixRows([
    ['EXP-001', '当前已验证', 'release commit evidence', 'L1', 'LOCAL', 'npm run test:exp', 'closed'],
    ['RUN-004', 'GOLDEN', '当前已验证', 'crash network duplicate out-of-order', 'L3', 'LOCAL', 'npm run test:run', 'closed']
  ]),
  packageScripts,
  expectedCounts: { P0: 1, P1: 1 }
})
assert.deepEqual(valid.structuralFailures, [])
assert.equal(valid.summary.mapped, 2)
assert.equal(valid.summary.criticalRecovery.complete, 1)

const punctuated = buildAcceptanceMap({
  prdMarkdown: requirementRows([['NFR-PRIV-003', 'P1', '立项目标', 'Redact outputs']]),
  matrixMarkdown: matrixRows([
    [
      'NFR-PRIV-003', 'GOLDEN', '立项目标', 'gap', 'L5', 'LOCAL',
      'Add gate `npm run test:secret-canary-all-outputs:required`.', 'open'
    ]
  ]),
  packageScripts
})
assert.deepEqual(punctuated.entries[0].declaredCommands, ['test:secret-canary-all-outputs:required'])
assert.deepEqual(punctuated.entries[0].missingCommands, [])

const missing = buildAcceptanceMap({
  prdMarkdown: requirementRows([['EXP-001', 'P0', '立项目标', 'Switch modes']]),
  matrixMarkdown: '',
  packageScripts: {}
})
assert.match(missing.structuralFailures.join('\n'), /missing matrix row/)

const duplicate = buildAcceptanceMap({
  prdMarkdown: requirementRows([['EXP-001', 'P0', '立项目标', 'Switch modes']]),
  matrixMarkdown: matrixRows([
    ['EXP-001', '立项目标', 'gap', 'L1', 'LOCAL', 'npm run test:exp', 'open'],
    ['EXP-001', '立项目标', 'gap', 'L1', 'LOCAL', 'npm run test:exp', 'open']
  ]),
  packageScripts
})
assert.match(duplicate.structuralFailures.join('\n'), /duplicate matrix rows/)

const stale = buildAcceptanceMap({
  prdMarkdown: requirementRows([['EXP-001', 'P0', '当前已验证', 'Switch modes']]),
  matrixMarkdown: matrixRows([
    ['EXP-001', '当前已验证', 'dirty worktree', 'L1', 'LOCAL', 'npm run test:missing', 'refresh in clean Deep']
  ]),
  packageScripts: {}
})
assert.match(stale.closureFailures.join('\n'), /missing package scripts/)
assert.match(stale.closureFailures.join('\n'), /lacks release-bound evidence/)

const malformed = buildAcceptanceMap({
  prdMarkdown: requirementRows([
    ['EXP-001', 'P0', '立项目标', 'Switch modes'],
    ['RUN-004', 'P1', '立项目标', 'Recover runs']
  ]),
  matrixMarkdown: matrixRows([
    ['EXP-001', '当前已验证', 'gap', 'L1', 'LOCAL', 'No gate yet', 'open'],
    ['RUN-004', 'GOLDEN', '立项目标', 'crash only', 'L3', 'LOCAL', 'npm run test:run', 'open'],
    ['UNKNOWN-001', '立项目标', 'gap', 'L0', 'LOCAL', 'npm run test:exp', 'open']
  ]),
  packageScripts,
  expectedCounts: { P0: 2, P1: 1 }
})
const malformedStructure = malformed.structuralFailures.join('\n')
assert.match(malformedStructure, /P0 inventory changed/)
assert.match(malformedStructure, /unknown requirement UNKNOWN-001/)
assert.match(malformedStructure, /PRD status .* differs from matrix status/)
assert.match(malformedStructure, /no automated command or explicit human gate/)
assert.match(malformed.closureFailures.join('\n'), /RUN-004: missing resilience cases/)

console.log('product 1.0 acceptance map smoke: PASS')

function verifyPublicContractAndPrivateInputModes() {
  const sourceContractPath = path.join(process.cwd(), 'scripts', 'contracts', 'product-1.0-acceptance-contract.json')
  const contract = JSON.parse(readFileSync(sourceContractPath, 'utf8'))
  verifyContractDefinition(contract)
  verifyMissingContractBehavior()

  const cleanRoot = mkdtempSync(path.join(tmpdir(), 'caogen-product-acceptance-contract-'))
  try {
    const fixture = writeAcceptanceFixture(cleanRoot, contract)
    verifyAcceptanceInputModes(cleanRoot, fixture)
    verifyPublicAcceptanceRuns(cleanRoot, fixture)
    verifyPrivateAcceptanceRuns(cleanRoot, fixture)
    verifyMalformedContractRun(cleanRoot, fixture)
  } finally {
    rmSync(cleanRoot, { recursive: true, force: true })
  }
}

function verifyContractDefinition(contract) {
  assert.deepEqual(validateProductAcceptanceContract(contract), [])
  assert.equal(hasPublicAcceptanceGate(contract, 'WORK-002', 'test:workitem-board:required'), true)
  assert.deepEqual(
    contract.additionalReleaseBlockingScope.items.map((item) => item.id),
    ['SEARCH-001', 'VID-MVP-001', 'CRITICAL-RECOVERY-11']
  )
  assert.equal(contract.additionalReleaseBlockingScope.items[2].itemCount, 11)
  assert.deepEqual(checkAcceptanceContractScripts(contract, {
    ...Object.fromEntries(contract.closurePolicy.requiredPackageScripts.map((name) => [name, 'node gate.mjs'])),
    'test:workitem-board:required': 'node board.mjs'
  }), [])

  const changedCounts = structuredClone(contract)
  changedCounts.inventory.P0 = 63
  assert.match(validateProductAcceptanceContract(changedCounts).join('\n'), /P0=64/)
  const changedRecovery = structuredClone(contract)
  changedRecovery.closurePolicy.criticalRecoveryRequirementIds.pop()
  assert.match(validateProductAcceptanceContract(changedRecovery).join('\n'), /critical recovery/)
  const changedReleaseScope = structuredClone(contract)
  changedReleaseScope.additionalReleaseBlockingScope.items[2].itemCount = 10
  assert.match(validateProductAcceptanceContract(changedReleaseScope).join('\n'), /CRITICAL-RECOVERY-11/)
  const changedBinding = structuredClone(contract)
  changedBinding.closurePolicy.publicGateBindings = []
  assert.match(validateProductAcceptanceContract(changedBinding).join('\n'), /public gate bindings/)
}

function verifyMissingContractBehavior() {
  const missingContract = loadProductAcceptanceInput({
    repoRoot: path.join(tmpdir(), 'caogen-product-acceptance-missing-contract'),
    environment: {}
  })
  assert.match(missingContract.contractFailures.join('\n'), /could not be read/)
  assert.equal(missingContract.privateInputsComplete, false)
  assert.doesNotThrow(() => checkAcceptanceContractScripts({ closurePolicy: { publicGateBindings: {} } }, {}))
  assert.equal(hasPublicAcceptanceGate(null, 'WORK-002', 'test:workitem-board:required'), false)
}

function writeAcceptanceFixture(cleanRoot, contract) {
  const contractDir = path.join(cleanRoot, 'scripts', 'contracts')
  const requirementsPath = path.join(cleanRoot, 'private-requirements.md')
  const matrixPath = path.join(cleanRoot, 'private-matrix.md')
  mkdirSync(contractDir, { recursive: true })
  writeFileSync(path.join(contractDir, 'product-1.0-acceptance-contract.json'), `${JSON.stringify(contract, null, 2)}\n`, 'utf8')
  writeFileSync(path.join(cleanRoot, 'package.json'), `${JSON.stringify({
    name: 'caogen-acceptance-contract-smoke',
    version: '0.0.0',
    scripts: acceptanceContractPackageScripts(contract)
  }, null, 2)}\n`, 'utf8')
  writeFileSync(requirementsPath, '| EXP-001 | P0 | 当前已验证 | fixture |\n', 'utf8')
  writeFileSync(matrixPath, '| EXP-001 | 当前已验证 | evidence | owner | LOCAL | npm run test:exp | closed |\n', 'utf8')
  return {
    contractDir,
    requirementsPath,
    matrixPath,
    runnerPath: path.join(process.cwd(), 'scripts', 'product-1.0-acceptance-map.mjs'),
    auditRunnerPath: path.join(process.cwd(), 'scripts', 'product-1.0-acceptance-audit.mjs'),
    cleanEnvironment: acceptanceEnvironment()
  }
}

function verifyAcceptanceInputModes(cleanRoot, fixture) {
  const publicOnly = loadProductAcceptanceInput({ repoRoot: cleanRoot, environment: {} })
  assert.equal(publicOnly.mode, 'public_contract')
  assert.equal(publicOnly.privateInputsComplete, false)
  assert.deepEqual(publicOnly.privateInputFailures, [])
  const requiredWithoutPrivate = loadProductAcceptanceInput({ repoRoot: cleanRoot, environment: {}, required: true })
  assert.match(requiredWithoutPrivate.closureInputFailures.join('\n'), /needs both private requirements and matrix inputs/)

  const privateLedger = loadProductAcceptanceInput({
    repoRoot: cleanRoot,
    environment: privateAcceptanceEnvironment(fixture)
  })
  assert.equal(privateLedger.mode, 'private_ledger')
  assert.equal(privateLedger.privateInputsComplete, true)
  assert.equal(privateLedger.requirements.path, '<private:CAOGEN_PRODUCT_REQUIREMENTS_PATH>')
  assert.equal(privateLedger.matrix.path, '<private:CAOGEN_ACCEPTANCE_MATRIX_PATH>')

  const invalidExplicit = loadProductAcceptanceInput({
    repoRoot: cleanRoot,
    environment: {
      CAOGEN_PRODUCT_REQUIREMENTS_PATH: path.join(cleanRoot, 'missing-requirements.md'),
      CAOGEN_ACCEPTANCE_MATRIX_PATH: fixture.matrixPath
    }
  })
  assert.match(invalidExplicit.privateInputFailures.join('\n'), /CAOGEN_PRODUCT_REQUIREMENTS_PATH/)
  assert.match(invalidExplicit.privateInputFailures.join('\n'), /must be provided together/)
}

function verifyPublicAcceptanceRuns(cleanRoot, fixture) {
  assertRunStatus(runAcceptance(cleanRoot, fixture.runnerPath, fixture.cleanEnvironment), 0)
  const publicReport = readLatestAcceptanceReport(cleanRoot)
  assert.equal(publicReport.inputMode, 'public_contract')
  assert.equal(publicReport.coverage, 'contract_only')
  assert.equal(publicReport.structuralStatus, 'passed')
  assert.equal(publicReport.closureStatus, 'failed')
  assert.equal(publicReport.summary.p0.total, 64)
  assert.equal(publicReport.summary.p1.total, 38)

  assertRunStatus(runAcceptance(cleanRoot, fixture.auditRunnerPath, fixture.cleanEnvironment), 0)
  const audit = readLatestAcceptanceAuditReport(cleanRoot)
  assert.equal(audit.status, 'failed')
  assert.equal(audit.inputMode, 'public_contract')
  assert.equal(audit.coverage, 'contract_only')
  assert.equal(audit.acceptanceMap.structuralStatus, 'passed')
  assert.equal(audit.acceptanceMap.closureStatus, 'failed')
  assert.equal(audit.summary.p0.total, 64)
  assert.equal(audit.summary.p1.total, 38)

  assertRunStatus(runAcceptance(cleanRoot, fixture.runnerPath, fixture.cleanEnvironment, true), 1)
  assert.match(readLatestAcceptanceReport(cleanRoot).closureFailures.join('\n'), /private acceptance ledger/)
  assertRunStatus(runAcceptance(cleanRoot, fixture.auditRunnerPath, fixture.cleanEnvironment, true), 1)
  assert.match(readLatestAcceptanceAuditReport(cleanRoot).closureFailures.join('\n'), /private acceptance ledger/)
}

function verifyPrivateAcceptanceRuns(cleanRoot, fixture) {
  const synthetic = syntheticFullAcceptanceLedger()
  writeFileSync(fixture.requirementsPath, synthetic.requirements, 'utf8')
  writeFileSync(fixture.matrixPath, synthetic.matrix, 'utf8')
  const privateEnvironment = privateAcceptanceEnvironment(fixture)
  assertRunStatus(runAcceptance(cleanRoot, fixture.runnerPath, privateEnvironment), 0)
  const report = readLatestAcceptanceReport(cleanRoot)
  assert.equal(report.inputMode, 'private_ledger')
  assert.equal(report.coverage, 'full')
  assert.equal(report.structuralStatus, 'passed')
  assert.equal(report.summary.p0.mapped, 64)
  assert.equal(report.summary.p1.mapped, 38)
  assert.equal(report.source, '<private:CAOGEN_PRODUCT_REQUIREMENTS_PATH>')
  assert.equal(report.matrix, '<private:CAOGEN_ACCEPTANCE_MATRIX_PATH>')
  assert(!JSON.stringify(report).includes(cleanRoot), 'acceptance report must not expose explicit private input paths')

  assertRunStatus(runAcceptance(cleanRoot, fixture.auditRunnerPath, privateEnvironment), 0)
  const audit = readLatestAcceptanceAuditReport(cleanRoot)
  assert.equal(audit.inputMode, 'private_ledger')
  assert.equal(audit.coverage, 'full')
  assert.equal(audit.privateInputsComplete, true)
  assert.equal(audit.source, '<private:CAOGEN_PRODUCT_REQUIREMENTS_PATH>')
  assert.equal(audit.matrix, '<private:CAOGEN_ACCEPTANCE_MATRIX_PATH>')
  assert(!JSON.stringify(audit).includes(fixture.requirementsPath), 'audit report must redact the requirements input path')
  assert(!JSON.stringify(audit).includes(fixture.matrixPath), 'audit report must redact the matrix input path')
}

function verifyMalformedContractRun(cleanRoot, fixture) {
  writeFileSync(path.join(fixture.contractDir, 'product-1.0-acceptance-contract.json'), '{ invalid contract', 'utf8')
  assertRunStatus(runAcceptance(cleanRoot, fixture.runnerPath, fixture.cleanEnvironment), 1)
  assert.match(readLatestAcceptanceReport(cleanRoot).structuralFailures.join('\n'), /contract could not be read/)
}

function acceptanceEnvironment() {
  return { ...process.env, CAOGEN_PRODUCT_REQUIREMENTS_PATH: '', CAOGEN_ACCEPTANCE_MATRIX_PATH: '' }
}

function privateAcceptanceEnvironment(fixture) {
  return {
    ...fixture.cleanEnvironment,
    CAOGEN_PRODUCT_REQUIREMENTS_PATH: fixture.requirementsPath,
    CAOGEN_ACCEPTANCE_MATRIX_PATH: fixture.matrixPath
  }
}

function runAcceptance(cleanRoot, runnerPath, environment, required = false) {
  return spawnSync(process.execPath, required ? [runnerPath, '--required'] : [runnerPath], {
    cwd: cleanRoot,
    env: environment,
    encoding: 'utf8'
  })
}

function assertRunStatus(run, expected) {
  assert.equal(run.status, expected, run.stderr || run.stdout)
}

function acceptanceContractPackageScripts(contract) {
  return Object.fromEntries([
    ...contract.closurePolicy.requiredPackageScripts,
    ...contract.closurePolicy.publicGateBindings.map((binding) => binding.script)
  ].map((name) => [name, 'node gate.mjs']))
}

function readLatestAcceptanceReport(root) {
  return JSON.parse(readFileSync(
    path.join(root, 'test-results', 'product-1.0-acceptance-map', 'latest.json'),
    'utf8'
  ))
}

function readLatestAcceptanceAuditReport(root) {
  return JSON.parse(readFileSync(
    path.join(root, 'test-results', 'product-1.0-acceptance-audit', 'latest.json'),
    'utf8'
  ))
}

function syntheticFullAcceptanceLedger() {
  const critical = [
    'RUN-004', 'RUN-005',
    'TRUST-002', 'TRUST-003', 'TRUST-004',
    'ART-002',
    'NFR-REC-001', 'NFR-REC-002', 'NFR-REC-003', 'NFR-REC-004', 'NFR-REC-005'
  ]
  const p0Ids = [
    ...critical,
    ...Array.from({ length: 64 - critical.length }, (_, index) => `PUBLIC-P0-${String(index + 1).padStart(3, '0')}`)
  ]
  const p1Ids = Array.from({ length: 38 }, (_, index) => `PUBLIC-P1-${String(index + 1).padStart(3, '0')}`)
  const rows = [
    ...p0Ids.map((id) => [id, 'P0']),
    ...p1Ids.map((id) => [id, 'P1'])
  ]
  return {
    requirements: rows.map(([id, priority]) =>
      `| ${id} | ${priority} | 立项目标 | Synthetic structure fixture |`
    ).join('\n'),
    matrix: rows.map(([id]) =>
      `| ${id} | GOLDEN | 立项目标 | crash restart network provider duplicate replay out-of-order stale CAS | owner | HUMAN-TIME | human review | open |`
    ).join('\n')
  }
}

function requirementRows(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n')
}

function matrixRows(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n')
}
