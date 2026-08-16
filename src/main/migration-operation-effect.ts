import { isAbsolute, resolve } from 'node:path'
import type { EffectTarget } from '../shared/effect-types'
import { readMigrationContract } from './migration-contract'
import {
  confirmed,
  notApplied,
  unresolved,
  type EffectReconciliationResult
} from './task/effect-reconciliation-result'
import { stableValueDigest } from './task/tool-idempotency'

export type MigrationOperationEffectTarget = Extract<EffectTarget, { kind: 'migration_operation' }>
export const MIGRATION_OPERATION_BACKUP_REF = 'caogen-private:migration-backups' as const

let configuredMigrationBackupRoot: string | undefined

export function configureMigrationOperationBackupRoot(root: string): void {
  configuredMigrationBackupRoot = requiredAbsolutePath(root, 'migration backup root')
}

export function isMigrationOperationEffectToolName(
  toolName: string
): toolName is 'migration_apply' | 'migration_rollback' {
  return toolName === 'migration_apply' || toolName === 'migration_rollback'
}

export function buildMigrationOperationEffectTarget(
  toolName: 'migration_apply' | 'migration_rollback',
  input: Record<string, unknown>
): MigrationOperationEffectTarget {
  const backupRef = input.backupRef === MIGRATION_OPERATION_BACKUP_REF
    ? MIGRATION_OPERATION_BACKUP_REF
    : undefined
  const backupRoot = input.backupRoot === undefined
    ? undefined
    : requiredAbsolutePath(input.backupRoot, 'backupRoot')
  if (!backupRef && !backupRoot) throw new Error('migration EffectTarget backup reference is invalid')
  const backupId = requiredId(input.backupId, 'backupId')
  const assetCount = nonNegativeInteger(input.assetCount, 'assetCount')
  const kindCounts = migrationKindCounts(input.kindCounts)
  const selectionDigest = sha256(input.selectionDigest, 'selectionDigest')
  const operation = toolName === 'migration_apply' ? 'apply' : 'rollback'
  if (assetCount !== Object.values(kindCounts).reduce((sum, count) => sum + count, 0)) {
    throw new Error('migration EffectTarget assetCount differs from kindCounts')
  }
  return {
    kind: 'migration_operation',
    operation,
    ...(backupRef ? { backupRef } : {}),
    ...(backupRoot ? { backupRoot } : {}),
    backupId,
    assetCount,
    kindCounts,
    selectionDigest,
    expectedState: operation === 'apply' ? 'committed' : 'rolled_back'
  }
}

export function reconcileMigrationOperationEffectTarget(
  target: MigrationOperationEffectTarget
): EffectReconciliationResult {
  const backupRoot = resolveMigrationOperationBackupRoot(target)
  if (!backupRoot) {
    return unresolved({
      kind: target.kind,
      operation: target.operation,
      backupId: target.backupId,
      backupRef: target.backupRef,
      reason: 'migration private backup Store is not bound in this process'
    })
  }
  let contract
  try {
    contract = readMigrationContract(backupRoot, target.backupId)
  } catch (error) {
    if (error instanceof Error && error.message === 'migration_contract_missing') {
      return notApplied({
        kind: target.kind,
        operation: target.operation,
        backupId: target.backupId,
        state: 'missing'
      }, 'migration contract does not exist, so the operation was not applied')
    }
    return unresolved({
      kind: target.kind,
      operation: target.operation,
      backupId: target.backupId,
      reason: error instanceof Error ? error.message : String(error)
    })
  }
  const observation = {
    kind: target.kind,
    operation: target.operation,
    backupId: target.backupId,
    state: contract.state,
    writesCompleted: contract.writesCompleted,
    targetCount: contract.targets.length,
    contractDigest: stableValueDigest(contract)
  }
  if (contract.backupId !== target.backupId || contract.migrationId !== target.backupId) {
    return unresolved({ ...observation, reason: 'migration contract identity differs from EffectTarget' })
  }
  if (contract.state === target.expectedState) {
    return confirmed(observation, `migration contract reached ${target.expectedState}`)
  }
  if (
    (target.operation === 'apply' && contract.state === 'rolled_back') ||
    (target.operation === 'rollback' && contract.state === 'committed')
  ) {
    return notApplied(observation, `migration contract state ${contract.state} proves the requested result is absent`)
  }
  return unresolved({ ...observation, reason: `migration operation is not terminal:${contract.state}` })
}

function resolveMigrationOperationBackupRoot(target: MigrationOperationEffectTarget): string | undefined {
  if (target.backupRef === MIGRATION_OPERATION_BACKUP_REF) return configuredMigrationBackupRoot
  return target.backupRoot ? requiredAbsolutePath(target.backupRoot, 'backupRoot') : undefined
}

function migrationKindCounts(value: unknown): MigrationOperationEffectTarget['kindCounts'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('migration EffectTarget kindCounts is invalid')
  }
  const record = value as Record<string, unknown>
  const keys = ['rules', 'mcp', 'config', 'skill', 'prompt', 'usage', 'hook', 'memory', 'routine', 'channel'] as const
  if (Object.keys(record).some((key) => !keys.includes(key as typeof keys[number]))) {
    throw new Error('migration EffectTarget kindCounts contains an unsupported key')
  }
  return Object.fromEntries(keys.map((key) => [key, nonNegativeInteger(record[key], `kindCounts.${key}`)])) as
    MigrationOperationEffectTarget['kindCounts']
}

function requiredAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value)) throw new Error(`${label} is invalid`)
  return resolve(value)
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(value)) throw new Error(`${label} is invalid`)
  return value
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} is invalid`)
  return value
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} is invalid`)
  return Number(value)
}
