import { createHash } from 'node:crypto'
import type {
  HistoryEntry,
  SessionMeta,
  SessionQueryInput,
  SessionQueryItem,
  SessionQueryPage,
  SessionQueryPresence,
  SessionStatus,
  TaskSnapshotRecord,
  TranscriptSearchHit
} from '../shared/types'
import { searchTranscripts } from './transcriptSearch'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const MAX_QUERY_LENGTH = 512
const MAX_ID_LENGTH = 256
const MAX_CURSOR_LENGTH = 2048
const STATUSES: readonly SessionStatus[] = ['starting', 'running', 'idle', 'error', 'closed']
const PRESENCE: readonly SessionQueryPresence[] = ['active', 'recovery', 'history']
const QUERY_FIELDS = new Set([
  'query', 'statuses', 'presence', 'workspaceId', 'projectId', 'goalId', 'workItemId',
  'parentSessionId', 'rootsOnly', 'includeArchived', 'updatedAfter', 'updatedBefore', 'limit', 'cursor'
])
const QUERY_ID_FIELDS = ['workspaceId', 'projectId', 'goalId', 'workItemId', 'parentSessionId'] as const

type NormalizedSessionQueryInput = Required<Pick<SessionQueryInput, 'limit'>> & SessionQueryInput

export interface SessionQuerySources {
  activeSessions: readonly SessionMeta[]
  history: readonly HistoryEntry[]
  snapshots: readonly TaskSnapshotRecord[]
  transcriptsDir?: string
}

interface SessionSourceGroup {
  active?: SessionMeta
  history?: HistoryEntry
  snapshot?: TaskSnapshotRecord
  ids: Set<string>
  sdkSessionIds: Set<string>
}

interface QueryCursor {
  version: 1
  scopeHash: string
  updatedAt: number
  id: string
}

export async function querySessionDirectory(
  sources: SessionQuerySources,
  rawInput: unknown = {}
): Promise<SessionQueryPage> {
  const input = normalizeSessionQueryInput(rawInput)
  const scopeHash = queryScopeHash(input)
  const cursor = input.cursor ? decodeCursor(input.cursor, scopeHash) : undefined
  const groups = groupSources(sources)
  const items = [...groups].map(toQueryItem)
  applyLineage(items, groups)

  const structurallyMatched = items.filter((item) => matchesStructuralFilters(item, input))
  const transcriptHits = input.query && sources.transcriptsDir
    ? await transcriptHitsFor(structurallyMatched, sources.transcriptsDir, input.query)
    : new Map<string, TranscriptSearchHit[]>()
  const query = input.query?.toLocaleLowerCase()
  const matched = structurallyMatched
    .map((item) => ({
      ...item,
      transcriptHits: item.sdkSessionId ? (transcriptHits.get(item.sdkSessionId) ?? []) : []
    }))
    .filter((item) => !query || metadataText(item).includes(query) || item.transcriptHits.length > 0)
    .sort(compareItems)
  const afterCursor = cursor ? matched.filter((item) => isAfterCursor(item, cursor)) : matched
  const pageItems = afterCursor.slice(0, input.limit)

  return {
    schemaVersion: 1,
    items: pageItems,
    ...(afterCursor.length > pageItems.length && pageItems.length > 0
      ? { nextCursor: encodeCursor(pageItems.at(-1)!, scopeHash) }
      : {}),
    totalMatched: matched.length
  }
}

export function normalizeSessionQueryInput(rawInput: unknown): NormalizedSessionQueryInput {
  if (rawInput === undefined || rawInput === null) return { limit: DEFAULT_LIMIT }
  if (!isRecord(rawInput)) throw new Error('Session query input must be an object')
  assertKnownQueryFields(rawInput)
  const input: NormalizedSessionQueryInput = { limit: optionalLimit(rawInput.limit) }
  applyTextAndEnumFilters(input, rawInput)
  applyIdFilters(input, rawInput)
  applyBooleanFilters(input, rawInput)
  applyTimestampFilters(input, rawInput)
  applyCursor(input, rawInput)
  assertCompatibleFilters(input)
  return input
}

function assertKnownQueryFields(rawInput: Record<string, unknown>): void {
  const unknown = Object.keys(rawInput).find((key) => !QUERY_FIELDS.has(key))
  if (unknown) throw new Error(`Unknown Session query field: ${unknown}`)
}

function applyTextAndEnumFilters(
  input: NormalizedSessionQueryInput,
  rawInput: Record<string, unknown>
): void {
  const query = optionalString(rawInput.query, 'query', MAX_QUERY_LENGTH)
  if (query) input.query = query
  const statuses = optionalEnumArray(rawInput.statuses, 'statuses', STATUSES)
  if (statuses) input.statuses = statuses
  const presence = optionalEnumArray(rawInput.presence, 'presence', PRESENCE)
  if (presence) input.presence = presence
}

function applyIdFilters(input: NormalizedSessionQueryInput, rawInput: Record<string, unknown>): void {
  for (const key of QUERY_ID_FIELDS) {
    const value = optionalString(rawInput[key], key, MAX_ID_LENGTH)
    if (value) input[key] = value
  }
}

function applyBooleanFilters(input: NormalizedSessionQueryInput, rawInput: Record<string, unknown>): void {
  if (rawInput.rootsOnly !== undefined) input.rootsOnly = requiredBoolean(rawInput.rootsOnly, 'rootsOnly')
  if (rawInput.includeArchived !== undefined) {
    input.includeArchived = requiredBoolean(rawInput.includeArchived, 'includeArchived')
  }
}

function applyTimestampFilters(input: NormalizedSessionQueryInput, rawInput: Record<string, unknown>): void {
  const updatedAfter = optionalTimestamp(rawInput.updatedAfter, 'updatedAfter')
  const updatedBefore = optionalTimestamp(rawInput.updatedBefore, 'updatedBefore')
  if (updatedAfter !== undefined) input.updatedAfter = updatedAfter
  if (updatedBefore !== undefined) input.updatedBefore = updatedBefore
}

function applyCursor(input: NormalizedSessionQueryInput, rawInput: Record<string, unknown>): void {
  const cursor = optionalString(rawInput.cursor, 'cursor', MAX_CURSOR_LENGTH)
  if (cursor) input.cursor = cursor
}

function assertCompatibleFilters(input: NormalizedSessionQueryInput): void {
  if (input.updatedAfter !== undefined && input.updatedBefore !== undefined &&
      input.updatedAfter > input.updatedBefore) {
    throw new Error('Session query updatedAfter must not exceed updatedBefore')
  }
  if (input.rootsOnly && input.parentSessionId) {
    throw new Error('Session query rootsOnly and parentSessionId are mutually exclusive')
  }
}

function groupSources(sources: SessionQuerySources): SessionSourceGroup[] {
  const groups: SessionSourceGroup[] = []
  const byId = new Map<string, SessionSourceGroup>()
  const bySdkId = new Map<string, SessionSourceGroup>()
  const upsert = (meta: SessionMeta | HistoryEntry, sdkSessionId: string | undefined): SessionSourceGroup => {
    const group = byId.get(meta.id) ?? (sdkSessionId ? bySdkId.get(sdkSessionId) : undefined) ?? {
      ids: new Set<string>(),
      sdkSessionIds: new Set<string>()
    }
    if (!groups.includes(group)) groups.push(group)
    group.ids.add(meta.id)
    byId.set(meta.id, group)
    if (sdkSessionId) {
      group.sdkSessionIds.add(sdkSessionId)
      bySdkId.set(sdkSessionId, group)
    }
    return group
  }
  for (const history of sources.history) upsert(history, history.sdkSessionId).history = history
  for (const snapshot of sources.snapshots) {
    const group = upsert(snapshot.meta, snapshot.meta.sdkSessionId)
    if (!group.snapshot || snapshot.updatedAt > group.snapshot.updatedAt) group.snapshot = snapshot
  }
  for (const active of sources.activeSessions) upsert(active, active.sdkSessionId).active = active
  return groups
}

function toQueryItem(group: SessionSourceGroup): SessionQueryItem {
  const meta = group.active ?? group.snapshot?.meta ?? group.history
  if (!meta) throw new Error('Session query source group is empty')
  const presence = PRESENCE.filter((item) => (
    item === 'active' ? Boolean(group.active) : item === 'recovery' ? Boolean(group.snapshot) : Boolean(group.history)
  ))
  const history = group.history
  const snapshot = group.snapshot
  return {
    id: meta.id,
    ...(meta.sdkSessionId ? { sdkSessionId: meta.sdkSessionId } : history?.sdkSessionId
      ? { sdkSessionId: history.sdkSessionId }
      : {}),
    title: meta.title,
    cwd: meta.cwd,
    ...(meta.sourceCwd ? { sourceCwd: meta.sourceCwd } : {}),
    status: group.active?.status ?? snapshot?.meta.status ?? 'closed',
    presence,
    createdAt: meta.createdAt,
    updatedAt: Math.max(meta.createdAt, history?.updatedAt ?? 0, snapshot?.updatedAt ?? 0),
    archived: history?.archived === true,
    pinned: history?.pinned === true,
    ...copyOptionalMeta(meta),
    model: meta.model,
    providerId: meta.providerId,
    ...(meta.engine ? { engine: meta.engine } : {}),
    taskStrategy: meta.taskStrategy ?? 'execute',
    permissionMode: meta.permissionMode,
    costUsd: meta.costUsd,
    lineage: {
      rootSessionId: meta.id,
      ancestorSessionIds: [],
      childSessionIds: [],
      depth: 0,
      cycleDetected: false
    },
    ...(snapshot ? {
      recovery: {
        snapshotId: snapshot.id,
        reason: snapshot.reason,
        updatedAt: snapshot.updatedAt,
        ...(snapshot.run ? { runStatus: snapshot.run.status } : {})
      }
    } : {}),
    transcriptHits: []
  }
}

function copyOptionalMeta(meta: SessionMeta | HistoryEntry) {
  return {
    ...(meta.parentSessionId ? { parentSessionId: meta.parentSessionId } : {}),
    ...(meta.orchestrationId ? { orchestrationId: meta.orchestrationId } : {}),
    ...(meta.childTaskId ? { childTaskId: meta.childTaskId } : {}),
    ...(meta.childRole ? { childRole: meta.childRole } : {}),
    ...(meta.projectId ? { projectId: meta.projectId } : {}),
    ...(meta.workspaceId ? { workspaceId: meta.workspaceId } : {}),
    ...(meta.goalId ? { goalId: meta.goalId } : {}),
    ...(meta.workItemId ? { workItemId: meta.workItemId } : {})
  }
}

function applyLineage(items: SessionQueryItem[], groups: SessionSourceGroup[]): void {
  const byId = new Map<string, SessionQueryItem>()
  items.forEach((item, index) => {
    byId.set(item.id, item)
    for (const alias of groups[index].ids) byId.set(alias, item)
  })
  for (const item of items) {
    if (!item.parentSessionId) continue
    const parent = byId.get(item.parentSessionId)
    if (parent && !parent.lineage.childSessionIds.includes(item.id)) parent.lineage.childSessionIds.push(item.id)
  }
  for (const item of items) {
    const ancestors: string[] = []
    const seen = new Set([item.id])
    let parentId = item.parentSessionId
    let cycleDetected = false
    while (parentId) {
      const parent = byId.get(parentId)
      const canonicalParentId = parent?.id ?? parentId
      if (seen.has(canonicalParentId)) {
        cycleDetected = true
        break
      }
      seen.add(canonicalParentId)
      ancestors.push(canonicalParentId)
      parentId = parent?.parentSessionId
    }
    item.lineage = {
      rootSessionId: ancestors.at(-1) ?? item.id,
      ancestorSessionIds: ancestors,
      childSessionIds: item.lineage.childSessionIds.sort(),
      depth: ancestors.length,
      cycleDetected
    }
  }
}

function matchesStructuralFilters(item: SessionQueryItem, input: SessionQueryInput): boolean {
  return matchesStateFilters(item, input) && matchesOwnershipFilters(item, input) &&
    matchesLineageAndTimeFilters(item, input)
}

function matchesStateFilters(item: SessionQueryItem, input: SessionQueryInput): boolean {
  if (!input.includeArchived && item.archived) return false
  if (input.statuses && !input.statuses.includes(item.status)) return false
  if (input.presence && !input.presence.some((presence) => item.presence.includes(presence))) return false
  return true
}

function matchesOwnershipFilters(item: SessionQueryItem, input: SessionQueryInput): boolean {
  if (input.workspaceId && item.workspaceId !== input.workspaceId) return false
  if (input.projectId && item.projectId !== input.projectId) return false
  if (input.goalId && item.goalId !== input.goalId) return false
  if (input.workItemId && item.workItemId !== input.workItemId) return false
  return true
}

function matchesLineageAndTimeFilters(item: SessionQueryItem, input: SessionQueryInput): boolean {
  if (input.parentSessionId && item.parentSessionId !== input.parentSessionId) return false
  if (input.rootsOnly && item.parentSessionId) return false
  if (input.updatedAfter !== undefined && item.updatedAt < input.updatedAfter) return false
  if (input.updatedBefore !== undefined && item.updatedAt > input.updatedBefore) return false
  return true
}

async function transcriptHitsFor(items: SessionQueryItem[], transcriptsDir: string, query: string) {
  const results = await searchTranscripts(
    transcriptsDir,
    items.flatMap((item) => item.sdkSessionId ? [{
      sdkSessionId: item.sdkSessionId,
      title: item.title,
      cwd: item.sourceCwd ?? item.cwd
    }] : []),
    query,
    { maxSessions: MAX_LIMIT, maxHitsPerSession: 3 }
  )
  return new Map(results.map((result) => [result.sdkSessionId, result.hits]))
}

function metadataText(item: SessionQueryItem): string {
  return [
    item.id, item.sdkSessionId, item.title, item.cwd, item.sourceCwd, item.parentSessionId,
    item.orchestrationId, item.childTaskId, item.childRole, item.projectId, item.workspaceId,
    item.goalId, item.workItemId, item.model, item.providerId, item.engine
  ].filter(Boolean).join('\n').toLocaleLowerCase()
}

function compareItems(left: SessionQueryItem, right: SessionQueryItem): number {
  return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)
}

function isAfterCursor(item: SessionQueryItem, cursor: QueryCursor): boolean {
  return item.updatedAt < cursor.updatedAt || (item.updatedAt === cursor.updatedAt && item.id > cursor.id)
}

function queryScopeHash(input: SessionQueryInput): string {
  const { cursor: _cursor, ...scope } = input
  return createHash('sha256').update(JSON.stringify(scope)).digest('hex').slice(0, 24)
}

function encodeCursor(item: SessionQueryItem, scopeHash: string): string {
  const cursor: QueryCursor = { version: 1, scopeHash, updatedAt: item.updatedAt, id: item.id }
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeCursor(encoded: string, scopeHash: string): QueryCursor {
  try {
    const raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown
    if (!isRecord(raw) || raw.version !== 1 || raw.scopeHash !== scopeHash ||
      typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > MAX_ID_LENGTH ||
      typeof raw.updatedAt !== 'number' || !Number.isSafeInteger(raw.updatedAt) || raw.updatedAt < 0) {
      throw new Error('invalid')
    }
    return raw as unknown as QueryCursor
  } catch {
    throw new Error('Session query cursor is invalid or belongs to a different query')
  }
}

function optionalLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_LIMIT) {
    throw new Error(`Session query limit must be an integer between 1 and ${MAX_LIMIT}`)
  }
  return value as number
}

function optionalString(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value !== value.trim() || value.length === 0 || value.length > maxLength ||
    /[\0-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value)) {
    throw new Error(`Session query ${label} is invalid`)
  }
  return value
}

function optionalEnumArray<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[]
): T[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > allowed.length ||
    value.some((item) => typeof item !== 'string' || !allowed.includes(item as T))) {
    throw new Error(`Session query ${label} is invalid`)
  }
  return [...new Set(value as T[])]
}

function optionalTimestamp(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Session query ${label} is invalid`)
  return value as number
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Session query ${label} must be boolean`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
