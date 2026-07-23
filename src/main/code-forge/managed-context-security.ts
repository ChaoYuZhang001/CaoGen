import path from 'node:path'
import {
  inspectManagedWorktreeIdentity,
  inspectManagedWorktreeRegistryRecord,
  type ManagedWorktreeRecord
} from '../managed-worktree-lifecycle'

export interface CodeForgeManagedContextLike {
  sessionId?: string
  repoRoot?: string
  sourceCwd?: string
  worktreePath?: string
  branch?: string
  baseBranch?: string | null
  baseSha?: string
}

interface ManagedWorktreeSelectors {
  sessionId: string
  repoRoot: string
  worktreePath: string
  baseSha: string
}

export function trustedCodeForgeManagedWorktree(
  context: CodeForgeManagedContextLike | undefined
): ManagedWorktreeRecord | undefined {
  const selectors = managedWorktreeSelectors(context)
  if (!selectors) return undefined
  const record = activeManagedWorktreeRecord(selectors.sessionId)
  assertManagedWorktreeContextMatches(record, context, selectors)
  assertManagedWorktreeIdentityIsValid(record)
  return record
}

function managedWorktreeSelectors(
  context: CodeForgeManagedContextLike | undefined
): ManagedWorktreeSelectors | undefined {
  const repoRoot = cleanString(context?.repoRoot)
  const worktreePath = cleanString(context?.worktreePath)
  const baseSha = cleanString(context?.baseSha)
  const hasManagedSelector = [repoRoot, worktreePath, baseSha].some(Boolean)
  if (!hasManagedSelector) return undefined
  if (!repoRoot || !worktreePath || !baseSha) {
    throw new Error('managed worktree Code Forge 上下文必须同时包含 repoRoot、worktreePath 与 baseSha')
  }
  const sessionId = cleanString(context?.sessionId)
  if (!sessionId) throw new Error('managed worktree Code Forge 上下文缺少 sessionId')
  return { sessionId, repoRoot, worktreePath, baseSha }
}

function activeManagedWorktreeRecord(sessionId: string): ManagedWorktreeRecord {
  const lookup = inspectManagedWorktreeRegistryRecord(sessionId)
  if ('error' in lookup) throw new Error(`managed worktree registry 无法查询:${lookup.error}`)
  const record = lookup.record
  if (!record || record.state !== 'active') {
    throw new Error('Code Forge 只接受 registry 中 active 的 managed worktree')
  }
  return record
}

function assertManagedWorktreeContextMatches(
  record: ManagedWorktreeRecord,
  context: CodeForgeManagedContextLike | undefined,
  selectors: ManagedWorktreeSelectors
): void {
  if (path.resolve(selectors.repoRoot) !== path.resolve(record.repoRoot)) throw managedContextMismatch()
  if (path.resolve(selectors.worktreePath) !== path.resolve(record.worktreePath)) throw managedContextMismatch()
  if (selectors.baseSha !== record.baseSha) throw managedContextMismatch()
  if (context?.sourceCwd !== undefined && path.resolve(context.sourceCwd) !== path.resolve(record.sourceCwd)) {
    throw managedContextMismatch()
  }
  if (context?.branch !== undefined && context.branch !== record.branch) throw managedContextMismatch()
  if (context?.baseBranch !== undefined && context.baseBranch !== record.baseBranch) throw managedContextMismatch()
}

function assertManagedWorktreeIdentityIsValid(record: ManagedWorktreeRecord): void {
  const identity = inspectManagedWorktreeIdentity(record)
  if ('error' in identity) throw new Error(`Code Forge managed worktree 身份校验失败:${identity.error}`)
}

function managedContextMismatch(): Error {
  return new Error('Code Forge managed worktree 上下文与 registry 冻结记录不一致')
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
