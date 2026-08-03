import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parse as parseToml } from '@iarna/toml'
import type {
  MigrationAsset,
  MigrationAssetConflict,
  MigrationAssetKind,
  MigrationAssetRisk,
  MigrationAssetScope,
  MigrationDecisionAction,
  MigrationScan
} from '../shared/types'
import {
  assertNoSymlinkWithin,
  containsSensitiveText,
  directoryContainsSensitiveText,
  errorCode,
  readSafeDirectory,
  readSafeFile,
  safeRulePreview,
  sha256,
  targetFingerprint
} from './migration-safety'
import { sanitizeMcpConfig } from './migration-mcp'
import {
  storeMigrationScan,
  type InternalMigrationAsset,
  type JsonObject
} from './migration-scan-store'
import { applyMigration as applyMigrationSelection } from './migration-apply'

type MigrationDiagnostic = MigrationScan['diagnostics'][number]

interface SkillScanContext {
  agent: string
  scope: MigrationAssetScope
  sourceRoot: string
  cwd: string | undefined
  home: string
  assets: InternalMigrationAsset[]
  diagnostics: MigrationDiagnostic[]
}

const MAX_SOURCE_FILE_BYTES = 512 * 1024
const MAX_TARGET_FILE_BYTES = 8 * 1024 * 1024
const MAX_SKILL_BYTES = 5 * 1024 * 1024
const MAX_SKILL_FILES = 200

const IMPORT_BEGIN = '<!-- caogen:migration-begin'

export { applyMigration, defaultMigrationBackupRoot, rollbackMigration } from './migration-apply'
export type { MigrationApplyOptions } from './migration-apply'

export function scanMigration(cwdInput?: string, homeDirectory = homedir()): MigrationScan {
  const home = resolve(homeDirectory)
  const cwd = normalizeProjectDirectory(cwdInput)
  const diagnostics: MigrationDiagnostic[] = []
  const internalAssets: InternalMigrationAsset[] = []

  if (cwd) scanProjectSources(cwd, home, internalAssets, diagnostics)
  scanUserSources(cwd, home, internalAssets, diagnostics)

  const nativeAssetCount = countNativeClaudeAssets(cwd, home)
  const scanId = randomUUID()
  const result: MigrationScan = {
    scanId,
    ...(cwd ? { cwd } : {}),
    mode: cwd ? 'project' : 'conversation',
    scannedAt: new Date().toISOString(),
    assets: internalAssets.map(({ asset }) => asset).sort(compareAssets),
    claudeNative: nativeAssetCount > 0,
    nativeAssetCount,
    diagnostics
  }
  storeMigrationScan(result, internalAssets)
  return result
}

/** Compatibility bridge for the legacy path-selection UI; replacement still requires the new decision flow. */
export function importAssets(cwd: string, paths: string[]): string {
  const requested = new Set(paths)
  const scan = scanMigration(cwd)
  const decisions = scan.assets
    .filter((asset) => requested.has(asset.path))
    .map((asset) => ({
      assetId: asset.id,
      action: asset.importable && asset.supportedActions.includes('import')
        ? 'import' as const
        : 'skip' as const
    }))
  const result = applyMigrationSelection({ scanId: scan.scanId, decisions })
  if (!result.ok) throw new Error(result.errorCode ?? 'migration_operation_failed')
  return result.message
}

function scanProjectSources(
  cwd: string,
  home: string,
  assets: InternalMigrationAsset[],
  diagnostics: MigrationDiagnostic[]
): void {
  const ruleFiles: Array<[string, string]> = [
    ['Cursor', join(cwd, '.cursorrules')],
    ['Windsurf', join(cwd, '.windsurfrules')],
    ['Cline', join(cwd, '.clinerules')],
    ['Roo Code', join(cwd, '.roorules')],
    ['Codex', join(cwd, 'AGENTS.md')],
    ['Gemini CLI', join(cwd, 'GEMINI.md')],
    ['GitHub Copilot', join(cwd, '.github', 'copilot-instructions.md')],
    ['Aider', join(cwd, 'CONVENTIONS.md')]
  ]
  for (const [agent, sourcePath] of ruleFiles) {
    addRuleAsset(agent, 'project', sourcePath, cwd, cwd, home, assets, diagnostics)
  }
  for (const [agent, directory] of [
    ['Cursor', join(cwd, '.cursor', 'rules')],
    ['Windsurf', join(cwd, '.windsurf', 'rules')],
    ['Cline', join(cwd, '.clinerules.d')],
    ['Roo Code', join(cwd, '.roo', 'rules')],
    ['GitHub Copilot', join(cwd, '.github', 'instructions')],
    ['Continue', join(cwd, '.continue', 'rules')]
  ] as Array<[string, string]>) {
    addRuleDirectory(agent, 'project', directory, cwd, cwd, home, assets, diagnostics)
  }

  for (const [agent, sourcePath] of [
    ['Cursor', join(cwd, '.cursor', 'mcp.json')],
    ['Windsurf', join(cwd, '.windsurf', 'mcp.json')],
    ['Cline', join(cwd, '.cline', 'mcp.json')],
    ['Roo Code', join(cwd, '.roo', 'mcp.json')]
  ] as Array<[string, string]>) {
    addJsonMcpAssets(agent, 'project', sourcePath, cwd, cwd, home, assets, diagnostics)
  }

  addBlockedConfigAsset('Aider', 'project', join(cwd, '.aider.conf.yml'), cwd, assets, diagnostics)
  addSkillRoot('Codex', 'project', join(cwd, '.codex', 'skills'), cwd, cwd, home, assets, diagnostics)
}

function scanUserSources(
  cwd: string | undefined,
  home: string,
  assets: InternalMigrationAsset[],
  diagnostics: MigrationDiagnostic[]
): void {
  addRuleAsset('Codex', 'user', join(home, '.codex', 'AGENTS.md'), home, cwd, home, assets, diagnostics)
  addRuleAsset('Gemini CLI', 'user', join(home, '.gemini', 'GEMINI.md'), home, cwd, home, assets, diagnostics)
  addBlockedConfigAsset('Aider', 'user', join(home, '.aider.conf.yml'), home, assets, diagnostics)
  addBlockedConfigAsset('Continue', 'user', join(home, '.continue', 'config.yaml'), home, assets, diagnostics)
  addBlockedConfigAsset('Continue', 'user', join(home, '.continue', 'config.json'), home, assets, diagnostics)

  addCodexConfigAssets(join(home, '.codex', 'config.toml'), home, cwd, home, assets, diagnostics)
  addJsonMcpAssets('Cursor', 'user', join(home, '.cursor', 'mcp.json'), home, cwd, home, assets, diagnostics)
  addJsonMcpAssets(
    'Cline',
    'user',
    join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
    home,
    cwd,
    home,
    assets,
    diagnostics
  )
  addSkillRoot('Codex', 'user', join(home, '.codex', 'skills'), home, cwd, home, assets, diagnostics)
}

function addRuleDirectory(
  agent: string,
  scope: MigrationAssetScope,
  directory: string,
  sourceRoot: string,
  cwd: string | undefined,
  home: string,
  assets: InternalMigrationAsset[],
  diagnostics: MigrationDiagnostic[]
): void {
  if (!existsSync(directory)) return
  try {
    assertNoSymlinkWithin(sourceRoot, directory)
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('migration_source_not_directory')
    for (const entry of readdirSync(directory, { withFileTypes: true, encoding: 'utf8' }).slice(0, 50)) {
      if (!entry.name.startsWith('.') && entry.isFile()) {
        addRuleAsset(agent, scope, join(directory, entry.name), sourceRoot, cwd, home, assets, diagnostics)
      }
    }
  } catch (error) {
    diagnostics.push(diagnostic(error, directory))
  }
}

function addRuleAsset(
  agent: string,
  scope: MigrationAssetScope,
  sourcePath: string,
  sourceRoot: string,
  cwd: string | undefined,
  home: string,
  assets: InternalMigrationAsset[],
  diagnostics: MigrationDiagnostic[]
): void {
  if (!existsSync(sourcePath)) return
  try {
    assertNoSymlinkWithin(sourceRoot, sourcePath)
    const source = readSafeFile(sourcePath, MAX_SOURCE_FILE_BYTES)
    const text = source.bytes.toString('utf8')
    const targetPath = ruleTarget(scope, cwd, home)
    const id = assetId(agent, 'rules', scope, sourcePath)
    const sensitive = containsSensitiveText(text)
    const target = inspectRuleTarget(targetPath, id, source.digest)
    const risk = sensitive ? 'blocked' : scope === 'user' ? 'review' : target.blocked ? 'blocked' : 'low'
    const conflict = target.blocked ? 'unsupported' : target.conflict
    const importable = !sensitive && !target.blocked && conflict !== 'duplicate'
    const asset = buildAsset({
      id,
      agent,
      kind: 'rules',
      scope,
      sourcePath,
      source,
      preview: safeRulePreview(text),
      targetPath,
      conflict,
      conflictDetail: target.detail,
      risk,
      riskReasons: [
        ...(sensitive ? ['检测到疑似凭据,禁止导入'] : []),
        ...(scope === 'user' ? ['用户级规则会影响所有对话'] : []),
        ...(target.blocked ? ['目标文件不可安全修改'] : [])
      ],
      importable,
      recommended: importable && risk === 'low' && (conflict === 'none' || conflict === 'merge')
    })
    assets.push({
      asset,
      sourceRoot,
      sourcePath,
      targetRoot: migrationTargetRoot(scope, cwd, home),
      targetPath,
      targetFingerprint: target.fingerprint
    })
  } catch (error) {
    diagnostics.push(diagnostic(error, sourcePath))
  }
}

function addBlockedConfigAsset(
  agent: string,
  scope: MigrationAssetScope,
  sourcePath: string,
  sourceRoot: string,
  assets: InternalMigrationAsset[],
  diagnostics: MigrationDiagnostic[]
): void {
  if (!existsSync(sourcePath)) return
  try {
    assertNoSymlinkWithin(sourceRoot, sourcePath)
    const source = readSafeFile(sourcePath, MAX_SOURCE_FILE_BYTES)
    assets.push({
      asset: buildAsset({
        id: assetId(agent, 'config', scope, sourcePath),
        agent,
        kind: 'config',
        scope,
        sourcePath,
        source,
        preview: '检测到配置文件;模型、Provider 和凭据字段不会自动复制。',
        conflict: 'unsupported',
        risk: 'blocked',
        riskReasons: ['通用配置语义不能安全映射'],
        ignoredFields: ['entire_config'],
        importable: false,
        recommended: false
      }),
      sourceRoot,
      sourcePath
    })
  } catch (error) {
    diagnostics.push(diagnostic(error, sourcePath))
  }
}

function addCodexConfigAssets(
  sourcePath: string,
  sourceRoot: string,
  cwd: string | undefined,
  home: string,
  assets: InternalMigrationAsset[],
  diagnostics: MigrationDiagnostic[]
): void {
  if (!existsSync(sourcePath)) return
  try {
    assertNoSymlinkWithin(sourceRoot, sourcePath)
    const source = readSafeFile(sourcePath, MAX_SOURCE_FILE_BYTES)
    const parsed = parseToml(source.bytes.toString('utf8')) as JsonObject
    const topLevelIgnored = Object.keys(parsed).filter((key) => key !== 'mcp_servers' && key !== 'notify')
    assets.push({
      asset: buildAsset({
        id: assetId('Codex', 'config', 'user', sourcePath),
        agent: 'Codex',
        kind: 'config',
        scope: 'user',
        sourcePath,
        source,
        preview: 'Codex 配置已结构化读取;Provider、模型、认证与运行策略保持不变。',
        conflict: 'unsupported',
        risk: 'blocked',
        riskReasons: ['只迁移可安全映射的 MCP 与 Skill'],
        ignoredFields: topLevelIgnored.length > 0 ? topLevelIgnored.map((key) => `config.${key}`) : ['non_mcp_config'],
        importable: false,
        recommended: false
      }),
      sourceRoot,
      sourcePath
    })

    if (Array.isArray(parsed.notify) || typeof parsed.notify === 'string') {
      assets.push({
        asset: buildAsset({
          id: assetId('Codex', 'hook', 'user', sourcePath, 'notify'),
          agent: 'Codex',
          kind: 'hook',
          scope: 'user',
          sourcePath,
          source,
          name: 'notify hook',
          preview: '检测到 Codex notify Hook;因执行语义和权限边界不同,不会自动启用。',
          conflict: 'unsupported',
          risk: 'blocked',
          riskReasons: ['Hook 可执行本地命令,必须重新授权'],
          ignoredFields: ['notify.command', 'notify.args', 'notify.env'],
          importable: false,
          recommended: false
        }),
        sourceRoot,
        sourcePath
      })
    }

    if (isObject(parsed.mcp_servers)) {
      for (const [name, config] of Object.entries(parsed.mcp_servers)) {
        addMcpEntry('Codex', 'user', sourcePath, sourceRoot, source, name, config, cwd, home, assets)
      }
    }
  } catch (error) {
    diagnostics.push(diagnostic(error, sourcePath))
  }
}

function addJsonMcpAssets(
  agent: string,
  scope: MigrationAssetScope,
  sourcePath: string,
  sourceRoot: string,
  cwd: string | undefined,
  home: string,
  assets: InternalMigrationAsset[],
  diagnostics: MigrationDiagnostic[]
): void {
  if (!existsSync(sourcePath)) return
  try {
    assertNoSymlinkWithin(sourceRoot, sourcePath)
    const source = readSafeFile(sourcePath, MAX_SOURCE_FILE_BYTES)
    const parsed = JSON.parse(source.bytes.toString('utf8')) as unknown
    if (!isObject(parsed)) throw new Error('migration_mcp_root_invalid')
    const servers = isObject(parsed.mcpServers) ? parsed.mcpServers : isObject(parsed.servers) ? parsed.servers : undefined
    if (!servers) throw new Error('migration_mcp_servers_missing')
    for (const [name, config] of Object.entries(servers)) {
      addMcpEntry(agent, scope, sourcePath, sourceRoot, source, name, config, cwd, home, assets)
    }
  } catch (error) {
    diagnostics.push(diagnostic(error, sourcePath))
  }
}

function addMcpEntry(
  agent: string,
  scope: MigrationAssetScope,
  sourcePath: string,
  sourceRoot: string,
  source: ReturnType<typeof readSafeFile>,
  serverName: string,
  configValue: unknown,
  cwd: string | undefined,
  home: string,
  assets: InternalMigrationAsset[]
): void {
  const targetPath = mcpTarget(scope, cwd, home)
  const id = assetId(agent, 'mcp', scope, sourcePath, serverName)
  const sanitized = sanitizeMcpConfig(configValue)
  const target = inspectMcpTarget(targetPath, serverName)
  const hasRunnableTarget = typeof sanitized.config.command === 'string' || typeof sanitized.config.url === 'string'
  const blocked = target.blocked || !hasRunnableTarget
  const risk: MigrationAssetRisk = blocked ? 'blocked' : sanitized.ignoredFields.length > 0 || scope === 'user' ? 'review' : 'low'
  const conflict: MigrationAssetConflict = blocked ? 'unsupported' : target.conflict
  const importable = !blocked && conflict !== 'duplicate'
  const transport = typeof sanitized.config.command === 'string' ? 'stdio' : 'HTTP'
  const preview = `${transport} MCP;保留 ${Object.keys(sanitized.config).length} 个安全字段;忽略 ${sanitized.ignoredFields.length} 个凭据或未知字段。`
  const asset = buildAsset({
    id,
    agent,
    kind: 'mcp',
    scope,
    sourcePath,
    source,
    name: serverName,
    preview,
    targetPath,
    conflict,
    conflictDetail: target.detail,
    risk,
    riskReasons: [
      ...(sanitized.ignoredFields.length > 0 ? ['凭据字段不会导入,服务可能需要重新授权'] : []),
      ...(scope === 'user' ? ['用户级 MCP 会影响所有对话'] : []),
      ...(blocked ? ['缺少可安全映射的 command 或 url'] : [])
    ],
    ignoredFields: sanitized.ignoredFields,
    importable,
    recommended: importable && risk === 'low' && conflict === 'none'
  })
  assets.push({
    asset,
    sourceRoot,
    sourcePath,
    targetRoot: migrationTargetRoot(scope, cwd, home),
    targetPath,
    targetFingerprint: target.fingerprint,
    mcpServerName: serverName,
    mcpConfig: sanitized.config
  })
}

function addSkillRoot(
  agent: string,
  scope: MigrationAssetScope,
  skillsRoot: string,
  sourceRoot: string,
  cwd: string | undefined,
  home: string,
  assets: InternalMigrationAsset[],
  diagnostics: MigrationDiagnostic[]
): void {
  if (!existsSync(skillsRoot)) return
  const context: SkillScanContext = { agent, scope, sourceRoot, cwd, home, assets, diagnostics }
  try {
    assertNoSymlinkWithin(sourceRoot, skillsRoot)
    const info = lstatSync(skillsRoot)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('migration_source_not_directory')
    for (const entry of readdirSync(skillsRoot, { withFileTypes: true, encoding: 'utf8' }).slice(0, 100)) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      addSkillEntry(skillsRoot, entry.name, context)
    }
  } catch (error) {
    diagnostics.push(diagnostic(error, skillsRoot))
  }
}

function addSkillEntry(skillsRoot: string, name: string, context: SkillScanContext): void {
  const sourcePath = join(skillsRoot, name)
  if (!existsSync(join(sourcePath, 'SKILL.md'))) return
  try {
    assertNoSymlinkWithin(context.sourceRoot, sourcePath)
    const snapshot = readSafeDirectory(sourcePath, {
      maxFiles: MAX_SKILL_FILES,
      maxBytes: MAX_SKILL_BYTES,
      maxDepth: 8
    })
    const targetPath = join(skillTargetRoot(context.scope, context.cwd, context.home), safeSingleSegment(name))
    const fingerprint = targetFingerprint(targetPath)
    const sensitive = directoryContainsSensitiveText(snapshot)
    const conflict = skillConflict(fingerprint, snapshot.digest)
    const targetBlocked = conflict === 'unsupported'
    const risk: MigrationAssetRisk = sensitive || targetBlocked
      ? 'blocked'
      : context.scope === 'user' ? 'review' : 'low'
    const importable = risk !== 'blocked' && conflict !== 'duplicate'
    const skillMd = snapshot.files.find((file) => file.relativePath === 'SKILL.md')
    const preview = sensitive
      ? 'Skill 内容包含疑似凭据,预览与导入均已阻止。'
      : safeRulePreview(skillMd?.bytes.toString('utf8') ?? '', 220)
    const asset = buildAsset({
      id: assetId(context.agent, 'skill', context.scope, sourcePath),
      agent: context.agent,
      kind: 'skill',
      scope: context.scope,
      sourcePath,
      source: { digest: snapshot.digest, sizeBytes: snapshot.sizeBytes },
      name,
      preview,
      targetPath,
      conflict,
      risk,
      riskReasons: [
        ...(sensitive ? ['Skill 中检测到疑似凭据'] : []),
        ...(context.scope === 'user' ? ['用户级 Skill 会影响所有对话'] : [])
      ],
      importable,
      recommended: importable && risk === 'low' && conflict === 'none'
    })
    context.assets.push({
      asset,
      sourceRoot: context.sourceRoot,
      sourcePath,
      targetRoot: migrationTargetRoot(context.scope, context.cwd, context.home),
      targetPath,
      targetFingerprint: fingerprint
    })
  } catch (error) {
    context.diagnostics.push(diagnostic(error, sourcePath))
  }
}

function skillConflict(fingerprint: string, sourceDigest: string): MigrationAssetConflict {
  if (fingerprint === 'symlink' || fingerprint === 'special') return 'unsupported'
  if (fingerprint === 'missing') return 'none'
  if (fingerprint === `dir:${sourceDigest}`) return 'duplicate'
  return 'replace_required'
}

function buildAsset(input: {
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

function inspectRuleTarget(targetPath: string, id: string, digest: string): {
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

function inspectMcpTarget(targetPath: string, serverName: string): {
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

function countNativeClaudeAssets(cwd: string | undefined, home: string): number {
  const candidates = [
    ...(cwd ? [join(cwd, 'CLAUDE.md'), join(cwd, '.claude'), join(cwd, '.mcp.json')] : []),
    join(home, '.claude', 'CLAUDE.md'),
    join(home, '.claude', 'skills'),
    join(home, '.claude', 'agents'),
    join(home, '.claude', 'settings.json')
  ]
  return candidates.filter((path) => {
    try {
      return !lstatSync(path).isSymbolicLink()
    } catch {
      return false
    }
  }).length
}

function ruleTarget(scope: MigrationAssetScope, cwd: string | undefined, home: string): string {
  return scope === 'project' && cwd ? join(cwd, 'CLAUDE.md') : join(home, '.claude', 'CLAUDE.md')
}

function mcpTarget(scope: MigrationAssetScope, cwd: string | undefined, home: string): string {
  return scope === 'project' && cwd ? join(cwd, '.mcp.json') : join(home, '.claude', 'settings.json')
}

function skillTargetRoot(scope: MigrationAssetScope, cwd: string | undefined, home: string): string {
  return scope === 'project' && cwd ? join(cwd, '.claude', 'skills') : join(home, '.claude', 'skills')
}

function migrationTargetRoot(scope: MigrationAssetScope, cwd: string | undefined, home: string): string {
  return scope === 'project' && cwd ? cwd : home
}

function normalizeProjectDirectory(cwdInput?: string): string | undefined {
  const trimmed = typeof cwdInput === 'string' ? cwdInput.trim() : ''
  if (!trimmed) return undefined
  const cwd = resolve(trimmed)
  const info = lstatSync(cwd)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('migration_project_not_directory')
  return cwd
}

function assetId(
  agent: string,
  kind: MigrationAssetKind,
  scope: MigrationAssetScope,
  sourcePath: string,
  entry = ''
): string {
  return `migration-${sha256([agent, kind, scope, resolve(sourcePath), entry].join('\0')).slice(0, 24)}`
}

function compareAssets(left: MigrationAsset, right: MigrationAsset): number {
  return left.scope.localeCompare(right.scope) || left.agent.localeCompare(right.agent) || left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name)
}

function safeSingleSegment(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9._-]/g, '-').replace(/\.{2,}/g, '-').replace(/^[.-]+/, '').slice(0, 80)
  if (!clean || clean === '.' || clean === '..') throw new Error('migration_target_name_invalid')
  return clean
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function diagnostic(error: unknown, path: string): MigrationDiagnostic {
  return { code: publicMigrationError(error), message: '该来源未扫描或未导入。', path }
}

function publicMigrationError(error: unknown): string {
  if (error instanceof Error && /^migration_[a-z0-9_]+$/.test(error.message)) return error.message
  const code = errorCode(error)
  if (code === 'ENOENT') return 'migration_path_missing'
  if (code === 'EACCES' || code === 'EPERM') return 'migration_path_unreadable'
  return 'migration_operation_failed'
}
