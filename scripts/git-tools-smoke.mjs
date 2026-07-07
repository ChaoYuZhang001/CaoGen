import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-git-tools-'))
const outDir = path.join(tempRoot, 'compiled')
const projectDir = path.join(tempRoot, 'project')
const mergeDir = path.join(tempRoot, 'merge-project')

try {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/openaiTools.ts',
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

  const tools = await import(pathToFileURL(path.join(outDir, 'main/openaiTools.js')).href)
  const gitTools = await import(pathToFileURL(path.join(outDir, 'main/agent/tools/git-tools.js')).href)
  const gitHelper = await import(pathToFileURL(path.join(outDir, 'main/git/git-helper.js')).href)

  assert(tools.OPENAI_CODING_TOOLS.some((item) => item.function?.name === 'git_status'), 'git_status schema missing')
  assert(tools.OPENAI_CODING_TOOLS.some((item) => item.function?.name === 'git_create_pr'), 'git_create_pr schema missing')
  assert(tools.READONLY_TOOLS.has('git_status'), 'git_status should be readonly')
  assert(tools.READONLY_TOOLS.has('git_diff'), 'git_diff should be readonly')
  assert(!tools.EDIT_TOOLS.has('git_commit'), 'git_commit should still require explicit permission outside readonly/edit allowlists')

  initRepo(projectDir)
  writePassingContext(projectDir)
  writeFileSync(path.join(projectDir, 'app.txt'), 'hello\n', 'utf8')
  git(projectDir, ['add', 'app.txt', 'caogen.md'])
  git(projectDir, ['commit', '-m', 'initial'])

  writeFileSync(path.join(projectDir, 'app.txt'), 'hello\nchanged\n', 'utf8')
  writeFileSync(path.join(projectDir, 'notes.txt'), 'untracked\n', 'utf8')

  const statusResult = await tools.executeCodingTool('git_status', {}, projectDir)
  assert(statusResult.ok, statusResult.output)
  const statusJson = parseJson(statusResult.output)
  assert(statusJson.files.some((file) => file.path === 'app.txt' && file.kind === 'modified'), 'modified file missing')
  assert(statusJson.files.some((file) => file.path === 'notes.txt' && file.untracked), 'untracked file missing')

  const diffResult = await tools.executeCodingTool('git_diff', { file: 'app.txt' }, projectDir)
  assert(diffResult.ok, diffResult.output)
  const diffJson = parseJson(diffResult.output)
  assert(diffJson.unstagedDiff.includes('+changed'), 'unstaged diff should include changed line')

  const noStageCommit = await tools.executeCodingTool('git_commit', { message: 'should not commit unstaged' }, projectDir)
  assert(!noStageCommit.ok, 'commit should fail without staged changes')
  assert(noStageCommit.output.includes('不会自动 git add'), 'commit failure should explain no auto add')

  git(projectDir, ['add', 'app.txt'])
  const commitResult = await tools.executeCodingTool('git_commit', { message: 'commit staged change' }, projectDir)
  assert(commitResult.ok, commitResult.output)
  const commitJson = parseJson(commitResult.output)
  assert(commitJson.sha && commitJson.checks.length === 2, 'commit should return sha and two checks')
  assert(existsSync(path.join(projectDir, 'notes.txt')), 'untracked file should remain uncommitted')

  writeFileSync(path.join(projectDir, 'app.txt'), 'hello\nchanged\nblocked\n', 'utf8')
  git(projectDir, ['add', 'app.txt'])
  writeFailingContext(projectDir)
  const blockedCommit = await tools.executeCodingTool('git_commit', { message: 'blocked by checks' }, projectDir)
  assert(!blockedCommit.ok, `commit should be blocked by failing caogen command: ${blockedCommit.output}`)
  assert(blockedCommit.output.includes('提交前检查失败'), 'blocked commit should mention pre-commit checks')

  git(projectDir, ['remote', 'add', 'origin', 'git@gitee.com:owner/repo.git'])
  const prResult = await tools.executeCodingTool('git_create_pr', { title: 'Smoke PR' }, projectDir)
  assert(!prResult.ok, 'gitee PR should be recognized but not created in the basic version')
  assert(prResult.output.toLowerCase().includes('gitee'), 'PR result should mention gitee')

  assert(gitHelper.detectProviderFromRemoteUrl('git@github.com:openai/example.git') === 'github', 'github scp remote')
  assert(gitHelper.detectProviderFromRemoteUrl('https://gitlab.example.com/group/project.git') === 'gitlab', 'gitlab host remote')
  assert(gitTools.gitRemoteProvider('https://gitee.com/org/project.git') === 'gitee', 'gitee remote')
  const gitHelperSource = readFileSync(path.join(repoRoot, 'src/main/git/git-helper.ts'), 'utf8')
  assert(gitHelperSource.includes('merge preflight failed, blocked actual merge'), 'merge preflight should fail closed')

  initRepo(mergeDir)
  writeFileSync(path.join(mergeDir, 'app.txt'), 'base\n', 'utf8')
  git(mergeDir, ['add', 'app.txt'])
  git(mergeDir, ['commit', '-m', 'base'])
  git(mergeDir, ['switch', '-c', 'feature'])
  writeFileSync(path.join(mergeDir, 'app.txt'), 'feature\n', 'utf8')
  git(mergeDir, ['add', 'app.txt'])
  git(mergeDir, ['commit', '-m', 'feature change'])
  git(mergeDir, ['switch', 'main'])
  writeFileSync(path.join(mergeDir, 'app.txt'), 'main\n', 'utf8')
  git(mergeDir, ['add', 'app.txt'])
  git(mergeDir, ['commit', '-m', 'main change'])

  const mergeResult = gitHelper.gitMerge(mergeDir, 'feature')
  assert(!mergeResult.ok, 'conflicting merge should fail before actual merge')
  assert(mergeResult.conflictFiles?.includes('app.txt'), `conflict file missing: ${JSON.stringify(mergeResult)}`)
  assert(!git(mergeDir, ['status', '--porcelain']).includes('U'), 'merge preflight should not leave unmerged state')
  assert(readFileSync(path.join(mergeDir, 'app.txt'), 'utf8') === 'main\n', 'merge preflight should not rewrite file')

  console.log('git tools smoke ok')
} finally {
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
    ['# 项目概述', 'Git tools smoke', '', '# 常用命令', '- lint: node -e "process.exit(0)"', '- test: node -e "process.exit(0)"', ''].join('\n'),
    'utf8'
  )
}

function writeFailingContext(dir) {
  writeFileSync(
    path.join(dir, 'caogen.md'),
    ['# 项目概述', 'Git tools smoke', '', '# 常用命令', '- lint: node -e "process.exit(0)"', '- test: node -e "process.exit(7)"', ''].join('\n'),
    'utf8'
  )
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function parseJson(text) {
  return JSON.parse(text)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
