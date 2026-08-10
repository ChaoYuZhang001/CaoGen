#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const root = mkdtempSync(path.join(tmpdir(), 'caogen-billable-ledger-'))
const out = path.join(root, 'compiled')
execFileSync(process.execPath, [
  path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
  'src/main/task/billable-usage-ledger.ts',
  '--outDir', out, '--rootDir', 'src', '--target', 'ES2022', '--module', 'commonjs',
  '--moduleResolution', 'node', '--types', 'node', '--skipLibCheck', '--esModuleInterop'
], { cwd: repoRoot, stdio: 'pipe' })
const require = createRequire(import.meta.url)
const ledger = require(path.join(out, 'main', 'task', 'billable-usage-ledger.js'))
const binding = { kind: 'assigned', workerId: 'worker-1', assignmentId: 'assignment-1' }
const attempt = (id, costUsd, status = 'succeeded') => ({
  schemaVersion: 1, id, runId: `run-${id}`, requestId: `request-${id}`, workItemId: 'work-1',
  ordinal: 1, providerId: 'provider-1', model: 'model-1', protocol: 'openai.responses',
  adapterVersion: 'test', contextDigest: 'sha256:context', routeReason: 'test', keyLabel: 'sha256:key',
  status, revision: 2, startedAt: 1_700_000_000_000, completedAt: 1_700_000_001_000,
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

const file = ledger.billableUsageLedgerPath(root)
const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
const tampered = JSON.parse(lines[0]); tampered.costUsd = 99
lines[0] = JSON.stringify(tampered)
writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
assert.throws(() => ledger.readBillableUsageLedger(root), /ledger (chain|digest) is invalid/)
console.log('Billable usage ledger smoke: passed (5 checks)')
