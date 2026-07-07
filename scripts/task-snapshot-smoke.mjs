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

  assertEqual(snapshotStore.TASK_SNAPSHOT_EVENT_INTERVAL, 5)

  const snapshot = snapshotStore.buildTaskSnapshot({
    meta: meta('session-a', 'running'),
    transcript: [
      { seq: 1, event: { kind: 'user-message', messageId: 'local-user-a', text: '实现 P0-005' } },
      { seq: 2, event: { kind: 'checkpoint', messageId: 'sdk-checkpoint-a', userMessageId: 'local-user-a' } },
      { seq: 3, event: { kind: 'tool-result', toolUseId: 'tool-a', content: 'ok', isError: false } }
    ],
    lastSeq: 3,
    lastEventKind: 'tool-result',
    eventCount: 5,
    reason: 'event-batch',
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
  assertEqual(snapshot.execution.lastCheckpointMessageId, 'sdk-checkpoint-a')
  assertEqual(snapshot.execution.lastUserMessageId, 'local-user-a')
  assertEqual(snapshot.execution.sdkSessionId, 'sdk-session-a')
  assertEqual(snapshot.execution.resumeSessionAt, 'sdk-checkpoint-a')
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

  const older = {
    ...snapshot,
    updatedAt: 1500,
    reason: 'important-event',
    eventCount: 6,
    execution: { ...snapshot.execution, lastSeq: 4 }
  }
  await snapshotStore.saveTaskSnapshot(older, explicitRoot)
  const updated = await snapshotStore.listTaskSnapshots(explicitRoot)
  assertEqual(updated.length, 1)
  assertEqual(updated[0].eventCount, 6)
  assertEqual(updated[0].createdAt, snapshot.createdAt)
  assertEqual(updated[0].execution.lastSeq, 4)
  assertNoTempFiles(explicitRoot)

  assertEqual(await snapshotStore.deleteTaskSnapshot('missing', explicitRoot), false)
  assertEqual(await snapshotStore.deleteTaskSnapshot('session-a', explicitRoot), true)
  assertEqual((await snapshotStore.listTaskSnapshots(explicitRoot)).length, 0)

  writeFileSync(snapshotStore.taskSnapshotsFile(explicitRoot), '{ bad json', 'utf8')
  assertEqual((await snapshotStore.listTaskSnapshots(explicitRoot)).length, 0)

  mkdirSync(legacyRoot, { recursive: true })
  writeFileSync(
    snapshotStore.taskSnapshotsFile(legacyRoot),
    `${JSON.stringify({ version: 1, snapshots: [snapshot] }, null, 2)}\n`,
    'utf8'
  )
  const migrated = await snapshotStore.listTaskSnapshots(legacyRoot)
  assertEqual(migrated.length, 1)
  assertEqual(migrated[0].id, snapshot.id)
  assert(existsSync(snapshotStore.taskSnapshotsDbFile(legacyRoot)), 'legacy JSON should be migrated to SQLite')
  assert(typeof snapshotStore.flushTaskSnapshotMutations === 'function', 'snapshot store should expose flushTaskSnapshotMutations')
  const taskSnapshotSource = readFileSync(path.join(repoRoot, 'src/main/task/task-snapshot.ts'), 'utf8')
  assert(taskSnapshotSource.includes('renameWithRetry(tmpPath, store.path)'), 'snapshot store should atomically rename temp db')
  assert(taskSnapshotSource.includes('rename(tmpPath, targetPath)'), 'snapshot store should use fs rename for replacement')
  assert(taskSnapshotSource.includes("'.tmp'") || taskSnapshotSource.includes('}.tmp`'), 'snapshot store should write a temp db file')
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
    "event.kind === 'turn-result' && event.isError === false",
    'restoreTranscriptIfMissing',
    'task-snapshot-replay',
    'buildTaskSnapshotReplayPrompt',
    'recoverable = await this.listTaskSnapshots()'
  ]) {
    assert(sessionManagerSource.includes(marker), `sessionManager missing snapshot marker ${marker}`)
  }
  const transcriptSource = readFileSync(path.join(repoRoot, 'src/main/transcript.ts'), 'utf8')
  assert(transcriptSource.includes('restoreTranscriptIfMissing'), 'transcript should restore missing snapshot transcripts')
}

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
