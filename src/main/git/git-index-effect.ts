import type { GitOperationResult } from '../../shared/types'
import {
  confirmed,
  notApplied,
  unresolved,
  type EffectReconciliationResult
} from '../task/effect-reconciliation-result'
import {
  assertGitIndexUpdateTargetInput,
  buildGitIndexUpdateTarget,
  executeGitIndexUpdateTarget,
  indexFileStateMatchesTarget,
  observeGitIndexUpdateTarget,
  type GitIndexBuildRequest,
  type GitIndexOperation,
  type GitIndexUpdateTarget
} from './git-index-state'

export const IPC_GIT_INDEX_EFFECT_TOOL_NAMES = {
  'git:stage': 'git_stage',
  'git:stageAll': 'git_stage_all',
  'git:unstage': 'git_unstage',
  'workspace:applyHunk': 'workspace_apply_hunk'
} as const

export type GitIndexEffectIpcChannel = keyof typeof IPC_GIT_INDEX_EFFECT_TOOL_NAMES
export type GitIndexEffectToolName = (typeof IPC_GIT_INDEX_EFFECT_TOOL_NAMES)[GitIndexEffectIpcChannel]

export interface GitIndexEffectInput {
  toolName: string
  cwd: string
  toolInput: Record<string, unknown>
}

const GIT_INDEX_OPERATIONS: Record<GitIndexEffectToolName, GitIndexOperation> = {
  git_stage: 'stage_paths',
  git_stage_all: 'stage_all',
  git_unstage: 'unstage_paths',
  workspace_apply_hunk: 'apply_cached_hunk'
}

export function isGitIndexEffectToolName(toolName: string): toolName is GitIndexEffectToolName {
  return Object.prototype.hasOwnProperty.call(GIT_INDEX_OPERATIONS, toolName)
}

export function gitIndexEffectToolNameForIpcChannel(
  channel: GitIndexEffectIpcChannel
): GitIndexEffectToolName {
  return IPC_GIT_INDEX_EFFECT_TOOL_NAMES[channel]
}

export function normalizeGitIndexEffectRequest(input: GitIndexEffectInput): GitIndexBuildRequest {
  if (!isGitIndexEffectToolName(input.toolName)) {
    throw new Error(`不支持的 Git index Effect toolName:${input.toolName}`)
  }
  const operation = GIT_INDEX_OPERATIONS[input.toolName]
  const base = { cwd: input.cwd, operation }
  if (operation === 'stage_paths' || operation === 'unstage_paths') {
    return { ...base, paths: input.toolInput.paths }
  }
  if (operation === 'apply_cached_hunk') {
    return {
      ...base,
      filePath: input.toolInput.filePath,
      patch: input.toolInput.hunkPatch
    }
  }
  return base
}

export function buildGitIndexEffectTarget(input: GitIndexEffectInput): GitIndexUpdateTarget {
  return buildGitIndexUpdateTarget(normalizeGitIndexEffectRequest(input))
}

export function executeGitIndexEffectTarget(
  target: GitIndexUpdateTarget,
  input: GitIndexEffectInput
): GitOperationResult {
  try {
    const request = normalizeGitIndexEffectRequest(input)
    assertGitIndexUpdateTargetInput(target, request)
    return executeGitIndexUpdateTarget(target, request.patch)
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

export function reconcileGitIndexEffectTarget(
  target: GitIndexUpdateTarget
): EffectReconciliationResult {
  const observation = observeGitIndexUpdateTarget(target)
  const payload = {
    kind: target.kind,
    operation: target.operation,
    repoRoot: target.repoRoot,
    indexPath: target.indexPath,
    preIndexEntriesDigest: target.preIndexEntriesDigest,
    expectedIndexEntriesDigest: target.expectedIndexEntriesDigest,
    observation
  }

  if (observation.error) {
    return unresolved({ ...payload, reason: `Git index 只读观察失败:${observation.error}` })
  }
  if (!observation.identityMatches) {
    return unresolved({ ...payload, reason: 'Git index 仓库、Git 元数据或 object directory 身份已变化' })
  }
  if (!observation.headMatches) {
    return unresolved({ ...payload, reason: 'Git HEAD 或 worktree 分支身份已变化' })
  }
  if (observation.entriesDigest === target.expectedIndexEntriesDigest) {
    return confirmed(payload, 'Git index entries 与冻结预期摘要完全一致')
  }
  if (observation.entriesDigest !== target.preIndexEntriesDigest) {
    return unresolved({ ...payload, reason: 'Git index entries 既不是执行前状态，也不是冻结预期状态' })
  }
  if (!observation.indexState) {
    return unresolved({ ...payload, reason: 'Git index 原始文件状态无法观察' })
  }
  if (indexFileStateMatchesTarget(observation.indexState, target)) {
    return notApplied(payload, 'Git index entries 与原始文件身份、摘要和大小均保持执行前状态')
  }
  return unresolved({
    ...payload,
    reason: 'Git index entries 仍为执行前语义状态，但原始 index 文件身份或内容已变化'
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
