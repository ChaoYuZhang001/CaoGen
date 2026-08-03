#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { EFFECT_ENTRY_REGISTRY } from './effect-entry-registry.mjs'
import {
  discoverEffectEntries,
  validateEffectEntryRegistry
} from './lib/effect-entry-inventory.mjs'

const repoRoot = process.cwd()
const discovery = discoverEffectEntries(repoRoot)

if (process.argv.includes('--print-discovered')) {
  console.log(JSON.stringify(discovery.entries, null, 2))
  process.exit(0)
}

const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const reportRoot = path.join(repoRoot, 'test-results', 'effect-entry-inventory')
const reportDir = path.join(reportRoot, runId)
const report = {
  schemaVersion: 1,
  runId,
  status: 'failed',
  sourceRevision: gitOutput(['rev-parse', 'HEAD']),
  worktreeStatusCount: gitOutput(['status', '--porcelain']).split('\n').filter(Boolean).length,
  checks: [],
  summary: {},
  failures: []
}

try {
  const failures = validateEffectEntryRegistry(EFFECT_ENTRY_REGISTRY, discovery)
  assert(failures.length === 0, failures.join('\n'))
  check('all discovered tool, IPC, action, connector, and provider entries are registered')
  check('read-only and mutating access classifications agree with source contracts')
  assertAcceptanceReviewIsDurableMutation()
  assertMergedIpcCoverage()
  check('queryable mutations reference declared EffectTargets with Reconciler coverage')
  check('opaque mutations require manual resolution and cannot authorize automatic replay')
  runNegativeFixtures()
  report.status = 'passed'
  report.summary = summarize(EFFECT_ENTRY_REGISTRY, discovery)
} catch (error) {
  report.failures.push(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
} finally {
  mkdirSync(reportDir, { recursive: true })
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(reportDir, 'report.json'), serialized, 'utf8')
  writeFileSync(path.join(reportRoot, 'latest.json'), serialized, 'utf8')
}

console.log(JSON.stringify({
  status: report.status,
  runId,
  checks: report.checks.length,
  summary: report.summary,
  failures: report.failures,
  reportDir
}, null, 2))

function runNegativeFixtures() {
  const mutation = discovery.entries.find((entry) => entry.expectedAccess === 'mutation')
  assert(mutation, 'negative fixture requires a discovered mutation')
  const missing = EFFECT_ENTRY_REGISTRY.filter((entry) => entry.id !== mutation.id)
  assertFailure(missing, /unregistered effect entry/, 'unregistered mutation is rejected')

  const writeFile = replaceEntry('tool:write_file', { access: 'read_only', effectPolicy: 'none', replayPolicy: 'not_applicable' })
  assertFailure(writeFile, /conflicts with discovered mutation|mutation-shaped entry/, 'mutation marked read_only is rejected')

  const missingReconciler = replaceEntry('tool:write_file', { effectTargets: ['missing_reconciler_fixture'] })
  assertFailure(missingReconciler, /is not declared|has no Reconciler/, 'queryable entry without Reconciler is rejected')

  const opaqueEntry = EFFECT_ENTRY_REGISTRY.find((entry) => entry.effectPolicy === 'opaque')
  assert(opaqueEntry, 'negative fixture requires an opaque entry')
  const automaticReplay = replaceEntry(opaqueEntry.id, { replayPolicy: 'automatic' })
  assertFailure(automaticReplay, /cannot authorize automatic replay/, 'opaque automatic replay is rejected')
}

function assertAcceptanceReviewIsDurableMutation() {
  const id = 'ipc:workflowLedger:reviewAcceptance'
  const discovered = discovery.entries.find((entry) => entry.id === id)
  const registered = EFFECT_ENTRY_REGISTRY.find((entry) => entry.id === id)
  assert(discovered?.expectedAccess === 'mutation', `${id} must be discovered as a mutation`)
  assert(
    registered?.access === 'mutation' &&
      registered.effectPolicy === 'durable_local' &&
      registered.replayPolicy === 'idempotent_resume',
    `${id} must use the durable local mutation contract`
  )
  check('Acceptance review IPC is classified as a durable mutation')
}

function assertMergedIpcCoverage() {
  const groups = {
    appFeatures: ['appFeatures:invoke'],
    migration: ['migration:scan', 'migration:import', 'migration:apply', 'migration:rollback'],
    notification: [
      'notificationConnectors:list',
      'notificationConnectors:create',
      'notificationConnectors:delete',
      'notificationConnectors:setDefault'
    ],
    localCompute: ['providers:activateLocalCompute'],
    routineReview: ['routines:reviewRun'],
    outboundPreview: ['sessions:outboundContextPreview']
  }
  const discovered = new Set(discovery.entries.map((entry) => entry.id))
  for (const [group, channels] of Object.entries(groups)) {
    for (const channel of channels) {
      assert(discovered.has(`ipc:${channel}`), `${group} IPC was not discovered: ${channel}`)
    }
  }
  check('merged app feature, migration, notification, local compute, routine review, and outbound preview IPCs are discovered')
}

function replaceEntry(id, patch) {
  return EFFECT_ENTRY_REGISTRY.map((entry) => entry.id === id ? { ...entry, ...patch } : entry)
}

function assertFailure(registry, expected, label) {
  const failures = validateEffectEntryRegistry(registry, discovery)
  assert(failures.some((failure) => expected.test(failure)), `${label}: ${failures.join('; ')}`)
  check(label, 'negative')
}

function summarize(registry, currentDiscovery) {
  return {
    entries: registry.length,
    surfaces: countBy(registry, (entry) => entry.id.split(':')[0]),
    access: countBy(registry, (entry) => entry.access),
    effectPolicies: countBy(registry, (entry) => entry.effectPolicy),
    effectTargetKinds: currentDiscovery.effectTargetKinds.size,
    reconciledTargetKinds: currentDiscovery.reconciledTargetKinds.size,
    negativePaths: report.checks.filter((item) => item.kind === 'negative').length
  }
}

function countBy(values, keyFor) {
  const counts = {}
  for (const value of values) {
    const key = keyFor(value)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function check(name, kind = 'positive') {
  report.checks.push({ name, kind, status: 'passed' })
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function gitOutput(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'unknown'
  }
}
