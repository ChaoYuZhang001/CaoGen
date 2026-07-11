import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
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
      'src/main/task/task-snapshot.ts',
      'src/main/agent/tools/git-tools.ts',
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
    `export const app = { getPath: () => ${JSON.stringify(path.join(tempRoot, 'userData'))} }\n`
  )
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')

  const ledger = await importModule(outDir, 'effect-ledger.js')
  const reconciler = await importModule(outDir, 'effect-reconciler.js')
  const taskExecution = await importModule(outDir, 'task-execution.js')
  const taskRun = await importModule(outDir, 'task-run.js')
  const registryModule = await importModule(outDir, 'task-runtime-registry.js')
  const snapshotStore = await importModule(outDir, 'task-snapshot.js')
  const idempotency = await importModule(outDir, 'tool-idempotency.js')
  const gitTools = await importModule(outDir, 'git-tools.js')

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

  const mergeRepo = path.join(tempRoot, 'merge-repo')
  initMergeFixture(mergeRepo)
  const mergeInput = { branch: 'feature' }
  const mergeDescriptor = await reconciler.buildEffectDescriptor({
    toolName: 'git_merge',
    toolInput: mergeInput,
    cwd: mergeRepo
  })
  assertEqual(mergeDescriptor.reconcilability, 'queryable')
  assertEqual(mergeDescriptor.target.kind, 'git_merge')
  assertEqual(mergeDescriptor.target.repoRoot, realpathSync(mergeRepo))
  assertEqual(mergeDescriptor.target.gitCommonDir, realpathSync(path.join(mergeRepo, '.git')))
  assertEqual(mergeDescriptor.target.worktreeGitDir, realpathSync(path.join(mergeRepo, '.git')))
  assertEqual(mergeDescriptor.target.destinationRef, 'refs/heads/main')
  assertEqual(mergeDescriptor.target.preHead, git(mergeRepo, ['rev-parse', 'HEAD']).trim())
  assertEqual(mergeDescriptor.target.preTree, git(mergeRepo, ['rev-parse', 'HEAD^{tree}']).trim())
  assertEqual(mergeDescriptor.target.sourceRef, 'refs/heads/feature')
  assertEqual(mergeDescriptor.target.sourceSha, git(mergeRepo, ['rev-parse', 'feature^{commit}']).trim())
  assertEqual(mergeDescriptor.target.sourceWasAncestor, false)
  assertEqual(mergeDescriptor.target.mode, 'no_ff_v1')
  assertIdentityRecord(mergeDescriptor.target.repoRootIdentity, 'repoRootIdentity')
  assertIdentityRecord(mergeDescriptor.target.gitCommonDirIdentity, 'gitCommonDirIdentity')
  assertIdentityRecord(mergeDescriptor.target.worktreeGitDirIdentity, 'worktreeGitDirIdentity')

  const redirectedGitDirRepo = path.join(tempRoot, 'merge-redirected-gitdir-repo')
  initMergeFixture(redirectedGitDirRepo)
  const redirectedGitDirDescriptor = await reconciler.buildEffectDescriptor({
    toolName: 'git_merge',
    toolInput: mergeInput,
    cwd: redirectedGitDirRepo
  })
  const redirectedGitDir = path.join(tempRoot, 'replacement-gitdir.git')
  cpSync(path.join(redirectedGitDirRepo, '.git'), redirectedGitDir, { recursive: true })
  rmSync(path.join(redirectedGitDirRepo, '.git'), { recursive: true, force: true })
  writeFileSync(path.join(redirectedGitDirRepo, '.git'), `gitdir: ${redirectedGitDir}\n`, 'utf8')
  const redirectedHeadBefore = git(redirectedGitDirRepo, ['rev-parse', 'refs/heads/main']).trim()
  const redirectedGitDirMerge = await gitTools.executeGitTool(
    'git_merge',
    mergeInput,
    redirectedGitDirRepo,
    { effectTarget: redirectedGitDirDescriptor.target }
  )
  assert(!redirectedGitDirMerge.ok, 'effect-bound git_merge must reject a repository whose .git target changed after approval')
  assertEqual(
    git(redirectedGitDirRepo, ['rev-parse', 'refs/heads/main']).trim(),
    redirectedHeadBefore,
    'identity rejection must not move the replacement repository destination ref'
  )

  const replacedGitDirRepo = path.join(tempRoot, 'merge-replaced-gitdir-repo')
  initMergeFixture(replacedGitDirRepo)
  const replacedGitDirDescriptor = await reconciler.buildEffectDescriptor({
    toolName: 'git_merge',
    toolInput: mergeInput,
    cwd: replacedGitDirRepo
  })
  const originalGitDirStat = statSync(path.join(replacedGitDirRepo, '.git'))
  const replacementAtSamePath = path.join(tempRoot, 'same-path-replacement.git')
  cpSync(path.join(replacedGitDirRepo, '.git'), replacementAtSamePath, { recursive: true })
  rmSync(path.join(replacedGitDirRepo, '.git'), { recursive: true, force: true })
  renameSync(replacementAtSamePath, path.join(replacedGitDirRepo, '.git'))
  const replacementGitDirStat = statSync(path.join(replacedGitDirRepo, '.git'))
  if (originalGitDirStat.dev !== replacementGitDirStat.dev || originalGitDirStat.ino !== replacementGitDirStat.ino) {
    const replacedHeadBefore = git(replacedGitDirRepo, ['rev-parse', 'refs/heads/main']).trim()
    const replacedGitDirMerge = await gitTools.executeGitTool(
      'git_merge',
      mergeInput,
      replacedGitDirRepo,
      { effectTarget: replacedGitDirDescriptor.target }
    )
    assert(!replacedGitDirMerge.ok, 'effect-bound git_merge must reject same-path Git metadata with a new inode')
    assertEqual(
      git(replacedGitDirRepo, ['rev-parse', 'refs/heads/main']).trim(),
      replacedHeadBefore,
      'same-path identity rejection must not move the destination ref'
    )
  }

  const promisorMergeRepo = path.join(tempRoot, 'merge-promisor-repo')
  initMergeFixture(promisorMergeRepo)
  const promisorRemote = path.join(tempRoot, 'merge-promisor-remote.git')
  git(tempRoot, ['clone', '--bare', promisorMergeRepo, promisorRemote])
  const promisorMarker = path.join(tempRoot, 'promisor-helper-ran.txt')
  const promisorHelper = path.join(tempRoot, 'promisor-helper.sh')
  writeFileSync(
    promisorHelper,
    `#!/bin/sh\ntouch ${JSON.stringify(promisorMarker)}\nexec git-upload-pack "$1"\n`,
    'utf8'
  )
  chmodSync(promisorHelper, 0o755)
  git(promisorMergeRepo, ['remote', 'add', 'origin', `ext::${promisorHelper} ${promisorRemote}`])
  git(promisorMergeRepo, ['config', 'remote.origin.promisor', 'true'])
  git(promisorMergeRepo, ['config', 'remote.origin.partialclonefilter', 'blob:none'])
  git(promisorMergeRepo, ['config', 'core.repositoryformatversion', '1'])
  git(promisorMergeRepo, ['config', 'extensions.partialclone', 'origin'])
  git(promisorMergeRepo, ['config', 'protocol.ext.allow', 'always'])
  const missingPromisorSha = git(promisorMergeRepo, ['rev-parse', 'feature^{commit}']).trim()
  rmSync(path.join(promisorMergeRepo, '.git', 'objects', missingPromisorSha.slice(0, 2), missingPromisorSha.slice(2)))
  await assertRejectsMatching(
    () => reconciler.buildEffectDescriptor({
      toolName: 'git_merge',
      toolInput: mergeInput,
      cwd: promisorMergeRepo
    }),
    /无法|失败|missing|object|revision|commit/i,
    'descriptor must fail closed when a promised merge object is unavailable locally'
  )
  assert(!existsSync(promisorMarker), 'descriptor must not lazy-fetch or execute a promisor remote helper before approval')

  const frozenPromisorRepo = path.join(tempRoot, 'merge-frozen-promisor-repo')
  initMergeFixture(frozenPromisorRepo)
  const frozenPromisorRemote = path.join(tempRoot, 'merge-frozen-promisor-remote.git')
  git(tempRoot, ['clone', '--bare', frozenPromisorRepo, frozenPromisorRemote])
  const frozenPromisorMarker = path.join(tempRoot, 'frozen-promisor-helper-ran.txt')
  const frozenPromisorHelper = path.join(tempRoot, 'frozen-promisor-helper.sh')
  writeFileSync(
    frozenPromisorHelper,
    `#!/bin/sh\ntouch ${JSON.stringify(frozenPromisorMarker)}\nexec git-upload-pack "$1"\n`,
    'utf8'
  )
  chmodSync(frozenPromisorHelper, 0o755)
  git(frozenPromisorRepo, ['remote', 'add', 'origin', `ext::${frozenPromisorHelper} ${frozenPromisorRemote}`])
  git(frozenPromisorRepo, ['config', 'remote.origin.promisor', 'true'])
  git(frozenPromisorRepo, ['config', 'remote.origin.partialclonefilter', 'blob:none'])
  git(frozenPromisorRepo, ['config', 'core.repositoryformatversion', '1'])
  git(frozenPromisorRepo, ['config', 'extensions.partialclone', 'origin'])
  git(frozenPromisorRepo, ['config', 'protocol.ext.allow', 'always'])
  const frozenPromisorDescriptor = await reconciler.buildEffectDescriptor({
    toolName: 'git_merge',
    toolInput: mergeInput,
    cwd: frozenPromisorRepo
  })
  const frozenPromisorExecution = prepareExecutingEffect({
    ledger,
    taskRun,
    taskExecution,
    sessionId: 'merge-frozen-promisor-session',
    toolUseId: 'merge-frozen-promisor-1',
    toolName: 'git_merge',
    toolInput: mergeInput,
    descriptor: frozenPromisorDescriptor,
    cwd: frozenPromisorRepo,
    now: 3450
  })
  const frozenPromisorSha = frozenPromisorDescriptor.target.sourceSha
  rmSync(path.join(frozenPromisorRepo, '.git', 'objects', frozenPromisorSha.slice(0, 2), frozenPromisorSha.slice(2)))
  const frozenPromisorMerge = await gitTools.executeGitTool(
    'git_merge',
    mergeInput,
    frozenPromisorRepo,
    { effectTarget: frozenPromisorDescriptor.target }
  )
  assert(!frozenPromisorMerge.ok, 'effect-bound git_merge must fail closed when a frozen source object disappears')
  assert(!existsSync(frozenPromisorMarker), 'git_merge execution must not lazy-fetch a missing promised object')
  const crashedFrozenPromisorRun = taskExecution.recoverTaskExecutionState(frozenPromisorExecution.run, 3470)
  const frozenPromisorProbe = await reconciler.reconcileEffect(crashedFrozenPromisorRun.effects[0])
  assertEqual(
    frozenPromisorProbe.kind,
    'not_applied',
    'unchanged clean destination must prove the missing-object merge was not applied without lazy fetch'
  )
  assert(!existsSync(frozenPromisorMarker), 'restart reconciliation must not execute a promisor remote helper')

  const mergeExecution = prepareExecutingEffect({
    ledger,
    taskRun,
    taskExecution,
    sessionId: 'merge-session',
    toolUseId: 'merge-1',
    toolName: 'git_merge',
    toolInput: mergeInput,
    descriptor: mergeDescriptor,
    cwd: mergeRepo,
    now: 3500
  })
  git(mergeRepo, ['merge', '--no-ff', '--no-edit', 'feature'])
  const mergedParents = git(mergeRepo, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(/\s+/)
  assertEqual(mergedParents.length, 3, 'successful no-ff merge must create exactly two parents')
  assertEqual(mergedParents[1], mergeDescriptor.target.preHead)
  assertEqual(mergedParents[2], mergeDescriptor.target.sourceSha)
  const crashedMergeRun = taskExecution.recoverTaskExecutionState(mergeExecution.run, 3520)
  const mergeProbe = await reconciler.reconcileEffect(crashedMergeRun.effects[0])
  assertEqual(mergeProbe.kind, 'confirmed', 'exact-parent merge commit must reconcile as confirmed')

  const notAppliedMergeRepo = path.join(tempRoot, 'merge-not-applied-repo')
  initMergeFixture(notAppliedMergeRepo)
  const notAppliedMergeDescriptor = await reconciler.buildEffectDescriptor({
    toolName: 'git_merge',
    toolInput: mergeInput,
    cwd: notAppliedMergeRepo
  })
  const notAppliedMergeExecution = prepareExecutingEffect({
    ledger,
    taskRun,
    taskExecution,
    sessionId: 'merge-not-applied-session',
    toolUseId: 'merge-not-applied-1',
    toolName: 'git_merge',
    toolInput: mergeInput,
    descriptor: notAppliedMergeDescriptor,
    cwd: notAppliedMergeRepo,
    now: 3600
  })
  const crashedNotAppliedMergeRun = taskExecution.recoverTaskExecutionState(notAppliedMergeExecution.run, 3620)
  assertEqual(git(notAppliedMergeRepo, ['status', '--porcelain']).trim(), '')
  assertEqual(
    git(notAppliedMergeRepo, ['rev-parse', 'HEAD']).trim(),
    notAppliedMergeDescriptor.target.preHead
  )
  const notAppliedMergeProbe = await reconciler.reconcileEffect(crashedNotAppliedMergeRun.effects[0])
  assertEqual(
    notAppliedMergeProbe.kind,
    'not_applied',
    'unchanged clean destination must prove a non-ancestor merge was not applied'
  )

  const hiddenIndexMergeRepo = path.join(tempRoot, 'merge-hidden-index-state-repo')
  initMergeFixture(hiddenIndexMergeRepo)
  const hiddenIndexMergeDescriptor = await reconciler.buildEffectDescriptor({
    toolName: 'git_merge',
    toolInput: mergeInput,
    cwd: hiddenIndexMergeRepo
  })
  const hiddenIndexMergeExecution = prepareExecutingEffect({
    ledger,
    taskRun,
    taskExecution,
    sessionId: 'merge-hidden-index-state-session',
    toolUseId: 'merge-hidden-index-state-1',
    toolName: 'git_merge',
    toolInput: mergeInput,
    descriptor: hiddenIndexMergeDescriptor,
    cwd: hiddenIndexMergeRepo,
    now: 3610
  })
  git(hiddenIndexMergeRepo, ['update-index', '--assume-unchanged', 'base.txt'])
  writeFileSync(path.join(hiddenIndexMergeRepo, 'base.txt'), 'local private data\n', 'utf8')
  const crashedHiddenIndexMergeRun = taskExecution.recoverTaskExecutionState(hiddenIndexMergeExecution.run, 3625)
  const hiddenIndexMergeProbe = await reconciler.reconcileEffect(crashedHiddenIndexMergeRun.effects[0])
  assertEqual(
    hiddenIndexMergeProbe.kind,
    'unresolved',
    'assume-unchanged paths must prevent a not_applied retry authorization'
  )
  assertEqual(
    readFileSync(path.join(hiddenIndexMergeRepo, 'base.txt'), 'utf8'),
    'local private data\n',
    'reconciliation must preserve hidden local tracked data'
  )

  const skipWorktreeMergeRepo = path.join(tempRoot, 'merge-skip-worktree-state-repo')
  initMergeFixture(skipWorktreeMergeRepo)
  const skipWorktreeMergeDescriptor = await reconciler.buildEffectDescriptor({
    toolName: 'git_merge',
    toolInput: mergeInput,
    cwd: skipWorktreeMergeRepo
  })
  const skipWorktreeMergeExecution = prepareExecutingEffect({
    ledger,
    taskRun,
    taskExecution,
    sessionId: 'merge-skip-worktree-state-session',
    toolUseId: 'merge-skip-worktree-state-1',
    toolName: 'git_merge',
    toolInput: mergeInput,
    descriptor: skipWorktreeMergeDescriptor,
    cwd: skipWorktreeMergeRepo,
    now: 3615
  })
  git(skipWorktreeMergeRepo, ['update-index', '--skip-worktree', 'base.txt'])
  assert(
    git(skipWorktreeMergeRepo, ['ls-files', '-v', 'base.txt']).startsWith('S '),
    'skip-worktree fixture must expose the normal uppercase S tag'
  )
  const crashedSkipWorktreeMergeRun = taskExecution.recoverTaskExecutionState(skipWorktreeMergeExecution.run, 3627)
  const skipWorktreeMergeProbe = await reconciler.reconcileEffect(crashedSkipWorktreeMergeRun.effects[0])
  assertEqual(
    skipWorktreeMergeProbe.kind,
    'not_applied',
    'an unchanged skip-worktree path must not block a proven not_applied reconciliation'
  )

  const colonMergeRepo = path.join(tempRoot, 'merge-reconcile:colon-repo')
  initMergeFixture(colonMergeRepo)
  const colonMergeDescriptor = await reconciler.buildEffectDescriptor({
    toolName: 'git_merge',
    toolInput: mergeInput,
    cwd: colonMergeRepo
  })
  assert(
    colonMergeDescriptor.target.gitCommonDir.includes(':'),
    'colon-path reconciliation fixture must preserve the colon in gitCommonDir'
  )
  const colonMergeExecution = prepareExecutingEffect({
    ledger,
    taskRun,
    taskExecution,
    sessionId: 'merge-colon-path-session',
    toolUseId: 'merge-colon-path-1',
    toolName: 'git_merge',
    toolInput: mergeInput,
    descriptor: colonMergeDescriptor,
    cwd: colonMergeRepo,
    now: 3630
  })
  const crashedColonMergeRun = taskExecution.recoverTaskExecutionState(colonMergeExecution.run, 3640)
  const colonMergeProbe = await reconciler.reconcileEffect(crashedColonMergeRun.effects[0])
  assertEqual(colonMergeProbe.kind, 'not_applied', 'reconciliation must support gitCommonDir paths containing a colon')

  const unsafeReconcileRepo = path.join(tempRoot, 'merge-unsafe-reconcile-repo')
  initMergeFixture(unsafeReconcileRepo)
  const unsafeReconcileDescriptor = await reconciler.buildEffectDescriptor({
    toolName: 'git_merge',
    toolInput: mergeInput,
    cwd: unsafeReconcileRepo
  })
  const unsafeReconcileExecution = prepareExecutingEffect({
    ledger,
    taskRun,
    taskExecution,
    sessionId: 'merge-unsafe-reconcile-session',
    toolUseId: 'merge-unsafe-reconcile-1',
    toolName: 'git_merge',
    toolInput: mergeInput,
    descriptor: unsafeReconcileDescriptor,
    cwd: unsafeReconcileRepo,
    now: 3650
  })
  const unsafeReconcileMarker = path.join(tempRoot, 'unsafe-reconcile-driver-ran.txt')
  const unsafeReconcileDriver = path.join(tempRoot, 'unsafe-reconcile-driver.sh')
  writeFileSync(
    unsafeReconcileDriver,
    `#!/bin/sh\ntouch ${JSON.stringify(unsafeReconcileMarker)}\ncp "$3" "$2"\n`,
    'utf8'
  )
  chmodSync(unsafeReconcileDriver, 0o755)
  git(unsafeReconcileRepo, ['config', 'merge.default', 'evil'])
  git(unsafeReconcileRepo, ['config', 'merge.evil.driver', `${unsafeReconcileDriver} %O %A %B`])
  const crashedUnsafeReconcileRun = taskExecution.recoverTaskExecutionState(unsafeReconcileExecution.run, 3660)
  const unsafeReconcileProbe = await reconciler.reconcileEffect(crashedUnsafeReconcileRun.effects[0])
  assertEqual(unsafeReconcileProbe.kind, 'unresolved', 'unsafe config added after prepare must fail reconciliation closed')
  assert(
    unsafeReconcileProbe.reason.includes('命令型 merge/filter 配置'),
    `unsafe config must be the reason reconciliation stops before merge-tree: ${unsafeReconcileProbe.reason}`
  )
  assert(!existsSync(unsafeReconcileMarker), 'reconciliation must reject unsafe config before running merge-tree')

  const alreadyMergedRepo = path.join(tempRoot, 'merge-already-ancestor-repo')
  initAncestorMergeFixture(alreadyMergedRepo)
  const alreadyMergedDescriptor = await reconciler.buildEffectDescriptor({
    toolName: 'git_merge',
    toolInput: mergeInput,
    cwd: alreadyMergedRepo
  })
  assertEqual(alreadyMergedDescriptor.target.kind, 'git_merge')
  assertEqual(alreadyMergedDescriptor.target.sourceWasAncestor, true)
  const alreadyMergedExecution = prepareExecutingEffect({
    ledger,
    taskRun,
    taskExecution,
    sessionId: 'merge-already-ancestor-session',
    toolUseId: 'merge-already-ancestor-1',
    toolName: 'git_merge',
    toolInput: mergeInput,
    descriptor: alreadyMergedDescriptor,
    cwd: alreadyMergedRepo,
    now: 3700
  })
  const crashedAlreadyMergedRun = taskExecution.recoverTaskExecutionState(alreadyMergedExecution.run, 3720)
  const alreadyMergedProbe = await reconciler.reconcileEffect(crashedAlreadyMergedRun.effects[0])
  assertEqual(alreadyMergedProbe.kind, 'confirmed', 'already-ancestor merge must reconcile as a confirmed no-op')

  const reachableMergeRepo = path.join(tempRoot, 'merge-reachable-candidate-repo')
  initMergeFixture(reachableMergeRepo)
  const reachableMergeDescriptor = await reconciler.buildEffectDescriptor({
    toolName: 'git_merge',
    toolInput: mergeInput,
    cwd: reachableMergeRepo
  })
  const reachableMergeExecution = prepareExecutingEffect({
    ledger,
    taskRun,
    taskExecution,
    sessionId: 'merge-reachable-candidate-session',
    toolUseId: 'merge-reachable-candidate-1',
    toolName: 'git_merge',
    toolInput: mergeInput,
    descriptor: reachableMergeDescriptor,
    cwd: reachableMergeRepo,
    now: 3800
  })
  git(reachableMergeRepo, ['merge', '--no-ff', '--no-edit', 'feature'])
  const reachableMergeSha = git(reachableMergeRepo, ['rev-parse', 'HEAD']).trim()
  writeFileSync(path.join(reachableMergeRepo, 'after-merge.txt'), 'destination advanced\n', 'utf8')
  git(reachableMergeRepo, ['add', 'after-merge.txt'])
  git(reachableMergeRepo, ['commit', '-m', 'advance destination after merge'])
  assert(
    git(reachableMergeRepo, ['merge-base', '--is-ancestor', reachableMergeSha, 'refs/heads/main']) === '',
    'unique merge candidate must remain reachable from destination'
  )
  const crashedReachableMergeRun = taskExecution.recoverTaskExecutionState(reachableMergeExecution.run, 3820)
  const reachableMergeProbe = await reconciler.reconcileEffect(crashedReachableMergeRun.effects[0])
  assertEqual(
    reachableMergeProbe.kind,
    'confirmed',
    'one reachable exact-parent merge candidate must remain confirmable after destination advances'
  )

  const conflictingStateMergeRepo = path.join(tempRoot, 'merge-candidate-with-conflicting-state-repo')
  initMergeFixture(conflictingStateMergeRepo)
  const conflictingStateMergeDescriptor = await reconciler.buildEffectDescriptor({
    toolName: 'git_merge',
    toolInput: mergeInput,
    cwd: conflictingStateMergeRepo
  })
  const conflictingStateMergeExecution = prepareExecutingEffect({
    ledger,
    taskRun,
    taskExecution,
    sessionId: 'merge-candidate-conflicting-state-session',
    toolUseId: 'merge-candidate-conflicting-state-1',
    toolName: 'git_merge',
    toolInput: mergeInput,
    descriptor: conflictingStateMergeDescriptor,
    cwd: conflictingStateMergeRepo,
    now: 3850
  })
  git(conflictingStateMergeRepo, ['merge', '--no-ff', '--no-edit', 'feature'])
  const conflictingStateCandidate = git(conflictingStateMergeRepo, ['rev-parse', 'HEAD']).trim()
  git(conflictingStateMergeRepo, ['switch', '-c', 'conflict-source'])
  writeFileSync(path.join(conflictingStateMergeRepo, 'conflict.txt'), 'source\n', 'utf8')
  git(conflictingStateMergeRepo, ['add', 'conflict.txt'])
  git(conflictingStateMergeRepo, ['commit', '-m', 'conflicting source'])
  git(conflictingStateMergeRepo, ['switch', 'main'])
  writeFileSync(path.join(conflictingStateMergeRepo, 'conflict.txt'), 'destination\n', 'utf8')
  git(conflictingStateMergeRepo, ['add', 'conflict.txt'])
  git(conflictingStateMergeRepo, ['commit', '-m', 'conflicting destination'])
  assert(gitFails(conflictingStateMergeRepo, ['merge', '--no-edit', 'conflict-source']), 'fixture must enter a conflicting merge state')
  assert(existsSync(path.join(conflictingStateMergeRepo, '.git', 'MERGE_HEAD')), 'fixture must retain MERGE_HEAD')
  assert(
    git(conflictingStateMergeRepo, ['ls-files', '--unmerged']).trim().length > 0,
    'fixture must retain unmerged index entries'
  )
  assert(
    git(conflictingStateMergeRepo, ['merge-base', '--is-ancestor', conflictingStateCandidate, 'refs/heads/main']) === '',
    'the exact merge candidate must remain reachable while the later merge is conflicted'
  )
  const crashedConflictingStateMergeRun = taskExecution.recoverTaskExecutionState(conflictingStateMergeExecution.run, 3870)
  const conflictingStateMergeProbe = await reconciler.reconcileEffect(crashedConflictingStateMergeRun.effects[0])
  assertEqual(
    conflictingStateMergeProbe.kind,
    'unresolved',
    'a reachable unique merge candidate must not confirm while MERGE_HEAD or unmerged entries remain'
  )

  const driftedMergeRepo = path.join(tempRoot, 'merge-destination-drift-repo')
  initMergeFixture(driftedMergeRepo)
  const driftedMergeDescriptor = await reconciler.buildEffectDescriptor({
    toolName: 'git_merge',
    toolInput: mergeInput,
    cwd: driftedMergeRepo
  })
  const driftedMergeExecution = prepareExecutingEffect({
    ledger,
    taskRun,
    taskExecution,
    sessionId: 'merge-destination-drift-session',
    toolUseId: 'merge-destination-drift-1',
    toolName: 'git_merge',
    toolInput: mergeInput,
    descriptor: driftedMergeDescriptor,
    cwd: driftedMergeRepo,
    now: 3900
  })
  writeFileSync(path.join(driftedMergeRepo, 'unrelated.txt'), 'unrelated destination drift\n', 'utf8')
  git(driftedMergeRepo, ['add', 'unrelated.txt'])
  git(driftedMergeRepo, ['commit', '-m', 'unrelated destination drift'])
  const crashedDriftedMergeRun = taskExecution.recoverTaskExecutionState(driftedMergeExecution.run, 3920)
  const driftedMergeProbe = await reconciler.reconcileEffect(crashedDriftedMergeRun.effects[0])
  assertEqual(driftedMergeProbe.kind, 'unresolved', 'destination drift without a merge candidate must fail closed')

  const wrongTreeMergeRepo = path.join(tempRoot, 'merge-wrong-tree-repo')
  initMergeFixture(wrongTreeMergeRepo)
  const wrongTreeMergeDescriptor = await reconciler.buildEffectDescriptor({
    toolName: 'git_merge',
    toolInput: mergeInput,
    cwd: wrongTreeMergeRepo
  })
  const wrongTreeMergeExecution = prepareExecutingEffect({
    ledger,
    taskRun,
    taskExecution,
    sessionId: 'merge-wrong-tree-session',
    toolUseId: 'merge-wrong-tree-1',
    toolName: 'git_merge',
    toolInput: mergeInput,
    descriptor: wrongTreeMergeDescriptor,
    cwd: wrongTreeMergeRepo,
    now: 3930
  })
  const wrongTreeCandidate = git(wrongTreeMergeRepo, [
    'commit-tree',
    wrongTreeMergeDescriptor.target.preTree,
    '-p',
    wrongTreeMergeDescriptor.target.preHead,
    '-p',
    wrongTreeMergeDescriptor.target.sourceSha,
    '-m',
    'fake merge that discards source tree'
  ]).trim()
  git(wrongTreeMergeRepo, [
    'update-ref',
    wrongTreeMergeDescriptor.target.destinationRef,
    wrongTreeCandidate,
    wrongTreeMergeDescriptor.target.preHead
  ])
  const crashedWrongTreeMergeRun = taskExecution.recoverTaskExecutionState(wrongTreeMergeExecution.run, 3940)
  const wrongTreeObjectsBefore = gitObjectInventory(wrongTreeMergeRepo)
  const wrongTreeMergeProbe = await reconciler.reconcileEffect(crashedWrongTreeMergeRun.effects[0])
  assertEqual(wrongTreeMergeProbe.kind, 'unresolved', 'exact parents with the wrong tree must never confirm')
  assertEqual(
    JSON.stringify(gitObjectInventory(wrongTreeMergeRepo)),
    JSON.stringify(wrongTreeObjectsBefore),
    'wrong-tree reconciliation must compute expected merge objects outside the repository object database'
  )

  const ambiguousMergeRepo = path.join(tempRoot, 'merge-ambiguous-candidates-repo')
  initMergeFixture(ambiguousMergeRepo)
  const ambiguousMergeDescriptor = await reconciler.buildEffectDescriptor({
    toolName: 'git_merge',
    toolInput: mergeInput,
    cwd: ambiguousMergeRepo
  })
  const ambiguousMergeExecution = prepareExecutingEffect({
    ledger,
    taskRun,
    taskExecution,
    sessionId: 'merge-ambiguous-candidates-session',
    toolUseId: 'merge-ambiguous-candidates-1',
    toolName: 'git_merge',
    toolInput: mergeInput,
    descriptor: ambiguousMergeDescriptor,
    cwd: ambiguousMergeRepo,
    now: 3950
  })
  const ambiguousTree = expectedMergeTree(
    ambiguousMergeRepo,
    ambiguousMergeDescriptor.target.preHead,
    ambiguousMergeDescriptor.target.sourceSha
  )
  const ambiguousCandidateOne = git(ambiguousMergeRepo, [
    'commit-tree',
    ambiguousTree,
    '-p',
    ambiguousMergeDescriptor.target.preHead,
    '-p',
    ambiguousMergeDescriptor.target.sourceSha,
    '-m',
    'candidate one'
  ]).trim()
  const ambiguousCandidateTwo = git(ambiguousMergeRepo, [
    'commit-tree',
    ambiguousTree,
    '-p',
    ambiguousMergeDescriptor.target.preHead,
    '-p',
    ambiguousMergeDescriptor.target.sourceSha,
    '-m',
    'candidate two'
  ]).trim()
  const ambiguousCollector = git(ambiguousMergeRepo, [
    'commit-tree',
    ambiguousTree,
    '-p',
    ambiguousCandidateOne,
    '-p',
    ambiguousCandidateTwo,
    '-m',
    'ambiguous collector'
  ]).trim()
  git(ambiguousMergeRepo, [
    'update-ref',
    ambiguousMergeDescriptor.target.destinationRef,
    ambiguousCollector,
    ambiguousMergeDescriptor.target.preHead
  ])
  git(ambiguousMergeRepo, ['reset', '--hard', ambiguousCollector])
  const exactParentCandidates = git(ambiguousMergeRepo, [
    'rev-list',
    '--parents',
    ambiguousMergeDescriptor.target.destinationRef
  ])
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter(([, ...parents]) => {
      return parents.length === 2 &&
        parents[0] === ambiguousMergeDescriptor.target.preHead &&
        parents[1] === ambiguousMergeDescriptor.target.sourceSha
    })
  assertEqual(exactParentCandidates.length, 2, 'fixture must expose two reachable exact-parent candidates')
  for (const [candidate] of exactParentCandidates) {
    assertEqual(
      git(ambiguousMergeRepo, ['rev-parse', `${candidate}^{tree}`]).trim(),
      ambiguousTree,
      'each ambiguous exact-parent candidate must use the recomputed expected merge tree'
    )
  }
  assertEqual(git(ambiguousMergeRepo, ['status', '--porcelain']).trim(), '')
  const crashedAmbiguousMergeRun = taskExecution.recoverTaskExecutionState(ambiguousMergeExecution.run, 3970)
  const ambiguousMergeProbe = await reconciler.reconcileEffect(crashedAmbiguousMergeRun.effects[0])
  assertEqual(ambiguousMergeProbe.kind, 'unresolved', 'multiple reachable exact-parent candidates must remain ambiguous')

  const mergeLockRepo = path.join(tempRoot, 'merge-resource-lock-repo')
  initMergeFixture(mergeLockRepo)
  const mergeLockDescriptor = await reconciler.buildEffectDescriptor({
    toolName: 'git_merge',
    toolInput: mergeInput,
    cwd: mergeLockRepo
  })
  writeFileSync(path.join(mergeLockRepo, 'staged.txt'), 'staged for competing commit\n', 'utf8')
  git(mergeLockRepo, ['add', 'staged.txt'])
  const competingCommitInput = { message: 'competing branch mutation' }
  const competingCommitDescriptor = await reconciler.buildEffectDescriptor({
    toolName: 'git_commit',
    toolInput: competingCommitInput,
    cwd: mergeLockRepo
  })
  const mergeLockRun = runWithTool(
    taskRun,
    taskExecution,
    'merge-lock-session',
    'merge-lock-1',
    'git_merge',
    mergeInput,
    mergeLockRepo
  )
  const preparedMergeLock = ledger.prepareEffect(mergeLockRun, {
    sessionId: mergeLockRun.sessionId,
    cwd: mergeLockRepo,
    toolUseId: 'merge-lock-1',
    toolName: 'git_merge',
    descriptor: mergeLockDescriptor,
    ownerId: 'merge-lock-worker',
    now: 3980
  })
  const commitLockRun = runWithTool(
    taskRun,
    taskExecution,
    'commit-lock-session',
    'commit-lock-1',
    'git_commit',
    competingCommitInput,
    mergeLockRepo
  )
  const preparedCommitLock = ledger.prepareEffect(commitLockRun, {
    sessionId: commitLockRun.sessionId,
    cwd: mergeLockRepo,
    toolUseId: 'commit-lock-1',
    toolName: 'git_commit',
    descriptor: competingCommitDescriptor,
    ownerId: 'commit-lock-worker',
    now: 3981
  })
  assertEqual(
    preparedMergeLock.handle.resourceKey,
    preparedCommitLock.handle.resourceKey,
    'git_merge and git_commit on one destination ref must share the local branch resource key'
  )
  const legacyCommitTarget = {
    kind: 'git_commit',
    repoRoot: realpathSync(mergeLockRepo),
    branch: 'main',
    preHead: competingCommitDescriptor.target.preHead,
    stagedDiffDigest: competingCommitDescriptor.target.stagedDiffDigest,
    messageDigest: competingCommitDescriptor.target.messageDigest
  }
  const legacyTargetDigest = idempotency.stableValueDigest(legacyCommitTarget)
  const legacyCommitDescriptor = {
    ...competingCommitDescriptor,
    target: legacyCommitTarget,
    targetDigest: legacyTargetDigest,
    intentDigest: idempotency.stableValueDigest({
      toolName: 'git_commit',
      targetDigest: legacyTargetDigest,
      inputDigest: competingCommitDescriptor.inputDigest
    })
  }
  const legacyCommitRun = runWithTool(
    taskRun,
    taskExecution,
    'legacy-commit-lock-session',
    'legacy-commit-lock-1',
    'git_commit',
    competingCommitInput,
    mergeLockRepo
  )
  const preparedLegacyCommitLock = ledger.prepareEffect(legacyCommitRun, {
    sessionId: legacyCommitRun.sessionId,
    cwd: mergeLockRepo,
    toolUseId: 'legacy-commit-lock-1',
    toolName: 'git_commit',
    descriptor: legacyCommitDescriptor,
    ownerId: 'legacy-commit-lock-worker',
    now: 3981.5
  })
  const knownLegacyCommitResourceKey = `resource-v1:${idempotency.stableValueDigest({
    scope: 'git-local-ref',
    repoRoot: realpathSync(mergeLockRepo),
    ref: 'refs/heads/main'
  })}`
  assertEqual(
    preparedLegacyCommitLock.handle.resourceKey,
    knownLegacyCommitResourceKey,
    'literal legacy git_commit target must retain the known resource-v1 local-ref key'
  )
  const mergeLockStore = path.join(tempRoot, 'merge-resource-lock-store')
  await snapshotStore.saveTaskSnapshot(
    effectSnapshot(snapshotStore, legacyCommitRun, mergeLockRepo, 3982),
    mergeLockStore
  )
  const persistedLegacyCommitLock = await snapshotStore.saveTaskRunBarrier(
    preparedLegacyCommitLock.run,
    mergeLockStore
  )
  assertEqual(
    persistedLegacyCommitLock.effects[0].resourceKey,
    knownLegacyCommitResourceKey,
    'the literal legacy git_commit resource key must survive durable persistence'
  )
  await snapshotStore.saveTaskSnapshot(
    effectSnapshot(snapshotStore, mergeLockRun, mergeLockRepo, 3983),
    mergeLockStore
  )
  await assertRejectsMatching(
    () => snapshotStore.saveTaskRunBarrier(preparedMergeLock.run, mergeLockStore),
    /其他会话仍未收敛|same resource/,
    'git_merge must conflict with a persisted legacy git_commit lease on the same destination ref'
  )

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

function prepareExecutingEffect({
  ledger,
  taskRun,
  taskExecution,
  sessionId,
  toolUseId,
  toolName,
  toolInput,
  descriptor,
  cwd,
  now
}) {
  const baseRun = runWithTool(taskRun, taskExecution, sessionId, toolUseId, toolName, toolInput, cwd)
  const prepared = ledger.prepareEffect(baseRun, {
    sessionId,
    cwd,
    toolUseId,
    toolName,
    descriptor,
    ownerId: `${sessionId}-worker`,
    now
  })
  return {
    baseRun,
    prepared,
    run: ledger.markEffectExecuting(prepared.run, prepared.handle, now + 10)
  }
}

function initMergeFixture(dir) {
  initRepo(dir)
  writeFileSync(path.join(dir, 'base.txt'), 'base\n', 'utf8')
  git(dir, ['add', 'base.txt'])
  git(dir, ['commit', '-m', 'merge base'])
  git(dir, ['switch', '-c', 'feature'])
  writeFileSync(path.join(dir, 'feature.txt'), 'feature\n', 'utf8')
  git(dir, ['add', 'feature.txt'])
  git(dir, ['commit', '-m', 'feature change'])
  git(dir, ['switch', 'main'])
  writeFileSync(path.join(dir, 'main.txt'), 'main\n', 'utf8')
  git(dir, ['add', 'main.txt'])
  git(dir, ['commit', '-m', 'main change'])
}

function initAncestorMergeFixture(dir) {
  initRepo(dir)
  writeFileSync(path.join(dir, 'base.txt'), 'base\n', 'utf8')
  git(dir, ['add', 'base.txt'])
  git(dir, ['commit', '-m', 'ancestor base'])
  git(dir, ['branch', 'feature'])
  writeFileSync(path.join(dir, 'main.txt'), 'main after ancestor\n', 'utf8')
  git(dir, ['add', 'main.txt'])
  git(dir, ['commit', '-m', 'main after ancestor'])
}

function expectedMergeTree(dir, preHead, sourceSha) {
  const tree = git(dir, ['merge-tree', '--write-tree', preHead, sourceSha]).split(/\r?\n/, 1)[0]?.trim()
  assert(/^[0-9a-f]{40,64}$/i.test(tree ?? ''), `merge-tree did not return an expected tree: ${JSON.stringify(tree)}`)
  return tree
}

function gitObjectInventory(dir) {
  const objectsRoot = path.join(dir, '.git', 'objects')
  const inventory = []
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) visit(fullPath)
      else if (entry.isFile()) inventory.push(path.relative(objectsRoot, fullPath))
    }
  }
  visit(objectsRoot)
  return inventory.sort()
}

function effectSnapshot(snapshotStore, run, cwd, now) {
  const messageId = `${run.sessionId}-message`
  return snapshotStore.buildTaskSnapshot({
    meta: {
      id: run.sessionId,
      title: 'effect resource lock smoke',
      cwd,
      sourceCwd: cwd,
      repoRoot: cwd,
      model: 'gpt-4.1',
      providerId: 'effect-smoke-provider',
      engine: 'openai',
      permissionMode: 'default',
      status: 'running',
      costUsd: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      contextTokens: 0,
      createdAt: run.createdAt
    },
    transcript: [{ seq: 1, event: { kind: 'user-message', messageId, text: 'effect resource lock smoke' } }],
    lastSeq: 1,
    lastEventKind: 'user-message',
    eventCount: 1,
    reason: 'important-event',
    run,
    now
  })
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

function gitFails(cwd, args) {
  try {
    git(cwd, args)
    return false
  } catch {
    return true
  }
}

function assertIdentityRecord(identity, name) {
  assert(identity && typeof identity.device === 'string' && identity.device.length > 0, `${name} must freeze device identity`)
  assert(identity && typeof identity.inode === 'string' && identity.inode.length > 0, `${name} must freeze inode identity`)
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
