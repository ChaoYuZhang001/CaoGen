import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-desk-worktree-merge-'))
const outDir = path.join(tempRoot, 'compiled')
const projectDir = path.join(tempRoot, 'repo')
const worktreeDir = path.join(tempRoot, 'feature-worktree')
const patchDir = path.join(tempRoot, 'patches')

try {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/worktreeMerge.ts',
      'src/main/git/auto-merger.ts',
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
      '--skipLibCheck'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )

  const worktreeMerge = await import(pathToFileURL(firstExisting([
    path.join(outDir, 'worktreeMerge.js'),
    path.join(outDir, 'main', 'worktreeMerge.js'),
    path.join(outDir, 'src', 'main', 'worktreeMerge.js')
  ])).href)
  const autoMerger = await import(pathToFileURL(firstExisting([
    path.join(outDir, 'git', 'auto-merger.js'),
    path.join(outDir, 'main', 'git', 'auto-merger.js'),
    path.join(outDir, 'src', 'main', 'git', 'auto-merger.js')
  ])).href)

  mkdirSync(projectDir, { recursive: true })
  git(projectDir, ['init'])
  git(projectDir, ['config', 'user.email', 'smoke@example.test'])
  git(projectDir, ['config', 'user.name', 'Worktree Merge Smoke'])

  writeFileSync(path.join(projectDir, 'notes.txt'), 'alpha\nbeta\n', 'utf8')
  git(projectDir, ['add', 'notes.txt'])
  git(projectDir, ['commit', '-m', 'initial'])
  const baseSha = git(projectDir, ['rev-parse', 'HEAD'])

  git(projectDir, ['worktree', 'add', '-b', 'feature/smoke', worktreeDir, 'HEAD'])
  writeFileSync(path.join(worktreeDir, 'notes.txt'), 'alpha\nbeta\nworktree line\n', 'utf8')
  writeFileSync(path.join(worktreeDir, 'new-file.txt'), 'fresh\n', 'utf8')
  mkdirSync(path.join(worktreeDir, '.caogen'), { recursive: true })
  writeFileSync(path.join(worktreeDir, '.caogen', 'audit.log'), 'runtime audit should not merge\n', 'utf8')

  const inspect = worktreeMerge.inspectMerge(projectDir, worktreeDir, baseSha)
  assertOk(inspect, 'inspectMerge should inspect a simple worktree')
  assertEqual(inspect.baseSha, baseSha)
  assertEqual(inspect.changedFiles, 2)
  assertEqual(inspect.insertions, 2)
  assertEqual(inspect.deletions, 0)
  assertEqual(inspect.conflictRisk, 'low')

  const patch = worktreeMerge.createSquashPatch(projectDir, worktreeDir, patchDir)
  assertOk(patch, 'createSquashPatch should write a patch')
  assert(existsSync(patch.path), 'patch file should exist')
  assert(readFileSync(patch.path, 'utf8').includes('worktree line'), 'patch should include tracked changes')
  assert(readFileSync(patch.path, 'utf8').includes('new-file.txt'), 'patch should include untracked files')
  assert(!readFileSync(patch.path, 'utf8').includes('.caogen/audit.log'), 'patch should exclude runtime audit log')

  const canApply = worktreeMerge.canFastApplyPatch(projectDir, patch.patchText)
  assertOk(canApply, 'canFastApplyPatch should complete')
  assert(canApply.canApply, `patch should apply cleanly: ${canApply.error ?? 'unknown error'}`)
  git(projectDir, ['apply', '--check', patch.path])

  // 冲突三栏:干净可应用时应返回空冲突列表。
  const noConflicts = worktreeMerge.getConflictFiles(projectDir, worktreeDir, baseSha)
  assertOk(noConflicts, 'getConflictFiles should succeed when patch applies cleanly')
  assertEqual(noConflicts.files.length, 0)

  const apply = worktreeMerge.applySquashPatch(projectDir, patch.patchText)
  assertOk(apply, 'applySquashPatch should apply a clean patch')
  assert(apply.applied, 'non-empty patch should report applied=true')
  assertEqual(apply.changedFiles, 2)
  assert(readFileSync(path.join(projectDir, 'notes.txt'), 'utf8').includes('worktree line'))
  assert(readFileSync(path.join(projectDir, 'new-file.txt'), 'utf8').includes('fresh'))

  const emptyPatch = worktreeMerge.canFastApplyPatch(projectDir, ' \n\t\n')
  assertOk(emptyPatch, 'canFastApplyPatch should accept an empty patch')
  assert(emptyPatch.canApply, 'empty patch should be treated as a no-op')

  const emptyApply = worktreeMerge.applySquashPatch(projectDir, ' \n\t\n')
  assertOk(emptyApply, 'applySquashPatch should accept an empty patch')
  assert(!emptyApply.applied, 'empty patch should be treated as a no-op')

  git(projectDir, ['reset', '--hard', 'HEAD'])
  rmSync(path.join(projectDir, 'new-file.txt'), { force: true })
  writeFileSync(path.join(projectDir, 'notes.txt'), 'alpha\nmain line\n', 'utf8')
  const blockedApply = worktreeMerge.canFastApplyPatch(projectDir, patch.patchText)
  assertOk(blockedApply, 'canFastApplyPatch should report apply-check failures')
  assert(!blockedApply.canApply, 'patch should be blocked by conflicting main worktree content')
  assert(blockedApply.error, 'blocked apply-check should include the git error')

  const blockedRealApply = worktreeMerge.applySquashPatch(projectDir, patch.patchText)
  assert(!blockedRealApply.ok, 'applySquashPatch should not apply a blocked patch')

  const conflictedInspect = worktreeMerge.inspectMerge(projectDir, worktreeDir, baseSha)
  assertOk(conflictedInspect, 'inspectMerge should not crash on conflict risk')
  assert(
    conflictedInspect.conflictRisk === 'medium' || conflictedInspect.conflictRisk === 'unknown',
    `expected medium/unknown conflict risk, got ${conflictedInspect.conflictRisk}`
  )

  // 冲突三栏:主工作区改了 notes.txt(与 worktree 的编辑冲突),
  // getConflictFiles 应返回该文件的 基线/worktree/主工作区 三份内容。
  const conflicts = worktreeMerge.getConflictFiles(projectDir, worktreeDir, baseSha)
  assertOk(conflicts, 'getConflictFiles should succeed on a conflicted repo')
  assert(conflicts.files.length >= 1, 'at least one conflicted file expected')
  const notesConflict = conflicts.files.find((file) => file.path === 'notes.txt')
  assert(notesConflict, 'notes.txt should be reported as conflicted')
  assertEqual(notesConflict.base, 'alpha\nbeta\n')
  assertEqual(notesConflict.worktree, 'alpha\nbeta\nworktree line\n')
  assertEqual(notesConflict.main, 'alpha\nmain line\n')
  assert(!notesConflict.baseMissing, 'base version should exist')
  assert(!notesConflict.worktreeMissing, 'worktree version should exist')
  assert(!notesConflict.mainMissing, 'main version should exist')

  // 基线里不存在的新增文件:baseMissing 应为 true、base 内容为空串。
  const freshConflict = conflicts.files.find((file) => file.path === 'new-file.txt')
  if (freshConflict) {
    assert(freshConflict.baseMissing === true, 'new file should be missing at base')
    assertEqual(freshConflict.base, '')
  }

  // 合并回执:sha256 稳定、追加/读取往返一致。
  const sha = worktreeMerge.patchSha256(patch.patchText)
  assertEqual(sha, worktreeMerge.patchSha256(patch.patchText))
  assertEqual(sha.length, 64)
  const receiptsFile = path.join(tempRoot, 'worktree-merges.json')
  const receipt = {
    sessionId: 'smoke-session',
    branch: 'caogen/smoke-session',
    baseSha,
    filesChanged: 2,
    insertions: 2,
    deletions: 0,
    mergedAt: Date.now(),
    patchSha256: sha
  }
  worktreeMerge.appendMergeReceipt(receiptsFile, receipt)
  worktreeMerge.appendMergeReceipt(receiptsFile, { ...receipt, mergedAt: receipt.mergedAt + 1 })
  const receipts = worktreeMerge.listMergeReceipts(receiptsFile)
  assertEqual(receipts.length, 2)
  assertEqual(receipts[0].sessionId, 'smoke-session')
  assertEqual(receipts[0].patchSha256, sha)
  assertEqual(receipts[1].mergedAt, receipt.mergedAt + 1)
  // 损坏文件应安全返回空数组。
  writeFileSync(receiptsFile, '{not json', 'utf8')
  assertEqual(worktreeMerge.listMergeReceipts(receiptsFile).length, 0)

  const autoRepo = path.join(tempRoot, 'auto-merge-repo')
  const autoWorktree = path.join(tempRoot, 'auto-merge-worktree')
  mkdirSync(autoRepo, { recursive: true })
  initRepo(autoRepo, 'auto.txt', 'base\n')
  const autoBaseSha = git(autoRepo, ['rev-parse', 'HEAD'])
  git(autoRepo, ['worktree', 'add', '-b', 'feature/auto-merge', autoWorktree, 'HEAD'])
  writeFileSync(path.join(autoWorktree, 'auto.txt'), 'base\nauto merged\n', 'utf8')
  const autoResult = autoMerger.runTaskDagAutoMerge({
    execution: executionView('auto-dag', 'success', [
      taskView('apply-auto', 'success', ['auto-session'])
    ]),
    sessions: [
      {
        sessionId: 'auto-session',
        taskId: 'apply-auto',
        repoRoot: autoRepo,
        worktreePath: autoWorktree,
        baseSha: autoBaseSha,
        branch: 'feature/auto-merge',
        resultText: 'ok'
      }
    ],
    verificationCommand: 'git diff --name-only -- auto.txt'
  })
  assertEqual(autoResult.status, 'success')
  assertEqual(autoResult.entries[0].status, 'merged')
  assertEqual(autoResult.verification.status, 'passed')
  assert(readFileSync(path.join(autoRepo, 'auto.txt'), 'utf8').includes('auto merged'), 'auto merge should update main repo')

  const rollbackRepo = path.join(tempRoot, 'auto-merge-rollback-repo')
  const rollbackWorktree = path.join(tempRoot, 'auto-merge-rollback-worktree')
  mkdirSync(rollbackRepo, { recursive: true })
  initRepo(rollbackRepo, 'rollback.txt', 'base\n')
  const rollbackBaseSha = git(rollbackRepo, ['rev-parse', 'HEAD'])
  git(rollbackRepo, ['worktree', 'add', '-b', 'feature/rollback', rollbackWorktree, 'HEAD'])
  writeFileSync(path.join(rollbackWorktree, 'rollback.txt'), 'base\nwill rollback\n', 'utf8')
  const rollbackResult = autoMerger.runTaskDagAutoMerge({
    execution: executionView('rollback-dag', 'failed', [
      taskView('blocked-first', 'failed', []),
      taskView('rollback-task', 'success', ['rollback-session'])
    ]),
    sessions: [
      {
        sessionId: 'rollback-session',
        taskId: 'rollback-task',
        repoRoot: rollbackRepo,
        worktreePath: rollbackWorktree,
        baseSha: rollbackBaseSha,
        branch: 'feature/rollback',
        resultText: 'ok'
      }
    ],
    verificationCommand: `${JSON.stringify(process.execPath)} -e "process.exit(17)"`
  })
  assertEqual(rollbackResult.status, 'rolled-back')
  assertEqual(rollbackResult.entries[0].status, 'skipped')
  assertEqual(rollbackResult.entries[1].status, 'rolled-back')
  assertEqual(rollbackResult.verification.status, 'failed')
  assert(
    !readFileSync(path.join(rollbackRepo, 'rollback.txt'), 'utf8').includes('will rollback'),
    'failed verification should rollback patch'
  )

  console.log('worktreeMerge smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const output = result.stderr.trim() || result.stdout.trim()
    throw new Error(`git ${args.join(' ')} failed: ${output}`)
  }
  return result.stdout.trim()
}

function firstExisting(candidates) {
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error(`compiled file not found: ${candidates.join(', ')}`)
  return found
}

function initRepo(cwd, fileName, content) {
  git(cwd, ['init'])
  git(cwd, ['config', 'user.email', 'smoke@example.test'])
  git(cwd, ['config', 'user.name', 'Worktree Merge Smoke'])
  writeFileSync(path.join(cwd, fileName), content, 'utf8')
  git(cwd, ['add', fileName])
  git(cwd, ['commit', '-m', 'initial'])
}

function executionView(id, status, tasks) {
  return {
    id,
    parentSessionId: 'parent',
    dag: {
      id,
      title: id,
      source: id,
      complexity: 'multi',
      createdAt: Date.now(),
      tasks: tasks.map((task) => task.task)
    },
    status,
    maxRetries: 0,
    startedAt: Date.now(),
    completedAt: Date.now(),
    layers: tasks.map((task) => [task.task.id]),
    tasks
  }
}

function taskView(id, status, sessionIds) {
  return {
    task: {
      id,
      title: id,
      description: id,
      dependencies: [],
      role: 'general',
      prompt: id
    },
    status,
    attempts: status === 'waiting' ? 0 : 1,
    sessionIds,
    startedAt: Date.now(),
    completedAt: status === 'running' || status === 'waiting' ? undefined : Date.now()
  }
}

function assertOk(result, message) {
  assert(result.ok, `${message}: ${result.error ?? 'unknown error'}`)
}

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) {
    throw new Error(message)
  }
}
