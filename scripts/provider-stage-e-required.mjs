#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { verifyBuildEvidence } from './lib/build-evidence.mjs'
import { bindSourceEvidence, readSourceEvidenceState } from './lib/source-evidence-binding.mjs'
import {
  summarizeBuild,
  validateEvidenceDocument
} from './lib/provider-stage-e-validation.mjs'

const COMMANDS = [
  { id: 'provider-profile', script: 'test:provider-profile:required' },
  { id: 'cc-switch-migration', script: 'test:cc-switch-migration:required' },
  { id: 'provider-key-failover', script: 'test:provider-key-failover' },
  { id: 'provider-target-failover', script: 'test:model-failover' },
  { id: 'routing-recovery', script: 'test:routing-recovery-ladder:required' },
  { id: 'local-provider-parity', script: 'test:local-provider-parity:required' }
]

const REPORTS = [
  evidence('provider-profile-smoke', 'test-results/provider-profile-smoke/latest.json',
    'test:provider-profile', 'provider-profile'),
  evidence('provider-profile-restart', 'test-results/provider-profile-restart/latest.json',
    'test:provider-profile:restart', 'provider-profile'),
  evidence('provider-profile-electron', 'test-results/provider-profile-e2e/latest.json',
    'test:provider-profile:e2e', 'provider-profile', true),
  evidence('cc-switch-provider-import', 'test-results/cc-switch-import-smoke/latest.json',
    'test:cc-switch-import', 'cc-switch-migration'),
  evidence('cc-switch-provider-restart', 'test-results/cc-switch-import-restart/latest.json',
    'test:cc-switch-import:restart', 'cc-switch-migration'),
  evidence('cc-switch-provider-electron', 'test-results/cc-switch-import-e2e/latest.json',
    'test:cc-switch-import:e2e', 'cc-switch-migration', true),
  evidence('cc-switch-assets', 'test-results/cc-switch-assets-migration-smoke/latest.json',
    'test:cc-switch-assets', 'cc-switch-migration'),
  evidence('cc-switch-assets-electron', 'test-results/cc-switch-assets-migration-e2e/latest.json',
    'test:cc-switch-assets:e2e', 'cc-switch-migration', true),
  evidence('provider-usage-summary', 'test-results/provider-usage-smoke/latest.json',
    'test:provider-usage:summary', 'cc-switch-migration'),
  evidence('provider-usage-dashboard', 'test-results/provider-usage-dashboard-smoke/latest.json',
    'test:provider-usage:dashboard', 'cc-switch-migration'),
  evidence('provider-usage-electron', 'test-results/provider-usage-dashboard-e2e/latest.json',
    'test:provider-usage:e2e', 'cc-switch-migration', true),
  evidence('provider-request-timeout', 'test-results/provider-request-timeout/latest.json',
    'test:provider-request-timeout', 'cc-switch-migration'),
  evidence('provider-key-failover', 'test-results/provider-key-failover/latest.json',
    'test:provider-key-failover', 'provider-key-failover'),
  evidence('provider-target-failover', 'test-results/failover-target/latest.json',
    'test:failover-target', 'provider-target-failover'),
  evidence('routing-recovery-ladder', 'test-results/routing-recovery-ladder/latest.json',
    'test:routing-recovery-ladder:required', 'routing-recovery'),
  evidence('anthropic-failover', 'test-results/anthropic-failover/latest.json',
    'test:anthropic-failover:required', 'routing-recovery'),
  evidence('provider-cross-resume', 'test-results/provider-cross-resume/latest.json',
    'test:provider-cross-resume', 'routing-recovery'),
  evidence('local-provider-parity', 'test-results/local-provider-parity/latest.json',
    'test:local-provider-parity:required', 'local-provider-parity'),
  evidence('routing-zero-choice-electron', 'test-results/routing-zero-choice/latest.json',
    'test:routing-zero-choice:required', 'local-provider-parity', true)
]

if (process.argv.includes('--self-test')) {
  runSelfTest()
} else {
  runGate()
}

function runGate() {
  const context = createGateContext(process.cwd())
  try {
    inspectInitialSource(context)
    if (context.failures.length === 0 && !context.verifyOnly) runRequiredCommands(context)
    inspectFinalSource(context)
    inspectBuildEvidence(context)
    collectEvidenceResults(context)
  } catch (error) {
    context.unexpectedError = errorMessage(error)
    context.failures.push(`Stage E gate error: ${context.unexpectedError}`)
  } finally {
    finalizeGate(context)
  }
}

function createGateContext(repoRoot) {
  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  const reportRoot = path.join(repoRoot, 'test-results', 'provider-stage-e-required')
  const reportDir = path.join(reportRoot, runId)
  mkdirSync(reportDir, { recursive: true })
  return {
    repoRoot,
    runId,
    reportRoot,
    reportDir,
    reportPath: path.join(reportDir, 'report.json'),
    latestPath: path.join(reportRoot, 'latest.json'),
    verifyOnly: process.argv.includes('--verify-only'),
    failures: [],
    commandResults: [],
    evidenceResults: []
  }
}

function inspectInitialSource(context) {
  context.startState = readSourceEvidenceState(context.repoRoot)
  context.expectedCommit = expectedCommitArgument() || context.startState.commit
  if (context.startState.commit !== context.expectedCommit) {
    context.failures.push(`HEAD ${context.startState.commit} does not match expected ${context.expectedCommit}`)
  }
  if (!context.startState.worktreeClean || context.startState.statusEntryCount !== 0) {
    context.failures.push(`Stage E requires a clean worktree; found ${context.startState.statusEntryCount} status entries`)
  }
}

function runRequiredCommands(context) {
  for (const command of COMMANDS) {
    const result = runCommand(
      context.repoRoot,
      context.reportDir,
      command,
      context.expectedCommit,
      context.startState.checkoutDigest
    )
    context.commandResults.push(result)
    if (result.status !== 'passed') context.failures.push(`${command.script}: ${result.reason}`)
    if (result.source?.status !== 'pass') {
      context.failures.push(`${command.script}: source became dirty or drifted`)
      break
    }
  }
}

function inspectFinalSource(context) {
  context.endState = readSourceEvidenceState(context.repoRoot)
  if (!context.expectedCommit) return
  if (context.endState.commit !== context.expectedCommit) {
    context.failures.push(`final HEAD ${context.endState.commit} does not match ${context.expectedCommit}`)
  }
  if (!context.endState.worktreeClean || context.endState.statusEntryCount !== 0) {
    context.failures.push(`final worktree is not clean (${context.endState.statusEntryCount} status entries)`)
  }
  if (context.startState?.checkoutDigest !== context.endState.checkoutDigest) {
    context.failures.push('source checkout drifted during Stage E')
  }
}

function inspectBuildEvidence(context) {
  try {
    context.currentBuild = verifyBuildEvidence(context.repoRoot, context.endState)
    if (context.currentBuild.status !== 'pass') {
      context.failures.push(`current build evidence failed: ${context.currentBuild.errors.join('; ')}`)
    }
  } catch (error) {
    context.failures.push(`current build evidence is unavailable: ${errorMessage(error)}`)
  }
}

function collectEvidenceResults(context) {
  const commandsById = new Map(context.commandResults.map((result) => [result.id, result]))
  for (const definition of REPORTS) {
    const result = readAndValidateEvidence(context.repoRoot, definition, {
      expectedCommit: context.expectedCommit,
      checkoutDigest: context.startState?.checkoutDigest,
      currentBuild: context.currentBuild,
      producer: context.verifyOnly ? undefined : commandsById.get(definition.producedBy)
    })
    context.evidenceResults.push(result)
    for (const error of result.errors) context.failures.push(`${definition.id}: ${error}`)
  }
}

function finalizeGate(context) {
  try {
    context.endState ??= readSourceEvidenceState(context.repoRoot)
  } catch (error) {
    context.failures.push(`unable to read final source state: ${errorMessage(error)}`)
  }
  const report = createGateReport(context)
  if (context.startState && context.endState) bindSourceEvidence(report, context.startState, context.endState, 'Provider Stage E')
  enforceCleanReportBoundaries(report)
  const body = `${JSON.stringify(report, null, 2)}\n`
  atomicWrite(context.reportPath, body)
  atomicWrite(context.latestPath, body)
  console.log(JSON.stringify({
    status: report.status,
    verification: report.verification,
    expectedSourceRevision: report.expectedSourceRevision,
    commandCount: report.commands.length,
    evidenceCount: report.evidence.length,
    failureCount: report.failures.length,
    reportPath: path.relative(context.repoRoot, context.reportPath)
  }, null, 2))
  if (report.status !== 'passed') process.exitCode = 1
}

function createGateReport(context) {
  const passed = context.failures.length === 0
  return {
    schemaVersion: 1,
    gate: 'test:provider-stage-e:required',
    runId: context.runId,
    generatedAt: new Date().toISOString(),
    mode: context.verifyOnly ? 'verify-only' : 'run-and-verify',
    status: passed ? 'passed' : 'failed',
    verification: passed ? 'verified' : 'not_verified',
    expectedSourceRevision: context.expectedCommit,
    expectedCheckoutDigest: context.startState?.checkoutDigest,
    sourceRevision: context.startState?.commit,
    sourceRevisionAtEnd: context.endState?.commit,
    sourceWorktreeClean: context.startState?.worktreeClean,
    sourceWorktreeCleanAtEnd: context.endState?.worktreeClean,
    sourceStatusEntryCount: context.startState?.statusEntryCount,
    sourceStatusEntryCountAtEnd: context.endState?.statusEntryCount,
    sourceCheckoutDigest: context.startState?.checkoutDigest,
    sourceCheckoutDigestAtEnd: context.endState?.checkoutDigest,
    commands: context.commandResults,
    evidence: context.evidenceResults,
    buildEvidence: summarizeBuild(context.currentBuild),
    failures: context.failures,
    error: context.unexpectedError,
    warnings: []
  }
}

function enforceCleanReportBoundaries(report) {
  if (!report.sourceWorktreeClean || !report.sourceWorktreeCleanAtEnd ||
      report.sourceStatusEntryCount !== 0 || report.sourceStatusEntryCountAtEnd !== 0) {
    report.status = 'failed'
    report.verification = 'not_verified'
  }
}

function runCommand(repoRoot, reportDir, command, expectedCommit, checkoutDigest) {
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const sourceAtStart = readSourceEvidenceState(repoRoot)
  const logPath = path.join(reportDir, `${String(COMMANDS.indexOf(command) + 1).padStart(2, '0')}-${command.id}.log`)
  const fd = openSync(logPath, 'w')
  let child
  try {
    child = spawnSync('npm', ['run', command.script], {
      cwd: repoRoot,
      env: providerSafeEnvironment(),
      stdio: ['ignore', fd, fd],
      timeout: 45 * 60 * 1000
    })
  } finally {
    closeSync(fd)
  }
  const finishedAtMs = Date.now()
  const sourceAtEnd = readSourceEvidenceState(repoRoot)
  const sourceErrors = validateCommandSource(sourceAtStart, sourceAtEnd, expectedCommit, checkoutDigest)
  const status = child?.status === 0 && !child.error && sourceErrors.length === 0 ? 'passed' : 'failed'
  const reason = child?.error
    ? errorMessage(child.error)
    : child?.signal
      ? `terminated by ${child.signal}`
      : child?.status !== 0
        ? `exit code ${child?.status ?? 'missing'}`
        : sourceErrors.join('; ')
  const logBytes = readFileSync(logPath)
  const result = {
    id: command.id,
    script: command.script,
    status,
    reason: status === 'passed' ? undefined : reason,
    exitCode: child?.status,
    signal: child?.signal,
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    logPath: path.relative(repoRoot, logPath),
    logSha256: sha256(logBytes),
    logBytes: logBytes.length,
    source: {
      status: sourceErrors.length === 0 ? 'pass' : 'fail',
      start: sourceAtStart,
      end: sourceAtEnd,
      errors: sourceErrors
    }
  }
  console.log(`[provider-stage-e] ${command.script}: ${status}`)
  return result
}

function validateCommandSource(start, end, expectedCommit, checkoutDigest) {
  const errors = []
  if (start.commit !== expectedCommit || end.commit !== expectedCommit) errors.push('HEAD mismatch')
  if (!start.worktreeClean || !end.worktreeClean) errors.push('worktree is not clean')
  if (start.statusEntryCount !== 0 || end.statusEntryCount !== 0) errors.push('status entries are present')
  if (start.checkoutDigest !== checkoutDigest || end.checkoutDigest !== checkoutDigest) errors.push('checkout digest mismatch')
  return errors
}

function readAndValidateEvidence(repoRoot, definition, context) {
  const absolutePath = path.join(repoRoot, definition.path)
  const errors = []
  let report
  let file
  if (!existsSync(absolutePath)) {
    return { ...definition, status: 'failed', errors: ['report is missing'] }
  }
  try {
    const bytes = readFileSync(absolutePath)
    file = {
      bytes: bytes.length,
      sha256: sha256(bytes),
      modifiedAt: new Date(statSync(absolutePath).mtimeMs).toISOString()
    }
    report = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    return { ...definition, status: 'failed', errors: [`report is unreadable: ${errorMessage(error)}`] }
  }

  errors.push(...validateEvidenceDocument(definition, report, context))
  if (context.producer) {
    const modifiedAtMs = statSync(absolutePath).mtimeMs
    const producerStartedAtMs = Date.parse(context.producer.startedAt)
    if (!Number.isFinite(producerStartedAtMs) || modifiedAtMs + 1_000 < producerStartedAtMs) {
      errors.push(`report was not refreshed by ${context.producer.script}`)
    }
  }
  return {
    ...definition,
    status: errors.length === 0 ? 'passed' : 'failed',
    reportStatus: report.status,
    reportRunId: report.runId,
    sourceRevision: report.sourceRevision,
    sourceCheckoutDigest: report.sourceCheckoutDigest,
    buildOutputDigest: report.buildEvidence?.output?.digest,
    file,
    errors
  }
}

function providerSafeEnvironment() {
  const env = { ...process.env, CAOGEN_PROVIDER_STAGE_E: '1' }
  for (const name of Object.keys(env)) {
    if (/(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PRIVATE_?KEY|CREDENTIALS?)(?:_|$)/i.test(name) ||
        /(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|credential)/i.test(name)) delete env[name]
  }
  for (const name of [
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY',
    'DEEPSEEK_API_KEY', 'CAOGEN_PRIVATE_PROVIDER_CONFIG', 'CAOGEN_REAL_PROVIDER_CONFIG',
    'AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'AZURE_CONFIG_DIR'
  ]) delete env[name]
  env.NO_PROXY = '127.0.0.1,localhost,::1'
  env.no_proxy = env.NO_PROXY
  return env
}

function expectedCommitArgument() {
  const index = process.argv.indexOf('--expected-sha')
  const value = index >= 0 ? process.argv[index + 1] : process.env.CAOGEN_EXPECTED_SOURCE_SHA
  if (value !== undefined && !/^[0-9a-f]{40}$/i.test(value)) throw new Error('--expected-sha must be a full Git SHA')
  return value?.toLowerCase()
}

function evidence(id, reportPath, gate, producedBy, electron = false) {
  return { id, path: reportPath, gate, producedBy, electron }
}

function atomicWrite(target, body) {
  mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, body, 'utf8')
  renameSync(temporary, target)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function errorMessage(error) {
  return error instanceof Error ? error.stack || error.message : String(error)
}

function runSelfTest() {
  const commit = 'a'.repeat(40)
  const checkoutDigest = 'b'.repeat(64)
  const output = { digest: 'c'.repeat(64), fileCount: 3, totalBytes: 42 }
  const source = { commit, worktreeClean: true, statusEntryCount: 0, checkoutDigest }
  const buildEvidence = {
    status: 'pass',
    errors: [],
    evidence: {
      schemaVersion: 1,
      kind: 'caogen-build-evidence',
      status: 'passed',
      source: { status: 'pass', start: source, end: source, drift: [] },
      output,
      outputValidation: { status: 'pass', errors: [] }
    },
    output
  }
  const definition = evidence('fixture', 'fixture.json', 'fixture:gate', 'fixture-command', true)
  const report = {
    schemaVersion: 1,
    gate: definition.gate,
    status: 'passed',
    ok: true,
    pass: 2,
    total: 2,
    failures: [],
    sourceRevision: commit,
    sourceRevisionAtEnd: commit,
    sourceWorktreeClean: true,
    sourceWorktreeCleanAtEnd: true,
    sourceStatusEntryCount: 0,
    sourceStatusEntryCountAtEnd: 0,
    sourceCheckoutDigest: checkoutDigest,
    sourceCheckoutDigestAtEnd: checkoutDigest,
    provenance: { status: 'pass', start: source, end: source, drift: [] },
    buildEvidence
  }
  const context = { expectedCommit: commit, checkoutDigest, currentBuild: buildEvidence }
  assert.deepEqual(validateEvidenceDocument(definition, report, context), [])
  assert(validateEvidenceDocument(definition, { ...report, sourceRevision: 'd'.repeat(40) }, context)
    .some((error) => error.includes('source revision')))
  assert(validateEvidenceDocument(definition, { ...report, sourceWorktreeClean: false }, context)
    .some((error) => error.includes('not clean')))
  assert(validateEvidenceDocument(definition, { ...report, provenance: { ...report.provenance, drift: ['changed'] } }, context)
    .some((error) => error.includes('without drift')))
  assert(validateEvidenceDocument(definition, { ...report, buildEvidence: undefined }, context)
    .some((error) => error.includes('missing build evidence')))
  assert(validateEvidenceDocument(definition, {
    ...report,
    buildEvidence: { ...buildEvidence, output: { ...output, digest: 'e'.repeat(64) } }
  }, context).some((error) => error.includes('does not match current out')))
  console.log(`Provider Stage E evidence self-test passed: ${REPORTS.length} manifest entries`)
}
