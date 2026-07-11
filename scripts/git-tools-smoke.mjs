import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
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
const successfulMergeDir = path.join(tempRoot, 'successful-merge-project')
const conflictingMergeDir = path.join(tempRoot, 'conflicting-merge-project')
const structuredReadFilterDir = path.join(tempRoot, 'structured-read-filter-project')
const structuredReadSubmoduleDir = path.join(tempRoot, 'structured-read-submodule-project')

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

  const gitHelperPath = path.join(outDir, 'main/git/git-helper.js')
  writeFileSync(
    gitHelperPath,
    `${readFileSync(gitHelperPath, 'utf8')}\nexports.__testRunMergeWithCas = runMergeWithCas;\nexports.__testMergeExecutionEnv = mergeExecutionEnv;\nexports.__testMergeCommitEnv = mergeCommitEnv;\n`,
    'utf8'
  )
  const gitTools = await import(pathToFileURL(path.join(outDir, 'main/agent/tools/git-tools.js')).href)
  const gitHelper = await import(pathToFileURL(gitHelperPath).href)

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

  initRepo(structuredReadFilterDir)
  commitFiles(structuredReadFilterDir, 'base', { 'tracked.txt': 'before\n' })
  const filterMarker = path.join(structuredReadFilterDir, 'filter-ran.txt')
  const filterPath = writeExecutable(
    structuredReadFilterDir,
    'unsafe-filter.sh',
    `#!/bin/sh\ntouch ${JSON.stringify(filterMarker)}\ncat\n`
  )
  writeFileSync(path.join(structuredReadFilterDir, '.gitattributes'), '*.txt filter=caogen-audit\n', 'utf8')
  writeFileSync(path.join(structuredReadFilterDir, 'tracked.txt'), 'after\n', 'utf8')
  git(structuredReadFilterDir, ['config', 'filter.caogen-audit.clean', filterPath])
  const unsafeStatus = gitHelper.gitStatus(structuredReadFilterDir)
  assert(!unsafeStatus.ok, 'git_status must fail closed when a repository clean filter is configured')
  assert(unsafeStatus.error.includes('Git filter'), `git_status should explain blocked filter: ${unsafeStatus.error}`)
  assert(!existsSync(filterMarker), 'git_status must not execute a repository clean filter')

  git(structuredReadFilterDir, ['config', '--unset', 'filter.caogen-audit.clean'])
  git(structuredReadFilterDir, ['config', 'filter.caogen-audit.process', filterPath])
  const unsafeDiff = gitHelper.gitDiff(structuredReadFilterDir, 'tracked.txt')
  assert(!unsafeDiff.ok, 'git_diff must fail closed when a repository process filter is configured')
  assert(unsafeDiff.error.includes('Git filter'), `git_diff should explain blocked filter: ${unsafeDiff.error}`)
  assert(!existsSync(filterMarker), 'git_diff must not execute a repository process filter')

  const submoduleSourceDir = path.join(tempRoot, 'unsafe-filter-submodule-source')
  initRepo(submoduleSourceDir)
  commitFiles(submoduleSourceDir, 'submodule base', {
    '.gitattributes': '*.txt filter=caogen-submodule-audit\n',
    'tracked.txt': 'before\n'
  })
  initRepo(structuredReadSubmoduleDir)
  commitFiles(structuredReadSubmoduleDir, 'parent base', { 'parent.txt': 'parent\n' })
  git(structuredReadSubmoduleDir, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    submoduleSourceDir,
    'vendor/sub'
  ])
  git(structuredReadSubmoduleDir, ['commit', '-am', 'add submodule'])
  const checkedOutSubmodule = path.join(structuredReadSubmoduleDir, 'vendor', 'sub')
  const submoduleFilterMarker = path.join(tempRoot, 'submodule-filter-ran.txt')
  const submoduleFilterPath = writeExecutable(
    tempRoot,
    'unsafe-submodule-filter.sh',
    `#!/bin/sh\ntouch ${JSON.stringify(submoduleFilterMarker)}\ncat\n`
  )
  git(checkedOutSubmodule, ['config', 'filter.caogen-submodule-audit.clean', submoduleFilterPath])
  writeFileSync(path.join(checkedOutSubmodule, 'tracked.txt'), 'after!\n', 'utf8')
  const submoduleStatus = gitHelper.gitStatus(structuredReadSubmoduleDir)
  assert(submoduleStatus.ok, `git_status should safely ignore submodule worktree dirt: ${JSON.stringify(submoduleStatus)}`)
  assert(!existsSync(submoduleFilterMarker), 'git_status must not execute filters from a dirty submodule')
  const submoduleDiff = gitHelper.gitDiff(structuredReadSubmoduleDir)
  assert(submoduleDiff.ok, `git_diff should safely ignore submodule worktree dirt: ${JSON.stringify(submoduleDiff)}`)
  assert(!existsSync(submoduleFilterMarker), 'git_diff must not execute filters from a dirty submodule')
  git(structuredReadSubmoduleDir, ['branch', 'safe-feature'])
  const submoduleMerge = gitHelper.gitMerge(structuredReadSubmoduleDir, 'safe-feature')
  assert(submoduleMerge.ok, `git_merge preflight should safely ignore submodule worktree dirt: ${JSON.stringify(submoduleMerge)}`)
  assert(!existsSync(submoduleFilterMarker), 'git_merge preflight must not execute filters from a dirty submodule')

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
  assert(
    gitHelperSource.includes('merge preflight failed, blocked actual merge') ||
      gitHelperSource.includes('merge 会产生冲突'),
    'merge conflicts should fail closed'
  )

  initRepo(successfulMergeDir)
  commitFiles(successfulMergeDir, 'base', { 'app.txt': 'base\n' })
  git(successfulMergeDir, ['switch', '-c', 'feature'])
  commitFiles(successfulMergeDir, 'feature change', { 'feature.txt': 'feature\n' })
  const successfulSourceHead = gitHead(successfulMergeDir)
  git(successfulMergeDir, ['switch', 'main'])
  const successfulPreHead = gitHead(successfulMergeDir)
  const preMergeHookMarker = path.join(successfulMergeDir, '.git', 'pre-merge-hook-ran.txt')
  const postMergeHookMarker = path.join(successfulMergeDir, '.git', 'post-merge-hook-ran.txt')
  writeHook(
    successfulMergeDir,
    'pre-merge-commit',
    `#!/bin/sh\ntouch ${JSON.stringify(preMergeHookMarker)}\nexit 91\n`
  )
  writeHook(successfulMergeDir, 'post-merge', `#!/bin/sh\ntouch ${JSON.stringify(postMergeHookMarker)}\nexit 91\n`)

  const successfulMerge = gitHelper.gitMerge(successfulMergeDir, 'feature')
  assert(successfulMerge.ok, `non-conflicting merge should succeed: ${JSON.stringify(successfulMerge)}`)
  const successfulParents = git(successfulMergeDir, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(/\s+/)
  assert(successfulParents.length === 3, `git_merge must create a --no-ff merge commit: ${successfulParents.join(' ')}`)
  assert(successfulParents[1] === successfulPreHead, 'merge commit first parent should be the destination pre-merge HEAD')
  assert(successfulParents[2] === successfulSourceHead, 'merge commit second parent should be the frozen source commit')
  assert(!existsSync(preMergeHookMarker), 'git_merge must not execute repository pre-merge-commit hooks')
  assert(!existsSync(postMergeHookMarker), 'git_merge must not execute repository post-merge hooks')

  const globalIdentityDir = path.join(tempRoot, 'global-only-merge-identity')
  prepareFastForwardMergeRepo(globalIdentityDir)
  git(globalIdentityDir, ['config', '--unset', 'user.name'])
  git(globalIdentityDir, ['config', '--unset', 'user.email'])
  const globalIdentityHome = path.join(tempRoot, 'global-identity-home')
  const globalIdentityXdg = path.join(tempRoot, 'global-identity-xdg')
  mkdirSync(globalIdentityHome, { recursive: true })
  mkdirSync(globalIdentityXdg, { recursive: true })
  const globalIdentityConfig = path.join(globalIdentityHome, '.gitconfig')
  git(tempRoot, ['config', '--file', globalIdentityConfig, 'user.name', 'Global Merge Identity'])
  git(tempRoot, ['config', '--file', globalIdentityConfig, 'user.email', 'global-merge@example.test'])
  const previousIdentityEnv = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
  process.env.HOME = globalIdentityHome
  process.env.XDG_CONFIG_HOME = globalIdentityXdg
  try {
    const globalIdentityMerge = gitHelper.gitMerge(globalIdentityDir, 'feature')
    assert(globalIdentityMerge.ok, `global-only Git identity must support merge commits: ${JSON.stringify(globalIdentityMerge)}`)
  } finally {
    restoreEnv('HOME', previousIdentityEnv.HOME)
    restoreEnv('XDG_CONFIG_HOME', previousIdentityEnv.XDG_CONFIG_HOME)
  }
  const [globalAuthorName, globalAuthorEmail] = git(
    globalIdentityDir,
    ['show', '-s', '--format=%an%x00%ae', 'HEAD']
  ).trim().split('\0')
  assert(globalAuthorName === 'Global Merge Identity', `merge author must use global user.name: ${globalAuthorName}`)
  assert(globalAuthorEmail === 'global-merge@example.test', `merge author must use global user.email: ${globalAuthorEmail}`)

  const noIdentityNoopDir = path.join(tempRoot, 'no-identity-noop-merge')
  initRepo(noIdentityNoopDir)
  commitFiles(noIdentityNoopDir, 'already merged base', { 'base.txt': 'base\n' })
  git(noIdentityNoopDir, ['branch', 'feature'])
  git(noIdentityNoopDir, ['config', '--unset', 'user.name'])
  git(noIdentityNoopDir, ['config', '--unset', 'user.email'])
  const noIdentityHome = path.join(tempRoot, 'no-identity-home')
  const noIdentityXdg = path.join(tempRoot, 'no-identity-xdg')
  mkdirSync(noIdentityHome, { recursive: true })
  mkdirSync(noIdentityXdg, { recursive: true })
  const previousNoIdentityEnv = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
  process.env.HOME = noIdentityHome
  process.env.XDG_CONFIG_HOME = noIdentityXdg
  try {
    const noIdentityNoopMerge = gitHelper.gitMerge(noIdentityNoopDir, 'feature')
    assert(noIdentityNoopMerge.ok, `already-up-to-date merge must not require commit identity: ${JSON.stringify(noIdentityNoopMerge)}`)
  } finally {
    restoreEnv('HOME', previousNoIdentityEnv.HOME)
    restoreEnv('XDG_CONFIG_HOME', previousNoIdentityEnv.XDG_CONFIG_HOME)
  }

  const frozenSourceDir = path.join(tempRoot, 'frozen-source-merge')
  initRepo(frozenSourceDir)
  commitFiles(frozenSourceDir, 'base', { 'base.txt': 'base\n' })
  git(frozenSourceDir, ['switch', '-c', 'feature'])
  commitFiles(frozenSourceDir, 'approved source', { 'approved.txt': 'approved\n' })
  const approvedSourceSha = gitHead(frozenSourceDir)
  commitFiles(frozenSourceDir, 'later source drift', { 'later.txt': 'later\n' })
  git(frozenSourceDir, ['switch', 'main'])
  const frozenPreHead = gitHead(frozenSourceDir)
  const frozenMerge = gitHelper.gitMerge(
    frozenSourceDir,
    'feature',
    mergeExecutionPlan(frozenSourceDir, frozenPreHead, 'refs/heads/feature', approvedSourceSha)
  )
  assert(frozenMerge.ok, `frozen source SHA merge should succeed: ${JSON.stringify(frozenMerge)}`)
  const frozenParents = git(frozenSourceDir, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(/\s+/)
  assert(frozenParents[2] === approvedSourceSha, 'git_merge execution plan must merge the approved SHA, not the moved source ref')
  assert(!existsSync(path.join(frozenSourceDir, 'later.txt')), 'source commits created after approval must not enter the merge')

  const assumeUnchangedDir = path.join(tempRoot, 'assume-unchanged-local-data')
  initRepo(assumeUnchangedDir)
  commitFiles(assumeUnchangedDir, 'base tracked file', { 'app.txt': 'base\n' })
  git(assumeUnchangedDir, ['switch', '-c', 'feature'])
  commitFiles(assumeUnchangedDir, 'feature edits tracked file', { 'app.txt': 'feature\n' })
  git(assumeUnchangedDir, ['switch', 'main'])
  git(assumeUnchangedDir, ['update-index', '--assume-unchanged', 'app.txt'])
  writeFileSync(path.join(assumeUnchangedDir, 'app.txt'), 'local private data\n', 'utf8')
  const assumeUnchangedPreHead = gitHead(assumeUnchangedDir)
  const assumeUnchangedMerge = gitHelper.gitMerge(assumeUnchangedDir, 'feature')
  assert(!assumeUnchangedMerge.ok, 'git_merge must reject assume-unchanged paths before real merge execution')
  assert(gitHead(assumeUnchangedDir) === assumeUnchangedPreHead, 'blocked assume-unchanged merge must preserve HEAD')
  assert(
    readFileSync(path.join(assumeUnchangedDir, 'app.txt'), 'utf8') === 'local private data\n',
    'blocked assume-unchanged merge must preserve hidden local data'
  )

  const sparseMergeDir = path.join(tempRoot, 'sparse-checkout-merge')
  initRepo(sparseMergeDir)
  mkdirSync(path.join(sparseMergeDir, 'keep'), { recursive: true })
  mkdirSync(path.join(sparseMergeDir, 'omit'), { recursive: true })
  commitFiles(sparseMergeDir, 'sparse base', {
    'keep/a.txt': 'keep\n',
    'omit/b.txt': 'omit\n'
  })
  git(sparseMergeDir, ['switch', '-c', 'feature'])
  commitFiles(sparseMergeDir, 'feature inside sparse cone', { 'keep/feature.txt': 'feature\n' })
  git(sparseMergeDir, ['switch', 'main'])
  git(sparseMergeDir, ['sparse-checkout', 'init', '--cone'])
  git(sparseMergeDir, ['sparse-checkout', 'set', 'keep'])
  const sparseFlags = git(sparseMergeDir, ['ls-files', '-v'])
  assert(sparseFlags.includes('S omit/b.txt'), `fixture must contain a normal skip-worktree path: ${sparseFlags}`)
  const sparseMerge = gitHelper.gitMerge(sparseMergeDir, 'feature')
  assert(sparseMerge.ok, `normal sparse-checkout skip-worktree paths must not block merge: ${JSON.stringify(sparseMerge)}`)
  assert(existsSync(path.join(sparseMergeDir, 'keep', 'feature.txt')), 'sparse merge must materialize in-cone source files')
  assert(!existsSync(path.join(sparseMergeDir, 'omit', 'b.txt')), 'sparse merge must preserve the omitted cone state')

  const directHookCasDir = path.join(tempRoot, 'direct-reference-transaction-cas')
  initRepo(directHookCasDir)
  commitFiles(directHookCasDir, 'base', { 'base.txt': 'base\n' })
  const directHookPreHead = gitHead(directHookCasDir)
  git(directHookCasDir, ['switch', '-c', 'feature'])
  commitFiles(directHookCasDir, 'feature change', { 'feature.txt': 'feature\n' })
  const directHookSourceSha = gitHead(directHookCasDir)
  git(directHookCasDir, ['switch', 'main'])
  const directHookExpectedTree = git(
    directHookCasDir,
    ['merge-tree', '--write-tree', directHookPreHead, directHookSourceSha]
  ).split(/\r?\n/, 1)[0].trim()
  commitFiles(directHookCasDir, 'destination drift', { 'drift.txt': 'drift\n' })
  const directHookDriftHead = gitHead(directHookCasDir)
  const directHookBaseEnv = gitHelper.__testMergeExecutionEnv(
    directHookCasDir,
    path.join(directHookCasDir, '.git'),
    path.join(directHookCasDir, '.git')
  )
  const directHookEnv = gitHelper.__testMergeCommitEnv(
    directHookCasDir,
    path.join(directHookCasDir, '.git'),
    path.join(directHookCasDir, '.git'),
    directHookBaseEnv
  )
  assert(directHookEnv.ok, `direct hook fixture must resolve an explicit Git identity: ${JSON.stringify(directHookEnv)}`)
  const directHookResult = gitHelper.__testRunMergeWithCas(
    directHookCasDir,
    'main',
    'refs/heads/main',
    directHookPreHead,
    directHookSourceSha,
    directHookExpectedTree,
    directHookEnv.env
  )
  assert(!directHookResult.ok, 'reference-transaction hook must reject a mismatched destination old SHA')
  assert(
    directHookResult.error?.includes('destination ref changed after approval'),
    `reference-transaction hook must emit its explicit CAS rejection: ${JSON.stringify(directHookResult)}`
  )
  assert(gitHead(directHookCasDir) === directHookDriftHead, 'rejected reference transaction must preserve destination ref')

  const destinationCasDir = path.join(tempRoot, 'destination-cas-merge')
  initRepo(destinationCasDir)
  commitFiles(destinationCasDir, 'base', { 'base.txt': 'base\n' })
  git(destinationCasDir, ['switch', '-c', 'feature'])
  const casFeatureFiles = {}
  for (let index = 0; index < 500; index += 1) {
    casFeatureFiles[`cas-file-${String(index).padStart(4, '0')}.txt`] = `feature ${index}\n`
  }
  commitFiles(destinationCasDir, 'large feature', casFeatureFiles)
  const casSourceSha = gitHead(destinationCasDir)
  git(destinationCasDir, ['switch', 'main'])
  const casPreHead = gitHead(destinationCasDir)
  const casPreTree = git(destinationCasDir, ['rev-parse', 'HEAD^{tree}']).trim()
  const casDriftHead = git(destinationCasDir, [
    'commit-tree',
    casPreTree,
    '-p',
    casPreHead,
    '-m',
    'concurrent destination drift'
  ]).trim()
  const casWatcher = spawn('/bin/sh', ['-c', [
    'set -eu',
    `while :; do for candidate in ${JSON.stringify(tmpdir())}/caogen-merge-hooks-${process.pid}-*; do`,
    '  if [ -d "$candidate" ]; then exit_loop=1; break; fi',
    'done',
    '  [ "${exit_loop:-0}" = 1 ] && break',
    'done',
    `git -C ${JSON.stringify(destinationCasDir)} update-ref refs/heads/main ${casDriftHead} ${casPreHead}`
  ].join('\n')], { stdio: ['ignore', 'pipe', 'pipe'] })
  const casMerge = gitHelper.gitMerge(
    destinationCasDir,
    'feature',
    mergeExecutionPlan(destinationCasDir, casPreHead, 'refs/heads/feature', casSourceSha)
  )
  const casWatcherResult = await waitForChild(casWatcher)
  assert(casWatcherResult.code === 0, `destination drift watcher failed: ${casWatcherResult.stderr}`)
  assert(!casMerge.ok, 'destination ref CAS must reject a branch move after the final preflight check')
  assert(gitHead(destinationCasDir) === casDriftHead, 'failed CAS merge must preserve the independently advanced destination ref')
  assert(git(destinationCasDir, ['status', '--porcelain']) === '', 'failed CAS merge must not leave index/worktree changes')
  assert(!existsSync(path.join(destinationCasDir, 'cas-file-0000.txt')), 'failed CAS merge must not expose source files')

  const semanticDriftDir = path.join(tempRoot, 'merge-semantics-drift')
  initRepo(semanticDriftDir)
  commitFiles(semanticDriftDir, 'semantic drift base', { 'app.txt': 'base one\nshared\nbase three\n' })
  git(semanticDriftDir, ['switch', '-c', 'feature'])
  commitFiles(semanticDriftDir, 'feature edits first line', { 'app.txt': 'feature one\nshared\nbase three\n' })
  git(semanticDriftDir, ['switch', 'main'])
  commitFiles(semanticDriftDir, 'main edits last line', { 'app.txt': 'base one\nshared\nmain three\n' })
  const semanticDriftPreHead = gitHead(semanticDriftDir)
  const semanticWrapperDir = path.join(tempRoot, 'semantic-drift-wrapper')
  mkdirSync(semanticWrapperDir, { recursive: true })
  const semanticDriftMarker = path.join(tempRoot, 'semantic-drift-real-merge-ran.txt')
  const semanticRealGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  writeExecutable(
    semanticWrapperDir,
    'git',
    [
      '#!/bin/sh',
      'is_merge=0',
      'is_no_ff=0',
      'for arg in "$@"',
      'do',
      '  [ "$arg" = "merge" ] && is_merge=1',
      '  [ "$arg" = "--no-ff" ] && is_no_ff=1',
      'done',
      'if [ "$is_merge" = 1 ] && [ "$is_no_ff" = 1 ]',
      'then',
      '  printf "semantic drift wrapper reached real merge\\n" > "$CAOGEN_SEMANTIC_MARKER"',
      '  printf "app.txt merge=caogen-race\\n" > "$CAOGEN_SEMANTIC_REPO/.git/info/attributes"',
      '  "$CAOGEN_REAL_GIT" -C "$CAOGEN_SEMANTIC_REPO" config merge.caogen-race.driver true',
      'fi',
      'exec "$CAOGEN_REAL_GIT" "$@"',
      ''
    ].join('\n')
  )
  const semanticDriftEnv = {
    PATH: process.env.PATH,
    CAOGEN_SEMANTIC_MARKER: process.env.CAOGEN_SEMANTIC_MARKER,
    CAOGEN_SEMANTIC_REPO: process.env.CAOGEN_SEMANTIC_REPO,
    CAOGEN_REAL_GIT: process.env.CAOGEN_REAL_GIT
  }
  process.env.PATH = `${semanticWrapperDir}${path.delimiter}${process.env.PATH ?? ''}`
  process.env.CAOGEN_SEMANTIC_MARKER = semanticDriftMarker
  process.env.CAOGEN_SEMANTIC_REPO = semanticDriftDir
  process.env.CAOGEN_REAL_GIT = semanticRealGit
  let semanticDriftMerge
  try {
    semanticDriftMerge = gitHelper.gitMerge(semanticDriftDir, 'feature')
  } finally {
    restoreEnv('PATH', semanticDriftEnv.PATH)
    restoreEnv('CAOGEN_SEMANTIC_MARKER', semanticDriftEnv.CAOGEN_SEMANTIC_MARKER)
    restoreEnv('CAOGEN_SEMANTIC_REPO', semanticDriftEnv.CAOGEN_SEMANTIC_REPO)
    restoreEnv('CAOGEN_REAL_GIT', semanticDriftEnv.CAOGEN_REAL_GIT)
  }
  assert(existsSync(semanticDriftMarker), 'fixture must change merge semantics only when the real merge starts')
  assert(!semanticDriftMerge.ok, 'reference transaction must reject a commit built with drifted merge semantics')
  assert(
    semanticDriftMerge.details?.includes('does not match approved parents/tree'),
    `semantic drift rejection must come from the trusted hook: ${JSON.stringify(semanticDriftMerge)}`
  )
  assert(gitHead(semanticDriftDir) === semanticDriftPreHead, 'semantic drift rejection must preserve destination ref')
  assert(git(semanticDriftDir, ['status', '--porcelain']) === '', 'semantic drift rejection must restore index/worktree')
  assert(
    readFileSync(path.join(semanticDriftDir, 'app.txt'), 'utf8') === 'base one\nshared\nmain three\n',
    'semantic drift rejection must preserve destination content'
  )

  prepareConflictingMergeRepo(conflictingMergeDir)
  const conflictingPreHead = gitHead(conflictingMergeDir)
  const conflictingObjectsBefore = gitObjectInventory(conflictingMergeDir)
  const mergeResult = gitHelper.gitMerge(conflictingMergeDir, 'feature')
  assert(!mergeResult.ok, 'conflicting merge should fail before actual merge')
  assert(mergeResult.conflictFiles?.includes('app.txt'), `conflict file missing: ${JSON.stringify(mergeResult)}`)
  assert(gitHead(conflictingMergeDir) === conflictingPreHead, 'conflicting merge must not move HEAD')
  assert(!existsSync(path.join(conflictingMergeDir, '.git', 'MERGE_HEAD')), 'conflicting merge must not leave MERGE_HEAD')
  assert(git(conflictingMergeDir, ['status', '--porcelain']) === '', 'conflicting merge must leave the worktree clean')
  assert(readFileSync(path.join(conflictingMergeDir, 'app.txt'), 'utf8') === 'main\n', 'conflicting merge must not rewrite files')
  assert(
    JSON.stringify(gitObjectInventory(conflictingMergeDir)) === JSON.stringify(conflictingObjectsBefore),
    'conflicting merge-tree preflight must not write unreachable objects into the repository object database'
  )

  const colonMergeDir = path.join(tempRoot, 'repo:colon')
  prepareFastForwardMergeRepo(colonMergeDir)
  const colonMerge = gitHelper.gitMerge(colonMergeDir, 'feature')
  assert(colonMerge.ok, `git_merge must support repository paths containing a colon: ${JSON.stringify(colonMerge)}`)
  assert(existsSync(path.join(colonMergeDir, 'feature.txt')), 'colon-path merge must materialize the source tree')

  for (const mergeDriverName of ['caogen-unsafe', 'text']) {
    const unsafeMergeDir = path.join(tempRoot, `unsafe-merge-driver-${mergeDriverName}`)
    prepareConflictingMergeRepo(unsafeMergeDir, `app.txt merge=${mergeDriverName}\n`)
    const marker = path.join(unsafeMergeDir, '.git', `${mergeDriverName}-driver-ran.txt`)
    const driver = writeExecutable(
      path.join(unsafeMergeDir, '.git'),
      `${mergeDriverName}-driver.sh`,
      `#!/bin/sh\ntouch ${JSON.stringify(marker)}\ncp "$3" "$2"\n`
    )
    git(unsafeMergeDir, ['config', `merge.${mergeDriverName}.driver`, `${JSON.stringify(driver)} %O %A %B`])
    const preHead = gitHead(unsafeMergeDir)

    const unsafeMerge = gitHelper.gitMerge(unsafeMergeDir, 'feature')
    assert(!unsafeMerge.ok, `configured merge.${mergeDriverName}.driver must block git_merge`)
    assert(!existsSync(marker), `git_merge must not execute merge.${mergeDriverName}.driver`)
    assert(gitHead(unsafeMergeDir) === preHead, `blocked merge.${mergeDriverName}.driver must not move HEAD`)
    assert(!existsSync(path.join(unsafeMergeDir, '.git', 'MERGE_HEAD')), 'blocked merge driver must not leave MERGE_HEAD')
    assert(readFileSync(path.join(unsafeMergeDir, 'app.txt'), 'utf8') === 'main\n', 'blocked merge driver must not rewrite files')
  }

  for (const filterCommand of ['clean', 'smudge', 'process']) {
    const unsafeFilterDir = path.join(tempRoot, `unsafe-filter-${filterCommand}`)
    prepareFastForwardMergeRepo(unsafeFilterDir, 'app.txt filter=caogen-unsafe\n')
    const marker = path.join(unsafeFilterDir, '.git', `${filterCommand}-filter-ran.txt`)
    const filter = writeExecutable(
      path.join(unsafeFilterDir, '.git'),
      `${filterCommand}-filter.sh`,
      `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 91\n`
    )
    git(unsafeFilterDir, ['config', `filter.caogen-unsafe.${filterCommand}`, JSON.stringify(filter)])
    const preHead = gitHead(unsafeFilterDir)

    const unsafeMerge = gitHelper.gitMerge(unsafeFilterDir, 'feature')
    assert(!unsafeMerge.ok, `configured filter.*.${filterCommand} must block git_merge`)
    assert(!existsSync(marker), `git_merge must not execute filter.*.${filterCommand}`)
    assert(gitHead(unsafeFilterDir) === preHead, `blocked filter.*.${filterCommand} must not move HEAD`)
    assert(!existsSync(path.join(unsafeFilterDir, '.git', 'MERGE_HEAD')), 'blocked filter command must not leave MERGE_HEAD')
    assert(readFileSync(path.join(unsafeFilterDir, 'app.txt'), 'utf8') === 'base\n', 'blocked filter command must not rewrite files')
  }

  const mergeOptionsDir = path.join(tempRoot, 'unsafe-branch-merge-options')
  prepareFastForwardMergeRepo(mergeOptionsDir)
  const strategyMarker = path.join(mergeOptionsDir, '.git', 'external-strategy-ran.txt')
  const strategy = writeExecutable(
    tempRoot,
    'git-merge-caogen-unsafe',
    `#!/bin/sh\ntouch ${JSON.stringify(strategyMarker)}\nexit 91\n`
  )
  git(mergeOptionsDir, ['config', 'branch.main.mergeOptions', '-s caogen-unsafe'])
  const previousPath = process.env.PATH
  process.env.PATH = `${path.dirname(strategy)}${path.delimiter}${previousPath ?? ''}`
  try {
    const unsafeOptionsMerge = gitHelper.gitMerge(mergeOptionsDir, 'feature')
    assert(!unsafeOptionsMerge.ok, 'branch.*.mergeOptions must block git_merge')
    assert(!existsSync(strategyMarker), 'git_merge must not execute an external strategy from branch mergeOptions')
  } finally {
    process.env.PATH = previousPath
  }

  const injectedConfigDir = path.join(tempRoot, 'injected-config-driver')
  prepareConflictingMergeRepo(injectedConfigDir, 'app.txt merge=caogen-env\n')
  const injectedMarker = path.join(injectedConfigDir, '.git', 'injected-driver-ran.txt')
  const injectedDriver = writeExecutable(
    path.join(injectedConfigDir, '.git'),
    'injected-driver.sh',
    `#!/bin/sh\ntouch ${JSON.stringify(injectedMarker)}\ncp "$3" "$2"\n`
  )
  const injectedEnv = {
    GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
    GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
    GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0
  }
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = 'merge.caogen-env.driver'
  process.env.GIT_CONFIG_VALUE_0 = `${JSON.stringify(injectedDriver)} %O %A %B`
  try {
    const injectedMerge = gitHelper.gitMerge(injectedConfigDir, 'feature')
    assert(!injectedMerge.ok, 'sanitized merge must retain the built-in conflict instead of using injected config')
    assert(!existsSync(injectedMarker), 'git_merge must strip GIT_CONFIG_* command injection')
  } finally {
    restoreEnv('GIT_CONFIG_COUNT', injectedEnv.GIT_CONFIG_COUNT)
    restoreEnv('GIT_CONFIG_KEY_0', injectedEnv.GIT_CONFIG_KEY_0)
    restoreEnv('GIT_CONFIG_VALUE_0', injectedEnv.GIT_CONFIG_VALUE_0)
  }

  const ignoredCollisionDir = path.join(tempRoot, 'ignored-collision')
  initRepo(ignoredCollisionDir)
  commitFiles(ignoredCollisionDir, 'ignore local secret', { '.gitignore': 'secret.txt\n', 'base.txt': 'base\n' })
  git(ignoredCollisionDir, ['switch', '-c', 'feature'])
  writeFileSync(path.join(ignoredCollisionDir, 'secret.txt'), 'feature version\n', 'utf8')
  git(ignoredCollisionDir, ['add', '-f', 'secret.txt'])
  git(ignoredCollisionDir, ['commit', '-m', 'track ignored path on feature'])
  git(ignoredCollisionDir, ['switch', 'main'])
  writeFileSync(path.join(ignoredCollisionDir, 'secret.txt'), 'local private data\n', 'utf8')
  const ignoredCollisionMerge = gitHelper.gitMerge(ignoredCollisionDir, 'feature')
  assert(!ignoredCollisionMerge.ok, 'git_merge must block incoming paths that collide with local ignored files')
  assert(
    readFileSync(path.join(ignoredCollisionDir, 'secret.txt'), 'utf8') === 'local private data\n',
    'blocked merge must preserve ignored local data'
  )

  const ignoredRenameCollisionDir = path.join(tempRoot, 'ignored-rename-collision')
  initRepo(ignoredRenameCollisionDir)
  commitFiles(ignoredRenameCollisionDir, 'base with rename source', {
    '.gitignore': 'secret.txt\n',
    'old.txt': 'tracked source\n'
  })
  git(ignoredRenameCollisionDir, ['switch', '-c', 'feature'])
  git(ignoredRenameCollisionDir, ['mv', 'old.txt', 'secret.txt'])
  git(ignoredRenameCollisionDir, ['commit', '-m', 'rename tracked file into ignored path'])
  git(ignoredRenameCollisionDir, ['switch', 'main'])
  writeFileSync(path.join(ignoredRenameCollisionDir, 'secret.txt'), 'local private data\n', 'utf8')
  const ignoredRenamePreHead = gitHead(ignoredRenameCollisionDir)
  const ignoredRenameMerge = gitHelper.gitMerge(ignoredRenameCollisionDir, 'feature')
  assert(!ignoredRenameMerge.ok, 'git_merge must treat rename destinations as incoming added paths')
  assert(gitHead(ignoredRenameCollisionDir) === ignoredRenamePreHead, 'blocked rename collision must preserve HEAD')
  assert(
    readFileSync(path.join(ignoredRenameCollisionDir, 'secret.txt'), 'utf8') === 'local private data\n',
    'blocked rename collision must preserve ignored local data'
  )
  assert(
    readFileSync(path.join(ignoredRenameCollisionDir, 'old.txt'), 'utf8') === 'tracked source\n',
    'blocked rename collision must preserve the tracked source path'
  )

  const ignoredRaceDir = path.join(tempRoot, 'ignored-collision-race')
  initRepo(ignoredRaceDir)
  commitFiles(ignoredRaceDir, 'ignore local secret for race', { '.gitignore': 'secret.txt\n', 'base.txt': 'base\n' })
  git(ignoredRaceDir, ['switch', '-c', 'feature'])
  writeFileSync(path.join(ignoredRaceDir, 'secret.txt'), 'feature version\n', 'utf8')
  git(ignoredRaceDir, ['add', '-f', 'secret.txt'])
  git(ignoredRaceDir, ['commit', '-m', 'track ignored path for race'])
  git(ignoredRaceDir, ['switch', 'main'])
  const ignoredRacePreHead = gitHead(ignoredRaceDir)
  const ignoredRaceWrapperDir = path.join(tempRoot, 'ignored-race-wrapper')
  mkdirSync(ignoredRaceWrapperDir, { recursive: true })
  const ignoredRaceMarker = path.join(tempRoot, 'ignored-race-real-merge-ran.txt')
  const ignoredRaceSecret = path.join(ignoredRaceDir, 'secret.txt')
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  writeExecutable(
    ignoredRaceWrapperDir,
    'git',
    [
      '#!/bin/sh',
      'is_merge=0',
      'is_no_ff=0',
      'for arg in "$@"',
      'do',
      '  [ "$arg" = "merge" ] && is_merge=1',
      '  [ "$arg" = "--no-ff" ] && is_no_ff=1',
      'done',
      'if [ "$is_merge" = 1 ] && [ "$is_no_ff" = 1 ]',
      'then',
      '  printf "wrapper reached real merge\\n" > "$CAOGEN_RACE_MARKER"',
      '  printf "local private data\\n" > "$CAOGEN_RACE_SECRET"',
      'fi',
      'exec "$CAOGEN_REAL_GIT" "$@"',
      ''
    ].join('\n')
  )
  const ignoredRaceEnv = {
    PATH: process.env.PATH,
    CAOGEN_RACE_MARKER: process.env.CAOGEN_RACE_MARKER,
    CAOGEN_RACE_SECRET: process.env.CAOGEN_RACE_SECRET,
    CAOGEN_REAL_GIT: process.env.CAOGEN_REAL_GIT
  }
  process.env.PATH = `${ignoredRaceWrapperDir}${path.delimiter}${process.env.PATH ?? ''}`
  process.env.CAOGEN_RACE_MARKER = ignoredRaceMarker
  process.env.CAOGEN_RACE_SECRET = ignoredRaceSecret
  process.env.CAOGEN_REAL_GIT = realGit
  try {
    const ignoredRaceMerge = gitHelper.gitMerge(ignoredRaceDir, 'feature')
    assert(!ignoredRaceMerge.ok, 'incoming ignored paths must be rejected before the real merge command starts')
  } finally {
    restoreEnv('PATH', ignoredRaceEnv.PATH)
    restoreEnv('CAOGEN_RACE_MARKER', ignoredRaceEnv.CAOGEN_RACE_MARKER)
    restoreEnv('CAOGEN_RACE_SECRET', ignoredRaceEnv.CAOGEN_RACE_SECRET)
    restoreEnv('CAOGEN_REAL_GIT', ignoredRaceEnv.CAOGEN_REAL_GIT)
  }
  assert(!existsSync(ignoredRaceMarker), 'ignored-path rejection must not enter the real --no-ff merge window')
  assert(!existsSync(ignoredRaceSecret), 'the real merge wrapper must not get a chance to create an ignored collision')
  assert(gitHead(ignoredRaceDir) === ignoredRacePreHead, 'ignored-path race rejection must preserve destination ref')

  const ignoredCaseCollisionDir = path.join(tempRoot, 'ignored-case-collision')
  initRepo(ignoredCaseCollisionDir)
  git(ignoredCaseCollisionDir, ['config', 'core.ignorecase', 'true'])
  commitFiles(ignoredCaseCollisionDir, 'ignore local secret by case', {
    '.gitignore': 'secret.txt\n',
    'base.txt': 'base\n'
  })
  git(ignoredCaseCollisionDir, ['switch', '-c', 'feature'])
  writeFileSync(path.join(ignoredCaseCollisionDir, 'Secret.txt'), 'feature version\n', 'utf8')
  git(ignoredCaseCollisionDir, ['add', '-f', 'Secret.txt'])
  git(ignoredCaseCollisionDir, ['commit', '-m', 'track case-variant ignored path'])
  git(ignoredCaseCollisionDir, ['switch', 'main'])
  writeFileSync(path.join(ignoredCaseCollisionDir, 'secret.txt'), 'local private data\n', 'utf8')
  const ignoredCaseMerge = gitHelper.gitMerge(ignoredCaseCollisionDir, 'feature')
  assert(!ignoredCaseMerge.ok, 'git_merge must use repository case semantics for ignored path collisions')
  assert(
    readFileSync(path.join(ignoredCaseCollisionDir, 'secret.txt'), 'utf8') === 'local private data\n',
    'case-variant collision must preserve ignored local data'
  )

  const unicodeCaseProbeDir = path.join(tempRoot, 'unicode-case-probe')
  if (fileSystemTreatsAsSameEntry(unicodeCaseProbeDir, 'straße.txt', 'STRASSE.txt')) {
    const ignoredUnicodeCaseDir = path.join(tempRoot, 'ignored-unicode-case-collision')
    initRepo(ignoredUnicodeCaseDir)
    git(ignoredUnicodeCaseDir, ['config', 'core.ignorecase', 'true'])
    commitFiles(ignoredUnicodeCaseDir, 'ignore local unicode case path', {
      '.gitignore': '*.txt\n',
      'base.md': 'base\n'
    })
    git(ignoredUnicodeCaseDir, ['switch', '-c', 'feature'])
    writeFileSync(path.join(ignoredUnicodeCaseDir, 'STRASSE.txt'), 'feature version\n', 'utf8')
    git(ignoredUnicodeCaseDir, ['add', '-f', 'STRASSE.txt'])
    git(ignoredUnicodeCaseDir, ['commit', '-m', 'track unicode case-variant ignored path'])
    git(ignoredUnicodeCaseDir, ['switch', 'main'])
    writeFileSync(path.join(ignoredUnicodeCaseDir, 'straße.txt'), 'local private data\n', 'utf8')
    const ignoredUnicodeCaseMerge = gitHelper.gitMerge(ignoredUnicodeCaseDir, 'feature')
    assert(!ignoredUnicodeCaseMerge.ok, 'git_merge must honor filesystem Unicode case equivalence for ignored collisions')
    assert(
      readFileSync(path.join(ignoredUnicodeCaseDir, 'straße.txt'), 'utf8') === 'local private data\n',
      'Unicode case-equivalent collision must preserve ignored local data'
    )
  }

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

function commitFiles(dir, message, files) {
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, file), content, 'utf8')
  }
  git(dir, ['add', ...Object.keys(files)])
  git(dir, ['commit', '-m', message])
}

function prepareConflictingMergeRepo(dir, attributes = '') {
  initRepo(dir)
  const baseFiles = { 'app.txt': 'base\n' }
  if (attributes) baseFiles['.gitattributes'] = attributes
  commitFiles(dir, 'base', baseFiles)
  git(dir, ['switch', '-c', 'feature'])
  commitFiles(dir, 'feature change', { 'app.txt': 'feature\n' })
  git(dir, ['switch', 'main'])
  commitFiles(dir, 'main change', { 'app.txt': 'main\n' })
}

function prepareFastForwardMergeRepo(dir, attributes = '') {
  initRepo(dir)
  const baseFiles = { 'app.txt': 'base\n' }
  if (attributes) baseFiles['.gitattributes'] = attributes
  commitFiles(dir, 'base', baseFiles)
  git(dir, ['switch', '-c', 'feature'])
  commitFiles(dir, 'feature change', { 'feature.txt': 'feature\n' })
  git(dir, ['switch', 'main'])
}

function writeHook(dir, name, content) {
  const hook = path.join(dir, '.git', 'hooks', name)
  writeFileSync(hook, content, 'utf8')
  chmodSync(hook, 0o755)
}

function gitHead(dir) {
  return git(dir, ['rev-parse', 'HEAD']).trim()
}

function mergeExecutionPlan(dir, preHead, sourceRef, sourceSha) {
  const repoRoot = realpathSync(dir)
  const gitCommonDir = realpathSync(path.join(repoRoot, '.git'))
  const worktreeGitDir = gitCommonDir
  return {
    repoRoot,
    gitCommonDir,
    worktreeGitDir,
    repoRootIdentity: fileSystemIdentity(repoRoot),
    gitCommonDirIdentity: fileSystemIdentity(gitCommonDir),
    worktreeGitDirIdentity: fileSystemIdentity(worktreeGitDir),
    destinationRef: 'refs/heads/main',
    preHead,
    sourceRef,
    sourceSha,
    sourceWasAncestor: false,
    mode: 'no_ff_v1'
  }
}

function fileSystemIdentity(target) {
  const stats = statSync(target, { bigint: true })
  return { device: stats.dev.toString(), inode: stats.ino.toString() }
}

function gitObjectInventory(dir) {
  const objectsRoot = path.join(dir, '.git', 'objects')
  const inventory = []
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) visit(fullPath)
      else if (entry.isFile()) {
        inventory.push(`${path.relative(objectsRoot, fullPath)}:${statSync(fullPath).size}`)
      }
    }
  }
  visit(objectsRoot)
  return inventory.sort()
}

function fileSystemTreatsAsSameEntry(dir, firstName, secondName) {
  mkdirSync(dir, { recursive: true })
  const firstPath = path.join(dir, firstName)
  const secondPath = path.join(dir, secondName)
  writeFileSync(firstPath, 'probe\n', 'utf8')
  const sameEntry = existsSync(secondPath) && statSync(firstPath).ino === statSync(secondPath).ino
  rmSync(dir, { recursive: true, force: true })
  return sameEntry
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal, stderr }))
  })
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
