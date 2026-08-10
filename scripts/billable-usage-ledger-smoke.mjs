#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const repoRoot = process.cwd()
const root = mkdtempSync(path.join(tmpdir(), 'caogen-billable-ledger-'))
const out = path.join(root, 'compiled')
execFileSync(process.execPath, [
  path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
  'src/main/task/billable-usage-ledger.ts',
  'src/main/model/durable-monthly-budget.ts',
  '--outDir', out, '--rootDir', 'src', '--target', 'ES2022', '--module', 'commonjs',
  '--moduleResolution', 'node', '--types', 'node', '--skipLibCheck', '--esModuleInterop'
], { cwd: repoRoot, stdio: 'pipe' })
const require = createRequire(import.meta.url)
const ledger = require(path.join(out, 'main', 'task', 'billable-usage-ledger.js'))
const budget = require(path.join(out, 'main', 'model', 'durable-monthly-budget.js'))
const binding = { kind: 'assigned', workerId: 'worker-1', assignmentId: 'assignment-1' }
const attempt = (id, costUsd, status = 'succeeded', completedAt = 1_700_000_001_000) => ({
  schemaVersion: 1, id, runId: `run-${id}`, requestId: `request-${id}`, workItemId: 'work-1',
  ordinal: 1, providerId: 'provider-1', model: 'model-1', protocol: 'openai.responses',
  adapterVersion: 'test', contextDigest: 'sha256:context', routeReason: 'test', keyLabel: 'sha256:key',
  status, revision: 2, startedAt: completedAt - 1000, completedAt,
  usage: { inputTokens: 10, outputTokens: 4 }, ...(costUsd === undefined ? {} : { costUsd }),
  outcome: status === 'succeeded' ? 'success' : 'error', startCommandId: `start-${id}`,
  startPayloadDigest: 'sha256:start', completionCommandId: `complete-${id}`,
  completionPayloadDigest: 'sha256:complete', recordDigest: 'sha256:attempt'
})

const first = ledger.appendBillableUsageLedger(root, { sessionId: 'session-1', attempt: attempt('a1', 0.25), digitalWorkerBinding: binding })
assert.equal(first.billable, true)
assert.equal(ledger.readBillableUsageLedger(root).length, 1)
assert.equal(ledger.appendBillableUsageLedger(root, { sessionId: 'session-1', attempt: attempt('a1', 0.25), digitalWorkerBinding: binding }).digest, first.digest)
assert.throws(() => ledger.appendBillableUsageLedger(root, { sessionId: 'session-1', attempt: attempt('a1', 0.5), digitalWorkerBinding: binding }), /conflicts with ledger history/)
const second = ledger.appendBillableUsageLedger(root, { sessionId: 'session-2', attempt: attempt('a2', undefined), digitalWorkerBinding: binding })
assert.equal(second.billable, false)
assert.equal(ledger.readBillableUsageLedger(root).length, 2)

const concurrentRoot = mkdtempSync(path.join(tmpdir(), 'caogen-billable-ledger-concurrent-'))
const compiledLedger = path.join(out, 'main', 'task', 'billable-usage-ledger.js')
const childSource = `
const ledger = require(process.argv[1]);
const root = process.argv[2];
const id = process.argv[3];
const attempt = {
  schemaVersion: 1, id, runId: 'run-' + id, requestId: 'request-' + id, workItemId: 'work-1',
  ordinal: 1, providerId: 'provider-1', model: 'model-1', protocol: 'openai.responses',
  adapterVersion: 'test', contextDigest: 'sha256:context', routeReason: 'test', keyLabel: 'sha256:key',
  status: 'succeeded', revision: 2, startedAt: 1700000000000, completedAt: 1700000001000,
  usage: { inputTokens: 10, outputTokens: 4 }, costUsd: 0.1, outcome: 'success',
  startCommandId: 'start-' + id, startPayloadDigest: 'sha256:start',
  completionCommandId: 'complete-' + id, completionPayloadDigest: 'sha256:complete', recordDigest: 'sha256:attempt'
};
ledger.appendBillableUsageLedger(root, { sessionId: 'session-' + id, attempt });
`
const execFileAsync = promisify(execFile)
await Promise.all(Array.from({ length: 12 }, (_, index) =>
  execFileAsync(process.execPath, ['-e', childSource, compiledLedger, concurrentRoot, `parallel-${index}`])))
const concurrent = ledger.readBillableUsageLedger(concurrentRoot)
assert.equal(concurrent.length, 12)
assert.deepEqual(concurrent.map((entry) => entry.seq), Array.from({ length: 12 }, (_, index) => index + 1))

const budgetRoot = mkdtempSync(path.join(tmpdir(), 'caogen-monthly-budget-'))
const july = Date.UTC(2026, 6, 10)
const august = Date.UTC(2026, 7, 10)
ledger.appendBillableUsageLedger(budgetRoot, { sessionId: 'july-success', attempt: attempt('july-success', 1.25, 'succeeded', july) })
ledger.appendBillableUsageLedger(budgetRoot, { sessionId: 'august-failed', attempt: attempt('august-failed', 0.5, 'failed', august) })
ledger.appendBillableUsageLedger(budgetRoot, { sessionId: 'august-success', attempt: attempt('august-success', 2.75, 'succeeded', august) })
const augustBudget = budget.calculateDurableMonthlyBudgetSnapshot({
  rootDir: budgetRoot,
  settings: { budgetUsdPerMonth: 3 },
  history: [{ id: 'legacy-overlap', sdkSessionId: 'legacy-overlap', costUsd: 3, createdAt: august, updatedAt: august }],
  now: august
})
assert.equal(augustBudget.source, 'billable-usage-ledger')
assert.equal(augustBudget.spentUsd, 3.25)
assert.equal(augustBudget.attemptCount, 2)
assert.equal(augustBudget.exceeded, true)
assert.equal(augustBudget.legacyFloorApplied, false)

const migrationFloor = budget.calculateDurableMonthlyBudgetSnapshot({
  rootDir: budgetRoot,
  settings: { budgetUsdPerMonth: 10 },
  history: [{ id: 'pre-ledger', sdkSessionId: 'pre-ledger', costUsd: 6, createdAt: august, updatedAt: august }],
  now: august
})
assert.equal(migrationFloor.spentUsd, 6)
assert.equal(migrationFloor.legacyFloorApplied, true)

const legacyRoot = mkdtempSync(path.join(tmpdir(), 'caogen-monthly-budget-legacy-'))
const legacyBudget = budget.calculateDurableMonthlyBudgetSnapshot({
  rootDir: legacyRoot,
  settings: { budgetUsdPerMonth: 10 },
  history: [{ id: 'legacy', sdkSessionId: 'legacy', costUsd: 4, createdAt: august, updatedAt: august }],
  now: august
})
assert.equal(legacyBudget.source, 'legacy-history')
assert.equal(legacyBudget.spentUsd, 4)
assert.equal(legacyBudget.legacyFloorApplied, true)

const unpricedRoot = mkdtempSync(path.join(tmpdir(), 'caogen-monthly-budget-unpriced-'))
ledger.appendBillableUsageLedger(unpricedRoot, {
  sessionId: 'unpriced-success', attempt: attempt('unpriced-success', undefined, 'succeeded', august)
})
assert.throws(() => budget.calculateDurableMonthlyBudgetSnapshot({
  rootDir: unpricedRoot, settings: { budgetUsdPerMonth: 10 }, history: [], now: august
}), (error) => error?.code === 'UNPRICED_SUCCESS')

const file = ledger.billableUsageLedgerPath(root)
const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
const tampered = JSON.parse(lines[0]); tampered.costUsd = 99
lines[0] = JSON.stringify(tampered)
writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
assert.throws(() => ledger.readBillableUsageLedger(root), /ledger (chain|digest) is invalid/)
console.log('Billable usage ledger smoke: passed (concurrency, idempotency, failure cost, cross-month, fallback, fail-closed)')
