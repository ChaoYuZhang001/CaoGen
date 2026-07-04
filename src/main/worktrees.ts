import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type {
  ManagedWorktreeView,
  WorktreePatchResult,
  WorktreeRemoveResult,
  WorktreeSummary
} from '../shared/types'

const WORKTREE_BRANCH_PREFIX = 'caogen'
const GIT_TIMEOUT_MS = 120_000

export type ManagedWorktreeState = 'active' | 'removed'

export interface ManagedWorktreeRecord {
  sessionId: string
  repoRoot: string
  sourceCwd: string
  worktreePath: string
  cwd: string
  branch: string
  baseSha: string
  baseBranch: string | null
  state: ManagedWorktreeState
  createdAt: number
  updatedAt: number
}

export interface WorktreePrepareOptions {
  sessionId: string
  cwd: string
  isolated?: boolean
}

export type WorktreePrepareResult =
  | { ok: true; isolated: boolean; cwd: string; record?: ManagedWorktreeRecord }
  | { ok: false; isolated: boolean; cwd: string; error: string }

export type WorktreeOpResult =
  | { ok: true; record: ManagedWorktreeRecord }
  | { ok: false; error: string; record?: ManagedWorktreeRecord }

interface WorktreeDiffStats {
  changedFiles: number
  insertions?: number
  deletions?: number
  dirty: boolean
}

function worktreesRoot(): string {
  return join(app.getPath('userData'), 'worktrees')
}

function registryFile(): string {
  return join(worktreesRoot(), 'index.json')
}

function patchesRoot(): string {
  return join(app.getPath('userData'), 'patches')
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS
    }).trim()
  } catch (err) {
    throw new Error(`git ${args.join(' ')} failed: ${errorText(err)}`)
  }
}

function gitOrNull(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args)
  } catch {
    return null
  }
}

function gitOutputAllowDiffExit(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS
    })
  } catch (err) {
    const stdout = err instanceof Error ? bufferText((err as Error & { stdout?: Buffer | string }).stdout) : ''
    if (stdout) return `${stdout}\n`
    throw new Error(`git ${args.join(' ')} failed: ${errorText(err)}`)
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const withOutput = err as Error & { stderr?: Buffer | string; stdout?: Buffer | string }
    const stderr = bufferText(withOutput.stderr)
    if (stderr) return stderr
    const stdout = bufferText(withOutput.stdout)
    if (stdout) return stdout
    return err.message
  }
  return String(err)
}

function bufferText(value: Buffer | string | undefined): string {
  if (value === undefined) return ''
  return Buffer.isBuffer(value) ? value.toString('utf8').trim() : value.trim()
}

function branchFor(sessionId: string): string {
  return `${WORKTREE_BRANCH_PREFIX}/${sessionId}`
}

function safePathSegment(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
  if (safe && safe === sessionId && safe !== '.' && safe !== '..') return safe
  const hash = createHash('sha1').update(sessionId).digest('hex').slice(0, 8)
  const prefix = safe && safe !== '.' && safe !== '..' ? safe : 'session'
  return `${prefix}-${hash}`
}

function worktreePathFor(sessionId: string): string {
  return join(worktreesRoot(), safePathSegment(sessionId))
}

function normalizeSessionId(sessionId: string): string {
  const normalized = sessionId.trim()
  if (!normalized) throw new Error('sessionId 不能为空')
  return normalized
}

function sourceSubdirFor(cwd: string): string {
  return git(cwd, ['rev-parse', '--show-prefix']).replace(/[\\/]+$/, '')
}

function cwdForWorktree(worktreePath: string, sourceCwd: string): string {
  const subdir = sourceSubdirFor(sourceCwd)
  return subdir ? join(worktreePath, subdir) : worktreePath
}

function currentBranchFor(repoRoot: string): string | null {
  const branch = gitOrNull(repoRoot, ['symbolic-ref', '--short', '-q', 'HEAD'])
  return branch || null
}

function branchExists(repoRoot: string, branch: string): boolean {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: repoRoot,
      stdio: 'ignore',
      timeout: GIT_TIMEOUT_MS
    })
    return true
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is ManagedWorktreeRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<ManagedWorktreeRecord>
  return (
    typeof record.sessionId === 'string' &&
    typeof record.repoRoot === 'string' &&
    typeof record.sourceCwd === 'string' &&
    typeof record.worktreePath === 'string' &&
    typeof record.cwd === 'string' &&
    typeof record.branch === 'string' &&
    typeof record.baseSha === 'string' &&
    (typeof record.baseBranch === 'string' || record.baseBranch === null) &&
    (record.state === 'active' || record.state === 'removed') &&
    typeof record.createdAt === 'number' &&
    typeof record.updatedAt === 'number'
  )
}

function loadRegistry(): ManagedWorktreeRecord[] {
  try {
    const raw = JSON.parse(readFileSync(registryFile(), 'utf8')) as unknown
    if (Array.isArray(raw)) return raw.filter(isRecord)
    if (raw && typeof raw === 'object') {
      const maybeRecords = (raw as { records?: unknown }).records
      if (Array.isArray(maybeRecords)) return maybeRecords.filter(isRecord)
    }
  } catch {
    // Registry is optional and can be recreated from future successful operations.
  }
  return []
}

function saveRegistry(records: ManagedWorktreeRecord[]): void {
  mkdirSync(worktreesRoot(), { recursive: true })
  writeFileSync(registryFile(), JSON.stringify(records, null, 2))
}

function upsertRecord(records: ManagedWorktreeRecord[], record: ManagedWorktreeRecord): void {
  const index = records.findIndex((item) => item.sessionId === record.sessionId)
  if (index >= 0) records[index] = record
  else records.push(record)
}

function updateRecord(record: ManagedWorktreeRecord): ManagedWorktreeRecord {
  const records = loadRegistry()
  upsertRecord(records, record)
  saveRegistry(records)
  return record
}

function toView(record: ManagedWorktreeRecord): ManagedWorktreeView {
  return { ...record }
}

function recordForSession(sessionId: string): ManagedWorktreeRecord | null {
  const normalizedSessionId = normalizeSessionId(sessionId)
  return loadRegistry().find((item) => item.sessionId === normalizedSessionId) ?? null
}

function diffStats(record: ManagedWorktreeRecord): WorktreeDiffStats {
  if (record.state !== 'active' || !existsSync(record.worktreePath)) {
    return { changedFiles: 0, dirty: false }
  }
  const numstat = git(record.worktreePath, ['diff', '--numstat', record.baseSha, '--'])
  let changedFiles = 0
  let insertions = 0
  let deletions = 0
  for (const line of numstat.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [added, removed] = line.split(/\t/)
    changedFiles += 1
    if (/^\d+$/.test(added)) insertions += Number(added)
    if (/^\d+$/.test(removed)) deletions += Number(removed)
  }
  for (const file of untrackedFiles(record.worktreePath)) {
    changedFiles += 1
    insertions += countTextLines(record.worktreePath, file)
  }
  return { changedFiles, insertions, deletions, dirty: changedFiles > 0 }
}

function untrackedFiles(worktreePath: string): string[] {
  const output = execFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z', '--full-name', '--', '.'],
    {
      cwd: worktreePath,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS
    }
  )
  return output.toString('utf8').split('\0').filter(Boolean)
}

function countTextLines(worktreePath: string, relPath: string): number {
  try {
    const buf = readFileSync(join(worktreePath, relPath))
    if (buf.includes(0)) return 0
    const text = buf.toString('utf8')
    if (!text) return 0
    return text.endsWith('\n') ? text.split(/\r?\n/).length - 1 : text.split(/\r?\n/).length
  } catch {
    return 0
  }
}

function untrackedPatch(worktreePath: string): string {
  return untrackedFiles(worktreePath)
    .map((file) => gitOutputAllowDiffExit(worktreePath, ['diff', '--no-index', '--binary', '--', '/dev/null', file]))
    .join('\n')
}

export function isGitRepository(cwd: string): boolean {
  if (!cwd) return false
  try {
    return git(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true'
  } catch {
    return false
  }
}

export function repoRootFor(cwd: string): string | null {
  if (!cwd || !isGitRepository(cwd)) return null
  return gitOrNull(cwd, ['rev-parse', '--show-toplevel'])
}

export function prepareWorktree(opts: WorktreePrepareOptions): WorktreePrepareResult {
  const sourceCwd = typeof opts.cwd === 'string' ? opts.cwd : ''
  const requestedIsolation = opts.isolated === true
  const shouldAutoIsolate = opts.isolated === undefined

  try {
    const sessionId = normalizeSessionId(opts.sessionId)
    const repoRoot = repoRootFor(sourceCwd)
    if (!repoRoot) {
      if (requestedIsolation) {
        return { ok: false, isolated: true, cwd: sourceCwd, error: '当前目录不是 Git 仓库' }
      }
      return { ok: true, isolated: false, cwd: sourceCwd }
    }

    if (!requestedIsolation && !shouldAutoIsolate) {
      return { ok: true, isolated: false, cwd: sourceCwd }
    }

    const records = loadRegistry()
    const existing = records.find(
      (record) => record.sessionId === sessionId && record.state === 'active'
    )
    if (existing && existsSync(existing.worktreePath)) {
      return { ok: true, isolated: true, cwd: existing.cwd, record: existing }
    }

    const branch = branchFor(sessionId)
    git(repoRoot, ['check-ref-format', '--branch', branch])

    const worktreePath = worktreePathFor(sessionId)
    const cwd = cwdForWorktree(worktreePath, sourceCwd)
    const baseSha = git(repoRoot, ['rev-parse', 'HEAD'])
    const baseBranch = currentBranchFor(repoRoot)

    mkdirSync(worktreesRoot(), { recursive: true })
    git(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'])
    mkdirSync(cwd, { recursive: true })

    const now = Date.now()
    const record: ManagedWorktreeRecord = {
      sessionId,
      repoRoot,
      sourceCwd,
      worktreePath,
      cwd,
      branch,
      baseSha,
      baseBranch,
      state: 'active',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    upsertRecord(records, record)
    saveRegistry(records)
    return { ok: true, isolated: true, cwd, record }
  } catch (err) {
    return { ok: false, isolated: requestedIsolation || shouldAutoIsolate, cwd: sourceCwd, error: errorText(err) }
  }
}

export function listManagedWorktrees(): ManagedWorktreeRecord[] {
  try {
    return loadRegistry().sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

export function getManagedWorktreeSummary(sessionId: string): WorktreeSummary {
  try {
    const record = recordForSession(sessionId)
    if (!record) {
      return {
        ok: false,
        isolated: false,
        changedFiles: 0,
        dirty: false,
        error: '当前会话没有 CaoGen 管理的 worktree'
      }
    }
    const stats = diffStats(record)
    return {
      ok: true,
      isolated: true,
      record: toView(record),
      ...stats
    }
  } catch (err) {
    return {
      ok: false,
      isolated: false,
      changedFiles: 0,
      dirty: false,
      error: errorText(err)
    }
  }
}

export function exportManagedWorktreePatch(sessionId: string): WorktreePatchResult {
  try {
    const record = recordForSession(sessionId)
    if (!record) return { ok: false, error: '当前会话没有 CaoGen 管理的 worktree' }
    if (record.state !== 'active' || !existsSync(record.worktreePath)) {
      return { ok: false, error: 'worktree 已不存在或已移除' }
    }
    // 相对基线的完整改动 = 已提交(baseSha..HEAD)+ 工作区未提交(HEAD 相对工作树)。
    // 用 `git diff --binary baseSha`(不带 -- 的三点/两点)对比"基线↔当前工作树",
    // 它同时涵盖已提交与未提交改动,一步到位;再叠加未跟踪文件。
    const patch = [
      git(record.worktreePath, ['diff', '--binary', record.baseSha]),
      untrackedPatch(record.worktreePath)
    ]
      .filter(Boolean)
      .join('\n')
    mkdirSync(patchesRoot(), { recursive: true })
    const patchPath = join(patchesRoot(), `${safePathSegment(record.sessionId)}-${Date.now()}.patch`)
    // git() 帮手会 trim 输出末尾换行,而 git apply 要求 patch 以换行结尾(否则 corrupt patch)
    writeFileSync(patchPath, patch ? `${patch}\n` : patch)
    return { ok: true, path: patchPath, bytes: statSync(patchPath).size }
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}

export function removeManagedWorktree(
  sessionId: string,
  opts: { deleteBranch?: boolean; force?: boolean } = {}
): WorktreeOpResult {
  try {
    const normalizedSessionId = normalizeSessionId(sessionId)
    const record = loadRegistry().find((item) => item.sessionId === normalizedSessionId)
    if (!record) {
      return { ok: false, error: `未找到 session ${normalizedSessionId} 的 worktree 记录` }
    }

    if (record.state !== 'removed' && existsSync(record.worktreePath)) {
      git(record.repoRoot, [
        'worktree',
        'remove',
        ...(opts.force === true ? ['--force'] : []),
        record.worktreePath
      ])
    }

    const removedRecord = updateRecord({
      ...record,
      state: 'removed',
      updatedAt: Date.now()
    })

    if (opts.deleteBranch === true && branchExists(record.repoRoot, record.branch)) {
      try {
        git(record.repoRoot, ['branch', opts.force === true ? '-D' : '-d', record.branch])
      } catch (err) {
        return {
          ok: false,
          error: `worktree 已移除，但删除分支失败: ${errorText(err)}`,
          record: removedRecord
        }
      }
    }

    return { ok: true, record: removedRecord }
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}

export function removeManagedWorktreeView(
  sessionId: string,
  opts: { deleteBranch?: boolean; force?: boolean } = {}
): WorktreeRemoveResult {
  const result = removeManagedWorktree(sessionId, opts)
  if (result.ok) return { ok: true, record: toView(result.record) }
  const failed = result as Extract<WorktreeOpResult, { ok: false }>
  return { ok: false, error: failed.error, record: failed.record ? toView(failed.record) : undefined }
}
