import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  gitCommit,
  gitCreatePr,
  type GitCommitCheckResult
} from '../git/git-helper'
import { withSafeLocalGitConfig } from '../git/safe-git'
import {
  canFastApplyPatch,
  createPullRequest,
  createSquashPatch,
  getConflictFiles,
  inspectMerge,
  patchSha256,
  type ConflictRisk
} from '../worktreeMerge'

export type CodeForgeDeliveryMode = 'report' | 'patch' | 'commit' | 'pr'
export type CodeForgeDeliveryStatus = 'ready' | 'needs-review' | 'blocked' | 'failed'
export type CodeForgeTargetKind = 'repository' | 'managed-worktree'
export type CodeForgeVerificationStatus = 'passed' | 'failed' | 'skipped'
export type CodeForgeRiskLevel = 'low' | 'medium' | 'high'

export interface CodeForgeWorktreeContext {
  sessionId?: string
  repoRoot?: string
  sourceCwd?: string
  worktreePath?: string
  branch?: string
  baseBranch?: string | null
  baseSha?: string
}

export interface CodeForgeDeliveryInput {
  cwd: string
  mode?: CodeForgeDeliveryMode
  verificationCommand?: string
  verificationCommands?: string[]
  verificationTimeoutMs?: number
  commitMessage?: string
  stageAll?: boolean
  createPatch?: boolean
  prTitle?: string
  prBody?: string
  baseBranch?: string
  repoRoot?: string
  worktreePath?: string
  baseSha?: string
  branch?: string
  worktreeContext?: CodeForgeWorktreeContext
}

export interface CodeForgeTargetReport {
  kind: CodeForgeTargetKind
  cwd: string
  repoRoot: string
  worktreePath: string
  branch?: string
  baseBranch?: string | null
  baseSha?: string
  headSha?: string
  sessionId?: string
}

export interface CodeForgeChangeSummary {
  changedFiles: number
  insertions: number
  deletions: number
  files: string[]
  truncatedFiles: boolean
  conflictRisk?: ConflictRisk
}

export interface CodeForgeVerificationCommandResult {
  command: string
  cwd: string
  status: CodeForgeVerificationStatus
  exitCode: number | null
  durationMs: number
  output: string
}

export interface CodeForgeVerificationSummary {
  status: CodeForgeVerificationStatus
  commands: CodeForgeVerificationCommandResult[]
  passed: number
  failed: number
  skipped: number
}

export interface CodeForgePatchReport {
  path: string
  bytes: number
  sha256: string
  canApply?: boolean
  error?: string
  conflictFiles?: string[]
}

export interface CodeForgeCommitReport {
  ok: boolean
  sha?: string
  branch?: string
  message?: string
  checks?: GitCommitCheckResult[]
  error?: string
}

export interface CodeForgePullRequestReport {
  ok: boolean
  created: boolean
  url?: string
  tool?: string
  branch?: string
  base?: string
  pushed?: boolean
  error?: string
}

export interface CodeForgeRiskReport {
  level: CodeForgeRiskLevel
  reasons: string[]
}

export interface CodeForgeDeliveryReport {
  ok: true
  status: CodeForgeDeliveryStatus
  mode: CodeForgeDeliveryMode
  startedAt: number
  completedAt: number
  target: CodeForgeTargetReport
  changes: CodeForgeChangeSummary
  verification: CodeForgeVerificationSummary
  patch?: CodeForgePatchReport
  commit?: CodeForgeCommitReport
  pullRequest?: CodeForgePullRequestReport
  risk: CodeForgeRiskReport
  mergeable: boolean
  summary: string
}

export interface CodeForgeDeliveryFailure {
  ok: false
  status: 'failed'
  mode?: CodeForgeDeliveryMode
  error: string
  summary: string
}

export type CodeForgeDeliveryResult = CodeForgeDeliveryReport | CodeForgeDeliveryFailure

interface ResolvedContext {
  target: CodeForgeTargetReport
  verificationCwd: string
}

interface GitRunResult {
  ok: boolean
  stdout: string
  stderr: string
  status: number | null
  error?: string
}

const DEFAULT_VERIFY_TIMEOUT_MS = 180_000
const MAX_OUTPUT_CHARS = 12_000
const MAX_FILE_LIST = 80
const MAX_GIT_BUFFER = 32 * 1024 * 1024
const GIT_TIMEOUT_MS = 120_000
const GIT_DEV_NULL = '/dev/null'

export function runCodeForgeDelivery(input: CodeForgeDeliveryInput): CodeForgeDeliveryResult {
  const startedAt = Date.now()
  const mode = normalizeMode(input.mode)
  try {
    const context = resolveContext(input)
    const changes = summarizeChanges(context)
    const verification = runVerification(
      verificationCommands(input),
      context.verificationCwd,
      input.verificationTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS
    )
    const patch = maybeCreatePatch(context, mode, input.createPatch === true)
    const commit = maybeCommit(context, mode, verification, input)
    const pullRequest = maybeCreatePullRequest(context, mode, verification, commit, input)
    const risk = assessRisk({ changes, verification, patch, commit, pullRequest })
    const status = deliveryStatus({ changes, verification, patch, commit, pullRequest })
    const mergeable = isMergeable({ changes, verification, patch, commit, pullRequest })
    return {
      ok: true,
      status,
      mode,
      startedAt,
      completedAt: Date.now(),
      target: context.target,
      changes,
      verification,
      ...(patch ? { patch } : {}),
      ...(commit ? { commit } : {}),
      ...(pullRequest ? { pullRequest } : {}),
      risk,
      mergeable,
      summary: buildSummary(status, mode, changes, verification, patch, commit, pullRequest, risk)
    }
  } catch (err) {
    const error = errorText(err)
    return {
      ok: false,
      status: 'failed',
      mode,
      error,
      summary: `Code Forge 交付失败:${error}`
    }
  }
}

export function formatCodeForgeDeliveryReport(result: CodeForgeDeliveryResult): string {
  return JSON.stringify(result, null, 2)
}

function normalizeMode(value: unknown): CodeForgeDeliveryMode {
  return value === 'patch' || value === 'commit' || value === 'pr' || value === 'report'
    ? value
    : 'report'
}

function resolveContext(input: CodeForgeDeliveryInput): ResolvedContext {
  const cwd = normalizeExistingDirectory(input.cwd, 'cwd')
  const cwdRoot = repoRootFor(cwd)
  const metadata = input.worktreeContext
  const repoRootArg = cleanString(input.repoRoot) ?? cleanString(metadata?.repoRoot)
  const worktreePathArg = cleanString(input.worktreePath) ?? cleanString(metadata?.worktreePath)
  const baseSha = cleanString(input.baseSha) ?? cleanString(metadata?.baseSha)

  if (repoRootArg && worktreePathArg && baseSha) {
    const repoRoot = repoRootFor(normalizeExistingDirectory(repoRootArg, 'repoRoot'))
    const worktreePath = repoRootFor(normalizeExistingDirectory(worktreePathArg, 'worktreePath'))
    const verificationCwd = pathInside(cwd, worktreePath) ? cwd : worktreePath
    return {
      target: {
        kind: 'managed-worktree',
        cwd: verificationCwd,
        repoRoot,
        worktreePath,
        branch: cleanString(input.branch) ?? cleanString(metadata?.branch) ?? currentBranch(worktreePath),
        baseBranch: cleanString(input.baseBranch) ?? metadata?.baseBranch,
        baseSha,
        headSha: revParseHead(worktreePath),
        sessionId: cleanString(metadata?.sessionId)
      },
      verificationCwd
    }
  }

  return {
    target: {
      kind: 'repository',
      cwd: cwdRoot,
      repoRoot: cwdRoot,
      worktreePath: cwdRoot,
      branch: cleanString(input.branch) ?? currentBranch(cwdRoot),
      headSha: revParseHead(cwdRoot),
      sessionId: cleanString(metadata?.sessionId)
    },
    verificationCwd: cwd
  }
}

function summarizeChanges(context: ResolvedContext): CodeForgeChangeSummary {
  if (context.target.kind === 'managed-worktree') {
    const baseSha = context.target.baseSha
    if (!baseSha) throw new Error('managed worktree 缺少 baseSha')
    const inspect = inspectMerge(context.target.repoRoot, context.target.worktreePath, baseSha)
    if (inspect.ok === false) throw new Error(inspect.error)
    const files = changedFilesSinceBase(context.target.worktreePath, baseSha)
    return {
      changedFiles: inspect.changedFiles,
      insertions: inspect.insertions,
      deletions: inspect.deletions,
      files: files.slice(0, MAX_FILE_LIST),
      truncatedFiles: files.length > MAX_FILE_LIST,
      conflictRisk: inspect.conflictRisk
    }
  }

  const stats = repoDiffStats(context.target.repoRoot)
  const files = repoChangedFiles(context.target.repoRoot)
  return {
    changedFiles: files.length,
    insertions: stats.insertions,
    deletions: stats.deletions,
    files: files.slice(0, MAX_FILE_LIST),
    truncatedFiles: files.length > MAX_FILE_LIST
  }
}

function maybeCreatePatch(
  context: ResolvedContext,
  mode: CodeForgeDeliveryMode,
  forced: boolean
): CodeForgePatchReport | undefined {
  if (!forced && mode !== 'patch' && mode !== 'pr') return undefined

  if (context.target.kind === 'managed-worktree') {
    const baseSha = context.target.baseSha
    if (!baseSha) throw new Error('managed worktree 缺少 baseSha')
    const patch = createSquashPatch(context.target.repoRoot, context.target.worktreePath, patchOutputRoot(), baseSha)
    if (patch.ok === false) throw new Error(patch.error)
    const check = canFastApplyPatch(context.target.repoRoot, patch.patchText)
    const report: CodeForgePatchReport = {
      path: patch.path,
      bytes: patch.bytes,
      sha256: patchSha256(patch.patchText),
      canApply: check.ok === true ? check.canApply : false
    }
    if (check.ok === false) report.error = check.error
    else if (check.canApply === false) {
      report.error = check.error
      const conflicts = getConflictFiles(context.target.repoRoot, context.target.worktreePath, baseSha)
      if (conflicts.ok && conflicts.files) report.conflictFiles = conflicts.files.map((file) => file.path)
    }
    return report
  }

  const patchText = repoPatchText(context.target.repoRoot)
  const patchPath = writePatchFile(context.target.repoRoot, patchText)
  return {
    path: patchPath,
    bytes: statSync(patchPath).size,
    sha256: patchSha256(patchText)
  }
}

function maybeCommit(
  context: ResolvedContext,
  mode: CodeForgeDeliveryMode,
  verification: CodeForgeVerificationSummary,
  input: CodeForgeDeliveryInput
): CodeForgeCommitReport | undefined {
  if (mode !== 'commit' && mode !== 'pr') return undefined
  const message = cleanString(input.commitMessage)
  if (!message && mode === 'commit') {
    return { ok: false, error: 'commit 模式必须提供 commitMessage' }
  }
  if (verification.status === 'failed') {
    return { ok: false, message, error: '验证失败，已跳过 commit' }
  }

  if (input.stageAll === true) {
    const add = runGit(context.target.worktreePath, ['add', '--all', '--'])
    if (!add.ok) return { ok: false, message, error: add.error ?? 'git add 失败' }
  }

  if (!message) {
    return hasUncommittedChanges(context.target.worktreePath)
      ? { ok: false, error: 'PR 模式检测到未提交改动；请提供 commitMessage 或先提交 worktree' }
      : undefined
  }

  const result = gitCommit(context.target.worktreePath, message)
  if (result.ok === false) {
    return {
      ok: false,
      message,
      error: result.error,
      checks: result.checks
    }
  }
  return {
    ok: true,
    sha: result.sha,
    branch: result.branch,
    message,
    checks: result.checks
  }
}

function maybeCreatePullRequest(
  context: ResolvedContext,
  mode: CodeForgeDeliveryMode,
  verification: CodeForgeVerificationSummary,
  commit: CodeForgeCommitReport | undefined,
  input: CodeForgeDeliveryInput
): CodeForgePullRequestReport | undefined {
  if (mode !== 'pr') return undefined
  if (verification.status === 'failed') {
    return { ok: false, created: false, error: '验证失败，已跳过 PR' }
  }
  if (commit?.ok === false) {
    return { ok: false, created: false, error: commit.error ?? 'commit 未完成，已跳过 PR' }
  }

  const title = cleanString(input.prTitle) ?? cleanString(input.commitMessage) ?? 'Code Forge delivery'
  const body = cleanString(input.prBody) ?? defaultPrBody(context)

  if (context.target.kind === 'managed-worktree') {
    const branch = context.target.branch
    if (!branch) return { ok: false, created: false, error: 'managed worktree 缺少 branch' }
    const result = createPullRequest({
      repoRoot: context.target.repoRoot,
      worktreePath: context.target.worktreePath,
      branch,
      title,
      body,
      baseBranch: cleanString(input.baseBranch) ?? context.target.baseBranch
    })
    if (result.ok === false) return { ok: false, created: false, error: result.error }
    if (result.created === false) return { ok: true, created: false, branch, error: result.message }
    return {
      ok: true,
      created: true,
      branch: result.branch,
      tool: result.tool,
      url: result.url,
      pushed: result.pushed
    }
  }

  const result = gitCreatePr(
    context.target.worktreePath,
    title,
    body,
    cleanString(input.baseBranch) ?? undefined
  )
  if (result.ok === false) return { ok: false, created: false, error: result.error }
  return {
    ok: true,
    created: true,
    branch: result.branch,
    base: result.base,
    tool: result.tool,
    url: result.url
  }
}

function runVerification(
  commands: string[],
  cwd: string,
  timeoutMs: number
): CodeForgeVerificationSummary {
  if (commands.length === 0) {
    return { status: 'skipped', commands: [], passed: 0, failed: 0, skipped: 1 }
  }
  const results = commands.map((command) => runVerificationCommand(command, cwd, timeoutMs))
  const failed = results.filter((result) => result.status === 'failed').length
  const passed = results.filter((result) => result.status === 'passed').length
  return {
    status: failed > 0 ? 'failed' : 'passed',
    commands: results,
    passed,
    failed,
    skipped: 0
  }
}

function runVerificationCommand(
  command: string,
  cwd: string,
  timeoutMs: number
): CodeForgeVerificationCommandResult {
  const startedAt = Date.now()
  const shell = process.platform === 'win32'
    ? { command: 'cmd', args: ['/c', command] }
    : { command: '/bin/sh', args: ['-c', command] }
  const result = spawnSync(shell.command, shell.args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: normalizeTimeout(timeoutMs),
    maxBuffer: MAX_GIT_BUFFER
  })
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  const output = clip([stdout, stderr, result.error?.message].filter(Boolean).join('\n'))
  return {
    command,
    cwd,
    status: result.status === 0 && !result.error ? 'passed' : 'failed',
    exitCode: result.status,
    durationMs: Date.now() - startedAt,
    output: output || '(no output)'
  }
}

function assessRisk(input: {
  changes: CodeForgeChangeSummary
  verification: CodeForgeVerificationSummary
  patch?: CodeForgePatchReport
  commit?: CodeForgeCommitReport
  pullRequest?: CodeForgePullRequestReport
}): CodeForgeRiskReport {
  const reasons: string[] = []
  let level: CodeForgeRiskLevel = 'low'
  if (input.changes.changedFiles === 0) {
    level = maxRisk(level, 'medium')
    reasons.push('没有检测到可交付变更')
  }
  if (input.verification.status === 'skipped') {
    level = maxRisk(level, 'medium')
    reasons.push('未运行验证命令')
  }
  if (input.verification.status === 'failed') {
    level = maxRisk(level, 'high')
    reasons.push('验证失败')
  }
  if (input.changes.conflictRisk === 'medium' || input.patch?.canApply === false) {
    level = maxRisk(level, 'high')
    reasons.push('patch 无法干净应用或存在冲突风险')
  }
  if (input.commit?.ok === false) {
    level = maxRisk(level, 'high')
    reasons.push('commit 未完成')
  }
  if (input.pullRequest?.ok === false) {
    level = maxRisk(level, 'high')
    reasons.push('PR 未创建')
  } else if (input.pullRequest && !input.pullRequest.created) {
    level = maxRisk(level, 'medium')
    reasons.push('PR 工具不可用或被跳过')
  }
  if (reasons.length === 0) reasons.push('验证通过且未发现冲突风险')
  return { level, reasons }
}

function deliveryStatus(input: {
  changes: CodeForgeChangeSummary
  verification: CodeForgeVerificationSummary
  patch?: CodeForgePatchReport
  commit?: CodeForgeCommitReport
  pullRequest?: CodeForgePullRequestReport
}): CodeForgeDeliveryStatus {
  if (input.verification.status === 'failed') return 'failed'
  if (input.commit?.ok === false) return 'failed'
  if (input.patch?.canApply === false) return 'blocked'
  if (input.pullRequest?.ok === false) return 'blocked'
  if (input.changes.changedFiles === 0 || input.verification.status !== 'passed') return 'needs-review'
  return 'ready'
}

function isMergeable(input: {
  changes: CodeForgeChangeSummary
  verification: CodeForgeVerificationSummary
  patch?: CodeForgePatchReport
  commit?: CodeForgeCommitReport
  pullRequest?: CodeForgePullRequestReport
}): boolean {
  return (
    input.changes.changedFiles > 0 &&
    input.verification.status === 'passed' &&
    input.patch?.canApply !== false &&
    input.commit?.ok !== false &&
    input.pullRequest?.ok !== false
  )
}

function buildSummary(
  status: CodeForgeDeliveryStatus,
  mode: CodeForgeDeliveryMode,
  changes: CodeForgeChangeSummary,
  verification: CodeForgeVerificationSummary,
  patch: CodeForgePatchReport | undefined,
  commit: CodeForgeCommitReport | undefined,
  pullRequest: CodeForgePullRequestReport | undefined,
  risk: CodeForgeRiskReport
): string {
  const parts = [
    `Code Forge ${status}`,
    `${changes.changedFiles} files (+${changes.insertions}/-${changes.deletions})`,
    `verification=${verification.status}`,
    `mode=${mode}`,
    patch ? `patch=${patch.path}` : '',
    commit?.sha ? `commit=${commit.sha.slice(0, 12)}` : '',
    pullRequest?.url ? `pr=${pullRequest.url}` : '',
    `risk=${risk.level}`
  ].filter(Boolean)
  return parts.join(' | ')
}

function verificationCommands(input: CodeForgeDeliveryInput): string[] {
  const commands = [
    ...(Array.isArray(input.verificationCommands) ? input.verificationCommands : []),
    cleanString(input.verificationCommand)
  ]
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
  return [...new Set(commands)].slice(0, 8)
}

function repoDiffStats(repoRoot: string): { insertions: number; deletions: number } {
  let insertions = 0
  let deletions = 0
  const numstat = runGit(repoRoot, ['diff', '--no-ext-diff', '--no-textconv', '--numstat', 'HEAD', '--'], {
    allowExitCodes: [0, 1]
  })
  if (numstat.ok) {
    for (const line of numstat.stdout.split(/\r?\n/)) {
      const [added, removed] = line.split('\t')
      if (/^\d+$/.test(added)) insertions += Number(added)
      if (/^\d+$/.test(removed)) deletions += Number(removed)
    }
  }
  for (const file of untrackedFiles(repoRoot)) insertions += countTextLines(repoRoot, file)
  return { insertions, deletions }
}

function repoChangedFiles(repoRoot: string): string[] {
  const files = new Set<string>()
  const tracked = runGit(repoRoot, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', 'HEAD', '--'], {
    allowExitCodes: [0, 1]
  })
  if (tracked.ok) {
    for (const item of tracked.stdout.split('\0').filter(Boolean)) files.add(item)
  }
  for (const item of untrackedFiles(repoRoot)) files.add(item)
  return [...files].sort()
}

function changedFilesSinceBase(worktreePath: string, baseSha: string): string[] {
  const files = new Set<string>()
  const tracked = runGit(worktreePath, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', baseSha, '--'], {
    allowExitCodes: [0, 1]
  })
  if (tracked.ok) {
    for (const item of tracked.stdout.split('\0').filter(Boolean)) files.add(item)
  }
  for (const item of untrackedFiles(worktreePath)) files.add(item)
  return [...files].sort()
}

function repoPatchText(repoRoot: string): string {
  const chunks: string[] = []
  const tracked = runGit(repoRoot, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--binary',
    '--full-index',
    'HEAD',
    '--'
  ], {
    allowExitCodes: [0, 1]
  })
  if (!tracked.ok) throw new Error(tracked.error ?? 'git diff 失败')
  if (tracked.stdout) chunks.push(tracked.stdout)
  for (const file of untrackedFiles(repoRoot)) {
    const untracked = runGit(
      repoRoot,
      ['diff', '--no-ext-diff', '--no-textconv', '--no-index', '--binary', '--full-index', '--', GIT_DEV_NULL, file],
      { allowExitCodes: [0, 1] }
    )
    if (!untracked.ok) throw new Error(untracked.error ?? `无法生成 untracked patch: ${file}`)
    if (untracked.stdout) chunks.push(untracked.stdout)
  }
  return ensureTrailingNewline(chunks.join('\n'))
}

function writePatchFile(repoRoot: string, patchText: string): string {
  const patchPath = path.join(patchOutputRoot(), `code-forge-${patchNameSeed(repoRoot, patchText)}.patch`)
  writeFileSync(patchPath, ensureTrailingNewline(patchText), 'utf8')
  return patchPath
}

function patchOutputRoot(): string {
  const dir = path.join(tmpdir(), 'caogen-code-forge-patches')
  mkdirSync(dir, { recursive: true })
  return realpathSync(dir)
}

function patchNameSeed(repoRoot: string, patchText: string): string {
  return `${Date.now()}-${createHash('sha1').update(repoRoot).update('\0').update(patchText).digest('hex').slice(0, 10)}`
}

function hasUncommittedChanges(cwd: string): boolean {
  const status = runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])
  return status.ok ? status.stdout.trim().length > 0 : true
}

function defaultPrBody(context: ResolvedContext): string {
  return [
    'Generated by CaoGen Code Forge.',
    '',
    `- Target: ${context.target.kind}`,
    `- Branch: ${context.target.branch ?? '(detached)'}`,
    context.target.baseSha ? `- Base: ${context.target.baseSha.slice(0, 12)}` : '',
    `- Worktree: ${context.target.worktreePath}`
  ].filter(Boolean).join('\n')
}

function normalizeExistingDirectory(value: string, label: string): string {
  const text = cleanString(value)
  if (!text) throw new Error(`${label} 不能为空`)
  if (text.includes('\0')) throw new Error(`${label} 包含非法字符`)
  const resolved = path.resolve(text)
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`${label} 不是目录: ${resolved}`)
  }
  return realpathSync(resolved)
}

function repoRootFor(cwd: string): string {
  const result = runGit(cwd, ['rev-parse', '--show-toplevel'])
  if (!result.ok) throw new Error(result.error ?? '当前目录不是 Git 工作区')
  return realpathSync(path.resolve(cwd, result.stdout.trim()))
}

function currentBranch(cwd: string): string | undefined {
  const branch = runGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])
  if (branch.ok && branch.stdout.trim()) return branch.stdout.trim()
  const sha = runGit(cwd, ['rev-parse', '--short', 'HEAD'])
  return sha.ok ? sha.stdout.trim() : undefined
}

function revParseHead(cwd: string): string | undefined {
  const result = runGit(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])
  return result.ok ? result.stdout.trim() : undefined
}

function untrackedFiles(cwd: string): string[] {
  const result = runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--full-name', '--', '.'])
  return result.ok ? result.stdout.split('\0').filter(Boolean) : []
}

function countTextLines(root: string, relPath: string): number {
  try {
    const buffer = readFileSync(path.join(root, relPath))
    if (buffer.includes(0) || buffer.length === 0) return 0
    const text = buffer.toString('utf8')
    return text.endsWith('\n') ? text.split(/\r?\n/).length - 1 : text.split(/\r?\n/).length
  } catch {
    return 0
  }
}

function pathInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function runGit(
  cwd: string,
  args: string[],
  options: { allowExitCodes?: number[] } = {}
): GitRunResult {
  const allowed = options.allowExitCodes ?? [0]
  const result = spawnSync('git', withSafeLocalGitConfig(args), {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_BUFFER
  })
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  const status = result.status
  if (result.error) return { ok: false, stdout, stderr, status, error: result.error.message }
  if (status === null || !allowed.includes(status)) {
    return { ok: false, stdout, stderr, status, error: gitError(args, status, stdout, stderr) }
  }
  return { ok: true, stdout, stderr, status }
}

function gitError(args: string[], status: number | null, stdout: string, stderr: string): string {
  const output = (stderr.trim() || stdout.trim()).slice(0, MAX_OUTPUT_CHARS)
  const code = status === null ? 'timeout' : String(status)
  return output ? `git ${args.join(' ')} failed (${code}): ${output}` : `git ${args.join(' ')} failed (${code})`
}

function normalizeTimeout(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VERIFY_TIMEOUT_MS
  return Math.min(30 * 60 * 1000, Math.max(100, Math.floor(value)))
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n...<truncated>`
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function maxRisk(left: CodeForgeRiskLevel, right: CodeForgeRiskLevel): CodeForgeRiskLevel {
  const order: CodeForgeRiskLevel[] = ['low', 'medium', 'high']
  return order.indexOf(left) >= order.indexOf(right) ? left : right
}
