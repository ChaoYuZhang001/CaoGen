import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  applySquashPatch,
  canFastApplyPatch,
  createSquashPatch,
  getConflictFiles,
  inspectMerge,
  patchSha256,
  reverseSquashPatch,
  WORKTREE_MERGE_EXCLUDE_PATHSPECS
} from '../worktreeMerge'
import { buildConflictResolverRequest } from '../agent/conflict-resolver'
import type {
  TaskDagAutoMergeConflict,
  TaskDagAutoMergeEntry,
  TaskDagAutoMergeRollback,
  TaskDagAutoMergeVerification,
  TaskDagAutoMergeView,
  TaskDagExecutionTask,
  TaskDagExecutionView
} from '../../shared/types'

export interface TaskDagAutoMergeSession {
  sessionId: string
  taskId?: string
  repoRoot?: string
  worktreePath?: string
  baseSha?: string
  branch?: string
  resultText?: string
}

export interface RunTaskDagAutoMergeOptions {
  execution: TaskDagExecutionView
  sessions: TaskDagAutoMergeSession[]
  verificationCommand?: string
  commitChanges?: boolean
  verificationTimeoutMs?: number
}

interface AppliedPatch {
  entryIndex: number
  repoRoot: string
  patchText: string
}

interface GitRunResult {
  ok: boolean
  stdout: string
  stderr: string
  status: number | null
  error?: string
}

const DEFAULT_VERIFY_TIMEOUT_MS = 120_000
const MAX_VERIFY_OUTPUT_CHARS = 5000
const VERIFY_CONFIG_FILES = ['caogen.md', '.caogen.md'] as const

export function runTaskDagAutoMerge(options: RunTaskDagAutoMergeOptions): TaskDagAutoMergeView {
  const startedAt = Date.now()
  const entries: TaskDagAutoMergeEntry[] = []
  const applied: AppliedPatch[] = []
  const sessionMap = new Map(options.sessions.map((session) => [session.sessionId, session]))
  const commitChanges = options.commitChanges ?? true
  let repoRoot: string | undefined
  let verification: TaskDagAutoMergeVerification | undefined

  for (const [entryIndex, taskState] of orderedTasks(options.execution).entries()) {
    const entry = mergeTask({
      entryIndex,
      taskState,
      sessionMap,
      repoRoot,
      applied,
      commitChanges
    })
    if (!repoRoot && entry.repoRoot) repoRoot = entry.repoRoot
    entries.push(stripRepoRoot(entry))
  }

  const hasBlockingFailure = entries.some((entry) => entry.status === 'blocked' || entry.status === 'failed')
  if (repoRoot && !hasBlockingFailure && entries.some((entry) => entry.status === 'merged')) {
    verification = runConfiguredVerification(
      repoRoot,
      options.verificationCommand,
      options.verificationTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS
    )
  } else {
    verification = { status: 'not-run', error: hasBlockingFailure ? '存在阻塞或失败的合并项' : '没有可验收的合并项' }
  }

  let rollback: TaskDagAutoMergeRollback | undefined
  if (verification.status === 'failed') {
    rollback = rollbackAppliedPatches(applied)
    if (rollback?.ok) {
      for (const appliedPatch of applied) {
        const entry = entries[appliedPatch.entryIndex]
        if (entry?.status === 'merged') entry.status = 'rolled-back'
      }
    }
  }

  const mergedCount = entries.filter((entry) => entry.status === 'merged').length
  const blockedCount = entries.filter((entry) => entry.status === 'blocked').length
  const skippedCount = entries.filter((entry) => entry.status === 'skipped').length
  const failedCount = entries.filter((entry) => entry.status === 'failed').length
  const rolledBackCount = entries.filter((entry) => entry.status === 'rolled-back').length
  const status = summarizeStatus({
    mergedCount,
    blockedCount,
    failedCount,
    rolledBackCount,
    verification,
    rollback
  })

  return {
    enabled: true,
    status,
    startedAt,
    completedAt: Date.now(),
    repoRoot,
    entries,
    mergedCount,
    blockedCount,
    skippedCount,
    verification,
    rollback,
    summary: buildSummary(mergedCount, blockedCount, skippedCount, failedCount, rolledBackCount, verification),
    error: status === 'failed' ? firstError(entries, verification, rollback) : undefined
  }
}

function mergeTask(input: {
  entryIndex: number
  taskState: TaskDagExecutionTask
  sessionMap: Map<string, TaskDagAutoMergeSession>
  repoRoot?: string
  applied: AppliedPatch[]
  commitChanges: boolean
}): TaskDagAutoMergeEntry & { repoRoot?: string } {
  const taskId = input.taskState.task.id
  if (input.taskState.status !== 'success') {
    return { taskId, status: 'skipped', error: `任务状态为 ${input.taskState.status}` }
  }

  const sessionId = input.taskState.sessionIds[input.taskState.sessionIds.length - 1]
  if (!sessionId) return { taskId, status: 'skipped', error: '任务没有可合并的子会话' }

  const session = input.sessionMap.get(sessionId)
  if (!session) return { taskId, sessionId, status: 'skipped', error: '找不到子会话元数据' }
  if (!session.repoRoot || !session.worktreePath || !session.baseSha) {
    return {
      taskId,
      sessionId,
      branch: session.branch,
      worktreePath: session.worktreePath,
      status: 'skipped',
      error: '子会话缺少 repoRoot/worktreePath/baseSha'
    }
  }
  if (input.repoRoot && path.resolve(input.repoRoot) !== path.resolve(session.repoRoot)) {
    return {
      taskId,
      sessionId,
      branch: session.branch,
      worktreePath: session.worktreePath,
      status: 'blocked',
      error: 'DAG 自动合并暂不跨仓库合并'
    }
  }

  if (input.commitChanges) {
    const commit = commitWorktreeChanges(session.worktreePath, input.taskState.task.title)
    if (!commit.ok) {
      return {
        taskId,
        sessionId,
        branch: session.branch,
        worktreePath: session.worktreePath,
        repoRoot: session.repoRoot,
        status: 'failed',
        error: resultError(commit, 'git commit 失败')
      }
    }
  }

  const inspect = inspectMerge(session.repoRoot, session.worktreePath, session.baseSha)
  if (!inspect.ok) {
    return {
      taskId,
      sessionId,
      branch: session.branch,
      worktreePath: session.worktreePath,
      repoRoot: session.repoRoot,
      status: 'failed',
      error: resultError(inspect, '合并检查失败')
    }
  }

  const patch = createSquashPatch(session.repoRoot, session.worktreePath, patchOutputRoot(), session.baseSha)
  if (!patch.ok) {
    return {
      taskId,
      sessionId,
      branch: session.branch,
      worktreePath: session.worktreePath,
      repoRoot: session.repoRoot,
      status: 'failed',
      changedFiles: inspect.changedFiles,
      insertions: inspect.insertions,
      deletions: inspect.deletions,
      conflictRisk: inspect.conflictRisk,
      error: resultError(patch, '生成 squash patch 失败')
    }
  }

  if (!patch.patchText.trim()) {
    return {
      taskId,
      sessionId,
      branch: session.branch,
      worktreePath: session.worktreePath,
      repoRoot: session.repoRoot,
      status: 'skipped',
      changedFiles: 0,
      insertions: 0,
      deletions: 0,
      conflictRisk: 'low',
      patchPath: patch.path,
      error: '没有可合并的 diff'
    }
  }

  const canApply = canFastApplyPatch(session.repoRoot, patch.patchText)
  if (!canApply.ok || !canApply.canApply) {
    const conflicts = loadConflicts(session.repoRoot, session.worktreePath, session.baseSha)
    const resolver = buildConflictResolverRequest({
      taskId,
      sessionId,
      branch: session.branch,
      taskSummary: session.resultText,
      conflicts
    })
    return {
      taskId,
      sessionId,
      branch: session.branch,
      worktreePath: session.worktreePath,
      repoRoot: session.repoRoot,
      status: 'blocked',
      changedFiles: inspect.changedFiles,
      insertions: inspect.insertions,
      deletions: inspect.deletions,
      conflictRisk: inspect.conflictRisk,
      patchSha256: patchSha256(patch.patchText),
      patchPath: patch.path,
      error: resultError(canApply, 'patch 无法干净应用'),
      conflicts,
      resolverPrompt: resolver.prompt
    }
  }

  const apply = applySquashPatch(session.repoRoot, patch.patchText)
  if (!apply.ok) {
    return {
      taskId,
      sessionId,
      branch: session.branch,
      worktreePath: session.worktreePath,
      repoRoot: session.repoRoot,
      status: 'failed',
      changedFiles: inspect.changedFiles,
      insertions: inspect.insertions,
      deletions: inspect.deletions,
      conflictRisk: inspect.conflictRisk,
      patchSha256: patchSha256(patch.patchText),
      patchPath: patch.path,
      error: resultError(apply, '应用 patch 失败')
    }
  }

  input.applied.push({
    entryIndex: input.entryIndex,
    repoRoot: session.repoRoot,
    patchText: patch.patchText
  })
  return {
    taskId,
    sessionId,
    branch: session.branch,
    worktreePath: session.worktreePath,
    repoRoot: session.repoRoot,
    status: apply.applied ? 'merged' : 'skipped',
    changedFiles: apply.changedFiles,
    insertions: inspect.insertions,
    deletions: inspect.deletions,
    conflictRisk: inspect.conflictRisk,
    patchSha256: patchSha256(patch.patchText),
    patchPath: patch.path,
    commitSha: revParseHead(session.worktreePath)
  }
}

function orderedTasks(execution: TaskDagExecutionView): TaskDagExecutionTask[] {
  const byId = new Map(execution.tasks.map((task) => [task.task.id, task]))
  const ordered: TaskDagExecutionTask[] = []
  const seen = new Set<string>()
  for (const layer of execution.layers) {
    for (const taskId of layer) {
      const task = byId.get(taskId)
      if (!task || seen.has(taskId)) continue
      ordered.push(task)
      seen.add(taskId)
    }
  }
  for (const task of execution.tasks) {
    if (seen.has(task.task.id)) continue
    ordered.push(task)
  }
  return ordered
}

function stripRepoRoot(entry: TaskDagAutoMergeEntry & { repoRoot?: string }): TaskDagAutoMergeEntry {
  const { repoRoot: _repoRoot, ...view } = entry
  return view
}

function loadConflicts(repoRoot: string, worktreePath: string, baseSha: string): TaskDagAutoMergeConflict[] {
  const result = getConflictFiles(repoRoot, worktreePath, baseSha)
  if (!result.ok || !result.files) return []
  return result.files.map((file) => ({
    path: file.path,
    base: file.base,
    worktree: file.worktree,
    main: file.main,
    baseMissing: file.baseMissing,
    worktreeMissing: file.worktreeMissing,
    mainMissing: file.mainMissing,
    truncated: file.truncated
  }))
}

function runConfiguredVerification(
  repoRoot: string,
  overrideCommand: string | undefined,
  timeoutMs: number
): TaskDagAutoMergeVerification {
  const command = resolveVerificationCommand(repoRoot, overrideCommand)
  if (!command) return { status: 'skipped', cwd: repoRoot, error: '未在 caogen.md 中找到验收命令' }

  const startedAt = Date.now()
  const shell = process.platform === 'win32'
    ? { command: 'cmd', args: ['/c', command] }
    : { command: '/bin/sh', args: ['-c', command] }
  const result = spawnSync(shell.command, shell.args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024
  })
  const output = capOutput([result.stdout, result.stderr].filter((item): item is string => typeof item === 'string').join('\n'))
  if (result.error) {
    return {
      status: 'failed',
      command,
      cwd: repoRoot,
      exitCode: result.status,
      durationMs: Date.now() - startedAt,
      output,
      error: result.error.message
    }
  }
  return {
    status: result.status === 0 ? 'passed' : 'failed',
    command,
    cwd: repoRoot,
    exitCode: result.status,
    durationMs: Date.now() - startedAt,
    output,
    error: result.status === 0 ? undefined : `验收命令退出码 ${result.status ?? 'null'}`
  }
}

export function resolveVerificationCommand(repoRoot: string, overrideCommand?: string): string | undefined {
  const override = overrideCommand?.trim()
  if (override) return override
  for (const fileName of VERIFY_CONFIG_FILES) {
    const filePath = path.join(repoRoot, fileName)
    if (!existsSync(filePath)) continue
    const content = readFileSync(filePath, 'utf8')
    const command = extractVerificationCommand(content)
    if (command) return command
  }
  return undefined
}

function extractVerificationCommand(content: string): string | undefined {
  const direct = /^\s*(?:[-*]\s*)?(?:验证命令|测试命令|验收命令|verify|test)\s*[:：]\s*`?([^`\r\n]+)`?\s*$/im.exec(content)
  const directCommand = direct?.[1]?.trim()
  if (directCommand) return directCommand

  const heading = /^#{1,6}\s*(?:验证|测试|验收|verify|test)\s*$/im.exec(content)
  if (!heading || heading.index === undefined) return undefined
  const afterHeading = content.slice(heading.index + heading[0].length)
  const fenced = /```(?:bash|sh|powershell|pwsh|cmd)?\s*\r?\n([^\r\n`]+)\r?\n```/i.exec(afterHeading)
  return fenced?.[1]?.trim() || undefined
}

function rollbackAppliedPatches(applied: AppliedPatch[]): TaskDagAutoMergeRollback {
  if (applied.length === 0) return { attempted: false, ok: true }
  for (const patch of [...applied].reverse()) {
    const reverted = reverseSquashPatch(patch.repoRoot, patch.patchText)
    if (!reverted.ok) return { attempted: true, ok: false, error: resultError(reverted, '反向 patch 回滚失败') }
  }
  return { attempted: true, ok: true }
}

function resultError(value: unknown, fallback: string): string {
  if (value && typeof value === 'object' && 'error' in value) {
    const error = (value as { error?: unknown }).error
    if (typeof error === 'string' && error.trim()) return error
  }
  return fallback
}

function summarizeStatus(input: {
  mergedCount: number
  blockedCount: number
  failedCount: number
  rolledBackCount: number
  verification: TaskDagAutoMergeVerification
  rollback?: TaskDagAutoMergeView['rollback']
}): TaskDagAutoMergeView['status'] {
  if (input.rolledBackCount > 0) return 'rolled-back'
  if (input.rollback && !input.rollback.ok) return 'failed'
  if (input.failedCount > 0) return 'failed'
  if (input.blockedCount > 0) return input.mergedCount > 0 ? 'partial' : 'failed'
  if (input.verification.status === 'failed') return 'failed'
  return 'success'
}

function buildSummary(
  mergedCount: number,
  blockedCount: number,
  skippedCount: number,
  failedCount: number,
  rolledBackCount: number,
  verification: TaskDagAutoMergeVerification
): string {
  return [
    `自动合并: ${mergedCount} 已合并`,
    blockedCount > 0 ? `${blockedCount} 阻塞` : '',
    failedCount > 0 ? `${failedCount} 失败` : '',
    skippedCount > 0 ? `${skippedCount} 跳过` : '',
    rolledBackCount > 0 ? `${rolledBackCount} 已回滚` : '',
    `验收: ${verification.status}`
  ]
    .filter(Boolean)
    .join(' / ')
}

function firstError(
  entries: TaskDagAutoMergeEntry[],
  verification: TaskDagAutoMergeVerification,
  rollback?: TaskDagAutoMergeView['rollback']
): string | undefined {
  return entries.find((entry) => entry.error)?.error ?? verification.error ?? rollback?.error
}

function commitWorktreeChanges(worktreePath: string, title: string): { ok: true } | { ok: false; error: string } {
  const mergePathspec = ['--', '.', ...WORKTREE_MERGE_EXCLUDE_PATHSPECS]
  const status = runGit(worktreePath, ['status', '--porcelain', ...mergePathspec])
  if (!status.ok) return { ok: false, error: status.error ?? '无法读取 worktree 状态' }
  if (!status.stdout.trim()) return { ok: true }

  const add = runGit(worktreePath, ['add', '-A', ...mergePathspec])
  if (!add.ok) return { ok: false, error: add.error ?? 'git add 失败' }

  const commit = runGit(worktreePath, [
    '-c',
    'user.name=CaoGen Auto Merge',
    '-c',
    'user.email=caogen-auto-merge@example.invalid',
    'commit',
    '-m',
    `caogen: ${cleanCommitTitle(title)}`
  ])
  if (!commit.ok) return { ok: false, error: commit.error ?? 'git commit 失败' }
  return { ok: true }
}

function revParseHead(worktreePath: string): string | undefined {
  const result = runGit(worktreePath, ['rev-parse', '--verify', 'HEAD'])
  return result.ok ? result.stdout.trim() : undefined
}

function runGit(cwd: string, args: string[]): GitRunResult {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    maxBuffer: 100 * 1024 * 1024
  })
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  if (result.error) {
    return { ok: false, stdout, stderr, status: result.status, error: result.error.message }
  }
  if (result.status !== 0) {
    return {
      ok: false,
      stdout,
      stderr,
      status: result.status,
      error: stderr.trim() || stdout.trim() || `git ${args.join(' ')} failed`
    }
  }
  return { ok: true, stdout, stderr, status: result.status }
}

function patchOutputRoot(): string {
  return path.join(tmpdir(), 'caogen-dag-auto-merge-patches')
}

function cleanCommitTitle(title: string): string {
  const clean = title.replace(/\s+/g, ' ').trim()
  return (clean || 'task changes').slice(0, 72)
}

function capOutput(output: string): string {
  const clean = output.trim()
  return clean.length > MAX_VERIFY_OUTPUT_CHARS ? `${clean.slice(0, MAX_VERIFY_OUTPUT_CHARS)}\n[已截断]` : clean
}
