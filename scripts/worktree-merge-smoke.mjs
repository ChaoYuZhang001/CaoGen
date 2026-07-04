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
    'npx',
    [
      'tsc',
      'src/main/worktreeMerge.ts',
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

  const worktreeMerge = await import(pathToFileURL(path.join(outDir, 'worktreeMerge.js')).href)

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

  const canApply = worktreeMerge.canFastApplyPatch(projectDir, patch.patchText)
  assertOk(canApply, 'canFastApplyPatch should complete')
  assert(canApply.canApply, `patch should apply cleanly: ${canApply.error ?? 'unknown error'}`)
  git(projectDir, ['apply', '--check', patch.path])

  const emptyPatch = worktreeMerge.canFastApplyPatch(projectDir, ' \n\t\n')
  assertOk(emptyPatch, 'canFastApplyPatch should accept an empty patch')
  assert(emptyPatch.canApply, 'empty patch should be treated as a no-op')

  writeFileSync(path.join(projectDir, 'notes.txt'), 'alpha\nmain line\n', 'utf8')
  const blockedApply = worktreeMerge.canFastApplyPatch(projectDir, patch.patchText)
  assertOk(blockedApply, 'canFastApplyPatch should report apply-check failures')
  assert(!blockedApply.canApply, 'patch should be blocked by conflicting main worktree content')
  assert(blockedApply.error, 'blocked apply-check should include the git error')

  const conflictedInspect = worktreeMerge.inspectMerge(projectDir, worktreeDir, baseSha)
  assertOk(conflictedInspect, 'inspectMerge should not crash on conflict risk')
  assert(
    conflictedInspect.conflictRisk === 'medium' || conflictedInspect.conflictRisk === 'unknown',
    `expected medium/unknown conflict risk, got ${conflictedInspect.conflictRisk}`
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
