#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const required = process.argv.includes('--required')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'critical-recovery-evidence')
const reportDir = path.join(reportRoot, runId)
const reportPath = path.join(reportDir, 'report.json')
const latestPath = path.join(reportRoot, 'latest.json')
const expectedCommit = git(['rev-parse', 'HEAD'])
const startState = gitState()
const reportCache = new Map()
const commandCache = new Map()
const cells = []
const gaps = []

const reportSources = {
  supervisorState: 'test-results/supervisor-state-smoke/latest.json',
  supervisorRestart: 'test-results/supervisor-restart-e2e/latest.json',
  domainRestart: 'test-results/domain-restart-parity/latest.json',
  notificationEffect: 'test-results/notification-effect/latest.json',
  externalEffect: 'test-results/external-effect-recovery/latest.json',
  sessionDeletion: 'test-results/session-deletion-recovery/latest.json',
  durableDirectWrite: 'test-results/durable-direct-write-recovery/latest.json',
  providerProfileRestart: findLatestReport('test-results/provider-profile-restart')
}

addReportCell('RUN-004', 'strong_kill', 'supervisorRestart',
  'SIGKILL child recovery blocks the run, expires the lease, and preserves fencing')
addReportCell('RUN-004', 'network_unknown_result', 'supervisorState',
  'waiting_reconciliation state blocks authorization after an unknown provider outcome',
  (report) => report.result?.reconciliation?.waitingReconciliationBlocksResume === true)
addReportCell('RUN-004', 'duplicate_idempotency', 'supervisorState',
  'duplicate sourceEventId leaves usage and revision unchanged',
  (report) => report.result?.budget?.duplicateEventIdempotent === true)
addReportCell('RUN-004', 'out_of_order', 'supervisorState',
  'delayed observations are audited but cannot regress canonical state',
  (report) => report.result?.budget?.outOfOrderObservationIgnored === true)

addReportCell('RUN-005', 'strong_kill', 'domainRestart',
  'cross-domain state survives a strong process kill after durable barriers',
  (report) => hasCheck(report, 'strong_kill_after_durable_barriers'))
addReportCell('RUN-005', 'network_unknown_result', 'domainRestart',
  'unknown Effect outcome is persisted and resume remains blocked',
  (report) => hasCheck(report, 'unknown_effect_is_persisted_and_blocks_resume'))
addReportCell('RUN-005', 'duplicate_idempotency', 'domainRestart',
  'recovery performs zero automatic replay and repeated recovery is idempotent',
  (report) => hasCheck(report, 'recovery_performs_zero_automatic_replays') &&
    hasCheck(report, 'repeated_recovery_is_fully_idempotent'))
addReportCell('RUN-005', 'out_of_order', 'domainRestart',
  'delayed Supervisor observation is recorded without state regression',
  (report) => hasCheck(report, 'out_of_order_observation_is_audited_without_state_regression'))

addCommandCell('TRUST-002', 'duplicate_idempotency', 'test:effect-reconciliation',
  'Effect reconciliation rejects duplicate side effects and reuses existing receipts')
addReportCell('TRUST-003', 'strong_kill', 'externalEffect',
  'external Issue and MCP effects are reconciled after SIGKILL',
  (report) => report.summary?.hardKill === true)
addReportCell('TRUST-003', 'network_unknown_result', 'notificationEffect',
  'HTTP and transport failures remain waiting_reconciliation',
  (report) => report.summary?.waitingEffects >= 1 && report.summary?.automaticResends === 0)
addReportCell('TRUST-003', 'duplicate_idempotency', 'notificationEffect',
  'confirmed notification toolUseId cannot be resent',
  (report) => report.summary?.automaticResends === 0 && report.summary?.confirmedEffects >= 1)

addReportCell('TRUST-004', 'strong_kill', 'externalEffect',
  'registered external Effect targets survive a hard kill and reconcile without replay',
  (report) => report.summary?.hardKill === true && report.summary?.automaticIssueReplays === 0)
addCommandCell('TRUST-004', 'duplicate_idempotency', 'test:effect-reconciliation',
  'Effect reconciliation preserves generation and idempotency fences')

addCommandCell('ART-002', 'duplicate_idempotency', 'test:acceptance-failure-ingress',
  'replayed Acceptance failure events do not create a second Evidence or repair')
addCommandCell('ART-002', 'out_of_order', 'test:acceptance-failure-ingress',
  'reordered criterion evidence is normalized without changing the Acceptance identity')

addReportCell('NFR-REC-001', 'strong_kill', 'sessionDeletion',
  'Session deletion resumes through every destructive phase after SIGKILL',
  (report) => report.checks?.some((check) => check.id === 'strong_kill_verified'))
addReportCell('NFR-REC-001', 'duplicate_idempotency', 'sessionDeletion',
  'duplicate pending deletion journals fail closed without a second mutation',
  (report) => report.checks?.some((check) => check.id === 'duplicate_pending_journal_fails_closed'))

addReportCell('NFR-REC-003', 'strong_kill', 'providerProfileRestart',
  'Provider profile import and rollback survive process interruption',
  (report) => report.status === 'passed' && report.scenarios?.length >= 1)
addCommandCell('NFR-REC-003', 'network_unknown_result', 'test:provider-request-timeout',
  'Provider timeout is classified as an unknown external result and remains recoverable')
addReportCell('NFR-REC-003', 'duplicate_idempotency', 'providerProfileRestart',
  'Provider profile restart scenarios preserve one operation identity',
  (report) => report.status === 'passed' && report.scenarios?.length >= 1)

addReportCell('NFR-REC-004', 'strong_kill', 'supervisorRestart',
  'Supervisor lease and fencing recover after process kill',
  (report) => report.result?.childSignal === 'SIGKILL')
addReportCell('NFR-REC-004', 'network_unknown_result', 'supervisorState',
  'Supervisor blocks a run awaiting reconciliation',
  (report) => report.result?.reconciliation?.waitingReconciliationBlocksResume === true)
addReportCell('NFR-REC-004', 'duplicate_idempotency', 'supervisorState',
  'Supervisor duplicate observations are idempotent',
  (report) => report.result?.budget?.duplicateEventIdempotent === true)
addReportCell('NFR-REC-004', 'out_of_order', 'supervisorState',
  'Supervisor delayed observations cannot regress state',
  (report) => report.result?.budget?.outOfOrderObservationIgnored === true)

addCommandCell('NFR-REC-005', 'strong_kill', 'test:migration-effect',
  'migration import Effect survives SIGKILL without replaying the callback')
addCommandCell('NFR-REC-005', 'duplicate_idempotency', 'test:migration-effect',
  'migration import callback executes once across recovery')

const endState = gitState()
const verifiedCells = cells.filter((cell) => cell.status === 'verified')
const complete = startState.clean && endState.clean && startState.commit === expectedCommit &&
  endState.commit === expectedCommit && verifiedCells.length === 44 && gaps.length === 0
const report = {
  schemaVersion: 1,
  gate: 'test:critical-recovery-evidence-bundle',
  runId,
  required,
  status: complete ? 'passed' : required ? 'failed' : 'partial',
  verification: complete ? 'verified' : 'not_verified',
  sourceRevision: expectedCommit,
  startState,
  endState,
  faultCellCount: 44,
  verifiedCellCount: verifiedCells.length,
  cells,
  gaps,
  commands: [...commandCache.values()]
}

mkdirSync(reportDir, { recursive: true })
const serialized = `${JSON.stringify(report, null, 2)}\n`
writeFileSync(reportPath, serialized, 'utf8')
writeFileSync(latestPath, serialized, 'utf8')
console.log(JSON.stringify({
  status: report.status,
  verification: report.verification,
  sourceRevision: report.sourceRevision,
  verifiedCellCount: report.verifiedCellCount,
  faultCellCount: report.faultCellCount,
  gapCount: report.gaps.length,
  reportPath: path.relative(repoRoot, reportPath)
}, null, 2))
if (report.status === 'failed') process.exitCode = 1

function addReportCell(requirementId, faultClass, sourceKey, reason, predicate = () => true) {
  const cell = { requirementId, faultClass, status: 'open', reason, evidence: [] }
  const sourcePath = reportSources[sourceKey]
  const report = loadReport(sourceKey, sourcePath)
  if (report && predicate(report)) {
    cell.status = 'verified'
    cell.evidence.push({ source: sourcePath, sourceRevision: report.sourceRevision })
  } else if (report) {
    cell.reason = `${reason}; source report does not contain the required assertion`
    gaps.push({ requirementId, faultClass, reason: cell.reason, source: sourcePath })
  } else {
    gaps.push({ requirementId, faultClass, reason: cell.reason, source: sourcePath })
  }
  cells.push(cell)
}

function addCommandCell(requirementId, faultClass, script, reason) {
  const cell = { requirementId, faultClass, status: 'open', reason, evidence: [] }
  const result = runCommand(script)
  if (result.status === 'passed') {
    cell.status = 'verified'
    cell.evidence.push({ command: script, commandRunId: result.runId, outputDigest: result.outputDigest })
  } else {
    gaps.push({ requirementId, faultClass, reason: `${reason}; command failed`, command: script })
  }
  cells.push(cell)
}

function loadReport(key, sourcePath) {
  if (reportCache.has(key)) return reportCache.get(key)
  if (!sourcePath || !existsSync(path.join(repoRoot, sourcePath))) {
    reportCache.set(key, null)
    return null
  }
  try {
    const report = JSON.parse(readFileSync(path.join(repoRoot, sourcePath), 'utf8'))
    const valid = report.status === 'passed' && report.sourceRevision === expectedCommit &&
      report.worktreeStatusCount === 0
    if (!valid) {
      gaps.push({ source: sourcePath, reason: 'report is not passed and clean-bound to the current SHA' })
      reportCache.set(key, null)
      return null
    }
    reportCache.set(key, report)
    return report
  } catch (error) {
    gaps.push({ source: sourcePath, reason: `invalid report: ${String(error)}` })
    reportCache.set(key, null)
    return null
  }
}

function runCommand(script) {
  if (commandCache.has(script)) return commandCache.get(script)
  const started = Date.now()
  const result = spawnSync('npm', ['run', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: process.env
  })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const record = {
    script,
    runId: new Date().toISOString(),
    status: result.status === 0 ? 'passed' : 'failed',
    exitCode: result.status,
    signal: result.signal,
    durationMs: Date.now() - started,
    outputDigest: sha256(output),
    sourceRevision: git(['rev-parse', 'HEAD']),
    worktreeStatusCount: gitState().statusEntryCount
  }
  commandCache.set(script, record)
  return record
}

function findLatestReport(root) {
  const absolute = path.join(repoRoot, root)
  if (existsSync(path.join(absolute, 'latest.json'))) return path.join(root, 'latest.json')
  if (!existsSync(absolute)) return null
  const candidates = readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(absolute, entry.name, 'report.json')))
    .map((entry) => path.join(absolute, entry.name, 'report.json'))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
  return candidates[0] ? path.relative(repoRoot, candidates[0]) : null
}

function hasCheck(report, id) {
  return Array.isArray(report.checks) && report.checks.some((check) => check.id === id)
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

function gitState() {
  const status = git(['status', '--porcelain=v1', '--untracked-files=all'])
  return { commit: git(['rev-parse', 'HEAD']), clean: status.length === 0, statusEntryCount: status ? status.split('\n').filter(Boolean).length : 0 }
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
