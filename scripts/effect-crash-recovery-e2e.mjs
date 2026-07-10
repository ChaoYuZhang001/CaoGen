import { execFileSync, fork } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  appendFileSync,
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

const mode = process.argv[2]

if (mode?.startsWith('--worker-')) {
  await runWorker(mode)
} else {
  await runParent()
}

async function runParent() {
  const repoRoot = process.cwd()
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-effect-crash-'))
  const outDir = path.join(tempRoot, 'compiled')
  try {
    execFileSync(
      process.execPath,
      [
        path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
        'src/main/task/effect-runtime.ts',
        'src/main/task/task-run.ts',
        'src/main/task/task-execution.ts',
        'src/main/task/task-snapshot.ts',
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
      'export const app = { getPath: () => process.env.CAOGEN_EFFECT_USER_DATA }\n'
    )
    writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')

    const sameOwnerCase = casePaths(tempRoot, 'same-owner')
    mkdirSync(sameOwnerCase.project, { recursive: true })
    mkdirSync(sameOwnerCase.userData, { recursive: true })
    writeFileSync(path.join(sameOwnerCase.project, 'state.txt'), 'before\n', 'utf8')
    const sameOwner = await forkWorker('--worker-same-owner-negative', outDir, sameOwnerCase, repoRoot)
    assertEqual(sameOwner.type, 'same-owner-negative')
    assertEqual(sameOwner.effectStatus, 'waiting_reconciliation')
    assertEqual(sameOwner.toolStatus, 'unknown_outcome')
    assertEqual(sameOwner.retryEvidenceCount, 0)
    assertEqual(sameOwner.decision, 'deny')

    const targetDriftCase = casePaths(tempRoot, 'target-drift')
    mkdirSync(targetDriftCase.project, { recursive: true })
    mkdirSync(targetDriftCase.userData, { recursive: true })
    writeFileSync(path.join(targetDriftCase.project, 'state.txt'), 'before\n', 'utf8')
    const targetDrift = await forkWorker('--worker-target-drift', outDir, targetDriftCase, repoRoot)
    assertEqual(targetDrift.type, 'target-drift')
    assertEqual(targetDrift.rejected, true)
    assert(targetDrift.error.includes('执行前目标或输入已变化'), 'target drift must invalidate the old approval')
    assertEqual(targetDrift.effectStatus, 'abandoned')
    assertEqual(targetDrift.toolStatus, 'cancelled')
    assertEqual(targetDrift.retryEvidenceCount, 1)
    assertEqual(readFileSync(path.join(targetDriftCase.project, 'state.txt'), 'utf8'), 'concurrent-change\n')

    const emptyCommitCase = casePaths(tempRoot, 'empty-git-commit')
    mkdirSync(emptyCommitCase.project, { recursive: true })
    mkdirSync(emptyCommitCase.userData, { recursive: true })
    initRepo(emptyCommitCase.project)
    writeFileSync(path.join(emptyCommitCase.project, 'tracked.txt'), 'base\n', 'utf8')
    git(emptyCommitCase.project, ['add', 'tracked.txt'])
    git(emptyCommitCase.project, ['commit', '-m', 'base'])
    const emptyCommit = await forkWorker(
      '--worker-empty-git-commit-preflight',
      outDir,
      emptyCommitCase,
      repoRoot
    )
    assertEqual(emptyCommit.type, 'empty-git-commit-preflight')
    assertEqual(emptyCommit.rejected, true)
    assert(emptyCommit.error.includes('没有已暂存的改动'), 'empty index must report a deterministic preflight failure')
    assertEqual(emptyCommit.effectCount, 0)
    assert(emptyCommit.runStatus !== 'waiting_reconciliation', 'empty index must not enter waiting_reconciliation')

    const preparedGitCase = casePaths(tempRoot, 'prepared-git')
    mkdirSync(preparedGitCase.project, { recursive: true })
    mkdirSync(preparedGitCase.userData, { recursive: true })
    initRepo(preparedGitCase.project)
    writeFileSync(path.join(preparedGitCase.project, 'tracked.txt'), 'base\n', 'utf8')
    git(preparedGitCase.project, ['add', 'tracked.txt'])
    git(preparedGitCase.project, ['commit', '-m', 'base'])
    git(preparedGitCase.project, ['remote', 'add', 'origin', 'ssh://example.invalid/repo.git'])
    const sshCommand = path.join(preparedGitCase.project, 'transport-marker.sh')
    writeFileSync(sshCommand, '#!/bin/sh\nprintf "invoked\\n" >> "$CAOGEN_EFFECT_COUNTER"\nexit 91\n', 'utf8')
    chmodSync(sshCommand, 0o755)
    git(preparedGitCase.project, ['config', 'core.sshCommand', sshCommand])
    const preparedGit = await forkWorker('--worker-prepared-git-crash', outDir, preparedGitCase, repoRoot)
    assertEqual(preparedGit.type, 'prepared-git')
    assertEqual(preparedGit.effectStatus, 'prepared')
    const preparedGitResume = await forkWorker('--worker-prepared-git-resume', outDir, preparedGitCase, repoRoot)
    assertEqual(preparedGitResume.type, 'prepared-git-resume')
    assertEqual(preparedGitResume.effectStatus, 'abandoned')
    assertEqual(preparedGitResume.retryEvidenceCount, 1)
    assertEqual(countLines(preparedGitCase.counter), 0)

    const fileCase = casePaths(tempRoot, 'file')
    mkdirSync(fileCase.project, { recursive: true })
    mkdirSync(fileCase.userData, { recursive: true })
    writeFileSync(path.join(fileCase.project, 'state.txt'), 'before\n', 'utf8')
    const fileCrash = await forkWorker('--worker-file-crash', outDir, fileCase, repoRoot)
    assertEqual(fileCrash.type, 'external-committed')
    assert(existsSync(path.join(fileCase.userData, 'task-snapshots.db')), 'effect intent must be durable before external action')
    assertEqual(readFileSync(path.join(fileCase.project, 'state.txt'), 'utf8'), 'after\n')
    const fileResume = await forkWorker('--worker-file-resume', outDir, fileCase, repoRoot)
    assertEqual(fileResume.type, 'reconciled')
    assertEqual(fileResume.effectStatus, 'confirmed')
    assertEqual(fileResume.toolStatus, 'succeeded')
    assertEqual(fileResume.decision, 'ask')
    assertEqual(countLines(fileCase.counter), 1)

    const opaqueCase = casePaths(tempRoot, 'opaque')
    mkdirSync(opaqueCase.project, { recursive: true })
    mkdirSync(opaqueCase.userData, { recursive: true })
    const opaqueCrash = await forkWorker('--worker-opaque-crash', outDir, opaqueCase, repoRoot)
    assertEqual(opaqueCrash.type, 'external-committed')
    const opaqueResume = await forkWorker('--worker-opaque-resume', outDir, opaqueCase, repoRoot)
    assertEqual(opaqueResume.type, 'reconciled')
    assertEqual(opaqueResume.effectStatus, 'waiting_reconciliation')
    assertEqual(opaqueResume.decision, 'deny')
    assertEqual(countLines(opaqueCase.counter), 1)
    const opaqueCas = await forkWorker('--worker-opaque-manual-cas', outDir, opaqueCase, repoRoot)
    assertEqual(opaqueCas.type, 'manual-cas')
    assertEqual(opaqueCas.fulfilled, 1)
    assertEqual(opaqueCas.rejected, 1)
    assert(opaqueCas.staleError.includes('stale_revision'), 'conflicting manual resolution must fail CAS')
    assertEqual(opaqueCas.effectStatus, 'confirmed')
    assertEqual(opaqueCas.manualEvidenceCount, 1)
    assertEqual(opaqueCas.retryEvidenceCount, 0)

    const postconditionCase = casePaths(tempRoot, 'postcondition')
    mkdirSync(postconditionCase.project, { recursive: true })
    mkdirSync(postconditionCase.userData, { recursive: true })
    writeFileSync(path.join(postconditionCase.project, 'state.txt'), 'before\n', 'utf8')
    const postcondition = await forkWorker(
      '--worker-postcondition-mismatch',
      outDir,
      postconditionCase,
      repoRoot
    )
    assertEqual(postcondition.type, 'postcondition-mismatch')
    assertEqual(postcondition.effectStatus, 'waiting_reconciliation')
    assertEqual(postcondition.retryEvidenceCount, 0)
    assertEqual(readFileSync(path.join(postconditionCase.project, 'state.txt'), 'utf8'), 'before\n')

    console.log('effect crash recovery e2e ok')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function runWorker(workerMode) {
  const outDir = requiredEnv('CAOGEN_EFFECT_COMPILED')
  const repoRoot = requiredEnv('CAOGEN_EFFECT_REPO_ROOT')
  const project = requiredEnv('CAOGEN_EFFECT_PROJECT')
  const counter = requiredEnv('CAOGEN_EFFECT_COUNTER')
  const require = createRequire(import.meta.url)
  process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
  require('node:module').Module._initPaths()

  const taskRun = await importModule(outDir, 'task-run.js')
  const taskExecution = await importModule(outDir, 'task-execution.js')
  const snapshotStore = await importModule(outDir, 'task-snapshot.js')
  const effectRuntime = await importModule(outDir, 'effect-runtime.js')
  const registryModule = await importModule(outDir, 'task-runtime-registry.js')

  if (workerMode === '--worker-same-owner-negative') {
    const sessionId = 'same-owner-session'
    const toolUseId = 'same-owner-tool'
    const toolInput = { path: 'state.txt', content: 'after\n' }
    let run = taskRun.createTaskRun({ id: `${sessionId}-run`, sessionId, taskId: sessionId, now: 1000 })
    run = taskExecution.reduceTaskExecutionEvent(
      run,
      { kind: 'user-message', messageId: `${sessionId}-message`, text: 'same process close race' },
      project,
      1010
    )
    run = taskExecution.reduceTaskExecutionEvent(
      run,
      { kind: 'assistant-message', blocks: [{ type: 'tool_use', id: toolUseId, name: 'write_file', input: toolInput }] },
      project,
      1020
    )
    registryModule.taskRuntimeRegistry.set(sessionId, run)
    await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
      meta: meta(sessionId, project),
      transcript: [
        { seq: 1, event: { kind: 'user-message', messageId: `${sessionId}-message`, text: 'same process close race' } },
        { seq: 2, event: { kind: 'assistant-message', blocks: [{ type: 'tool_use', id: toolUseId, name: 'write_file', input: toolInput }] } }
      ],
      lastSeq: 2,
      lastEventKind: 'assistant-message',
      eventCount: 2,
      reason: 'important-event',
      run,
      now: 1030
    }))
    const handle = await effectRuntime.prepareEffectExecution({
      sessionId,
      cwd: project,
      toolUseId,
      toolName: 'write_file',
      toolInput
    })
    await effectRuntime.markEffectExecutionStarted(handle, {
      sessionId,
      cwd: project,
      toolUseId,
      toolName: 'write_file',
      toolInput
    })
    const snapshot = await snapshotStore.getTaskSnapshot(sessionId)
    assert(snapshot?.run, 'same-owner worker requires persisted TaskRun')
    const reconciled = await effectRuntime.reconcileTaskSnapshotEffects(snapshot, { processStopped: true })
    const effect = reconciled.run.effects[0]
    const tool = reconciled.run.toolExecutions[0]
    registryModule.taskRuntimeRegistry.set(sessionId, reconciled.run)
    const decision = registryModule.taskRuntimeRegistry.evaluateTool({
      sessionId,
      cwd: project,
      toolName: 'write_file',
      toolInput,
      toolUseId: 'same-owner-retry'
    }).kind
    process.send?.({
      type: 'same-owner-negative',
      effectStatus: effect.status,
      toolStatus: tool.status,
      retryEvidenceCount: effect.evidence.filter((item) => item.kind === 'retry_authorized').length,
      decision
    })
    return
  }

  if (workerMode === '--worker-target-drift') {
    const sessionId = 'target-drift-session'
    const toolUseId = 'target-drift-tool'
    const toolName = 'write_file'
    const toolInput = { path: 'state.txt', content: 'after\n' }
    let run = taskRun.createTaskRun({ id: `${sessionId}-run`, sessionId, taskId: sessionId, now: 1000 })
    run = taskExecution.reduceTaskExecutionEvent(
      run,
      { kind: 'user-message', messageId: `${sessionId}-message`, text: 'target drift before execution' },
      project,
      1010
    )
    run = taskExecution.reduceTaskExecutionEvent(
      run,
      { kind: 'assistant-message', blocks: [{ type: 'tool_use', id: toolUseId, name: toolName, input: toolInput }] },
      project,
      1020
    )
    registryModule.taskRuntimeRegistry.set(sessionId, run)
    await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
      meta: meta(sessionId, project),
      transcript: [
        { seq: 1, event: { kind: 'user-message', messageId: `${sessionId}-message`, text: 'target drift before execution' } },
        { seq: 2, event: { kind: 'assistant-message', blocks: [{ type: 'tool_use', id: toolUseId, name: toolName, input: toolInput }] } }
      ],
      lastSeq: 2,
      lastEventKind: 'assistant-message',
      eventCount: 2,
      reason: 'important-event',
      run,
      now: 1030
    }))
    const executionInput = { sessionId, cwd: project, toolUseId, toolName, toolInput }
    const handle = await effectRuntime.prepareEffectExecution(executionInput)
    writeFileSync(path.join(project, 'state.txt'), 'concurrent-change\n', 'utf8')
    let error = ''
    try {
      await effectRuntime.markEffectExecutionStarted(handle, executionInput)
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    const snapshot = await snapshotStore.getTaskSnapshot(sessionId)
    assert(snapshot?.run, 'target drift worker requires persisted TaskRun')
    const effect = snapshot.run.effects[0]
    const tool = snapshot.run.toolExecutions[0]
    process.send?.({
      type: 'target-drift',
      rejected: error.length > 0,
      error,
      effectStatus: effect.status,
      toolStatus: tool.status,
      retryEvidenceCount: effect.evidence.filter((item) => item.kind === 'retry_authorized').length
    })
    return
  }

  if (workerMode === '--worker-empty-git-commit-preflight') {
    const sessionId = 'empty-git-commit-session'
    const toolUseId = 'empty-git-commit-tool'
    const toolName = 'git_commit'
    const toolInput = { message: 'must fail before lease' }
    let run = taskRun.createTaskRun({ id: `${sessionId}-run`, sessionId, taskId: sessionId, now: 1000 })
    run = taskExecution.reduceTaskExecutionEvent(
      run,
      { kind: 'user-message', messageId: `${sessionId}-message`, text: 'commit with empty index' },
      project,
      1010
    )
    run = taskExecution.reduceTaskExecutionEvent(
      run,
      { kind: 'assistant-message', blocks: [{ type: 'tool_use', id: toolUseId, name: toolName, input: toolInput }] },
      project,
      1020
    )
    registryModule.taskRuntimeRegistry.set(sessionId, run)
    await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
      meta: meta(sessionId, project),
      transcript: [
        { seq: 1, event: { kind: 'user-message', messageId: `${sessionId}-message`, text: 'commit with empty index' } },
        { seq: 2, event: { kind: 'assistant-message', blocks: [{ type: 'tool_use', id: toolUseId, name: toolName, input: toolInput }] } }
      ],
      lastSeq: 2,
      lastEventKind: 'assistant-message',
      eventCount: 2,
      reason: 'important-event',
      run,
      now: 1030
    }))
    let error = ''
    try {
      await effectRuntime.prepareEffectExecution({ sessionId, cwd: project, toolUseId, toolName, toolInput })
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    const snapshot = await snapshotStore.getTaskSnapshot(sessionId)
    assert(snapshot?.run, 'empty commit preflight requires persisted TaskRun')
    process.send?.({
      type: 'empty-git-commit-preflight',
      rejected: error.length > 0,
      error,
      effectCount: snapshot.run.effects?.length ?? 0,
      runStatus: snapshot.run.status
    })
    return
  }

  if (workerMode === '--worker-prepared-git-crash') {
    const sessionId = 'prepared-git-session'
    const toolUseId = 'prepared-git-tool'
    const toolName = 'git_push'
    const toolInput = { branch: 'main' }
    let run = taskRun.createTaskRun({ id: `${sessionId}-run`, sessionId, taskId: sessionId, now: 1000 })
    run = taskExecution.reduceTaskExecutionEvent(
      run,
      { kind: 'user-message', messageId: `${sessionId}-message`, text: 'prepare push then crash before approval' },
      project,
      1010
    )
    run = taskExecution.reduceTaskExecutionEvent(
      run,
      { kind: 'assistant-message', blocks: [{ type: 'tool_use', id: toolUseId, name: toolName, input: toolInput }] },
      project,
      1020
    )
    registryModule.taskRuntimeRegistry.set(sessionId, run)
    await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
      meta: meta(sessionId, project),
      transcript: [
        { seq: 1, event: { kind: 'user-message', messageId: `${sessionId}-message`, text: 'prepare push then crash before approval' } },
        { seq: 2, event: { kind: 'assistant-message', blocks: [{ type: 'tool_use', id: toolUseId, name: toolName, input: toolInput }] } }
      ],
      lastSeq: 2,
      lastEventKind: 'assistant-message',
      eventCount: 2,
      reason: 'important-event',
      run,
      now: 1030
    }))
    await effectRuntime.prepareEffectExecution({ sessionId, cwd: project, toolUseId, toolName, toolInput })
    const snapshot = await snapshotStore.getTaskSnapshot(sessionId)
    process.send?.({ type: 'prepared-git', effectStatus: snapshot?.run?.effects?.[0]?.status })
    setInterval(() => undefined, 1000)
    return
  }

  if (workerMode === '--worker-prepared-git-resume') {
    const snapshot = await snapshotStore.getTaskSnapshot('prepared-git-session')
    assert(snapshot?.run, 'prepared git resume requires persisted TaskRun')
    const reconciled = await effectRuntime.reconcilePersistedTaskSnapshot(snapshot)
    const effect = reconciled.run.effects[0]
    process.send?.({
      type: 'prepared-git-resume',
      effectStatus: effect.status,
      retryEvidenceCount: effect.evidence.filter((item) => item.kind === 'retry_authorized').length
    })
    return
  }

  if (workerMode.endsWith('-manual-cas')) {
    const snapshot = await snapshotStore.getTaskSnapshot('opaque-crash-session')
    assert(snapshot?.run, 'manual CAS worker requires persisted TaskRun')
    const effect = snapshot.run.effects[0]
    const expectedRevision = effect.revision
    const outcomes = await Promise.allSettled([
      effectRuntime.resolvePersistedTaskEffect(
        snapshot.id,
        effect.id,
        expectedRevision,
        'confirmed_applied'
      ),
      effectRuntime.resolvePersistedTaskEffect(
        snapshot.id,
        effect.id,
        expectedRevision,
        'confirmed_not_applied'
      )
    ])
    const finalSnapshot = await snapshotStore.getTaskSnapshot(snapshot.id)
    assert(finalSnapshot?.run, 'manual CAS result must remain persisted')
    const finalEffect = finalSnapshot.run.effects.find((item) => item.id === effect.id)
    assert(finalEffect, 'manual CAS effect must remain present')
    const staleError = outcomes
      .filter((item) => item.status === 'rejected')
      .map((item) => item.reason instanceof Error ? item.reason.message : String(item.reason))
      .join('\n')
    process.send?.({
      type: 'manual-cas',
      fulfilled: outcomes.filter((item) => item.status === 'fulfilled').length,
      rejected: outcomes.filter((item) => item.status === 'rejected').length,
      staleError,
      effectStatus: finalEffect.status,
      manualEvidenceCount: finalEffect.evidence.filter((item) => item.kind === 'manual_confirmation').length,
      retryEvidenceCount: finalEffect.evidence.filter((item) => item.kind === 'retry_authorized').length
    })
    return
  }

  if (workerMode.endsWith('-crash') || workerMode.endsWith('-postcondition-mismatch')) {
    const postconditionMismatch = workerMode.endsWith('-postcondition-mismatch')
    const opaque = workerMode.includes('opaque')
    const sessionId = postconditionMismatch
      ? 'postcondition-mismatch-session'
      : opaque
        ? 'opaque-crash-session'
        : 'file-crash-session'
    const toolName = opaque ? 'bash' : 'write_file'
    const toolUseId = opaque ? 'opaque-tool' : 'file-tool'
    const toolInput = opaque
      ? { command: 'external-action-without-query-api' }
      : { path: 'state.txt', content: 'after\n' }
    let run = taskRun.createTaskRun({ id: `${sessionId}-run`, sessionId, taskId: sessionId, now: 1000 })
    run = taskExecution.reduceTaskExecutionEvent(
      run,
      { kind: 'user-message', messageId: `${sessionId}-message`, text: 'crash effect test' },
      project,
      1010
    )
    run = taskExecution.reduceTaskExecutionEvent(
      run,
      { kind: 'assistant-message', blocks: [{ type: 'tool_use', id: toolUseId, name: toolName, input: toolInput }] },
      project,
      1020
    )
    registryModule.taskRuntimeRegistry.set(sessionId, run)
    await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
      meta: meta(sessionId, project),
      transcript: [
        { seq: 1, event: { kind: 'user-message', messageId: `${sessionId}-message`, text: 'crash effect test' } },
        { seq: 2, event: { kind: 'assistant-message', blocks: [{ type: 'tool_use', id: toolUseId, name: toolName, input: toolInput }] } }
      ],
      lastSeq: 2,
      lastEventKind: 'assistant-message',
      eventCount: 2,
      reason: 'important-event',
      run,
      now: 1030
    }))
    const handle = await effectRuntime.prepareEffectExecution({
      sessionId,
      cwd: project,
      toolUseId,
      toolName,
      toolInput
    })
    await effectRuntime.markEffectExecutionStarted(handle, {
      sessionId,
      cwd: project,
      toolUseId,
      toolName,
      toolInput
    })

    if (postconditionMismatch) {
      const effect = await effectRuntime.completeEffectExecution(handle, {
        ok: true,
        output: 'executor claimed success without applying the target effect'
      })
      process.send?.({
        type: 'postcondition-mismatch',
        effectStatus: effect?.status,
        retryEvidenceCount: effect?.evidence.filter((item) => item.kind === 'retry_authorized').length
      })
      return
    }

    appendFileSync(counter, 'executed\n', 'utf8')
    if (!opaque) writeFileSync(path.join(project, 'state.txt'), 'after\n', 'utf8')
    process.send?.({ type: 'external-committed' })
    setInterval(() => undefined, 1000)
    return
  }

  const snapshot = await snapshotStore.getTaskSnapshot(
    workerMode.includes('opaque') ? 'opaque-crash-session' : 'file-crash-session'
  )
  assert(snapshot?.run, 'resume worker requires persisted TaskRun')
  const reconciledSnapshot = await effectRuntime.reconcileTaskSnapshotEffects(snapshot, { processStopped: true })
  const persisted = await snapshotStore.saveTaskSnapshot({
    ...reconciledSnapshot,
    updatedAt: Date.now(),
    run: reconciledSnapshot.run
  })
  const effect = persisted.run.effects[0]
  const tool = persisted.run.toolExecutions[0]
  registryModule.taskRuntimeRegistry.set(persisted.run.sessionId, persisted.run)
  const opaque = workerMode.includes('opaque')
  const decision = registryModule.taskRuntimeRegistry.evaluateTool({
    sessionId: persisted.run.sessionId,
    cwd: project,
    toolName: opaque ? 'bash' : 'write_file',
    toolInput: opaque
      ? { command: 'external-action-without-query-api' }
      : { path: 'state.txt', content: 'after\n' },
    toolUseId: opaque ? 'opaque-retry' : 'file-retry'
  }).kind
  process.send?.({
    type: 'reconciled',
    effectStatus: effect.status,
    toolStatus: tool.status,
    decision
  })
}

function forkWorker(workerMode, outDir, paths, repoRoot) {
  return new Promise((resolve, reject) => {
    const child = fork(process.argv[1], [workerMode], {
      env: {
        ...process.env,
        CAOGEN_EFFECT_COMPILED: outDir,
        CAOGEN_EFFECT_REPO_ROOT: repoRoot,
        CAOGEN_EFFECT_PROJECT: paths.project,
        CAOGEN_EFFECT_COUNTER: paths.counter,
        CAOGEN_EFFECT_USER_DATA: paths.userData
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    let settled = false
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.once('error', reject)
    child.on('message', (message) => {
      if (settled) return
      settled = true
      resolve(message)
      if (workerMode.endsWith('-crash')) {
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' })
        } else {
          child.kill('SIGKILL')
        }
      } else {
        child.disconnect()
      }
    })
    child.once('exit', (code, signal) => {
      if (!settled) reject(new Error(`worker exited before evidence: code=${code} signal=${signal}\n${stderr}`))
    })
  })
}

function casePaths(root, name) {
  return {
    project: path.join(root, `${name}-project`),
    userData: path.join(root, `${name}-userData`),
    counter: path.join(root, `${name}-count.txt`)
  }
}

function meta(id, cwd) {
  return {
    id,
    title: 'Effect crash smoke',
    cwd,
    driveMode: 'core',
    engine: 'openai',
    model: 'gpt-test',
    providerId: 'provider-test',
    permissionMode: 'bypassPermissions',
    status: 'running',
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    costUsd: 0,
    contextTokens: 0,
    createdAt: 1000
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

function countLines(file) {
  if (!existsSync(file)) return 0
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).length
}

function initRepo(dir) {
  git(dir, ['init', '-b', 'main'])
  git(dir, ['config', 'user.email', 'effect@example.test'])
  git(dir, ['config', 'user.name', 'Effect Crash Smoke'])
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
