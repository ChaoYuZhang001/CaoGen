import { app } from 'electron'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { access, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { constants } from 'node:fs'
import initSqlJs from 'sql.js'
import type {
  AgentEvent,
  EffectRecord,
  EngineKind,
  SessionMeta,
  SessionStatus,
  TaskDagExecutionView,
  TaskDagRuntimeSnapshot,
  TaskSnapshotExecutionPosition,
  TaskSnapshotReason,
  TaskSnapshotRecord,
  TaskSnapshotReplayCandidate,
  TaskRunRecord,
  TaskSnapshotSubtaskState,
  TaskSnapshotSubtaskStatus,
  TaskSnapshotWorktreeInfo,
  TranscriptEntry,
  UsageTotals
} from '../../shared/types'
import { isTaskRunRecord, mergeTaskRunRecords } from './task-run'
import { stableValueDigest } from './tool-idempotency'

type SqlJsStatic = Awaited<ReturnType<typeof initSqlJs>>
type SqlDatabase = InstanceType<SqlJsStatic['Database']>

// Finder/Dock may launch the app with cwd="/"; resolve packaged WASM beside the bundled module.
const nodeRequire = createRequire(__filename)
const STORE_VERSION = 4
export const TASK_SNAPSHOT_EVENT_INTERVAL = 5
const TASK_SNAPSHOT_DB_FILE = 'task-snapshots.db'
const UNRESOLVED_EFFECT_STATUSES = new Set<EffectRecord['status']>([
  'prepared',
  'executing',
  'waiting_reconciliation'
])

interface TaskSnapshotFile {
  version: number
  snapshots: TaskSnapshotRecord[]
}

let sqlPromise: Promise<SqlJsStatic> | null = null
const mutationQueues = new Map<string, Promise<unknown>>()

export interface BuildTaskSnapshotInput {
  meta: SessionMeta
  transcript: TranscriptEntry[]
  lastSeq: number
  lastEventId?: string
  lastEventKind?: AgentEvent['kind']
  eventCount: number
  reason: TaskSnapshotReason
  run?: TaskRunRecord
  subtasks?: TaskSnapshotSubtaskState[]
  dagExecutions?: TaskDagExecutionView[]
  dagRuntimes?: TaskDagRuntimeSnapshot[]
  now?: number
}

export function taskSnapshotsFile(rootDir = app.getPath('userData')): string {
  return join(rootDir, 'task-snapshots.json')
}

export function taskSnapshotsDbFile(rootDir = app.getPath('userData')): string {
  return join(rootDir, TASK_SNAPSHOT_DB_FILE)
}

export function buildTaskSnapshot(input: BuildTaskSnapshotInput): TaskSnapshotRecord {
  const now = input.now ?? Date.now()
  const transcript = input.transcript.filter(isTranscriptEntry)
  const ids = latestTranscriptIds(transcript)
  const execution: TaskSnapshotExecutionPosition = {
    status: input.meta.status,
    lastSeq: input.lastSeq,
    cursor: { seq: input.lastSeq, eventId: input.lastEventId },
    lastEventId: input.lastEventId,
    lastEventKind: input.lastEventKind,
    lastEventAt: now,
    sdkSessionId: input.meta.sdkSessionId,
    resumeSessionAt: input.meta.resumeSessionAt,
    lastCheckpointMessageId: ids.lastCheckpointMessageId,
    lastUserMessageId: ids.lastUserMessageId
  }
  const worktree = worktreeFromMeta(input.meta)
  const projectPath = input.meta.sourceCwd ?? input.meta.cwd
  const replayCandidate = replayCandidateFromTranscript(transcript, input.meta.status, now)
  return {
    id: input.meta.id,
    taskId: input.meta.childTaskId ?? input.meta.id,
    sessionId: input.meta.id,
    title: input.meta.title,
    projectPath,
    engine: input.meta.engine,
    model: input.meta.model,
    providerId: input.meta.providerId,
    createdAt: input.meta.createdAt,
    updatedAt: now,
    eventCount: Math.max(0, Math.floor(input.eventCount)),
    reason: input.reason,
    meta: { ...input.meta },
    execution,
    ...(input.run ? { run: { ...input.run } } : {}),
    ...(replayCandidate ? { replayCandidate } : {}),
    ...(worktree ? { worktree } : {}),
    transcript,
    subtasks: (input.subtasks ?? []).filter(isSubtaskState),
    dagExecutions: (input.dagExecutions ?? []).filter(isTaskDagExecutionView),
    dagRuntimes: (input.dagRuntimes ?? []).filter(isTaskDagRuntimeSnapshot)
  }
}

export async function listTaskSnapshots(rootDir?: string): Promise<TaskSnapshotRecord[]> {
  await waitForPendingMutations(rootDir)
  return readStore(rootDir)
}

export async function getTaskSnapshot(snapshotId: string, rootDir?: string): Promise<TaskSnapshotRecord | null> {
  const id = snapshotId.trim()
  if (!id) return null
  await waitForPendingMutations(rootDir)
  return readStore(rootDir).then((snapshots) => snapshots.find((snapshot) => snapshot.id === id || snapshot.sessionId === id) ?? null)
}

export function saveTaskSnapshot(snapshot: TaskSnapshotRecord, rootDir?: string): Promise<TaskSnapshotRecord> {
  return enqueueMutation(rootDir, async () => {
    const store = await openStore(rootDir)
    try {
      const previous = findSnapshotInDb(store.db, snapshot.id, snapshot.sessionId)
      let nextSnapshot = previous ? mergeTaskSnapshots(previous, snapshot) : snapshot
      if (nextSnapshot.run) {
        const persistedRun = upsertTaskRun(store.db, nextSnapshot.run)
        nextSnapshot = {
          ...nextSnapshot,
          updatedAt: Math.max(nextSnapshot.updatedAt, persistedRun.updatedAt),
          run: persistedRun
        }
      }
      upsertSnapshot(store.db, nextSnapshot)
      await persistStore(store)
      return nextSnapshot
    } finally {
      store.db.close()
    }
  })
}

export function deleteTaskSnapshot(
  snapshotId: string,
  rootDir?: string,
  finalRun?: TaskRunRecord
): Promise<boolean> {
  const id = snapshotId.trim()
  if (!id) return Promise.resolve(false)
  return enqueueMutation(rootDir, async () => {
    const store = await openStore(rootDir)
    try {
      const previous = findSnapshotInDb(store.db, id, id)
      if (finalRun) upsertTaskRun(store.db, finalRun)
      if (!previous) {
        if (finalRun) await persistStore(store)
        return false
      }
      store.db.run('DELETE FROM task_snapshots WHERE id = ? OR session_id = ?', [id, id])
      await persistStore(store)
      return true
    } finally {
      store.db.close()
    }
  })
}

export async function listTaskRuns(sessionId?: string, rootDir?: string): Promise<TaskRunRecord[]> {
  await waitForPendingMutations(rootDir)
  const store = await openStore(rootDir)
  try {
    return selectTaskRuns(store.db, sessionId)
  } finally {
    store.db.close()
  }
}

/**
 * Write-ahead barrier for external effects. The returned promise resolves only
 * after the run and any matching recovery snapshot have reached durable storage.
 */
export function saveTaskRunBarrier(run: TaskRunRecord, rootDir?: string): Promise<TaskRunRecord> {
  return enqueueMutation(rootDir, async () => {
    const store = await openStore(rootDir)
    try {
      const persistedRuns = selectTaskRuns(store.db)
      const previous = persistedRuns.find((item) => item.id === run.id) ?? null
      const candidateRun = previous ? mergeTaskRunRecords(previous, run) : run
      const conflictingEffect = findConflictingEffectLease(persistedRuns, candidateRun)
      if (conflictingEffect) {
        throw new Error(
          `相同资源的外部效果在其他会话仍未收敛(${conflictingEffect.status})，已阻止第二个执行 lease`
        )
      }
      const matchingSnapshots = selectSnapshots(store.db).filter((snapshot) =>
        snapshot.sessionId === candidateRun.sessionId && (!snapshot.run || snapshot.run.id === candidateRun.id)
      )
      if (matchingSnapshots.length === 0) {
        throw new Error('效果持久化屏障缺少可恢复任务快照，已阻止外部执行')
      }
      const persistedRun = assignResourceFencingTokens(store.db, candidateRun, persistedRuns)
      upsertTaskRun(store.db, persistedRun)
      for (const snapshot of matchingSnapshots) {
        upsertSnapshot(store.db, {
          ...snapshot,
          updatedAt: Math.max(snapshot.updatedAt, persistedRun.updatedAt),
          run: snapshot.run ? mergeTaskRunRecords(snapshot.run, persistedRun) : persistedRun
        })
      }
      await persistStore(store)
      return persistedRun
    } finally {
      store.db.close()
    }
  })
}

function findConflictingEffectLease(
  persistedRuns: TaskRunRecord[],
  incomingRun: TaskRunRecord
): EffectRecord | undefined {
  const incoming = (incomingRun.effects ?? []).filter((effect) =>
    UNRESOLVED_EFFECT_STATUSES.has(effect.status)
  )
  if (incoming.length === 0) return undefined
  const incomingIds = new Set(incoming.map((effect) => effect.id))
  const incomingKeys = new Set(incoming.map(effectResourceKey))
  for (const persistedRun of persistedRuns) {
    for (const effect of persistedRun.effects ?? []) {
      if (incomingIds.has(effect.id)) continue
      if (!incomingKeys.has(effectResourceKey(effect))) continue
      if (UNRESOLVED_EFFECT_STATUSES.has(effect.status)) return effect
    }
  }
  return undefined
}

function assignResourceFencingTokens(
  db: SqlDatabase,
  incomingRun: TaskRunRecord,
  persistedRuns: TaskRunRecord[]
): TaskRunRecord {
  const persistedEffects = persistedRuns.flatMap((run) => run.effects ?? [])
  const persistedById = new Map(persistedEffects.map((effect) => [effect.id, effect]))
  const maxByResource = new Map<string, number>()
  for (const effect of persistedEffects) {
    if (!effect.lease) continue
    const resourceKey = effectResourceKey(effect)
    maxByResource.set(
      resourceKey,
      Math.max(maxByResource.get(resourceKey) ?? 0, effect.lease.fencingToken)
    )
  }

  let changed = false
  const effects = (incomingRun.effects ?? []).map((effect) => {
    if (!effect.lease) return effect
    const resourceKey = effectResourceKey(effect)
    const persistedEffect = persistedById.get(effect.id)
    const observedMax = Math.max(
      maxByResource.get(resourceKey) ?? 0,
      readResourceFencingToken(db, resourceKey)
    )
    const fencingToken = persistedEffect?.lease?.fencingToken ?? observedMax + 1
    const nextMax = Math.max(observedMax, fencingToken)
    maxByResource.set(resourceKey, nextMax)
    writeResourceFencingToken(db, resourceKey, nextMax)
    if (effect.lease.fencingToken === fencingToken) return effect
    changed = true
    return withFencingToken(effect, fencingToken)
  })
  return changed ? { ...incomingRun, effects } : incomingRun
}

function effectResourceKey(effect: EffectRecord): string {
  return effect.resourceKey || effect.effectKey
}

function readResourceFencingToken(db: SqlDatabase, resourceKey: string): number {
  const stmt = db.prepare(
    'SELECT fencing_token FROM effect_resource_fences WHERE resource_key = ? LIMIT 1'
  )
  try {
    stmt.bind([resourceKey])
    if (!stmt.step()) return 0
    const value = stmt.getAsObject().fencing_token
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
  } finally {
    stmt.free()
  }
}

function writeResourceFencingToken(db: SqlDatabase, resourceKey: string, fencingToken: number): void {
  db.run(
    `
      INSERT INTO effect_resource_fences(resource_key, fencing_token)
      VALUES (?, ?)
      ON CONFLICT(resource_key) DO UPDATE SET
        fencing_token = MAX(effect_resource_fences.fencing_token, excluded.fencing_token)
    `,
    [resourceKey, fencingToken]
  )
}

function withFencingToken(effect: EffectRecord, fencingToken: number): EffectRecord {
  if (!effect.lease) return effect
  const evidence = effect.evidence.map((item) =>
    item.kind === 'prepared' &&
    item.generation === effect.generation &&
    item.verifier === 'effect-ledger-v1'
      ? {
          ...item,
          digest: stableValueDigest({
            effectKey: effect.effectKey,
            resourceKey: effect.resourceKey,
            targetDigest: effect.targetDigest,
            intentDigest: effect.intentDigest,
            leaseId: effect.lease?.id,
            fencingToken
          })
        }
      : item
  )
  return { ...effect, lease: { ...effect.lease, fencingToken }, evidence }
}

export function supersedeToolExecution(
  executionId: string,
  replacementExecutionId: string,
  now = Date.now(),
  rootDir?: string
): Promise<boolean> {
  return enqueueMutation(rootDir, async () => {
    const store = await openStore(rootDir)
    try {
      let changed = false
      for (const run of selectTaskRuns(store.db)) {
        const updated = markToolExecutionSuperseded(run, executionId, replacementExecutionId, now)
        if (!updated) continue
        upsertTaskRun(store.db, updated)
        changed = true
      }
      for (const snapshot of selectSnapshots(store.db)) {
        if (!snapshot.run) continue
        const updatedRun = markToolExecutionSuperseded(
          snapshot.run,
          executionId,
          replacementExecutionId,
          now
        )
        if (!updatedRun) continue
        upsertSnapshot(store.db, {
          ...snapshot,
          updatedAt: Math.max(snapshot.updatedAt, now),
          run: updatedRun
        })
        changed = true
      }
      if (changed) await persistStore(store)
      return changed
    } finally {
      store.db.close()
    }
  })
}

export function flushTaskSnapshotMutations(rootDir?: string): Promise<void> {
  return waitForPendingMutations(rootDir)
}

async function readStore(rootDir?: string): Promise<TaskSnapshotRecord[]> {
  const store = await openStore(rootDir)
  try {
    return selectSnapshots(store.db)
  } finally {
    store.db.close()
  }
}

async function openStore(rootDir?: string): Promise<{ db: SqlDatabase; path: string }> {
  const SQL = await loadSql()
  const dbPath = taskSnapshotsDbFile(rootDir)
  await mkdir(dirname(dbPath), { recursive: true })
  const dbExists = await access(dbPath, constants.R_OK)
    .then(() => true)
    .catch(() => false)
  const db = dbExists ? new SQL.Database(await readFile(dbPath)) : new SQL.Database()
  const previousVersion = readStoreVersion(db)
  if (previousVersion > STORE_VERSION) {
    db.close()
    throw new Error(`任务快照数据库版本过新:${previousVersion} > ${STORE_VERSION}`)
  }
  setupSchema(db)
  const migratedLegacyJson = migrateLegacyJson(db, rootDir)
  if (migratedLegacyJson || (dbExists && previousVersion < STORE_VERSION)) {
    await persistStore({ db, path: dbPath })
  }
  return { db, path: dbPath }
}

async function persistStore(store: { db: SqlDatabase; path: string }): Promise<void> {
  const tmpPath = `${store.path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  try {
    const handle = await open(tmpPath, 'w')
    try {
      await handle.writeFile(store.db.export())
      await handle.sync()
    } finally {
      await handle.close()
    }
    await renameWithRetry(tmpPath, store.path)
    await syncParentDirectory(store.path)
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function syncParentDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(dirname(path), 'r').catch(() => null)
  if (!handle) return
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function renameWithRetry(tmpPath: string, targetPath: string): Promise<void> {
  const maxAttempts = process.platform === 'win32' ? 5 : 1
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rename(tmpPath, targetPath)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= maxAttempts || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
        throw error
      }
      await delay(20 * attempt)
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function setupSchema(db: SqlDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS task_snapshots (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_task_snapshots_session_id ON task_snapshots(session_id);')
  db.run('CREATE INDEX IF NOT EXISTS idx_task_snapshots_updated_at ON task_snapshots(updated_at);')
  db.run(`
    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_task_runs_session_id ON task_runs(session_id);')
  db.run('CREATE INDEX IF NOT EXISTS idx_task_runs_updated_at ON task_runs(updated_at);')
  db.run(`
    CREATE TABLE IF NOT EXISTS effect_resource_fences (
      resource_key TEXT PRIMARY KEY,
      fencing_token INTEGER NOT NULL
    );
  `)
  db.run('PRAGMA user_version = ' + STORE_VERSION)
}

function readStoreVersion(db: SqlDatabase): number {
  const result = db.exec('PRAGMA user_version')
  const value = result[0]?.values[0]?.[0]
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function migrateLegacyJson(db: SqlDatabase, rootDir?: string): boolean {
  if (tableRowCount(db, 'task_snapshots') > 0 || tableRowCount(db, 'task_runs') > 0) return false
  let migrated = false
  for (const snapshot of readLegacyJsonSnapshots(rootDir)) {
    if (snapshot.run) upsertTaskRun(db, snapshot.run)
    upsertSnapshot(db, snapshot)
    migrated = true
  }
  return migrated
}

function tableRowCount(db: SqlDatabase, table: 'task_snapshots' | 'task_runs'): number {
  const result = db.exec(`SELECT COUNT(*) FROM ${table}`)
  const value = result[0]?.values[0]?.[0]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function readLegacyJsonSnapshots(rootDir?: string): TaskSnapshotRecord[] {
  const file = taskSnapshotsFile(rootDir)
  try {
    if (!existsSync(file)) return []
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (Array.isArray(parsed)) return parsed.filter(isTaskSnapshotRecord)
    const record = asRecord(parsed)
    if (!record) return []
    const snapshots = record.snapshots
    return Array.isArray(snapshots) ? snapshots.filter(isTaskSnapshotRecord) : []
  } catch {
    return []
  }
}

function selectSnapshots(db: SqlDatabase): TaskSnapshotRecord[] {
  const snapshots: TaskSnapshotRecord[] = []
  const stmt = db.prepare('SELECT payload FROM task_snapshots ORDER BY updated_at DESC')
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject()
      const payload = row.payload
      if (typeof payload !== 'string') continue
      try {
        const parsed = JSON.parse(payload) as unknown
        if (isTaskSnapshotRecord(parsed)) snapshots.push(parsed)
      } catch {
        // 损坏行不阻断其他快照恢复。
      }
    }
  } finally {
    stmt.free()
  }
  return snapshots
}

function findSnapshotInDb(db: SqlDatabase, id: string, sessionId: string): TaskSnapshotRecord | null {
  const stmt = db.prepare('SELECT payload FROM task_snapshots WHERE id = ? OR session_id = ? LIMIT 1')
  try {
    stmt.bind([id, sessionId])
    if (!stmt.step()) return null
    const payload = stmt.getAsObject().payload
    if (typeof payload !== 'string') return null
    const parsed = JSON.parse(payload) as unknown
    return isTaskSnapshotRecord(parsed) ? parsed : null
  } catch {
    return null
  } finally {
    stmt.free()
  }
}

function upsertSnapshot(db: SqlDatabase, snapshot: TaskSnapshotRecord): void {
  const previous = findSnapshotInDb(db, snapshot.id, snapshot.sessionId)
  const next = previous ? mergeTaskSnapshots(previous, snapshot) : snapshot
  db.run(
    `
      INSERT INTO task_snapshots(id, session_id, updated_at, payload)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        updated_at = excluded.updated_at,
        payload = excluded.payload
    `,
    [next.id, next.sessionId, next.updatedAt, JSON.stringify(next)]
  )
}

function upsertTaskRun(db: SqlDatabase, run: TaskRunRecord): TaskRunRecord {
  const previous = findTaskRunInDb(db, run.id)
  const next = previous ? mergeTaskRunRecords(previous, run) : run
  db.run(
    `
      INSERT INTO task_runs(id, session_id, updated_at, payload)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        updated_at = excluded.updated_at,
        payload = excluded.payload
    `,
    [next.id, next.sessionId, next.updatedAt, JSON.stringify(next)]
  )
  return next
}

function findTaskRunInDb(db: SqlDatabase, id: string): TaskRunRecord | null {
  const stmt = db.prepare('SELECT payload FROM task_runs WHERE id = ? LIMIT 1')
  try {
    stmt.bind([id])
    if (!stmt.step()) return null
    const payload = stmt.getAsObject().payload
    if (typeof payload !== 'string') return null
    const parsed = JSON.parse(payload) as unknown
    return isTaskRunRecord(parsed) ? parsed : null
  } catch {
    return null
  } finally {
    stmt.free()
  }
}

function compareSnapshotFreshness(left: TaskSnapshotRecord, right: TaskSnapshotRecord): number {
  const leftCursor = left.execution.cursor?.seq ?? left.execution.lastSeq
  const rightCursor = right.execution.cursor?.seq ?? right.execution.lastSeq
  if (leftCursor !== rightCursor) return leftCursor - rightCursor
  const leftRevision = left.run?.revision ?? 0
  const rightRevision = right.run?.revision ?? 0
  if (leftRevision !== rightRevision) return leftRevision - rightRevision
  return left.updatedAt - right.updatedAt
}

function mergeTaskSnapshots(
  current: TaskSnapshotRecord,
  incoming: TaskSnapshotRecord
): TaskSnapshotRecord {
  const preferred = compareSnapshotFreshness(current, incoming) >= 0 ? current : incoming
  const other = preferred === current ? incoming : current
  const run = preferred.run && other.run
    ? mergeTaskRunRecords(preferred.run, other.run)
    : preferred.run ?? other.run
  return {
    ...preferred,
    createdAt: current.createdAt,
    updatedAt: Math.max(current.updatedAt, incoming.updatedAt, run?.updatedAt ?? 0),
    ...(run ? { run } : {})
  }
}

function selectTaskRuns(db: SqlDatabase, sessionId?: string): TaskRunRecord[] {
  const runs: TaskRunRecord[] = []
  const stmt = sessionId
    ? db.prepare('SELECT payload FROM task_runs WHERE session_id = ? ORDER BY updated_at DESC')
    : db.prepare('SELECT payload FROM task_runs ORDER BY updated_at DESC')
  try {
    if (sessionId) stmt.bind([sessionId])
    while (stmt.step()) {
      const payload = stmt.getAsObject().payload
      if (typeof payload !== 'string') continue
      try {
        const parsed = JSON.parse(payload) as unknown
        if (isTaskRunRecord(parsed)) runs.push(parsed)
      } catch {
        // 损坏 run 不阻断其他任务历史读取。
      }
    }
  } finally {
    stmt.free()
  }
  return runs
}

function markToolExecutionSuperseded(
  run: TaskRunRecord,
  executionId: string,
  replacementExecutionId: string,
  now: number
): TaskRunRecord | null {
  const executions = run.toolExecutions ?? []
  const index = executions.findIndex(
    (execution) => execution.id === executionId && execution.status === 'unknown_outcome'
  )
  if (index < 0) return null
  const toolExecutions = [...executions]
  toolExecutions[index] = {
    ...toolExecutions[index],
    status: 'superseded',
    supersededByExecutionId: replacementExecutionId,
    updatedAt: now,
    finishedAt: now,
    error: '未知结果已由用户确认后的成功重试取代'
  }
  return {
    ...run,
    revision: run.revision + 1,
    updatedAt: Math.max(run.updatedAt, now),
    toolExecutions
  }
}

function enqueueMutation<T>(rootDir: string | undefined, task: () => Promise<T>): Promise<T> {
  const key = taskSnapshotsDbFile(rootDir)
  const previous = mutationQueues.get(key) ?? Promise.resolve()
  const next = previous.then(task, task)
  const release = (): void => {
    if (mutationQueues.get(key) === queued) mutationQueues.delete(key)
  }
  const queued = next.then(release, release)
  mutationQueues.set(key, queued)
  return next
}

async function waitForPendingMutations(rootDir: string | undefined): Promise<void> {
  const pending = mutationQueues.get(taskSnapshotsDbFile(rootDir))
  if (pending) await pending.catch(() => undefined)
}

function loadSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: (file) =>
        file.endsWith('.wasm') ? nodeRequire.resolve('sql.js/dist/sql-wasm.wasm') : file
    })
  }
  return sqlPromise
}

function worktreeFromMeta(meta: SessionMeta): TaskSnapshotWorktreeInfo | undefined {
  const worktree: TaskSnapshotWorktreeInfo = {
    isolated: meta.isolated,
    sourceCwd: meta.sourceCwd,
    repoRoot: meta.repoRoot,
    worktreePath: meta.worktreePath,
    branch: meta.branch,
    baseBranch: meta.baseBranch,
    baseSha: meta.baseSha,
    state: meta.worktreeState
  }
  return Object.values(worktree).some((value) => value !== undefined) ? worktree : undefined
}

function latestTranscriptIds(transcript: TranscriptEntry[]): {
  lastCheckpointMessageId?: string
  lastUserMessageId?: string
} {
  let lastCheckpointMessageId: string | undefined
  let lastUserMessageId: string | undefined
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const event = transcript[index].event
    if (!lastCheckpointMessageId && event.kind === 'checkpoint') {
      lastCheckpointMessageId = event.messageId
    }
    if (!lastUserMessageId && event.kind === 'user-message') {
      lastUserMessageId = event.messageId
    }
    if (lastCheckpointMessageId && lastUserMessageId) break
  }
  return { lastCheckpointMessageId, lastUserMessageId }
}

function replayCandidateFromTranscript(
  transcript: TranscriptEntry[],
  status: SessionStatus,
  now: number
): TaskSnapshotReplayCandidate | undefined {
  if (status !== 'starting' && status !== 'running' && status !== 'error') return undefined
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index]
    const event = entry.event
    if (event.kind !== 'user-message') continue
    const text = event.text.trim()
    const messageId = event.messageId?.trim()
    if (!text || !messageId) return undefined
    const completedAfterUser = transcript
      .slice(index + 1)
      .some((next) => next.event.kind === 'turn-result' && next.event.isError === false)
    if (completedAfterUser) return undefined
    return {
      messageId,
      text,
      seq: entry.seq,
      capturedAt: now,
      reason: 'running-user-message'
    }
  }
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}

function isSessionStatus(value: unknown): value is SessionStatus {
  return (
    value === 'starting' ||
    value === 'running' ||
    value === 'idle' ||
    value === 'error' ||
    value === 'closed'
  )
}

function isEngineKind(value: unknown): value is EngineKind {
  return value === 'claude' || value === 'openai'
}

function isUsageTotals(value: unknown): value is UsageTotals {
  const record = asRecord(value)
  return (
    !!record &&
    typeof record.input === 'number' &&
    typeof record.output === 'number' &&
    typeof record.cacheRead === 'number' &&
    typeof record.cacheCreation === 'number'
  )
}

function isSessionMeta(value: unknown): value is SessionMeta {
  const record = asRecord(value)
  return (
    !!record &&
    isString(record.id) &&
    isString(record.title) &&
    isString(record.cwd) &&
    isString(record.model) &&
    isString(record.providerId) &&
    isSessionStatus(record.status) &&
    isString(record.permissionMode) &&
    isUsageTotals(record.usage) &&
    typeof record.costUsd === 'number' &&
    typeof record.contextTokens === 'number' &&
    typeof record.createdAt === 'number' &&
    (record.engine === undefined || isEngineKind(record.engine))
  )
}

function isTaskSnapshotReason(value: unknown): value is TaskSnapshotReason {
  return (
    value === 'created' ||
    value === 'important-event' ||
    value === 'event-batch' ||
    value === 'shutdown' ||
    value === 'recovered'
  )
}

function isAgentEvent(value: unknown): value is AgentEvent {
  const record = asRecord(value)
  if (!record || typeof record.kind !== 'string') return false
  return [
    'status',
    'init',
    'meta',
    'user-message',
    'checkpoint',
    'checkpoint-restore',
    'routing',
    'failover',
    'provider-key-failover',
    'text-delta',
    'thinking-delta',
    'tool-start',
    'assistant-message',
    'tool-result',
    'permission-request',
    'permission-resolved',
    'turn-result',
    'subagent-result',
    'task-dag-update',
    'hook-event'
  ].includes(record.kind)
}

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  const record = asRecord(value)
  return (
    !!record &&
    typeof record.seq === 'number' &&
    isOptionalString(record.eventId) &&
    isOptionalNumber(record.occurredAt) &&
    isOptionalString(record.streamId) &&
    isOptionalString(record.causationId) &&
    isOptionalString(record.correlationId) &&
    isAgentEvent(record.event)
  )
}

function isEventCursor(value: unknown): boolean {
  const record = asRecord(value)
  return (
    !!record &&
    typeof record.seq === 'number' &&
    Number.isInteger(record.seq) &&
    record.seq >= 0 &&
    isOptionalString(record.eventId)
  )
}

function isExecutionPosition(value: unknown): value is TaskSnapshotExecutionPosition {
  const record = asRecord(value)
  return (
    !!record &&
    isSessionStatus(record.status) &&
    typeof record.lastSeq === 'number' &&
    (record.cursor === undefined || isEventCursor(record.cursor)) &&
    isOptionalString(record.lastEventId) &&
    typeof record.lastEventAt === 'number' &&
    (record.lastEventKind === undefined || isAgentEvent({ kind: record.lastEventKind })) &&
    isOptionalString(record.sdkSessionId) &&
    isOptionalString(record.resumeSessionAt) &&
    isOptionalString(record.lastCheckpointMessageId) &&
    isOptionalString(record.lastUserMessageId)
  )
}

function isReplayCandidate(value: unknown): value is TaskSnapshotReplayCandidate {
  const record = asRecord(value)
  return (
    !!record &&
    isString(record.messageId) &&
    isString(record.text) &&
    typeof record.seq === 'number' &&
    typeof record.capturedAt === 'number' &&
    record.reason === 'running-user-message'
  )
}

function isWorktreeInfo(value: unknown): value is TaskSnapshotWorktreeInfo {
  const record = asRecord(value)
  return (
    !!record &&
    (record.isolated === undefined || typeof record.isolated === 'boolean') &&
    isOptionalString(record.sourceCwd) &&
    isOptionalString(record.repoRoot) &&
    isOptionalString(record.worktreePath) &&
    isOptionalString(record.branch) &&
    (record.baseBranch === undefined || record.baseBranch === null || typeof record.baseBranch === 'string') &&
    isOptionalString(record.baseSha) &&
    (record.state === undefined || record.state === 'active' || record.state === 'removed')
  )
}

function isSubtaskStatus(value: unknown): value is TaskSnapshotSubtaskStatus {
  return (
    value === 'pending' ||
    value === 'running' ||
    value === 'success' ||
    value === 'failed' ||
    value === 'closed'
  )
}

function isSubtaskState(value: unknown): value is TaskSnapshotSubtaskState {
  const record = asRecord(value)
  return (
    !!record &&
    isString(record.sessionId) &&
    isSubtaskStatus(record.status) &&
    isOptionalString(record.taskId) &&
    isOptionalString(record.role) &&
    isOptionalString(record.resultText) &&
    isOptionalNumber(record.costUsd) &&
    isOptionalString(record.branch) &&
    isOptionalString(record.worktreePath)
  )
}

function isTaskDagTask(value: unknown): boolean {
  const record = asRecord(value)
  return (
    !!record &&
    isString(record.id) &&
    isString(record.title) &&
    isString(record.description) &&
    Array.isArray(record.dependencies) &&
    record.dependencies.every(isString) &&
    isString(record.role) &&
    isString(record.prompt)
  )
}

function isTaskDag(value: unknown): boolean {
  const record = asRecord(value)
  return (
    !!record &&
    isString(record.id) &&
    isString(record.title) &&
    isString(record.source) &&
    (record.complexity === 'single' || record.complexity === 'multi') &&
    typeof record.createdAt === 'number' &&
    Array.isArray(record.tasks) &&
    record.tasks.every(isTaskDagTask)
  )
}

function isTaskDagTaskStatus(value: unknown): boolean {
  return value === 'waiting' || value === 'running' || value === 'success' || value === 'failed'
}

function isTaskDagExecutionTask(value: unknown): boolean {
  const record = asRecord(value)
  return (
    !!record &&
    isTaskDagTask(record.task) &&
    isTaskDagTaskStatus(record.status) &&
    typeof record.attempts === 'number' &&
    Array.isArray(record.sessionIds) &&
    record.sessionIds.every(isString) &&
    isOptionalNumber(record.startedAt) &&
    isOptionalNumber(record.completedAt) &&
    isOptionalString(record.resultText) &&
    isOptionalString(record.error)
  )
}

function isTaskDagExecutionView(value: unknown): value is TaskDagExecutionView {
  const record = asRecord(value)
  return (
    !!record &&
    isString(record.id) &&
    isString(record.parentSessionId) &&
    isTaskDag(record.dag) &&
    (record.status === 'waiting' ||
      record.status === 'running' ||
      record.status === 'success' ||
      record.status === 'failed') &&
    typeof record.maxRetries === 'number' &&
    typeof record.startedAt === 'number' &&
    isOptionalNumber(record.completedAt) &&
    Array.isArray(record.layers) &&
    record.layers.every((layer) => Array.isArray(layer) && layer.every(isString)) &&
    Array.isArray(record.tasks) &&
    record.tasks.every(isTaskDagExecutionTask) &&
    isOptionalString(record.summary) &&
    isOptionalString(record.error)
  )
}

function isTaskDagRuntimeDispatchOptions(value: unknown): boolean {
  const record = asRecord(value)
  return (
    !!record &&
    isOptionalString(record.cwd) &&
    (record.isolated === undefined || typeof record.isolated === 'boolean') &&
    isOptionalString(record.driveMode) &&
    isOptionalString(record.model) &&
    isOptionalString(record.providerId) &&
    (record.engine === undefined || isEngineKind(record.engine)) &&
    (record.permissionMode === undefined || isString(record.permissionMode)) &&
    typeof record.taskTimeoutMs === 'number'
  )
}

function isTaskDagRuntimeRunningTask(value: unknown): boolean {
  const record = asRecord(value)
  return !!record && isString(record.taskId) && isString(record.sessionId)
}

function isTaskDagRuntimeAutoMergeOptions(value: unknown): boolean {
  const record = asRecord(value)
  return (
    !!record &&
    typeof record.enabled === 'boolean' &&
    isOptionalString(record.verificationCommand)
  )
}

function isTaskDagRuntimeMergeSession(value: unknown): boolean {
  const record = asRecord(value)
  return (
    !!record &&
    isString(record.sessionId) &&
    isOptionalString(record.taskId) &&
    isOptionalString(record.repoRoot) &&
    isOptionalString(record.worktreePath) &&
    isOptionalString(record.baseSha) &&
    isOptionalString(record.branch) &&
    isOptionalString(record.resultText)
  )
}

function isTaskDagRuntimeSnapshot(value: unknown): value is TaskDagRuntimeSnapshot {
  const record = asRecord(value)
  return (
    !!record &&
    isString(record.executionId) &&
    isString(record.parentSessionId) &&
    typeof record.capturedAt === 'number' &&
    isTaskDagRuntimeDispatchOptions(record.dispatchOptions) &&
    Array.isArray(record.runningTasks) &&
    record.runningTasks.every(isTaskDagRuntimeRunningTask) &&
    (record.mergeSessions === undefined ||
      (Array.isArray(record.mergeSessions) && record.mergeSessions.every(isTaskDagRuntimeMergeSession))) &&
    (record.autoMerge === undefined || isTaskDagRuntimeAutoMergeOptions(record.autoMerge))
  )
}

function isTaskSnapshotRecord(value: unknown): value is TaskSnapshotRecord {
  const record = asRecord(value)
  return (
    !!record &&
    isString(record.id) &&
    isString(record.taskId) &&
    isString(record.sessionId) &&
    isString(record.title) &&
    isString(record.projectPath) &&
    (record.engine === undefined || isEngineKind(record.engine)) &&
    isString(record.model) &&
    isString(record.providerId) &&
    typeof record.createdAt === 'number' &&
    typeof record.updatedAt === 'number' &&
    typeof record.eventCount === 'number' &&
    isTaskSnapshotReason(record.reason) &&
    isSessionMeta(record.meta) &&
    isExecutionPosition(record.execution) &&
    (record.run === undefined || isTaskRunRecord(record.run)) &&
    (record.replayCandidate === undefined || isReplayCandidate(record.replayCandidate)) &&
    (record.worktree === undefined || isWorktreeInfo(record.worktree)) &&
    Array.isArray(record.transcript) &&
    record.transcript.every(isTranscriptEntry) &&
    Array.isArray(record.subtasks) &&
    record.subtasks.every(isSubtaskState) &&
    Array.isArray(record.dagExecutions) &&
    record.dagExecutions.every(isTaskDagExecutionView) &&
    (record.dagRuntimes === undefined ||
      (Array.isArray(record.dagRuntimes) && record.dagRuntimes.every(isTaskDagRuntimeSnapshot)))
  )
}
