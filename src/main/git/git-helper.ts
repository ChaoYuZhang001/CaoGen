import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { readProjectContext } from '../agent/context-loader'

const GIT_TIMEOUT_MS = 120_000
const COMMAND_TIMEOUT_MS = 180_000
const MAX_BUFFER = 16 * 1024 * 1024
const MAX_OUTPUT_CHARS = 24_000
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])
const SUPPORTED_PR_PROVIDERS = new Set<PullRequestProvider>(['github', 'gitlab'])

export type PullRequestProvider = 'github' | 'gitlab' | 'gitee' | 'unknown'
export type PullRequestTool = 'gh' | 'glab'

export interface GitRunResult {
  ok: boolean
  stdout: string
  stderr: string
  status: number | null
  error?: string
}

export interface GitStatusFile {
  path: string
  oldPath?: string
  indexStatus: string
  worktreeStatus: string
  kind: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted' | 'unknown'
  staged: boolean
  unstaged: boolean
  untracked: boolean
  conflicted: boolean
}

export interface GitStatusResult {
  ok: true
  repoRoot: string
  branch: string
  upstream?: string
  ahead: number
  behind: number
  clean: boolean
  files: GitStatusFile[]
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
}

export interface GitDiffResult {
  ok: true
  repoRoot: string
  file?: string
  stagedDiff: string
  unstagedDiff: string
  untrackedFiles: string[]
  truncated: boolean
}

export interface GitCommitCheckResult {
  name: string
  command: string
  ok: boolean
  exitCode: number | null
  output: string
}

export interface GitCommitResult {
  ok: true
  repoRoot: string
  branch: string
  sha: string
  checks: GitCommitCheckResult[]
}

export interface GitPushResult {
  ok: true
  repoRoot: string
  remote: string
  branch: string
  upstream: string
  output: string
}

export interface PullRequestRemote {
  remote: string
  url: string
  provider: PullRequestProvider
  owner?: string
  repo?: string
}

export interface GitCreatePrResult {
  ok: true
  repoRoot: string
  provider: PullRequestProvider
  tool: PullRequestTool
  branch: string
  base: string
  url: string
}

export interface GitMergeResult {
  ok: true
  repoRoot: string
  currentBranch: string
  mergedBranch: string
  output: string
}

export interface GitFailure {
  ok: false
  error: string
  repoRoot?: string
  details?: string
  conflictFiles?: string[]
  checks?: GitCommitCheckResult[]
}

export type GitStatusOperationResult = GitStatusResult | GitFailure
export type GitDiffOperationResult = GitDiffResult | GitFailure
export type GitCommitOperationResult = GitCommitResult | GitFailure
export type GitPushOperationResult = GitPushResult | GitFailure
export type GitCreatePrOperationResult = GitCreatePrResult | GitFailure
export type GitMergeOperationResult = GitMergeResult | GitFailure

interface BranchInfo {
  branch: string
  upstream?: string
  ahead: number
  behind: number
}

interface ParsedCommand {
  name: string
  command: string
}

interface NormalizedFilePath {
  absolute: string
  relative: string
}

export function gitStatus(cwd: string): GitStatusOperationResult {
  const repo = resolveRepo(cwd)
  if (repo.ok === false) return repo

  const status = runGit(repo.repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (!status.ok) return failure('读取 Git 状态失败', repo.repoRoot, status.error)

  const files = parsePorcelainStatus(status.stdout)
  const branch = readBranchInfo(repo.repoRoot)
  return {
    ok: true,
    repoRoot: repo.repoRoot,
    branch: branch.branch,
    upstream: branch.upstream,
    ahead: branch.ahead,
    behind: branch.behind,
    clean: files.length === 0,
    files,
    staged: files.filter((file) => file.staged).length,
    unstaged: files.filter((file) => file.unstaged && !file.untracked).length,
    untracked: files.filter((file) => file.untracked).length,
    conflicted: files.filter((file) => file.conflicted).length
  }
}

export function gitDiff(cwd: string, rawFile?: string): GitDiffOperationResult {
  const repo = resolveRepo(cwd)
  if (repo.ok === false) return repo

  let file: NormalizedFilePath | undefined
  if (rawFile) {
    const normalized = normalizeRepoPath(repo.repoRoot, rawFile)
    if (normalized.ok === false) return normalized
    file = { absolute: normalized.absolute, relative: normalized.relative }
  }

  const pathArgs = file?.relative ? ['--', file.relative] : ['--']
  const staged = runGit(repo.repoRoot, ['diff', '--cached', ...pathArgs])
  if (!staged.ok) return failure('读取 staged diff 失败', repo.repoRoot, staged.error)
  const unstaged = runGit(repo.repoRoot, ['diff', ...pathArgs])
  if (!unstaged.ok) return failure('读取 unstaged diff 失败', repo.repoRoot, unstaged.error)

  const untracked = rawFile
    ? untrackedFiles(repo.repoRoot).filter((item) => item === file?.relative)
    : untrackedFiles(repo.repoRoot)
  const stagedClip = clip(staged.stdout)
  const unstagedClip = clip(unstaged.stdout)

  return {
    ok: true,
    repoRoot: repo.repoRoot,
    file: file?.relative,
    stagedDiff: stagedClip.text,
    unstagedDiff: unstagedClip.text,
    untrackedFiles: untracked,
    truncated: stagedClip.truncated || unstagedClip.truncated
  }
}

export function gitCommit(cwd: string, message: string): GitCommitOperationResult {
  const repo = resolveRepo(cwd)
  if (repo.ok === false) return repo

  const text = typeof message === 'string' ? message.trim() : ''
  if (!text) return failure('提交信息不能为空', repo.repoRoot)

  const status = gitStatus(repo.repoRoot)
  if (status.ok === false) return status
  if (status.conflicted > 0) {
    return failure(
      '存在未解决冲突，已阻止提交',
      repo.repoRoot,
      undefined,
      status.files.filter((file) => file.conflicted).map((file) => file.path)
    )
  }

  if (!hasStagedChanges(repo.repoRoot)) {
    return failure('没有已暂存的改动；为避免误提交其他 Agent 改动，git_commit 不会自动 git add', repo.repoRoot)
  }

  const checks = runPreCommitChecks(repo.repoRoot)
  const failed = checks.find((check) => !check.ok)
  if (failed) {
    return {
      ok: false,
      repoRoot: repo.repoRoot,
      error: `提交前检查失败: ${failed.name}`,
      details: failed.output,
      checks
    }
  }

  const commit = runGit(repo.repoRoot, ['commit', '-m', text])
  if (!commit.ok) return failure('git commit 失败', repo.repoRoot, commit.error, undefined, checks)

  const sha = gitText(repo.repoRoot, ['rev-parse', 'HEAD'])
  if (sha.ok === false) return failure('提交已执行，但读取 HEAD sha 失败', repo.repoRoot, sha.error, undefined, checks)
  return { ok: true, repoRoot: repo.repoRoot, branch: readBranchInfo(repo.repoRoot).branch, sha: sha.text, checks }
}

export function gitPush(cwd: string, rawBranch?: string): GitPushOperationResult {
  const repo = resolveRepo(cwd)
  if (repo.ok === false) return repo

  const branch = rawBranch?.trim() || readBranchInfo(repo.repoRoot).branch
  if (!isUsableBranchName(repo.repoRoot, branch)) return failure(`无效或不可推送的分支名: ${branch}`, repo.repoRoot)

  const remote = preferredRemote(repo.repoRoot)
  if (!remote) return failure('未配置 Git remote，无法 push', repo.repoRoot)

  const push = runGit(repo.repoRoot, ['push', '-u', remote, `${branch}:${branch}`])
  if (!push.ok) return failure('git push 失败', repo.repoRoot, push.error)

  const upstream = `${remote}/${branch}`
  return {
    ok: true,
    repoRoot: repo.repoRoot,
    remote,
    branch,
    upstream,
    output: clip([push.stdout, push.stderr].filter(Boolean).join('\n')).text
  }
}

export function gitCreatePr(
  cwd: string,
  title: string,
  body: string,
  rawBase?: string
): GitCreatePrOperationResult {
  const repo = resolveRepo(cwd)
  if (repo.ok === false) return repo

  const prTitle = typeof title === 'string' ? title.trim() : ''
  if (!prTitle) return failure('PR 标题不能为空', repo.repoRoot)

  const branch = readBranchInfo(repo.repoRoot).branch
  if (!isUsableBranchName(repo.repoRoot, branch)) return failure(`当前分支不可创建 PR: ${branch}`, repo.repoRoot)

  const remote = detectPullRequestRemote(repo.repoRoot)
  if (!remote) return failure('未检测到可用于创建 PR 的 Git remote', repo.repoRoot)
  if (!SUPPORTED_PR_PROVIDERS.has(remote.provider)) {
    return failure(
      `已识别 ${remote.provider} remote，但当前基础版本只支持 GitHub/GitLab CLI 创建 PR/MR`,
      repo.repoRoot,
      remote.url
    )
  }

  const tool = prToolForProvider(remote.provider)
  if (!tool || !commandExists(tool)) {
    return failure(
      `已识别 ${remote.provider} remote，但本机未检测到 ${tool ?? '可用'} PR 工具`,
      repo.repoRoot,
      remote.url
    )
  }

  if (!hasRemoteBranch(repo.repoRoot, remote.remote, branch)) {
    return failure(`远端分支 ${remote.remote}/${branch} 不存在；请先显式调用 git_push`, repo.repoRoot)
  }

  const base = rawBase?.trim() || defaultBaseBranch(repo.repoRoot, remote.remote) || 'main'
  if (!isUsableBranchName(repo.repoRoot, base)) return failure(`无效 base 分支: ${base}`, repo.repoRoot)

  const create =
    tool === 'gh'
      ? runCommand('gh', ['pr', 'create', '--head', branch, '--base', base, '--title', prTitle, '--body', body], repo.repoRoot, {
          GH_PROMPT_DISABLED: '1'
        })
      : runCommand(
          'glab',
          ['mr', 'create', '--source-branch', branch, '--target-branch', base, '--title', prTitle, '--description', body, '--yes'],
          repo.repoRoot,
          { GITLAB_HOST: gitlabHostFromUrl(remote.url) ?? '' }
        )

  if (!create.ok) return failure(`${tool} 创建 PR/MR 失败`, repo.repoRoot, create.error)
  const url = extractUrl(create.stdout) ?? extractUrl(create.stderr)
  if (!url) return failure(`${tool} 创建完成但未返回 PR/MR URL`, repo.repoRoot, clip(create.stdout || create.stderr).text)

  return { ok: true, repoRoot: repo.repoRoot, provider: remote.provider, tool, branch, base, url }
}

export function gitMerge(cwd: string, branch: string): GitMergeOperationResult {
  const repo = resolveRepo(cwd)
  if (repo.ok === false) return repo

  const target = typeof branch === 'string' ? branch.trim() : ''
  if (!isUsableBranchName(repo.repoRoot, target)) return failure(`无效 merge 分支: ${target}`, repo.repoRoot)

  const current = readBranchInfo(repo.repoRoot).branch
  if (current === target) return failure('不能把当前分支 merge 到自身', repo.repoRoot)

  const status = gitStatus(repo.repoRoot)
  if (status.ok === false) return status
  if (!status.clean) {
    return failure('工作区不干净，已阻止 merge；请先提交、暂存处理或清理当前改动', repo.repoRoot)
  }

  const preflight = runGit(repo.repoRoot, ['merge-tree', '--write-tree', '--messages', '--name-only', 'HEAD', target], {
    allowExitCodes: [0, 1]
  })
  if (preflight.ok === false && preflight.status === null) return failure('merge 冲突预检无法执行', repo.repoRoot, preflight.error)
  if (preflight.ok === false) {
    return failure(
      `merge preflight failed, blocked actual merge: git merge-tree exit ${preflight.status ?? 'unknown'}`,
      repo.repoRoot,
      clip(preflight.error || preflight.stderr || preflight.stdout).text
    )
  }
  if (preflight.status === 1) {
    const conflictFiles = parseMergeTreeConflictFiles(preflight.stdout)
    return failure(
      `merge 会产生冲突，已阻止实际合并: ${target}`,
      repo.repoRoot,
      clip(preflight.stdout || preflight.stderr).text,
      conflictFiles
    )
  }

  const merge = runGit(repo.repoRoot, ['merge', '--no-ff', '--no-edit', target])
  if (!merge.ok) {
    return failure('git merge 失败', repo.repoRoot, merge.error, unmergedFiles(repo.repoRoot))
  }

  return {
    ok: true,
    repoRoot: repo.repoRoot,
    currentBranch: current,
    mergedBranch: target,
    output: clip([merge.stdout, merge.stderr].filter(Boolean).join('\n')).text
  }
}

export function detectPullRequestRemote(cwd: string): PullRequestRemote | null {
  const remote = preferredRemote(cwd)
  if (!remote) return null
  const url = remoteUrl(cwd, remote)
  if (!url) return null
  const parsed = parseRemoteUrl(url)
  return { remote, url, provider: parsed.provider, owner: parsed.owner, repo: parsed.repo }
}

export function detectProviderFromRemoteUrl(url: string): PullRequestProvider {
  return parseRemoteUrl(url).provider
}

function resolveRepo(cwd: string): { ok: true; repoRoot: string } | GitFailure {
  if (typeof cwd !== 'string' || !cwd.trim()) return failure('cwd 不能为空')
  const result = runGit(cwd, ['rev-parse', '--show-toplevel'])
  if (!result.ok) return failure('当前目录不是 Git 工作区', undefined, result.error)
  return { ok: true, repoRoot: resolve(result.stdout.trim()) }
}

function runGit(
  cwd: string,
  args: string[],
  options: { allowExitCodes?: number[]; input?: string } = {}
): GitRunResult {
  return runCommand('git', args, cwd, undefined, options)
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  extraEnv?: Record<string, string>,
  options: { allowExitCodes?: number[]; input?: string } = {}
): GitRunResult {
  const allowed = options.allowExitCodes ?? [0]
  const env = extraEnv ? { ...process.env, ...extraEnv } : process.env
  const result = spawnSync(command, args, {
    cwd,
    input: options.input,
    encoding: 'utf8',
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER
  })
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  const status = result.status

  if (result.error) {
    return { ok: false, stdout, stderr, status, error: result.error.message }
  }
  if (status === null || !allowed.includes(status)) {
    return { ok: false, stdout, stderr, status, error: commandError(command, args, status, stdout, stderr) }
  }
  return { ok: true, stdout, stderr, status }
}

function runShellCommand(cwd: string, command: string): GitRunResult {
  const result = spawnSync(command, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER
  })
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  const status = result.status
  if (result.error) return { ok: false, stdout, stderr, status, error: result.error.message }
  if (status !== 0) return { ok: false, stdout, stderr, status, error: shellCommandError(command, status, stdout, stderr) }
  return { ok: true, stdout, stderr, status }
}

function gitText(cwd: string, args: string[]): { ok: true; text: string } | { ok: false; error: string } {
  const result = runGit(cwd, args)
  if (!result.ok) return { ok: false, error: result.error ?? `git ${args.join(' ')} 失败` }
  return { ok: true, text: result.stdout.trim() }
}

function commandError(command: string, args: string[], status: number | null, stdout: string, stderr: string): string {
  const output = (stderr.trim() || stdout.trim()).slice(0, MAX_OUTPUT_CHARS)
  const code = status === null ? 'timeout' : String(status)
  return output ? `${command} ${args.join(' ')} failed (${code}): ${output}` : `${command} ${args.join(' ')} failed (${code})`
}

function shellCommandError(command: string, status: number | null, stdout: string, stderr: string): string {
  const output = (stderr.trim() || stdout.trim()).slice(0, MAX_OUTPUT_CHARS)
  const code = status === null ? 'timeout' : String(status)
  return output ? `${command} failed (${code}): ${output}` : `${command} failed (${code})`
}

function readBranchInfo(repoRoot: string): BranchInfo {
  const branch = gitText(repoRoot, ['symbolic-ref', '--short', '-q', 'HEAD'])
  const fallback = gitText(repoRoot, ['rev-parse', '--short', 'HEAD'])
  const upstream = gitText(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  const counts = upstream.ok ? gitText(repoRoot, ['rev-list', '--left-right', '--count', `${upstream.text}...HEAD`]) : undefined
  const [behindRaw, aheadRaw] = counts?.ok ? counts.text.split(/\s+/) : ['0', '0']
  return {
    branch: branch.ok && branch.text ? branch.text : fallback.ok ? fallback.text : '',
    upstream: upstream.ok ? upstream.text : undefined,
    ahead: Number(aheadRaw) || 0,
    behind: Number(behindRaw) || 0
  }
}

function parsePorcelainStatus(output: string): GitStatusFile[] {
  const records = output.split('\0').filter(Boolean)
  const files: GitStatusFile[] = []

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.length < 4) continue
    const indexStatus = record[0] ?? ' '
    const worktreeStatus = record[1] ?? ' '
    const path = record.slice(3)
    let oldPath: string | undefined
    if (indexStatus === 'R' || indexStatus === 'C') {
      oldPath = records[index + 1]
      index += 1
    }
    const code = `${indexStatus}${worktreeStatus}`
    const conflicted = CONFLICT_CODES.has(code) || indexStatus === 'U' || worktreeStatus === 'U'
    const untracked = code === '??'
    files.push({
      path,
      oldPath,
      indexStatus,
      worktreeStatus,
      kind: statusKind(indexStatus, worktreeStatus, conflicted),
      staged: !conflicted && indexStatus !== ' ' && indexStatus !== '?',
      unstaged: !conflicted && worktreeStatus !== ' ',
      untracked,
      conflicted
    })
  }
  return files
}

function statusKind(
  indexStatus: string,
  worktreeStatus: string,
  conflicted: boolean
): GitStatusFile['kind'] {
  if (conflicted) return 'conflicted'
  const code = `${indexStatus}${worktreeStatus}`
  if (code.includes('?')) return 'untracked'
  if (code.includes('R')) return 'renamed'
  if (code.includes('C')) return 'copied'
  if (code.includes('A')) return 'added'
  if (code.includes('D')) return 'deleted'
  if (code.includes('M')) return 'modified'
  return 'unknown'
}

function normalizeRepoPath(repoRoot: string, rawPath: string): ({ ok: true } & NormalizedFilePath) | GitFailure {
  const raw = rawPath.trim()
  if (!raw || raw.includes('\0')) return failure('file 参数不能为空或包含非法字符', repoRoot)
  const target = isAbsolute(raw) ? resolve(raw) : resolve(repoRoot, raw)
  const rel = relative(repoRoot, target).replace(/\\/g, '/')
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return failure(`file 超出 Git 仓库范围: ${rawPath}`, repoRoot)
  }
  return { ok: true, absolute: target, relative: rel }
}

function untrackedFiles(repoRoot: string): string[] {
  const result = runGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z', '--full-name', '--', '.'])
  if (!result.ok) return []
  return result.stdout.split('\0').filter(Boolean)
}

function unmergedFiles(repoRoot: string): string[] {
  const result = runGit(repoRoot, ['diff', '--name-only', '--diff-filter=U', '-z'])
  if (!result.ok) return []
  return result.stdout.split('\0').filter(Boolean)
}

function hasStagedChanges(repoRoot: string): boolean {
  const result = runGit(repoRoot, ['diff', '--cached', '--quiet', '--exit-code'], { allowExitCodes: [0, 1] })
  return result.status === 1
}

function runPreCommitChecks(repoRoot: string): GitCommitCheckResult[] {
  const commands = readLintTestCommands(repoRoot)
  return commands.map((item) => {
    const result = runShellCommand(repoRoot, item.command)
    const output = clip([result.stdout, result.stderr, result.error].filter(Boolean).join('\n')).text
    return {
      name: item.name,
      command: item.command,
      ok: result.ok,
      exitCode: result.status,
      output: output || '(无输出)'
    }
  })
}

function readLintTestCommands(repoRoot: string): ParsedCommand[] {
  let content = ''
  try {
    const context = readProjectContext(repoRoot)
    if (context.source?.fileName === 'caogen.md' || context.source?.fileName === '.caogen.md') {
      content = context.content
    }
  } catch {
    content = ''
  }
  if (!content.trim()) return []

  const section = commonCommandsSection(content)
  const commands = parseNamedCommands(section)
  const selected = commands.filter((item) => /^(lint|test)$/i.test(item.name))
  return dedupeCommands(selected)
}

function commonCommandsSection(content: string): string {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const start = lines.findIndex((line) => /^#{1,6}\s*(常用命令|commands?|scripts?)\s*$/i.test(line.trim()))
  if (start === -1) return ''
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s+\S+/.test(line.trim())) break
    body.push(line)
  }
  return body.join('\n')
}

function parseNamedCommands(section: string): ParsedCommand[] {
  const commands: ParsedCommand[] = []
  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const bullet = /^(?:[-*+]|\d+\.)\s*`?([A-Za-z0-9:_-]+)`?\s*[:：-]\s*(.+)$/.exec(trimmed)
    if (bullet) {
      commands.push({ name: bullet[1].trim(), command: stripCommandFence(bullet[2]) })
      continue
    }
    const fenced = /^`?((?:npm|pnpm|yarn|bun)\s+run\s+(lint|test)\b.+?)`?$/.exec(trimmed)
    if (fenced) commands.push({ name: fenced[2], command: stripCommandFence(fenced[1]) })
  }
  return commands.filter((item) => item.command.length > 0)
}

function stripCommandFence(value: string): string {
  return value.trim().replace(/^`+/, '').replace(/`+$/, '').trim()
}

function dedupeCommands(commands: ParsedCommand[]): ParsedCommand[] {
  const seen = new Set<string>()
  const result: ParsedCommand[] = []
  for (const command of commands) {
    const key = command.name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(command)
  }
  return result
}

function preferredRemote(repoRoot: string): string | null {
  const remotes = runGit(repoRoot, ['remote'])
  if (!remotes.ok) return null
  const names = remotes.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (names.includes('origin')) return 'origin'
  return names[0] ?? null
}

function remoteUrl(repoRoot: string, remote: string): string | null {
  const result = gitText(repoRoot, ['remote', 'get-url', remote])
  return result.ok ? result.text : null
}

function parseRemoteUrl(url: string): { provider: PullRequestProvider; owner?: string; repo?: string } {
  const normalized = url.trim()
  const host = remoteHost(normalized)
  const pathParts = remotePath(normalized).replace(/\.git$/i, '').split('/').filter(Boolean)
  const provider = providerFromHost(host)
  return {
    provider,
    owner: pathParts.length >= 2 ? pathParts[pathParts.length - 2] : undefined,
    repo: pathParts.length >= 1 ? pathParts[pathParts.length - 1] : undefined
  }
}

function remoteHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    const scp = /^[^@]+@([^:]+):/.exec(url)
    if (scp) return scp[1].toLowerCase()
    return ''
  }
}

function remotePath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    const scp = /^[^@]+@[^:]+:(.+)$/.exec(url)
    if (scp) return scp[1]
    const slash = url.indexOf('/')
    return slash >= 0 ? url.slice(slash) : ''
  }
}

function providerFromHost(host: string): PullRequestProvider {
  if (host === 'github.com' || host.endsWith('.github.com')) return 'github'
  if (host === 'gitlab.com' || host.includes('gitlab')) return 'gitlab'
  if (host === 'gitee.com' || host.endsWith('.gitee.com')) return 'gitee'
  return 'unknown'
}

function prToolForProvider(provider: PullRequestProvider): PullRequestTool | null {
  if (provider === 'github') return 'gh'
  if (provider === 'gitlab') return 'glab'
  return null
}

function commandExists(command: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(probe, [command], { stdio: 'ignore', timeout: GIT_TIMEOUT_MS })
  return result.status === 0
}

function hasRemoteBranch(repoRoot: string, remote: string, branch: string): boolean {
  const result = runGit(repoRoot, ['ls-remote', '--exit-code', '--heads', remote, branch], { allowExitCodes: [0, 2] })
  return result.status === 0
}

function defaultBaseBranch(repoRoot: string, remote: string): string | null {
  const ref = gitText(repoRoot, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`])
  if (ref.ok) {
    const prefix = `${remote}/`
    return ref.text.startsWith(prefix) ? ref.text.slice(prefix.length) : ref.text
  }
  for (const candidate of ['main', 'master', 'develop']) {
    if (hasRemoteBranch(repoRoot, remote, candidate)) return candidate
  }
  return null
}

function isUsableBranchName(repoRoot: string, branch: string): boolean {
  if (!branch || branch === 'HEAD' || branch.includes('\0') || /\s/.test(branch)) return false
  const result = runGit(repoRoot, ['check-ref-format', '--branch', branch])
  return result.ok
}

function gitlabHostFromUrl(url: string): string | null {
  const host = remoteHost(url)
  return host && host !== 'gitlab.com' ? host : null
}

function extractUrl(text: string): string | null {
  const match = /https?:\/\/\S+/i.exec(text)
  return match ? match[0].replace(/[),.;]+$/, '') : null
}

function parseMergeTreeConflictFiles(output: string): string[] {
  const files = new Set<string>()
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (const line of lines) {
    if (/^[0-7]{6}\s+[0-9a-f]{40,64}\s+\d+\s+(.+)$/.test(line)) {
      const match = /^[0-7]{6}\s+[0-9a-f]{40,64}\s+\d+\s+(.+)$/.exec(line)
      if (match) files.add(match[1])
      continue
    }
    if (!line.includes(' ') && !line.includes('\t') && existsLikePath(line)) files.add(line)
  }
  return [...files]
}

function existsLikePath(value: string): boolean {
  return value.includes('/') || value.includes('\\') || /\.[A-Za-z0-9]+$/.test(value)
}

function clip(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false }
  return { text: `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[已截断，共 ${text.length} 字符]`, truncated: true }
}

function failure(
  error: string,
  repoRoot?: string,
  details?: string,
  conflictFiles?: string[],
  checks?: GitCommitCheckResult[]
): GitFailure {
  const result: GitFailure = { ok: false, error }
  if (repoRoot) result.repoRoot = repoRoot
  if (details) result.details = details
  if (conflictFiles && conflictFiles.length > 0) result.conflictFiles = conflictFiles
  if (checks) result.checks = checks
  return result
}

// 保留给后续扩展：PR/merge 前可用它判断路径是否仍存在于仓库内。
export function pathExistsInsideRepo(repoRoot: string, rawPath: string): boolean {
  const normalized = normalizeRepoPath(repoRoot, rawPath)
  if (normalized.ok === false) return false
  const parent = dirname(normalized.absolute)
  return existsSync(normalized.absolute) || (existsSync(parent) && statSync(parent).isDirectory())
}
