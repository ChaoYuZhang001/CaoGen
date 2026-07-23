import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { EffectTarget } from '../../shared/types'
import { inspectSingleFilePatch } from './git-patch-inspection'
import { unsafeMergeConfigKeys } from './safe-git'

type GitIndexUpdateTarget = Extract<EffectTarget, { kind: 'git_index_update' }>

export type GitIndexOperation = GitIndexUpdateTarget['operation']

export interface GitIndexBuildRequest {
  cwd: string
  operation: GitIndexOperation
  paths?: unknown
  filePath?: unknown
  patch?: unknown
}

export interface NormalizedGitIndexRequest {
  operation: GitIndexOperation
  paths: string[]
  worktreeReadScope: GitIndexUpdateTarget['worktreeReadScope']
  scopePath?: string
  patch?: string
}

export interface GitIndexInputCommands {
  environment(): NodeJS.ProcessEnv
  text(cwd: string, args: string[], env: NodeJS.ProcessEnv): string
  buffer(cwd: string, args: string[], env: NodeJS.ProcessEnv, input?: Buffer): Buffer
}

const MAX_PATHS = 5_000
const MAX_PATH_ARGUMENT_BYTES = 256 * 1024
const MAX_PATCH_BYTES = 1_000_000

export function normalizeGitIndexRequest(
  repoRoot: string,
  request: GitIndexBuildRequest,
  commands: GitIndexInputCommands
): NormalizedGitIndexRequest {
  assertNoExecutableGitFilters(repoRoot, commands)
  if (request.operation === 'stage_all') return normalizeStageAll(repoRoot, request, commands)
  if (request.operation === 'apply_cached_hunk') return normalizeCachedHunk(repoRoot, request)
  const paths = normalizeLiteralPaths(repoRoot, request.cwd, request.paths, commands)
  return {
    operation: request.operation,
    paths,
    worktreeReadScope: request.operation === 'unstage_paths' ? 'none' : 'paths'
  }
}

export function assertSafeNormalizedGitIndexInput(
  repoRoot: string,
  request: NormalizedGitIndexRequest,
  commands: GitIndexInputCommands
): void {
  assertNoExecutableGitFilters(repoRoot, commands)
  if ((request.operation === 'stage_paths' || request.operation === 'stage_all') && request.paths.length > 0) {
    assertNoFilterAttributes(repoRoot, request.paths, commands)
  }
}

export function normalizeGitIndexPatch(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('hunk patch 不能为空')
  const normalized = value.endsWith('\n') ? value : `${value}\n`
  if (Buffer.byteLength(normalized, 'utf8') > MAX_PATCH_BYTES) throw new Error('hunk patch 过大')
  return normalized
}

function normalizeStageAll(
  repoRoot: string,
  request: GitIndexBuildRequest,
  commands: GitIndexInputCommands
): NormalizedGitIndexRequest {
  const scopePath = cwdScopePath(repoRoot, request.cwd)
  return {
    operation: request.operation,
    paths: changedPaths(repoRoot, scopePath, commands),
    worktreeReadScope: 'all',
    scopePath
  }
}

function normalizeCachedHunk(
  repoRoot: string,
  request: GitIndexBuildRequest
): NormalizedGitIndexRequest {
  const patch = normalizeGitIndexPatch(request.patch)
  const inspected = inspectSingleFilePatch(repoRoot, String(request.filePath ?? ''), patch)
  if (inspected.ok === false) throw new Error(inspected.error)
  return { operation: request.operation, paths: [inspected.relativePath], worktreeReadScope: 'paths', patch }
}

function normalizeLiteralPaths(
  repoRoot: string,
  cwd: string,
  input: unknown,
  commands: GitIndexInputCommands
): string[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error('Git index 操作缺少文件路径')
  const realCwd = realpathSync(resolve(cwd))
  const paths = input.map((value) => normalizeLiteralPath(repoRoot, realCwd, value))
  const unique = [...new Set(paths)].sort()
  if (unique.length > MAX_PATHS) throw new Error(`Git index 操作路径超过 ${MAX_PATHS} 条上限`)
  const argumentBytes = unique.reduce((total, item) => total + Buffer.byteLength(item) + 1, 0)
  if (argumentBytes > MAX_PATH_ARGUMENT_BYTES) throw new Error('Git index 操作路径参数过大')
  assertNoTrackedDirectoryPathspecs(repoRoot, unique, commands)
  return unique
}

function assertNoTrackedDirectoryPathspecs(
  repoRoot: string,
  paths: string[],
  commands: GitIndexInputCommands
): void {
  const tracked = commands.buffer(repoRoot, ['ls-files', '-z'], commands.environment())
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
  for (const candidate of paths) {
    if (tracked.some((entry) => entry.startsWith(`${candidate}/`))) {
      throw new Error(`Git index 操作不接受目录 pathspec:${candidate}`)
    }
  }
}

function normalizeLiteralPath(repoRoot: string, cwd: string, value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.includes('\0')) {
    throw new Error('Git 路径不能为空或包含非法字符')
  }
  if (isAbsolute(value) || value.startsWith(':')) throw new Error('Git 路径必须是普通相对路径')
  const absolute = resolve(cwd, value)
  const repoRelative = relative(repoRoot, absolute)
  if (!repoRelative || repoRelative.startsWith('..') || isAbsolute(repoRelative)) throw new Error('Git 路径必须位于当前仓库内')
  if (existsSync(absolute) && lstatSync(absolute).isDirectory()) throw new Error('Git index 操作暂不接受目录 pathspec')
  return repoRelative.split(sep).join('/')
}

function cwdScopePath(repoRoot: string, cwd: string): string {
  const realCwd = realpathSync(resolve(cwd))
  const scope = relative(repoRoot, realCwd)
  if (scope.startsWith('..') || isAbsolute(scope)) throw new Error('Git stageAll cwd 不在仓库内')
  return scope ? scope.split(sep).join('/') : '.'
}

function changedPaths(repoRoot: string, scopePath: string, commands: GitIndexInputCommands): string[] {
  const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', scopePath]
  const output = commands.buffer(repoRoot, args, commands.environment())
  const records = output.toString('utf8').split('\0').filter(Boolean)
  const paths: string[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.length < 4) continue
    paths.push(record.slice(3))
    if (record[0] === 'R' || record[0] === 'C') paths.push(records[++index] ?? '')
  }
  return [...new Set(paths.filter(Boolean))].sort()
}

function assertNoExecutableGitFilters(repoRoot: string, commands: GitIndexInputCommands): void {
  const env = commands.environment()
  const config = commands.text(repoRoot, ['config', '--includes', '-z', '--list'], env)
  const filters = unsafeMergeConfigKeys(config).filter((key) => /^filter\..+\.(?:clean|smudge|process)$/i.test(key))
  if (filters.length > 0) throw new Error(`仓库配置了可执行 Git filter，已阻止 index 操作:${filters.join(', ')}`)
}

function assertNoFilterAttributes(
  repoRoot: string,
  paths: string[],
  commands: GitIndexInputCommands
): void {
  const input = Buffer.from(`${paths.join('\0')}\0`, 'utf8')
  const output = commands.buffer(repoRoot, ['check-attr', '-z', '--stdin', 'filter'], commands.environment(), input)
  const fields = output.toString('utf8').split('\0').filter(Boolean)
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const value = fields[index + 2]
    if (value !== 'unspecified' && value !== 'unset') {
      throw new Error(`路径 ${fields[index]} 配置了 Git filter=${value}，已阻止 index 操作`)
    }
  }
}
