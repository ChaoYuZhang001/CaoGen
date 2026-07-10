import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
      '--skipLibCheck'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )

  const gitTools = await import(pathToFileURL(path.join(outDir, 'main/agent/tools/git-tools.js')).href)
  const gitHelper = await import(pathToFileURL(path.join(outDir, 'main/git/git-helper.js')).href)

  assert(gitTools.GIT_TOOLS.some((item) => item.function?.name === 'git_status'), 'git_status schema missing')
  assert(gitTools.GIT_TOOLS.some((item) => item.function?.name === 'git_create_pr'), 'git_create_pr schema missing')
  assert(gitTools.GIT_TOOLS.some((item) => item.function?.name === 'code_forge_delivery'), 'code_forge_delivery schema missing')
  const openaiToolsSource = readFileSync(path.join(repoRoot, 'src/main/openaiTools.ts'), 'utf8')
  const readonlyBlock = openaiToolsSource.slice(
    openaiToolsSource.indexOf('export const READONLY_TOOLS'),
    openaiToolsSource.indexOf('/** 文件写入类')
  )
  const idempotencySource = readFileSync(path.join(repoRoot, 'src/main/task/tool-idempotency.ts'), 'utf8')
  const sharedReadonlyBlock = idempotencySource.slice(
    idempotencySource.indexOf('export const OPENAI_PERMISSION_READ_ONLY_TOOLS'),
    idempotencySource.indexOf('const EFFECT_FREE_TOOLS')
  )
  assert(openaiToolsSource.includes('...GIT_TOOLS'), 'OpenAI coding tools should include GIT_TOOLS')
  assert(readonlyBlock.includes('OPENAI_PERMISSION_READ_ONLY_TOOLS'), 'OpenAI tools should use shared readonly classification')
  assert(sharedReadonlyBlock.includes("'git_status'"), 'git_status should be readonly')
  assert(sharedReadonlyBlock.includes("'git_diff'"), 'git_diff should be readonly')
  assert(!sharedReadonlyBlock.includes("'code_forge_delivery'"), 'code_forge_delivery should not be readonly')
  assert(openaiToolsSource.includes("export const EDIT_TOOLS = new Set(['write_file', 'search_replace', 'edit_file'])"), 'git tools should not be acceptEdits-only')

  initRepo(projectDir)
  const commandMarker = path.join(projectDir, 'caogen-command-ran.txt')
  const hookMarker = path.join(projectDir, 'git-hook-ran.txt')
  const fsmonitorMarker = path.join(projectDir, 'fsmonitor-ran.txt')
  const externalDiffMarker = path.join(projectDir, 'external-diff-ran.txt')
  const textconvMarker = path.join(projectDir, 'textconv-ran.txt')
  writeUntrustedContext(projectDir, commandMarker)
  writeFileSync(path.join(projectDir, '.gitattributes'), 'app.txt diff=caogen-unsafe\n', 'utf8')
  writeFileSync(path.join(projectDir, 'app.txt'), 'hello\n', 'utf8')
  git(projectDir, ['add', 'app.txt', 'caogen.md', '.gitattributes'])
  git(projectDir, ['commit', '-m', 'initial'])
  const fsmonitorPath = writeExecutable(
    projectDir,
    'fsmonitor.sh',
    `#!/bin/sh\ntouch ${JSON.stringify(fsmonitorMarker)}\nprintf '1\\n\\n'\n`
  )
  const externalDiffPath = writeExecutable(
    projectDir,
    'external-diff.sh',
    `#!/bin/sh\ntouch ${JSON.stringify(externalDiffMarker)}\nexit 0\n`
  )
  const textconvPath = writeExecutable(
    projectDir,
    'textconv.sh',
    `#!/bin/sh\ntouch ${JSON.stringify(textconvMarker)}\ncat "$1"\n`
  )
  git(projectDir, ['config', 'core.fsmonitor', fsmonitorPath])
  git(projectDir, ['config', 'diff.external', externalDiffPath])
  git(projectDir, ['config', 'diff.caogen-unsafe.textconv', textconvPath])
  const hookPath = path.join(projectDir, '.git', 'hooks', 'pre-commit')
  writeFileSync(hookPath, `#!/bin/sh\ntouch ${JSON.stringify(hookMarker)}\nexit 91\n`, 'utf8')
  chmodSync(hookPath, 0o755)
  const postHookPath = path.join(projectDir, '.git', 'hooks', 'post-commit')
  writeFileSync(postHookPath, `#!/bin/sh\ntouch ${JSON.stringify(hookMarker)}\n`, 'utf8')
  chmodSync(postHookPath, 0o755)

  writeFileSync(path.join(projectDir, 'app.txt'), 'hello\nchanged\n', 'utf8')
  writeFileSync(path.join(projectDir, 'notes.txt'), 'untracked\n', 'utf8')

  const statusResult = await gitTools.executeGitTool('git_status', {}, projectDir)
  assert(statusResult.ok, statusResult.output)
  const statusJson = parseJson(statusResult.output)
  assert(statusJson.files.some((file) => file.path === 'app.txt' && file.kind === 'modified'), 'modified file missing')
  assert(statusJson.files.some((file) => file.path === 'notes.txt' && file.untracked), 'untracked file missing')
  assert(!existsSync(fsmonitorMarker), 'permission-free git_status must not execute core.fsmonitor')

  const diffResult = await gitTools.executeGitTool('git_diff', { file: 'app.txt' }, projectDir)
  assert(diffResult.ok, diffResult.output)
  const diffJson = parseJson(diffResult.output)
  assert(diffJson.unstagedDiff.includes('+changed'), 'unstaged diff should include changed line')
  assert(!existsSync(externalDiffMarker), 'git_diff must not execute diff.external')
  assert(!existsSync(textconvMarker), 'git_diff must not execute a configured textconv command')

  const noStageCommit = await gitTools.executeGitTool('git_commit', { message: 'should not commit unstaged' }, projectDir)
  assert(!noStageCommit.ok, 'commit should fail without staged changes')
  assert(noStageCommit.output.includes('不会自动 git add'), 'commit failure should explain no auto add')

  git(projectDir, ['add', 'app.txt'])
  const commitResult = await gitTools.executeGitTool('git_commit', { message: 'commit staged change' }, projectDir)
  assert(commitResult.ok, commitResult.output)
  const commitJson = parseJson(commitResult.output)
  assert(commitJson.sha && commitJson.checks.length === 0, 'commit should return sha without implicit shell checks')
  assert(!existsSync(commandMarker), 'git_commit must not execute commands embedded in caogen.md')
  assert(!existsSync(hookMarker), 'git_commit must bypass pre and post repository hooks')
  assert(existsSync(path.join(projectDir, 'notes.txt')), 'untracked file should remain uncommitted')

  writeFileSync(path.join(projectDir, 'app.txt'), 'hello\nchanged\nsecond\n', 'utf8')
  git(projectDir, ['add', 'app.txt'])
  const secondCommit = await gitTools.executeGitTool('git_commit', { message: 'second safe commit' }, projectDir)
  assert(secondCommit.ok, `repository commands and hooks must stay inert: ${secondCommit.output}`)
  assert(!existsSync(commandMarker) && !existsSync(hookMarker), 'hidden repository commands must remain unexecuted')

  git(projectDir, ['remote', 'add', 'origin', 'git@gitee.com:owner/repo.git'])
  const prResult = await gitTools.executeGitTool('git_create_pr', { title: 'Smoke PR' }, projectDir)
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

function writeUntrustedContext(dir, marker) {
  writeFileSync(
    path.join(dir, 'caogen.md'),
    [
      '# 项目概述',
      'Git tools smoke',
      '',
      '# 常用命令',
      `- lint: node -e "require('node:fs').writeFileSync('${marker}', 'ran')"`,
      '- test: node -e "process.exit(91)"',
      ''
    ].join('\n'),
    'utf8'
  )
}

function writeExecutable(dir, name, content) {
  const file = path.join(dir, name)
  writeFileSync(file, content, 'utf8')
  chmodSync(file, 0o755)
  return file
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
