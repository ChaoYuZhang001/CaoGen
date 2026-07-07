import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-code-forge-'))
const outDir = path.join(tempRoot, 'compiled')
const projectDir = path.join(tempRoot, 'project')
const worktreeDir = path.join(tempRoot, 'worktree')

try {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/agent/tools/git-tools.ts',
      'src/main/permission/tool-permission.ts',
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
      '--skipLibCheck'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )

  const gitTools = await import(pathToFileURL(path.join(outDir, 'main/agent/tools/git-tools.js')).href)
  const permissions = await import(pathToFileURL(path.join(outDir, 'main/permission/tool-permission.js')).href)

  assert(
    gitTools.GIT_TOOLS.some((item) => item.function?.name === 'code_forge_delivery'),
    'code_forge_delivery schema missing'
  )

  initRepo(projectDir)
  writePassingContext(projectDir)
  writeFileSync(path.join(projectDir, 'app.txt'), 'base\n', 'utf8')
  git(projectDir, ['add', 'app.txt', 'caogen.md'])
  git(projectDir, ['commit', '-m', 'base'])
  const baseSha = git(projectDir, ['rev-parse', 'HEAD']).trim()

  git(projectDir, ['worktree', 'add', '-b', 'forge/change', worktreeDir, 'HEAD'])
  writeFileSync(path.join(worktreeDir, 'app.txt'), 'base\nforge\n', 'utf8')
  writeFileSync(path.join(worktreeDir, 'new.txt'), 'new file\n', 'utf8')

  const worktreeContext = {
    sessionId: 'code-forge-smoke',
    repoRoot: projectDir,
    worktreePath: worktreeDir,
    baseSha,
    branch: 'forge/change',
    baseBranch: 'main'
  }

  const patchResult = await gitTools.executeGitTool(
    'code_forge_delivery',
    {
      mode: 'patch',
      verificationCommand: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`
    },
    worktreeDir,
    { sessionId: 'code-forge-smoke', worktreeContext }
  )
  assert(patchResult.ok, patchResult.output)
  const patchReport = JSON.parse(patchResult.output)
  assert.equal(patchReport.status, 'ready', 'patch report should be ready')
  assert.equal(patchReport.target.kind, 'managed-worktree', 'should use managed worktree context')
  assert.equal(patchReport.verification.status, 'passed', 'verification should pass')
  assert.equal(patchReport.patch.canApply, true, 'patch should apply cleanly to source repo')
  assert(existsSync(patchReport.patch.path), 'patch file should exist')
  assert(patchReport.mergeable, 'patch report should be mergeable')
  assert(patchReport.changes.files.includes('app.txt'), 'tracked change missing')
  assert(patchReport.changes.files.includes('new.txt'), 'untracked change missing')

  const commitResult = await gitTools.executeGitTool(
    'code_forge_delivery',
    {
      mode: 'commit',
      verificationCommands: [`${JSON.stringify(process.execPath)} -e "process.exit(0)"`],
      commitMessage: 'code forge smoke delivery',
      stageAll: true,
      createPatch: true
    },
    worktreeDir,
    { sessionId: 'code-forge-smoke', worktreeContext }
  )
  assert(commitResult.ok, commitResult.output)
  const commitReport = JSON.parse(commitResult.output)
  assert.equal(commitReport.status, 'ready', 'commit report should be ready')
  assert.equal(commitReport.commit.ok, true, 'commit should succeed')
  assert.match(commitReport.commit.sha, /^[0-9a-f]{40}$/, 'commit sha missing')
  assert.equal(git(worktreeDir, ['status', '--porcelain']).trim(), '', 'worktree should be clean after commit')
  assert(readFileSync(path.join(projectDir, 'app.txt'), 'utf8') === 'base\n', 'source repo should not be mutated')

  const failedVerification = await gitTools.executeGitTool(
    'code_forge_delivery',
    {
      mode: 'report',
      verificationCommand: `${JSON.stringify(process.execPath)} -e "process.exit(9)"`
    },
    worktreeDir,
    { sessionId: 'code-forge-smoke', worktreeContext }
  )
  assert(failedVerification.ok, failedVerification.output)
  const failedReport = JSON.parse(failedVerification.output)
  assert.equal(failedReport.status, 'failed', 'failed verification should mark report failed')
  assert.equal(failedReport.mergeable, false, 'failed verification should not be mergeable')
  assert.equal(failedReport.risk.level, 'high', 'failed verification should be high risk')

  const reportRisk = permissions.classifyToolRisk('code_forge_delivery', { mode: 'report' }, projectDir)
  const commitRisk = permissions.classifyToolRisk('code_forge_delivery', { mode: 'commit' }, projectDir)
  assert.equal(reportRisk.level, 'medium', 'report mode should be medium risk')
  assert.equal(commitRisk.level, 'high', 'commit mode should be high risk')

  console.log('code forge smoke ok')
} finally {
  try {
    git(projectDir, ['worktree', 'remove', '--force', worktreeDir])
  } catch {
    // temp cleanup below is enough if git worktree metadata was already removed.
  }
  rmSync(tempRoot, { recursive: true, force: true })
}

function initRepo(dir) {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-b', 'main'])
  git(dir, ['config', 'user.email', 'smoke@example.test'])
  git(dir, ['config', 'user.name', 'CaoGen Smoke'])
}

function writePassingContext(dir) {
  writeFileSync(
    path.join(dir, 'caogen.md'),
    [
      '# Project',
      'Code Forge smoke',
      '',
      '# Commands',
      '- lint: node -e "process.exit(0)"',
      '- test: node -e "process.exit(0)"',
      ''
    ].join('\n'),
    'utf8'
  )
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
