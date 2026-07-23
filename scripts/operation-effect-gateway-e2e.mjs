import { execFileSync, fork } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  chmodSync,
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
import { pathToFileURL } from 'node:url'
import { runManagedWorktreeOperationChecks } from './lib/managed-worktree-operation-checks.mjs'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-operation-effect-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
process.env.CAOGEN_TEST_USER_DATA = userData

try {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/task/operation-effect-gateway.ts',
      'src/main/ipc/operation-snapshot.ts',
      'src/main/task/effect-reconciler.ts',
      'src/main/git/pull-request-effect.ts',
      'src/main/git/managed-worktree-effect.ts',
      'src/main/git/git-helper.ts',
      'src/main/gitDiff.ts',
      'src/main/worktrees.ts',
      'src/main/ipc/worktree-operation-handlers.ts',
      '--outDir',
      outDir,
      '--rootDir',
      'src',
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
    'export const app = { getPath: () => process.env.CAOGEN_TEST_USER_DATA }\n'
  )
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')

  const gateway = await importModule(outDir, 'operation-effect-gateway.js')
  const operationSnapshot = await importModule(outDir, 'operation-snapshot.js')
  const snapshotStore = await importModule(outDir, 'task-snapshot.js')
  const taskRun = await importModule(outDir, 'task-run.js')
  const registryModule = await importModule(outDir, 'task-runtime-registry.js')
  const effectRuntime = await importModule(outDir, 'effect-runtime.js')
  const reconciler = await importModule(outDir, 'effect-reconciler.js')
  const ledger = await importModule(outDir, 'effect-ledger.js')
  const pullRequest = await importModule(outDir, 'pull-request-effect.js')
  const worktrees = await importModule(outDir, 'worktrees.js')
  const managedWorktreeEffect = await importModule(outDir, 'managed-worktree-effect.js')
  const worktreeHandlers = await importModule(outDir, 'worktree-operation-handlers.js')
  const gitHelper = await importModule(outDir, 'git-helper.js')
  const gitDiff = await importModule(outDir, 'gitDiff.js')

  await operationGatewayCases({ gateway, operationSnapshot, snapshotStore, taskRun, registryModule, effectRuntime })
  await sourceOperationQueueCases({ gateway })
  await preparedOperationBarrierCases({
    gateway,
    operationSnapshot,
    snapshotStore,
    taskRun,
    registryModule,
    effectRuntime
  })
  await codeForgeContractEffectCases({ effectRuntime, taskRun, registryModule })
  await rendererCommitCases({ gateway, snapshotStore, gitHelper })
  await runManagedWorktreeOperationChecks({
    tempRoot,
    userData,
    gateway,
    snapshotStore,
    effectRuntime,
    worktrees,
    managedWorktreeEffect,
    worktreeHandlers,
    git,
    initRepo
  })
  hunkPathSafetyCases({ gitDiff })
  await discardHunkCases({ gateway, snapshotStore, reconciler, ledger, taskRun, gitDiff })
  await discardHunkCrashRecoveryCase(outDir)
  await worktreePatchCases({ reconciler, ledger, taskRun })
  await pullRequestCases({ pullRequest, reconciler, ledger, taskRun })

  console.log('operation effect gateway e2e: PASS')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

async function operationGatewayCases({ gateway, operationSnapshot, snapshotStore, taskRun, registryModule, effectRuntime }) {
  const project = path.join(tempRoot, 'gateway-project')
  mkdirSync(project, { recursive: true })
  const file = path.join(project, 'state.txt')
  writeFileSync(file, 'before\n', 'utf8')

  const chatRun = taskRun.createTaskRun({ id: 'chat-run', sessionId: 'chat-session', taskId: 'chat-task' })
  registryModule.taskRuntimeRegistry.set('chat-session', chatRun)
  let callbackCount = 0
  const completed = await gateway.executeInteractiveOperationEffect({
    operationId: 'write-success',
    kind: 'file_write',
    title: 'durable write probe',
    sourceSessionId: 'chat-session',
    cwd: project,
    toolName: 'write_file',
    toolInput: { path: 'state.txt', content: 'after\n' },
    execute: async (effect) => {
      callbackCount += 1
      const snapshot = await snapshotStore.getTaskSnapshot(effect.sessionId)
      assert(snapshot, 'operation snapshot must exist when callback starts')
      const persisted = snapshot.run.effects.find((item) => item.id === effect.id)
      assertEqual(persisted?.status, 'executing', 'callback must start after durable executing barrier')
      assertEqual(snapshot.run.operation?.source, 'renderer', 'omitted source must default to renderer')
      assertEqual(snapshot.run.operation?.sourceSessionId, 'chat-session')
      assert(gateway.isInteractiveOperationActive(snapshot), 'operation must stay active during callback')
      const hidden = await gateway.settleStoppedInteractiveOperationSnapshot(snapshot)
      assertEqual(hidden, null, 'active operation should be hidden from recovery reconciliation')
      assert(await snapshotStore.getTaskSnapshot(effect.sessionId), 'active refresh must not delete snapshot')
      writeFileSync(file, 'after\n', 'utf8')
      return { ok: true }
    },
    isSuccess: (result) => result.ok
  })
  assertEqual(completed.status, 'completed')
  assertEqual(callbackCount, 1)
  assertEqual(readFileSync(file, 'utf8'), 'after\n')
  assertEqual(await snapshotStore.getTaskSnapshot('operation:write-success'), null)
  assertEqual(registryModule.taskRuntimeRegistry.get('chat-session')?.id, 'chat-run')
  const terminalRuns = await snapshotStore.listTaskRuns('operation:write-success')
  assertEqual(terminalRuns[0]?.status, 'completed', 'terminal operation run should remain auditable')

  for (const source of ['dag', 'session_lifecycle']) {
    const content = `${source}\n`
    const sourced = await gateway.executeInteractiveOperationEffect({
      operationId: `write-${source}`,
      source,
      kind: 'file_write',
      title: `${source} durable write probe`,
      sourceSessionId: `${source}-source`,
      cwd: project,
      toolName: 'write_file',
      toolInput: { path: 'state.txt', content },
      execute: async (effect) => {
        const snapshot = await snapshotStore.getTaskSnapshot(effect.sessionId)
        assert(snapshot, `${source} operation snapshot must cross the durable barrier`)
        assertEqual(snapshot.run.operation?.source, source)
        assert(gateway.isInteractiveOperationSnapshot(snapshot), `${source} must use operation-only recovery`)
        assertEqual(
          snapshot.run.effects.find((item) => item.id === effect.id)?.status,
          'executing',
          `${source} callback must start only after the executing barrier`
        )
        writeFileSync(file, content, 'utf8')
        return { ok: true }
      },
      isSuccess: (result) => result.ok
    })
    assertEqual(sourced.status, 'completed')
    assertEqual(await snapshotStore.getTaskSnapshot(`operation:write-${source}`), null)
    const [terminal] = await snapshotStore.listTaskRuns(`operation:write-${source}`)
    assertEqual(terminal?.operation?.source, source, `${source} must remain auditable after settlement`)
  }

  writeFileSync(file, 'before\n', 'utf8')
  const waiting = await gateway.executeInteractiveOperationEffect({
    operationId: 'write-unknown',
    kind: 'file_write',
    title: 'unknown write probe',
    sourceSessionId: 'chat-session',
    cwd: project,
    toolName: 'write_file',
    toolInput: { path: 'state.txt', content: 'expected\n' },
    execute: () => {
      writeFileSync(file, 'unexpected\n', 'utf8')
      return { ok: false, error: 'executor lost its acknowledgement' }
    },
    isSuccess: (result) => result.ok
  })
  assertEqual(waiting.status, 'waiting_reconciliation')
  const waitingSnapshot = await snapshotStore.getTaskSnapshot(waiting.snapshotId)
  assert(waitingSnapshot, 'unknown result must retain a recovery snapshot')
  const waitingEffect = waitingSnapshot.run.effects.find((item) => item.id === waiting.effectId)
  assertEqual(waitingEffect?.status, 'waiting_reconciliation')
  await effectRuntime.resolvePersistedTaskEffect(
    waitingSnapshot.id,
    waiting.effectId,
    waitingEffect.revision,
    'confirmed_not_applied'
  )
  const manuallyResolved = await snapshotStore.getTaskSnapshot(waitingSnapshot.id)
  const settled = await operationSnapshot.reconcileInteractiveOperationSnapshot(manuallyResolved)
  assertEqual(settled, null)
  assertEqual(await snapshotStore.getTaskSnapshot(waitingSnapshot.id), null)
}

async function codeForgeContractEffectCases({ effectRuntime, taskRun, registryModule }) {
  const project = path.join(tempRoot, 'code-forge-contract-project')
  mkdirSync(project, { recursive: true })
  const rejectedInputs = [
    { mode: 'commit' },
    { mode: 'pr' },
    { mode: 'report', verificationCommand: 'echo forbidden' },
    { mode: 'patch', verificationCommands: ['echo forbidden'] }
  ]

  for (const [index, toolInput] of rejectedInputs.entries()) {
    const sessionId = `code-forge-contract-${index}`
    registryModule.taskRuntimeRegistry.set(
      sessionId,
      taskRun.createTaskRun({ sessionId, taskId: `${sessionId}-task` })
    )
    let message = ''
    try {
      await effectRuntime.prepareEffectExecution({
        sessionId,
        cwd: project,
        toolUseId: `${sessionId}-tool`,
        toolName: 'code_forge_delivery',
        toolInput
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    assert(
      message.includes('Effect descriptor 创建前阻止'),
      'legacy Code Forge input must fail before Effect creation'
    )
    assertEqual(
      registryModule.taskRuntimeRegistry.get(sessionId)?.effects?.length ?? 0,
      0,
      'rejected Code Forge input must not create a durable opaque Effect'
    )
  }
}

async function sourceOperationQueueCases({ gateway }) {
  const project = path.join(tempRoot, 'source-operation-queue')
  mkdirSync(project, { recursive: true })
  const firstGate = deferred()
  const firstStarted = deferred()
  let secondStarted = false
  const first = queuedWrite('fifo-first', 'fifo-session', 'first.txt', firstStarted, firstGate)
  await firstStarted.promise
  const second = queuedWrite('fifo-second', 'fifo-session', 'second.txt', {
    resolve: () => { secondStarted = true }
  })
  await new Promise((resolve) => setTimeout(resolve, 40))
  assertEqual(secondStarted, false, 'same sourceSessionId callback must wait for the active operation')
  firstGate.resolve()
  const [firstResult, secondResult] = await Promise.all([first, second])
  assertEqual(firstResult.status, 'completed')
  assertEqual(secondResult.status, 'completed')
  assert(secondStarted, 'same-session second callback must run after the first settles')

  const crossGate = deferred()
  const crossStarted = deferred()
  const otherStarted = deferred()
  const blocked = queuedWrite('parallel-blocked', 'parallel-a', 'parallel-a.txt', crossStarted, crossGate)
  await crossStarted.promise
  const other = queuedWrite('parallel-other', 'parallel-b', 'parallel-b.txt', otherStarted)
  const startedConcurrently = await resolvesWithin(otherStarted.promise, 2_000)
  crossGate.resolve()
  const [blockedResult, otherResult] = await Promise.all([blocked, other])
  assert(startedConcurrently, 'different sourceSessionId operations must remain concurrent')
  assertEqual(blockedResult.status, 'completed')
  assertEqual(otherResult.status, 'completed')

  function queuedWrite(operationId, sourceSessionId, relativePath, started, gate) {
    const content = `${operationId}\n`
    return gateway.executeInteractiveOperationEffect({
      operationId,
      kind: 'file_write',
      title: operationId,
      sourceSessionId,
      cwd: project,
      toolName: 'write_file',
      toolInput: { path: relativePath, content },
      execute: async () => {
        started.resolve()
        if (gate) await gate.promise
        writeFileSync(path.join(project, relativePath), content, 'utf8')
        return { ok: true }
      },
      isSuccess: (result) => result.ok
    })
  }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function resolvesWithin(promise, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function preparedOperationBarrierCases({
  gateway,
  operationSnapshot,
  snapshotStore,
  taskRun,
  registryModule,
  effectRuntime
}) {
  const project = path.join(tempRoot, 'prepared-operation-project')
  mkdirSync(project, { recursive: true })
  const file = path.join(project, 'prepared.txt')
  writeFileSync(file, 'unchanged\n', 'utf8')

  for (const source of ['renderer', 'dag', 'session_lifecycle']) {
    const scopeId = `operation:prepared-${source}`
    const now = Date.now()
    const operation = {
      schemaVersion: 1,
      operationId: `prepared-${source}`,
      source,
      kind: 'file_write',
      sourceSessionId: `prepared-source-${source}`,
      title: `${source} prepared barrier`
    }
    const run = taskRun.transitionTaskRun(
      taskRun.createTaskRun({ id: scopeId, sessionId: scopeId, taskId: operation.operationId, operation, now }),
      'executing',
      { now }
    )
    const meta = {
      id: scopeId,
      title: operation.title,
      cwd: project,
      model: '',
      providerId: '',
      permissionMode: 'default',
      status: 'running',
      costUsd: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      contextTokens: 0,
      createdAt: now
    }
    await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
      meta,
      transcript: [],
      lastSeq: 0,
      eventCount: 0,
      reason: 'important-event',
      run,
      now
    }))
    registryModule.taskRuntimeRegistry.set(scopeId, run)
    const handle = await effectRuntime.prepareEffectExecution({
      sessionId: scopeId,
      cwd: project,
      toolUseId: `${scopeId}:effect:0`,
      toolName: 'write_file',
      toolInput: { path: 'prepared.txt', content: `${source}\n` }
    })
    assert(handle, `${source} must prepare a side effect`)
    const prepared = await snapshotStore.getTaskSnapshot(scopeId)
    assertEqual(prepared.run.effects[0]?.status, 'prepared')
    let agentRecoveryRejected = false
    try {
      operationSnapshot.assertAgentRecoverySnapshot(prepared)
    } catch {
      agentRecoveryRejected = true
    }
    assert(agentRecoveryRejected, `${source} operation must never enter Agent recovery`)
    const reconciled = await effectRuntime.reconcilePersistedTaskSnapshot(prepared)
    assertEqual(
      reconciled.run.effects[0]?.status,
      'abandoned',
      `${source} prepared operation must be proven not started after process stop`
    )
    assertEqual(readFileSync(file, 'utf8'), 'unchanged\n', 'prepared barrier test must not execute callback')
    assertEqual(await gateway.settleStoppedInteractiveOperationSnapshot(reconciled), null)
  }
}

async function rendererCommitCases({ gateway, snapshotStore, gitHelper }) {
  const repo = path.join(tempRoot, 'renderer-commit-repo')
  initRepo(repo)
  writeFileSync(path.join(repo, 'app.txt'), 'base\n', 'utf8')
  git(repo, ['add', 'app.txt'])
  git(repo, ['commit', '-m', 'base'])
  const preHead = git(repo, ['rev-parse', 'HEAD']).trim()
  writeFileSync(path.join(repo, 'app.txt'), 'base\nrenderer\n', 'utf8')
  git(repo, ['add', 'app.txt'])

  const outcome = await gateway.executeInteractiveOperationEffect({
    operationId: 'renderer-commit-ack-loss',
    kind: 'git_commit',
    title: 'Renderer commit probe',
    sourceSessionId: 'renderer-commit-source',
    cwd: repo,
    toolName: 'git_commit',
    toolInput: { message: 'renderer commit' },
    execute: (effect) => {
      assertEqual(effect.target.kind, 'git_commit')
      const committed = gitHelper.gitCommit(repo, 'renderer commit')
      assert(committed.ok, JSON.stringify(committed))
      return { ok: false, error: 'simulated lost acknowledgement' }
    },
    isSuccess: (result) => result.ok
  })

  assertEqual(outcome.status, 'completed', 'unique commit reconciliation must recover a lost acknowledgement')
  const head = git(repo, ['rev-parse', 'HEAD']).trim()
  assert(head !== preHead, 'Renderer commit must advance HEAD')
  assertEqual(git(repo, ['show', '-s', '--format=%s', head]).trim(), 'renderer commit')
  assertEqual(await snapshotStore.getTaskSnapshot('operation:renderer-commit-ack-loss'), null)
}

function hunkPathSafetyCases({ gitDiff }) {
  const repo = path.join(tempRoot, 'hunk-path-repo')
  initRepo(repo)
  writeFileSync(path.join(repo, 'a.txt'), 'a0\n', 'utf8')
  writeFileSync(path.join(repo, 'b.txt'), 'b0\n', 'utf8')
  git(repo, ['add', 'a.txt', 'b.txt'])
  git(repo, ['commit', '-m', 'base'])
  writeFileSync(path.join(repo, 'a.txt'), 'a0\na1\n', 'utf8')
  writeFileSync(path.join(repo, 'b.txt'), 'b0\nb1\n', 'utf8')
  const aPatch = git(repo, ['diff', '--binary', '--', 'a.txt'])
  const combinedPatch = git(repo, ['diff', '--binary', '--', 'a.txt', 'b.txt'])

  const mismatch = gitDiff.applyHunk(repo, 'b.txt', aPatch)
  assertEqual(mismatch.ok, false, 'declared and actual hunk paths must match')
  assertEqual(git(repo, ['diff', '--cached', '--name-only']).trim(), '')
  const multiple = gitDiff.applyHunk(repo, 'a.txt', combinedPatch)
  assertEqual(multiple.ok, false, 'multi-file hunk patches must fail closed')
  const accepted = gitDiff.applyHunk(repo, 'a.txt', aPatch)
  assertEqual(accepted.ok, true, JSON.stringify(accepted))
  assertEqual(git(repo, ['diff', '--cached', '--name-only']).trim(), 'a.txt')
}

async function discardHunkCases({ gateway, snapshotStore, reconciler, ledger, taskRun, gitDiff }) {
  const repo = path.join(tempRoot, 'discard-hunk-repo')
  initRepo(repo)
  const originalLines = Array.from({ length: 24 }, (_, index) => `line-${index + 1}`)
  writeFileSync(path.join(repo, 'two-hunks.txt'), `${originalLines.join('\n')}\n`, 'utf8')
  writeFileSync(path.join(repo, 'probe.txt'), 'probe-base\n', 'utf8')
  writeFileSync(path.join(repo, 'drift.txt'), 'drift-base\n', 'utf8')
  git(repo, ['add', 'two-hunks.txt', 'probe.txt', 'drift.txt'])
  git(repo, ['commit', '-m', 'base'])

  const modifiedLines = [...originalLines]
  modifiedLines[1] = 'line-2 changed'
  modifiedLines[21] = 'line-22 changed'
  writeFileSync(path.join(repo, 'two-hunks.txt'), `${modifiedLines.join('\n')}\n`, 'utf8')
  const diff = gitDiff.getWorkspaceDiff(repo)
  const file = diff.files.find((item) => item.newPath === 'two-hunks.txt')
  assert(file && file.hunks.length === 2, 'discard fixture must produce two independent hunks')
  const firstPatch = file.hunks[0].patch
  assert(firstPatch, 'discard fixture must expose the first hunk patch')
  const descriptor = await reconciler.buildEffectDescriptor({
    toolName: 'workspace_discard_hunk',
    cwd: repo,
    toolInput: { filePath: 'two-hunks.txt', hunkPatch: firstPatch }
  })
  assertEqual(descriptor.target.kind, 'file_content')
  assertEqual(descriptor.target.expectedState, 'file')

  const outcome = await gateway.executeInteractiveOperationEffect({
    operationId: 'discard-hunk-ack-loss',
    kind: 'workspace_hunk_discard',
    title: 'discard hunk probe',
    sourceSessionId: 'discard-source',
    cwd: repo,
    toolName: 'workspace_discard_hunk',
    toolInput: { filePath: 'two-hunks.txt', hunkPatch: firstPatch },
    execute: () => {
      const result = gitDiff.applyHunk(repo, 'two-hunks.txt', firstPatch, { reverse: true })
      assert(result.ok, JSON.stringify(result))
      return { ok: false, error: 'simulated lost acknowledgement' }
    },
    isSuccess: (result) => result.ok
  })
  assertEqual(outcome.status, 'completed', 'discard reconciliation must recover a lost acknowledgement')
  const content = readFileSync(path.join(repo, 'two-hunks.txt'), 'utf8')
  assert(content.includes('line-2\n'), 'selected hunk must return to its base content')
  assert(content.includes('line-22 changed'), 'unselected hunk must remain in the worktree')
  assertEqual(await snapshotStore.getTaskSnapshot('operation:discard-hunk-ack-loss'), null)

  await discardReconciliationCases({ repo, reconciler, ledger, taskRun, gitDiff })
  await discardUntrackedFileCase({ repo, gateway, snapshotStore, reconciler, gitDiff })
  await discardTextEdgeCases({ gateway, reconciler, gitDiff })
}

async function discardReconciliationCases({ repo, reconciler, ledger, taskRun, gitDiff }) {
  writeFileSync(path.join(repo, 'probe.txt'), 'probe-base\nprobe-change\n', 'utf8')
  const patch = git(repo, ['diff', '--binary', '--', 'probe.txt'])
  const descriptor = await reconciler.buildEffectDescriptor({
    toolName: 'workspace_discard_hunk',
    cwd: repo,
    toolInput: { filePath: 'probe.txt', hunkPatch: patch }
  })
  const run = taskRun.createTaskRun({ sessionId: 'discard-probe-session', taskId: 'discard-probe-task' })
  const prepared = ledger.prepareEffect(run, {
    sessionId: run.sessionId,
    cwd: repo,
    toolUseId: 'discard-probe-effect',
    toolName: 'workspace_discard_hunk',
    descriptor,
    ownerId: 'discard-probe'
  })
  assertEqual((await reconciler.reconcileEffect(prepared.run.effects[0])).kind, 'not_applied')
  const applied = gitDiff.applyHunk(repo, 'probe.txt', patch, { reverse: true })
  assert(applied.ok, JSON.stringify(applied))
  assertEqual((await reconciler.reconcileEffect(prepared.run.effects[0])).kind, 'confirmed')

  writeFileSync(path.join(repo, 'drift.txt'), 'drift-base\ndrift-change\n', 'utf8')
  const driftPatch = git(repo, ['diff', '--binary', '--', 'drift.txt'])
  const driftDescriptor = await reconciler.buildEffectDescriptor({
    toolName: 'workspace_discard_hunk',
    cwd: repo,
    toolInput: { filePath: 'drift.txt', hunkPatch: driftPatch }
  })
  const driftRun = taskRun.createTaskRun({ sessionId: 'discard-drift-session', taskId: 'discard-drift-task' })
  const driftPrepared = ledger.prepareEffect(driftRun, {
    sessionId: driftRun.sessionId,
    cwd: repo,
    toolUseId: 'discard-drift-effect',
    toolName: 'workspace_discard_hunk',
    descriptor: driftDescriptor,
    ownerId: 'discard-drift'
  })
  writeFileSync(path.join(repo, 'drift.txt'), 'third-content\n', 'utf8')
  assertEqual((await reconciler.reconcileEffect(driftPrepared.run.effects[0])).kind, 'unresolved')
}

async function discardUntrackedFileCase({ repo, gateway, snapshotStore, reconciler, gitDiff }) {
  writeFileSync(path.join(repo, 'untracked.txt'), 'temporary\n', 'utf8')
  const diff = gitDiff.getWorkspaceDiff(repo)
  const file = diff.files.find((item) => item.newPath === 'untracked.txt')
  const patch = file?.hunks[0]?.patch
  assert(patch, 'untracked file must expose a discardable hunk')
  const descriptor = await reconciler.buildEffectDescriptor({
    toolName: 'workspace_discard_hunk',
    cwd: repo,
    toolInput: { filePath: 'untracked.txt', hunkPatch: patch }
  })
  assertEqual(descriptor.target.kind, 'file_content')
  assertEqual(descriptor.target.expectedState, 'absent')
  const outcome = await gateway.executeInteractiveOperationEffect({
    operationId: 'discard-untracked-file',
    kind: 'workspace_hunk_discard',
    title: 'discard untracked file',
    sourceSessionId: 'discard-source',
    cwd: repo,
    toolName: 'workspace_discard_hunk',
    toolInput: { filePath: 'untracked.txt', hunkPatch: patch },
    execute: () => gitDiff.applyHunk(repo, 'untracked.txt', patch, { reverse: true }),
    isSuccess: (result) => result.ok
  })
  assertEqual(outcome.status, 'completed')
  assertEqual(existsSync(path.join(repo, 'untracked.txt')), false)
  assertEqual(await snapshotStore.getTaskSnapshot('operation:discard-untracked-file'), null)
}

async function discardTextEdgeCases({ gateway, reconciler, gitDiff }) {
  const repo = path.join(tempRoot, 'discard-text-edge-repo')
  initRepo(repo)
  writeFileSync(path.join(repo, 'tracked-crlf.txt'), Buffer.from('base\r\n'))
  git(repo, ['add', 'tracked-crlf.txt'])
  git(repo, ['commit', '-m', 'base'])
  writeFileSync(path.join(repo, 'tracked-crlf.txt'), Buffer.from('base\r\nchange\r\n'))
  await discardVisibleHunk({
    repo,
    filePath: 'tracked-crlf.txt',
    expected: Buffer.from('base\r\n'),
    operationId: 'discard-tracked-crlf',
    gateway,
    reconciler,
    gitDiff
  })
  for (const fixture of [
    { filePath: 'untracked-crlf.txt', content: Buffer.from('temporary\r\n') },
    { filePath: 'untracked-no-eol.txt', content: Buffer.from('temporary') }
  ]) {
    writeFileSync(path.join(repo, fixture.filePath), fixture.content)
    await discardVisibleHunk({
      repo,
      filePath: fixture.filePath,
      expected: undefined,
      operationId: `discard-${fixture.filePath.replaceAll('.', '-')}`,
      gateway,
      reconciler,
      gitDiff
    })
  }
  writeFileSync(path.join(repo, 'empty.txt'), Buffer.alloc(0))
  const empty = gitDiff.getWorkspaceDiff(repo).files.find((item) => item.newPath === 'empty.txt')
  assert(empty && empty.hunks.length === 0, 'empty untracked files must not expose a corrupt synthetic hunk')
  writeFileSync(path.join(repo, 'invalid-utf8.txt'), Buffer.from([0xff, 0xfe]))
  const binary = gitDiff.getWorkspaceDiff(repo).files.find((item) => item.newPath === 'invalid-utf8.txt')
  assert(binary?.binary === true && binary.hunks.length === 0, 'invalid UTF-8 must stay on the binary path')
}

async function discardVisibleHunk({ repo, filePath, expected, operationId, gateway, reconciler, gitDiff }) {
  const file = gitDiff.getWorkspaceDiff(repo).files.find((item) => item.newPath === filePath)
  const patch = file?.hunks[0]?.patch
  assert(patch, `${filePath} must expose a discardable hunk`)
  assert(file.hunks.every((hunk) => hunk.lines.every((line) => !line.text.endsWith('\r'))))
  const descriptor = await reconciler.buildEffectDescriptor({
    toolName: 'workspace_discard_hunk',
    cwd: repo,
    toolInput: { filePath, hunkPatch: patch }
  })
  assertEqual(descriptor.target.kind, 'file_content')
  assertEqual(descriptor.target.expectedState, expected === undefined ? 'absent' : 'file')
  const outcome = await gateway.executeInteractiveOperationEffect({
    operationId,
    kind: 'workspace_hunk_discard',
    title: `discard ${filePath}`,
    sourceSessionId: 'discard-edge-source',
    cwd: repo,
    toolName: 'workspace_discard_hunk',
    toolInput: { filePath, hunkPatch: patch },
    execute: () => gitDiff.applyHunk(repo, filePath, patch, { reverse: true }),
    isSuccess: (result) => result.ok
  })
  assertEqual(outcome.status, 'completed')
  if (expected === undefined) assertEqual(existsSync(path.join(repo, filePath)), false)
  else assert(readFileSync(path.join(repo, filePath)).equals(expected), `${filePath} content must remain byte exact`)
}

async function discardHunkCrashRecoveryCase(outDir) {
  const repo = path.join(tempRoot, 'discard-crash-repo')
  const crashUserData = path.join(tempRoot, 'discard-crash-user-data')
  const patchFile = path.join(tempRoot, 'discard-crash.patch')
  const markerFile = path.join(tempRoot, 'discard-crash-count.txt')
  const workerFile = path.join(tempRoot, 'discard-crash-worker.mjs')
  initRepo(repo)
  mkdirSync(crashUserData, { recursive: true })
  writeFileSync(path.join(repo, 'state.txt'), 'base\n', 'utf8')
  git(repo, ['add', 'state.txt'])
  git(repo, ['commit', '-m', 'base'])
  writeFileSync(path.join(repo, 'state.txt'), 'base\nchange\n', 'utf8')
  writeFileSync(patchFile, git(repo, ['diff', '--binary', '--', 'state.txt']), 'utf8')
  writeFileSync(workerFile, discardCrashWorkerSource(outDir), 'utf8')
  const baseEnv = {
    ...process.env,
    CAOGEN_TEST_USER_DATA: crashUserData,
    DISCARD_CRASH_REPO: repo,
    DISCARD_CRASH_PATCH: patchFile,
    DISCARD_CRASH_MARKER: markerFile
  }
  const crashed = await forkWorkerForMessage(workerFile, { ...baseEnv, DISCARD_CRASH_PHASE: 'crash' }, true)
  assertEqual(crashed.phase, 'executed')
  assertEqual(readFileSync(path.join(repo, 'state.txt'), 'utf8'), 'base\n')
  assertEqual(readFileSync(markerFile, 'utf8'), 'executed\n')
  const resumed = await forkWorkerForMessage(workerFile, { ...baseEnv, DISCARD_CRASH_PHASE: 'resume' }, false)
  assertEqual(resumed.probeKind, 'confirmed')
  assertEqual(resumed.effectStatus, 'confirmed')
  assertEqual(resumed.snapshotCleared, true)
  assertEqual(readFileSync(markerFile, 'utf8'), 'executed\n', 'restart must not replay the discard mutation')
}

function discardCrashWorkerSource(outDir) {
  const moduleUrl = (name) => pathToFileURL(findCompiledModule(outDir, name)).href
  return `
import { appendFileSync, readFileSync } from 'node:fs'
const gateway = await import(${JSON.stringify(moduleUrl('operation-effect-gateway.js'))})
const gitDiff = await import(${JSON.stringify(moduleUrl('gitDiff.js'))})
const snapshotStore = await import(${JSON.stringify(moduleUrl('task-snapshot.js'))})
const effectRuntime = await import(${JSON.stringify(moduleUrl('effect-runtime.js'))})
const reconciler = await import(${JSON.stringify(moduleUrl('effect-reconciler.js'))})
const repo = process.env.DISCARD_CRASH_REPO
const patch = readFileSync(process.env.DISCARD_CRASH_PATCH, 'utf8')
const toolInput = { filePath: 'state.txt', hunkPatch: patch }
if (process.env.DISCARD_CRASH_PHASE === 'crash') {
  await gateway.executeInteractiveOperationEffect({
    operationId: 'discard-crash',
    kind: 'workspace_hunk_discard',
    title: 'discard crash probe',
    sourceSessionId: 'discard-crash-source',
    cwd: repo,
    toolName: 'workspace_discard_hunk',
    toolInput,
    execute: () => {
      const result = gitDiff.applyHunk(repo, 'state.txt', patch, { reverse: true })
      if (!result.ok) throw new Error(result.error)
      appendFileSync(process.env.DISCARD_CRASH_MARKER, 'executed\\n', 'utf8')
      process.send?.({ phase: 'executed' })
      setInterval(() => undefined, 1_000)
      return new Promise(() => {})
    },
    isSuccess: (result) => result.ok
  })
} else {
  const snapshot = await snapshotStore.getTaskSnapshot('operation:discard-crash')
  if (!snapshot?.run) throw new Error('discard crash snapshot missing')
  const probe = await reconciler.reconcileEffect(snapshot.run.effects[0])
  const reconciled = await effectRuntime.reconcilePersistedTaskSnapshot(snapshot)
  const effect = reconciled.run.effects[0]
  await gateway.settleStoppedInteractiveOperationSnapshot(reconciled)
  const remaining = await snapshotStore.getTaskSnapshot('operation:discard-crash')
  process.send?.({
    phase: 'resumed',
    probeKind: probe.kind,
    effectStatus: effect.status,
    snapshotCleared: remaining === null
  })
}
`
}

function forkWorkerForMessage(workerFile, env, killAfterMessage) {
  return new Promise((resolve, reject) => {
    const child = fork(workerFile, [], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`discard crash worker timed out: ${env.DISCARD_CRASH_PHASE}`))
    }, 30_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('message', (message) => {
      clearTimeout(timer)
      if (!killAfterMessage) {
        resolve(message)
        return
      }
      child.once('exit', () => resolve(message))
      child.kill('SIGKILL')
    })
    child.once('exit', (code, signal) => {
      if (killAfterMessage || code === 0) return
      clearTimeout(timer)
      reject(new Error(`discard crash worker exited before result: code=${code} signal=${signal}`))
    })
  })
}

async function worktreePatchCases({ reconciler, ledger, taskRun }) {
  const repo = path.join(tempRoot, 'patch-repo')
  const worktree = path.join(tempRoot, 'patch-worktree')
  const patchFile = path.join(tempRoot, 'frozen.patch')
  initRepo(repo)
  writeFileSync(path.join(repo, 'app.txt'), 'base\n', 'utf8')
  git(repo, ['add', 'app.txt'])
  git(repo, ['commit', '-m', 'base'])
  const baseSha = git(repo, ['rev-parse', 'HEAD']).trim()
  git(repo, ['worktree', 'add', '-b', 'feature', worktree, baseSha])
  writeFileSync(path.join(worktree, 'app.txt'), 'base\nfeature\n', 'utf8')
  const patchText = git(worktree, ['diff', '--binary', '--full-index', baseSha, '--'])
  writeFileSync(patchFile, patchText.endsWith('\n') ? patchText : `${patchText}\n`, 'utf8')
  const descriptor = await reconciler.buildEffectDescriptor({
    toolName: 'worktree_patch_apply',
    cwd: repo,
    toolInput: {
      repoRoot: repo,
      worktreePath: worktree,
      baseSha,
      headSha: baseSha,
      patchPath: patchFile
    }
  })
  assertEqual(descriptor.target.kind, 'worktree_patch_apply')
  assert(descriptor.target.changedPaths.includes('app.txt'))
  const run = taskRun.createTaskRun({ sessionId: 'patch-session', taskId: 'patch-task' })
  const prepared = ledger.prepareEffect(run, {
    sessionId: run.sessionId,
    cwd: repo,
    toolUseId: 'patch-effect',
    toolName: 'worktree_patch_apply',
    descriptor,
    ownerId: 'patch-test'
  })
  const before = await reconciler.reconcileEffect(prepared.run.effects[0])
  assertEqual(before.kind, 'not_applied')
  execFileSync('git', ['-C', repo, 'apply', '--whitespace=nowarn', patchFile])
  const after = await reconciler.reconcileEffect(prepared.run.effects[0])
  assertEqual(after.kind, 'confirmed')

  const reverseDescriptor = await reconciler.buildEffectDescriptor({
    toolName: 'worktree_patch_apply',
    cwd: repo,
    toolInput: {
      repoRoot: repo,
      worktreePath: worktree,
      baseSha,
      headSha: baseSha,
      patchPath: patchFile,
      direction: 'reverse'
    }
  })
  assertEqual(reverseDescriptor.target.kind, 'worktree_patch_apply')
  assertEqual(reverseDescriptor.target.mode, 'reverse')
  assertEqual(reverseDescriptor.target.changedPaths.join(','), descriptor.target.changedPaths.join(','))
  const reverseRun = taskRun.createTaskRun({ sessionId: 'reverse-patch-session', taskId: 'reverse-patch-task' })
  const reversePrepared = ledger.prepareEffect(reverseRun, {
    sessionId: reverseRun.sessionId,
    cwd: repo,
    toolUseId: 'reverse-patch-effect',
    toolName: 'worktree_patch_apply',
    descriptor: reverseDescriptor,
    ownerId: 'reverse-patch-test'
  })
  const beforeReverse = await reconciler.reconcileEffect(reversePrepared.run.effects[0])
  assertEqual(beforeReverse.kind, 'not_applied')
  execFileSync('git', ['-C', repo, 'apply', '-R', '--whitespace=nowarn', patchFile])
  const afterReverse = await reconciler.reconcileEffect(reversePrepared.run.effects[0])
  assertEqual(afterReverse.kind, 'confirmed')
}

async function pullRequestCases({ pullRequest, reconciler, ledger, taskRun }) {
  const repo = path.join(tempRoot, 'pr-repo')
  initRepo(repo)
  writeFileSync(path.join(repo, 'README.md'), 'PR test\n', 'utf8')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-m', 'base'])
  git(repo, ['switch', '-c', 'feature'])
  writeFileSync(path.join(repo, 'feature.txt'), 'feature\n', 'utf8')
  git(repo, ['add', 'feature.txt'])
  git(repo, ['commit', '-m', 'feature'])
  const sourceSha = git(repo, ['rev-parse', 'HEAD']).trim()
  git(repo, ['remote', 'add', 'origin', 'git@github.com:owner/project.git'])

  const fakeBin = path.join(tempRoot, 'fake-bin')
  const stateFile = path.join(tempRoot, 'fake-pr-state.json')
  const countFile = path.join(tempRoot, 'fake-pr-count.txt')
  mkdirSync(fakeBin, { recursive: true })
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  writeExecutable(
    path.join(fakeBin, 'git'),
    `#!/bin/sh\nlast=\nseen=0\nfor arg in "$@"\ndo\n  [ "$arg" != "ls-remote" ] || seen=1\n  last="$arg"\ndone\nif [ "$seen" = "1" ]\nthen\n  printf '%s\\t%s\\n' "$FAKE_REMOTE_SHA" "$last"\n  exit 0\nfi\nexec ${shellQuote(realGit)} "$@"\n`
  )
  writeExecutable(
    path.join(fakeBin, 'gh'),
    `#!${process.execPath}\n` +
      `const fs=require('fs');const a=process.argv.slice(2);const state=process.env.FAKE_PR_STATE;` +
      `if(a[0]==='pr'&&a[1]==='list'){process.stdout.write(fs.existsSync(state)?fs.readFileSync(state,'utf8'):'[]');process.exit(0)}` +
      `if(a[0]==='pr'&&a[1]==='create'){const get=(n)=>a[a.indexOf(n)+1]||'';` +
      `const r=[{number:1,url:'https://github.com/owner/project/pull/1',state:'OPEN',headRefName:get('--head'),headRefOid:process.env.FAKE_REMOTE_SHA,baseRefName:get('--base'),body:get('--body')}];` +
      `fs.writeFileSync(state,JSON.stringify(r));const c=process.env.FAKE_PR_COUNT;const n=fs.existsSync(c)?Number(fs.readFileSync(c,'utf8')):0;fs.writeFileSync(c,String(n+1));process.stdout.write(r[0].url+'\\n');process.exit(0)}` +
      `process.stderr.write('unexpected gh args '+JSON.stringify(a));process.exit(2)\n`
  )
  const previousPath = process.env.PATH
  process.env.PATH = `${fakeBin}:${previousPath}`
  process.env.FAKE_REMOTE_SHA = sourceSha
  process.env.FAKE_PR_STATE = stateFile
  process.env.FAKE_PR_COUNT = countFile
  try {
    const descriptor = await reconciler.buildEffectDescriptor({
      toolName: 'git_create_pr',
      cwd: repo,
      toolInput: { title: 'Effect PR', body: 'Body', base: 'main' }
    })
    const target = descriptor.target
    assertEqual(target.kind, 'pull_request_create')
    assert(target.marker.startsWith('<!-- caogen-effect:pull-request:v1:'))
    const run = taskRun.createTaskRun({ sessionId: 'pr-session', taskId: 'pr-task' })
    const prepared = ledger.prepareEffect(run, {
      sessionId: run.sessionId,
      cwd: repo,
      toolUseId: 'pr-effect',
      toolName: 'git_create_pr',
      descriptor,
      ownerId: 'pr-test'
    })
    const absent = await reconciler.reconcileEffect(prepared.run.effects[0])
    assertEqual(absent.kind, 'unresolved', 'PR absence must never authorize automatic replay')

    const created = await pullRequest.executePullRequestEffectTarget({
      target,
      title: 'Effect PR',
      body: 'Body'
    })
    assert(created.ok, JSON.stringify(created))
    assertEqual(readFileSync(countFile, 'utf8'), '1')
    const remoteRecords = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert(remoteRecords[0].body.includes(target.marker), 'created PR body must carry exact marker')
    const confirmed = await reconciler.reconcileEffect(prepared.run.effects[0])
    assertEqual(confirmed.kind, 'confirmed')

    const idempotent = await pullRequest.executePullRequestEffectTarget({
      target,
      title: 'Effect PR',
      body: 'Body'
    })
    assert(idempotent.ok && idempotent.existing === true)
    assertEqual(readFileSync(countFile, 'utf8'), '1', 'exact marker retry must not invoke create twice')

    remoteRecords[0].headRefOid = 'f'.repeat(sourceSha.length)
    writeFileSync(stateFile, JSON.stringify(remoteRecords), 'utf8')
    const drifted = await reconciler.reconcileEffect(prepared.run.effects[0])
    assertEqual(drifted.kind, 'confirmed', 'head drift must not erase proof that PR creation happened')
    remoteRecords[0].body = 'marker removed'
    writeFileSync(stateFile, JSON.stringify(remoteRecords), 'utf8')
    const missingMarker = await reconciler.reconcileEffect(prepared.run.effects[0])
    assertEqual(missingMarker.kind, 'unresolved')
  } finally {
    process.env.PATH = previousPath
    delete process.env.FAKE_REMOTE_SHA
    delete process.env.FAKE_PR_STATE
    delete process.env.FAKE_PR_COUNT
  }
}

async function importModule(root, name) {
  return import(pathToFileURL(findCompiledModule(root, name)).href)
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
  return null
}

function initRepo(dir) {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-b', 'main'])
  git(dir, ['config', 'user.email', 'operation@example.test'])
  git(dir, ['config', 'user.name', 'Operation Smoke'])
  git(dir, ['config', 'core.autocrlf', 'false'])
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

function writeExecutable(file, content) {
  writeFileSync(file, content, 'utf8')
  chmodSync(file, 0o755)
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

async function assertRejects(promise, expectedMessage) {
  try {
    await promise
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    assert(message.includes(expectedMessage), `expected rejection containing ${expectedMessage}, got ${message}`)
    return
  }
  throw new Error(`expected rejection containing ${expectedMessage}`)
}
