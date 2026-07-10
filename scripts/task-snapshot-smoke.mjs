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

  const compiledModule = findCompiledModule(outDir)
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

  mkdirSync(legacyRoot, { recursive: true })
  const { run: _legacyRun, ...legacySnapshotWithoutRun } = snapshot
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
  assertEqual(readSqliteUserVersion(SQL, snapshotStore.taskSnapshotsDbFile(sqliteV2Root)), 4)
  assertEqual((await snapshotStore.listTaskRuns('session-a', sqliteV2Root)).length, 0)

  mkdirSync(sqliteFutureRoot, { recursive: true })
  writeLegacySqliteV2(
    SQL,
    snapshotStore.taskSnapshotsDbFile(sqliteFutureRoot),
    legacySnapshotWithoutRun,
    5
  )
  await assertRejects(
    () => snapshotStore.listTaskSnapshots(sqliteFutureRoot),
    '任务快照数据库版本过新:5 > 4'
  )
  assert(typeof snapshotStore.flushTaskSnapshotMutations === 'function', 'snapshot store should expose flushTaskSnapshotMutations')
  const taskSnapshotSource = readFileSync(path.join(repoRoot, 'src/main/task/task-snapshot.ts'), 'utf8')
  assert(taskSnapshotSource.includes('renameWithRetry(tmpPath, store.path)'), 'snapshot store should atomically rename temp db')
  assert(taskSnapshotSource.includes('rename(tmpPath, targetPath)'), 'snapshot store should use fs rename for replacement')
  assert(taskSnapshotSource.includes("'.tmp'") || taskSnapshotSource.includes('}.tmp`'), 'snapshot store should write a temp db file')
  assert(taskSnapshotSource.includes('mutationQueues.get(key) === queued'), 'settled snapshot mutation queues should be released')
  verifyRecoveryUiAndTray()

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

function findCompiledModule(root) {
  const entries = readdirSync(root, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModule(fullPath)
      if (found) return found
    } else if (entry.isFile() && entry.name === 'task-snapshot.js') {
      return fullPath
    }
  }
  throw new Error(`compiled task-snapshot.js not found under ${root}`)
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

function verifyRecoveryUiAndTray() {
  const appSource = readFileSync(path.join(repoRoot, 'src/renderer/src/App.tsx'), 'utf8')
  assert(appSource.includes('TaskRecoveryModal'), 'App should mount TaskRecoveryModal')
  const recoverySource = readFileSync(path.join(repoRoot, 'src/renderer/src/components/TaskRecoveryModal.tsx'), 'utf8')
  for (const marker of ['listTaskSnapshots', 'recoverTaskSnapshot', 'deleteTaskSnapshot']) {
    assert(recoverySource.includes(marker), `TaskRecoveryModal missing ${marker}`)
  }
  const storeSource = readFileSync(path.join(repoRoot, 'src/renderer/src/store.ts'), 'utf8')
  assert(storeSource.includes('async recoverTaskSnapshot'), 'store should register recovered sessions')
  const mainSource = readFileSync(path.join(repoRoot, 'src/main/index.ts'), 'utf8')
  for (const marker of ['Tray', 'hasRunningSessions', 'win.hide()', 'updateTray']) {
    assert(mainSource.includes(marker), `main process missing tray marker ${marker}`)
  }
  assert(mainSource.includes('await sessionManager.disposeAll()'), 'main process should await snapshot shutdown flush')
  const sessionManagerSource = readFileSync(path.join(repoRoot, 'src/main/sessionManager.ts'), 'utf8')
  for (const marker of [
    'flushTaskSnapshotMutations',
    "event.kind === 'turn-result' && event.isError",
    'event.isError === false &&',
    'restoreTranscriptIfMissing',
    'task-snapshot-replay',
    'buildTaskSnapshotReplayPrompts',
    'recoverable = await this.listTaskSnapshots()'
  ]) {
    assert(sessionManagerSource.includes(marker), `sessionManager missing snapshot marker ${marker}`)
  }
  assert(
    sessionManagerSource.indexOf('const recoverable = await this.listTaskSnapshots()') <
      sessionManagerSource.indexOf('this.restoreActiveSessions('),
    'task snapshots must take recovery precedence over the legacy active-session registry'
  )
  assert(
    !sessionManagerSource.includes('this.preservingSnapshotsOnDispose = false'),
    'shutdown snapshot protection must remain active for late provider events'
  )
  assert(sessionManagerSource.includes('run: this.taskRuns.get(sessionId)'), 'snapshot writes must include TaskRun state')
  const transcriptSource = readFileSync(path.join(repoRoot, 'src/main/transcript.ts'), 'utf8')
  assert(transcriptSource.includes('restoreTranscriptIfMissing'), 'transcript should restore missing snapshot transcripts')
}

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
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
