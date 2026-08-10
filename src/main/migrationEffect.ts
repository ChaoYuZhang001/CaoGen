import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { EffectRecord, MigrationAsset, MigrationImportOperationResult } from '../shared/types'
import { importAssets, scanMigration } from './migration'
import {
  executeInteractiveOperationEffect,
  type InteractiveOperationEffectOutcome
} from './task/operation-effect-gateway'
import { stableValueDigest } from './task/tool-idempotency'

type OperationGateway = typeof executeInteractiveOperationEffect
type MigrationImporter = typeof importAssets

export async function executeMigrationImportEffect(
  cwd: unknown,
  paths: unknown,
  runOperation: OperationGateway = executeInteractiveOperationEffect,
  runImport: MigrationImporter = importAssets
): Promise<MigrationImportOperationResult> {
  const root = migrationRoot(cwd)
  const selected = selectedMigrationAssets(root, paths)
  if (selected.length === 0) return { ok: true, summary: '未选择任何资产' }

  const kindCounts = migrationKindCounts(selected)
  const outcome = await runOperation({
    kind: 'migration_import',
    title: '导入外部 Agent 资产',
    sourceSessionId: migrationSourceId(root),
    cwd: root,
    toolName: 'migration_import',
    toolInput: {
      assetCount: selected.length,
      kindCounts,
      selectionDigest: stableValueDigest(selected.map(safeAssetIdentity))
    },
    execute: (effect) => executeOpaqueMigration(effect, root, selected, runImport),
    isSuccess: () => true,
    resultSummary: () => JSON.stringify({ assetCount: selected.length, kindCounts })
  })
  return migrationEffectOutcome(outcome)
}

function migrationRoot(cwd: unknown): string {
  if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('必须指定项目目录')
  const root = resolve(cwd)
  if (!statSync(root).isDirectory()) throw new Error('迁移目标必须是项目目录')
  return root
}

function selectedMigrationAssets(root: string, paths: unknown): MigrationAsset[] {
  if (!Array.isArray(paths)) return []
  const requested = new Set(paths.filter((item): item is string => typeof item === 'string'))
  return scanMigration(root).assets.filter((asset) => requested.has(asset.path))
}

function safeAssetIdentity(asset: MigrationAsset): Record<string, string> {
  return {
    agent: asset.agent,
    kind: asset.kind,
    pathDigest: stableValueDigest(asset.path)
  }
}

function migrationKindCounts(assets: MigrationAsset[]): Record<MigrationAsset['kind'], number> {
  const counts: Record<MigrationAsset['kind'], number> = {
    rules: 0,
    mcp: 0,
    config: 0,
    skill: 0,
    prompt: 0,
    usage: 0,
    hook: 0
  }
  for (const asset of assets) counts[asset.kind] += 1
  return counts
}

function executeOpaqueMigration(
  effect: EffectRecord,
  root: string,
  selected: MigrationAsset[],
  runImport: MigrationImporter
): string {
  assertOpaqueMigrationEffect(effect)
  try {
    return runImport(root, selected.map((asset) => asset.path))
  } catch {
    throw new Error('迁移导入执行失败')
  }
}

function assertOpaqueMigrationEffect(effect: EffectRecord): void {
  if (effect.target.kind !== 'unsupported' || effect.target.toolName !== 'migration_import') {
    throw new Error('迁移导入必须保持 opaque 并与工具名绑定')
  }
}

function migrationEffectOutcome(
  outcome: InteractiveOperationEffectOutcome<string>
): MigrationImportOperationResult {
  if (outcome.status === 'completed' && outcome.value !== undefined) {
    return {
      ok: true,
      summary: outcome.value,
      effectStatus: outcome.effectStatus,
      operationId: outcome.operationId
    }
  }
  if (outcome.status === 'waiting_reconciliation') {
    return {
      ok: false,
      error: '迁移导入结果未知，请在恢复面板完成对账',
      effectStatus: outcome.effectStatus,
      operationId: outcome.operationId,
      snapshotId: outcome.snapshotId
    }
  }
  return {
    ok: false,
    error: outcome.status === 'failed' ? outcome.error : '迁移导入效果已确认，但执行结果缺失',
    effectStatus: outcome.effectStatus,
    operationId: outcome.operationId
  }
}

function migrationSourceId(root: string): string {
  return `migration:${createHash('sha256').update(root).digest('hex').slice(0, 40)}`
}
