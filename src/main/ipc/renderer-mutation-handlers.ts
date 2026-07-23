import type { GitCommitResult, WorkspaceHunkResult, WriteTextFileResult } from '../../shared/types'
import { writeTextFile } from '../fileOps'
import { gitCommit } from '../git/git-helper'
import { applyHunk } from '../gitDiff'
import {
  executeGitIndexEffectTarget,
  gitIndexEffectToolNameForIpcChannel,
  type GitIndexEffectInput,
  type GitIndexEffectIpcChannel
} from '../git/git-index-effect'
import { sessionManager } from '../sessionManager'
import {
  executeInteractiveOperationEffect,
  type InteractiveOperationEffectOutcome
} from '../task/operation-effect-gateway'

type OperationGateway = typeof executeInteractiveOperationEffect
type CompletedOutcome<T> = Extract<InteractiveOperationEffectOutcome<T>, { status: 'completed' }>
type IncompleteOutcome<T> = Exclude<InteractiveOperationEffectOutcome<T>, { status: 'completed' }>

export async function executeInteractiveOperationEffectWriteFile(
  id: string,
  relPath: unknown,
  content: unknown,
  runOperation: OperationGateway
) {
  const context = rendererOperationContext(id)
  if (!context) return { ok: false, error: '会话不存在' }
  const safePath = typeof relPath === 'string' ? relPath : ''
  const safeContent = typeof content === 'string' ? content : ''
  const outcome = await runOperation({
    kind: 'file_write',
    title: '保存项目文件',
    sourceSessionId: id,
    projectId: context.projectId,
    cwd: context.cwd,
    toolName: 'write_file',
    toolInput: { path: safePath, content: safeContent },
    execute: (effect) => {
      if (effect.target.kind !== 'file_content') throw new Error('文件写入 EffectTarget 类型不匹配')
      return writeTextFile(context.cwd, safePath, safeContent)
    },
    isSuccess: (result) => result.ok,
    resultSummary: (result) => JSON.stringify(result)
  })
  return outcome.status === 'completed'
    ? completedFileWriteResult(outcome)
    : incompleteOperationResult(outcome)
}

export async function executeInteractiveOperationEffectGitCommit(
  id: string,
  message: unknown,
  runOperation: OperationGateway
) {
  const context = rendererOperationContext(id)
  if (!context) return { ok: false, error: '会话不存在' }
  const safeMessage = typeof message === 'string' ? message : ''
  const outcome = await runOperation({
    kind: 'git_commit',
    title: '提交 Git 改动',
    sourceSessionId: id,
    projectId: context.projectId,
    cwd: context.cwd,
    toolName: 'git_commit',
    toolInput: { message: safeMessage },
    execute: (effect) => {
      if (effect.target.kind !== 'git_commit') throw new Error('Git commit EffectTarget 类型不匹配')
      return safeGitCommit(context.cwd, safeMessage)
    },
    isSuccess: (result) => result.ok,
    resultSummary: (result) => JSON.stringify(result)
  })
  return outcome.status === 'completed'
    ? completedGitCommitResult(outcome)
    : incompleteOperationResult(outcome)
}

export async function executeInteractiveOperationEffectDiscardHunk(
  id: string,
  filePath: unknown,
  hunkPatch: unknown,
  runOperation: OperationGateway
) {
  const context = rendererOperationContext(id)
  if (!context) return { ok: false, error: '会话不存在' }
  const safePath = typeof filePath === 'string' ? filePath : ''
  const safePatch = typeof hunkPatch === 'string' ? hunkPatch : ''
  const outcome = await runOperation({
    kind: 'workspace_hunk_discard',
    title: '丢弃工作区 hunk',
    sourceSessionId: id,
    projectId: context.projectId,
    cwd: context.cwd,
    toolName: 'workspace_discard_hunk',
    toolInput: { filePath: safePath, hunkPatch: safePatch },
    execute: (effect) => {
      if (effect.target.kind !== 'file_content') throw new Error('discard hunk EffectTarget 类型不匹配')
      return applyHunk(context.cwd, safePath, safePatch, { reverse: true })
    },
    isSuccess: (result) => result.ok,
    resultSummary: (result) => JSON.stringify(result)
  })
  return outcome.status === 'completed'
    ? completedWorkspaceHunkResult(outcome)
    : incompleteOperationResult(outcome)
}

export async function executeInteractiveOperationEffectGitIndex(
  id: string,
  channel: GitIndexEffectIpcChannel,
  toolInput: Record<string, unknown>,
  runOperation: OperationGateway
) {
  const context = rendererOperationContext(id)
  if (!context) return { ok: false, error: '会话不存在' }
  const toolName = gitIndexEffectToolNameForIpcChannel(channel)
  const effectInput: GitIndexEffectInput = { toolName, cwd: context.cwd, toolInput }
  const outcome = await runOperation({
    kind: 'git_index_update',
    title: gitIndexOperationTitle(channel),
    sourceSessionId: id,
    projectId: context.projectId,
    cwd: context.cwd,
    toolName,
    toolInput,
    execute: (effect) => {
      if (effect.target.kind !== 'git_index_update') throw new Error('Git index EffectTarget 类型不匹配')
      return executeGitIndexEffectTarget(effect.target, effectInput)
    },
    isSuccess: (result) => result.ok,
    resultSummary: (result) => JSON.stringify(result)
  })
  return outcome.status === 'completed'
    ? completedGitIndexResult(outcome)
    : incompleteOperationResult(outcome)
}

function rendererOperationContext(id: string): { cwd: string; projectId?: string } | undefined {
  const session = sessionManager.get(id)
  return session?.meta.cwd ? { cwd: session.meta.cwd, projectId: session.meta.projectId } : undefined
}

function safeGitCommit(cwd: string, message: string): GitCommitResult {
  const result = gitCommit(cwd, message)
  return result.ok ? { ok: true, sha: result.sha } : { ok: false, error: result.error }
}

function completedFileWriteResult(outcome: CompletedOutcome<WriteTextFileResult>) {
  if (outcome.value?.ok) {
    return { ...outcome.value, effectStatus: outcome.effectStatus, operationId: outcome.operationId }
  }
  const target = outcome.effect.target
  if (target.kind !== 'file_content') {
    return { ok: false, error: '文件写入已确认，但 EffectTarget 类型不匹配' }
  }
  return {
    ok: true,
    path: target.relativePath,
    bytes: target.expectedBytes,
    effectStatus: outcome.effectStatus,
    operationId: outcome.operationId
  }
}

function completedGitCommitResult(outcome: CompletedOutcome<GitCommitResult>) {
  if (outcome.value?.ok) {
    return { ...outcome.value, effectStatus: outcome.effectStatus, operationId: outcome.operationId }
  }
  return {
    ok: false,
    error: 'Git commit 已通过 Effect 对账确认，但执行结果未返回 commit SHA；请刷新 Git 状态核对',
    effectStatus: outcome.effectStatus,
    operationId: outcome.operationId
  }
}

function completedGitIndexResult(
  outcome: CompletedOutcome<ReturnType<typeof executeGitIndexEffectTarget>>
) {
  return {
    ok: true,
    effectStatus: outcome.effectStatus,
    operationId: outcome.operationId
  }
}

function completedWorkspaceHunkResult(outcome: CompletedOutcome<WorkspaceHunkResult>) {
  return {
    ok: true,
    effectStatus: outcome.effectStatus,
    operationId: outcome.operationId
  }
}

function gitIndexOperationTitle(channel: GitIndexEffectIpcChannel): string {
  if (channel === 'git:stage') return '暂存所选 Git 文件'
  if (channel === 'git:stageAll') return '暂存全部 Git 改动'
  if (channel === 'git:unstage') return '取消暂存所选 Git 文件'
  return '暂存所选 Git hunk'
}

function incompleteOperationResult<T>(outcome: IncompleteOutcome<T>) {
  return {
    ok: false,
    error: outcome.error,
    effectStatus: outcome.effectStatus,
    operationId: outcome.operationId,
    ...(outcome.status === 'waiting_reconciliation' ? { snapshotId: outcome.snapshotId } : {})
  }
}
