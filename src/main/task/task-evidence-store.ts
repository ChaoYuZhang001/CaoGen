import { createHash } from 'node:crypto'
import type initSqlJs from 'sql.js'
import type { EffectRecord, EffectEvidenceRecord, TaskRunRecord } from '../../shared/types'
import { isTaskRunRecord } from './task-run'

type SqlJsStatic = Awaited<ReturnType<typeof initSqlJs>>
type SqlDatabase = InstanceType<SqlJsStatic['Database']>

const SCHEMA_VERSION = 1
const GENESIS_DIGEST = '0'.repeat(64)
const EVIDENCE_KINDS = new Set<EffectEvidenceRecord['kind']>([
  'prepared',
  'executing',
  'execution_result',
  'reconciliation',
  'retry_authorized',
  'manual_confirmation',
  'compensation'
])

export interface TaskEvidenceScope {
  sessionId?: string
  runId?: string
  taskId?: string
  effectId?: string
  projectId?: string
  operationId?: string
}

export interface TaskEvidenceProjectContext {
  sessionId: string
  projectId?: string
}

export interface TaskEvidenceRecord {
  schemaVersion: 1
  seq: number
  id: string
  evidenceId: string
  sessionId: string
  runId: string
  taskId: string
  effectId: string
  operationId?: string
  projectId?: string
  kind: EffectEvidenceRecord['kind']
  generation: number
  observedAt: number
  verifier: string
  evidenceDigest: string
  effectKey: string
  targetDigest: string
  prevDigest: string
  digest: string
}

export interface TaskEvidenceVerification {
  valid: true
  count: number
  lastSeq: number
  lastDigest: string
}

export class TaskEvidenceCorruptionError extends Error {
  readonly code = 'TASK_EVIDENCE_CORRUPTION'
  readonly seq?: number

  constructor(reason: string, seq?: number) {
    super(`Task evidence ledger corruption${seq === undefined ? '' : ` at seq=${seq}`}: ${reason}`)
    this.name = 'TaskEvidenceCorruptionError'
    this.seq = seq
  }
}

export function setupTaskEvidenceSchema(db: SqlDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS task_evidence (
      seq INTEGER PRIMARY KEY,
      evidence_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      effect_id TEXT NOT NULL,
      operation_id TEXT,
      project_id TEXT,
      kind TEXT NOT NULL,
      generation INTEGER NOT NULL,
      observed_at INTEGER NOT NULL,
      verifier TEXT NOT NULL,
      evidence_digest TEXT NOT NULL,
      effect_key TEXT NOT NULL,
      target_digest TEXT NOT NULL,
      prev_digest TEXT NOT NULL,
      record_digest TEXT NOT NULL,
      payload TEXT NOT NULL
    );
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_task_evidence_session ON task_evidence(session_id, seq);')
  db.run('CREATE INDEX IF NOT EXISTS idx_task_evidence_run ON task_evidence(run_id, seq);')
  db.run('CREATE INDEX IF NOT EXISTS idx_task_evidence_effect ON task_evidence(effect_id, seq);')
}

/**
 * Append every previously unseen Effect evidence item for a TaskRun.
 * The caller must persist the same in-memory SQLite database only after this
 * function returns; an invalid existing chain therefore prevents the whole
 * durability barrier from reaching disk.
 */
export function appendTaskRunEvidence(
  db: SqlDatabase,
  run: TaskRunRecord,
  projectId?: string
): boolean {
  return appendTaskRunsEvidence(db, [{ run, projectId }])
}

export function backfillTaskEvidence(
  db: SqlDatabase,
  runs: readonly TaskRunRecord[],
  contexts: readonly TaskEvidenceProjectContext[] = []
): boolean {
  const projectBySession = new Map<string, string>()
  for (const item of contexts) {
    const projectId = item.projectId?.trim()
    if (!projectId) continue
    const prior = projectBySession.get(item.sessionId)
    if (prior && prior !== projectId) {
      throw new TaskEvidenceCorruptionError(`session ${item.sessionId} has conflicting project bindings`)
    }
    projectBySession.set(item.sessionId, projectId)
  }
  return appendTaskRunsEvidence(
    db,
    runs.map((run) => ({ run, projectId: projectBySession.get(run.sessionId) }))
  )
}

export function selectTaskRunsForEvidence(db: SqlDatabase): TaskRunRecord[] {
  const runs: TaskRunRecord[] = []
  const stmt = db.prepare('SELECT id, payload FROM task_runs ORDER BY updated_at DESC')
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject()
      if (typeof row.payload !== 'string') throw new TaskEvidenceCorruptionError('TaskRun payload is not text')
      let parsed: unknown
      try { parsed = JSON.parse(row.payload) } catch { throw new TaskEvidenceCorruptionError('TaskRun payload is not valid JSON') }
      if (!isTaskRunRecord(parsed)) throw new TaskEvidenceCorruptionError(`TaskRun ${String(row.id)} schema validation failed`)
      runs.push(parsed)
    }
  } finally {
    stmt.free()
  }
  return runs
}

function appendTaskRunsEvidence(
  db: SqlDatabase,
  runs: readonly { run: TaskRunRecord; projectId?: string }[]
): boolean {
  const existing = readAndVerifyTaskEvidence(db)
  const byEvidenceId = new Map(existing.map((record) => [record.evidenceId, record]))
  const projectByRunId = projectBindingsFromEvidence(existing)
  let nextSeq = existing.at(-1)?.seq ?? 0
  let previousDigest = existing.at(-1)?.digest ?? GENESIS_DIGEST
  let appended = false

  for (const { run, projectId } of runs) {
    if (!isTaskRunRecord(run)) {
      throw new TaskEvidenceCorruptionError('candidate TaskRun schema validation failed')
    }
    const effectiveProjectId = projectId ?? projectByRunId.get(run.id)
    for (const effect of run.effects ?? []) {
      assertEffectOwnership(run, effect)
      for (const evidence of effect.evidence ?? []) {
        assertEvidenceGeneration(effect, evidence)
        const candidate = buildEvidenceRecord(run, effect, evidence, nextSeq + 1, previousDigest, effectiveProjectId)
        const prior = byEvidenceId.get(candidate.evidenceId)
        if (prior) {
          if (immutableEvidenceDigest(prior) !== immutableEvidenceDigest(candidate)) {
            throw new TaskEvidenceCorruptionError(
              `evidence id ${candidate.evidenceId} maps to different immutable content`,
              prior.seq
            )
          }
          continue
        }
        insertEvidence(db, candidate)
        byEvidenceId.set(candidate.evidenceId, candidate)
        nextSeq = candidate.seq
        previousDigest = candidate.digest
        appended = true
      }
    }
  }
  return appended
}

function projectBindingsFromEvidence(records: readonly TaskEvidenceRecord[]): Map<string, string> {
  const projects = new Map<string, string>()
  for (const record of records) {
    if (!record.projectId) continue
    const prior = projects.get(record.runId)
    if (prior && prior !== record.projectId) {
      throw new TaskEvidenceCorruptionError(`run ${record.runId} has conflicting project bindings`, record.seq)
    }
    projects.set(record.runId, record.projectId)
  }
  return projects
}

function assertEffectOwnership(run: TaskRunRecord, effect: EffectRecord): void {
  if (effect.sessionId !== run.sessionId || effect.runId !== run.id) {
    throw new TaskEvidenceCorruptionError(`effect ${effect.id} ownership does not match run ${run.id}`)
  }
}

function assertEvidenceGeneration(effect: EffectRecord, evidence: EffectEvidenceRecord): void {
  if (evidence.generation !== effect.generation) {
    throw new TaskEvidenceCorruptionError(`evidence ${evidence.id} generation does not match effect ${effect.id}`)
  }
}

export function selectTaskEvidence(
  db: SqlDatabase,
  scope: TaskEvidenceScope = {}
): TaskEvidenceRecord[] {
  return readAndVerifyTaskEvidence(db).filter((record) => matchesScope(record, scope))
}

export function verifyTaskEvidence(db: SqlDatabase): TaskEvidenceVerification {
  const records = readAndVerifyTaskEvidence(db)
  const last = records.at(-1)
  return {
    valid: true,
    count: records.length,
    lastSeq: last?.seq ?? 0,
    lastDigest: last?.digest ?? GENESIS_DIGEST
  }
}

function buildEvidenceRecord(
  run: TaskRunRecord,
  effect: EffectRecord,
  evidence: EffectEvidenceRecord,
  seq: number,
  prevDigest: string,
  projectIdOverride?: string
): TaskEvidenceRecord {
  const operation = taskEvidenceOperationContext(run)
  const explicitProjectId = projectIdOverride?.trim()
  if (explicitProjectId && operation.projectId && explicitProjectId !== operation.projectId) {
    throw new TaskEvidenceCorruptionError(`run ${run.id} has conflicting snapshot and operation project bindings`)
  }
  const projectId = explicitProjectId || operation.projectId
  const recordWithoutDigest = {
    schemaVersion: SCHEMA_VERSION as 1,
    seq,
    id: `evidence:${evidence.id}`,
    evidenceId: evidence.id,
    sessionId: run.sessionId,
    runId: run.id,
    taskId: run.taskId,
    effectId: effect.id,
    ...(operation.operationId ? { operationId: operation.operationId } : {}),
    ...(projectId ? { projectId } : {}),
    kind: evidence.kind,
    generation: evidence.generation,
    observedAt: evidence.observedAt,
    verifier: evidence.verifier,
    evidenceDigest: evidence.digest,
    effectKey: effect.effectKey,
    targetDigest: effect.targetDigest,
    prevDigest
  }
  return {
    ...recordWithoutDigest,
    digest: digest(recordWithoutDigest)
  }
}

function taskEvidenceOperationContext(run: TaskRunRecord): { operationId?: string; projectId?: string } {
  if (!run.operation) return {}
  const operationId = run.operation.operationId.trim()
  const sourceSessionId = run.operation.sourceSessionId.trim()
  const title = run.operation.title.trim()
  const projectId = run.operation.projectId?.trim()
  if (!operationId || !sourceSessionId || !title || (run.operation.projectId !== undefined && !projectId)) {
    throw new TaskEvidenceCorruptionError(`run ${run.id} operation metadata is incomplete`)
  }
  return { operationId, ...(projectId ? { projectId } : {}) }
}

function insertEvidence(db: SqlDatabase, record: TaskEvidenceRecord): void {
  const payloadRecord = recordWithoutDigest(record)
  if (!hasEvidencePayloadShape(payloadRecord as Record<string, unknown>)) {
    throw new TaskEvidenceCorruptionError('candidate evidence payload schema validation failed', record.seq)
  }
  const payload = canonicalJson(payloadRecord)
  db.run(
    `
      INSERT INTO task_evidence(
        seq, evidence_id, session_id, run_id, task_id, effect_id,
        operation_id, project_id, kind, generation, observed_at,
        verifier, evidence_digest, effect_key, target_digest,
        prev_digest, record_digest, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      record.seq,
      record.evidenceId,
      record.sessionId,
      record.runId,
      record.taskId,
      record.effectId,
      record.operationId ?? null,
      record.projectId ?? null,
      record.kind,
      record.generation,
      record.observedAt,
      record.verifier,
      record.evidenceDigest,
      record.effectKey,
      record.targetDigest,
      record.prevDigest,
      record.digest,
      payload
    ]
  )
}

function readAndVerifyTaskEvidence(db: SqlDatabase): TaskEvidenceRecord[] {
  const rows: TaskEvidenceRecord[] = []
  const stmt = db.prepare(
    'SELECT seq, evidence_id, session_id, run_id, task_id, effect_id, ' +
    'operation_id, project_id, kind, generation, observed_at, verifier, ' +
    'evidence_digest, effect_key, target_digest, prev_digest, record_digest, payload ' +
    'FROM task_evidence ORDER BY seq ASC'
  )
  try {
    while (stmt.step()) rows.push(decodeEvidenceRow(stmt.getAsObject()))
  } finally {
    stmt.free()
  }

  const seenIds = new Set<string>()
  let previousDigest = GENESIS_DIGEST
  for (let index = 0; index < rows.length; index += 1) {
    const record = rows[index]
    if (seenIds.has(record.evidenceId)) {
      throw new TaskEvidenceCorruptionError(`duplicate evidence id ${record.evidenceId}`, record.seq)
    }
    seenIds.add(record.evidenceId)
    if (record.seq !== index + 1) {
      throw new TaskEvidenceCorruptionError(`sequence is not contiguous: expected ${index + 1}`, record.seq)
    }
    if (record.prevDigest !== previousDigest) {
      throw new TaskEvidenceCorruptionError('previous digest does not match the chain', record.seq)
    }
    previousDigest = record.digest
  }
  return rows
}

function decodeEvidenceRow(row: Record<string, unknown>): TaskEvidenceRecord {
  if (typeof row.payload !== 'string') throw new TaskEvidenceCorruptionError('payload is not text')
  let parsed: unknown
  try {
    parsed = JSON.parse(row.payload) as unknown
  } catch {
    throw new TaskEvidenceCorruptionError('payload is not valid JSON', numeric(row.seq))
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TaskEvidenceCorruptionError('payload is not an object', numeric(row.seq))
  }
  const record = parsed as Record<string, unknown>
  const decoded = recordFromPayload(record)
  const seq = numeric(row.seq)
  if (seq === undefined || decoded.seq !== seq) throw new TaskEvidenceCorruptionError('SQL seq differs from payload', seq)
  const checks: Array<[string, unknown, unknown]> = [
    ['evidence_id', row.evidence_id, decoded.evidenceId],
    ['session_id', row.session_id, decoded.sessionId],
    ['run_id', row.run_id, decoded.runId],
    ['task_id', row.task_id, decoded.taskId],
    ['effect_id', row.effect_id, decoded.effectId],
    ['operation_id', nullable(row.operation_id), decoded.operationId],
    ['project_id', nullable(row.project_id), decoded.projectId],
    ['kind', row.kind, decoded.kind],
    ['generation', row.generation, decoded.generation],
    ['observed_at', row.observed_at, decoded.observedAt],
    ['verifier', row.verifier, decoded.verifier],
    ['evidence_digest', row.evidence_digest, decoded.evidenceDigest],
    ['effect_key', row.effect_key, decoded.effectKey],
    ['target_digest', row.target_digest, decoded.targetDigest],
    ['prev_digest', row.prev_digest, decoded.prevDigest]
  ]
  for (const [name, sqlValue, payloadValue] of checks) {
    if (sqlValue !== payloadValue) throw new TaskEvidenceCorruptionError(`SQL ${name} differs from payload`, seq)
  }
  const recordDigest = row.record_digest
  if (typeof recordDigest !== 'string' || recordDigest !== digest(recordFromPayload(record))) {
    throw new TaskEvidenceCorruptionError('record digest does not match payload', seq)
  }
  return { ...decoded, digest: recordDigest }
}

function recordFromPayload(record: Record<string, unknown>): Omit<TaskEvidenceRecord, 'digest'> {
  if (!hasEvidencePayloadShape(record)) {
    throw new TaskEvidenceCorruptionError('payload schema validation failed', numeric(record.seq))
  }
  return record as Omit<TaskEvidenceRecord, 'digest'>
}

function hasEvidencePayloadShape(record: Record<string, unknown>): boolean {
  const required = [
    record.schemaVersion === SCHEMA_VERSION,
    isPositiveInteger(record.seq),
    isNonEmptyString(record.id),
    isNonEmptyString(record.evidenceId),
    record.id === `evidence:${String(record.evidenceId)}`,
    isNonEmptyString(record.sessionId),
    isNonEmptyString(record.runId),
    isNonEmptyString(record.taskId),
    isNonEmptyString(record.effectId),
    isNonEmptyString(record.kind),
    EVIDENCE_KINDS.has(record.kind as EffectEvidenceRecord['kind']),
    isPositiveInteger(record.generation),
    isFiniteNumber(record.observedAt),
    isNonEmptyString(record.verifier),
    isNonEmptyString(record.evidenceDigest),
    isNonEmptyString(record.effectKey),
    isNonEmptyString(record.targetDigest),
    isNonEmptyString(record.prevDigest)
  ]
  const optional = [
    record.operationId === undefined || isNonEmptyString(record.operationId),
    record.projectId === undefined || isNonEmptyString(record.projectId)
  ]
  return required.every(Boolean) && optional.every(Boolean)
}

function recordWithoutDigest(record: TaskEvidenceRecord): Omit<TaskEvidenceRecord, 'digest'> {
  const { digest: _digest, ...withoutDigest } = record
  return withoutDigest
}

function immutableEvidenceDigest(record: TaskEvidenceRecord): string {
  return digest({
    evidenceId: record.evidenceId,
    sessionId: record.sessionId,
    runId: record.runId,
    taskId: record.taskId,
    effectId: record.effectId,
    operationId: record.operationId,
    projectId: record.projectId,
    kind: record.kind,
    generation: record.generation,
    observedAt: record.observedAt,
    verifier: record.verifier,
    evidenceDigest: record.evidenceDigest,
    effectKey: record.effectKey,
    targetDigest: record.targetDigest
  })
}

function matchesScope(record: TaskEvidenceRecord, scope: TaskEvidenceScope): boolean {
  return Object.entries(scope).every(([key, value]) => value === undefined || record[key as keyof TaskEvidenceRecord] === value)
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nullable(value: unknown): unknown {
  return value === null ? undefined : value
}
