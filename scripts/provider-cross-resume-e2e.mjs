import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bindSourceEvidence, readSourceEvidenceState } from './lib/source-evidence-binding.mjs'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()

const sourceSessionId = 'session-openai-source'
const sourceSdkSessionId = 'sdk-openai-source'
const targetSessionId = 'session-anthropic-target'
const targetSdkSessionId = 'sdk-anthropic-target'
const projectId = 'project-cross-provider'
const workspaceId = 'workspace-cross-provider'
const goalId = 'goal-cross-provider'
const workItemId = 'work-item-cross-provider'
const sourceRunId = 'run-cross-provider-source'
const sourceRequestId = 'request-cross-provider-source'
const sourceStepId = 'step-cross-provider-source'
const targetRequestId = 'request-cross-provider-target'
const targetStepId = 'step-cross-provider-target'
const sourceAttemptId = 'attempt-openai-source'
const targetAttemptId = 'attempt-anthropic-target'
const artifactId = 'artifact-cross-provider-source'
const artifactEvidenceId = 'evidence-cross-provider-source'
const artifactAcceptanceId = 'acceptance-cross-provider-source'
const artifactLocationId = 'location-cross-provider-source'
const artifactBytes = Buffer.from('CaoGen canonical Artifact survives Provider continuation.\n', 'utf8')
const userSecret = ['sk-proj', 'user-secret-1234567890'].join('-')
const toolInputSecret = ['ghp', 'tool-input-secret-1234567890'].join('_')
const toolResultSecret = ['sk-ant', 'tool-result-secret-1234567890'].join('-')

const phase = process.argv[2]
if (phase === '--phase-source') {
  await sourcePhase()
} else if (phase === '--phase-target') {
  await targetPhase()
} else {
  await orchestrate()
}

async function orchestrate() {
  const sourceEvidenceAtStart = readSourceEvidenceState(repoRoot)
  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  const reportRoot = path.join(repoRoot, 'test-results', 'provider-cross-resume')
  const reportDir = path.join(reportRoot, runId)
  let tempRoot
  let evidenceReport = {
    schemaVersion: 1,
    runId,
    gate: 'test:provider-cross-resume',
    status: 'failed',
    failures: [],
    warnings: []
  }
  let finalError
  try {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-cross-resume-'))
    const outDir = path.join(tempRoot, 'compiled')
    const userData = path.join(tempRoot, 'user-data')
    const reportFile = path.join(tempRoot, 'target-report.json')
    compileSources(outDir)
    installElectronStub(outDir, userData)
    const childEnv = {
      ...process.env,
      CAOGEN_CROSS_RESUME_OUT_DIR: outDir,
      CAOGEN_CROSS_RESUME_USER_DATA: userData,
      CAOGEN_CROSS_RESUME_REPORT: reportFile
    }
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--phase-source'], {
      cwd: repoRoot,
      env: childEnv,
      stdio: 'inherit'
    })

    const sourceTranscript = path.join(userData, 'transcripts', `${sourceSdkSessionId}.jsonl`)
    assert(existsSync(sourceTranscript), 'source process must persist JSONL before restart')
    unlinkSync(sourceTranscript)

    execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--phase-target'], {
      cwd: repoRoot,
      env: childEnv,
      stdio: 'inherit'
    })

    const report = JSON.parse(readFileSync(reportFile, 'utf8'))
    assertEqual(report.sourceJsonlRecovered, true, 'target process must recover deleted source JSONL')
    assertEqual(report.attempts, 2, 'cross-provider attempt count')
    assertEqual(report.historyRoles, 'user', 'Anthropic portable replay role sequence')
    assertEqual(report.redactionPassed, true, 'cross-provider replay redaction')
    assertEqual(report.contextParity, true, 'provider-neutral Canonical Context parity')
    assertEqual(report.artifact.byteVerified, true, 'target must verify canonical Artifact bytes')
    assertEqual(report.artifact.crossProjectRejected, true, 'target must reject cross-Project Artifact access')
    assertEqual(report.artifact.tamperRejected, true, 'target must reject tampered Artifact bytes')
    evidenceReport = {
      schemaVersion: 1,
      runId,
      gate: 'test:provider-cross-resume',
      status: 'passed',
      ok: true,
      restartBoundary: 'two-node-processes',
      source: report.source,
      target: report.target,
      preserved: report.preserved,
      attempts: report.attempts,
      conversationStreams: report.conversationStreams,
      historyRoles: report.historyRoles,
      attachmentReferences: report.attachmentReferences,
      toolPairs: report.toolPairs,
      redactionPassed: report.redactionPassed,
      canonicalContextDigest: report.canonicalContextDigest,
      artifact: report.artifact,
      sourceJsonlRecovered: report.sourceJsonlRecovered,
      sideEffectReplay: false,
      failures: [],
      warnings: []
    }
  } catch (error) {
    finalError = error
    evidenceReport.failures.push({
      message: 'Provider cross-resume verification failed',
      errorDigest: `sha256:${createHash('sha256').update(error instanceof Error ? error.stack || error.message : String(error)).digest('hex')}`
    })
    process.exitCode = 1
  } finally {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
    const provenance = bindSourceEvidence(
      evidenceReport,
      sourceEvidenceAtStart,
      readSourceEvidenceState(repoRoot),
      'Provider cross-resume'
    )
    if (provenance.status !== 'pass') {
      evidenceReport.status = 'failed'
      evidenceReport.failures.push({ message: evidenceReport.error })
      process.exitCode = 1
    }
    mkdirSync(reportDir, { recursive: true })
    const body = `${JSON.stringify(evidenceReport, null, 2)}\n`
    writeFileSync(path.join(reportDir, 'report.json'), body, 'utf8')
    writeFileSync(path.join(reportRoot, 'latest.json'), body, 'utf8')
  }
  if (evidenceReport.status === 'passed' && !process.exitCode) {
    console.log(JSON.stringify({ ...evidenceReport, reportDir }, null, 2))
  } else {
    console.error(`Provider cross-resume verification failed (${finalError ? 'see report digest' : 'evidence provenance'})`)
  }
}

async function sourcePhase() {
  const { outDir, userData } = childPaths()
  const transcript = await importCompiled(outDir, 'transcript.js')
  const archive = await importCompiled(outDir, 'conversation-ledger-archive.js')
  const snapshots = await importCompiled(outDir, 'task-snapshot.js')
  const attemptRuntime = await importCompiled(outDir, 'model-attempt-runtime.js')
  const workflow = await importCompiled(outDir, 'workflow-ledger-store.js')
  const workflowApi = await importCompiled(outDir, 'workflow-ledger-api.js')
  const neutralContext = await importCompiled(outDir, 'provider-neutral-context.js')

  const entries = buildSourceTranscript(transcript)
  await archive.archiveConversationLedgerFromJsonl(sourceArchiveIdentity(), {
    rootDir: userData,
    reason: 'initial'
  })
  await persistSourceSnapshot({ snapshots, workflow, entries, userData })

  const artifact = await persistSourceArtifact({ workflowApi, neutralContext }, userData)
  const canonicalContextDigest = neutralContext.buildProviderNeutralContextDigest({
    entries,
    outboundContext: providerOutboundContext({
      sessionId: sourceSessionId,
      providerId: 'provider-openai',
      model: 'gpt-fixture',
      artifactContinuationDigest: artifact.continuation.digest
    }),
    artifactContinuationDigest: artifact.continuation.digest
  })
  const handle = await attemptRuntime.beginPersistedModelAttempt({
    id: sourceAttemptId,
    requestId: sourceRequestId,
    stepId: sourceStepId,
    runId: sourceRunId,
    providerId: 'provider-openai',
    model: 'gpt-fixture',
    protocol: 'openai.responses',
    adapterVersion: 'openai-adapter-v1',
    context: {
      endpoint: 'https://openai.fixture/v1/responses',
      body: { input: 'provider-specific OpenAI wire body' }
    },
    contextDigest: canonicalContextDigest,
    routeReason: 'Selected OpenAI-compatible source route.',
    rootDir: userData,
    startedAt: 110
  }, { dependencies: { now: () => 120 } })
  await handle.fail({
    status: 'failed',
    outcome: 'unavailable',
    errorClass: 'provider_unavailable'
  })
}

function buildSourceTranscript(transcript) {
  const writer = new transcript.TranscriptWriter()
  writer.next({ kind: 'init', sdkSessionId: sourceSdkSessionId, model: 'gpt-fixture' })
  writer.next({
    kind: 'user-message',
    messageId: 'message-cross-provider',
    text: `Inspect the project and persist the result. User credential: ${userSecret}`,
    attachments: [{ id: 'c'.repeat(64), hash: 'c'.repeat(64), mime: 'image/png', bytes: 256 }]
  })
  writer.next({
    kind: 'assistant-message',
    blocks: [
      { type: 'text', text: 'The project state is available.' },
      { type: 'tool_use', id: 'tool-cross-provider', name: 'read_file', input: { path: 'STATUS.md', apiKey: toolInputSecret } }
    ]
  })
  writer.next({ kind: 'tool-result', toolUseId: 'tool-cross-provider', content: `persisted project evidence ${toolResultSecret}`, isError: false })
  writer.next({ kind: 'turn-result', subtype: 'success', isError: false })
  return writer.readAll()
}

async function persistSourceSnapshot({ snapshots, workflow, entries, userData }) {
  await snapshots.mutateTaskSnapshotDatabase(userData, (db) => {
    workflow.projectGoal(db, {
      id: goalId, projectId: workspaceId, title: 'Cross-provider recovery goal',
      objective: 'Resume one durable task across provider boundaries.', status: 'running',
      revision: 1, source: 'explicit', createdAt: 90, updatedAt: 90
    })
    workflow.projectWorkItem(db, {
      id: workItemId, projectId: workspaceId, goalId, type: 'coding',
      title: 'Cross-provider recovery work item', status: 'running', revision: 1,
      source: 'explicit', createdAt: 90, updatedAt: 90
    })
  })
  await snapshots.saveTaskSnapshot(snapshots.buildTaskSnapshot({
    meta: sessionMeta({ id: sourceSessionId, sdkSessionId: sourceSdkSessionId, providerId: 'provider-openai', model: 'gpt-fixture', engine: 'openai' }, userData),
    transcript: entries, lastSeq: entries.at(-1)?.seq ?? 0, lastEventId: entries.at(-1)?.eventId,
    lastEventKind: entries.at(-1)?.event.kind, eventCount: entries.length,
    reason: 'important-event', run: sourceTaskRun(), now: 100
  }), userData)
}

async function targetPhase() {
  const { outDir, userData, reportFile } = childPaths()
  const modules = await loadTargetPhaseModules(outDir)
  const conversation = await restoreTargetConversation(modules, userData)
  const targetRun = await persistTargetRun(modules, userData, conversation.targetEntries)
  const artifactState = await verifyTargetArtifactContinuation(modules, userData)
  const attemptState = await persistAndVerifyTargetAttempt(
    modules,
    userData,
    targetRun,
    conversation.targetEntries,
    artifactState.continuation
  )
  const portableState = verifyPortableTargetContext(modules, conversation.targetEntries)
  const archiveState = await readAndVerifyTargetArchive(modules, userData)
  writeTargetPhaseReport(reportFile, {
    sourceJsonlRecovered: conversation.sourceJsonlRecovered,
    targetRun,
    attemptState,
    artifactState,
    portableState,
    conversationStreams: archiveState.verification.streams
  })
}

async function loadTargetPhaseModules(outDir) {
  const transcript = await importCompiled(outDir, 'transcript.js')
  const archive = await importCompiled(outDir, 'conversation-ledger-archive.js')
  const ledgerStore = await importCompiled(outDir, 'conversation-ledger-store.js')
  const snapshots = await importCompiled(outDir, 'task-snapshot.js')
  const attempts = await importCompiled(outDir, 'model-attempt-api.js')
  const attemptRuntime = await importCompiled(outDir, 'model-attempt-runtime.js')
  const anthropicHistory = await importCompiled(outDir, 'anthropic-history.js')
  const replay = await importCompiled(outDir, 'conversation-ledger-replay.js')
  const taskRuns = await importCompiled(outDir, 'task-run.js')
  const neutralContext = await importCompiled(outDir, 'provider-neutral-context.js')
  return {
    transcript,
    archive,
    ledgerStore,
    snapshots,
    attempts,
    attemptRuntime,
    anthropicHistory,
    replay,
    taskRuns,
    neutralContext
  }
}

async function restoreTargetConversation(modules, userData) {
  const sourceJsonlRecovered = await modules.archive.restoreConversationLedgerJsonlFromArchive(
    sourceSdkSessionId,
    userData
  )
  assertEqual(sourceJsonlRecovered, true, 'restart must recover source JSONL from DB archive')
  const sourceEntries = modules.transcript.readTranscriptEntriesStrict(sourceSdkSessionId)
  assert(sourceEntries.length > 0, 'recovered source conversation must not be empty')

  const fork = new modules.transcript.TranscriptWriter()
  fork.seedFrom(sourceSdkSessionId)
  fork.next({ kind: 'init', sdkSessionId: targetSdkSessionId, model: 'claude-fixture' })
  fork.next({
    kind: 'routing',
    providerId: 'provider-anthropic',
    providerName: 'Anthropic fixture',
    model: 'claude-fixture',
    reason: 'Cross-provider recovery selected a healthy target.'
  })
  const targetEntries = fork.readAll()
  assert(
    targetEntries.some((entry) => entry.event.kind === 'init' && entry.event.sdkSessionId === targetSdkSessionId),
    'fork must own a new SDK identity'
  )
  assert(
    !targetEntries.some((entry) => entry.event.kind === 'init' && entry.event.sdkSessionId === sourceSdkSessionId),
    'fork must not inherit the source provider runtime identity'
  )
  const inheritedSourceIds = sourceEntries
    .filter((entry) => !['init', 'status', 'meta'].includes(entry.event.kind))
    .map((entry) => entry.eventId)
  assertEqual(
    targetEntries.slice(0, inheritedSourceIds.length).map((entry) => entry.eventId).join(','),
    inheritedSourceIds.join(','),
    'fork must preserve inherited semantic event identities'
  )

  await modules.archive.archiveConversationLedgerFromJsonl({
    sdkSessionId: targetSdkSessionId,
    sourceSdkSessionId,
    currentSessionId: targetSessionId,
    projectId,
    workspaceId,
    goalId,
    workItemId,
    sourceCwd: repoRoot,
    providerId: 'provider-anthropic',
    model: 'claude-fixture',
    engine: 'anthropic',
    createdAt: 130,
    updatedAt: 140
  }, { rootDir: userData, reason: 'initial' })
  return { sourceJsonlRecovered, targetEntries }
}

async function persistTargetRun(modules, userData, targetEntries) {
  const targetMeta = sessionMeta({
    id: targetSessionId,
    sdkSessionId: targetSdkSessionId,
    providerId: 'provider-anthropic',
    model: 'claude-fixture',
    engine: 'anthropic',
    conversationForkSourceSdkSessionId: sourceSdkSessionId,
    conversationForkSourceSessionId: sourceSessionId,
    conversationForkSourceRunId: sourceRunId
  }, userData)
  const targetRun = modules.taskRuns.createSessionTaskRun(targetMeta)
  assert(targetRun.id !== sourceRunId, 'fork must create a distinct successor Run')
  assertEqual(targetRun.sessionId, targetSessionId, 'successor Run must belong to target Session')
  assertEqual(targetRun.continuation?.kind, 'conversation_fork', 'successor Run continuation kind')
  assertEqual(targetRun.continuation?.sourceSessionId, sourceSessionId, 'successor source Session lineage')
  assertEqual(targetRun.continuation?.sourceRunId, sourceRunId, 'successor source Run lineage')
  assertEqual(targetRun.continuation?.sourceSdkSessionId, sourceSdkSessionId, 'successor source SDK lineage')
  await modules.snapshots.saveTaskSnapshot(modules.snapshots.buildTaskSnapshot({
    meta: targetMeta,
    transcript: targetEntries,
    lastSeq: targetEntries.at(-1)?.seq ?? 0,
    lastEventId: targetEntries.at(-1)?.eventId,
    lastEventKind: targetEntries.at(-1)?.event.kind,
    eventCount: targetEntries.length,
    reason: 'important-event',
    run: targetRun,
    now: 140
  }), userData)
  return targetRun
}

async function persistAndVerifyTargetAttempt(
  modules,
  userData,
  targetRun,
  targetEntries,
  artifactContinuation
) {
  const canonicalContextDigest = modules.neutralContext.buildProviderNeutralContextDigest({
    entries: targetEntries,
    outboundContext: providerOutboundContext({
      sessionId: targetSessionId,
      providerId: 'provider-anthropic',
      model: 'claude-fixture',
      artifactContinuationDigest: artifactContinuation.digest
    }),
    artifactContinuationDigest: artifactContinuation.digest
  })
  const handle = await modules.attemptRuntime.beginPersistedModelAttempt({
    id: targetAttemptId,
    requestId: targetRequestId,
    stepId: targetStepId,
    runId: targetRun.id,
    providerId: 'provider-anthropic',
    model: 'claude-fixture',
    protocol: 'anthropic.messages',
    adapterVersion: 'anthropic-adapter-v1',
    context: {
      endpoint: 'https://anthropic.fixture/v1/messages',
      body: { messages: 'provider-specific Anthropic wire body' }
    },
    contextDigest: canonicalContextDigest,
    routeReason: 'Recovered CaoGen ledger on Anthropic-compatible target.',
    rootDir: userData,
    startedAt: 130
  }, { dependencies: { now: () => 150 } })
  await handle.succeed({
    usage: { inputTokens: 10, outputTokens: 5 },
    costUsd: 0.01
  })

  const sourceSelection = await modules.attempts.queryPersistedModelAttempts({ runId: sourceRunId, limit: 10 }, userData)
  const targetSelection = await modules.attempts.queryPersistedModelAttempts({ runId: targetRun.id, limit: 10 }, userData)
  assertEqual(sourceSelection.attempts.length, 1, 'restart must retain source Run Attempt')
  assertEqual(targetSelection.attempts.length, 1, 'successor Run must own its own Attempt')
  const sourceAttempt = sourceSelection.attempts[0]
  const targetAttempt = targetSelection.attempts[0]
  assertEqual(sourceAttempt.id, sourceAttemptId, 'source Attempt identity')
  assertEqual(targetAttempt.id, targetAttemptId, 'target Attempt identity')
  assertEqual(sourceAttempt.nextAttemptId, undefined, 'Attempt chains must not cross Run boundaries')
  assertEqual(targetAttempt.failoverFromAttemptId, undefined, 'successor Run must use continuation instead of Attempt failover')
  assert(sourceAttempt.runId !== targetAttempt.runId, 'source and target Attempts must belong to different Runs')
  for (const attempt of [sourceAttempt, targetAttempt]) {
    assertEqual(attempt.projectId, workspaceId, 'Project identity must remain stable')
    assertEqual(attempt.goalId, goalId, 'Goal identity must remain stable')
    assertEqual(attempt.workItemId, workItemId, 'WorkItem identity must remain stable')
  }
  assertEqual(sourceAttempt.providerId, 'provider-openai', 'source Provider identity')
  assertEqual(targetAttempt.providerId, 'provider-anthropic', 'target Provider identity')
  assertEqual(sourceAttempt.contextDigest, canonicalContextDigest, 'source Canonical Context digest')
  assertEqual(targetAttempt.contextDigest, canonicalContextDigest, 'target Canonical Context digest')
  return {
    sourceSelection,
    targetSelection,
    sourceAttempt,
    targetAttempt,
    canonicalContextDigest,
    contextParity: sourceAttempt.contextDigest === targetAttempt.contextDigest
  }
}

async function persistSourceArtifact(modules, userData) {
  const artifactPath = providerArtifactPath(userData)
  const digest = `sha256:${createHash('sha256').update(artifactBytes).digest('hex')}`
  writeFileSync(artifactPath, artifactBytes)
  await modules.workflowApi.createWorkflowArtifact({
    id: artifactId,
    projectId: workspaceId,
    goalId,
    workItemId,
    runId: sourceRunId,
    kind: 'report',
    title: 'Cross-provider canonical Artifact',
    digest,
    mediaType: 'text/plain',
    provenance: 'explicit',
    createdAt: 121,
    updatedAt: 121
  }, userData)
  await modules.workflowApi.createWorkflowArtifactLocation({
    id: artifactLocationId,
    artifactId,
    projectId: workspaceId,
    goalId,
    workItemId,
    runId: sourceRunId,
    kind: 'file',
    path: artifactPath,
    availability: 'available',
    checksum: digest,
    sizeBytes: artifactBytes.byteLength,
    mediaType: 'text/plain',
    createdAt: 121,
    updatedAt: 121
  }, userData)
  const pending = await modules.workflowApi.saveWorkflowAcceptance({
    id: artifactAcceptanceId,
    projectId: workspaceId,
    goalId,
    workItemId,
    criteria: ['Artifact bytes and ownership remain continuous across Provider takeover.'],
    status: 'pending',
    revision: 1,
    createdAt: 122,
    updatedAt: 122
  }, userData, { caller: 'automatic', actorId: 'provider-cross-resume-source' })
  const evidence = await modules.workflowApi.createWorkflowEvidence({
    evidenceId: artifactEvidenceId,
    projectId: workspaceId,
    goalId,
    workItemId,
    runId: sourceRunId,
    artifactId,
    kind: 'delivery_check',
    title: 'Cross-provider Artifact byte verification',
    summary: 'The canonical local file matches its Artifact digest and Project ownership.',
    mediaType: 'text/plain',
    contentDigest: digest.slice('sha256:'.length)
  }, userData, {
    source: 'runtime',
    verifier: 'provider-cross-resume-source',
    observedAt: 123
  })
  await modules.workflowApi.createWorkflowEvidenceLink({
    id: 'link-cross-provider-source',
    evidenceId: evidence.evidenceId,
    evidenceOrigin: 'workflow',
    projectId: workspaceId,
    runId: sourceRunId,
    artifactId,
    acceptanceId: pending.id,
    relation: 'verifies',
    createdAt: 123
  }, userData)
  const verifying = await modules.workflowApi.saveWorkflowAcceptance({
    ...pending,
    status: 'verifying',
    evidenceRefs: [evidence.evidenceId],
    revision: pending.revision + 1,
    updatedAt: 124
  }, userData, { caller: 'automatic', actorId: 'provider-cross-resume-source' })
  const passed = await modules.workflowApi.saveWorkflowAcceptance({
    ...verifying,
    status: 'passed',
    verifier: 'provider-cross-resume-source',
    verifiedAt: 125,
    revision: verifying.revision + 1,
    updatedAt: 125
  }, userData, { caller: 'automatic', actorId: 'provider-cross-resume-source' })
  assertEqual(passed.status, 'passed', 'source Artifact Acceptance must pass')
  const continuation = await modules.neutralContext.readReadyCanonicalArtifactContinuation({
    projectId: workspaceId,
    artifactIds: [artifactId],
    rootDir: userData
  })
  assertEqual(continuation.artifacts[0]?.digest, digest, 'source Artifact continuation digest')
  return { artifactPath, digest, continuation }
}

async function verifyTargetArtifactContinuation(modules, userData) {
  const continuation = await modules.neutralContext.readReadyCanonicalArtifactContinuation({
    projectId: workspaceId,
    artifactIds: [artifactId],
    rootDir: userData
  })
  const artifactPath = providerArtifactPath(userData)
  const byteVerified = readFileSync(artifactPath).equals(artifactBytes)
  assertEqual(byteVerified, true, 'target must read the exact source Artifact bytes')
  const crossProjectRejected = await rejects(async () => {
    await modules.neutralContext.readReadyCanonicalArtifactContinuation({
      projectId: 'workspace-cross-provider-other',
      artifactIds: [artifactId],
      rootDir: userData
    })
  })
  assertEqual(crossProjectRejected, true, 'cross-Project Artifact continuation must fail closed')

  writeFileSync(artifactPath, 'tampered cross-provider Artifact\n', 'utf8')
  const tamperRejected = await rejects(async () => {
    await modules.neutralContext.readReadyCanonicalArtifactContinuation({
      projectId: workspaceId,
      artifactIds: [artifactId],
      rootDir: userData
    })
  })
  writeFileSync(artifactPath, artifactBytes)
  assertEqual(tamperRejected, true, 'tampered Artifact continuation must fail closed')
  const restored = await modules.neutralContext.readReadyCanonicalArtifactContinuation({
    projectId: workspaceId,
    artifactIds: [artifactId],
    rootDir: userData
  })
  assertEqual(restored.digest, continuation.digest, 'restored Artifact continuation must be byte-stable')
  return { continuation, byteVerified, crossProjectRejected, tamperRejected }
}

function providerOutboundContext(input) {
  const userPromptDigest = `sha256:${createHash('sha256')
    .update('Inspect the project and persist the result. User credential: [REDACTED]')
    .digest('hex')}`
  return {
    schemaVersion: 1,
    generatedAt: input.providerId === 'provider-openai' ? 110 : 140,
    sessionId: input.sessionId,
    projectId: workspaceId,
    projectRevision: 1,
    projectPolicyDigest: `sha256:${'1'.repeat(64)}`,
    resourceContextDigest: `sha256:${'2'.repeat(64)}`,
    receiver: {
      providerId: input.providerId,
      providerName: input.providerId,
      engine: input.providerId === 'provider-openai' ? 'openai' : 'anthropic',
      model: input.model,
      endpointOrigin: input.providerId === 'provider-openai'
        ? 'https://openai.fixture'
        : 'https://anthropic.fixture',
      locality: 'remote'
    },
    dataClasses: ['S2', 'S4'],
    items: [{
      id: 'message:user-prompt',
      kind: 'user_prompt',
      label: 'User prompt',
      dataClass: 'S2',
      egressPolicy: 'allow',
      decision: 'included',
      digest: userPromptDigest
    }, {
      id: 'context:workflow',
      kind: 'workflow_context',
      label: 'Workflow handoff',
      dataClass: 'S4',
      egressPolicy: 'allow',
      decision: 'included',
      digest: input.artifactContinuationDigest
    }],
    scopeCompleteness: 'partial',
    blocked: false,
    blockReasons: [],
    failoverAllowed: true,
    routingMayChangeReceiver: true,
    manifestDigest: `sha256:${createHash('sha256')
      .update(`${input.providerId}:${input.model}:${input.sessionId}`)
      .digest('hex')}`
  }
}

function providerArtifactPath(userData) {
  return path.join(userData, 'cross-provider-canonical-artifact.txt')
}

function verifyPortableTargetContext(modules, targetEntries) {
  const history = modules.anthropicHistory.rebuildPortableAnthropicHistory(targetEntries)
  const historyRoles = history.map((message) => message.role).join(',')
  assertEqual(historyRoles, 'user', 'cross-provider Anthropic history must be one portable replay message')
  const attachmentReferences = history
    .flatMap((message) => message.content)
    .filter((block) => block.type === 'image').length
  const toolCalls = history
    .flatMap((message) => message.content)
    .filter((block) => block.type === 'tool_use' && block.id === 'tool-cross-provider').length
  const toolResults = history
    .flatMap((message) => message.content)
    .filter((block) => block.type === 'tool_result' && block.tool_use_id === 'tool-cross-provider').length
  assertEqual(attachmentReferences, 0, 'cross-provider history must not resolve source attachment bytes')
  assertEqual(toolCalls, 0, 'cross-provider history must not replay source tool calls as executable blocks')
  assertEqual(toolResults, 0, 'cross-provider history must not replay source tool results as provider blocks')

  const portable = modules.replay.buildPortableConversationReplay(targetEntries)
  assert(portable, 'target provider must receive portable CaoGen context')
  assert(
    portable.text.includes('Do not repeat side effects solely because they appear below.'),
    'cross-provider replay must prohibit side-effect repetition'
  )
  assertEqual(countOccurrences(portable.text, '[assistant tool_call id=tool-cross-provider'), 1, 'portable tool call count')
  assertEqual(countOccurrences(portable.text, '[tool_result id=tool-cross-provider'), 1, 'portable tool result count')
  assert(portable.text.includes('content_omitted=true'), 'portable tool result must contain only an omission summary')
  for (const secret of [userSecret, toolInputSecret, toolResultSecret]) {
    assert(!portable.text.includes(secret), `portable replay leaked secret sentinel ${secret}`)
  }
  const redactionPassed = portable.text.includes('"apiKey":"[REDACTED]"')
  assert(redactionPassed, 'camelCase sensitive tool fields must be redacted')
  return {
    historyRoles,
    attachmentReferences,
    toolPairs: countOccurrences(portable.text, '[tool_result id=tool-cross-provider'),
    redactionPassed
  }
}

async function readAndVerifyTargetArchive(modules, userData) {
  const archiveState = await modules.snapshots.readTaskSnapshotDatabase(userData, (db) => {
    const verification = modules.ledgerStore.verifyConversationLedgerArchive(db)
    const streams = rows(db, `
      SELECT sdk_session_id, current_session_id, source_sdk_session_id,
             project_id, workspace_id, goal_id, work_item_id, provider_id, model, engine
      FROM conversation_ledger_streams
      ORDER BY sdk_session_id
    `)
    return { verification, streams }
  })
  assertEqual(archiveState.verification.streams, 2, 'source and target streams must both remain durable')
  const sourceStream = archiveState.streams.find((item) => item.sdk_session_id === sourceSdkSessionId)
  const targetStream = archiveState.streams.find((item) => item.sdk_session_id === targetSdkSessionId)
  assert(sourceStream && targetStream, 'source and target stream identities must be queryable')
  assertEqual(sourceStream.current_session_id, sourceSessionId, 'source Session identity')
  assertEqual(targetStream.current_session_id, targetSessionId, 'target Session identity')
  assertEqual(targetStream.source_sdk_session_id, sourceSdkSessionId, 'target source SDK lineage')
  assertEqual(targetStream.provider_id, 'provider-anthropic', 'target archive Provider identity')
  for (const stream of archiveState.streams) {
    assertEqual(stream.project_id, projectId, 'legacy project identity must remain stable')
    assertEqual(stream.workspace_id, workspaceId, 'canonical Project identity must remain stable')
    assertEqual(stream.goal_id, goalId, 'archive Goal identity must remain stable')
    assertEqual(stream.work_item_id, workItemId, 'archive WorkItem identity must remain stable')
  }
  return archiveState
}

function writeTargetPhaseReport(reportFile, state) {
  const {
    sourceSelection,
    targetSelection,
    sourceAttempt,
    targetAttempt,
    canonicalContextDigest,
    contextParity
  } = state.attemptState
  writeFileSync(reportFile, JSON.stringify({
    sourceJsonlRecovered: state.sourceJsonlRecovered,
    source: {
      sessionId: sourceSessionId,
      sdkSessionId: sourceSdkSessionId,
      providerId: sourceAttempt.providerId,
      model: sourceAttempt.model
    },
    target: {
      sessionId: targetSessionId,
      sdkSessionId: targetSdkSessionId,
      providerId: targetAttempt.providerId,
      model: targetAttempt.model,
      sourceSdkSessionId
    },
    preserved: {
      projectId: workspaceId,
      goalId,
      workItemId,
      sourceRunId,
      targetRunId: state.targetRun.id,
      continuation: state.targetRun.continuation
    },
    attempts: sourceSelection.attempts.length + targetSelection.attempts.length,
    canonicalContextDigest,
    contextParity,
    artifact: {
      artifactId,
      digest: state.artifactState.continuation.artifacts[0]?.digest,
      continuationDigest: state.artifactState.continuation.digest,
      byteVerified: state.artifactState.byteVerified,
      crossProjectRejected: state.artifactState.crossProjectRejected,
      tamperRejected: state.artifactState.tamperRejected
    },
    conversationStreams: state.conversationStreams,
    historyRoles: state.portableState.historyRoles,
    attachmentReferences: state.portableState.attachmentReferences,
    toolPairs: state.portableState.toolPairs,
    redactionPassed: state.portableState.redactionPassed
  }, null, 2))
}

function compileSources(outDir) {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/transcript.ts',
    'src/main/conversation-ledger-replay.ts',
    'src/main/anthropic-history.ts',
    'src/main/task/conversation-ledger-archive.ts',
    'src/main/task/conversation-ledger-store.ts',
    'src/main/task/model-attempt-api.ts',
    'src/main/task/model-attempt-runtime.ts',
    'src/main/task/provider-neutral-context.ts',
    'src/main/task/workflow-ledger-api.ts',
    'src/main/task/task-snapshot.ts',
    'src/main/task/task-run.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronStub(outDir, userData) {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), `export const app = { getPath: () => ${JSON.stringify(userData)} }\n`)
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

function childPaths() {
  const outDir = requiredEnv('CAOGEN_CROSS_RESUME_OUT_DIR')
  const userData = requiredEnv('CAOGEN_CROSS_RESUME_USER_DATA')
  const reportFile = requiredEnv('CAOGEN_CROSS_RESUME_REPORT')
  return { outDir, userData, reportFile }
}

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required for child phase`)
  return value
}

async function importCompiled(outDir, name) {
  return import(pathToFileURL(findCompiledModule(outDir, name)).href)
}

function findCompiledModule(root, name) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModule(fullPath, name)
      if (found) return found
    } else if (entry.isFile() && entry.name === name) {
      return fullPath
    }
  }
  if (root === requiredEnv('CAOGEN_CROSS_RESUME_OUT_DIR')) {
    throw new Error(`compiled ${name} not found under ${root}`)
  }
  return null
}

function sourceArchiveIdentity() {
  return {
    sdkSessionId: sourceSdkSessionId,
    currentSessionId: sourceSessionId,
    projectId,
    workspaceId,
    goalId,
    workItemId,
    sourceCwd: repoRoot,
    providerId: 'provider-openai',
    model: 'gpt-fixture',
    engine: 'openai',
    createdAt: 90,
    updatedAt: 100
  }
}

function sessionMeta(identity, userData) {
  return {
    id: identity.id,
    title: 'Cross-provider recovery fixture',
    cwd: userData,
    sourceCwd: repoRoot,
    projectId,
    workspaceId,
    goalId,
    workItemId,
    childTaskId: workItemId,
    model: identity.model,
    providerId: identity.providerId,
    engine: identity.engine,
    taskStrategy: 'execute',
    permissionMode: 'default',
    status: 'running',
    sdkSessionId: identity.sdkSessionId,
    conversationForkSourceSdkSessionId: identity.conversationForkSourceSdkSessionId,
    conversationForkSourceSessionId: identity.conversationForkSourceSessionId,
    conversationForkSourceRunId: identity.conversationForkSourceRunId,
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: 90
  }
}

function sourceTaskRun() {
  return {
    schemaVersion: 1,
    id: sourceRunId,
    sessionId: sourceSessionId,
    taskId: workItemId,
    status: 'executing',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: 90,
    updatedAt: 100,
    steps: [],
    toolExecutions: [],
    effects: []
  }
}

function rows(db, sql, values = []) {
  const statement = db.prepare(sql)
  const result = []
  try {
    statement.bind(values)
    while (statement.step()) result.push(statement.getAsObject())
  } finally {
    statement.free()
  }
  return result
}

function countOccurrences(text, value) {
  return text.split(value).length - 1
}

async function rejects(operation) {
  try {
    await operation()
    return false
  } catch {
    return true
  }
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
