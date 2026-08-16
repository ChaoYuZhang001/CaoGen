import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parse as parseJson5 } from 'json5'
import { JSON_SCHEMA, load as parseYaml } from 'js-yaml'
import type {
  MigrationAsset,
  MigrationAssetConflict,
  MigrationAssetKind,
  MigrationDecisionAction,
  MigrationScan
} from '../shared/types'
import { projectHash } from './memoryStore'
import {
  assertNoSymlinkWithin,
  containsSensitiveText,
  errorCode,
  readSafeDirectory,
  readSafeFile,
  safeRulePreview,
  sha256,
  targetFingerprint
} from './migration-safety'
import type { InternalMigrationAsset, JsonObject } from './migration-scan-store'
import {
  cronJobs,
  cronPrompt,
  cronSchedule,
  isScriptJob,
  stableJobSeed,
  type OpenSourceCronDialect,
  type OpenSourceCronSchedule
} from './migration-open-source-cron'

type MigrationDiagnostic = MigrationScan['diagnostics'][number]
type MigrationSource = ReturnType<typeof readSafeFile>

interface MemoryImportTarget {
  targetPath?: string
  targetBytes?: Buffer
  inspection?: ReturnType<typeof inspectVirtualTarget>
}

export interface OpenSourceAssetScanInput {
  cwd?: string
  home: string
  targetRoot: string
  assets: InternalMigrationAsset[]
  diagnostics: MigrationDiagnostic[]
}

const MAX_MEMORY_FILE_BYTES = 256 * 1024
const MAX_MEMORY_FILES = 100
const MAX_MEMORY_TOTAL_BYTES = 2 * 1024 * 1024
const MAX_MEMORY_DEPTH = 6
const MAX_CONFIG_BYTES = 512 * 1024
const MAX_CRON_JOBS = 200
const MAX_CHANNELS = 50
const MAX_PROFILES = 20
const EPOCH = '1970-01-01T00:00:00.000Z'
const SAFE_PLATFORM_NAMES = new Set([
  'bluebubbles', 'discord', 'email', 'feishu', 'googlechat', 'imessage', 'irc', 'line',
  'matrix', 'mattermost', 'msteams', 'signal', 'slack', 'sms', 'teams', 'telegram',
  'twitch', 'wechat', 'whatsapp', 'web', 'webchat', 'zulip'
])
const TARGET_CONTAINER_TYPES = new Set([
  'channels', 'chats', 'conversations', 'groups', 'guilds', 'rooms', 'targets', 'threads'
])

export function scanOpenSourceAgentAssets(input: OpenSourceAssetScanInput): void {
  const openClawRoot = join(input.home, '.openclaw')
  const hermesRoot = join(input.home, '.hermes')

  scanOpenClawMemory(input, openClawRoot)
  scanHermesMemory(input, hermesRoot)
  scanCronStore(input, 'OpenClaw', openClawRoot, join(openClawRoot, 'cron', 'jobs.json'), 'openclaw')
  scanCronStore(input, 'Hermes Agent', hermesRoot, join(hermesRoot, 'cron', 'jobs.json'), 'hermes')
  scanHermesProfiles(input, hermesRoot)
  scanChannelConfig(input, 'OpenClaw', openClawRoot, join(openClawRoot, 'openclaw.json'), 'json5')
  scanChannelConfig(input, 'Hermes Agent', hermesRoot, join(hermesRoot, 'config.yaml'), 'yaml')
  scanHermesChannelDirectory(input, hermesRoot)
}

function scanOpenClawMemory(input: OpenSourceAssetScanInput, sourceRoot: string): void {
  const roots = [
    ...(input.cwd ? [{ root: input.cwd, files: ['MEMORY.md'], directories: ['memory'] }] : []),
    { root: join(sourceRoot, 'workspace'), files: ['MEMORY.md'], directories: ['memory'] }
  ]
  const seen = new Set<string>()
  for (const candidate of roots) {
    scanMemoryLocation(input, 'OpenClaw', candidate.root, candidate.files, candidate.directories, seen)
  }
}

function scanHermesMemory(input: OpenSourceAssetScanInput, sourceRoot: string): void {
  scanMemoryLocation(input, 'Hermes Agent', sourceRoot, ['MEMORY.md', 'USER.md'], ['memories', 'memory'], new Set())
}

function scanMemoryLocation(
  input: OpenSourceAssetScanInput,
  agent: string,
  sourceRoot: string,
  files: string[],
  directories: string[],
  seen: Set<string>
): void {
  let index = input.assets.filter((item) => item.asset.agent === agent && item.asset.kind === 'memory').length
  for (const file of files) {
    const sourcePath = join(sourceRoot, file)
    if (existsSync(sourcePath) && !seen.has(resolve(sourcePath))) {
      seen.add(resolve(sourcePath))
      addMemoryAsset(input, agent, sourceRoot, sourcePath, ++index)
    }
  }
  for (const directory of directories) {
    const memoryRoot = join(sourceRoot, directory)
    if (!existsSync(memoryRoot)) continue
    try {
      assertNoSymlinkWithin(sourceRoot, memoryRoot)
      const snapshot = readSafeDirectory(memoryRoot, {
        maxFiles: MAX_MEMORY_FILES,
        maxBytes: MAX_MEMORY_TOTAL_BYTES,
        maxDepth: MAX_MEMORY_DEPTH,
        allowEmpty: true
      })
      for (const file of snapshot.files) {
        if (!file.relativePath.toLowerCase().endsWith('.md')) continue
        const sourcePath = join(memoryRoot, file.relativePath)
        if (seen.has(resolve(sourcePath))) continue
        seen.add(resolve(sourcePath))
        addMemoryAsset(input, agent, sourceRoot, sourcePath, ++index)
      }
    } catch (error) {
      input.diagnostics.push(diagnostic(error, memoryRoot))
    }
  }
}

function addMemoryAsset(
  input: OpenSourceAssetScanInput,
  agent: string,
  sourceRoot: string,
  sourcePath: string,
  index: number
): void {
  try {
    input.assets.push(buildMemoryAsset(input, agent, sourceRoot, sourcePath, index))
  } catch (error) {
    input.diagnostics.push(diagnostic(error, sourcePath))
  }
}

function buildMemoryAsset(
  input: OpenSourceAssetScanInput,
  agent: string,
  sourceRoot: string,
  sourcePath: string,
  index: number
): InternalMigrationAsset {
  assertNoSymlinkWithin(sourceRoot, sourcePath)
  const source = readSafeFile(sourcePath, MAX_MEMORY_FILE_BYTES)
  const body = source.bytes.toString('utf8').trim()
  const sensitive = !body || containsSensitiveText(body)
  const id = assetId(agent, 'memory', sourcePath)
  const target = prepareMemoryTarget(input, agent, id, index, body, sensitive)
  const blocked = sensitive || !input.cwd || target.inspection?.blocked === true
  const conflict = blocked ? 'unsupported' : target.inspection?.conflict ?? 'none'
  return {
    asset: buildAsset({
      id, agent, kind: 'memory', sourcePath, source, name: `Memory draft ${index}`,
      preview: sensitive
        ? 'Memory content is empty or may contain credentials; preview and import are blocked.'
        : `${safeRulePreview(body, 180)} (imports as an untrusted draft)`,
      targetPath: target.targetPath,
      conflict,
      conflictDetail: target.inspection?.detail,
      risk: blocked ? 'blocked' : 'review',
      riskReasons: memoryRiskReasons(input.cwd, sensitive, target.inspection?.blocked === true, blocked),
      importable: !blocked && conflict !== 'duplicate',
      recommended: false
    }),
    sourceRoot,
    sourcePath,
    ...memoryImportFields(input.targetRoot, sourcePath, target)
  }
}

function prepareMemoryTarget(
  input: OpenSourceAssetScanInput,
  agent: string,
  id: string,
  index: number,
  body: string,
  sensitive: boolean
): MemoryImportTarget {
  if (!input.cwd) return {}
  const entryId = `migration-memory-${id.slice(-24)}`
  const targetPath = join(input.targetRoot, 'memory', 'projects', projectHash(input.cwd), 'drafts', `${entryId}.json`)
  if (sensitive) return { targetPath }
  const targetBytes = memoryDraftBytes(agent, entryId, index, body)
  return { targetPath, targetBytes, inspection: inspectVirtualTarget(targetPath, targetBytes) }
}

function memoryDraftBytes(agent: string, entryId: string, index: number, body: string): Buffer {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    format: 'caogen.project-memory-entry.v1',
    id: entryId,
    kind: 'imported_external_memory',
    title: `${agent} memory draft ${index}`,
    body,
    source: `migration:${safeAgent(agent)}`,
    reason: 'Imported as an untrusted draft; user approval is required before use.',
    createdAt: EPOCH,
    updatedAt: EPOCH,
    status: 'draft'
  }, null, 2)}\n`, 'utf8')
}

function memoryRiskReasons(
  cwd: string | undefined,
  sensitive: boolean,
  targetBlocked: boolean,
  blocked: boolean
): string[] {
  const reasons: string[] = []
  if (!cwd) reasons.push('A project folder is required for project-scoped memory')
  if (sensitive) reasons.push('Memory is empty or contains suspected credentials')
  if (targetBlocked) reasons.push('Memory draft target cannot be modified safely')
  if (!blocked) reasons.push('Imported memory remains a draft until explicitly approved')
  return reasons
}

function memoryImportFields(
  targetRoot: string,
  sourcePath: string,
  target: MemoryImportTarget
): Partial<InternalMigrationAsset> {
  if (!target.targetPath) return {}
  return {
    targetRoot: existingTargetRoot(targetRoot),
    targetPath: target.targetPath,
    targetFingerprint: target.inspection?.fingerprint,
    targetBytes: target.targetBytes,
    readSourceDigest: () => readSafeFile(sourcePath, MAX_MEMORY_FILE_BYTES).digest
  }
}

function scanCronStore(
  input: OpenSourceAssetScanInput,
  agent: string,
  sourceRoot: string,
  sourcePath: string,
  dialect: OpenSourceCronDialect
): void {
  if (!existsSync(sourcePath)) return
  try {
    assertNoSymlinkWithin(sourceRoot, sourcePath)
    const source = readSafeFile(sourcePath, MAX_CONFIG_BYTES)
    const parsed = JSON.parse(source.bytes.toString('utf8')) as unknown
    const jobs = cronJobs(parsed)
    if (jobs.length > MAX_CRON_JOBS) throw new Error('migration_cron_job_limit')
    jobs.forEach((job, index) => addCronAsset(input, agent, sourceRoot, sourcePath, source, job, index, dialect))
  } catch (error) {
    input.diagnostics.push(diagnostic(error, sourcePath))
  }
}

function addCronAsset(
  input: OpenSourceAssetScanInput,
  agent: string,
  sourceRoot: string,
  sourcePath: string,
  source: ReturnType<typeof readSafeFile>,
  job: unknown,
  index: number,
  dialect: OpenSourceCronDialect
): void {
  if (!isObject(job)) return
  input.assets.push(buildCronAsset(input, agent, sourceRoot, sourcePath, source, job, index, dialect))
}

function buildCronAsset(
  input: OpenSourceAssetScanInput,
  agent: string,
  sourceRoot: string,
  sourcePath: string,
  source: MigrationSource,
  job: JsonObject,
  index: number,
  dialect: OpenSourceCronDialect
): InternalMigrationAsset {
  const script = isScriptJob(job)
  const prompt = cronPrompt(job, dialect)
  const sensitive = Boolean(prompt && containsSensitiveText(prompt))
  const empty = !prompt?.trim()
  const schedule = cronSchedule(job, dialect)
  const scheduleSensitive = containsSensitiveText(schedule.value)
  const id = assetId(agent, 'routine', sourcePath, stableJobSeed(job, index))
  const routineId = `migration-routine-${id.slice(-24)}`
  const targetPath = input.cwd ? join(input.targetRoot, 'routines', 'routines.json') : undefined
  const entry = routineDraftEntry(input.cwd, agent, routineId, index, prompt, schedule, {
    script, sensitive, scheduleSensitive, empty
  })
  const target = targetPath && entry ? inspectRoutineTarget(targetPath, routineId, entry) : undefined
  const blocked = cronAssetBlocked(input.cwd, script, sensitive, scheduleSensitive, empty, target?.blocked === true)
  const conflict = blocked ? 'unsupported' : target?.conflict ?? 'none'
  return {
    asset: buildAsset({
      id, agent, kind: 'routine', sourcePath, source, name: `Automation draft ${index + 1}`,
      preview: cronPreview(script, sensitive || scheduleSensitive, schedule.kind),
      targetPath,
      conflict,
      conflictDetail: target?.detail,
      risk: blocked ? 'blocked' : 'review',
      riskReasons: cronRiskReasons(input.cwd, script, empty, sensitive || scheduleSensitive, target?.blocked === true, blocked),
      ignoredFields: cronIgnoredFields(schedule.supported),
      importable: !blocked && conflict !== 'duplicate',
      recommended: false
    }),
    sourceRoot,
    sourcePath,
    ...routineImportFields(input.targetRoot, sourcePath, routineId, targetPath, entry, target)
  }
}

function routineDraftEntry(
  cwd: string | undefined,
  agent: string,
  routineId: string,
  index: number,
  prompt: string | undefined,
  schedule: OpenSourceCronSchedule,
  state: { script: boolean; sensitive: boolean; scheduleSensitive: boolean; empty: boolean }
): JsonObject | undefined {
  if (state.script || state.sensitive || state.scheduleSensitive || state.empty || !cwd || !prompt) return undefined
  return {
    id: routineId,
    name: `${agent} automation draft ${index + 1}`,
    prompt,
    content: prompt,
    projectCwd: cwd,
    schedule: schedule.value,
    frequency: schedule.value,
    providerId: '',
    model: '',
    permissionMode: 'plan',
    budgetUsd: 0,
    notification: { enabled: false, onSuccess: false, onFailure: false },
    enabled: false,
    createdAt: 0,
    updatedAt: 0,
    lastRunAt: null,
    migrationSource: safeAgent(agent),
    migrationReviewRequired: true,
    migrationScheduleKind: schedule.kind,
    migrationScheduleSupported: schedule.supported
  }
}

function cronPreview(script: boolean, sensitive: boolean, scheduleKind: string): string {
  if (script) return 'Script/no-agent task detected; executable migration is blocked.'
  if (sensitive) return 'Automation content may contain credentials; preview and import are blocked.'
  return `Disabled ${scheduleKind} automation draft; provider, delivery, permissions, and notifications are cleared.`
}

function cronRiskReasons(
  cwd: string | undefined,
  script: boolean,
  empty: boolean,
  sensitive: boolean,
  targetBlocked: boolean,
  blocked: boolean
): string[] {
  const reasons: string[] = []
  if (!cwd) reasons.push('A project folder is required for an automation draft')
  if (script) reasons.push('External scripts cannot become executable Routines automatically')
  if (empty) reasons.push('Automation prompt is empty')
  if (sensitive) reasons.push('Automation contains suspected credentials')
  if (targetBlocked) reasons.push('Routine store cannot be modified safely')
  if (!blocked) reasons.push('Routine is imported disabled with plan-only permission and zero budget')
  return reasons
}

function cronIgnoredFields(scheduleSupported: boolean): string[] {
  const fields = ['provider', 'model', 'credentials', 'delivery', 'webhook', 'account', 'tool_permissions']
  if (!scheduleSupported) fields.push('schedule.unsupported')
  return fields
}

function cronAssetBlocked(
  cwd: string | undefined,
  script: boolean,
  sensitive: boolean,
  scheduleSensitive: boolean,
  empty: boolean,
  targetBlocked: boolean
): boolean {
  return [!cwd, script, sensitive, scheduleSensitive, empty, targetBlocked].some(Boolean)
}

function routineImportFields(
  targetRoot: string,
  sourcePath: string,
  routineId: string,
  targetPath: string | undefined,
  entry: JsonObject | undefined,
  target: ReturnType<typeof inspectRoutineTarget> | undefined
): Partial<InternalMigrationAsset> {
  if (!targetPath || !entry) return {}
  return {
    targetRoot: existingTargetRoot(targetRoot),
    targetPath,
    targetFingerprint: target?.fingerprint,
    routineEntryId: routineId,
    routineEntry: entry,
    readSourceDigest: () => readSafeFile(sourcePath, MAX_CONFIG_BYTES).digest
  }
}

function scanHermesProfiles(input: OpenSourceAssetScanInput, hermesRoot: string): void {
  const profilesRoot = join(hermesRoot, 'profiles')
  if (!existsSync(profilesRoot)) return
  try {
    assertNoSymlinkWithin(hermesRoot, profilesRoot)
    const profiles = readdirSync(profilesRoot, { withFileTypes: true, encoding: 'utf8' })
      .filter((entry) => entry.isDirectory() && safeDirectoryName(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name))
    if (profiles.length > MAX_PROFILES) throw new Error('migration_profile_limit')
    const seen = new Set<string>()
    for (const profile of profiles) {
      const root = join(profilesRoot, profile.name)
      scanMemoryLocation(input, 'Hermes Agent', root, [], ['memories'], seen)
      scanCronStore(input, 'Hermes Agent', hermesRoot, join(root, 'cron', 'jobs.json'), 'hermes')
      scanChannelConfig(input, 'Hermes Agent', hermesRoot, join(root, 'config.yaml'), 'yaml')
    }
  } catch (error) {
    input.diagnostics.push(diagnostic(error, profilesRoot))
  }
}

function scanChannelConfig(
  input: OpenSourceAssetScanInput,
  agent: string,
  sourceRoot: string,
  sourcePath: string,
  format: 'json5' | 'yaml'
): void {
  if (!existsSync(sourcePath)) return
  try {
    assertNoSymlinkWithin(sourceRoot, sourcePath)
    const source = readSafeFile(sourcePath, MAX_CONFIG_BYTES)
    const parsed = format === 'json5'
      ? parseJson5(source.bytes.toString('utf8')) as unknown
      : parseYaml(source.bytes.toString('utf8'), { schema: JSON_SCHEMA, json: true }) as unknown
    if (!isObject(parsed)) throw new Error('migration_channel_config_invalid')
    const platforms = format === 'json5' ? openClawPlatforms(parsed) : hermesPlatforms(parsed)
    if (platforms.size > MAX_CHANNELS) throw new Error('migration_channel_limit')
    let index = 0
    for (const [platform, values] of [...platforms.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      addChannelAsset(input, agent, sourceRoot, sourcePath, source, platform, values, ++index)
    }
  } catch (error) {
    input.diagnostics.push(diagnostic(error, sourcePath))
  }
}

function scanHermesChannelDirectory(input: OpenSourceAssetScanInput, hermesRoot: string): void {
  const sourcePath = join(hermesRoot, 'channel_directory.json')
  if (!existsSync(sourcePath)) return
  try {
    assertNoSymlinkWithin(hermesRoot, sourcePath)
    const source = readSafeFile(sourcePath, MAX_CONFIG_BYTES)
    const parsed = JSON.parse(source.bytes.toString('utf8')) as unknown
    const platforms = channelDirectoryPlatforms(parsed)
    if (platforms.size > MAX_CHANNELS) throw new Error('migration_channel_limit')
    let index = 0
    for (const [platform, values] of [...platforms.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      addChannelAsset(input, 'Hermes Agent', hermesRoot, sourcePath, source, platform, values, ++index)
    }
  } catch (error) {
    input.diagnostics.push(diagnostic(error, sourcePath))
  }
}

function addChannelAsset(
  input: OpenSourceAssetScanInput,
  agent: string,
  sourceRoot: string,
  sourcePath: string,
  source: ReturnType<typeof readSafeFile>,
  platform: string,
  values: unknown[],
  index: number
): void {
  const summary = summarizeChannel(values)
  const id = assetId(agent, 'channel', sourcePath, platform)
  const targetPath = join(input.targetRoot, 'migration-imports', 'channels', `${id}.json`)
  const targetBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    format: 'caogen.migration-channel-index.v1',
    id,
    agent: safeAgent(agent),
    platform,
    sourceEnabled: summary.sourceEnabled,
    accountCount: summary.accountCount,
    discoveredTargetCount: summary.discoveredTargetCount,
    targetTypeCounts: summary.targetTypeCounts,
    createsConnector: false,
    requiresReauthorization: true
  }, null, 2)}\n`, 'utf8')
  const target = inspectVirtualTarget(targetPath, targetBytes)
  const blocked = target.blocked
  const conflict = blocked ? 'unsupported' : target.conflict
  const asset = buildAsset({
    id,
    agent,
    kind: 'channel',
    sourcePath,
    source,
    name: `Channel index ${index}: ${platform}`,
    preview: `${platform} index; ${summary.accountCount} account slots and ${summary.discoveredTargetCount} targets counted. No identifiers or credentials are retained.`,
    targetPath,
    conflict,
    conflictDetail: target.detail,
    risk: blocked ? 'blocked' : 'review',
    riskReasons: [
      ...(blocked ? ['Channel index target cannot be modified safely'] : []),
      ...(!blocked ? ['Index is informational and cannot send messages'] : [])
    ],
    ignoredFields: ['credentials', 'tokens', 'cookies', 'webhooks', 'account_ids', 'channel_ids', 'names', 'allowlists', 'prompts', 'routing_targets'],
    importable: !blocked && conflict !== 'duplicate',
    recommended: false
  })
  input.assets.push({
    asset,
    sourceRoot,
    sourcePath,
    targetRoot: existingTargetRoot(input.targetRoot),
    targetPath,
    targetFingerprint: target.fingerprint,
    targetBytes,
    readSourceDigest: () => readSafeFile(sourcePath, MAX_CONFIG_BYTES).digest
  })
}

function openClawPlatforms(config: JsonObject): Map<string, unknown[]> {
  const result = new Map<string, unknown[]>()
  if (!isObject(config.channels)) return result
  collectPlatformObject(result, config.channels)
  return result
}

function hermesPlatforms(config: JsonObject): Map<string, unknown[]> {
  const result = new Map<string, unknown[]>()
  if (isObject(config.platforms)) collectPlatformObject(result, config.platforms)
  if (isObject(config.gateway) && isObject(config.gateway.platforms)) collectPlatformObject(result, config.gateway.platforms)
  for (const [key, value] of Object.entries(config)) {
    const platform = normalizePlatform(key)
    if (platform && !['platforms'].includes(key.toLowerCase())) addPlatformValue(result, platform, value)
  }
  return result
}

function channelDirectoryPlatforms(value: unknown): Map<string, unknown[]> {
  const result = new Map<string, unknown[]>()
  const visit = (current: unknown, depth: number): void => {
    if (depth > 6 || current === null || current === undefined) return
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 1000)) visit(item, depth + 1)
      return
    }
    if (!isObject(current)) return
    const platform = normalizePlatform(firstString(current.platform, current.provider, current.channel_type))
    if (platform) addPlatformValue(result, platform, current)
    for (const [key, child] of Object.entries(current)) {
      const keyedPlatform = normalizePlatform(key)
      if (keyedPlatform) addPlatformValue(result, keyedPlatform, child)
      else if (Array.isArray(child) || isObject(child)) visit(child, depth + 1)
    }
  }
  visit(value, 0)
  return result
}

function collectPlatformObject(result: Map<string, unknown[]>, value: JsonObject): void {
  for (const [key, entry] of Object.entries(value)) {
    const platform = normalizePlatform(key)
    if (platform) addPlatformValue(result, platform, entry)
  }
}

function addPlatformValue(result: Map<string, unknown[]>, platform: string, value: unknown): void {
  const entries = result.get(platform) ?? []
  entries.push(value)
  result.set(platform, entries)
}

function summarizeChannel(values: unknown[]): {
  sourceEnabled: boolean
  accountCount: number
  discoveredTargetCount: number
  targetTypeCounts: Record<string, number>
} {
  let sourceEnabled = false
  let accountCount = 0
  let discoveredTargetCount = 0
  const targetTypeCounts: Record<string, number> = {}
  for (const value of values) {
    if (isObject(value)) {
      sourceEnabled ||= value.enabled !== false
      accountCount += boundedCollectionSize(value.accounts)
      for (const [key, child] of Object.entries(value)) {
        const type = key.toLowerCase().replace(/[^a-z]/g, '')
        if (!TARGET_CONTAINER_TYPES.has(type)) continue
        const count = boundedCollectionSize(child)
        discoveredTargetCount += count
        targetTypeCounts[type] = (targetTypeCounts[type] ?? 0) + count
      }
    } else {
      sourceEnabled = true
    }
  }
  return {
    sourceEnabled,
    accountCount: Math.min(accountCount, 10_000),
    discoveredTargetCount: Math.min(discoveredTargetCount, 100_000),
    targetTypeCounts: Object.fromEntries(Object.entries(targetTypeCounts).sort(([left], [right]) => left.localeCompare(right)))
  }
}

function boundedCollectionSize(value: unknown): number {
  if (Array.isArray(value)) return Math.min(value.length, 10_000)
  if (isObject(value)) return Math.min(Object.keys(value).length, 10_000)
  return 0
}

function inspectVirtualTarget(targetPath: string, bytes: Buffer): {
  fingerprint: string
  conflict: MigrationAssetConflict
  detail?: string
  blocked: boolean
} {
  try {
    const fingerprint = targetFingerprint(targetPath)
    if (fingerprint === 'missing') return { fingerprint, conflict: 'none', blocked: false }
    if (!fingerprint.startsWith('file:')) {
      return { fingerprint, conflict: 'unsupported', detail: 'Target is not a regular file.', blocked: true }
    }
    if (fingerprint === `file:${sha256(bytes)}`) {
      return { fingerprint, conflict: 'duplicate', detail: 'Identical version is already imported.', blocked: false }
    }
    return { fingerprint, conflict: 'replace_required', detail: 'A different imported version already exists.', blocked: false }
  } catch (error) {
    return { fingerprint: 'unreadable', conflict: 'unsupported', detail: publicError(error), blocked: true }
  }
}

function inspectRoutineTarget(targetPath: string, routineId: string, entry: JsonObject): {
  fingerprint: string
  conflict: MigrationAssetConflict
  detail?: string
  blocked: boolean
} {
  try {
    const fingerprint = targetFingerprint(targetPath)
    if (fingerprint === 'missing') return { fingerprint, conflict: 'none', blocked: false }
    if (!fingerprint.startsWith('file:')) {
      return { fingerprint, conflict: 'unsupported', detail: 'Routine target is not a regular file.', blocked: true }
    }
    const parsed = JSON.parse(readSafeFile(targetPath, 8 * 1024 * 1024).bytes.toString('utf8')) as unknown
    if (!isObject(parsed) || (parsed.routines !== undefined && !Array.isArray(parsed.routines))) {
      throw new Error('migration_target_routine_invalid')
    }
    const routines = Array.isArray(parsed.routines) ? parsed.routines : []
    const existing = routines.find((candidate) => isObject(candidate) && candidate.id === routineId)
    if (!existing) return { fingerprint, conflict: 'none', blocked: false }
    if (stableJson(existing) === stableJson(entry)) {
      return { fingerprint, conflict: 'duplicate', detail: 'Identical automation draft is already imported.', blocked: false }
    }
    return { fingerprint, conflict: 'replace_required', detail: 'Automation draft ID already exists.', blocked: false }
  } catch (error) {
    return { fingerprint: 'unreadable', conflict: 'unsupported', detail: publicError(error), blocked: true }
  }
}

function buildAsset(input: {
  id: string
  agent: string
  kind: MigrationAssetKind
  sourcePath: string
  source: { digest: string; sizeBytes: number }
  name: string
  preview: string
  targetPath?: string
  conflict: MigrationAssetConflict
  conflictDetail?: string
  risk: MigrationAsset['risk']
  riskReasons: string[]
  ignoredFields?: string[]
  importable: boolean
  recommended: boolean
}): MigrationAsset {
  const supportedActions: MigrationDecisionAction[] = input.importable
    ? input.conflict === 'replace_required' ? ['replace', 'skip'] : ['import', 'skip']
    : ['skip']
  return {
    id: input.id,
    agent: input.agent,
    kind: input.kind,
    scope: 'user',
    path: input.sourcePath,
    name: input.name,
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

function assetId(agent: string, kind: MigrationAssetKind, sourcePath: string, entry = ''): string {
  return `migration-${sha256([agent, kind, resolve(sourcePath), entry].join('\0')).slice(0, 24)}`
}

function safeAgent(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'external-agent'
}

function normalizePlatform(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, '')
  return SAFE_PLATFORM_NAMES.has(normalized) ? normalized : undefined
}

function safeDirectoryName(value: string): boolean {
  return value.length > 0 && value.length <= 128 && value !== '.' && value !== '..' && !/[\0-\x1f\x7f]/.test(value)
}

function existingTargetRoot(targetRoot: string): string {
  let current = resolve(targetRoot)
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) throw new Error('migration_target_root_missing')
    current = parent
  }
  const info = lstatSync(current)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('migration_target_root_invalid')
  return current
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim()
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!isObject(value)) return JSON.stringify(value)
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function diagnostic(error: unknown, path: string): MigrationDiagnostic {
  return { code: publicError(error), message: publicError(error), path }
}

function publicError(error: unknown): string {
  if (error instanceof Error && /^migration_[a-z0-9_]+$/.test(error.message)) return error.message
  const code = errorCode(error)
  if (code === 'ENOENT') return 'migration_path_missing'
  if (code === 'EACCES' || code === 'EPERM') return 'migration_path_unreadable'
  return 'migration_open_source_asset_invalid'
}
