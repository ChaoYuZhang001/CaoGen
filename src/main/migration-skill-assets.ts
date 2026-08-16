import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { MigrationAssetRisk, MigrationAssetScope } from '../shared/types'
import {
  assetId,
  buildAsset,
  diagnostic,
  migrationTargetRoot,
  publicMigrationError,
  safeSkillTargetName,
  skillConflict,
  skillTargetRoot,
  type MigrationDiagnostic
} from './migration-asset-helpers'
import {
  assertNoSymlinkWithin,
  directoryContainsSensitiveText,
  readSafeDirectory,
  safeRulePreview,
  targetFingerprint,
  type SafeDirectorySnapshot
} from './migration-safety'
import type { InternalMigrationAsset } from './migration-scan-store'

interface SkillScanContext {
  agent: string
  scope: MigrationAssetScope
  sourceRoot: string
  cwd: string | undefined
  home: string
  assets: InternalMigrationAsset[]
  diagnostics: MigrationDiagnostic[]
  targetPrefix: string
  visitedDirectories: number
  discoveredAssets: number
  discoveredBytes: number
  limitReached: boolean
}

interface SkillCandidate {
  sourcePath: string
  displayName: string
  targetPath: string
  fingerprint: string
  snapshot: SafeDirectorySnapshot
  sensitive: boolean
  risk: MigrationAssetRisk
  conflict: ReturnType<typeof skillConflict>
  importable: boolean
}

const MAX_SKILL_BYTES = 5 * 1024 * 1024
const MAX_SKILL_FILES = 200
const MAX_SKILL_DISCOVERY_BYTES = 20 * 1024 * 1024
const MAX_SKILL_DISCOVERY_DEPTH = 6
const MAX_SKILL_DIRECTORIES = 500
const MAX_SKILL_ASSETS = 100

export function addSkillRoot(
  agent: string,
  scope: MigrationAssetScope,
  skillsRoot: string,
  sourceRoot: string,
  cwd: string | undefined,
  home: string,
  assets: InternalMigrationAsset[],
  diagnostics: MigrationDiagnostic[],
  targetPrefix = ''
): void {
  if (!existsSync(skillsRoot)) return
  const context = createSkillScanContext(agent, scope, sourceRoot, cwd, home, assets, diagnostics, targetPrefix)
  try {
    assertNoSymlinkWithin(sourceRoot, skillsRoot)
    const info = lstatSync(skillsRoot)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('migration_source_not_directory')
    discoverSkillEntries(skillsRoot, '', 0, context)
  } catch (error) {
    diagnostics.push(diagnostic(error, skillsRoot))
  }
}

function createSkillScanContext(
  agent: string,
  scope: MigrationAssetScope,
  sourceRoot: string,
  cwd: string | undefined,
  home: string,
  assets: InternalMigrationAsset[],
  diagnostics: MigrationDiagnostic[],
  targetPrefix: string
): SkillScanContext {
  return {
    agent, scope, sourceRoot, cwd, home, assets, diagnostics, targetPrefix,
    visitedDirectories: 0,
    discoveredAssets: 0,
    discoveredBytes: 0,
    limitReached: false
  }
}

function discoverSkillEntries(
  skillsRoot: string,
  relativeDirectory: string,
  depth: number,
  context: SkillScanContext
): void {
  if (context.limitReached) return
  if (depth > MAX_SKILL_DISCOVERY_DEPTH) {
    markSkillLimit(context, 'migration_source_depth_exceeded', join(skillsRoot, relativeDirectory))
    return
  }
  const directory = join(skillsRoot, relativeDirectory)
  for (const entry of skillDirectoryEntries(directory)) {
    if (context.limitReached || entry.name.startsWith('.')) continue
    inspectSkillDirectoryEntry(skillsRoot, relativeDirectory, entry, depth, context)
  }
}

function skillDirectoryEntries(directory: string) {
  return readdirSync(directory, { withFileTypes: true, encoding: 'utf8' })
    .sort((left, right) => left.name.localeCompare(right.name))
}

function inspectSkillDirectoryEntry(
  skillsRoot: string,
  relativeDirectory: string,
  entry: ReturnType<typeof skillDirectoryEntries>[number],
  depth: number,
  context: SkillScanContext
): void {
  const entryRelativePath = join(relativeDirectory, entry.name)
  const entryPath = join(skillsRoot, entryRelativePath)
  if (entry.isSymbolicLink()) {
    context.diagnostics.push(diagnostic(new Error('migration_source_symlink'), entryPath))
    return
  }
  if (!entry.isDirectory()) return
  context.visitedDirectories += 1
  if (context.visitedDirectories > MAX_SKILL_DIRECTORIES) {
    markSkillLimit(context, 'migration_source_directory_limit', entryPath)
    return
  }
  try {
    assertNoSymlinkWithin(context.sourceRoot, entryPath)
    const info = lstatSync(entryPath)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('migration_source_symlink')
    if (existsSync(join(entryPath, 'SKILL.md'))) addSkillEntry(skillsRoot, entryRelativePath, context)
    else discoverSkillEntries(skillsRoot, entryRelativePath, depth + 1, context)
  } catch (error) {
    context.diagnostics.push(diagnostic(error, entryPath))
  }
}

function addSkillEntry(skillsRoot: string, relativeSkillPath: string, context: SkillScanContext): void {
  const sourcePath = join(skillsRoot, relativeSkillPath)
  if (!existsSync(join(sourcePath, 'SKILL.md'))) return
  try {
    const candidate = readSkillCandidate(sourcePath, relativeSkillPath, context)
    context.assets.push(buildSkillInternalAsset(candidate, context))
    context.discoveredAssets += 1
    context.discoveredBytes += candidate.snapshot.sizeBytes
  } catch (error) {
    const code = publicMigrationError(error)
    if (code === 'migration_source_asset_limit' || code === 'migration_source_total_size_invalid') {
      context.limitReached = true
    }
    context.diagnostics.push(diagnostic(error, sourcePath))
  }
}

function readSkillCandidate(
  sourcePath: string,
  relativeSkillPath: string,
  context: SkillScanContext
): SkillCandidate {
  assertNoSymlinkWithin(context.sourceRoot, sourcePath)
  const snapshot = readSafeDirectory(sourcePath, {
    maxFiles: MAX_SKILL_FILES,
    maxBytes: MAX_SKILL_BYTES,
    maxDepth: 8
  })
  enforceSkillDiscoveryLimits(snapshot, context)
  const displayName = relativeSkillPath.split(/[\\/]/).join('/')
  const targetName = safeSkillTargetName(context.targetPrefix, displayName)
  const targetPath = join(skillTargetRoot(context.scope, context.cwd, context.home), targetName)
  const fingerprint = targetFingerprint(targetPath)
  const sensitive = directoryContainsSensitiveText(snapshot)
  const conflict = skillConflict(fingerprint, snapshot.digest)
  const risk: MigrationAssetRisk = sensitive || conflict === 'unsupported'
    ? 'blocked'
    : context.scope === 'user' ? 'review' : 'low'
  return {
    sourcePath, displayName, targetPath, fingerprint, snapshot, sensitive, risk, conflict,
    importable: risk !== 'blocked' && conflict !== 'duplicate'
  }
}

function enforceSkillDiscoveryLimits(snapshot: SafeDirectorySnapshot, context: SkillScanContext): void {
  if (context.discoveredAssets >= MAX_SKILL_ASSETS) throw new Error('migration_source_asset_limit')
  if (context.discoveredBytes + snapshot.sizeBytes > MAX_SKILL_DISCOVERY_BYTES) {
    throw new Error('migration_source_total_size_invalid')
  }
}

function buildSkillInternalAsset(candidate: SkillCandidate, context: SkillScanContext): InternalMigrationAsset {
  const skillMd = candidate.snapshot.files.find((file) => file.relativePath === 'SKILL.md')
  const preview = candidate.sensitive
    ? 'Skill 内容包含疑似凭据,预览与导入均已阻止。'
    : safeRulePreview(skillMd?.bytes.toString('utf8') ?? '', 220)
  return {
    asset: buildAsset({
      id: assetId(context.agent, 'skill', context.scope, candidate.sourcePath),
      agent: context.agent,
      kind: 'skill',
      scope: context.scope,
      sourcePath: candidate.sourcePath,
      source: { digest: candidate.snapshot.digest, sizeBytes: candidate.snapshot.sizeBytes },
      name: candidate.displayName,
      preview,
      targetPath: candidate.targetPath,
      conflict: candidate.conflict,
      risk: candidate.risk,
      riskReasons: skillRiskReasons(candidate.sensitive, context.scope),
      importable: candidate.importable,
      recommended: candidate.importable && candidate.risk === 'low' && candidate.conflict === 'none'
    }),
    sourceRoot: context.sourceRoot,
    sourcePath: candidate.sourcePath,
    targetRoot: migrationTargetRoot(context.scope, context.cwd, context.home),
    targetPath: candidate.targetPath,
    targetFingerprint: candidate.fingerprint
  }
}

function skillRiskReasons(sensitive: boolean, scope: MigrationAssetScope): string[] {
  const reasons: string[] = []
  if (sensitive) reasons.push('Skill 中检测到疑似凭据')
  if (scope === 'user') reasons.push('用户级 Skill 会影响所有对话')
  return reasons
}

function markSkillLimit(context: SkillScanContext, code: string, path: string): void {
  context.limitReached = true
  context.diagnostics.push(diagnostic(new Error(code), path))
}
