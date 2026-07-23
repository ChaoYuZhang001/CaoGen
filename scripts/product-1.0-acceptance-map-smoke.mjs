#!/usr/bin/env node
import assert from 'node:assert/strict'
import { buildAcceptanceMap } from './lib/product-acceptance-map.mjs'

const packageScripts = {
  'test:exp': 'node exp.mjs',
  'test:run': 'node run.mjs'
}

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

function requirementRows(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n')
}

function matrixRows(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n')
}
