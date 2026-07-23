import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyRecoveryUiAndTray, verifyTaskDagFinalizerStore } from './lib/task-snapshot-finalizer-checks.mjs'
import { verifySequentialRunReplacement } from './lib/task-snapshot-sequential-run-checks.mjs'
const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-task-snapshot-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'userData')
const explicitRoot = path.join(tempRoot, 'explicit-store')
const legacyRoot = path.join(tempRoot, 'legacy-store')
const sqliteV2Root = path.join(tempRoot, 'sqlite-v2-store')
const sqliteFutureRoot = path.join(tempRoot, 'sqlite-future-store')
const supersedeRoot = path.join(tempRoot, 'supersede-store')
const barrierRoot = path.join(tempRoot, 'barrier-store')
const identityMismatchRoot = path.join(tempRoot, 'identity-mismatch-store')
const crossSessionBarrierRoot = path.join(tempRoot, 'cross-session-barrier-store')
const legacyFileEffectBarrierRoot = path.join(tempRoot, 'legacy-file-effect-barrier-store')
const effectFirstRaceRoot = path.join(tempRoot, 'effect-first-race-store')
const eventFirstRaceRoot = path.join(tempRoot, 'event-first-race-store')
const finalizerRoot = path.join(tempRoot, 'dag-finalizer-store'),
  finalizerAtomicFailureRoot = path.join(tempRoot, 'dag-finalizer-atomic-failure-store')
const finalizerCorruptionRoot = path.join(tempRoot, 'dag-finalizer-corruption-store')
try {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/task/task-snapshot.ts',
      '--outDir',
      outDir,
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--types',
      'node',
      '--skipLibCheck',
      '--esModuleInterop'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(
    path.join(electronDir, 'index.js'),
    `export const app = { getPath: () => ${JSON.stringify(userData)} }\n`
  )
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')

  const compiledModule = path.join(outDir, 'main', 'task', 'task-snapshot.js')
  assert(existsSync(compiledModule), `compiled task-snapshot.js not found at ${compiledModule}`)
  const snapshotStore = await import(pathToFileURL(compiledModule).href)
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs({
    locateFile: (file) => (file.endsWith('.wasm') ? require.resolve('sql.js/dist/sql-wasm.wasm') : file)
  })

  assertEqual(snapshotStore.TASK_SNAPSHOT_EVENT_INTERVAL, 5)

  const snapshot = snapshotStore.buildTaskSnapshot({
    meta: meta('session-a', 'running'),
    transcript: [
      { seq: 1, event: { kind: 'user-message', messageId: 'local-user-a', text: '实现 P0-005' } },
      { seq: 2, event: { kind: 'checkpoint', messageId: 'sdk-checkpoint-a', userMessageId: 'local-user-a' } },
      { seq: 3, event: { kind: 'tool-result', toolUseId: 'tool-a', content: 'ok', isError: false } }
    ],
    lastSeq: 3,
    lastEventId: 'event-tool-result-a',
    lastEventKind: 'tool-result',
    eventCount: 5,
    reason: 'event-batch',
    run: {
      schemaVersion: 1,
      id: 'run-a',
      sessionId: 'session-a',
      taskId: 'session-a',
      status: 'executing',
      revision: 3,
      attempt: 1,
      recoveryCount: 0,
      createdAt: 1000,
      updatedAt: 1900,
      startedAt: 1100,
      messageId: 'local-user-a',
      lastEventKind: 'tool-result',
      steps: [
        {
          id: 'run-a:step:1',
          runId: 'run-a',
          sessionId: 'session-a',
          sequence: 1,
          status: 'executing',
          createdAt: 1000,
          updatedAt: 1900,
          startedAt: 1100,
          messageId: 'local-user-a',
          requestText: '实现 P0-005',
          lastEventKind: 'tool-result'
        }
      ],
      toolExecutions: [
        {
          id: 'run-a:tool:tool-a',
          runId: 'run-a',
          stepId: 'run-a:step:1',
          sessionId: 'session-a',
          toolUseId: 'tool-a',
          toolName: 'write_file',
          status: 'succeeded',
          inputDigest: 'input-digest',
          outputDigest: 'output-digest',
          idempotencyKey: 'tool-v1:fixture',
          createdAt: 1200,
          updatedAt: 1800,
          startedAt: 1200,
          finishedAt: 1800
        }
      ]
    },
    subtasks: [
      {
        taskId: 'qa-smoke',
        role: 'qa',
        sessionId: 'child-a',
        status: 'running',
        branch: 'caogen/session-child-a',
        worktreePath: path.join(tempRoot, 'child-worktree')
      }
    ],
    dagExecutions: [
      {
        id: 'dag-a',
        parentSessionId: 'session-a',
        dag: {
          id: 'dag-a',
          title: 'P0-005',
          source: 'smoke',
          complexity: 'multi',
          createdAt: 1000,
          tasks: []
        },
        status: 'running',
        maxRetries: 1,
        startedAt: 1000,
        layers: [],
        tasks: []
      }
    ],
    dagRuntimes: [
      {
        executionId: 'dag-a',
        parentSessionId: 'session-a',
        capturedAt: 1999,
        dispatchOptions: {
          cwd: 'D:\\project\\CaoGen',
          isolated: true,
          model: 'gpt-4.1',
          providerId: 'provider-a',
          engine: 'openai',
          permissionMode: 'default',
          taskTimeoutMs: 1200000
        },
        runningTasks: [{ taskId: 'qa-smoke', sessionId: 'child-a' }],
        mergeSessions: [
          {
            taskId: 'qa-smoke',
            sessionId: 'child-a',
            repoRoot: 'D:\\project\\CaoGen',
            worktreePath: path.join(tempRoot, 'child-worktree'),
            baseSha: 'abc123',
            branch: 'caogen/session-child-a',
            resultText: 'qa partial'
          }
        ],
        autoMerge: { enabled: true, verificationCommand: 'npm.cmd run typecheck' }
      }
    ],
    now: 2000
  })

  assertEqual(snapshot.taskId, 'session-a')
  assertEqual(snapshot.projectPath, 'D:\\project\\CaoGen')
  assertEqual(snapshot.execution.lastSeq, 3)
  assertEqual(snapshot.execution.cursor.seq, 3)
  assertEqual(snapshot.execution.cursor.eventId, 'event-tool-result-a')
  assertEqual(snapshot.execution.lastCheckpointMessageId, 'sdk-checkpoint-a')
  assertEqual(snapshot.execution.lastUserMessageId, 'local-user-a')
  assertEqual(snapshot.execution.sdkSessionId, 'sdk-session-a')
  assertEqual(snapshot.execution.resumeSessionAt, 'sdk-checkpoint-a')
  assertEqual(snapshot.run.status, 'executing')
  assertEqual(snapshot.run.messageId, 'local-user-a')
  assertEqual(snapshot.run.steps[0].requestText, '实现 P0-005')
  assertEqual(snapshot.run.toolExecutions[0].idempotencyKey, 'tool-v1:fixture')
  assertEqual(snapshot.replayCandidate.messageId, 'local-user-a')
  assertEqual(snapshot.replayCandidate.seq, 1)
  assertEqual(snapshot.replayCandidate.text, '实现 P0-005')
  assertEqual(snapshot.worktree.worktreePath, 'D:\\tmp\\caogen-worktree-a')
  assertEqual(snapshot.subtasks.length, 1)
  assertEqual(snapshot.dagExecutions.length, 1)
  assertEqual(snapshot.dagRuntimes.length, 1)
  assertEqual(snapshot.dagRuntimes[0].runningTasks[0].sessionId, 'child-a')
  assertEqual(snapshot.dagRuntimes[0].mergeSessions[0].branch, 'caogen/session-child-a')
  assertEqual(snapshot.dagRuntimes[0].autoMerge.verificationCommand, 'npm.cmd run typecheck')

  await assertRejects(
    () => snapshotStore.saveTaskSnapshot({ ...snapshot, taskId: 'foreign-task' }, identityMismatchRoot),
    'ownership differs from Snapshot'
  )
  assertEqual((await snapshotStore.listTaskSnapshots(identityMismatchRoot)).length, 0)

  await assertRejects(
    () => snapshotStore.saveTaskRunBarrier(snapshot.run, barrierRoot),
    '缺少可恢复任务快照'
  )
  assertEqual((await snapshotStore.listTaskRuns('session-a', barrierRoot)).length, 0)
  await snapshotStore.saveTaskSnapshot(snapshot, barrierRoot)
  const barrierRun = {
    ...snapshot.run,
    revision: snapshot.run.revision + 1,
    updatedAt: snapshot.run.updatedAt + 1
  }
  await snapshotStore.saveTaskRunBarrier(barrierRun, barrierRoot)
  const barrierSnapshots = await snapshotStore.listTaskSnapshots(barrierRoot)
  assertEqual(barrierSnapshots[0].run.revision, barrierRun.revision)

  await verifySequentialRunReplacement(snapshotStore, path.join(tempRoot, 'sequential-run-store'), meta, assertEqual)

  for (const [raceIndex, raceRoot] of [effectFirstRaceRoot, eventFirstRaceRoot].entries()) {
    const sessionId = `effect-event-race-${raceIndex}`
    const runId = `${sessionId}-run`
    const toolUseId = `${sessionId}-write`
    const effectKey = `effect-v1:${sessionId}`
    const baseRun = {
      ...snapshot.run,
      id: runId,
      sessionId,
      taskId: sessionId,
      revision: 10,
      updatedAt: 5000,
      lastAppliedEventId: `${sessionId}-event-3`,
      lastAppliedEventSeq: 3,
      recentEventIds: [`${sessionId}-event-3`]
    }
    const executingEffect = {
      ...preparedEffect(baseRun, effectKey, 100 + raceIndex),
      id: `${sessionId}-effect`,
      toolUseId,
      toolName: 'write_file',
      revision: 2,
      status: 'executing',
      evidence: [{
        id: `${sessionId}-executing-evidence`,
        kind: 'executing',
        digest: `${sessionId}-executing-digest`,
        observedAt: 5000,
        verifier: 'task-snapshot-race-smoke',
        generation: 1
      }],
      createdAt: 4990,
      updatedAt: 5000
    }
    const baseTool = {
      ...snapshot.run.toolExecutions[0],
      id: `${runId}:tool:${toolUseId}`,
      runId,
      sessionId,
      toolUseId,
      status: 'running',
      effectId: executingEffect.id,
      effectKey,
      effectStatus: 'executing',
      outputDigest: undefined,
      resultEventId: undefined,
      lastEventId: `${sessionId}-event-3`,
      lastEventSeq: 3,
      updatedAt: 5000,
      finishedAt: undefined
    }
    baseRun.effects = [executingEffect]
    baseRun.toolExecutions = [baseTool]
    const baseSnapshot = snapshotStore.buildTaskSnapshot({
      meta: meta(sessionId, 'running'),
      transcript: [{
        seq: 3,
        event: { kind: 'user-message', messageId: `${sessionId}-message`, text: 'race write' }
      }],
      lastSeq: 3,
      lastEventId: `${sessionId}-event-3`,
      lastEventKind: 'user-message',
      eventCount: 3,
      reason: 'important-event',
      run: baseRun,
      now: 5000
    })
    await snapshotStore.saveTaskSnapshot(baseSnapshot, raceRoot)
    const seededRaceSnapshots = await snapshotStore.listTaskSnapshots(raceRoot)
    assertEqual(seededRaceSnapshots.length, 1)
    assertEqual(seededRaceSnapshots[0].run.id, runId)

    const confirmedEffect = {
      ...executingEffect,
      revision: 3,
      status: 'confirmed',
      lease: { ...executingEffect.lease, releasedAt: 5100 },
      evidence: [
        ...executingEffect.evidence,
        {
          id: `${sessionId}-confirmed-evidence`,
          kind: 'execution_result',
          digest: `${sessionId}-confirmed-digest`,
          observedAt: 5100,
          verifier: 'task-snapshot-race-smoke',
          generation: 1
        }
      ],
      updatedAt: 5100,
      terminalAt: 5100
    }
    const effectRun = {
      ...baseRun,
      revision: 11,
      updatedAt: 5100,
      effects: [confirmedEffect],
      toolExecutions: [{
        ...baseTool,
        status: 'succeeded',
        effectStatus: 'confirmed',
        updatedAt: 5100,
        finishedAt: 5100
      }]
    }
    const eventRun = {
      ...baseRun,
      revision: 11,
      updatedAt: 5200,
      lastAppliedEventId: `${sessionId}-event-4`,
      lastAppliedEventSeq: 4,
      recentEventIds: [`${sessionId}-event-3`, `${sessionId}-event-4`],
      toolExecutions: [{
        ...baseTool,
        outputDigest: `${sessionId}-event-output`,
        resultEventId: `${sessionId}-event-4`,
        lastEventId: `${sessionId}-event-4`,
        lastEventSeq: 4,
        updatedAt: 5200
      }]
    }
    const eventSnapshot = {
      ...baseSnapshot,
      updatedAt: 5200,
      eventCount: 4,
      execution: {
        ...baseSnapshot.execution,
        lastSeq: 4,
        cursor: { seq: 4, eventId: `${sessionId}-event-4` },
        lastEventId: `${sessionId}-event-4`,
        lastEventKind: 'tool-result',
        lastEventAt: 5200
      },
      transcript: [
        ...baseSnapshot.transcript,
        {
          seq: 4,
          event: {
            kind: 'tool-result',
            toolUseId,
            content: 'write complete',
            isError: false
          }
        }
      ],
      run: eventRun
    }
    const writes = raceIndex === 0
      ? [
          snapshotStore.saveTaskRunBarrier(effectRun, raceRoot),
          snapshotStore.saveTaskSnapshot(eventSnapshot, raceRoot)
        ]
      : [
          snapshotStore.saveTaskSnapshot(eventSnapshot, raceRoot),
          snapshotStore.saveTaskRunBarrier(effectRun, raceRoot)
        ]
    const outcomes = await Promise.all(writes)
    const barrierResult = raceIndex === 0 ? outcomes[0] : outcomes[1]
    const persistedRaceSnapshot = (await snapshotStore.listTaskSnapshots(raceRoot))[0]
    const persistedRaceRun = (await snapshotStore.listTaskRuns(sessionId, raceRoot))[0]
    assertEqual(barrierResult.effects[0].status, 'confirmed')
    if (raceIndex === 1) {
      assertEqual(barrierResult.lastAppliedEventSeq, 4)
      assertEqual(barrierResult.toolExecutions[0].outputDigest, `${sessionId}-event-output`)
    }
    for (const mergedRun of [persistedRaceSnapshot.run, persistedRaceRun]) {
      assertEqual(mergedRun.lastAppliedEventSeq, 4)
      assertEqual(mergedRun.effects[0].status, 'confirmed')
      assertEqual(mergedRun.toolExecutions[0].status, 'succeeded')
      assertEqual(mergedRun.toolExecutions[0].effectStatus, 'confirmed')
      assertEqual(mergedRun.toolExecutions[0].outputDigest, `${sessionId}-event-output`)
    }
  }

  const sharedResourceKey = 'resource-v1:shared-cross-session-target'
  const crossSessionRuns = ['cross-session-a', 'cross-session-b'].map((sessionId, index) => ({
    schemaVersion: 1,
    id: `${sessionId}-run`,
    sessionId,
    taskId: sessionId,
    status: 'executing',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: 3000 + index,
    updatedAt: 3000 + index,
    steps: [],
    toolExecutions: [],
    effects: []
  }))
  for (const run of crossSessionRuns) {
    await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
      meta: meta(run.sessionId, 'running'),
      transcript: [{ seq: 1, event: { kind: 'user-message', text: 'cross-session lease' } }],
      lastSeq: 1,
      lastEventKind: 'user-message',
      eventCount: 1,
      reason: 'important-event',
      run,
      now: run.updatedAt
    }), crossSessionBarrierRoot)
  }
  const competingRuns = crossSessionRuns.map((run, index) => ({
    ...run,
    revision: 2,
    updatedAt: 3100 + index,
    effects: [preparedEffect(run, `effect-v1:cross-session-intent-${index}`, index, sharedResourceKey)]
  }))
  const competingOutcomes = await Promise.allSettled(
    competingRuns.map((run) => snapshotStore.saveTaskRunBarrier(run, crossSessionBarrierRoot))
  )
  assertEqual(competingOutcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
  assertEqual(competingOutcomes.filter((outcome) => outcome.status === 'rejected').length, 1)
  const conflictError = competingOutcomes
    .filter((outcome) => outcome.status === 'rejected')
    .map((outcome) => String(outcome.reason?.message ?? outcome.reason))
    .join('\n')
  assert(conflictError.includes('其他会话仍未收敛'), 'cross-session duplicate lease must fail closed')
  const globallyPersistedEffects = (await snapshotStore.listTaskRuns(undefined, crossSessionBarrierRoot))
    .flatMap((run) => run.effects ?? [])
    .filter((effect) => effect.resourceKey === sharedResourceKey)
  assertEqual(globallyPersistedEffects.length, 1)
  const winningOutcome = competingOutcomes.find((outcome) => outcome.status === 'fulfilled')
  const winningRun = winningOutcome.value
  assertEqual(winningRun.effects[0].lease.fencingToken, 1)
  const settledWinningRun = {
    ...winningRun,
    revision: winningRun.revision + 1,
    updatedAt: 3200,
    effects: [{
      ...winningRun.effects[0],
      revision: winningRun.effects[0].revision + 1,
      status: 'confirmed',
      lease: { ...winningRun.effects[0].lease, releasedAt: 3200 },
      updatedAt: 3200,
      terminalAt: 3200
    }]
  }
  await snapshotStore.saveTaskRunBarrier(settledWinningRun, crossSessionBarrierRoot)
  const losingRun = competingRuns.find((run) => run.id !== winningRun.id)
  const retriedRun = await snapshotStore.saveTaskRunBarrier({
    ...losingRun,
    revision: losingRun.revision + 1,
    updatedAt: 3300
  }, crossSessionBarrierRoot)
  assertEqual(
    retriedRun.effects[0].lease.fencingToken,
    2,
    'next lease for one resource must receive the next global fencing token'
  )

  for (const [legacyIndex, toolName] of ['search_replace', 'edit_file'].entries()) {
    const legacyStoreRoot = path.join(legacyFileEffectBarrierRoot, toolName)
    const legacySessionId = `legacy-opaque-${toolName}`
    const queryableSessionId = `queryable-${toolName}`
    const observedAt = 3600 + legacyIndex * 100
    const legacyTarget = { kind: 'unsupported', toolName }
    const legacyTargetDigest = `legacy-${toolName}-target-digest`
    const legacyIntentDigest = `legacy-${toolName}-intent-digest`
    const legacyResourceKey = `resource-v1:legacy-opaque-${toolName}`
    const legacyRun = {
      schemaVersion: 1,
      id: `${legacySessionId}-run`,
      sessionId: legacySessionId,
      taskId: legacySessionId,
      status: 'waiting_reconciliation',
      revision: 2,
      attempt: 1,
      recoveryCount: 0,
      createdAt: observedAt,
      updatedAt: observedAt + 1,
      steps: [],
      toolExecutions: [],
      effects: []
    }
    const preparedLegacyEffect = preparedEffect(
      legacyRun,
      `effect-v1:legacy-opaque-${toolName}`,
      30 + legacyIndex,
      legacyResourceKey
    )
    const legacyEffect = {
      ...preparedLegacyEffect,
      toolName,
      status: 'waiting_reconciliation',
      reconcilability: 'opaque',
      target: legacyTarget,
      targetDigest: legacyTargetDigest,
      intentDigest: legacyIntentDigest,
      inputDigest: `legacy-${toolName}-input-digest`,
      revision: 2,
      lease: {
        ...preparedLegacyEffect.lease,
        releasedAt: observedAt + 1
      },
      createdAt: observedAt,
      updatedAt: observedAt + 1,
      error: 'legacy effect outcome is unknown'
    }
    legacyRun.effects = [legacyEffect]
    await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
      meta: meta(legacySessionId, 'error'),
      transcript: [{ seq: 1, event: { kind: 'user-message', text: `legacy ${toolName}` } }],
      lastSeq: 1,
      lastEventKind: 'user-message',
      eventCount: 1,
      reason: 'important-event',
      run: legacyRun,
      now: observedAt + 1
    }), legacyStoreRoot)

    const persistedLegacyEffect = (await snapshotStore.listTaskRuns(legacySessionId, legacyStoreRoot))[0].effects[0]
    assertEqual(JSON.stringify(persistedLegacyEffect.target), JSON.stringify(legacyTarget))
    assertEqual(persistedLegacyEffect.targetDigest, legacyTargetDigest)
    assertEqual(persistedLegacyEffect.intentDigest, legacyIntentDigest)
    assertEqual(persistedLegacyEffect.resourceKey, legacyResourceKey)

    const queryableRun = {
      schemaVersion: 1,
      id: `${queryableSessionId}-run`,
      sessionId: queryableSessionId,
      taskId: queryableSessionId,
      status: 'executing',
      revision: 2,
      attempt: 1,
      recoveryCount: 0,
      createdAt: observedAt + 10,
      updatedAt: observedAt + 11,
      steps: [],
      toolExecutions: [],
      effects: []
    }
    await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
      meta: meta(queryableSessionId, 'running'),
      transcript: [{ seq: 1, event: { kind: 'user-message', text: `queryable ${toolName}` } }],
      lastSeq: 1,
      lastEventKind: 'user-message',
      eventCount: 1,
      reason: 'important-event',
      run: queryableRun,
      now: observedAt + 11
    }), legacyStoreRoot)
    const queryableEffect = {
      ...preparedEffect(
        queryableRun,
        `effect-v1:queryable-${toolName}`,
        40 + legacyIndex,
        `resource-v1:queryable-file-${toolName}`
      ),
      toolName,
      reconcilability: 'queryable',
      target: {
        kind: 'file_content',
        rootPath: path.join(tempRoot, 'legacy-file-effect-project'),
        rootIdentity: { device: '101', inode: '201' },
        relativePath: `${toolName}.txt`,
        preState: 'file',
        preFileIdentity: { device: '101', inode: String(301 + legacyIndex) },
        preSha256: `pre-${toolName}-sha256`,
        preBytes: 6,
        expectedSha256: `expected-${toolName}-sha256`,
        expectedBytes: 7
      },
      targetDigest: `queryable-${toolName}-target-digest`,
      intentDigest: `queryable-${toolName}-intent-digest`,
      inputDigest: `queryable-${toolName}-input-digest`
    }
    const queryableEffectRun = { ...queryableRun, effects: [queryableEffect] }
    assert(
      queryableEffect.resourceKey !== legacyResourceKey,
      'legacy opaque and queryable file effects must exercise the wildcard conflict path'
    )
    await assertRejects(
      () => snapshotStore.saveTaskRunBarrier(queryableEffectRun, legacyStoreRoot),
      '其他会话仍未收敛'
    )
    assertEqual(
      (await snapshotStore.listTaskRuns(queryableSessionId, legacyStoreRoot))[0].effects.length,
      0
    )

    const legacyAfterConflict = (await snapshotStore.listTaskRuns(legacySessionId, legacyStoreRoot))[0].effects[0]
    assertEqual(JSON.stringify(legacyAfterConflict.target), JSON.stringify(legacyTarget))
    assertEqual(legacyAfterConflict.targetDigest, legacyTargetDigest)
    assertEqual(legacyAfterConflict.intentDigest, legacyIntentDigest)
    assertEqual(legacyAfterConflict.resourceKey, legacyResourceKey)

    const sameRunStoreRoot = path.join(legacyFileEffectBarrierRoot, `${toolName}-same-run`)
    const sameRunSessionId = `same-run-legacy-${toolName}`
    const sameRun = {
      ...legacyRun,
      id: `${sameRunSessionId}-run`,
      sessionId: sameRunSessionId,
      taskId: sameRunSessionId,
      effects: []
    }
    const sameRunLegacyEffect = rebindEffect(legacyEffect, sameRun, 'legacy')
    const persistedSameRun = { ...sameRun, effects: [sameRunLegacyEffect] }
    await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
      meta: meta(sameRunSessionId, 'error'),
      transcript: [{ seq: 1, event: { kind: 'user-message', text: `same-run legacy ${toolName}` } }],
      lastSeq: 1,
      lastEventKind: 'user-message',
      eventCount: 1,
      reason: 'important-event',
      run: persistedSameRun,
      now: observedAt + 2
    }), sameRunStoreRoot)

    const sameRunQueryableEffect = rebindEffect(
      {
        ...queryableEffect,
        resourceKey: `resource-v1:same-run-queryable-${toolName}`
      },
      sameRun,
      'queryable'
    )
    assert(
      sameRunQueryableEffect.resourceKey !== sameRunLegacyEffect.resourceKey,
      'same-run legacy and queryable effects must exercise the wildcard conflict path'
    )
    await assertRejects(
      () => snapshotStore.saveTaskRunBarrier({
        ...persistedSameRun,
        revision: persistedSameRun.revision + 1,
        updatedAt: observedAt + 3,
        effects: [sameRunLegacyEffect, sameRunQueryableEffect]
      }, sameRunStoreRoot),
      '已阻止第二个执行 lease'
    )
    const sameRunAfterConflict = (await snapshotStore.listTaskRuns(sameRunSessionId, sameRunStoreRoot))[0]
    assertEqual(sameRunAfterConflict.effects.length, 1)
    assertEqual(sameRunAfterConflict.effects[0].id, sameRunLegacyEffect.id)

    const opaquePeerSessionId = `opaque-peer-${toolName}`
    const opaquePeerRun = {
      ...queryableRun,
      id: `${opaquePeerSessionId}-run`,
      sessionId: opaquePeerSessionId,
      taskId: opaquePeerSessionId,
      effects: []
    }
    await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
      meta: meta(opaquePeerSessionId, 'running'),
      transcript: [{ seq: 1, event: { kind: 'user-message', text: `opaque peer ${toolName}` } }],
      lastSeq: 1,
      lastEventKind: 'user-message',
      eventCount: 1,
      reason: 'important-event',
      run: opaquePeerRun,
      now: observedAt + 4
    }), sameRunStoreRoot)
    const opaquePeerEffect = {
      ...preparedEffect(
        opaquePeerRun,
        `effect-v1:opaque-peer-${toolName}`,
        50 + legacyIndex,
        `resource-v1:opaque-peer-${toolName}`
      ),
      toolName,
      target: { kind: 'unsupported', toolName },
      targetDigest: `opaque-peer-${toolName}-target-digest`,
      intentDigest: `opaque-peer-${toolName}-intent-digest`,
      inputDigest: `opaque-peer-${toolName}-input-digest`
    }
    assert(
      opaquePeerEffect.resourceKey !== sameRunLegacyEffect.resourceKey,
      'opaque file effects must exercise the wildcard conflict path even when resource keys differ'
    )
    await assertRejects(
      () => snapshotStore.saveTaskRunBarrier({ ...opaquePeerRun, effects: [opaquePeerEffect] }, sameRunStoreRoot),
      '已阻止第二个执行 lease'
    )
    assertEqual(
      (await snapshotStore.listTaskRuns(opaquePeerSessionId, sameRunStoreRoot))[0].effects.length,
      0
    )

    const writePeerSessionId = `write-peer-${toolName}`
    const writePeerRun = {
      ...queryableRun,
      id: `${writePeerSessionId}-run`,
      sessionId: writePeerSessionId,
      taskId: writePeerSessionId,
      effects: []
    }
    await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
      meta: meta(writePeerSessionId, 'running'),
      transcript: [{ seq: 1, event: { kind: 'user-message', text: `write peer ${toolName}` } }],
      lastSeq: 1,
      lastEventKind: 'user-message',
      eventCount: 1,
      reason: 'important-event',
      run: writePeerRun,
      now: observedAt + 5
    }), sameRunStoreRoot)
    const writePeerEffect = {
      ...preparedEffect(
        writePeerRun,
        `effect-v1:write-peer-${toolName}`,
        60 + legacyIndex,
        `resource-v1:write-peer-${toolName}`
      ),
      toolName: 'write_file',
      reconcilability: 'queryable',
      target: {
        ...queryableEffect.target,
        relativePath: `write-peer-${toolName}.txt`
      },
      targetDigest: `write-peer-${toolName}-target-digest`,
      intentDigest: `write-peer-${toolName}-intent-digest`,
      inputDigest: `write-peer-${toolName}-input-digest`
    }
    assert(
      writePeerEffect.resourceKey !== sameRunLegacyEffect.resourceKey,
      'legacy opaque file edits must wildcard-conflict with write_file even when resource keys differ'
    )
    await assertRejects(
      () => snapshotStore.saveTaskRunBarrier({ ...writePeerRun, effects: [writePeerEffect] }, sameRunStoreRoot),
      '已阻止第二个执行 lease'
    )
    assertEqual(
      (await snapshotStore.listTaskRuns(writePeerSessionId, sameRunStoreRoot))[0].effects.length,
      0
    )

    const confirmedApplied = toolName === 'search_replace'
    const terminalAt = observedAt + 20
    const manualEvidence = {
      id: `${legacySessionId}-manual-resolution`,
      kind: 'manual_confirmation',
      digest: `${legacySessionId}-manual-resolution-digest`,
      observedAt: terminalAt,
      verifier: 'human-v1',
      generation: legacyAfterConflict.generation
    }
    const terminalLegacyEffect = {
      ...legacyAfterConflict,
      status: confirmedApplied ? 'confirmed' : 'abandoned',
      revision: legacyAfterConflict.revision + 1,
      evidence: [
        ...legacyAfterConflict.evidence,
        manualEvidence,
        ...(!confirmedApplied
          ? [{
              id: `${legacySessionId}-retry-authorization`,
              kind: 'retry_authorized',
              digest: `${legacySessionId}-retry-authorization-digest`,
              observedAt: terminalAt,
              verifier: 'human-v1',
              generation: legacyAfterConflict.generation
            }]
          : [])
      ],
      updatedAt: terminalAt,
      terminalAt,
      error: confirmedApplied ? undefined : '人工处置:confirmed_not_applied'
    }
    const terminalLegacyRun = {
      ...legacyRun,
      status: confirmedApplied ? 'completed' : 'failed',
      revision: legacyRun.revision + 1,
      updatedAt: terminalAt,
      finishedAt: terminalAt,
      effects: [terminalLegacyEffect],
      error: confirmedApplied ? undefined : '人工确认外部效果未执行'
    }
    await snapshotStore.saveTaskRunBarrier(terminalLegacyRun, legacyStoreRoot)
    const persistedTerminalEffect = (await snapshotStore.listTaskRuns(legacySessionId, legacyStoreRoot))[0].effects[0]
    assertEqual(persistedTerminalEffect.status, confirmedApplied ? 'confirmed' : 'abandoned')
    assertEqual(JSON.stringify(persistedTerminalEffect.target), JSON.stringify(legacyTarget))
    assertEqual(persistedTerminalEffect.targetDigest, legacyTargetDigest)
    assertEqual(persistedTerminalEffect.intentDigest, legacyIntentDigest)

    const acceptedQueryableRun = await snapshotStore.saveTaskRunBarrier(queryableEffectRun, legacyStoreRoot)
    assertEqual(acceptedQueryableRun.effects[0].status, 'prepared')
    assertEqual(acceptedQueryableRun.effects[0].lease.fencingToken, 1)
  }

  const independentRuns = ['independent-a', 'independent-b'].map((sessionId, index) => ({
    schemaVersion: 1,
    id: `${sessionId}-run`,
    sessionId,
    taskId: sessionId,
    status: 'executing',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: 3400 + index,
    updatedAt: 3400 + index,
    steps: [],
    toolExecutions: [],
    effects: []
  }))
  for (const run of independentRuns) {
    await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
      meta: meta(run.sessionId, 'running'),
      transcript: [{ seq: 1, event: { kind: 'user-message', text: 'independent resource lease' } }],
      lastSeq: 1,
      lastEventKind: 'user-message',
      eventCount: 1,
      reason: 'important-event',
      run,
      now: run.updatedAt
    }), crossSessionBarrierRoot)
  }
  const independentResults = await Promise.all(independentRuns.map((run, index) =>
    snapshotStore.saveTaskRunBarrier({
      ...run,
      revision: 2,
      updatedAt: 3500 + index,
      effects: [preparedEffect(
        run,
        `effect-v1:independent-intent-${index}`,
        10 + index,
        `resource-v1:independent-${index}`
      )]
    }, crossSessionBarrierRoot)
  ))
  assertEqual(independentResults.length, 2)
  assert(
    independentResults.every((run) => run.effects[0].lease.fencingToken === 1),
    'unrelated resources must acquire leases concurrently with independent token sequences'
  )

  const completedSnapshot = snapshotStore.buildTaskSnapshot({
    meta: meta('session-completed', 'idle'),
    transcript: [
      { seq: 1, event: { kind: 'user-message', messageId: 'local-user-completed', text: '已完成任务' } },
      { seq: 2, event: { kind: 'turn-result', subtype: 'success', isError: false, resultText: 'done' } }
    ],
    lastSeq: 2,
    lastEventKind: 'turn-result',
    eventCount: 2,
    reason: 'event-batch',
    now: 3000
  })
  assertEqual(completedSnapshot.replayCandidate, undefined)

  const saved = await snapshotStore.saveTaskSnapshot(snapshot, explicitRoot)
  assertEqual(saved.id, 'session-a')
  assert(existsSync(snapshotStore.taskSnapshotsDbFile(explicitRoot)), 'SQLite snapshot store should be written')
  const dbHeader = readFileSync(snapshotStore.taskSnapshotsDbFile(explicitRoot)).subarray(0, 16).toString('utf8')
  assertEqual(dbHeader, 'SQLite format 3\0')
  assertEqual((await snapshotStore.listTaskSnapshots(explicitRoot)).length, 1)
  assertEqual((await snapshotStore.getTaskSnapshot('session-a', explicitRoot)).execution.status, 'running')
  assertEqual((await snapshotStore.getTaskSnapshot('session-a', explicitRoot)).run.status, 'executing')
  assertEqual((await snapshotStore.getTaskSnapshot('session-a', explicitRoot)).run.toolExecutions[0].status, 'succeeded')

  await verifyTaskDagFinalizerStore({
    assertRejects, finalizerAtomicFailureRoot, finalizerCorruptionRoot, finalizerRoot, meta, snapshotStore, SQL
  })

  const supersededSnapshot = {
    ...snapshot,
    id: 'session-supersede',
    sessionId: 'session-supersede',
    taskId: 'session-supersede',
    meta: meta('session-supersede', 'error'),
    run: {
      ...snapshot.run,
      id: 'run-supersede',
      sessionId: 'session-supersede',
      taskId: 'session-supersede',
      status: 'failed',
      revision: 4,
      updatedAt: 2200,
      finishedAt: 2200,
      error: 'interrupted',
      toolExecutions: [
        {
          ...snapshot.run.toolExecutions[0],
          id: 'run-supersede:tool:old-unknown',
          runId: 'run-supersede',
          sessionId: 'session-supersede',
          toolUseId: 'old-unknown',
          status: 'unknown_outcome',
          outputDigest: undefined,
          updatedAt: 2100,
          finishedAt: 2100,
          error: 'unknown'
        }
      ]
    }
  }
  await snapshotStore.saveTaskSnapshot(supersededSnapshot, supersedeRoot)
  assertEqual(
    await snapshotStore.supersedeToolExecution(
      'run-supersede:tool:old-unknown',
      'run-retry:tool:confirmed',
      2300,
      supersedeRoot
    ),
    true
  )
  const supersededRuns = await snapshotStore.listTaskRuns('session-supersede', supersedeRoot)
  assertEqual(supersededRuns[0].toolExecutions[0].status, 'superseded')
  assertEqual(
    supersededRuns[0].toolExecutions[0].supersededByExecutionId,
    'run-retry:tool:confirmed'
  )
  const supersededStoredSnapshot = await snapshotStore.getTaskSnapshot('session-supersede', supersedeRoot)
  assertEqual(supersededStoredSnapshot.run.toolExecutions[0].status, 'superseded')

  const older = {
    ...snapshot,
    updatedAt: 1500,
    reason: 'important-event',
    eventCount: 6,
    execution: {
      ...snapshot.execution,
      lastSeq: 2,
      cursor: { seq: 2, eventId: 'event-stale' },
      lastEventId: 'event-stale'
    }
  }
  await snapshotStore.saveTaskSnapshot(older, explicitRoot)
  const updated = await snapshotStore.listTaskSnapshots(explicitRoot)
  assertEqual(updated.length, 1)
  assertEqual(updated[0].eventCount, 5)
  assertEqual(updated[0].createdAt, snapshot.createdAt)
  assertEqual(updated[0].execution.lastSeq, 3)
  assertEqual(updated[0].execution.cursor.eventId, 'event-tool-result-a')
  assertNoTempFiles(explicitRoot)

  assertEqual(await snapshotStore.deleteTaskSnapshot('missing', explicitRoot), false)
  const completedRun = {
    ...snapshot.run,
    status: 'completed',
    revision: snapshot.run.revision + 1,
    updatedAt: 2500,
    finishedAt: 2500,
    lastEventKind: 'turn-result'
  }
  assertEqual(await snapshotStore.deleteTaskSnapshot('session-a', explicitRoot, completedRun), true)
  assertEqual((await snapshotStore.listTaskSnapshots(explicitRoot)).length, 0)
  const persistedRuns = await snapshotStore.listTaskRuns('session-a', explicitRoot)
  assertEqual(persistedRuns.length, 1)
  assertEqual(persistedRuns[0].status, 'completed')
  assertEqual(persistedRuns[0].finishedAt, 2500)
  assertEqual(persistedRuns[0].steps.length, 1)
  assertEqual(persistedRuns[0].toolExecutions.length, 1)

  writeFileSync(snapshotStore.taskSnapshotsFile(explicitRoot), '{ bad json', 'utf8')
  assertEqual((await snapshotStore.listTaskSnapshots(explicitRoot)).length, 0)

  const { run: _legacyRun, ...legacySnapshotWithoutRun } = snapshot
  mkdirSync(legacyRoot, { recursive: true })
  writeFileSync(
    snapshotStore.taskSnapshotsFile(legacyRoot),
    `${JSON.stringify({ version: 1, snapshots: [legacySnapshotWithoutRun] }, null, 2)}\n`,
    'utf8'
  )
  const migrated = await snapshotStore.listTaskSnapshots(legacyRoot)
  assertEqual(migrated.length, 1)
  assertEqual(migrated[0].id, snapshot.id)
  assertEqual(migrated[0].run, undefined)
  assertEqual((await snapshotStore.listTaskRuns('session-a', legacyRoot)).length, 0)
  assert(existsSync(snapshotStore.taskSnapshotsDbFile(legacyRoot)), 'legacy JSON should be migrated to SQLite')
  const migratedNewer = {
    ...migrated[0],
    updatedAt: 4000,
    eventCount: 9,
    execution: {
      ...migrated[0].execution,
      lastSeq: 9,
      cursor: { seq: 9, eventId: 'event-after-legacy-migration' },
      lastEventId: 'event-after-legacy-migration'
    }
  }
  await snapshotStore.saveTaskSnapshot(migratedNewer, legacyRoot)
  const reopenedAfterLegacyMigration = await snapshotStore.listTaskSnapshots(legacyRoot)
  assertEqual(reopenedAfterLegacyMigration[0].eventCount, 9)
  assertEqual(reopenedAfterLegacyMigration[0].execution.lastSeq, 9)

  mkdirSync(sqliteV2Root, { recursive: true })
  writeLegacySqliteV2(
    SQL,
    snapshotStore.taskSnapshotsDbFile(sqliteV2Root),
    legacySnapshotWithoutRun
  )
  const migratedV2 = await snapshotStore.listTaskSnapshots(sqliteV2Root)
  assertEqual(migratedV2.length, 1)
  assertEqual(migratedV2[0].run, undefined)
  assertEqual(readSqliteUserVersion(SQL, snapshotStore.taskSnapshotsDbFile(sqliteV2Root)), 8)
  assertEqual((await snapshotStore.listTaskRuns('session-a', sqliteV2Root)).length, 0)

  mkdirSync(sqliteFutureRoot, { recursive: true })
  writeLegacySqliteV2(
    SQL,
    snapshotStore.taskSnapshotsDbFile(sqliteFutureRoot),
    legacySnapshotWithoutRun,
    9
  )
  await assertRejects(
    () => snapshotStore.listTaskSnapshots(sqliteFutureRoot),
    '任务快照数据库版本过新:9 > 8'
  )
  assert(typeof snapshotStore.flushTaskSnapshotMutations === 'function', 'snapshot store should expose flushTaskSnapshotMutations')
  const taskSnapshotSource = readFileSync(path.join(repoRoot, 'src/main/task/task-snapshot.ts'), 'utf8')
  assert(taskSnapshotSource.includes('renameWithRetry(tmpPath, store.path)'), 'snapshot store should atomically rename temp db')
  assert(taskSnapshotSource.includes('rename(tmpPath, targetPath)'), 'snapshot store should use fs rename for replacement')
  assert(taskSnapshotSource.includes("'.tmp'") || taskSnapshotSource.includes('}.tmp`'), 'snapshot store should write a temp db file')
  assert(taskSnapshotSource.includes('mutationQueues.get(key) === queued'), 'settled snapshot mutation queues should be released')
  verifyRecoveryUiAndTray(repoRoot)

  console.log('taskSnapshot smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function meta(id, status) {
  return {
    id,
    title: 'P0-005 snapshot smoke',
    cwd: 'D:\\project\\CaoGen',
    sourceCwd: 'D:\\project\\CaoGen',
    repoRoot: 'D:\\project\\CaoGen',
    isolated: true,
    worktreePath: 'D:\\tmp\\caogen-worktree-a',
    branch: 'caogen/session-a',
    baseBranch: 'main',
    baseSha: 'abc123',
    worktreeState: 'active',
    model: 'gpt-4.1',
    providerId: 'provider-a',
    resumeSessionAt: 'sdk-checkpoint-a',
    engine: 'openai',
    permissionMode: 'default',
    status,
    sdkSessionId: 'sdk-session-a',
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: 1000
  }
}

function assertNoTempFiles(root) {
  const tempFiles = readdirSync(root).filter((entry) => entry.endsWith('.tmp'))
  assertEqual(JSON.stringify(tempFiles), '[]')
}

function writeLegacySqliteV2(SQL, dbPath, snapshot, version = 2) {
  const db = new SQL.Database()
  try {
    db.run(`
      CREATE TABLE task_snapshots (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
    `)
    db.run(
      'INSERT INTO task_snapshots(id, session_id, updated_at, payload) VALUES (?, ?, ?, ?)',
      [snapshot.id, snapshot.sessionId, snapshot.updatedAt, JSON.stringify(snapshot)]
    )
    db.run(`PRAGMA user_version = ${version}`)
    writeFileSync(dbPath, db.export())
  } finally {
    db.close()
  }
}

function readSqliteUserVersion(SQL, dbPath) {
  const db = new SQL.Database(readFileSync(dbPath))
  try {
    return db.exec('PRAGMA user_version')[0]?.values[0]?.[0]
  } finally {
    db.close()
  }
}
function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function preparedEffect(run, effectKey, index, resourceKey = effectKey) {
  const observedAt = 3100 + index
  return {
    schemaVersion: 1,
    id: `${run.sessionId}-effect`,
    effectKey,
    resourceKey,
    sessionId: run.sessionId,
    runId: run.id,
    toolUseId: `${run.sessionId}-tool`,
    toolName: 'bash',
    generation: 1,
    revision: 1,
    status: 'prepared',
    reconcilability: 'opaque',
    target: { kind: 'unsupported', toolName: 'bash' },
    targetDigest: 'target-digest',
    intentDigest: 'intent-digest',
    inputDigest: 'input-digest',
    lease: {
      id: `${run.sessionId}-lease`,
      ownerId: `${run.sessionId}-owner`,
      fencingToken: 1,
      acquiredAt: observedAt,
      expiresAt: observedAt + 60_000
    },
    evidence: [{
      id: `${run.sessionId}-evidence`,
      kind: 'prepared',
      digest: 'prepared-digest',
      observedAt,
      verifier: 'task-snapshot-smoke',
      generation: 1
    }],
    createdAt: observedAt,
    updatedAt: observedAt
  }
}

function rebindEffect(effect, run, suffix) {
  return {
    ...effect,
    id: `${run.sessionId}-${suffix}-effect`,
    sessionId: run.sessionId,
    runId: run.id,
    toolUseId: `${run.sessionId}-${suffix}-tool`,
    lease: {
      ...effect.lease,
      id: `${run.sessionId}-${suffix}-lease`,
      ownerId: `${run.sessionId}-${suffix}-owner`
    },
    evidence: effect.evidence.map((item, index) => ({
      ...item,
      id: `${run.sessionId}-${suffix}-evidence-${index}`
    }))
  }
}

async function assertRejects(fn, expectedMessage) {
  try {
    await fn()
  } catch (error) {
    assert(String(error?.message ?? error).includes(expectedMessage), `unexpected rejection: ${String(error)}`)
    return
  }
  throw new Error(`expected rejection containing ${JSON.stringify(expectedMessage)}`)
}
function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
