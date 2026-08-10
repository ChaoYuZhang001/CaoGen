import { createHash } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  MigrationAsset,
  MigrationAssetConflict,
  MigrationAssetRisk,
  MigrationDecisionAction,
  MigrationScan
} from '../shared/types'
import { sanitizeMcpConfig } from './migration-mcp'
import {
  containsSensitiveText,
  directoryContainsSensitiveText,
  readSafeDirectory,
  readSafeFile,
  safeRulePreview,
  sha256,
  targetFingerprint,
  type SafeDirectorySnapshot
} from './migration-safety'
import type { InternalMigrationAsset, JsonObject } from './migration-scan-store'
import { addCcSwitchUsageAsset } from './migration-cc-switch-usage'

type MigrationDiagnostic = MigrationScan['diagnostics'][number]

interface ScanContext {
  home: string
  assets: InternalMigrationAsset[]
  diagnostics: MigrationDiagnostic[]
}

interface McpRow {
  id: string
  name: string
  serverConfig: string
  enabledClaude: boolean
  enabledCodex: boolean
}

interface PromptRow {
  id: string
  appType: string
  name: string
  content: string
  description?: string
  enabled: boolean
}

interface SkillRow {
  id: string
  name: string
  directory: string
  enabledClaude: boolean
  enabledCodex: boolean
  contentHash?: string
}

const MAX_DATABASE_BYTES = 512 * 1024 * 1024
const MAX_TEXT_BYTES = 512 * 1024
const MAX_SKILL_BYTES = 5 * 1024 * 1024
const MAX_SKILL_FILES = 200

export function scanCcSwitchMigrationAssets(context: ScanContext): void {
  const sourceRoot = join(context.home, '.cc-switch')
  const databasePath = join(sourceRoot, 'cc-switch.db')
  if (!existsSync(databasePath)) return
  try {
    withDatabase(databasePath, (database) => {
      for (const row of readMcpRows(database)) addMcpAsset(context, databasePath, row)
      for (const row of readPromptRows(database)) addPromptAsset(context, databasePath, row)
      for (const row of readSkillRows(database)) addSkillAsset(context, databasePath, sourceRoot, row)
      addCcSwitchUsageAsset(context, databasePath, database)
    })
  } catch (error) {
    context.diagnostics.push({ code: publicError(error), message: 'CC Switch 资产扫描失败。' })
  }
}

function addMcpAsset(context: ScanContext, databasePath: string, row: McpRow): void {
  try {
    const displayName = safeDisplayName(row.name, `MCP ${shortHash(row.id)}`)
    const configValue = parseJson(row.serverConfig, 'cc_switch_mcp_config_invalid')
    const sanitized = sanitizeMcpConfig(configValue)
    const targetPath = join(context.home, '.claude', 'settings.json')
    const target = inspectMcpTarget(targetPath, displayName)
    const hasRunnableTarget = typeof sanitized.config.command === 'string' || typeof sanitized.config.url === 'string'
    const enabled = row.enabledClaude || row.enabledCodex
    const blocked = target.blocked || !hasRunnableTarget
    const conflict = blocked ? 'unsupported' : target.conflict
    const importable = !blocked && conflict !== 'duplicate'
    const risk: MigrationAssetRisk = blocked ? 'blocked' : 'review'
    const sourceDigest = digest(row)
    const asset = createAsset({
      id: assetId('mcp', row.id), kind: 'mcp', name: displayName,
      path: `CC Switch / MCP / ${displayName}`, sourceDigest, sizeBytes: Buffer.byteLength(row.serverConfig),
      preview: `${typeof sanitized.config.command === 'string' ? 'stdio' : 'HTTP'} MCP；保留 ${Object.keys(sanitized.config).length} 个安全字段，忽略 ${sanitized.ignoredFields.length} 个凭据或未知字段。`,
      targetPath, conflict, conflictDetail: target.detail, risk,
      riskReasons: [
        '用户级 MCP 会影响所有对话',
        ...(!enabled ? ['该 MCP 在 CC Switch 中未启用'] : []),
        ...(sanitized.ignoredFields.length > 0 ? ['凭据字段不会导入，服务可能需要重新授权'] : []),
        ...(blocked ? ['缺少可安全映射的 command 或 url'] : [])
      ],
      ignoredFields: sanitized.ignoredFields,
      importable,
      recommended: false
    })
    context.assets.push({
      asset,
      sourceRoot: resolve(databasePath, '..'),
      sourcePath: databasePath,
      targetRoot: context.home,
      targetPath,
      targetFingerprint: target.fingerprint,
      mcpServerName: displayName,
      mcpConfig: sanitized.config,
      readSourceDigest: () => readMcpDigest(databasePath, row.id)
    })
  } catch (error) {
    context.diagnostics.push({ code: publicError(error), message: '一个 CC Switch MCP 记录无法安全映射。' })
  }
}

function addPromptAsset(context: ScanContext, databasePath: string, row: PromptRow): void {
  try {
    const displayName = safeDisplayName(row.name, `Prompt ${shortHash(`${row.id}:${row.appType}`)}`)
    const sensitive = containsSensitiveText([row.name, row.description, row.content].filter(Boolean).join('\n'))
    const snapshot = promptSkillSnapshot(row, displayName)
    const targetPath = join(context.home, '.caogen', 'skills', targetSegment('prompt', displayName, row.id))
    const conflict = directoryConflict(targetFingerprint(targetPath), snapshot.digest)
    const blocked = sensitive || conflict === 'unsupported'
    const importable = !blocked && conflict !== 'duplicate'
    const sourceDigest = digest(row)
    const asset = createAsset({
      id: assetId('prompt', `${row.appType}:${row.id}`), kind: 'prompt', name: displayName,
      path: `CC Switch / Prompt / ${displayName}`, sourceDigest, sizeBytes: Buffer.byteLength(row.content),
      preview: sensitive ? 'Prompt 内容疑似包含凭据，预览与导入均已阻止。' : safeRulePreview(row.content, 220),
      targetPath, conflict, risk: blocked ? 'blocked' : 'review',
      riskReasons: [
        'Prompt 将作为 CaoGen 全局 prompt-only Skill 导入',
        ...(!row.enabled ? ['该 Prompt 在 CC Switch 中未启用'] : []),
        ...(sensitive ? ['Prompt 中检测到疑似凭据'] : [])
      ],
      importable,
      recommended: false
    })
    context.assets.push({
      asset,
      sourceRoot: resolve(databasePath, '..'),
      sourcePath: databasePath,
      targetRoot: context.home,
      targetPath,
      targetFingerprint: targetFingerprint(targetPath),
      readSourceDigest: () => readPromptDigest(databasePath, row.id, row.appType),
      ...(blocked ? {} : { sourceDirectorySnapshot: snapshot })
    })
  } catch (error) {
    context.diagnostics.push({ code: publicError(error), message: '一个 CC Switch Prompt 记录无法安全映射。' })
  }
}

function addSkillAsset(context: ScanContext, databasePath: string, sourceRoot: string, row: SkillRow): void {
  try {
    const displayName = safeDisplayName(row.name, `Skill ${shortHash(row.id)}`)
    const sourcePath = resolveSkillPath(sourceRoot, row.directory)
    const snapshot = readCcSwitchSkill(sourceRoot, sourcePath)
    const sensitive = directoryContainsSensitiveText(snapshot) || containsSensitiveText(displayName)
    const targetPath = join(context.home, '.caogen', 'skills', targetSegment('skill', displayName, row.id))
    const conflict = directoryConflict(targetFingerprint(targetPath), snapshot.digest)
    const blocked = sensitive || conflict === 'unsupported'
    const importable = !blocked && conflict !== 'duplicate'
    const enabled = row.enabledClaude || row.enabledCodex
    const sourceDigest = combinedSkillDigest(row, snapshot)
    const asset = createAsset({
      id: assetId('skill', row.id), kind: 'skill', name: displayName,
      path: `CC Switch / Skill / ${displayName}`, sourceDigest, sizeBytes: snapshot.sizeBytes,
      preview: sensitive ? 'Skill 内容疑似包含凭据，预览与导入均已阻止。' : skillPreview(snapshot),
      targetPath, conflict, risk: blocked ? 'blocked' : 'review',
      riskReasons: [
        'Skill 将导入 CaoGen 全局 Skill 根目录',
        ...(!enabled ? ['该 Skill 在 CC Switch 中未启用'] : []),
        ...(sensitive ? ['Skill 中检测到疑似凭据'] : [])
      ],
      importable,
      recommended: false
    })
    context.assets.push({
      asset,
      sourceRoot,
      sourcePath,
      targetRoot: context.home,
      targetPath,
      targetFingerprint: targetFingerprint(targetPath),
      readSourceDigest: () => readSkillDigest(databasePath, sourceRoot, row.id),
      ...(blocked ? {} : { sourceDirectorySnapshot: snapshot })
    })
  } catch (error) {
    context.diagnostics.push({ code: publicError(error), message: '一个 CC Switch Skill 记录无法安全映射。' })
  }
}

function readMcpRows(database: DatabaseSync): McpRow[] {
  return database.prepare(`SELECT id, name, server_config, enabled_claude, enabled_codex FROM mcp_servers ORDER BY id`)
    .all().map((row) => mcpRow(row as Record<string, unknown>))
}

function readPromptRows(database: DatabaseSync): PromptRow[] {
  return database.prepare(`SELECT id, app_type, name, content, description, enabled FROM prompts ORDER BY app_type, id`)
    .all().map((row) => promptRow(row as Record<string, unknown>))
}

function readSkillRows(database: DatabaseSync): SkillRow[] {
  return database.prepare(`SELECT id, name, directory, enabled_claude, enabled_codex, content_hash FROM skills ORDER BY id`)
    .all().map((row) => skillRow(row as Record<string, unknown>))
}

function readMcpDigest(databasePath: string, id: string): string {
  return withDatabase(databasePath, (database) => digest(mcpRow(requiredRow(database, 'SELECT id, name, server_config, enabled_claude, enabled_codex FROM mcp_servers WHERE id = ?', id))))
}

function readPromptDigest(databasePath: string, id: string, appType: string): string {
  return withDatabase(databasePath, (database) => digest(promptRow(requiredRow(database, 'SELECT id, app_type, name, content, description, enabled FROM prompts WHERE id = ? AND app_type = ?', id, appType))))
}

function readSkillDigest(databasePath: string, sourceRoot: string, id: string): string {
  return withDatabase(databasePath, (database) => {
    const row = skillRow(requiredRow(database, 'SELECT id, name, directory, enabled_claude, enabled_codex, content_hash FROM skills WHERE id = ?', id))
    const snapshot = readCcSwitchSkill(sourceRoot, resolveSkillPath(sourceRoot, row.directory))
    return combinedSkillDigest(row, snapshot)
  })
}

function withDatabase<T>(databasePath: string, action: (database: DatabaseSync) => T): T {
  assertDatabase(databasePath)
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    database.exec('PRAGMA query_only = ON')
    return action(database)
  } finally {
    database.close()
  }
}

function requiredRow(database: DatabaseSync, sql: string, ...params: string[]): Record<string, unknown> {
  const row = database.prepare(sql).get(...params) as Record<string, unknown> | undefined
  if (!row) throw new Error('migration_source_changed')
  return row
}

function mcpRow(row: Record<string, unknown>): McpRow {
  return {
    id: requiredText(row.id, 'mcp id'), name: requiredText(row.name, 'mcp name'),
    serverConfig: boundedText(row.server_config, 'mcp config'),
    enabledClaude: Boolean(row.enabled_claude), enabledCodex: Boolean(row.enabled_codex)
  }
}

function promptRow(row: Record<string, unknown>): PromptRow {
  return {
    id: requiredText(row.id, 'prompt id'), appType: requiredText(row.app_type, 'prompt app'),
    name: requiredText(row.name, 'prompt name'), content: boundedText(row.content, 'prompt content'),
    description: optionalText(row.description), enabled: Boolean(row.enabled)
  }
}

function skillRow(row: Record<string, unknown>): SkillRow {
  return {
    id: requiredText(row.id, 'skill id'), name: requiredText(row.name, 'skill name'),
    directory: requiredText(row.directory, 'skill directory'),
    enabledClaude: Boolean(row.enabled_claude), enabledCodex: Boolean(row.enabled_codex),
    contentHash: optionalText(row.content_hash)
  }
}

function promptSkillSnapshot(row: PromptRow, displayName: string): SafeDirectorySnapshot {
  const description = cleanLine(row.description) || `Imported ${row.appType} prompt from CC Switch`
  const markdown = [
    '---',
    `name: ${JSON.stringify(displayName)}`,
    `description: ${JSON.stringify(description)}`,
    `trigger: ${JSON.stringify(displayName)}`,
    `tags: [cc-switch, prompt, ${safeTag(row.appType)}]`,
    'version: 1',
    '---',
    '',
    `# ${displayName}`,
    '',
    row.content.trim(),
    ''
  ].join('\n')
  return directorySnapshot('SKILL.md', Buffer.from(markdown, 'utf8'))
}

function directorySnapshot(relativePath: string, bytes: Buffer): SafeDirectorySnapshot {
  const fileDigest = sha256(bytes)
  const digest = createHash('sha256').update(relativePath).update('\0').update(fileDigest).update('\0').digest('hex')
  return { files: [{ relativePath, bytes, digest: fileDigest, sizeBytes: bytes.length, executable: false }], digest, sizeBytes: bytes.length }
}

function readCcSwitchSkill(sourceRoot: string, sourcePath: string): SafeDirectorySnapshot {
  if (!isInside(sourceRoot, sourcePath)) throw new Error('cc_switch_skill_path_outside_source')
  const snapshot = readSafeDirectory(sourcePath, { maxFiles: MAX_SKILL_FILES, maxBytes: MAX_SKILL_BYTES, maxDepth: 8 })
  if (!snapshot.files.some((file) => file.relativePath.replaceAll('\\', '/') === 'SKILL.md')) {
    throw new Error('cc_switch_skill_manifest_missing')
  }
  return snapshot
}

function resolveSkillPath(sourceRoot: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(sourceRoot, value)
}

function combinedSkillDigest(row: SkillRow, snapshot: SafeDirectorySnapshot): string {
  return digest({ row, snapshotDigest: snapshot.digest })
}

function skillPreview(snapshot: SafeDirectorySnapshot): string {
  const skill = snapshot.files.find((file) => file.relativePath.replaceAll('\\', '/') === 'SKILL.md')
  return safeRulePreview(skill?.bytes.toString('utf8') ?? '', 220)
}

function inspectMcpTarget(targetPath: string, serverName: string): {
  fingerprint: string
  conflict: MigrationAssetConflict
  detail?: string
  blocked: boolean
} {
  try {
    const fingerprint = targetFingerprint(targetPath)
    if (fingerprint === 'missing') return { fingerprint, conflict: 'none', blocked: false }
    if (!fingerprint.startsWith('file:')) return { fingerprint, conflict: 'unsupported', detail: '目标不是普通 JSON 文件', blocked: true }
    const parsed = parseJson(readSafeFile(targetPath, MAX_TEXT_BYTES).bytes.toString('utf8'), 'migration_target_json_invalid')
    const servers = parsed.mcpServers
    if (servers !== undefined && !isObject(servers)) throw new Error('migration_target_mcp_invalid')
    return isObject(servers) && Object.hasOwn(servers, serverName)
      ? { fingerprint, conflict: 'replace_required', detail: '目标已有同名 MCP', blocked: false }
      : { fingerprint, conflict: 'none', blocked: false }
  } catch (error) {
    return { fingerprint: 'unreadable', conflict: 'unsupported', detail: publicError(error), blocked: true }
  }
}

function directoryConflict(fingerprint: string, sourceDigest: string): MigrationAssetConflict {
  if (fingerprint === 'symlink' || fingerprint === 'special' || fingerprint.startsWith('file:')) return 'unsupported'
  if (fingerprint === 'missing') return 'none'
  if (fingerprint === `dir:${sourceDigest}`) return 'duplicate'
  return 'replace_required'
}

function createAsset(input: {
  id: string
  kind: 'mcp' | 'prompt' | 'skill'
  name: string
  path: string
  sourceDigest: string
  sizeBytes: number
  preview: string
  targetPath: string
  conflict: MigrationAssetConflict
  conflictDetail?: string
  risk: MigrationAssetRisk
  riskReasons: string[]
  ignoredFields?: string[]
  importable: boolean
  recommended: boolean
}): MigrationAsset {
  const supportedActions: MigrationDecisionAction[] = input.importable
    ? input.conflict === 'replace_required' ? ['replace', 'skip'] : ['import', 'skip']
    : ['skip']
  return {
    ...input,
    agent: 'CC Switch',
    scope: 'user',
    ignoredFields: [...new Set(input.ignoredFields ?? [])].sort(),
    supportedActions
  }
}

function assertDatabase(databasePath: string): void {
  const info = lstatSync(databasePath)
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_DATABASE_BYTES) {
    throw new Error('cc_switch_database_invalid')
  }
}

function boundedText(value: unknown, field: string): string {
  const text = requiredText(value, field)
  if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new Error('cc_switch_text_too_large')
  return text
}

function requiredText(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`cc_switch_${field.replace(/\s+/g, '_')}_invalid`)
  return text
}

function optionalText(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || undefined
}

function safeDisplayName(value: string, fallback: string): string {
  const clean = cleanLine(value).slice(0, 120)
  return clean && !containsSensitiveText(clean) ? clean : fallback
}

function cleanLine(value: string | undefined): string {
  return value?.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() ?? ''
}

function targetSegment(kind: string, name: string, id: string): string {
  const slug = name.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || kind
  return `cc-switch-${kind}-${slug}-${shortHash(id)}`
}

function safeTag(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24) || 'unknown'
}

function assetId(kind: string, sourceId: string): string {
  return `cc-switch:${kind}:${sha256(sourceId).slice(0, 24)}`
}

function shortHash(value: string): string {
  return sha256(value).slice(0, 8)
}

function digest(value: unknown): string {
  return sha256(JSON.stringify(value))
}

function parseJson(value: string, error: string): JsonObject {
  try {
    const parsed = JSON.parse(value) as unknown
    if (isObject(parsed)) return parsed
  } catch {
    // Public callers receive the stable error below.
  }
  throw new Error(error)
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return /^[a-z0-9_]+$/i.test(message) ? message : 'cc_switch_asset_invalid'
}
