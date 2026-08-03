import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-checkpoint-effect-boundary-'))
const outDir = path.join(tempRoot, 'compiled')

try {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/checkpoint-effect-boundary.ts',
    'src/main/session-operation-queue.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck'
  ], { cwd: repoRoot, stdio: 'inherit' })

  const compiled = [
    path.join(outDir, 'checkpoint-effect-boundary.js'),
    path.join(outDir, 'main', 'checkpoint-effect-boundary.js'),
    path.join(outDir, 'src', 'main', 'checkpoint-effect-boundary.js')
  ].find(existsSync)
  assert.ok(compiled, 'compiled checkpoint effect boundary module must exist')
  const boundary = await import(pathToFileURL(compiled).href)
  const compiledQueue = [
    path.join(outDir, 'session-operation-queue.js'),
    path.join(outDir, 'main', 'session-operation-queue.js'),
    path.join(outDir, 'src', 'main', 'session-operation-queue.js')
  ].find(existsSync)
  assert.ok(compiledQueue, 'compiled Session operation queue module must exist')
  const queue = await import(pathToFileURL(compiledQueue).href)

  const cleanRun = runFixture('executing', [])
  const preparedRun = runFixture('executing', [effectFixture('prepared')])
  const executingRun = runFixture('executing', [effectFixture('executing')])
  const waitingRun = runFixture('waiting_reconciliation', [effectFixture('waiting_reconciliation')])
  const statusOnlyWaitingRun = runFixture('waiting_reconciliation', [])
  const confirmedRun = runFixture('executing', [effectFixture('confirmed')])

  assert.equal(boundary.checkpointRestoreEffectBoundary(cleanRun, false).allowed, true)
  assert.equal(boundary.checkpointRestoreEffectBoundary(confirmedRun, false).allowed, true)
  assert.equal(boundary.checkpointRestoreEffectBoundary(preparedRun, false).allowed, false)
  assert.equal(boundary.checkpointRestoreEffectBoundary(executingRun, false).allowed, false)
  assert.equal(boundary.checkpointRestoreEffectBoundary(waitingRun, false).allowed, false)
  assert.equal(boundary.checkpointRestoreEffectBoundary(statusOnlyWaitingRun, false).allowed, false)

  for (const candidate of [preparedRun, executingRun, waitingRun, statusOnlyWaitingRun]) {
    const preview = boundary.checkpointRestoreEffectBoundary(candidate, true)
    assert.equal(preview.allowed, true, 'dry-run must remain a read-only preview')
    assert.equal(preview.previewOnly, true, 'dry-run must disclose preview-only status')
    assert.match(preview.reason, /未决外部 Effect/, 'dry-run must disclose why apply remains blocked')
  }

  await assertSessionOperationSerialization(queue.withSessionOperationQueue)

  const managerSource = readFileSync(path.join(repoRoot, 'src/main/sessionManager.ts'), 'utf8')
  const gatewaySource = readFileSync(
    path.join(repoRoot, 'src/main/task/operation-effect-gateway.ts'),
    'utf8'
  )
  const effectTypesSource = readFileSync(path.join(repoRoot, 'src/shared/effect-types.ts'), 'utf8')
  const ipcSource = readFileSync(
    path.join(repoRoot, 'src/main/ipc/interactive-mutation-handlers.ts'),
    'utf8'
  )
  assert.match(
    managerSource,
    /private async restoreCheckpointAttempt\([\s\S]*checkpointRestoreEffectBoundary\([\s\S]*session\.restoreCheckpoint\(/,
    'SessionManager must guard the actual restore inside the serialized execution callback'
  )
  assert.match(
    managerSource,
    /private async rewindFilesAttempt\([\s\S]*checkpointRestoreEffectBoundary\([\s\S]*session\.rewindFiles\(/,
    'SessionManager must guard legacy file rewind inside the serialized execution callback'
  )
  assert.match(
    managerSource,
    /当前结果仅为只读预览，完成对账前不可应用。/,
    'SessionManager must not present a blocked dry-run as safe to apply'
  )
  assert.match(
    managerSource,
    /send\([\s\S]*return withSessionOperationQueue\(id, \(\) => this\.performSend\(/,
    'normal sends and Supervisor replay sends must use the shared Session operation queue'
  )
  assert.match(
    managerSource,
    /executeInteractiveOperationEffect<CheckpointOperationAttempt<RewindResult>>\([\s\S]*kind: 'checkpoint_restore'/,
    'legacy file rewind apply must cross a durable Operation Effect barrier'
  )
  assert.match(
    managerSource,
    /executeInteractiveOperationEffect<CheckpointOperationAttempt<CheckpointRestoreResult>>\([\s\S]*kind: 'checkpoint_restore'/,
    'multi-mode checkpoint apply must cross a durable Operation Effect barrier'
  )
  assert(
    managerSource.includes('await this.archiveCheckpointConversation(session)') &&
      managerSource.includes('const archived = await archiveConversationLedgerFromJsonl(identity, {') &&
      managerSource.includes("reason: 'checkpoint_restore'") &&
      managerSource.includes("if (!archived) throw new Error('Checkpoint 已执行，但 Conversation Ledger 没有可归档事件')"),
    'checkpoint apply must await the DB archive before reporting a completed result'
  )
  assert(
    gatewaySource.includes("import { withSessionOperationQueue } from '../session-operation-queue'") &&
      gatewaySource.includes('return withSessionOperationQueue(sourceSessionId, async () => {'),
    'Operation Effect Gateway must share the same per-Session queue as send'
  )
  assert(
    effectTypesSource.includes("| 'checkpoint_restore'"),
    'checkpoint restore must survive durable TaskRun operation metadata validation'
  )
  assert.match(
    ipcSource,
    /sessionManager\.restoreCheckpoint\(id, messageId, safeMode, dryRun === true\)/,
    'IPC must delegate every checkpoint mode to the guarded SessionManager entrypoint'
  )
  assert.match(
    ipcSource,
    /sessionManager\.rewindFiles\(id, messageId, dryRun === true\)/,
    'legacy file-rewind IPC must delegate to the guarded SessionManager entrypoint'
  )
  assert.doesNotMatch(
    ipcSource,
    /return session\.(?:restoreCheckpoint|rewindFiles)\(/,
    'checkpoint IPC must not bypass the SessionManager recovery boundary'
  )

  console.log(JSON.stringify({
    ok: true,
    blockedStatuses: ['prepared', 'executing', 'waiting_reconciliation'],
    dryRun: 'preview-only',
    modes: ['chat', 'code', 'both'],
    productionPath: 'all checkpoint IPC -> shared Session queue -> durable Effect -> Engine restore',
    crashOutcome: 'waiting_reconciliation'
  }, null, 2))
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

async function assertSessionOperationSerialization(withSessionOperationQueue) {
  const order = []
  let releaseSend
  const sendBarrier = new Promise((resolve) => { releaseSend = resolve })
  const send = withSessionOperationQueue('session-serialized', async () => {
    order.push('send:start')
    await sendBarrier
    order.push('send:end')
  })
  await Promise.resolve()
  const checkpoint = withSessionOperationQueue('session-serialized', async () => {
    order.push('checkpoint:start')
    order.push('checkpoint:end')
  })
  await Promise.resolve()
  assert.deepEqual(order, ['send:start'], 'checkpoint must not pass an in-flight send')
  releaseSend()
  await Promise.all([send, checkpoint])
  assert.deepEqual(
    order,
    ['send:start', 'send:end', 'checkpoint:start', 'checkpoint:end'],
    'send and checkpoint must execute as one atomic Session order'
  )

  await assert.rejects(
    withSessionOperationQueue('session-recoverable-queue', async () => { throw new Error('fixture failure') }),
    /fixture failure/
  )
  const recovered = await withSessionOperationQueue('session-recoverable-queue', async () => 'continued')
  assert.equal(recovered, 'continued', 'a rejected action must not poison later Session operations')
}

function runFixture(status, effects) {
  return {
    schemaVersion: 1,
    id: 'run-checkpoint',
    sessionId: 'session-checkpoint',
    taskId: 'work-item-checkpoint',
    status,
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: 1,
    updatedAt: 2,
    steps: [],
    toolExecutions: [],
    effects
  }
}

function effectFixture(status) {
  return {
    schemaVersion: 1,
    id: `effect-${status}`,
    effectKey: `effect-key-${status}`,
    resourceKey: 'workspace:/fixture',
    runId: 'run-checkpoint',
    sessionId: 'session-checkpoint',
    toolUseId: `tool-${status}`,
    toolName: 'write_file',
    status,
    generation: 1,
    intentDigest: 'a'.repeat(64),
    targetDigest: 'b'.repeat(64),
    target: { kind: 'workspace_path', path: '/fixture/file.txt' },
    evidence: [],
    preparedAt: 1,
    updatedAt: 2
  }
}
