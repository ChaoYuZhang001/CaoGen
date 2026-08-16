import { basename, join, resolve } from 'node:path'
import type {
  MigrationAsset,
  MigrationAssetConflict,
  MigrationAssetKind,
  MigrationAssetRisk,
  MigrationAssetScope,
  MigrationDecisionAction,
  MigrationScan
} from '../shared/types'
import { errorCode, readSafeFile, sha256, targetFingerprint } from './migration-safety'
import type { JsonObject } from './migration-scan-store'

export type MigrationDiagnostic = MigrationScan['diagnostics'][number]

export const MAX_MIGRATION_SOURCE_FILE_BYTES = 512 * 1024
export const MAX_MCP_SERVERS = 100

const MAX_TARGET_FILE_BYTES = 8 * 1024 * 1024
const IMPORT_BEGIN = '<!-- caogen:migration-begin'

export function buildAsset(input: {
  id: string
  agent: string
  kind: MigrationAssetKind
  scope: MigrationAssetScope
  sourcePath: string
  source: { digest: string; sizeBytes: number }
  name?: string
  preview: string
  targetPath?: string
  conflict: MigrationAssetConflict
  conflictDetail?: string
  risk: MigrationAssetRisk
  riskReasons: string[]
  ignoredFields?: string[]
  importable: boolean
  recommended: boolean
}): MigrationAsset {
  const supportedActions: MigrationDecisionAction[] = input.importable
    ? input.conflict === 'replace_required'
      ? ['replace', 'skip']
      : ['import', 'skip']
    : ['skip']
  return {
    id: input.id,
    agent: input.agent,
    kind: input.kind,
    scope: input.scope,
    path: input.sourcePath,
    name: input.name ?? basename(input.sourcePath),
    sourceDigest: input.source.digest,
    sizeBytes: input.source.sizeBytes,
    preview: input.preview,
    ...(input.targetPath ? { targetPath: input.targetPath } : {}),
    conflict: input.conflict,
    ...(input.conflictDetail ? { conflictDetail: input.conflictDetail } : {}),
    ignoredFields: [...new Set(input.ignoredFields ?? [])].sort(),
    risk: input.risk,
    riskReasons: input.riskReasons,
    importable: input.importable,
    recommended: input.recommended,
    supportedActions
  }
}

export function assetId(
  agent: string,
  kind: MigrationAssetKind,
  scope: MigrationAssetScope,
  sourcePath: string,
  entry = ''
): string {
  return `migration-${sha256([agent, kind, scope, resolve(sourcePath), entry].join('\0')).slice(0, 24)}`
}

export function compareAssets(left: MigrationAsset, right: MigrationAsset): number {
  return left.scope.localeCompare(right.scope) || left.agent.localeCompare(right.agent) ||
    left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name)
}

export function migrationTargetRoot(
  scope: MigrationAssetScope,
  cwd: string | undefined,
  home: string
): string {
  return scope === 'project' && cwd ? cwd : home
}

export function ruleTarget(scope: MigrationAssetScope, cwd: string | undefined, home: string): string {
  return scope === 'project' && cwd ? join(cwd, 'CLAUDE.md') : join(home, '.claude', 'CLAUDE.md')
}

export function mcpTarget(scope: MigrationAssetScope, cwd: string | undefined, home: string): string {
  return scope === 'project' && cwd ? join(cwd, '.mcp.json') : join(home, '.claude', 'settings.json')
}

export function skillTargetRoot(scope: MigrationAssetScope, cwd: string | undefined, home: string): string {
  return scope === 'project' && cwd ? join(cwd, '.claude', 'skills') : join(home, '.claude', 'skills')
}

export function inspectRuleTarget(targetPath: string, id: string, digest: string): {
  fingerprint: string
  conflict: MigrationAssetConflict
  detail?: string
  blocked: boolean
} {
  try {
    const fingerprint = targetFingerprint(targetPath)
    if (fingerprint === 'missing') return { fingerprint, conflict: 'none', blocked: false }
    if (!fingerprint.startsWith('file:')) {
      return { fingerprint, conflict: 'unsupported', detail: '目标不是普通文件', blocked: true }
    }
    const text = readSafeFile(targetPath, MAX_TARGET_FILE_BYTES).bytes.toString('utf8')
    if (text.includes(`${IMPORT_BEGIN} id:${id} digest:${digest}`)) {
      return { fingerprint, conflict: 'duplicate', detail: '相同版本已导入', blocked: false }
    }
    if (text.includes(`${IMPORT_BEGIN} id:${id} `)) {
      return { fingerprint, conflict: 'replace_required', detail: '已导入旧版本', blocked: false }
    }
    return { fingerprint, conflict: 'merge', detail: '将追加独立来源区块', blocked: false }
  } catch (error) {
    return { fingerprint: 'unreadable', conflict: 'unsupported', detail: publicMigrationError(error), blocked: true }
  }
}

export function inspectMcpTarget(targetPath: string, serverName: string): {
  fingerprint: string
  conflict: MigrationAssetConflict
  detail?: string
  blocked: boolean
} {
  try {
    const fingerprint = targetFingerprint(targetPath)
    if (fingerprint === 'missing') return { fingerprint, conflict: 'none', blocked: false }
    if (!fingerprint.startsWith('file:')) {
      return { fingerprint, conflict: 'unsupported', detail: '目标不是普通 JSON 文件', blocked: true }
    }
    const parsed = JSON.parse(readSafeFile(targetPath, MAX_TARGET_FILE_BYTES).bytes.toString('utf8')) as unknown
    if (!isObject(parsed)) throw new Error('migration_target_json_invalid')
    const servers = parsed.mcpServers
    if (servers !== undefined && !isObject(servers)) throw new Error('migration_target_mcp_invalid')
    if (isObject(servers) && Object.hasOwn(servers, serverName)) {
      return { fingerprint, conflict: 'replace_required', detail: '目标已有同名 MCP', blocked: false }
    }
    return { fingerprint, conflict: 'none', blocked: false }
  } catch (error) {
    return { fingerprint: 'unreadable', conflict: 'unsupported', detail: publicMigrationError(error), blocked: true }
  }
}

export function skillConflict(fingerprint: string, sourceDigest: string): MigrationAssetConflict {
  if (fingerprint === 'symlink' || fingerprint === 'special') return 'unsupported'
  if (fingerprint === 'missing') return 'none'
  if (fingerprint === `dir:${sourceDigest}`) return 'duplicate'
  return 'replace_required'
}

export function safeSkillTargetName(prefix: string, relativeSkillPath: string): string {
  const source = [prefix, ...relativeSkillPath.split(/[\\/]/)].filter(Boolean).join('--')
  const clean = source.replace(/[^A-Za-z0-9._-]/g, '-').replace(/\.{2,}/g, '-').replace(/^[.-]+/, '')
  if (!clean || clean === '.' || clean === '..') throw new Error('migration_target_name_invalid')
  if (clean.length <= 80) return clean
  return `${clean.slice(0, 63)}-${sha256(source).slice(0, 12)}`
}

export function isSafeMcpServerName(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return value === value.trim()
    && value.length > 0
    && value.length <= 120
    && !/[\u0000-\u001f\u007f]/.test(value)
    && normalized !== '__proto__'
    && normalized !== 'prototype'
    && normalized !== 'constructor'
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function diagnostic(error: unknown, path: string): MigrationDiagnostic {
  return { code: publicMigrationError(error), message: '该来源未扫描或未导入。', path }
}

export function publicMigrationError(error: unknown): string {
  if (error instanceof Error && /^migration_[a-z0-9_]+$/.test(error.message)) return error.message
  const code = errorCode(error)
  if (code === 'ENOENT') return 'migration_path_missing'
  if (code === 'EACCES' || code === 'EPERM') return 'migration_path_unreadable'
  return 'migration_operation_failed'
}
