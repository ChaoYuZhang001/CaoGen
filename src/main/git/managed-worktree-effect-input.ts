import type { ManagedWorktreeProjectionRecord } from '../../shared/types'

export interface ManagedWorktreePlanInput {
  sessionId: string
  sourceCwd: string
  worktreePath: string
  branch: string
  baseSha: string
  baseBranch: string | null
  registryRecord: Readonly<ManagedWorktreeProjectionRecord>
}

export function parseManagedWorktreePlanInput(
  toolInput: Record<string, unknown>
): ManagedWorktreePlanInput {
  const common = {
    sessionId: requiredText(toolInput.sessionId, 'sessionId'),
    sourceCwd: requiredText(toolInput.sourceCwd, 'sourceCwd'),
    worktreePath: requiredText(toolInput.worktreePath, 'worktreePath'),
    branch: requiredText(toolInput.branch, 'branch'),
    baseSha: requiredSha(toolInput.baseSha, 'baseSha'),
    baseBranch: nullableText(toolInput.baseBranch, 'baseBranch'),
    registryRecord: requiredRegistryRecord(toolInput.registryRecord)
  }
  assertRegistryRecordMatchesInput(common)
  return common
}

export function assertExactManagedWorktreeInput(
  toolInput: Record<string, unknown>,
  allowed: readonly string[]
): void {
  const expected = new Set(allowed)
  for (const key of Object.keys(toolInput)) {
    if (!expected.has(key)) throw new Error(`managed worktree effect 不接受 toolInput 字段:${key}`)
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(toolInput, key)) {
      throw new Error(`managed worktree effect 缺少 toolInput 字段:${key}`)
    }
  }
}

export function requiredManagedWorktreeBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} 必须是布尔值`)
  return value
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`${name} 必须是非空字符串且不含 NUL`)
  }
  return value.trim()
}

function requiredSha(value: unknown, name: string): string {
  const text = requiredText(value, name)
  if (!/^[0-9a-f]{40,64}$/i.test(text)) throw new Error(`${name} 必须是完整 Git object id`)
  return text.toLowerCase()
}

function nullableText(value: unknown, name: string): string | null {
  if (value === null) return null
  return requiredText(value, name)
}

function requiredRegistryRecord(value: unknown): Readonly<ManagedWorktreeProjectionRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('registryRecord 必须是对象')
  }
  const record = value as Record<string, unknown>
  const state = record.state
  if (state !== 'active' && state !== 'removed') throw new Error('registryRecord.state 无效')
  const createdAt = requiredTimestamp(record.createdAt, 'registryRecord.createdAt')
  const updatedAt = requiredTimestamp(record.updatedAt, 'registryRecord.updatedAt')
  if (updatedAt < createdAt) throw new Error('registryRecord.updatedAt 不能早于 createdAt')
  return Object.freeze({
    sessionId: requiredText(record.sessionId, 'registryRecord.sessionId'),
    repoRoot: requiredText(record.repoRoot, 'registryRecord.repoRoot'),
    sourceCwd: requiredText(record.sourceCwd, 'registryRecord.sourceCwd'),
    worktreePath: requiredText(record.worktreePath, 'registryRecord.worktreePath'),
    cwd: requiredText(record.cwd, 'registryRecord.cwd'),
    branch: requiredText(record.branch, 'registryRecord.branch'),
    baseSha: requiredSha(record.baseSha, 'registryRecord.baseSha'),
    baseBranch: nullableText(record.baseBranch, 'registryRecord.baseBranch'),
    state,
    createdAt,
    updatedAt
  })
}

function requiredTimestamp(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} 必须是非负有限数`)
  }
  return value
}

function assertRegistryRecordMatchesInput(common: ManagedWorktreePlanInput): void {
  const record = common.registryRecord
  if (
    record.sessionId !== common.sessionId ||
    record.sourceCwd !== common.sourceCwd ||
    record.worktreePath !== common.worktreePath ||
    record.branch !== common.branch ||
    record.baseSha !== common.baseSha ||
    record.baseBranch !== common.baseBranch
  ) {
    throw new Error('registryRecord 与 managed worktree 输入身份不一致')
  }
}
