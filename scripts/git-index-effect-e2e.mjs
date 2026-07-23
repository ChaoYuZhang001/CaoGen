import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-git-index-effect-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
const cleanGitEnv = sanitizedGitEnvironment(process.env)

process.env.CAOGEN_TEST_USER_DATA = userData
process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter)
require('node:module').Module._initPaths()

try {
  compileSources()
  installElectronStub()
  const modules = loadModules()
  operationModeCases(modules)
  await agentToolCases(modules)
  reconciliationCases(modules)
  await acknowledgementLossCases(modules)
  await invalidInputCases(modules)
  await isolationCases(modules)
  await sameIndexLeaseCase(modules)
  await semanticCommitConflictCase(modules)
  await opaqueMultiEditConflictCase(modules)
  await linkedWorktreeConcurrencyCase(modules)
  await lockOwnershipCase(modules)
  objectDirectorySymlinkCase(modules.indexEffect)
  console.log('git index effect e2e: PASS')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

async function agentToolCases({ gitTools, indexEffect, gateway }) {
  const selectedRepo = createRepo('agent-tool-stage-selected', { 'a.txt': 'a0\n', 'b.txt': 'b0\n' })
  writeFileSync(path.join(selectedRepo, 'a.txt'), 'a0\na1\n')
  writeFileSync(path.join(selectedRepo, 'b.txt'), 'b0\nb1\n')
  const selectedInput = effectInput('git_stage', selectedRepo, { paths: ['a.txt'] })
  const missingTarget = await gitTools.executeGitTool(
    selectedInput.toolName,
    selectedInput.toolInput,
    selectedRepo
  )
  assert(!missingTarget.ok, 'Agent git_stage must fail closed without a frozen target')
  assertDeepEqual(cachedNames(selectedRepo), [])
  const bindingTarget = indexEffect.buildGitIndexEffectTarget(selectedInput)
  const differentPaths = await gitTools.executeGitTool(
    selectedInput.toolName,
    { paths: ['b.txt'] },
    selectedRepo,
    { effectTarget: bindingTarget }
  )
  assert(!differentPaths.ok, 'Agent git_stage must reject same-operation path drift')
  assert(String(differentPaths.output).includes('调用路径与冻结目标不一致'))
  assertDeepEqual(cachedNames(selectedRepo), [])
  const alternateRepo = createRepo('agent-tool-stage-alternate-cwd', { 'a.txt': 'alternate0\n' })
  writeFileSync(path.join(alternateRepo, 'a.txt'), 'alternate1\n')
  const differentCwd = await gitTools.executeGitTool(
    selectedInput.toolName,
    selectedInput.toolInput,
    alternateRepo,
    { effectTarget: bindingTarget }
  )
  assert(!differentCwd.ok, 'Agent git_stage must reject a target frozen for another repository or worktree')
  assert(String(differentCwd.output).includes('调用 cwd 与冻结仓库或 worktree 身份不一致'))
  assertDeepEqual(cachedNames(selectedRepo), [])
  assertDeepEqual(cachedNames(alternateRepo), [])
  const selectedOutcome = await gateway.executeInteractiveOperationEffect(operationSpec(
    'agent-tool-stage-selected',
    selectedInput,
    (effect) => gitTools.executeGitTool(
      selectedInput.toolName,
      selectedInput.toolInput,
      selectedRepo,
      { effectTarget: effect.target }
    )
  ))
  assertEqual(selectedOutcome.status, 'completed')
  assertEqual(selectedOutcome.effectStatus, 'confirmed')
  assertDeepEqual(cachedNames(selectedRepo), ['a.txt'])

  const broadRepo = createRepo('agent-tool-stage-all', { 'tracked.txt': 'before\n', 'deleted.txt': 'delete\n' })
  writeFileSync(path.join(broadRepo, 'tracked.txt'), 'after\n')
  unlinkSync(path.join(broadRepo, 'deleted.txt'))
  writeFileSync(path.join(broadRepo, 'new.txt'), 'new\n')
  const broadInput = effectInput('git_stage_all', broadRepo)
  const broadOutcome = await gateway.executeInteractiveOperationEffect(operationSpec(
    'agent-tool-stage-all',
    broadInput,
    (effect) => gitTools.executeGitTool(
      broadInput.toolName,
      broadInput.toolInput,
      broadRepo,
      { effectTarget: effect.target }
    )
  ))
  assertEqual(broadOutcome.status, 'completed')
  assertEqual(broadOutcome.effectStatus, 'confirmed')
  assertDeepEqual(cachedNames(broadRepo), ['deleted.txt', 'new.txt', 'tracked.txt'])

  const mismatchedTarget = indexEffect.buildGitIndexEffectTarget(effectInput('git_stage_all', selectedRepo))
  const beforeMismatch = indexDigest(selectedRepo)
  const mismatch = await gitTools.executeGitTool(
    'git_stage',
    { paths: ['b.txt'] },
    selectedRepo,
    { effectTarget: mismatchedTarget }
  )
  assert(!mismatch.ok, 'Agent git_stage must reject a frozen stage_all target')
  assertEqual(indexDigest(selectedRepo), beforeMismatch, 'mismatched Agent target must not mutate the index')
}

function operationModeCases({ indexEffect }) {
  stageSelectedCase(indexEffect)
  stageAllCase(indexEffect)
  unstageCase(indexEffect)
  applyHunkCase(indexEffect)
  splitIndexCase(indexEffect)
  unbornStageAndUnstageCase(indexEffect)
}

function stageSelectedCase(indexEffect) {
  const repo = createRepo('stage-selected', { 'a.txt': 'a0\n', 'b.txt': 'b0\n' })
  writeFileSync(path.join(repo, 'a.txt'), 'a0\na1\n')
  writeFileSync(path.join(repo, 'b.txt'), 'b0\nb1\n')
  writeFileSync(path.join(repo, 'new.txt'), 'new\n')
  const before = indexDigest(repo)
  const input = effectInput('git_stage', repo, { paths: ['new.txt', 'a.txt', 'a.txt'] })
  const target = indexEffect.buildGitIndexEffectTarget(input)
  assertEqual(indexDigest(repo), before, 'target planning must not mutate the real index')
  assertEqual(target.operation, 'stage_paths')
  assertDeepEqual(target.paths, ['a.txt', 'new.txt'])
  assertEqual(indexEffect.reconcileGitIndexEffectTarget(target).kind, 'not_applied')
  assert(indexEffect.executeGitIndexEffectTarget(target, input).ok)
  assertDeepEqual(cachedNames(repo), ['a.txt', 'new.txt'])
  assertDeepEqual(worktreeNames(repo), ['b.txt'])
  assertEqual(indexEffect.reconcileGitIndexEffectTarget(target).kind, 'confirmed')
}

function stageAllCase(indexEffect) {
  const repo = createRepo('stage-all', {
    'keep.txt': 'keep0\n',
    'delete.txt': 'delete\n'
  })
  writeFileSync(path.join(repo, 'keep.txt'), 'keep0\nkeep1\n')
  unlinkSync(path.join(repo, 'delete.txt'))
  mkdirSync(path.join(repo, 'nested'))
  writeFileSync(path.join(repo, 'nested', 'new.txt'), 'new\n')
  const input = effectInput('git_stage_all', repo)
  const target = indexEffect.buildGitIndexEffectTarget(input)
  assertEqual(target.operation, 'stage_all')
  assertEqual(target.worktreeReadScope, 'all')
  assert(indexEffect.executeGitIndexEffectTarget(target, input).ok)
  assertDeepEqual(cachedNames(repo), ['delete.txt', 'keep.txt', 'nested/new.txt'])
  assertDeepEqual(worktreeNames(repo), [])
}

function unstageCase(indexEffect) {
  const repo = createRepo('unstage', { 'a.txt': 'a0\n', 'b.txt': 'b0\n' })
  writeFileSync(path.join(repo, 'a.txt'), 'a0\na1\n')
  writeFileSync(path.join(repo, 'b.txt'), 'b0\nb1\n')
  git(repo, ['add', '--', 'a.txt', 'b.txt'])
  const input = effectInput('git_unstage', repo, { paths: ['a.txt'] })
  const target = indexEffect.buildGitIndexEffectTarget(input)
  assertEqual(target.operation, 'unstage_paths')
  assertEqual(target.worktreeReadScope, 'none')
  assert(indexEffect.executeGitIndexEffectTarget(target, input).ok)
  assertDeepEqual(cachedNames(repo), ['b.txt'])
  assertDeepEqual(worktreeNames(repo), ['a.txt'])
}

function applyHunkCase(indexEffect) {
  const repo = createRepo('apply-hunk', { 'app.txt': 'line0\nline1\nline2\n' })
  writeFileSync(path.join(repo, 'app.txt'), 'line0\nchanged\nline2\n')
  const patch = git(repo, ['diff', '--binary', '--', 'app.txt'])
  const input = effectInput('workspace_apply_hunk', repo, { filePath: 'app.txt', hunkPatch: patch })
  const target = indexEffect.buildGitIndexEffectTarget(input)
  assertEqual(target.operation, 'apply_cached_hunk')
  assertEqual(target.patchSha256, sha256(Buffer.from(patch)))
  assert(indexEffect.executeGitIndexEffectTarget(target, input).ok)
  assertDeepEqual(cachedNames(repo), ['app.txt'])
  assertEqual(indexEffect.reconcileGitIndexEffectTarget(target).kind, 'confirmed')
}

function splitIndexCase(indexEffect) {
  const repo = createRepo('split-index', { 'a.txt': 'a0\n' })
  assert(process.cwd() !== repo, 'fixture requires process cwd and repository cwd to differ')
  git(repo, ['config', 'core.splitIndex', 'true'])
  git(repo, ['update-index', '--split-index'])
  const sharedIndex = git(repo, ['rev-parse', '--path-format=absolute', '--shared-index-path']).trim()
  assert(sharedIndex && existsSync(sharedIndex), 'split-index fixture must have a resolvable shared index')
  writeFileSync(path.join(repo, 'a.txt'), 'a0\na1\n')
  const input = effectInput('git_stage', repo, { paths: ['a.txt'] })
  const target = indexEffect.buildGitIndexEffectTarget(input)
  assert(indexEffect.executeGitIndexEffectTarget(target, input).ok)
  assertDeepEqual(cachedNames(repo), ['a.txt'])
  assertEqual(indexEffect.reconcileGitIndexEffectTarget(target).kind, 'confirmed')
}

function unbornStageAndUnstageCase(indexEffect) {
  const repo = path.join(tempRoot, 'unborn-stage-unstage')
  mkdirSync(repo)
  git(repo, ['init', '-b', 'main'])
  writeFileSync(path.join(repo, 'new.txt'), 'unborn\n')
  const stageInput = effectInput('git_stage', repo, { paths: ['new.txt'] })
  const stageTarget = indexEffect.buildGitIndexEffectTarget(stageInput)
  assertEqual(stageTarget.preHeadState, 'unborn')
  assert(indexEffect.executeGitIndexEffectTarget(stageTarget, stageInput).ok)
  assertDeepEqual(cachedNames(repo), ['new.txt'])
  const unstageInput = effectInput('git_unstage', repo, { paths: ['new.txt'] })
  const unstageTarget = indexEffect.buildGitIndexEffectTarget(unstageInput)
  assertEqual(unstageTarget.preHeadState, 'unborn')
  assert(indexEffect.executeGitIndexEffectTarget(unstageTarget, unstageInput).ok)
  assertDeepEqual(cachedNames(repo), [])
  assertEqual(indexEffect.reconcileGitIndexEffectTarget(unstageTarget).kind, 'confirmed')
}

function reconciliationCases({ indexEffect }) {
  const repo = createRepo('reconciliation', { 'a.txt': 'a0\n', 'b.txt': 'b0\n' })
  writeFileSync(path.join(repo, 'a.txt'), 'a0\na1\n')
  writeFileSync(path.join(repo, 'b.txt'), 'b0\nb1\n')
  const input = effectInput('git_stage', repo, { paths: ['a.txt'] })
  const target = indexEffect.buildGitIndexEffectTarget(input)
  const initialDigest = indexDigest(repo)
  const notApplied = indexEffect.reconcileGitIndexEffectTarget(target)
  assertEqual(notApplied.kind, 'not_applied')
  assertEqual(indexDigest(repo), initialDigest, 'read-only reconciliation must not mutate index')
  git(repo, ['add', '--', 'b.txt'])
  const unresolved = indexEffect.reconcileGitIndexEffectTarget(target)
  assertEqual(unresolved.kind, 'unresolved')
  assert(String(unresolved.reason).includes('既不是执行前状态，也不是冻结预期状态'))
}

async function acknowledgementLossCases({ indexEffect, gateway, snapshotStore }) {
  for (const [index, mode] of ['git_stage', 'git_stage_all', 'git_unstage', 'workspace_apply_hunk'].entries()) {
    const fixture = acknowledgementFixture(mode, index)
    let calls = 0
    const outcome = await gateway.executeInteractiveOperationEffect({
      operationId: `ack-loss-${index}`,
      kind: 'git_index_update',
      title: `ack loss ${mode}`,
      sourceSessionId: `ack-source-${index}`,
      cwd: fixture.repo,
      toolName: mode,
      toolInput: fixture.input.toolInput,
      execute: (effect) => {
        calls += 1
        assertEqual(effect.target.kind, 'git_index_update')
        const result = indexEffect.executeGitIndexEffectTarget(effect.target, fixture.input)
        assert(result.ok, JSON.stringify(result))
        if (index % 2 === 1) throw new Error('simulated acknowledgement loss')
        return { ok: false, error: 'simulated acknowledgement loss' }
      },
      isSuccess: (result) => result.ok
    })
    assertEqual(outcome.status, 'completed', `${mode} must reconcile a lost acknowledgement`)
    assertEqual(outcome.effectStatus, 'confirmed')
    assertEqual(calls, 1)
    fixture.verify()
    assertEqual(await snapshotStore.getTaskSnapshot(`operation:ack-loss-${index}`), null)
  }
}

function acknowledgementFixture(mode, index) {
  const repo = createRepo(`ack-${index}`, { 'a.txt': 'a0\n', 'b.txt': 'b0\n' })
  writeFileSync(path.join(repo, 'a.txt'), 'a0\na1\n')
  writeFileSync(path.join(repo, 'b.txt'), 'b0\nb1\n')
  if (mode === 'git_unstage') git(repo, ['add', '--', 'a.txt', 'b.txt'])
  const patch = mode === 'workspace_apply_hunk' ? git(repo, ['diff', '--binary', '--', 'a.txt']) : undefined
  const toolInput = mode === 'git_stage'
    ? { paths: ['a.txt'] }
    : mode === 'git_unstage'
      ? { paths: ['a.txt'] }
      : mode === 'workspace_apply_hunk'
        ? { filePath: 'a.txt', hunkPatch: patch }
        : {}
  const expected = mode === 'git_stage_all' ? ['a.txt', 'b.txt'] : mode === 'git_unstage' ? ['b.txt'] : ['a.txt']
  return {
    repo,
    input: effectInput(mode, repo, toolInput),
    verify: () => assertDeepEqual(cachedNames(repo), expected)
  }
}

async function invalidInputCases({ indexEffect, gateway, snapshotStore }) {
  const repo = createRepo('invalid-input', {
    'a.txt': 'a0\n',
    'b.txt': 'b0\n',
    'deleted/nested.txt': 'nested\n'
  })
  writeFileSync(path.join(repo, 'a.txt'), 'a0\na1\n')
  writeFileSync(path.join(repo, 'b.txt'), 'b0\nb1\n')
  rmSync(path.join(repo, 'deleted'), { recursive: true })
  const aPatch = git(repo, ['diff', '--binary', '--', 'a.txt'])
  const multiPatch = git(repo, ['diff', '--binary', '--', 'a.txt', 'b.txt'])
  const outside = path.join(tempRoot, 'outside.txt')
  writeFileSync(outside, 'outside\n')
  const invalid = [
    effectInput('git_stage', repo, { paths: [] }),
    effectInput('git_stage', repo, { paths: ['../outside.txt'] }),
    effectInput('git_stage', repo, { paths: [outside] }),
    effectInput('git_stage', repo, { paths: ['bad\0path'] }),
    effectInput('git_stage', repo, { paths: ['deleted'] }),
    effectInput('workspace_apply_hunk', repo, { filePath: 'b.txt', hunkPatch: aPatch }),
    effectInput('workspace_apply_hunk', repo, { filePath: 'a.txt', hunkPatch: multiPatch })
  ]
  const before = indexDigest(repo)
  for (const input of invalid) assertThrows(() => indexEffect.buildGitIndexEffectTarget(input))
  assertEqual(indexDigest(repo), before)
  let callbackCount = 0
  const outcome = await gateway.executeInteractiveOperationEffect({
    operationId: 'invalid-hunk',
    kind: 'git_index_update',
    title: 'invalid hunk',
    sourceSessionId: 'invalid-source',
    cwd: repo,
    toolName: 'workspace_apply_hunk',
    toolInput: { filePath: 'b.txt', hunkPatch: aPatch },
    execute: () => {
      callbackCount += 1
      return { ok: true }
    },
    isSuccess: (result) => result.ok
  })
  assertEqual(outcome.status, 'failed')
  assertEqual(callbackCount, 0)
  assertEqual(indexDigest(repo), before)
  assertEqual(readFileSync(outside, 'utf8'), 'outside\n')
  assertEqual(await snapshotStore.getTaskSnapshot('operation:invalid-hunk'), null)
}

async function isolationCases(modules) {
  const { indexEffect } = modules
  executableFilterCase(indexEffect)
  hookIsolationCase(indexEffect)
  environmentIsolationCase(indexEffect)
}

function executableFilterCase(indexEffect) {
  const repo = createRepo('filter-isolation', { 'a.txt': 'a0\n' })
  const marker = path.join(tempRoot, 'filter-marker')
  writeFileSync(path.join(repo, '.gitattributes'), '*.txt filter=malicious\n')
  writeFileSync(path.join(repo, 'a.txt'), 'a0\na1\n')
  git(repo, ['config', 'filter.malicious.clean', `sh -c "printf filter > ${shellQuote(marker)}; cat"`])
  assertThrowsMatching(
    () => indexEffect.buildGitIndexEffectTarget(effectInput('git_stage', repo, { paths: ['a.txt'] })),
    /filter/
  )
  assert(!existsSync(marker), 'executable clean filter must never run')
  assertDeepEqual(cachedNames(repo), [])
}

function hookIsolationCase(indexEffect) {
  const repo = createRepo('hook-isolation', { 'a.txt': 'a0\n' })
  const hooks = path.join(repo, 'hostile-hooks')
  const marker = path.join(tempRoot, 'hook-marker')
  mkdirSync(hooks)
  writeExecutable(path.join(hooks, 'post-index-change'), `#!/bin/sh\nprintf hook > ${shellQuote(marker)}\nexit 91\n`)
  git(repo, ['config', 'core.hooksPath', hooks])
  writeFileSync(path.join(repo, 'a.txt'), 'a0\na1\n')
  const input = effectInput('git_stage', repo, { paths: ['a.txt'] })
  const target = indexEffect.buildGitIndexEffectTarget(input)
  assert(!existsSync(marker), 'planning must not run post-index-change hook')
  assert(indexEffect.executeGitIndexEffectTarget(target, input).ok)
  assertEqual(indexEffect.reconcileGitIndexEffectTarget(target).kind, 'confirmed')
  assert(!existsSync(marker), 'execution and reconciliation must not run hooks')
}

function environmentIsolationCase(indexEffect) {
  const repo = createRepo('environment-isolation', { 'a.txt': 'a0\n' })
  writeFileSync(path.join(repo, 'a.txt'), 'a0\na1\n')
  const realIndex = git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).trim()
  const alternateIndex = path.join(tempRoot, 'alternate-index')
  const hostileConfig = path.join(tempRoot, 'hostile-global-config')
  const marker = path.join(tempRoot, 'global-hook-marker')
  copyFileSync(realIndex, alternateIndex)
  const alternateBefore = sha256(readFileSync(alternateIndex))
  writeFileSync(hostileConfig, `[core]\n\thooksPath = ${path.join(tempRoot, 'missing-hooks')}\n[filter "pwn"]\n\tclean = sh -c 'printf pwn > ${marker}; cat'\n`)
  const previous = captureEnvironment(['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_CONFIG_GLOBAL'])
  process.env.GIT_INDEX_FILE = alternateIndex
  process.env.GIT_DIR = path.join(tempRoot, 'bogus-git-dir')
  process.env.GIT_CONFIG_GLOBAL = hostileConfig
  let target
  try {
    const input = effectInput('git_stage', repo, { paths: ['a.txt'] })
    target = indexEffect.buildGitIndexEffectTarget(input)
    assert(indexEffect.executeGitIndexEffectTarget(target, input).ok)
  } finally {
    restoreEnvironment(previous)
  }
  assertEqual(indexEffect.reconcileGitIndexEffectTarget(target).kind, 'confirmed')
  assertDeepEqual(cachedNames(repo), ['a.txt'])
  assertEqual(sha256(readFileSync(alternateIndex)), alternateBefore)
  assert(!existsSync(marker), 'environment-injected filter must never run')
}

async function lockOwnershipCase({ indexEffect, gateway, snapshotStore }) {
  const repo = createRepo('index-lock-ownership', { 'a.txt': 'a0\n' })
  writeFileSync(path.join(repo, 'a.txt'), 'a0\na1\n')
  const input = effectInput('git_stage', repo, { paths: ['a.txt'] })
  const preIndexDigest = indexDigest(repo)
  let target
  let reachableObjectsBefore
  let reachableObjectsAfter
  const lockContents = 'foreign-index-lock\n'
  const outcome = await gateway.executeInteractiveOperationEffect(operationSpec('foreign-index-lock', input, (effect) => {
    target = effect.target
    reachableObjectsBefore = reachableObjectsDigest(repo)
    writeFileSync(`${target.indexPath}.lock`, lockContents)
    const result = indexEffect.executeGitIndexEffectTarget(target, input)
    reachableObjectsAfter = reachableObjectsDigest(repo)
    return result
  }))
  assertEqual(outcome.status, 'failed')
  assertEqual(outcome.effectStatus, 'abandoned')
  assertEqual(readFileSync(`${target.indexPath}.lock`, 'utf8'), lockContents)
  assertEqual(indexDigest(repo), preIndexDigest)
  assertEqual(reachableObjectsAfter, reachableObjectsBefore, 'foreign index.lock must not change reachable objects')
  assertEqual(indexEffect.reconcileGitIndexEffectTarget(target).kind, 'not_applied')
  assertEqual(await snapshotStore.getTaskSnapshot('operation:foreign-index-lock'), null)
  unlinkSync(`${target.indexPath}.lock`)
}

function objectDirectorySymlinkCase(indexEffect) {
  const repo = createRepo('object-directory-symlink', { 'a.txt': 'a0\n' })
  const outside = path.join(tempRoot, 'object-directory-outside')
  mkdirSync(outside)
  const { input, target, objectPrefix } = targetWithUnusedObjectPrefix(indexEffect, repo)
  const objectPrefixPath = path.join(target.objectDir, objectPrefix)
  const before = indexDigest(repo)
  symlinkSync(outside, objectPrefixPath, 'dir')
  const result = indexEffect.executeGitIndexEffectTarget(target, input)
  assertEqual(result.ok, false)
  assertEqual(indexDigest(repo), before, 'unsafe object directory must not change the index')
  assertDeepEqual(readdirSync(outside), [], 'unsafe object directory must not write outside the repository')
  assertEqual(indexEffect.reconcileGitIndexEffectTarget(target).kind, 'not_applied')
}

function targetWithUnusedObjectPrefix(indexEffect, repo) {
  for (let attempt = 0; attempt < 512; attempt += 1) {
    writeFileSync(path.join(repo, 'a.txt'), `a0\nsymlink-${attempt}\n`)
    const input = effectInput('git_stage', repo, { paths: ['a.txt'] })
    const target = indexEffect.buildGitIndexEffectTarget(input)
    const manifest = JSON.parse(readFileSync(target.objectManifestPath, 'utf8'))
    const objectPrefix = manifest.objects[0]?.path?.slice(0, 2)
    if (objectPrefix && !existsSync(path.join(target.objectDir, objectPrefix))) {
      return { input, target, objectPrefix }
    }
  }
  throw new Error('could not find an unused loose-object prefix for symlink fixture')
}

async function sameIndexLeaseCase({ indexEffect, gateway }) {
  const repo = createRepo('same-index-lease', { 'a.txt': 'a0\n', 'b.txt': 'b0\n' })
  writeFileSync(path.join(repo, 'a.txt'), 'a0\na1\n')
  writeFileSync(path.join(repo, 'b.txt'), 'b0\nb1\n')
  const gate = deferred()
  const entered = deferred()
  const firstInput = effectInput('git_stage', repo, { paths: ['a.txt'] })
  const first = gateway.executeInteractiveOperationEffect(operationSpec('lease-first', firstInput, async (effect) => {
    entered.resolve()
    await gate.promise
    return indexEffect.executeGitIndexEffectTarget(effect.target, firstInput)
  }))
  await entered.promise
  let secondCalls = 0
  const secondInput = effectInput('git_stage', repo, { paths: ['b.txt'] })
  const second = await gateway.executeInteractiveOperationEffect(operationSpec('lease-second', secondInput, () => {
    secondCalls += 1
    return { ok: true }
  }))
  assertEqual(second.status, 'failed')
  assertEqual(secondCalls, 0)
  assert(String(second.error).includes('相同资源'))
  gate.resolve()
  assertEqual((await first).status, 'completed')
}

async function semanticCommitConflictCase({ reconciler, ledger, snapshotStore, taskRun }) {
  const repo = createRepo('commit-conflict', { 'a.txt': 'a0\n', 'b.txt': 'b0\n' })
  writeFileSync(path.join(repo, 'a.txt'), 'a0\na1\n')
  writeFileSync(path.join(repo, 'b.txt'), 'b0\nb1\n')
  git(repo, ['add', '--', 'a.txt'])
  const [indexDescriptor, commitDescriptor] = await Promise.all([
    reconciler.buildEffectDescriptor({ toolName: 'git_stage', toolInput: { paths: ['b.txt'] }, cwd: repo }),
    reconciler.buildEffectDescriptor({ toolName: 'git_commit', toolInput: { message: 'conflict' }, cwd: repo })
  ])
  const inputs = [indexDescriptor, commitDescriptor].map((descriptor, index) => {
    const sessionId = `semantic-conflict-${index}`
    const run = taskRun.createTaskRun({ id: `${sessionId}-run`, sessionId, taskId: sessionId })
    return { descriptor, run, sessionId, toolName: index === 0 ? 'git_stage' : 'git_commit' }
  })
  for (const item of inputs) await saveBaseSnapshot(snapshotStore, item.run, repo)
  const prepared = inputs.map((item, index) => ledger.prepareEffect(item.run, {
    sessionId: item.sessionId,
    cwd: repo,
    toolUseId: `${item.sessionId}-tool`,
    toolName: item.toolName,
    descriptor: item.descriptor,
    ownerId: `semantic-owner-${index}`
  }).run)
  assert(prepared[0].effects[0].resourceKey !== prepared[1].effects[0].resourceKey)
  const outcomes = await Promise.allSettled(prepared.map((run) => snapshotStore.saveTaskRunBarrier(run)))
  assertEqual(outcomes.filter((item) => item.status === 'fulfilled').length, 1)
  assertEqual(outcomes.filter((item) => item.status === 'rejected').length, 1)
}

async function opaqueMultiEditConflictCase({ indexEffect, reconciler, targetConflict }) {
  const repo = createRepo('opaque-multiedit-conflict', { 'a.txt': 'a0\n', 'b.txt': 'b0\n' })
  writeFileSync(path.join(repo, 'a.txt'), 'a0\na1\n')
  writeFileSync(path.join(repo, 'b.txt'), 'b0\nb1\n')
  const patch = git(repo, ['diff', '--binary', '--', 'a.txt'])
  const stage = indexEffect.buildGitIndexEffectTarget(effectInput('git_stage', repo, { paths: ['a.txt'] }))
  const stageAll = indexEffect.buildGitIndexEffectTarget(effectInput('git_stage_all', repo))
  const hunk = indexEffect.buildGitIndexEffectTarget(
    effectInput('workspace_apply_hunk', repo, { filePath: 'a.txt', hunkPatch: patch })
  )
  git(repo, ['add', '--', 'a.txt'])
  const unstage = indexEffect.buildGitIndexEffectTarget(effectInput('git_unstage', repo, { paths: ['a.txt'] }))
  const opaque = (await reconciler.buildEffectDescriptor({
    toolName: 'MultiEdit',
    toolInput: { edits: [{ file_path: 'unknown.txt', old_string: 'x', new_string: 'y' }] },
    cwd: repo
  })).target
  assertEqual(opaque.kind, 'unsupported')
  assertEqual(opaque.toolName, 'edit_file')
  for (const target of [stage, stageAll, hunk]) {
    assert(targetConflict.effectTargetsConflict(target, opaque), `${target.operation} must conservatively conflict with MultiEdit`)
  }
  assertEqual(targetConflict.effectTargetsConflict(unstage, opaque), false)
}

async function linkedWorktreeConcurrencyCase({ indexEffect, gateway }) {
  const repo = createRepo('linked-main', { 'a.txt': 'a0\n', 'b.txt': 'b0\n' })
  const worktree = path.join(tempRoot, 'linked-feature')
  git(repo, ['worktree', 'add', '-b', 'feature', worktree])
  writeFileSync(path.join(repo, 'a.txt'), 'a0\nmain\n')
  writeFileSync(path.join(worktree, 'b.txt'), 'b0\nfeature\n')
  const mainGate = deferred()
  const worktreeGate = deferred()
  const mainEntered = deferred()
  const worktreeEntered = deferred()
  const mainInput = effectInput('git_stage', repo, { paths: ['a.txt'] })
  const worktreeInput = effectInput('git_stage', worktree, { paths: ['b.txt'] })
  const mainRun = gateway.executeInteractiveOperationEffect(operationSpec('linked-main', mainInput, async (effect) => {
    mainEntered.resolve()
    await mainGate.promise
    return indexEffect.executeGitIndexEffectTarget(effect.target, mainInput)
  }))
  await mainEntered.promise
  const worktreeRun = gateway.executeInteractiveOperationEffect(operationSpec('linked-worktree', worktreeInput, async (effect) => {
    worktreeEntered.resolve()
    await worktreeGate.promise
    return indexEffect.executeGitIndexEffectTarget(effect.target, worktreeInput)
  }))
  const independentlyEntered = await Promise.race([
    worktreeEntered.promise.then(() => true),
    worktreeRun.then(() => false),
    delay(5_000).then(() => false)
  ])
  assert(independentlyEntered, 'linked worktrees with separate indexes must not conflict')
  mainGate.resolve()
  worktreeGate.resolve()
  const [mainOutcome, worktreeOutcome] = await Promise.all([mainRun, worktreeRun])
  assertEqual(mainOutcome.status, 'completed')
  assertEqual(worktreeOutcome.status, 'completed')
  assert(mainOutcome.effect.resourceKey !== worktreeOutcome.effect.resourceKey)
}

function operationSpec(operationId, input, execute) {
  return {
    operationId,
    kind: 'git_index_update',
    title: operationId,
    sourceSessionId: `${operationId}-source`,
    cwd: input.cwd,
    toolName: input.toolName,
    toolInput: input.toolInput,
    execute,
    isSuccess: (result) => result.ok
  }
}

async function saveBaseSnapshot(snapshotStore, run, project) {
  await snapshotStore.saveTaskSnapshot(snapshotStore.buildTaskSnapshot({
    meta: operationMeta(run.sessionId, project),
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'important-event',
    run,
    subtasks: [],
    dagExecutions: []
  }))
}

function operationMeta(id, cwd) {
  return {
    id,
    title: id,
    cwd,
    model: '',
    providerId: '',
    permissionMode: 'default',
    status: 'running',
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: Date.now()
  }
}

function effectInput(toolName, cwd, toolInput = {}) {
  return { toolName, cwd, toolInput }
}

function createRepo(name, files) {
  const repo = path.join(tempRoot, name)
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-b', 'main'])
  git(repo, ['config', 'user.email', 'git-index-effect@example.test'])
  git(repo, ['config', 'user.name', 'Git Index Effect Test'])
  for (const [relativePath, content] of Object.entries(files)) {
    const file = path.join(repo, relativePath)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  git(repo, ['add', '-A', '--', '.'])
  git(repo, ['commit', '-m', 'base'])
  return repo
}

function git(cwd, args, input) {
  return execFileSync('git', ['-C', cwd, ...args], {
    env: cleanGitEnv,
    input,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  })
}

function indexDigest(cwd) {
  const output = execFileSync('git', ['-C', cwd, 'ls-files', '--stage', '-z'], {
    env: cleanGitEnv,
    encoding: 'buffer'
  })
  return sha256(output)
}

function cachedNames(cwd) {
  return nulNames(git(cwd, ['diff', '--cached', '--name-only', '-z']))
}

function worktreeNames(cwd) {
  return nulNames(git(cwd, ['diff', '--name-only', '-z']))
}

function nulNames(output) {
  return output.split('\0').filter(Boolean).sort()
}

function reachableObjectsDigest(repo) {
  return sha256(Buffer.from(git(repo, ['rev-list', '--objects', '--all'])))
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/git/git-index-effect.ts',
    'src/main/agent/tools/git-tools.ts',
    'src/main/task/operation-effect-gateway.ts',
    'src/main/task/effect-reconciler.ts',
    'src/main/task/effect-target-conflict.ts',
    '--outDir', outDir,
    '--rootDir', 'src',
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), 'module.exports = { app: { getPath: () => process.env.CAOGEN_TEST_USER_DATA } }\n')
}

function loadModules() {
  return {
    gitTools: require(findCompiledModule(outDir, 'git-tools.js')),
    indexEffect: require(findCompiledModule(outDir, 'git-index-effect.js')),
    gateway: require(findCompiledModule(outDir, 'operation-effect-gateway.js')),
    snapshotStore: require(findCompiledModule(outDir, 'task-snapshot.js')),
    reconciler: require(findCompiledModule(outDir, 'effect-reconciler.js')),
    targetConflict: require(findCompiledModule(outDir, 'effect-target-conflict.js')),
    ledger: require(findCompiledModule(outDir, 'effect-ledger.js')),
    taskRun: require(findCompiledModule(outDir, 'task-run.js'))
  }
}

function findCompiledModule(root, name) {
  const found = findCompiledModuleOrNull(root, name)
  if (found) return found
  throw new Error(`compiled module missing: ${name}`)
}

function findCompiledModuleOrNull(root, name) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModuleOrNull(fullPath, name)
      if (found) return found
    } else if (entry.name === name) return fullPath
  }
  return null
}

function sanitizedGitEnvironment(source) {
  const env = { ...source }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') || key === 'SSH_ASKPASS') delete env[key]
  }
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}

function captureEnvironment(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]))
}

function restoreEnvironment(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function writeExecutable(file, content) {
  writeFileSync(file, content)
  chmodSync(file, 0o755)
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function assertThrows(task) {
  assertThrowsMatching(task, /./)
}

function assertThrowsMatching(task, pattern) {
  let message = ''
  try {
    task()
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  assert(pattern.test(message), `expected error ${pattern}, got ${JSON.stringify(message)}`)
}

function assertDeepEqual(actual, expected, message) {
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
