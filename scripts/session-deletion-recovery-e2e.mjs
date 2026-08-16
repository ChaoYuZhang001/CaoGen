#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = process.cwd()
const scriptPath = fileURLToPath(import.meta.url)
const nodeRequire = createRequire(import.meta.url)
const Module = nodeRequire('node:module').Module
const phases = ['prepared', 'snapshot_purged', 'stores_purged', 'files_purged', 'verified', 'completed']

process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter)
Module._initPaths()

const mode = process.argv[2]
if (mode === '--crash-worker') {
  await runCrashWorker(decodePayload(process.argv[3]))
} else if (mode === '--restart-probe') {
  await runRestartProbe(decodePayload(process.argv[3]))
} else {
  await runSuite()
}

async function runSuite() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-session-deletion-recovery-'))
  const outDir = path.join(tempRoot, 'compiled')
  const checks = []
  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  const reportDir = path.join(repoRoot, 'test-results', 'session-deletion-recovery', runId)
  let failure
  try {
    compileSources(outDir)
    installElectronStub(outDir)
    const api = loadModules(outDir)
    await runStrongKillCases(api, outDir, tempRoot, checks)
    await runRetentionCases(api, tempRoot, checks)
    await runRecoveryBlockerCases(api, tempRoot, checks)
    await runJournalCorruptionCases(api, tempRoot, checks)
  } catch (error) {
    failure = error
  } finally {
    mkdirSync(reportDir, { recursive: true })
    const report = {
      schemaVersion: 1,
      status: failure ? 'failed' : 'passed',
      runId,
      checks,
      failure: failure ? String(failure.stack ?? failure) : undefined,
      guarantees: [
        'every durable Session deletion phase survives a real strong process kill and resumes in a fresh process',
        'recovery is idempotent and removes all private Session projections without replaying the deletion',
        'canonical Run, ModelAttempt, Artifact, Evidence, Acceptance, and unrelated Session data remain unchanged',
        'minimum retention and legal holds preserve a pending prepared operation until authority permits deletion',
        'identity conflicts, unresolved recovery state, active worktrees, and corrupt journals fail closed'
      ]
    }
    writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    rmSync(tempRoot, { recursive: true, force: true })
  }
  if (failure) throw failure
  process.stdout.write(`session deletion recovery E2E: PASS (${checks.length} checks)\n`)
}

async function runStrongKillCases(api, outDir, tempRoot, checks) {
  for (const phase of phases) {
    await check(checks, `strong_kill_${phase}`, async () => {
      const root = path.join(tempRoot, `phase-${phase}`)
      const fixture = await seedFullFixture(api, root, phase)
      const barrier = await hardKill({ outDir, root, phase, fixture })
      assert.equal(barrier.phase, phase)
      assert.equal(readPendingPhase(root), phase)
      const restart = restartProbe({ outDir, root, phase, fixture, operationId: barrier.operationId })
      assert.equal(restart.pending, 0)
      assert.equal(restart.secondResumeCount, 0)
      assert.equal(restart.canonicalDigest, fixture.canonicalDigest)
      return {
        phase,
        firstResumeCount: restart.firstResumeCount,
        removedPathCount: restart.removedPathCount,
        canonicalDigest: restart.canonicalDigest
      }
    })
  }
}

async function runRetentionCases(api, tempRoot, checks) {
  await check(checks, 'minimum_retention_pending_resume', async () => {
    const root = path.join(tempRoot, 'minimum-retention')
    const fixture = seedLightFixture(root, 'minimum-retention')
    const authority = new api.retention.DataRetentionAuthorityStore(root)
    await authority.updatePolicy({
      requestId: 'retention-policy-on', expectedRevision: 0,
      projectMinimumRetentionMs: 0, sessionMinimumRetentionMs: 60_000
    }, 'test-owner')
    await assertRejects(api.deletion.deleteStandaloneSession(
      fixture.sessionId, fixture.sdkSessionId, root, { retentionAnchorAt: Date.now() }
    ), /retention authority/)
    assert.equal(new api.journal.SessionDeletionJournal(root).listPending().length, 1)
    assertTargetDataPresent(root, fixture)
    assert.deepEqual(await api.deletion.resumeSessionDeletions(root), [])
    await authority.updatePolicy({
      requestId: 'retention-policy-off', expectedRevision: 1,
      projectMinimumRetentionMs: 0, sessionMinimumRetentionMs: 0
    }, 'test-owner')
    assert.equal((await api.deletion.resumeSessionDeletions(root)).length, 1)
    await assertDeleted(api, root, fixture)
    return { queuedPhase: 'prepared', resumed: true }
  })

  await check(checks, 'legal_hold_pending_resume', async () => {
    const root = path.join(tempRoot, 'legal-hold')
    const fixture = seedLightFixture(root, 'legal-hold')
    const authority = new api.retention.DataRetentionAuthorityStore(root)
    const held = await authority.createLegalHold({
      requestId: 'hold-create', expectedRevision: 0,
      subject: { kind: 'session', id: fixture.sessionId }, reason: 'Preserve for audit'
    }, 'test-owner')
    await assertRejects(api.deletion.deleteStandaloneSession(
      fixture.sessionId, fixture.sdkSessionId, root
    ), /retention authority/)
    assertTargetDataPresent(root, fixture)
    const hold = held.legalHolds.find((candidate) => candidate.status === 'active')
    assert(hold)
    await authority.releaseLegalHold({
      requestId: 'hold-release', expectedRevision: held.revision,
      holdId: hold.id, reason: 'Audit complete'
    }, 'test-owner')
    assert.equal((await api.deletion.resumeSessionDeletions(root)).length, 1)
    await assertDeleted(api, root, fixture)
    return { holdId: hold.id, resumed: true }
  })
}

async function runRecoveryBlockerCases(api, tempRoot, checks) {
  await check(checks, 'prepared_identity_mismatch_fails_closed', async () => {
    const root = path.join(tempRoot, 'identity-mismatch')
    const fixture = seedLightFixture(root, 'identity-mismatch')
    const journal = new api.journal.SessionDeletionJournal(root)
    const prepared = await journal.begin({
      sessionId: fixture.sessionId,
      sdkSessionId: fixture.sdkSessionId,
      retentionTargets: [{
        subject: { kind: 'session', id: fixture.sessionId }, retentionAnchorAt: Date.now()
      }],
      legalHoldSubjects: [{ kind: 'session', id: fixture.sessionId }]
    })
    await assertRejects(api.deletion.deleteStandaloneSession(
      fixture.sessionId, `${fixture.sdkSessionId}-changed`, root
    ), /does not match the prepared history identity/)
    assert.equal(journal.listPending()[0].operationId, prepared.operationId)
    assertTargetDataPresent(root, fixture)
    assert.equal((await api.deletion.resumeSessionDeletions(root)).length, 1)
    await assertDeleted(api, root, fixture)
    return { operationId: prepared.operationId }
  })

  await check(checks, 'unresolved_effect_preserves_recovery_entry', async () => {
    const root = path.join(tempRoot, 'unresolved-effect')
    const fixture = await seedRecoveryBlockerFixture(api, root, 'unresolved-effect', 'waiting_reconciliation')
    await assertRejects(api.deletion.deleteStandaloneSession(
      fixture.sessionId, fixture.sdkSessionId, root
    ), /unresolved Effect/)
    assertTargetDataPresent(root, fixture)
    assert(await api.snapshots.getTaskSnapshot(fixture.sessionId, root))
    assert.equal(new api.journal.SessionDeletionJournal(root).listPending()[0].phase, 'prepared')
    return { blockedPhase: 'prepared' }
  })

  await check(checks, 'started_model_attempt_preserves_recovery_entry', async () => {
    const root = path.join(tempRoot, 'started-model-attempt')
    const fixture = await seedRecoveryBlockerFixture(api, root, 'started-model-attempt', 'confirmed')
    await api.modelAttempts.startPersistedModelAttempt({
      id: fixture.attemptId, commandId: 'command-started', requestId: 'request-started',
      runId: fixture.runId, providerId: 'fixture-provider', model: 'fixture-model',
      protocol: 'openai.responses', adapterVersion: 'adapter-v1',
      contextDigest: sha256('started-context'), routeReason: 'Recovery gate fixture.',
      keyLabel: 'label:synthetic', startedAt: Date.now()
    }, root)
    await assertRejects(api.deletion.deleteStandaloneSession(
      fixture.sessionId, fixture.sdkSessionId, root
    ), /ModelAttempt/)
    assertTargetDataPresent(root, fixture)
    assert(await api.snapshots.getTaskSnapshot(fixture.sessionId, root))
    return { attemptId: fixture.attemptId }
  })

  await check(checks, 'active_worktree_blocks_before_destructive_phase', async () => {
    const root = path.join(tempRoot, 'active-worktree')
    const fixture = seedLightFixture(root, 'active-worktree')
    seedWorktreeRegistry(root, fixture, 'active')
    const before = targetDataDigest(root, fixture)
    await assertRejects(api.deletion.deleteStandaloneSession(
      fixture.sessionId, fixture.sdkSessionId, root
    ), /active managed worktree prevents Session deletion/)
    assert.equal(targetDataDigest(root, fixture), before)
    assert.equal(new api.journal.SessionDeletionJournal(root).listPending()[0].phase, 'prepared')
    return { destructiveWrites: 0 }
  })
}

async function runJournalCorruptionCases(api, tempRoot, checks) {
  await check(checks, 'corrupt_journal_fails_closed', async () => {
    const root = path.join(tempRoot, 'corrupt-journal')
    const fixture = seedLightFixture(root, 'corrupt-journal')
    const file = journalFile(root)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '{"schemaVersion":2,"revision":0,"entries":[]}\n', { mode: 0o600 })
    const before = digestTree(root)
    await assertRejects(api.deletion.resumeSessionDeletions(root), /journal is invalid/)
    assert.equal(digestTree(root), before)
    assertTargetDataPresent(root, fixture)
    return { mutationCount: 0 }
  })

  await check(checks, 'duplicate_pending_journal_fails_closed', async () => {
    const root = path.join(tempRoot, 'duplicate-journal')
    const fixture = seedLightFixture(root, 'duplicate-journal')
    const journal = new api.journal.SessionDeletionJournal(root)
    await journal.begin({
      sessionId: fixture.sessionId, sdkSessionId: fixture.sdkSessionId,
      retentionTargets: [{
        subject: { kind: 'session', id: fixture.sessionId }, retentionAnchorAt: Date.now()
      }],
      legalHoldSubjects: [{ kind: 'session', id: fixture.sessionId }]
    })
    const document = JSON.parse(readFileSync(journal.filePath, 'utf8'))
    document.entries.push({ ...document.entries[0], operationId: 'duplicate-operation' })
    writeFileSync(journal.filePath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    const before = digestTree(root)
    await assertRejects(api.deletion.resumeSessionDeletions(root), /duplicate pending sessions/)
    assert.equal(digestTree(root), before)
    assertTargetDataPresent(root, fixture)
    return { mutationCount: 0 }
  })
}

async function runCrashWorker(payload) {
  process.env.CAOGEN_TEST_USER_DATA = payload.root
  const api = loadModules(payload.outDir)
  let barrierSent = false
  await api.deletion.deleteStandaloneSession(
    payload.fixture.sessionId,
    payload.fixture.sdkSessionId,
    payload.root,
    {
      retentionAnchorAt: payload.fixture.retentionAnchorAt,
      afterPhase: async (phase, entry) => {
        if (barrierSent || phase !== payload.phase) return
        barrierSent = true
        process.send?.({
          kind: 'session-deletion-barrier', phase, operationId: entry.operationId
        })
        setInterval(() => undefined, 1_000)
        await new Promise(() => undefined)
      }
    }
  )
  throw new Error(`crash worker completed without reaching ${payload.phase}`)
}

async function runRestartProbe(payload) {
  process.env.CAOGEN_TEST_USER_DATA = payload.root
  const api = loadModules(payload.outDir)
  const first = await api.deletion.resumeSessionDeletions(payload.root)
  const beforeSecond = digestTree(payload.root)
  const second = await api.deletion.resumeSessionDeletions(payload.root)
  assert.equal(digestTree(payload.root), beforeSecond)
  await assertDeleted(api, payload.root, payload.fixture)
  const canonical = await canonicalState(api, payload.root, payload.fixture)
  assert.equal(canonical.digest, payload.fixture.canonicalDigest)
  const completed = completedEntry(payload.root, payload.operationId)
  assert.equal(completed.phase, 'completed')
  const result = {
    firstResumeCount: first.length,
    secondResumeCount: second.length,
    pending: new api.journal.SessionDeletionJournal(payload.root).listPending().length,
    removedPathCount: first[0]?.removedPathCount ?? completed.removedPathCount ?? 0,
    canonicalDigest: canonical.digest
  }
  process.stdout.write(`SESSION_DELETION_RESTART:${JSON.stringify(result)}\n`)
}

async function seedFullFixture(api, root, suffix) {
  const fixture = seedLightFixture(root, suffix)
  process.env.CAOGEN_TEST_USER_DATA = root
  await api.workflow.createWorkflowGoal({
    id: fixture.goalId, projectId: fixture.projectId, title: 'Retained Goal',
    objective: 'Prove canonical delivery records survive history deletion.',
    status: 'running', revision: 1, source: 'explicit',
    createdAt: fixture.retentionAnchorAt, updatedAt: fixture.retentionAnchorAt
  }, root)
  await api.workflow.createWorkflowWorkItem({
    id: fixture.workItemId, projectId: fixture.projectId, goalId: fixture.goalId,
    type: 'testing', title: 'Retained WorkItem', status: 'running', revision: 1,
    source: 'explicit', runIds: [fixture.runId], currentRunId: fixture.runId,
    createdAt: fixture.retentionAnchorAt, updatedAt: fixture.retentionAnchorAt
  }, root)
  const run = taskRun(fixture, 'confirmed')
  await api.snapshots.saveTaskSnapshot(api.snapshots.buildTaskSnapshot({
    meta: sessionMeta(fixture, 'running'), transcript: [], lastSeq: 0, eventCount: 0,
    reason: 'created', run, now: fixture.retentionAnchorAt + 10
  }), root)
  await api.modelAttempts.startPersistedModelAttempt({
    id: fixture.attemptId, commandId: `command-${suffix}`, requestId: `request-${suffix}`,
    runId: fixture.runId, providerId: 'fixture-provider', model: 'fixture-model',
    protocol: 'openai.responses', adapterVersion: 'adapter-v1',
    contextDigest: sha256(`context-${suffix}`), routeReason: 'Completed synthetic attempt.',
    keyLabel: 'label:synthetic', startedAt: fixture.retentionAnchorAt + 30
  }, root)
  await api.modelAttempts.completePersistedModelAttempt(fixture.attemptId, {
    commandId: `complete-${suffix}`, expectedRevision: 1, status: 'succeeded',
    completedAt: fixture.retentionAnchorAt + 40, outcome: 'success'
  }, root)
  const completedRun = {
    ...run,
    status: 'completed',
    revision: 2,
    updatedAt: fixture.retentionAnchorAt + 50,
    finishedAt: fixture.retentionAnchorAt + 50
  }
  await api.snapshots.saveTaskSnapshot(api.snapshots.buildTaskSnapshot({
    meta: sessionMeta(fixture, 'closed'), transcript: [], lastSeq: 0, eventCount: 0,
    reason: 'important-event', run: completedRun, now: fixture.retentionAnchorAt + 50
  }), root)
  await api.workflow.createWorkflowArtifact({
    id: fixture.artifactId, projectId: fixture.projectId, goalId: fixture.goalId,
    workItemId: fixture.workItemId, runId: fixture.runId, kind: 'test_report',
    title: 'Retained deletion evidence', version: 1,
    digest: sha256(`artifact-${suffix}`), provenance: 'explicit',
    createdAt: fixture.retentionAnchorAt + 60, updatedAt: fixture.retentionAnchorAt + 60
  }, root)
  await api.workflow.createWorkflowArtifactAcceptance({ artifactId: fixture.artifactId }, root)

  const plans = new api.taskPlans.TaskPlanContractStore(() => root)
  const targetPlan = plans.createVersion({
    sessionId: fixture.sessionId, workspaceId: fixture.projectId,
    goalId: fixture.goalId, workItemId: fixture.workItemId
  }, planDraft('Delete only private Session projections'), 'local-user')
  const survivorPlan = plans.createVersion({ sessionId: fixture.survivorSessionId },
    planDraft('Preserve unrelated Session projections'), 'local-user')
  await api.taskPlanLedger.syncTaskPlanLedger(root, targetPlan)
  await api.taskPlanLedger.syncTaskPlanLedger(root, survivorPlan)

  rmSync(path.join(root, 'transcripts', `${fixture.sdkSessionId}.jsonl`), { force: true })
  rmSync(path.join(root, 'event-receipts', `${fixture.sdkSessionId}.jsonl`), { force: true })
  const writer = new api.transcript.TranscriptWriter()
  writer.next({ kind: 'init', sdkSessionId: fixture.sdkSessionId, model: 'fixture-model' })
  writer.next({ kind: 'user-message', messageId: `message-${suffix}`, text: 'Delete this history entry.' })
  writer.next({ kind: 'assistant-message', blocks: [{ type: 'text', text: 'Deletion is ready.' }] })
  writer.next({ kind: 'turn-result', subtype: 'success', isError: false })
  await api.conversation.archiveConversationLedgerFromJsonl({
    sdkSessionId: fixture.sdkSessionId,
    currentSessionId: fixture.sessionId,
    projectId: fixture.projectId,
    workspaceId: fixture.projectId,
    goalId: fixture.goalId,
    workItemId: fixture.workItemId,
    sourceCwd: root,
    providerId: 'fixture-provider',
    model: 'fixture-model',
    engine: 'openai',
    createdAt: fixture.retentionAnchorAt,
    updatedAt: fixture.retentionAnchorAt + 70
  }, { rootDir: root, reason: 'initial' })

  seedOwnedFiles(root, fixture)
  seedWorktreeRegistry(root, fixture, 'removed')
  api.worktreeMerge.appendMergeReceipt(path.join(root, 'worktree-merges.json'), mergeReceipt(fixture.sessionId))
  api.worktreeMerge.appendMergeReceipt(path.join(root, 'worktree-merges.json'), mergeReceipt(fixture.survivorSessionId))
  const canonical = await canonicalState(api, root, fixture)
  return { ...fixture, canonicalDigest: canonical.digest }
}

async function seedRecoveryBlockerFixture(api, root, suffix, effectStatus) {
  const fixture = seedLightFixture(root, suffix)
  process.env.CAOGEN_TEST_USER_DATA = root
  await api.workflow.createWorkflowGoal({
    id: fixture.goalId, projectId: fixture.projectId, title: 'Recovery blocker Goal',
    objective: 'Preserve recovery entry.', status: 'running', source: 'explicit'
  }, root)
  await api.workflow.createWorkflowWorkItem({
    id: fixture.workItemId, projectId: fixture.projectId, goalId: fixture.goalId,
    type: 'testing', title: 'Recovery blocker WorkItem', status: 'running', source: 'explicit',
    runIds: [fixture.runId], currentRunId: fixture.runId
  }, root)
  await api.snapshots.saveTaskSnapshot(api.snapshots.buildTaskSnapshot({
    meta: sessionMeta(fixture), transcript: [], lastSeq: 0, eventCount: 0,
    reason: 'created', run: taskRun(fixture, effectStatus)
  }), root)
  return fixture
}

function seedLightFixture(root, suffix) {
  const safe = suffix.replace(/[^a-z0-9-]/gi, '-')
  const now = Date.now() - 5_000
  const fixture = {
    sessionId: `session-${safe}`,
    sdkSessionId: `sdk-${safe}`,
    survivorSessionId: `session-survivor-${safe}`,
    survivorSdkSessionId: `sdk-survivor-${safe}`,
    projectId: `project-${safe}`,
    goalId: `goal-${safe}`,
    workItemId: `work-item-${safe}`,
    runId: `run-${safe}`,
    artifactId: `artifact-${safe}`,
    attemptId: `attempt-${safe}`,
    retentionAnchorAt: now
  }
  mkdirSync(root, { recursive: true })
  const target = historyRecord(fixture.sessionId, fixture.sdkSessionId, fixture.projectId, now)
  const survivor = historyRecord(
    fixture.survivorSessionId, fixture.survivorSdkSessionId, `survivor-${fixture.projectId}`, now
  )
  writeJson(path.join(root, 'sessions.json'), { schemaVersion: 1, entries: [target, survivor] })
  writeJson(path.join(root, 'active-sessions.json'), { schemaVersion: 1, sessions: [target, survivor] })
  writeJson(path.join(root, 'session-creation-journal.json'), {
    schemaVersion: 1,
    format: 'caogen.session-creation-journal.v1',
    records: [target, survivor]
  })
  seedOwnedFiles(root, fixture)
  return fixture
}

function seedOwnedFiles(root, fixture) {
  for (const target of [
    path.join(root, 'attachments', fixture.sessionId, 'attachment.txt'),
    path.join(root, 'browser-annotations', fixture.sessionId, 'annotation.json'),
    path.join(root, 'preview-annotations', fixture.sessionId, 'annotation.json'),
    path.join(root, 'task-audit', `${fixture.sessionId}.jsonl`),
    path.join(root, 'patches', `${fixture.sessionId}.patch`),
    path.join(root, 'patches', `${fixture.sessionId}-1700000000000.patch`),
    path.join(root, 'transcripts', `${fixture.sdkSessionId}.jsonl`),
    path.join(root, 'event-receipts', `${fixture.sdkSessionId}.jsonl`),
    path.join(root, 'attachments', fixture.survivorSessionId, 'survivor.txt')
  ]) {
    if (existsSync(target)) continue
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, 'synthetic session deletion fixture\n', { mode: 0o600 })
  }
}

function seedWorktreeRegistry(root, fixture, state) {
  const record = (sessionId, nextState) => ({
    sessionId,
    repoRoot: root,
    sourceCwd: root,
    worktreePath: path.join(root, 'worktrees', sessionId),
    cwd: path.join(root, 'worktrees', sessionId),
    branch: `caogen/${sessionId}`,
    baseSha: 'a'.repeat(40),
    baseBranch: 'main',
    state: nextState,
    createdAt: 1,
    updatedAt: 2
  })
  writeJson(path.join(root, 'worktrees', 'index.json'), {
    schemaVersion: 1,
    records: [record(fixture.sessionId, state), record(fixture.survivorSessionId, 'removed')]
  })
}

async function canonicalState(api, root, fixture) {
  const ledger = await api.workflow.listPersistedWorkflowLedger({
    projectId: fixture.projectId, limit: 500
  }, root)
  const evidence = await api.workflow.listWorkflowEvidence({ projectId: fixture.projectId }, root)
  const attempts = await api.modelAttempts.queryPersistedModelAttempts({
    projectId: fixture.projectId, limit: 500
  }, root)
  const selected = {
    goals: ledger.goals.items.filter((item) => item.id === fixture.goalId),
    workItems: ledger.workItems.items.filter((item) => item.id === fixture.workItemId),
    runs: ledger.runs.items.filter((item) => item.id === fixture.runId),
    artifacts: ledger.artifacts.items.filter((item) => item.id === fixture.artifactId),
    acceptances: ledger.acceptances.items.filter((item) => item.projectId === fixture.projectId),
    evidenceLinks: ledger.evidenceLinks.items.filter((item) => item.projectId === fixture.projectId),
    evidence: evidence.filter((item) => item.projectId === fixture.projectId),
    attempts: attempts.attempts.filter((item) => item.id === fixture.attemptId)
  }
  for (const [label, values] of Object.entries(selected)) {
    assert(values.length > 0, `canonical ${label} fixture is missing`)
  }
  return { digest: hashJson(selected), selected }
}

async function assertDeleted(api, root, fixture) {
  const residuals = api.sessionPurge.scanStandaloneSessionResiduals(
    root, fixture.sessionId, fixture.sdkSessionId
  )
  assert(Object.values(residuals).every((count) => count === 0))
  assert.equal((await api.snapshots.listTaskSnapshots(root)).filter((item) =>
    item.id === fixture.sessionId || item.sessionId === fixture.sessionId).length, 0)
  assert.deepEqual(
    await api.conversation.countConversationLedgerArchiveResidualsForSession(fixture.sdkSessionId, root),
    { streams: 0, generations: 0, events: 0 }
  )
  assert.equal(await api.taskPlanLedger.countTaskPlanLedgerForSession(root, fixture.sessionId), 0)
  assert.equal(api.taskPlans ? new api.taskPlans.TaskPlanContractStore(() => root).hasPlan(fixture.sessionId) : false, false)
  assert.equal(api.worktrees.inspectManagedWorktreeRegistryRecord(fixture.sessionId, root).record, null)
  assert.equal(api.worktrees.countWorktreeMergeReceiptsForSession(fixture.sessionId, root), 0)
  assertSurvivorDataPresent(api, root, fixture)
}

function assertSurvivorDataPresent(api, root, fixture) {
  const history = JSON.parse(readFileSync(path.join(root, 'sessions.json'), 'utf8')).entries
  assert(history.some((entry) => entry.id === fixture.survivorSessionId))
  assert(existsSync(path.join(root, 'attachments', fixture.survivorSessionId, 'survivor.txt')))
  const worktree = api.worktrees.inspectManagedWorktreeRegistryRecord(fixture.survivorSessionId, root)
  if (existsSync(path.join(root, 'worktrees', 'index.json'))) assert.equal(worktree.record?.state, 'removed')
  if (existsSync(path.join(root, 'worktree-merges.json'))) {
    assert.equal(api.worktrees.countWorktreeMergeReceiptsForSession(fixture.survivorSessionId, root), 1)
  }
  if (existsSync(path.join(root, 'task-plans', 'task-plan-contracts.json'))) {
    assert(new api.taskPlans.TaskPlanContractStore(() => root).hasPlan(fixture.survivorSessionId))
  }
}

function hardKill(payload) {
  return new Promise((resolve, reject) => {
    const child = fork(scriptPath, ['--crash-worker', encodePayload(payload)], {
      cwd: repoRoot,
      env: workerEnv(payload),
      execArgv: [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    let barrier
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback()
    }
    const timer = setTimeout(() => {
      killProcess(child)
      finish(() => reject(new Error(`Session deletion worker timed out\n${stdout}\n${stderr}`)))
    }, 30_000)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.once('error', (error) => finish(() => reject(error)))
    child.on('message', (message) => {
      if (settled || barrier || message?.kind !== 'session-deletion-barrier') return
      barrier = message
      killProcess(child)
    })
    child.once('exit', (code, signal) => {
      if (!barrier) {
        finish(() => reject(new Error(`worker exited before barrier ${code}/${signal}\n${stdout}\n${stderr}`)))
      } else if (process.platform !== 'win32' && signal !== 'SIGKILL') {
        finish(() => reject(new Error(`worker was not SIGKILLed: ${code}/${signal}`)))
      } else {
        finish(() => resolve(barrier))
      }
    })
  })
}

function restartProbe(payload) {
  const stdout = execFileSync(process.execPath, [
    scriptPath, '--restart-probe', encodePayload(payload)
  ], {
    cwd: repoRoot,
    env: workerEnv(payload),
    encoding: 'utf8',
    timeout: 30_000
  })
  const marker = stdout.split('\n').find((line) => line.startsWith('SESSION_DELETION_RESTART:'))
  if (!marker) throw new Error(`restart probe emitted no result marker:\n${stdout}`)
  return JSON.parse(marker.slice('SESSION_DELETION_RESTART:'.length))
}

function killProcess(child) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' })
  } else {
    child.kill('SIGKILL')
  }
}

function compileSources(outDir) {
  mkdirSync(outDir, { recursive: true })
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/data-lifecycle/session-deletion-coordinator.ts',
    'src/main/task/workflow-ledger-api.ts',
    'src/main/task/model-attempt-api.ts',
    'src/main/task/conversation-ledger-archive.ts',
    'src/main/task/task-plan-contract-store.ts',
    'src/main/task/task-plan-ledger.ts',
    'src/main/transcript.ts',
    '--outDir', outDir,
    '--rootDir', 'src',
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronStub(outDir) {
  const electron = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electron, { recursive: true })
  writeFileSync(path.join(electron, 'index.js'),
    "module.exports = { app: { getPath: () => process.env.CAOGEN_TEST_USER_DATA } }\n")
  writeFileSync(path.join(electron, 'package.json'), '{"main":"index.js"}\n')
}

function loadModules(outDir) {
  const compiled = (relativePath) => nodeRequire(path.join(outDir, 'main', relativePath))
  return {
    deletion: compiled('data-lifecycle/session-deletion-coordinator.js'),
    journal: compiled('data-lifecycle/session-deletion-journal.js'),
    retention: compiled('data-lifecycle/retention-authority-store.js'),
    sessionPurge: compiled('data-lifecycle/project-session-purge.js'),
    snapshots: compiled('task/task-snapshot.js'),
    workflow: compiled('task/workflow-ledger-api.js'),
    modelAttempts: compiled('task/model-attempt-api.js'),
    conversation: compiled('task/conversation-ledger-archive.js'),
    taskPlans: compiled('task/task-plan-contract-store.js'),
    taskPlanLedger: compiled('task/task-plan-ledger.js'),
    transcript: compiled('transcript.js'),
    worktrees: compiled('worktrees.js'),
    worktreeMerge: compiled('worktreeMerge.js')
  }
}

function taskRun(fixture, effectStatus) {
  const now = fixture.retentionAnchorAt + 5
  return {
    schemaVersion: 1,
    id: fixture.runId,
    sessionId: fixture.sessionId,
    taskId: fixture.workItemId,
    status: effectStatus === 'waiting_reconciliation' ? 'waiting_reconciliation' : 'executing',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: fixture.retentionAnchorAt,
    updatedAt: now,
    steps: [],
    toolExecutions: [],
    effects: [{
      schemaVersion: 1,
      id: `effect-${fixture.runId}`,
      effectKey: `effect-key-${fixture.runId}`,
      resourceKey: `resource-key-${fixture.runId}`,
      sessionId: fixture.sessionId,
      runId: fixture.runId,
      toolUseId: `tool-${fixture.runId}`,
      toolName: 'fixture_tool',
      generation: 1,
      revision: 1,
      status: effectStatus,
      reconcilability: 'queryable',
      target: { kind: 'unsupported', toolName: 'fixture_tool' },
      targetDigest: `target-${fixture.runId}`,
      intentDigest: `intent-${fixture.runId}`,
      inputDigest: `input-${fixture.runId}`,
      evidence: effectStatus === 'confirmed' ? [{
        id: `effect-evidence-${fixture.runId}`,
        kind: 'execution_result',
        digest: `effect-evidence-digest-${fixture.runId}`,
        observedAt: now,
        verifier: 'session-deletion-recovery-e2e',
        generation: 1
      }] : [],
      createdAt: fixture.retentionAnchorAt,
      updatedAt: now
    }]
  }
}

function sessionMeta(fixture, status = 'running') {
  return {
    id: fixture.sessionId,
    title: fixture.sessionId,
    cwd: repoRoot,
    workspaceId: fixture.projectId,
    goalId: fixture.goalId,
    workItemId: fixture.workItemId,
    childTaskId: fixture.workItemId,
    model: 'fixture-model',
    providerId: 'fixture-provider',
    permissionMode: 'default',
    status,
    sdkSessionId: fixture.sdkSessionId,
    costUsd: 0.25,
    usage: { input: 10, output: 20, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 30,
    createdAt: fixture.retentionAnchorAt
  }
}

function planDraft(objective) {
  return {
    objective,
    steps: [{ id: 'verify', title: 'Verify', description: 'Verify durable deletion recovery.' }],
    expectedArtifacts: ['Recovery report'],
    dataEgress: [],
    estimatedCostUsd: 0,
    riskLevel: 'high',
    acceptanceCriteria: ['Fresh-process recovery leaves zero private residuals.']
  }
}

function historyRecord(id, sdkSessionId, projectId, now) {
  return {
    id,
    sdkSessionId,
    workspaceId: projectId,
    projectId,
    title: id,
    cwd: repoRoot,
    createdAt: now,
    updatedAt: now
  }
}

function mergeReceipt(sessionId) {
  return {
    sessionId,
    branch: `caogen/${sessionId}`,
    baseSha: 'a'.repeat(40),
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
    mergedAt: Date.now(),
    patchSha256: 'b'.repeat(64)
  }
}

function targetDataDigest(root, fixture) {
  const targets = [
    path.join(root, 'sessions.json'),
    path.join(root, 'active-sessions.json'),
    path.join(root, 'session-creation-journal.json'),
    path.join(root, 'attachments', fixture.sessionId)
  ]
  const hash = createHash('sha256')
  for (const target of targets) {
    hash.update(path.relative(root, target))
    if (existsSync(target)) digestPath(target, hash)
  }
  return hash.digest('hex')
}

function assertTargetDataPresent(root, fixture) {
  const entries = JSON.parse(readFileSync(path.join(root, 'sessions.json'), 'utf8')).entries
  assert(entries.some((entry) => entry.id === fixture.sessionId))
  assert(existsSync(path.join(root, 'attachments', fixture.sessionId, 'attachment.txt')))
}

function completedEntry(root, operationId) {
  const document = JSON.parse(readFileSync(journalFile(root), 'utf8'))
  const entry = document.entries.find((candidate) => candidate.operationId === operationId)
  assert(entry, `completed Session deletion entry is missing: ${operationId}`)
  return entry
}

function readPendingPhase(root) {
  const document = JSON.parse(readFileSync(journalFile(root), 'utf8'))
  assert.equal(document.entries.length, 1)
  return document.entries[0].phase
}

function journalFile(root) {
  return path.join(root, 'private', 'session-deletion-journal.json')
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function digestTree(root) {
  const hash = createHash('sha256')
  if (existsSync(root)) digestPath(root, hash)
  return hash.digest('hex')
}

function digestPath(target, hash) {
  const stat = nodeRequire('node:fs').lstatSync(target)
  if (!stat.isDirectory()) {
    hash.update(readFileSync(target))
    return
  }
  for (const name of readdirSync(target).sort()) {
    hash.update(name)
    digestPath(path.join(target, name), hash)
  }
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

async function check(checks, id, run) {
  const detail = await run()
  checks.push({ id, status: 'passed', ...detail })
  process.stdout.write(`[PASS] ${id}\n`)
}

async function assertRejects(promise, pattern) {
  await assert.rejects(promise, pattern)
}

function workerEnv(payload) {
  return {
    ...process.env,
    NODE_PATH: [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
    CAOGEN_TEST_USER_DATA: payload.root
  }
}

function encodePayload(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodePayload(value) {
  if (!value) throw new Error('worker payload is required')
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
}
