import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-effect-reconcile-'))
const outDir = path.join(tempRoot, 'compiled')

try {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/task/effect-ledger.ts',
      'src/main/task/task-execution.ts',
      'src/main/task/task-run.ts',
      'src/main/task/task-runtime-registry.ts',
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

  const ledger = await importModule(outDir, 'effect-ledger.js')
  const reconciler = await importModule(outDir, 'effect-reconciler.js')
  const taskExecution = await importModule(outDir, 'task-execution.js')
  const taskRun = await importModule(outDir, 'task-run.js')
  const registryModule = await importModule(outDir, 'task-runtime-registry.js')
  const idempotency = await importModule(outDir, 'tool-idempotency.js')

  for (const toolName of idempotency.OPENAI_PERMISSION_READ_ONLY_TOOLS) {
    assert(!idempotency.isSideEffectingTool(toolName), `${toolName} must not create an effect record`)
  }
  for (const toolName of ['WebSearch', 'browser_screenshot', 'gui_list_windows', 'gui_screenshot']) {
    assert(!idempotency.isSideEffectingTool(toolName), `${toolName} is observational and must remain effect-free`)
  }
  assert(idempotency.isSideEffectingTool('unknown_future_tool'), 'unknown tools must fail closed as side-effecting')
  assert(idempotency.isSideEffectingTool('write_file'), 'write_file must remain side-effecting')

  const fileRoot = path.join(tempRoot, 'file-project')
  mkdirSync(fileRoot, { recursive: true })
  const fileAlias = path.join(tempRoot, 'file-project-alias')
  if (process.platform !== 'win32') symlinkSync(fileRoot, fileAlias, 'dir')
  const peerCwd = process.platform === 'win32' ? path.join(fileRoot, '.') : fileAlias
  writeFileSync(path.join(fileRoot, 'state.txt'), 'before\n', 'utf8')
  const fileInput = { path: 'state.txt', content: 'after\n' }
  let fileRun = runWithTool(taskRun, taskExecution, 'file-session', 'write-1', 'write_file', fileInput, fileRoot)
  const fileDescriptor = await reconciler.buildEffectDescriptor({ toolName: 'write_file', toolInput: fileInput, cwd: fileRoot })
  const prepared = ledger.prepareEffect(fileRun, {
    sessionId: fileRun.sessionId,
    cwd: fileRoot,
    toolUseId: 'write-1',
    toolName: 'write_file',
    descriptor: fileDescriptor,
    ownerId: 'worker-a',
    now: 1000
  })
  const peerRun = runWithTool(
    taskRun,
    taskExecution,
    'file-session-peer',
    'write-peer',
    'write_file',
    fileInput,
    peerCwd
  )
  const peerDescriptor = await reconciler.buildEffectDescriptor({
    toolName: 'write_file',
    toolInput: fileInput,
    cwd: peerCwd
  })
  const peerPrepared = ledger.prepareEffect(peerRun, {
    sessionId: peerRun.sessionId,
    cwd: peerCwd,
    toolUseId: 'write-peer',
    toolName: 'write_file',
    descriptor: peerDescriptor,
    ownerId: 'worker-peer',
    now: 1000
  })
  assertEqual(
    peerPrepared.handle.effectKey,
    prepared.handle.effectKey,
    'effect keys must be target-scoped across sessions'
  )
  assertEqual(
    peerPrepared.handle.resourceKey,
    prepared.handle.resourceKey,
    'canonical aliases of one file must share a resource key'
  )
  const differentIntentInput = { path: 'state.txt', content: 'different\n' }
  const differentIntentDescriptor = await reconciler.buildEffectDescriptor({
    toolName: 'write_file',
    toolInput: differentIntentInput,
    cwd: peerCwd
  })
  const differentIntentRun = runWithTool(
    taskRun,
    taskExecution,
    'file-session-different-intent',
    'write-different-intent',
    'write_file',
    differentIntentInput,
    peerCwd
  )
  const differentIntentPrepared = ledger.prepareEffect(differentIntentRun, {
    sessionId: differentIntentRun.sessionId,
    cwd: peerCwd,
    toolUseId: 'write-different-intent',
    toolName: 'write_file',
    descriptor: differentIntentDescriptor,
    ownerId: 'worker-different-intent',
    now: 1000
  })
  assert(
    differentIntentPrepared.handle.effectKey !== prepared.handle.effectKey,
    'different file content intents must keep distinct effect keys'
  )
  assertEqual(
    differentIntentPrepared.handle.resourceKey,
    prepared.handle.resourceKey,
    'different content intents for one file must share a resource key'
  )
  fileRun = prepared.run
  assertEqual(fileRun.effects[0].status, 'prepared')
  assertEqual(fileRun.effects[0].lease.fencingToken, 1)
  const originalEvidence = evidenceSnapshot(fileRun.effects[0])
  assertThrowsMatching(
    () => ledger.prepareEffect(fileRun, {
      sessionId: fileRun.sessionId,
      cwd: fileRoot,
      toolUseId: 'write-2',
      toolName: 'write_file',
      descriptor: fileDescriptor,
      ownerId: 'worker-b',
      now: 1001
    }),
    /相同外部效果仍未收敛/,
    'same effectKey must not acquire a second active lease'
  )
  assertThrowsMatching(
    () => ledger.prepareEffect(fileRun, {
      sessionId: fileRun.sessionId,
      cwd: fileRoot,
      toolUseId: 'write-3',
      toolName: 'write_file',
      descriptor: differentIntentDescriptor,
      ownerId: 'worker-c',
      now: 1002
    }),
    /same resource|\u540c\u4e00\u8d44\u6e90/,
    'same file with a different intent must not acquire a concurrent lease'
  )
  fileRun = ledger.markEffectExecuting(fileRun, prepared.handle, 1010)
  writeFileSync(path.join(fileRoot, 'state.txt'), 'after\n', 'utf8')
  const crashedFileRun = taskExecution.recoverTaskExecutionState(fileRun, 1020)
  assertEqual(crashedFileRun.effects[0].status, 'waiting_reconciliation')
  assert(crashedFileRun.effects[0].lease.releasedAt === 1020, 'crash recovery must release execution lease')
  const fileProbe = await reconciler.reconcileEffect(crashedFileRun.effects[0])
  assertEqual(fileProbe.kind, 'confirmed')
  fileRun = ledger.applyEffectReconciliation(crashedFileRun, crashedFileRun.effects[0].id, fileProbe, 1030)
  assertEqual(fileRun.effects[0].status, 'confirmed')
  assertEqual(fileRun.toolExecutions[0].status, 'succeeded')
  assertEvidencePrefix(fileRun.effects[0], originalEvidence, 'reconciliation must preserve prepared evidence')
  const fileReconciliationEvidence = requireEvidence(fileRun.effects[0], 'reconciliation')
  assertEqual(fileReconciliationEvidence.generation, 1)
  assertEqual(
    fileReconciliationEvidence.digest,
    idempotency.stableValueDigest({
      result: fileProbe.kind,
      evidenceDigest: fileProbe.evidenceDigest,
      reason: fileProbe.reason
    })
  )
  const compensated = ledger.markEffectCompensated(fileRun, fileRun.effects[0].id, 'compensation-effect', 'compensation-evidence', 1040)
  assertEqual(compensated.effects[0].status, 'compensated')
  assertEvidencePrefix(compensated.effects[0], evidenceSnapshot(fileRun.effects[0]), 'compensation must append evidence')
  const compensationEvidence = requireEvidence(compensated.effects[0], 'compensation')
  assertEqual(compensationEvidence.generation, 1)
  assertEqual(compensationEvidence.verifier, 'effect-ledger-v1')
  assertEqual(
    compensationEvidence.digest,
    idempotency.stableValueDigest({
      compensationEffectId: 'compensation-effect',
      evidenceDigest: 'compensation-evidence'
    })
  )

  writeFileSync(path.join(fileRoot, 'fence.txt'), 'before\n', 'utf8')
  const fenceInput = { path: 'fence.txt', content: 'after\n' }
  let fenceRun = runWithTool(taskRun, taskExecution, 'fence-session', 'fence-1', 'write_file', fenceInput, fileRoot)
  const fenceDescriptor = await reconciler.buildEffectDescriptor({
    toolName: 'write_file',
    toolInput: fenceInput,
    cwd: fileRoot
  })
  const fencePrepared = ledger.prepareEffect(fenceRun, {
    sessionId: fenceRun.sessionId,
    cwd: fileRoot,
    toolUseId: 'fence-1',
    toolName: 'write_file',
    descriptor: fenceDescriptor,
    ownerId: 'worker-a',
    now: 6000,
    leaseTtlMs: 1000
  })
  for (const [label, handle] of [
    ['lease id', { ...fencePrepared.handle, leaseId: 'wrong-lease-id' }],
    ['owner', { ...fencePrepared.handle, ownerId: 'worker-b' }],
    ['fencing token', { ...fencePrepared.handle, fencingToken: fencePrepared.handle.fencingToken + 1 }]
  ]) {
    assertThrowsMatching(
      () => ledger.markEffectExecuting(fencePrepared.run, handle, 6010),
      /stale_fence/,
      `wrong ${label} must be fenced`
    )
  }
  fenceRun = ledger.markEffectExecuting(fencePrepared.run, fencePrepared.handle, 6010)
  const executingEvidence = evidenceSnapshot(fenceRun.effects[0])
  const reenteredFenceRun = ledger.markEffectExecuting(fenceRun, fencePrepared.handle, 6500)
  assert(reenteredFenceRun === fenceRun, 'valid executing re-entry should be idempotent')
  assertEqual(JSON.stringify(evidenceSnapshot(reenteredFenceRun.effects[0])), JSON.stringify(executingEvidence))
  assertThrowsMatching(
    () => ledger.markEffectExecuting(fenceRun, fencePrepared.handle, 7000),
    /stale_fence: effect lease 已过期/,
    'expired executing lease must be fenced before re-entry'
  )

  writeFileSync(path.join(fileRoot, 'retry.txt'), 'old\n', 'utf8')
  const retryInput = { path: 'retry.txt', content: 'new\n' }
  let retryRun = runWithTool(taskRun, taskExecution, 'retry-session', 'retry-1', 'write_file', retryInput, fileRoot)
  const retryDescriptor = await reconciler.buildEffectDescriptor({ toolName: 'write_file', toolInput: retryInput, cwd: fileRoot })
  const retryPrepared = ledger.prepareEffect(retryRun, {
    sessionId: retryRun.sessionId,
    cwd: fileRoot,
    toolUseId: 'retry-1',
    toolName: 'write_file',
    descriptor: retryDescriptor,
    ownerId: 'worker-a',
    now: 2000
  })
  retryRun = taskExecution.recoverTaskExecutionState(
    ledger.markEffectExecuting(retryPrepared.run, retryPrepared.handle, 2010),
    2020
  )
  const retryProbe = await reconciler.reconcileEffect(retryRun.effects[0])
  assertEqual(retryProbe.kind, 'not_applied')
  retryRun = ledger.applyEffectReconciliation(retryRun, retryRun.effects[0].id, retryProbe, 2030)
  assertEqual(retryRun.effects[0].status, 'abandoned')
  const retryReconciliationEvidence = requireEvidence(retryRun.effects[0], 'reconciliation')
  const retryAuthorizationEvidence = requireEvidence(retryRun.effects[0], 'retry_authorized')
  assertEqual(retryReconciliationEvidence.generation, 1)
  assertEqual(retryAuthorizationEvidence.generation, 1)
  assertEqual(
    retryReconciliationEvidence.digest,
    idempotency.stableValueDigest({
      result: retryProbe.kind,
      evidenceDigest: retryProbe.evidenceDigest,
      reason: retryProbe.reason
    })
  )
  assertEqual(
    retryAuthorizationEvidence.digest,
    idempotency.stableValueDigest({
      reconciliationEvidenceDigest: retryReconciliationEvidence.digest,
      effectKey: retryRun.effects[0].effectKey
    })
  )
  const generationOneEvidence = evidenceSnapshot(retryRun.effects[0])
  retryRun = taskExecution.reduceTaskExecutionEvent(
    retryRun,
    { kind: 'assistant-message', blocks: [{ type: 'tool_use', id: 'retry-2', name: 'write_file', input: retryInput }] },
    fileRoot,
    2040
  )
  const secondGeneration = ledger.prepareEffect(retryRun, {
    sessionId: retryRun.sessionId,
    cwd: fileRoot,
    toolUseId: 'retry-2',
    toolName: 'write_file',
    descriptor: retryDescriptor,
    ownerId: 'worker-b',
    now: 2050
  })
  assertEqual(secondGeneration.run.effects[1].generation, 2)
  assertEqual(secondGeneration.run.effects[1].lease.fencingToken, 2)
  assertEqual(secondGeneration.run.effects[1].effectKey, secondGeneration.run.effects[0].effectKey)
  assertEqual(secondGeneration.run.effects[1].targetDigest, secondGeneration.run.effects[0].targetDigest)
  assertEqual(secondGeneration.run.effects[1].intentDigest, secondGeneration.run.effects[0].intentDigest)
  assertEqual(secondGeneration.run.effects[1].inputDigest, secondGeneration.run.effects[0].inputDigest)
  assertEvidencePrefix(secondGeneration.run.effects[0], generationOneEvidence, 'new generation must not rewrite old evidence')
  assert(
    secondGeneration.run.effects[1].evidence.every((item) => item.generation === 2),
    'generation two evidence must be tagged with generation two'
  )
  assertThrowsMatching(
    () => ledger.markEffectExecuting(secondGeneration.run, retryPrepared.handle, 2060),
    /stale_fence/,
    'stale fencing token must not mutate a newer generation'
  )

  const commitRepo = path.join(tempRoot, 'commit-repo')
  initRepo(commitRepo)
  writeFileSync(path.join(commitRepo, 'app.txt'), 'base\n', 'utf8')
  git(commitRepo, ['add', 'app.txt'])
  git(commitRepo, ['commit', '-m', 'base'])
  writeFileSync(path.join(commitRepo, 'app.txt'), 'changed\n', 'utf8')
  git(commitRepo, ['add', 'app.txt'])
  const commitInput = { message: 'effect commit' }
  let commitRun = runWithTool(taskRun, taskExecution, 'commit-session', 'commit-1', 'git_commit', commitInput, commitRepo)
  const commitDescriptor = await reconciler.buildEffectDescriptor({ toolName: 'git_commit', toolInput: commitInput, cwd: commitRepo })
  const alternateCommitInput = { message: 'different effect commit' }
  const alternateCommitDescriptor = await reconciler.buildEffectDescriptor({
    toolName: 'git_commit',
    toolInput: alternateCommitInput,
    cwd: commitRepo
  })
  const commitPrepared = ledger.prepareEffect(commitRun, {
    sessionId: commitRun.sessionId,
    cwd: commitRepo,
    toolUseId: 'commit-1',
    toolName: 'git_commit',
    descriptor: commitDescriptor,
    ownerId: 'worker-a',
    now: 3000
  })
  const alternateCommitRun = runWithTool(
    taskRun,
    taskExecution,
    'commit-session-alternate',
    'commit-alternate',
    'git_commit',
    alternateCommitInput,
    commitRepo
  )
  const alternateCommitPrepared = ledger.prepareEffect(alternateCommitRun, {
    sessionId: alternateCommitRun.sessionId,
    cwd: commitRepo,
    toolUseId: 'commit-alternate',
    toolName: 'git_commit',
    descriptor: alternateCommitDescriptor,
    ownerId: 'worker-alternate',
    now: 3000
  })
  assert(
    alternateCommitPrepared.handle.effectKey !== commitPrepared.handle.effectKey,
    'different commit messages must keep distinct effect keys'
  )
  assertEqual(
    alternateCommitPrepared.handle.resourceKey,
    commitPrepared.handle.resourceKey,
    'different commit intents on one local branch must share a resource key'
  )
  commitRun = ledger.markEffectExecuting(commitPrepared.run, commitPrepared.handle, 3010)
  git(commitRepo, ['commit', '-m', 'effect commit'])
  commitRun = taskExecution.recoverTaskExecutionState(commitRun, 3020)
  const commitProbe = await reconciler.reconcileEffect(commitRun.effects[0])
  assertEqual(commitProbe.kind, 'confirmed')
  commitRun = ledger.applyEffectReconciliation(commitRun, commitRun.effects[0].id, commitProbe, 3030)
  assertEqual(commitRun.effects[0].status, 'confirmed')

  const emptyCommitRun = runWithTool(
    taskRun,
    taskExecution,
    'empty-commit-session',
    'empty-commit-1',
    'git_commit',
    { message: 'must not wait for reconciliation' },
    commitRepo
  )
  await assertRejectsMatching(
    () => reconciler.buildEffectDescriptor({
      toolName: 'git_commit',
      toolInput: { message: 'must not wait for reconciliation' },
      cwd: commitRepo
    }),
    /没有已暂存的改动/,
    'deterministic empty-index preflight must fail before an EffectRecord is prepared'
  )
  assertEqual(emptyCommitRun.effects?.length ?? 0, 0)

  const pushRepo = path.join(tempRoot, 'push-repo')
  const bareRemote = path.join(tempRoot, 'remote.git')
  const pushBareRemote = path.join(tempRoot, 'push-remote.git')
  mkdirSync(bareRemote, { recursive: true })
  mkdirSync(pushBareRemote, { recursive: true })
  git(tempRoot, ['init', '--bare', bareRemote])
  git(tempRoot, ['init', '--bare', pushBareRemote])
  initRepo(pushRepo)
  writeFileSync(path.join(pushRepo, 'push.txt'), 'once\n', 'utf8')
  git(pushRepo, ['add', 'push.txt'])
  git(pushRepo, ['commit', '-m', 'push base'])
  git(pushRepo, ['remote', 'add', 'origin', bareRemote])
  git(pushRepo, ['remote', 'set-url', '--push', 'origin', pushBareRemote])
  const pushInput = { branch: 'main' }
  let pushRun = runWithTool(taskRun, taskExecution, 'push-session', 'push-1', 'git_push', pushInput, pushRepo)
  const pushDescriptor = await reconciler.buildEffectDescriptor({ toolName: 'git_push', toolInput: pushInput, cwd: pushRepo })
  const pushPrepared = ledger.prepareEffect(pushRun, {
    sessionId: pushRun.sessionId,
    cwd: pushRepo,
    toolUseId: 'push-1',
    toolName: 'git_push',
    descriptor: pushDescriptor,
    ownerId: 'worker-a',
    now: 4000
  })
  pushRun = ledger.markEffectExecuting(pushPrepared.run, pushPrepared.handle, 4010)
  git(pushRepo, ['push', '-u', 'origin', 'main'])
  pushRun = taskExecution.recoverTaskExecutionState(pushRun, 4020)
  const pushProbe = await reconciler.reconcileEffect(pushRun.effects[0])
  assertEqual(pushProbe.kind, 'confirmed')
  pushRun = ledger.applyEffectReconciliation(pushRun, pushRun.effects[0].id, pushProbe, 4030)
  assertEqual(pushRun.effects[0].status, 'confirmed')
  assertEqual(
    git(tempRoot, ['--git-dir', pushBareRemote, 'rev-parse', 'refs/heads/main']).trim(),
    pushDescriptor.target.intendedSha,
    'git_push reconciliation must query the effective pushurl target'
  )

  const commandMarker = path.join(tempRoot, 'git-config-command-marker.txt')
  const commandScript = path.join(tempRoot, 'git-config-command.sh')
  writeFileSync(commandScript, `#!/bin/sh\nprintf "invoked:%s\\n" "$1" >> "${commandMarker}"\nexit 0\n`, 'utf8')
  chmodSync(commandScript, 0o755)
  const globalConfig = path.join(tempRoot, 'untrusted-global.gitconfig')
  git(tempRoot, ['config', '--file', globalConfig, 'core.sshCommand', commandScript])
  git(tempRoot, ['config', '--file', globalConfig, 'core.askPass', commandScript])
  git(tempRoot, ['config', '--file', globalConfig, 'credential.helper', `!${commandScript}`])

  const inheritedEnv = captureEnv([
    'GIT_ASKPASS',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_KEY_1',
    'GIT_CONFIG_VALUE_0',
    'GIT_CONFIG_VALUE_1',
    'GIT_SSH_COMMAND',
    'SSH_ASKPASS'
  ])
  try {
    process.env.GIT_CONFIG_GLOBAL = globalConfig
    process.env.GIT_CONFIG_COUNT = '2'
    process.env.GIT_CONFIG_KEY_0 = 'credential.helper'
    process.env.GIT_CONFIG_VALUE_0 = `!${commandScript}`
    process.env.GIT_CONFIG_KEY_1 = 'core.sshCommand'
    process.env.GIT_CONFIG_VALUE_1 = commandScript
    process.env.GIT_ASKPASS = commandScript
    process.env.SSH_ASKPASS = commandScript
    process.env.GIT_SSH_COMMAND = commandScript

    const sshRepo = path.join(tempRoot, 'ssh-probe-repo')
    initRepo(sshRepo)
    writeFileSync(path.join(sshRepo, 'ssh.txt'), 'ssh probe\n', 'utf8')
    git(sshRepo, ['add', 'ssh.txt'])
    git(sshRepo, ['commit', '-m', 'ssh probe'])
    git(sshRepo, ['remote', 'add', 'origin', 'ssh://127.0.0.1:1/repo.git'])
    git(sshRepo, ['config', 'core.sshCommand', commandScript])
    const sshInput = { branch: 'main' }
    let sshRun = runWithTool(taskRun, taskExecution, 'ssh-probe-session', 'ssh-push-1', 'git_push', sshInput, sshRepo)
    const sshDescriptor = await reconciler.buildEffectDescriptor({ toolName: 'git_push', toolInput: sshInput, cwd: sshRepo })
    const sshPrepared = ledger.prepareEffect(sshRun, {
      sessionId: sshRun.sessionId,
      cwd: sshRepo,
      toolUseId: 'ssh-push-1',
      toolName: 'git_push',
      descriptor: sshDescriptor,
      ownerId: 'worker-a',
      now: 4100
    })
    sshRun = ledger.markEffectExecuting(sshPrepared.run, sshPrepared.handle, 4110)
    const sshProbe = await reconciler.reconcileEffect(sshRun.effects[0])
    assertEqual(sshProbe.kind, 'unresolved')
    assert(!existsSync(commandMarker), 'git_push reconciliation must not execute configured SSH commands')

    let httpRequests = 0
    const authServer = createServer((_request, response) => {
      httpRequests += 1
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="effect-test"' })
      response.end('credentials required')
    })
    await new Promise((resolveListen, rejectListen) => {
      authServer.once('error', rejectListen)
      authServer.listen(0, '127.0.0.1', resolveListen)
    })
    try {
      const address = authServer.address()
      assert(address && typeof address === 'object', 'auth test server must expose an address')
      const httpRepo = path.join(tempRoot, 'http-probe-repo')
      initRepo(httpRepo)
      writeFileSync(path.join(httpRepo, 'http.txt'), 'http probe\n', 'utf8')
      git(httpRepo, ['add', 'http.txt'])
      git(httpRepo, ['commit', '-m', 'http probe'])
      git(httpRepo, ['remote', 'add', 'origin', `http://127.0.0.1:${address.port}/repo.git`])
      git(httpRepo, ['config', 'credential.helper', `!${commandScript}`])
      git(httpRepo, ['config', 'core.askPass', commandScript])
      const httpInput = { branch: 'main' }
      let httpRun = runWithTool(taskRun, taskExecution, 'http-probe-session', 'http-push-1', 'git_push', httpInput, httpRepo)
      const httpDescriptor = await reconciler.buildEffectDescriptor({ toolName: 'git_push', toolInput: httpInput, cwd: httpRepo })
      const httpPrepared = ledger.prepareEffect(httpRun, {
        sessionId: httpRun.sessionId,
        cwd: httpRepo,
        toolUseId: 'http-push-1',
        toolName: 'git_push',
        descriptor: httpDescriptor,
        ownerId: 'worker-a',
        now: 4200
      })
      httpRun = ledger.markEffectExecuting(httpPrepared.run, httpPrepared.handle, 4210)
      const httpProbe = await reconciler.reconcileEffect(httpRun.effects[0])
      assertEqual(httpProbe.kind, 'unresolved')
      assert(httpRequests > 0, 'isolated HTTP reconciliation must still perform the read-only remote probe')
      assert(!existsSync(commandMarker), 'git_push reconciliation must not execute credential helpers or askpass')
    } finally {
      await new Promise((resolveClose) => authServer.close(resolveClose))
    }
  } finally {
    restoreEnv(inheritedEnv)
  }

  const bashInput = { command: 'send-message-without-query-api' }
  let opaqueRun = runWithTool(taskRun, taskExecution, 'opaque-session', 'opaque-1', 'bash', bashInput, fileRoot)
  const opaqueDescriptor = await reconciler.buildEffectDescriptor({ toolName: 'bash', toolInput: bashInput, cwd: fileRoot })
  const opaquePrepared = ledger.prepareEffect(opaqueRun, {
    sessionId: opaqueRun.sessionId,
    cwd: fileRoot,
    toolUseId: 'opaque-1',
    toolName: 'bash',
    descriptor: opaqueDescriptor,
    ownerId: 'worker-a',
    now: 5000
  })
  opaqueRun = taskExecution.recoverTaskExecutionState(
    ledger.markEffectExecuting(opaquePrepared.run, opaquePrepared.handle, 5010),
    5020
  )
  const opaqueProbe = await reconciler.reconcileEffect(opaqueRun.effects[0])
  assertEqual(opaqueProbe.kind, 'unresolved')
  opaqueRun = ledger.applyEffectReconciliation(opaqueRun, opaqueRun.effects[0].id, opaqueProbe, 5030)
  assertEqual(opaqueRun.effects[0].status, 'waiting_reconciliation')
  registryModule.taskRuntimeRegistry.clear()
  registryModule.taskRuntimeRegistry.set(opaqueRun.sessionId, opaqueRun)
  const opaqueDecision = registryModule.taskRuntimeRegistry.evaluateTool({
    sessionId: opaqueRun.sessionId,
    cwd: fileRoot,
    toolName: 'bash',
    toolInput: bashInput,
    toolUseId: 'opaque-2'
  })
  assertEqual(opaqueDecision.kind, 'deny')
  assert(opaqueDecision.reason.includes('普通权限批准不能绕过'), 'opaque unknown outcome must fail closed')

  const opaqueEvidence = evidenceSnapshot(opaqueRun.effects[0])
  const manualApplied = ledger.manuallyResolveEffect(
    opaqueRun,
    opaqueRun.effects[0].id,
    'confirmed_applied',
    5040
  )
  const appliedEffect = manualApplied.effects[0]
  assertEqual(appliedEffect.status, 'confirmed')
  assertEqual(manualApplied.toolExecutions[0].status, 'succeeded')
  assertEvidencePrefix(appliedEffect, opaqueEvidence, 'manual applied resolution must append evidence')
  const appliedManualEvidence = requireEvidence(appliedEffect, 'manual_confirmation')
  assertEqual(appliedManualEvidence.generation, appliedEffect.generation)
  assertEqual(appliedManualEvidence.verifier, 'human-v1')
  assertEqual(
    appliedManualEvidence.digest,
    idempotency.stableValueDigest({
      effectId: appliedEffect.id,
      effectKey: appliedEffect.effectKey,
      resolution: 'confirmed_applied'
    })
  )
  assert(
    appliedEffect.evidence.filter((item) => item.kind === 'retry_authorized').length ===
      opaqueRun.effects[0].evidence.filter((item) => item.kind === 'retry_authorized').length,
    'confirmed applied must not authorize a retry'
  )

  const manualNotApplied = ledger.manuallyResolveEffect(
    opaqueRun,
    opaqueRun.effects[0].id,
    'confirmed_not_applied',
    5050
  )
  const notAppliedEffect = manualNotApplied.effects[0]
  assertEqual(notAppliedEffect.status, 'abandoned')
  assertEqual(manualNotApplied.toolExecutions[0].status, 'cancelled')
  assertEvidencePrefix(notAppliedEffect, opaqueEvidence, 'manual not-applied resolution must append evidence')
  const notAppliedManualEvidence = requireEvidence(notAppliedEffect, 'manual_confirmation')
  const manualRetryEvidence = requireEvidence(notAppliedEffect, 'retry_authorized')
  assertEqual(notAppliedManualEvidence.generation, notAppliedEffect.generation)
  assertEqual(manualRetryEvidence.generation, notAppliedEffect.generation)
  assertEqual(
    notAppliedManualEvidence.digest,
    idempotency.stableValueDigest({
      effectId: notAppliedEffect.id,
      effectKey: notAppliedEffect.effectKey,
      resolution: 'confirmed_not_applied'
    })
  )
  assertEqual(
    manualRetryEvidence.digest,
    idempotency.stableValueDigest({
      manualEvidenceDigest: notAppliedManualEvidence.digest,
      effectKey: notAppliedEffect.effectKey
    })
  )

  console.log('effect reconciliation smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function runWithTool(taskRun, taskExecution, sessionId, toolUseId, toolName, input, cwd) {
  let run = taskRun.createTaskRun({ id: `${sessionId}-run`, sessionId, taskId: sessionId, now: 100 })
  run = taskExecution.reduceTaskExecutionEvent(
    run,
    { kind: 'user-message', messageId: `${sessionId}-message`, text: 'effect smoke' },
    cwd,
    110
  )
  return taskExecution.reduceTaskExecutionEvent(
    run,
    { kind: 'assistant-message', blocks: [{ type: 'tool_use', id: toolUseId, name: toolName, input }] },
    cwd,
    120
  )
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
  git(dir, ['config', 'user.email', 'effect@example.test'])
  git(dir, ['config', 'user.name', 'Effect Smoke'])
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function assertThrowsMatching(fn, pattern, message) {
  let errorText = ''
  try {
    fn()
  } catch (error) {
    errorText = error instanceof Error ? error.message : String(error)
  }
  assert(errorText.length > 0, message)
  assert(pattern.test(errorText), `${message}: unexpected error ${JSON.stringify(errorText)}`)
}

async function assertRejectsMatching(fn, pattern, message) {
  let error
  try {
    await fn()
  } catch (caught) {
    error = caught
  }
  assert(error instanceof Error && pattern.test(error.message), message)
}

function captureEnv(keys) {
  return new Map(keys.map((key) => [key, process.env[key]]))
}

function restoreEnv(snapshot) {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function evidenceSnapshot(effect) {
  return effect.evidence.map((item) => ({
    id: item.id,
    kind: item.kind,
    digest: item.digest,
    observedAt: item.observedAt,
    verifier: item.verifier,
    generation: item.generation
  }))
}

function assertEvidencePrefix(effect, expected, message) {
  assertEqual(
    JSON.stringify(evidenceSnapshot(effect).slice(0, expected.length)),
    JSON.stringify(expected),
    message
  )
}

function requireEvidence(effect, kind) {
  const record = [...effect.evidence].reverse().find((item) => item.kind === kind)
  assert(record, `missing ${kind} evidence`)
  return record
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, message ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
