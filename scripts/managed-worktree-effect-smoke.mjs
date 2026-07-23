import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-managed-worktree-effect-'))
const outDir = path.join(tempRoot, 'compiled')
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
const cleanGitEnv = sanitizedGitEnvironment(process.env)

try {
  compileSources()
  installElectronStub()
  const modules = loadModules()
  await createAndRemoveCase(modules)
  await symlinkParentDriftCase(modules.lifecycle)
  await partialRemoveCase(modules.lifecycle)
  await refMoveCasCase(modules.lifecycle)
  await resourceAndConflictCase(modules)
  console.log('managed worktree effect smoke: PASS')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

async function symlinkParentDriftCase(lifecycle) {
  const repo = createRepo('symlink-parent')
  const anchor = path.join(tempRoot, 'chain-anchor')
  const malicious = path.join(tempRoot, 'chain-redirect')
  mkdirSync(anchor)
  mkdirSync(malicious)
  const input = createInput(
    repo,
    repo,
    path.join(anchor, 'missing-one', 'missing-two', 'managed'),
    'caogen/symlink-parent'
  )
  const target = lifecycle.buildManagedWorktreeCreateTarget(repo, input)
  const firstMissing = path.relative(
    target.worktreeParentAnchorPath,
    target.worktreeParentPath
  ).split(path.sep)[0]
  const injected = path.join(target.worktreeParentAnchorPath, firstMissing)
  symlinkSync(malicious, injected, 'dir')
  try {
    assertEqual(
      lifecycle.reconcileManagedWorktreeCreateTarget(target).kind,
      'unresolved',
      'an injected parent-chain symlink must invalidate not_applied'
    )
    assert(!lifecycle.executeManagedWorktreeCreateTarget(target).ok, 'executor must reject parent-chain symlink drift')
  } finally {
    unlinkSync(injected)
  }
}

async function createAndRemoveCase({ lifecycle, reconciler, validation }) {
  const repo = createRepo('create-remove')
  const marker = path.join(tempRoot, 'hostile-post-checkout')
  const hooks = path.join(tempRoot, 'hostile-hooks')
  mkdirSync(hooks)
  writeExecutable(path.join(hooks, 'post-checkout'), `#!/bin/sh\ntouch ${shellQuote(marker)}\n`)
  git(repo, ['config', 'core.hooksPath', hooks])

  const sourceCwd = path.join(repo, 'nested')
  const worktreePath = path.join(tempRoot, 'first-parent', 'managed')
  const input = createInput(repo, sourceCwd, worktreePath, 'caogen/create-remove')
  const descriptor = await reconciler.buildEffectDescriptor({
    toolName: 'managed_worktree_create',
    toolInput: input,
    cwd: sourceCwd
  })
  const target = descriptor.target
  assertEqual(target.kind, 'git_worktree_create')
  assertEqual(descriptor.reconcilability, 'queryable')
  assert(validation.isEffectTarget(target), 'create target must pass persisted target validation')
  assertEqual(target.sourcePrefix, 'nested')
  assertEqual(target.worktreeCwd, path.join(target.worktreePath, 'nested'))
  assertEqual(lifecycle.reconcileManagedWorktreeCreateTarget(target).kind, 'not_applied')
  assertThrows(() => lifecycle.buildManagedWorktreeCreateTarget(sourceCwd, { ...input, identity: {} }))

  mkdirSync(target.worktreeParentPath, { recursive: true })
  assertEqual(
    lifecycle.reconcileManagedWorktreeCreateTarget(target).kind,
    'unresolved',
    'parent-only create state must be unresolved'
  )
  rmSync(target.worktreeParentPath, { recursive: true })

  const previousConfigCount = process.env.GIT_CONFIG_COUNT
  const previousConfigKey = process.env.GIT_CONFIG_KEY_0
  const previousConfigValue = process.env.GIT_CONFIG_VALUE_0
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath'
  process.env.GIT_CONFIG_VALUE_0 = hooks
  try {
    const result = lifecycle.executeManagedWorktreeCreateTarget(target)
    assert(result.ok, result.error)
  } finally {
    restoreEnv('GIT_CONFIG_COUNT', previousConfigCount)
    restoreEnv('GIT_CONFIG_KEY_0', previousConfigKey)
    restoreEnv('GIT_CONFIG_VALUE_0', previousConfigValue)
  }
  assert(!existsSync(marker), 'repository and injected post-checkout hooks must not execute')
  assertEqual(lifecycle.reconcileManagedWorktreeCreateTarget(target).kind, 'confirmed')
  assertEqual(gitText(worktreePath, ['rev-parse', 'HEAD']), input.baseSha)

  const removeInput = removeInputFor(input, false, true)
  const removeDescriptor = await reconciler.buildEffectDescriptor({
    toolName: 'managed_worktree_remove',
    toolInput: removeInput,
    cwd: sourceCwd
  })
  const removeTarget = removeDescriptor.target
  assertEqual(removeTarget.kind, 'git_worktree_remove')
  assert(validation.isEffectTarget(removeTarget), 'remove target must pass persisted target validation')
  assertEqual(lifecycle.reconcileManagedWorktreeRemoveTarget(removeTarget).kind, 'not_applied')
  const removed = lifecycle.executeManagedWorktreeRemoveTarget(removeTarget)
  assert(removed.ok, removed.error)
  assertEqual(lifecycle.reconcileManagedWorktreeRemoveTarget(removeTarget).kind, 'confirmed')
  assert(!existsSync(worktreePath), 'confirmed remove must remove the worktree directory')
  assertEqual(refShaOrEmpty(repo, removeTarget.branchRef), '')
}

async function partialRemoveCase(lifecycle) {
  const repo = createRepo('partial-remove')
  const worktreePath = path.join(tempRoot, 'partial-parent', 'managed')
  const input = createInput(repo, repo, worktreePath, 'caogen/partial-remove')
  const createTarget = lifecycle.buildManagedWorktreeCreateTarget(repo, input)
  assert(lifecycle.executeManagedWorktreeCreateTarget(createTarget).ok)
  const removeTarget = lifecycle.buildManagedWorktreeRemoveTarget(repo, removeInputFor(input, false, true))
  git(repo, ['worktree', 'remove', worktreePath])
  assertEqual(
    lifecycle.reconcileManagedWorktreeRemoveTarget(removeTarget).kind,
    'unresolved',
    'removed path with surviving branch must be unresolved'
  )
  assertEqual(refShaOrEmpty(repo, removeTarget.branchRef), removeTarget.branchSha)
  git(repo, ['update-ref', '-d', removeTarget.branchRef, removeTarget.branchSha])
}

async function refMoveCasCase(lifecycle) {
  const repo = createRepo('ref-move')
  const worktreePath = path.join(tempRoot, 'ref-move-parent', 'managed')
  const input = createInput(repo, repo, worktreePath, 'caogen/ref-move')
  const createTarget = lifecycle.buildManagedWorktreeCreateTarget(repo, input)
  assert(lifecycle.executeManagedWorktreeCreateTarget(createTarget).ok)
  const removeTarget = lifecycle.buildManagedWorktreeRemoveTarget(repo, removeInputFor(input, true, true))
  const tree = gitText(repo, ['rev-parse', 'HEAD^{tree}'])
  const movedSha = gitText(repo, ['commit-tree', tree, '-p', input.baseSha, '-m', 'concurrent ref move'])
  const wrapperDir = path.join(tempRoot, 'git-wrapper')
  mkdirSync(wrapperDir)
  writeExecutable(path.join(wrapperDir, 'git'), refMoveWrapper())
  const previous = captureEnvironment([
    'PATH',
    'CAOGEN_TEST_REAL_GIT',
    'CAOGEN_TEST_MOVE_REPO',
    'CAOGEN_TEST_MOVE_REF',
    'CAOGEN_TEST_MOVE_SHA'
  ])
  process.env.PATH = `${wrapperDir}${path.delimiter}${process.env.PATH ?? ''}`
  process.env.CAOGEN_TEST_REAL_GIT = realGit
  process.env.CAOGEN_TEST_MOVE_REPO = repo
  process.env.CAOGEN_TEST_MOVE_REF = removeTarget.branchRef
  process.env.CAOGEN_TEST_MOVE_SHA = movedSha
  let result
  try {
    result = lifecycle.executeManagedWorktreeRemoveTarget(removeTarget)
  } finally {
    restoreEnvironment(previous)
  }
  assert(!result.ok, 'ref move between remove and delete must fail the executor CAS')
  assert(!existsSync(worktreePath), 'worktree removal should already have occurred in the race fixture')
  assertEqual(refShaOrEmpty(repo, removeTarget.branchRef), movedSha, 'moved ref must not be deleted')
  assertEqual(
    lifecycle.reconcileManagedWorktreeRemoveTarget(removeTarget).kind,
    'unresolved',
    'ref-move partial state must remain unresolved'
  )
  git(repo, ['update-ref', '-d', removeTarget.branchRef, movedSha])
}

async function resourceAndConflictCase({ lifecycle, reconciler, ledger, conflict }) {
  const repo = createRepo('resource-conflict')
  const firstInput = createInput(
    repo,
    repo,
    path.join(tempRoot, 'resource-parent', 'one'),
    'caogen/resource-one'
  )
  const secondInput = createInput(
    repo,
    repo,
    path.join(tempRoot, 'resource-parent', 'two'),
    'caogen/resource-two'
  )
  const first = await reconciler.buildEffectDescriptor({
    toolName: 'managed_worktree_create', toolInput: firstInput, cwd: repo
  })
  const second = await reconciler.buildEffectDescriptor({
    toolName: 'managed_worktree_create', toolInput: secondInput, cwd: repo
  })
  const firstPrepared = ledger.prepareEffect(emptyRun('first'), prepareInput(repo, 'first', first))
  const secondPrepared = ledger.prepareEffect(emptyRun('second'), prepareInput(repo, 'second', second))
  assertEqual(
    firstPrepared.handle.resourceKey,
    secondPrepared.handle.resourceKey,
    'same common-dir lifecycle targets must share one resource key'
  )
  const target = lifecycle.buildManagedWorktreeCreateTarget(repo, firstInput)
  assert(conflict.effectTargetsConflict(target, {
    kind: 'git_commit', repoRoot: target.repoRoot, branch: 'main', preHead: target.baseSha,
    stagedDiffDigest: 'x', messageDigest: 'y'
  }), 'lifecycle must conflict with a commit in its source worktree')
  assert(conflict.effectTargetsConflict(target, {
    kind: 'git_index_update', repoRoot: target.repoRoot,
    worktreeGitDir: target.sourceWorktreeGitDir,
    worktreeGitDirIdentity: target.sourceWorktreeGitDirIdentity
  }), 'lifecycle must conflict with an index effect in the same worktree')
  assert(conflict.effectTargetsConflict(target, {
    kind: 'worktree_patch_apply', repoRoot: path.join(tempRoot, 'elsewhere'),
    worktreePath: target.worktreePath
  }), 'lifecycle must conflict with a patch that reads its managed worktree')
  assert(conflict.effectTargetsConflict(target, {
    kind: 'file_content',
    rootPath: target.worktreePath,
    relativePath: 'nested/file.txt'
  }), 'lifecycle must conflict with file writes inside its managed worktree')
  assert(!conflict.effectTargetsConflict(target, {
    kind: 'file_content',
    rootPath: path.join(tempRoot, 'unrelated-files'),
    relativePath: 'file.txt'
  }), 'lifecycle must not globally block unrelated file writes')
  assert(conflict.effectTargetsConflict(target, {
    kind: 'git_push', repoRoot: target.repoRoot
  }), 'lifecycle must conflict with pushes from the same source repository')
  assert(conflict.effectTargetsConflict(target, {
    kind: 'pull_request_create', repoRoot: target.worktreePath
  }), 'lifecycle must conflict with PR creation reading its managed worktree')
  assert(conflict.effectTargetsConflict(target, second.target), 'same common-dir lifecycle targets must conflict')
}

function createRepo(name) {
  const repo = path.join(tempRoot, `repo-${name}`)
  mkdirSync(path.join(repo, 'nested'), { recursive: true })
  git(repo, ['init', '-b', 'main'])
  git(repo, ['config', 'user.name', 'CaoGen Test'])
  git(repo, ['config', 'user.email', 'caogen@example.invalid'])
  writeFileSync(path.join(repo, 'root.txt'), 'root\n')
  writeFileSync(path.join(repo, 'nested', 'file.txt'), 'nested\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-m', 'fixture'])
  return repo
}

function createInput(repo, sourceCwd, worktreePath, branch) {
  const sessionId = `session-${branch.slice(branch.indexOf('/') + 1)}`
  const canonicalWorktreePath = canonicalPlannedPath(worktreePath)
  const baseSha = gitText(repo, ['rev-parse', 'HEAD'])
  const baseBranch = gitText(repo, ['symbolic-ref', '--short', 'HEAD'])
  const repoRoot = gitText(repo, ['rev-parse', '--show-toplevel'])
  const sourcePrefix = path.relative(repoRoot, fsRealpath(sourceCwd))
  const cwd = path.resolve(canonicalWorktreePath, sourcePrefix)
  const registryRecord = {
    sessionId,
    repoRoot,
    sourceCwd,
    worktreePath: canonicalWorktreePath,
    cwd,
    branch,
    baseSha,
    baseBranch,
    state: 'active',
    createdAt: 1,
    updatedAt: 1
  }
  return { sessionId, sourceCwd, worktreePath: canonicalWorktreePath, branch, baseSha, baseBranch, registryRecord }
}

function removeInputFor(input, force, deleteBranch) {
  return {
    ...input,
    force,
    deleteBranch,
    registryRecord: { ...input.registryRecord, state: 'removed', updatedAt: 2 }
  }
}

function canonicalPlannedPath(value) {
  let cursor = path.resolve(value)
  const missing = []
  while (!existsSync(cursor)) {
    missing.unshift(path.basename(cursor))
    cursor = path.dirname(cursor)
  }
  return path.join(fsRealpath(cursor), ...missing)
}

function fsRealpath(value) {
  return execFileSync('realpath', [value], { encoding: 'utf8' }).trim()
}

function emptyRun(id) {
  return {
    schemaVersion: 1,
    id: `run-${id}`,
    sessionId: `session-${id}`,
    taskId: `task-${id}`,
    status: 'executing',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: 1,
    updatedAt: 1,
    effects: []
  }
}

function prepareInput(cwd, id, descriptor) {
  return {
    sessionId: `session-${id}`,
    cwd,
    toolUseId: `tool-${id}`,
    toolName: 'managed_worktree_create',
    descriptor,
    ownerId: `owner-${id}`,
    now: 10
  }
}

function refMoveWrapper() {
  return `#!/bin/sh\n"$CAOGEN_TEST_REAL_GIT" "$@"\nstatus=$?\ncase " $* " in\n  *" worktree remove "*)\n    "$CAOGEN_TEST_REAL_GIT" -C "$CAOGEN_TEST_MOVE_REPO" update-ref "$CAOGEN_TEST_MOVE_REF" "$CAOGEN_TEST_MOVE_SHA"\n    ;;\nesac\nexit $status\n`
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/git/managed-worktree-effect.ts',
    'src/main/task/effect-reconciler.ts',
    'src/main/task/effect-ledger.ts',
    'src/main/task/effect-target-conflict.ts',
    'src/main/task/effect-target-validation.ts',
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

function loadModules() {
  return {
    lifecycle: require(findCompiledModule(outDir, 'managed-worktree-effect.js')),
    reconciler: require(findCompiledModule(outDir, 'effect-reconciler.js')),
    ledger: require(findCompiledModule(outDir, 'effect-ledger.js')),
    conflict: require(findCompiledModule(outDir, 'effect-target-conflict.js')),
    validation: require(findCompiledModule(outDir, 'effect-target-validation.js'))
  }
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), 'module.exports = { app: { getPath: () => "" } }\n')
}

function findCompiledModule(root, name) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModuleOrNull(fullPath, name)
      if (found) return found
    } else if (entry.name === name) return fullPath
  }
  throw new Error(`compiled module missing: ${name}`)
}

function findCompiledModuleOrNull(root, name) {
  try {
    return findCompiledModule(root, name)
  } catch {
    return null
  }
}

function git(cwd, args) {
  return execFileSync(realGit, args, {
    cwd,
    encoding: 'utf8',
    env: cleanGitEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function gitText(cwd, args) {
  return git(cwd, args)
}

function refShaOrEmpty(repo, ref) {
  try {
    return gitText(repo, ['show-ref', '--verify', '--hash', ref])
  } catch {
    return ''
  }
}

function sanitizedGitEnvironment(source) {
  const env = { ...source }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') || key === 'SSH_ASKPASS') delete env[key]
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}

function captureEnvironment(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]))
}

function restoreEnvironment(previous) {
  for (const [key, value] of Object.entries(previous)) restoreEnv(key, value)
}

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function writeExecutable(file, content) {
  writeFileSync(file, content)
  chmodSync(file, 0o755)
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function assertThrows(task) {
  let threw = false
  try {
    task()
  } catch {
    threw = true
  }
  assert(threw, 'expected function to throw')
}

function assertEqual(actual, expected, message = '') {
  assert(actual === expected, `${message} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
