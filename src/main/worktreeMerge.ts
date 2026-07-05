import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import path from 'node:path'

const GIT_TIMEOUT_MS = 120_000
const MAX_GIT_BUFFER = 100 * 1024 * 1024

export type ConflictRisk = 'low' | 'medium' | 'unknown'

export interface WorktreeMergeFailure {
  ok: false
  error: string
}

export interface InspectMergeSuccess {
  ok: true
  repoRoot: string
  worktreePath: string
  baseSha: string
  headSha: string
  changedFiles: number
  insertions: number
  deletions: number
  conflictRisk: ConflictRisk
}

export type InspectMergeResult = InspectMergeSuccess | WorktreeMergeFailure

export interface CreateSquashPatchSuccess {
  ok: true
  repoRoot: string
  worktreePath: string
  baseSha: string
  headSha: string
  path: string
  patchText: string
  bytes: number
}

export type CreateSquashPatchResult = CreateSquashPatchSuccess | WorktreeMergeFailure

export type CanFastApplyPatchResult =
  | { ok: true; canApply: true }
  | { ok: true; canApply: false; error: string }
  | WorktreeMergeFailure

export interface ApplySquashPatchSuccess {
  ok: true
  repoRoot: string
  bytes: number
  changedFiles: number
  applied: boolean
}

export type ApplySquashPatchResult = ApplySquashPatchSuccess | WorktreeMergeFailure

export type PullRequestTool = 'gh' | 'glab'

export interface CreatePullRequestOptions {
  repoRoot: string
  worktreePath: string
  branch: string
  title: string
  body?: string
  baseBranch?: string | null
}

export type CreatePullRequestResult =
  | { ok: true; created: true; tool: PullRequestTool; branch: string; url: string; pushed: boolean }
  | { ok: true; created: false; message: string }
  | WorktreeMergeFailure

// 拒绝直接向这些分支推送/建 PR,遵守 git-safety(绝不直接动 main/master)。
const PROTECTED_BRANCHES = new Set(['main', 'master', 'HEAD'])

interface MergeContext {
  repoRoot: string
  worktreePath: string
  baseSha: string
  headSha: string
}

interface DiffStats {
  changedFiles: number
  insertions: number
  deletions: number
}

interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  status: number | null
  error?: string
}

export function inspectMerge(
  repoRoot: string,
  worktreePath: string,
  baseSha?: string
): InspectMergeResult {
  try {
    const context = resolveMergeContext(repoRoot, worktreePath, baseSha)
    const stats = diffStats(context.worktreePath, context.baseSha)
    const patch = buildSquashPatchText(context.worktreePath, context.baseSha)
    const conflictRisk = patch.ok
      ? conflictRiskForApplyCheck(context.repoRoot, patch.patchText)
      : 'unknown'

    return {
      ok: true,
      repoRoot: context.repoRoot,
      worktreePath: context.worktreePath,
      baseSha: context.baseSha,
      headSha: context.headSha,
      changedFiles: stats.changedFiles,
      insertions: stats.insertions,
      deletions: stats.deletions,
      conflictRisk
    }
  } catch (err) {
    return failure(errorMessage(err))
  }
}

export function createSquashPatch(
  repoRoot: string,
  worktreePath: string,
  outDir?: string,
  baseSha?: string
): CreateSquashPatchResult {
  try {
    const context = resolveMergeContext(repoRoot, worktreePath, baseSha)
    const patch = buildSquashPatchText(context.worktreePath, context.baseSha)
    if (patch.ok === false) return failure(patch.error)

    const patchDir = normalizeOutputDirectory(outDir)
    const patchPath = path.join(patchDir, patchFileName(context))
    const patchText = ensureTrailingNewline(patch.patchText)
    writeFileSync(patchPath, patchText, 'utf8')

    return {
      ok: true,
      repoRoot: context.repoRoot,
      worktreePath: context.worktreePath,
      baseSha: context.baseSha,
      headSha: context.headSha,
      path: patchPath,
      patchText,
      bytes: Buffer.byteLength(patchText, 'utf8')
    }
  } catch (err) {
    return failure(errorMessage(err))
  }
}

export function canFastApplyPatch(repoRoot: string, patchText: string): CanFastApplyPatchResult {
  try {
    const root = normalizeDirectory('repoRoot', repoRoot)
    assertGitWorktreeRoot(root, 'repoRoot')
    if (typeof patchText !== 'string') return failure('patchText 必须是字符串')
    if (patchText.trim() === '') return { ok: true, canApply: true }

    const check = runGit(root, ['apply', '--check', '--whitespace=nowarn', '-'], {
      input: ensureTrailingNewline(patchText)
    })
    if (check.ok) return { ok: true, canApply: true }
    if (check.status !== null) {
      return { ok: true, canApply: false, error: check.error ?? 'git apply --check failed' }
    }
    return failure(check.error ?? 'git apply --check 无法执行')
  } catch (err) {
    return failure(errorMessage(err))
  }
}

export function applySquashPatch(repoRoot: string, patchText: string): ApplySquashPatchResult {
  try {
    const root = normalizeDirectory('repoRoot', repoRoot)
    assertGitWorktreeRoot(root, 'repoRoot')
    if (typeof patchText !== 'string') return failure('patchText 必须是字符串')
    if (patchText.trim() === '') {
      return { ok: true, repoRoot: root, bytes: 0, changedFiles: 0, applied: false }
    }

    const normalizedPatch = ensureTrailingNewline(patchText)
    const check = canFastApplyPatch(root, normalizedPatch)
    if (check.ok === false) return failure(check.error)
    if (check.canApply === false) return failure(check.error)

    const apply = runGit(root, ['apply', '--whitespace=nowarn', '-'], { input: normalizedPatch })
    if (!apply.ok) return failure(apply.error ?? 'git apply failed')

    return {
      ok: true,
      repoRoot: root,
      bytes: Buffer.byteLength(normalizedPatch, 'utf8'),
      changedFiles: changedFileCountFromPatch(normalizedPatch),
      applied: true
    }
  } catch (err) {
    return failure(errorMessage(err))
  }
}

export function detectPullRequestTool(): PullRequestTool | null {
  for (const tool of ['gh', 'glab'] as const) {
    if (commandExists(tool)) return tool
  }
  return null
}

/**
 * 推送 managed worktree 分支并创建 PR/MR。
 * git-safety:绝不直接推 main/master;推送目标即受管分支自身,并用 -u 建立 upstream;
 * 无 force、无破坏性操作;全部走 execFile 数组参数,零字符串插值以避免注入。
 */
export function createPullRequest(options: CreatePullRequestOptions): CreatePullRequestResult {
  try {
    const root = normalizeDirectory('repoRoot', options.repoRoot)
    assertGitWorktreeRoot(root, 'repoRoot')
    const worktree = normalizeDirectory('worktreePath', options.worktreePath)
    assertSameRepository(root, worktree)

    const branch = typeof options.branch === 'string' ? options.branch.trim() : ''
    if (!branch) return failure('分支名不能为空')
    if (PROTECTED_BRANCHES.has(branch)) {
      return failure(`拒绝直接向受保护分支创建 PR: ${branch}`)
    }

    const title = typeof options.title === 'string' ? options.title.trim() : ''
    if (!title) return failure('PR 标题不能为空')
    const body = typeof options.body === 'string' ? options.body : ''

    const tool = detectPullRequestTool()
    if (!tool) {
      return {
        ok: true,
        created: false,
        message: '未检测到可用的 PR 工具(gh / glab),已跳过创建 PR'
      }
    }

    // 从 worktree 侧推送受管分支,设置上游;无 --force。
    const push = runGit(worktree, ['push', '-u', 'origin', `${branch}:${branch}`])
    if (!push.ok) return failure(push.error ?? `git push 失败: ${branch}`)

    const created =
      tool === 'gh'
        ? runPrTool('gh', worktree, ['pr', 'create', '--head', branch, '--title', title, '--body', body])
        : runPrTool('glab', worktree, ['mr', 'create', '--source-branch', branch, '--title', title, '--description', body, '--yes'])

    if (!created.ok) return failure(created.error ?? `${tool} 创建 PR 失败`)

    const url = extractUrl(created.stdout) ?? created.stdout.trim()
    return { ok: true, created: true, tool, branch, url, pushed: true }
  } catch (err) {
    return failure(errorMessage(err))
  }
}

function commandExists(command: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  try {
    execFileSync(probe, [command], {
      stdio: 'ignore',
      timeout: GIT_TIMEOUT_MS
    })
    return true
  } catch {
    return false
  }
}

function runPrTool(
  command: PullRequestTool,
  cwd: string,
  args: string[]
): { ok: boolean; stdout: string; error?: string } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_BUFFER
  })
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  if (result.error) return { ok: false, stdout, error: result.error.message }
  if (result.status !== 0) {
    const output = stderr.trim() || stdout.trim()
    return { ok: false, stdout, error: output || `${command} exited with ${result.status ?? 'null'}` }
  }
  return { ok: true, stdout }
}

function extractUrl(text: string): string | null {
  const match = /https?:\/\/\S+/.exec(text)
  return match ? match[0].trim() : null
}

function resolveMergeContext(
  repoRoot: string,
  worktreePath: string,
  requestedBaseSha?: string
): MergeContext {
  const root = normalizeDirectory('repoRoot', repoRoot)
  const worktree = normalizeDirectory('worktreePath', worktreePath)
  assertSameRepository(root, worktree)

  const headSha = git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const repoHeadSha = git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const baseSha = requestedBaseSha?.trim()
    ? git(worktree, ['rev-parse', '--verify', `${requestedBaseSha.trim()}^{commit}`])
    : mergeBase(root, worktree, repoHeadSha, headSha)

  return {
    repoRoot: root,
    worktreePath: worktree,
    baseSha,
    headSha
  }
}

function normalizeDirectory(label: string, value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 不能为空`)
  if (value.includes('\0')) throw new Error(`${label} 包含非法字符`)

  const resolved = path.resolve(value)
  const info = statSync(resolved)
  if (!info.isDirectory()) throw new Error(`${label} 不是目录: ${resolved}`)
  return realpathSync(resolved)
}

function normalizeOutputDirectory(outDir: string | undefined): string {
  const requested = outDir?.trim() ? outDir : path.join(tmpdir(), 'caogen-worktree-patches')
  if (requested.includes('\0')) throw new Error('outDir 包含非法字符')
  const resolved = path.resolve(requested)
  mkdirSync(resolved, { recursive: true })
  const info = statSync(resolved)
  if (!info.isDirectory()) throw new Error(`outDir 不是目录: ${resolved}`)
  return realpathSync(resolved)
}

function assertSameRepository(repoRoot: string, worktreePath: string): void {
  const repoTop = assertGitWorktreeRoot(repoRoot, 'repoRoot')
  const worktreeTop = assertGitWorktreeRoot(worktreePath, 'worktreePath')
  if (repoTop !== repoRoot) throw new Error(`repoRoot 必须是 Git 工作区根目录: ${repoRoot}`)
  if (worktreeTop !== worktreePath) throw new Error(`worktreePath 必须是 Git 工作区根目录: ${worktreePath}`)

  const repoCommonDir = gitCommonDir(repoRoot)
  const worktreeCommonDir = gitCommonDir(worktreePath)
  if (repoCommonDir !== worktreeCommonDir) {
    throw new Error('repoRoot 与 worktreePath 不属于同一个 Git 仓库')
  }
}

function assertGitWorktreeRoot(cwd: string, label: string): string {
  const topLevel = git(cwd, ['rev-parse', '--show-toplevel'])
  const normalizedTopLevel = realpathSync(path.resolve(cwd, topLevel))
  if (!normalizedTopLevel) throw new Error(`${label} 不是 Git 工作区`)
  return normalizedTopLevel
}

function gitCommonDir(cwd: string): string {
  const raw = git(cwd, ['rev-parse', '--git-common-dir'])
  const fullPath = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw)
  return realpathSync(fullPath)
}

function mergeBase(repoRoot: string, worktreePath: string, repoHeadSha: string, headSha: string): string {
  const result = runGit(worktreePath, ['merge-base', repoHeadSha, headSha])
  if (result.ok && result.stdout.trim()) return result.stdout.trim()
  throw new Error(
    `无法计算 repoRoot HEAD 与 worktree HEAD 的 merge-base: ${
      result.error ?? 'git merge-base 没有输出'
    }`
  )
}

function diffStats(worktreePath: string, baseSha: string): DiffStats {
  const numstat = gitRaw(worktreePath, ['diff', '--numstat', baseSha, '--'])
  let changedFiles = 0
  let insertions = 0
  let deletions = 0

  for (const line of numstat.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [added, removed] = line.split('\t')
    changedFiles += 1
    if (/^\d+$/.test(added)) insertions += Number(added)
    if (/^\d+$/.test(removed)) deletions += Number(removed)
  }

  for (const file of untrackedFiles(worktreePath)) {
    changedFiles += 1
    insertions += countTextLines(worktreePath, file)
  }

  return { changedFiles, insertions, deletions }
}

function buildSquashPatchText(
  worktreePath: string,
  baseSha: string
): { ok: true; patchText: string } | WorktreeMergeFailure {
  const tracked = runGit(worktreePath, ['diff', '--binary', '--full-index', baseSha, '--'])
  if (!tracked.ok) return failure(tracked.error ?? 'git diff failed')

  const chunks = [tracked.stdout]
  for (const file of untrackedFiles(worktreePath)) {
    const untracked = runGit(
      worktreePath,
      ['diff', '--no-index', '--binary', '--full-index', '--', devNull, file],
      { allowExitCodes: [0, 1] }
    )
    if (!untracked.ok) return failure(untracked.error ?? `无法生成 untracked patch: ${file}`)
    chunks.push(untracked.stdout)
  }

  return {
    ok: true,
    patchText: chunks.filter((chunk) => chunk.length > 0).join('\n')
  }
}

function conflictRiskForApplyCheck(repoRoot: string, patchText: string): ConflictRisk {
  const check = canFastApplyPatch(repoRoot, patchText)
  if (!check.ok) return 'unknown'
  return check.canApply ? 'low' : 'medium'
}

function untrackedFiles(worktreePath: string): string[] {
  const output = gitRaw(worktreePath, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--full-name',
    '--',
    '.'
  ])
  return output.split('\0').filter(Boolean)
}

function countTextLines(worktreePath: string, relPath: string): number {
  try {
    const buffer = readFileSync(path.join(worktreePath, relPath))
    if (buffer.includes(0) || buffer.length === 0) return 0
    const text = buffer.toString('utf8')
    return text.endsWith('\n') ? text.split(/\r?\n/).length - 1 : text.split(/\r?\n/).length
  } catch {
    return 0
  }
}

function patchFileName(context: MergeContext): string {
  const hash = createHash('sha1')
    .update(context.repoRoot)
    .update('\0')
    .update(context.worktreePath)
    .digest('hex')
    .slice(0, 10)
  return `worktree-${context.headSha.slice(0, 12)}-${hash}-${Date.now()}.patch`
}

function git(cwd: string, args: string[]): string {
  return gitRaw(cwd, args).trim()
}

function gitRaw(cwd: string, args: string[]): string {
  const result = runGit(cwd, args)
  if (!result.ok) throw new Error(result.error ?? `git ${args.join(' ')} failed`)
  return result.stdout
}

function runGit(
  cwd: string,
  args: string[],
  options: { input?: string; allowExitCodes?: number[] } = {}
): GitResult {
  const allowed = options.allowExitCodes ?? [0]
  const result = spawnSync('git', args, {
    cwd,
    input: options.input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_BUFFER
  })

  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  const status = result.status

  if (result.error) {
    return {
      ok: false,
      stdout,
      stderr,
      status,
      error: result.error.message
    }
  }

  if (status === null || !allowed.includes(status)) {
    return {
      ok: false,
      stdout,
      stderr,
      status,
      error: gitError(args, status, stdout, stderr)
    }
  }

  return { ok: true, stdout, stderr, status }
}

function gitError(args: string[], status: number | null, stdout: string, stderr: string): string {
  const output = stderr.trim() || stdout.trim()
  const command = ['git', ...args].join(' ')
  if (output) return `${command} failed${status === null ? '' : ` (${status})`}: ${output}`
  return `${command} failed${status === null ? '' : ` (${status})`}`
}

function ensureTrailingNewline(text: string): string {
  if (!text) return text
  return text.endsWith('\n') ? text : `${text}\n`
}

function changedFileCountFromPatch(patchText: string): number {
  const files = new Set<string>()
  for (const line of patchText.split(/\r?\n/)) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (!match) continue
    const target = match[2]
    if (target && target !== '/dev/null') files.add(target)
  }
  return files.size
}

function failure(error: string): WorktreeMergeFailure {
  return { ok: false, error }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
