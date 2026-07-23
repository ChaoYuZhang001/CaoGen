import type {
  WorkflowEvidenceInput,
  WorkflowEvidenceKind,
  WorkflowEvidenceRecord,
  WorkflowEvidenceScope,
  WorkflowEvidenceSource,
  WorkflowEvidenceVerification,
  WorkflowLedgerPage
} from '../../shared/workflow-types'
import { canonicalJson, cursorOffset, digest, GENESIS_DIGEST, pageSize } from './workflow-ledger-codec'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'
import {
  assertWorkflowArtifactMetadataSafe,
  assertWorkflowArtifactUriSafe,
  assertWorkflowEvidenceTextSafe
} from './workflow-ledger-artifact-security'

const TABLE = 'workflow_evidence'
const SCHEMA_VERSION = 1
const EVIDENCE_ID_PREFIX = 'workflow-evidence:'
const MAX_LIST_RESULTS = 500

const EVIDENCE_KINDS: readonly WorkflowEvidenceKind[] = [
  'research_source',
  'review_result',
  'test_result',
  'approval',
  'observation',
  'metric',
  'security_scan',
  'delivery_check',
  'custom'
]

const EVIDENCE_SOURCES: readonly WorkflowEvidenceSource[] = [
  'runtime',
  'human',
  'imported',
  'recovery'
]

const INPUT_KEYS = new Set([
  'evidenceId', 'projectId', 'goalId', 'workItemId', 'runId', 'artifactId',
  'kind', 'source', 'title', 'summary', 'uri', 'mediaType', 'verifier',
  'observedAt', 'contentDigest', 'metadata'
])

const SCOPE_KEYS = new Set([
  'evidenceId', 'projectId', 'goalId', 'workItemId', 'runId', 'artifactId', 'kind',
  'limit', 'cursor'
])

const APPEND_OPTION_KEYS = new Set(['source', 'verifier', 'observedAt', 'createdAt'])

const PAYLOAD_KEYS = new Set([
  'schemaVersion', 'seq', 'id', ...INPUT_KEYS, 'createdAt', 'prevDigest'
])

const REQUIRED_PAYLOAD_KEYS = [
  'schemaVersion', 'seq', 'id', 'evidenceId', 'projectId', 'kind', 'source',
  'title', 'verifier', 'observedAt', 'contentDigest', 'createdAt', 'prevDigest'
] as const

const REQUIRED_COLUMNS = new Map<string, { type: string; notNull: boolean; primaryKey?: boolean }>([
  ['seq', { type: 'INTEGER', notNull: false, primaryKey: true }],
  ['id', { type: 'TEXT', notNull: true }],
  ['evidence_id', { type: 'TEXT', notNull: true }],
  ['project_id', { type: 'TEXT', notNull: true }],
  ['goal_id', { type: 'TEXT', notNull: false }],
  ['work_item_id', { type: 'TEXT', notNull: false }],
  ['run_id', { type: 'TEXT', notNull: false }],
  ['artifact_id', { type: 'TEXT', notNull: false }],
  ['kind', { type: 'TEXT', notNull: true }],
  ['source', { type: 'TEXT', notNull: true }],
  ['title', { type: 'TEXT', notNull: true }],
  ['summary', { type: 'TEXT', notNull: false }],
  ['uri', { type: 'TEXT', notNull: false }],
  ['media_type', { type: 'TEXT', notNull: false }],
  ['verifier', { type: 'TEXT', notNull: true }],
  ['observed_at', { type: 'INTEGER', notNull: true }],
  ['content_digest', { type: 'TEXT', notNull: true }],
  ['metadata_json', { type: 'TEXT', notNull: false }],
  ['created_at', { type: 'INTEGER', notNull: true }],
  ['prev_digest', { type: 'TEXT', notNull: true }],
  ['record_digest', { type: 'TEXT', notNull: true }],
  ['payload', { type: 'TEXT', notNull: true }]
])

export interface AppendWorkflowEvidenceOptions {
  /** Trusted main-process authority override; replaces any caller supplied value. */
  source?: WorkflowEvidenceSource
  /** Trusted main-process verifier identity; replaces any caller supplied value. */
  verifier?: string
  /** Trusted main-process observation time; replaces any caller supplied value. */
  observedAt?: number
  /** Main-process wall clock used only when creating a previously unseen record. */
  createdAt?: number
}

/** Set up the append-only evidence table and fail closed on a partial/incompatible table. */
export function setupWorkflowEvidenceSchema(db: WorkflowLedgerDatabase): void {
  if (tableExists(db)) assertColumnContract(db)
  db.run(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      seq INTEGER PRIMARY KEY CHECK(seq > 0),
      id TEXT NOT NULL UNIQUE,
      evidence_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      goal_id TEXT,
      work_item_id TEXT,
      run_id TEXT,
      artifact_id TEXT,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      uri TEXT,
      media_type TEXT,
      verifier TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      content_digest TEXT NOT NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      prev_digest TEXT NOT NULL,
      record_digest TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_evidence_project ON ${TABLE}(project_id, seq);
    CREATE INDEX IF NOT EXISTS idx_workflow_evidence_goal ON ${TABLE}(goal_id, seq);
    CREATE INDEX IF NOT EXISTS idx_workflow_evidence_work_item ON ${TABLE}(work_item_id, seq);
    CREATE INDEX IF NOT EXISTS idx_workflow_evidence_run ON ${TABLE}(run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_workflow_evidence_artifact ON ${TABLE}(artifact_id, seq);
    CREATE INDEX IF NOT EXISTS idx_workflow_evidence_kind ON ${TABLE}(kind, seq);
  `)
  assertColumnContract(db)
  assertUniqueContract(db, 'id')
  assertUniqueContract(db, 'evidence_id')
}

/**
 * Append one immutable evidence record. Replaying the same evidenceId with the
 * same normalized content returns the original record; conflicting content is
 * corruption and never appends a second row.
 */
export function appendWorkflowEvidence(
  db: WorkflowLedgerDatabase,
  input: WorkflowEvidenceInput,
  options: AppendWorkflowEvidenceOptions = {}
): WorkflowEvidenceRecord {
  const normalizedOptions = normalizeAppendOptions(options)
  const normalized = normalizeEvidenceInput(input, normalizedOptions)
  setupWorkflowEvidenceSchema(db)
  const records = readAndVerifyWorkflowEvidence(db)
  const existing = records.find((record) => record.evidenceId === normalized.evidenceId)
  if (existing) {
    const replay = buildEvidenceRecord(
      normalized,
      existing.seq,
      existing.prevDigest,
      existing.createdAt,
      normalized.observedAt ?? existing.observedAt
    )
    if (canonicalJson(withoutDigest(replay)) !== canonicalJson(withoutDigest(existing))) {
      throw new WorkflowLedgerCorruptionError(
        `workflow evidence id ${normalized.evidenceId} maps to different immutable content`,
        existing.seq
      )
    }
    return existing
  }

  const createdAt = normalizedTimestamp(normalizedOptions.createdAt ?? Date.now(), 'workflow evidence createdAt')
  const previous = records.at(-1)
  const record = buildEvidenceRecord(
    normalized,
    (previous?.seq ?? 0) + 1,
    previous?.digest ?? GENESIS_DIGEST,
    createdAt,
    normalized.observedAt ?? createdAt
  )
  insertEvidence(db, record)
  return record
}

/**
 * Backwards-compatible array read after verifying the complete persisted chain.
 * Unpaged callers receive the latest bounded window in append order; callers
 * that need completeness and continuation metadata should use selectWorkflowEvidence.
 */
export function listWorkflowEvidence(
  db: WorkflowLedgerDatabase,
  scope: WorkflowEvidenceScope = {}
): WorkflowEvidenceRecord[] {
  const normalizedScope = normalizeEvidenceScope(scope)
  const records = scopedWorkflowEvidence(db, normalizedScope)
  if (normalizedScope.limit !== undefined || normalizedScope.cursor !== undefined) {
    return pageWorkflowEvidence(records, normalizedScope).items
  }
  return records.slice(-MAX_LIST_RESULTS)
}

/** Read a complete evidence scope through the repository-standard page contract. */
export function selectWorkflowEvidence(
  db: WorkflowLedgerDatabase,
  scope: WorkflowEvidenceScope = {}
): WorkflowLedgerPage<WorkflowEvidenceRecord> {
  const normalizedScope = normalizeEvidenceScope(scope)
  return pageWorkflowEvidence(scopedWorkflowEvidence(db, normalizedScope), normalizedScope)
}

/** Internal integrity surface: verify and return the complete chain without the renderer list cap. */
export function readAllWorkflowEvidenceForIntegrity(
  db: WorkflowLedgerDatabase
): WorkflowEvidenceRecord[] {
  setupWorkflowEvidenceSchema(db)
  return readAndVerifyWorkflowEvidence(db)
}

/** Verify every row, duplicated SQL columns, sequence, and digest-chain link. */
export function verifyWorkflowEvidence(db: WorkflowLedgerDatabase): WorkflowEvidenceVerification {
  const records = readAllWorkflowEvidenceForIntegrity(db)
  const last = records.at(-1)
  return {
    valid: true,
    count: records.length,
    lastSeq: last?.seq ?? 0,
    lastDigest: last?.digest ?? GENESIS_DIGEST
  }
}

function normalizeEvidenceInput(
  input: WorkflowEvidenceInput,
  authority: NormalizedAppendOptions = {}
): NormalizedEvidenceInput {
  const record = strictRecord(input, 'workflow evidence input')
  assertKnownKeys(record, INPUT_KEYS, 'workflow evidence input')
  const kind = record.kind
  if (!EVIDENCE_KINDS.includes(kind as WorkflowEvidenceKind)) {
    throw new WorkflowLedgerCorruptionError('workflow evidence kind is invalid')
  }
  const source = authority.source ?? record.source ?? 'runtime'
  if (!EVIDENCE_SOURCES.includes(source as WorkflowEvidenceSource)) {
    throw new WorkflowLedgerCorruptionError('workflow evidence source is invalid')
  }
  const metadata = normalizeOptionalMetadata(record.metadata)
  assertWorkflowArtifactMetadataSafe(metadata, 'artifact metadata')
  const uri = optionalText(record.uri, 'workflow evidence uri')
  assertWorkflowArtifactUriSafe(uri)
  const title = requiredText(record.title, 'workflow evidence title')
  const summary = optionalText(record.summary, 'workflow evidence summary')
  const mediaType = optionalText(record.mediaType, 'workflow evidence mediaType')
  assertWorkflowEvidenceTextSafe(title, 'workflow evidence title')
  assertWorkflowEvidenceTextSafe(summary, 'workflow evidence summary')
  assertWorkflowEvidenceTextSafe(mediaType, 'workflow evidence media type')
  return {
    evidenceId: requiredText(record.evidenceId, 'workflow evidence evidenceId'),
    projectId: requiredText(record.projectId, 'workflow evidence projectId'),
    ...optionalField('goalId', optionalText(record.goalId, 'workflow evidence goalId')),
    ...optionalField('workItemId', optionalText(record.workItemId, 'workflow evidence workItemId')),
    ...optionalField('runId', optionalText(record.runId, 'workflow evidence runId')),
    ...optionalField('artifactId', optionalText(record.artifactId, 'workflow evidence artifactId')),
    kind: kind as WorkflowEvidenceKind,
    source: source as WorkflowEvidenceSource,
    title,
    ...optionalField('summary', summary),
    ...optionalField('uri', uri),
    ...optionalField('mediaType', mediaType),
    verifier: requiredText(authority.verifier ?? record.verifier, 'workflow evidence verifier'),
    ...optionalNumberField(
      'observedAt',
      authority.observedAt !== undefined
        ? authority.observedAt
        : record.observedAt === undefined
        ? undefined
        : normalizedTimestamp(record.observedAt, 'workflow evidence observedAt')
    ),
    contentDigest: contentDigest(record.contentDigest),
    ...optionalField('metadata', metadata)
  }
}

function normalizeAppendOptions(options: AppendWorkflowEvidenceOptions): NormalizedAppendOptions {
  const record = strictRecord(options, 'workflow evidence append options')
  assertKnownKeys(record, APPEND_OPTION_KEYS, 'workflow evidence append options')
  if (record.source !== undefined && !EVIDENCE_SOURCES.includes(record.source as WorkflowEvidenceSource)) {
    throw new WorkflowLedgerCorruptionError('workflow evidence authority source is invalid')
  }
  return {
    ...(record.source === undefined ? {} : { source: record.source as WorkflowEvidenceSource }),
    ...optionalField('verifier', optionalText(record.verifier, 'workflow evidence authority verifier')),
    ...optionalNumberField(
      'observedAt',
      record.observedAt === undefined
        ? undefined
        : normalizedTimestamp(record.observedAt, 'workflow evidence authority observedAt')
    ),
    ...optionalNumberField(
      'createdAt',
      record.createdAt === undefined
        ? undefined
        : normalizedTimestamp(record.createdAt, 'workflow evidence authority createdAt')
    )
  }
}

function normalizeEvidenceScope(scope: WorkflowEvidenceScope): WorkflowEvidenceScope {
  const record = strictRecord(scope, 'workflow evidence scope')
  assertKnownKeys(record, SCOPE_KEYS, 'workflow evidence scope')
  if (record.kind !== undefined && !EVIDENCE_KINDS.includes(record.kind as WorkflowEvidenceKind)) {
    throw new WorkflowLedgerCorruptionError('workflow evidence scope kind is invalid')
  }
  return {
    ...optionalField('evidenceId', optionalText(record.evidenceId, 'workflow evidence scope evidenceId')),
    ...optionalField('projectId', optionalText(record.projectId, 'workflow evidence scope projectId')),
    ...optionalField('goalId', optionalText(record.goalId, 'workflow evidence scope goalId')),
    ...optionalField('workItemId', optionalText(record.workItemId, 'workflow evidence scope workItemId')),
    ...optionalField('runId', optionalText(record.runId, 'workflow evidence scope runId')),
    ...optionalField('artifactId', optionalText(record.artifactId, 'workflow evidence scope artifactId')),
    ...(record.kind === undefined ? {} : { kind: record.kind as WorkflowEvidenceKind }),
    ...(record.limit === undefined ? {} : { limit: pageSize(record.limit as number) }),
    ...(record.cursor === undefined
      ? {}
      : { cursor: normalizedEvidenceCursor(record.cursor) })
  }
}

function buildEvidenceRecord(
  input: NormalizedEvidenceInput,
  seq: number,
  prevDigest: string,
  createdAt: number,
  observedAt: number
): WorkflowEvidenceRecord {
  const recordWithoutDigest: Omit<WorkflowEvidenceRecord, 'digest'> = {
    schemaVersion: SCHEMA_VERSION,
    seq: positiveSequence(seq),
    id: `${EVIDENCE_ID_PREFIX}${input.evidenceId}`,
    evidenceId: input.evidenceId,
    projectId: input.projectId,
    ...optionalField('goalId', input.goalId),
    ...optionalField('workItemId', input.workItemId),
    ...optionalField('runId', input.runId),
    ...optionalField('artifactId', input.artifactId),
    kind: input.kind,
    source: input.source,
    title: input.title,
    ...optionalField('summary', input.summary),
    ...optionalField('uri', input.uri),
    ...optionalField('mediaType', input.mediaType),
    verifier: input.verifier,
    observedAt: normalizedTimestamp(observedAt, 'workflow evidence observedAt'),
    contentDigest: input.contentDigest,
    ...optionalField('metadata', input.metadata),
    createdAt: normalizedTimestamp(createdAt, 'workflow evidence createdAt'),
    prevDigest: storedDigest(prevDigest, 'workflow evidence previous digest')
  }
  return { ...recordWithoutDigest, digest: digest(recordWithoutDigest) }
}

function insertEvidence(db: WorkflowLedgerDatabase, record: WorkflowEvidenceRecord): void {
  const payloadRecord = withoutDigest(record)
  const payload = canonicalJson(payloadRecord)
  db.run(
    `
      INSERT INTO ${TABLE}(
        seq, id, evidence_id, project_id, goal_id, work_item_id, run_id,
        artifact_id, kind, source, title, summary, uri, media_type, verifier,
        observed_at, content_digest, metadata_json, created_at, prev_digest,
        record_digest, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      record.seq,
      record.id,
      record.evidenceId,
      record.projectId,
      record.goalId ?? null,
      record.workItemId ?? null,
      record.runId ?? null,
      record.artifactId ?? null,
      record.kind,
      record.source,
      record.title,
      record.summary ?? null,
      record.uri ?? null,
      record.mediaType ?? null,
      record.verifier,
      record.observedAt,
      record.contentDigest,
      record.metadata === undefined ? null : canonicalJson(record.metadata),
      record.createdAt,
      record.prevDigest,
      record.digest,
      payload
    ]
  )
}

function readAndVerifyWorkflowEvidence(db: WorkflowLedgerDatabase): WorkflowEvidenceRecord[] {
  const records: WorkflowEvidenceRecord[] = []
  const stmt = db.prepare(`
    SELECT seq, id, evidence_id, project_id, goal_id, work_item_id, run_id,
           artifact_id, kind, source, title, summary, uri, media_type, verifier,
           observed_at, content_digest, metadata_json, created_at, prev_digest,
           record_digest, payload
    FROM ${TABLE}
    ORDER BY seq ASC
  `)
  try {
    while (stmt.step()) records.push(decodeEvidenceRow(stmt.getAsObject()))
  } finally {
    stmt.free()
  }

  const evidenceIds = new Set<string>()
  const ids = new Set<string>()
  let previousDigest = GENESIS_DIGEST
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.seq !== index + 1) {
      throw new WorkflowLedgerCorruptionError(`workflow evidence sequence is not contiguous; expected ${index + 1}`, record.seq)
    }
    if (evidenceIds.has(record.evidenceId)) {
      throw new WorkflowLedgerCorruptionError(`duplicate workflow evidence id ${record.evidenceId}`, record.seq)
    }
    if (ids.has(record.id)) {
      throw new WorkflowLedgerCorruptionError(`duplicate workflow evidence record id ${record.id}`, record.seq)
    }
    if (record.prevDigest !== previousDigest) {
      throw new WorkflowLedgerCorruptionError('workflow evidence previous digest does not match the chain', record.seq)
    }
    evidenceIds.add(record.evidenceId)
    ids.add(record.id)
    previousDigest = record.digest
  }
  return records
}

function decodeEvidenceRow(row: Record<string, unknown>): WorkflowEvidenceRecord {
  const seq = positiveSequence(row.seq)
  const payloadText = evidencePayloadText(row.payload, seq)
  const payload = decodeEvidencePayload(payloadText, seq)
  const decoded = evidenceRecordFromPayload(payload, seq)
  assertEvidencePayloadIdentity(payload, payloadText, decoded, seq)
  assertEvidenceSqlColumns(row, decoded, seq)
  return withStoredEvidenceDigest(row.record_digest, decoded, seq)
}

function evidencePayloadText(value: unknown, seq: number): string {
  if (typeof value !== 'string') {
    throw new WorkflowLedgerCorruptionError('workflow evidence payload is not text', seq)
  }
  return value
}

function decodeEvidencePayload(payloadText: string, seq: number): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(payloadText) as unknown
  } catch {
    throw new WorkflowLedgerCorruptionError('workflow evidence payload is not valid JSON', seq)
  }
  const payload = strictRecord(parsed, 'workflow evidence payload', seq)
  assertKnownKeys(payload, PAYLOAD_KEYS, 'workflow evidence payload', seq)
  assertRequiredEvidencePayloadKeys(payload, seq)
  if (canonicalJson(payload) !== payloadText) {
    throw new WorkflowLedgerCorruptionError('workflow evidence payload is not canonical JSON', seq)
  }
  return payload
}

function assertRequiredEvidencePayloadKeys(payload: Record<string, unknown>, seq: number): void {
  for (const key of REQUIRED_PAYLOAD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) {
      throw new WorkflowLedgerCorruptionError(`workflow evidence payload is missing ${key}`, seq)
    }
  }
}

function evidenceRecordFromPayload(
  payload: Record<string, unknown>,
  seq: number
): WorkflowEvidenceRecord {
  const normalized = normalizeEvidenceInput({
    evidenceId: payload.evidenceId as string,
    projectId: payload.projectId as string,
    goalId: payload.goalId as string | undefined,
    workItemId: payload.workItemId as string | undefined,
    runId: payload.runId as string | undefined,
    artifactId: payload.artifactId as string | undefined,
    kind: payload.kind as WorkflowEvidenceKind,
    source: payload.source as WorkflowEvidenceSource,
    title: payload.title as string,
    summary: payload.summary as string | undefined,
    uri: payload.uri as string | undefined,
    mediaType: payload.mediaType as string | undefined,
    verifier: payload.verifier as string,
    observedAt: payload.observedAt as number,
    contentDigest: payload.contentDigest as string,
    metadata: payload.metadata as Record<string, unknown> | undefined
  })
  return buildEvidenceRecord(
    normalized,
    positiveSequence(payload.seq),
    storedDigest(payload.prevDigest, 'workflow evidence payload previous digest', seq),
    normalizedTimestamp(payload.createdAt, 'workflow evidence payload createdAt', seq),
    normalizedTimestamp(payload.observedAt, 'workflow evidence payload observedAt', seq)
  )
}

function assertEvidencePayloadIdentity(
  payload: Record<string, unknown>,
  payloadText: string,
  decoded: WorkflowEvidenceRecord,
  seq: number
): void {
  if (payload.schemaVersion !== SCHEMA_VERSION) {
    throw new WorkflowLedgerCorruptionError('workflow evidence payload schema version is invalid', seq)
  }
  if (payload.id !== decoded.id) {
    throw new WorkflowLedgerCorruptionError('workflow evidence payload record id is invalid', seq)
  }
  if (canonicalJson(withoutDigest(decoded)) !== payloadText) {
    throw new WorkflowLedgerCorruptionError('workflow evidence payload is not normalized', seq)
  }
}

function assertEvidenceSqlColumns(
  row: Record<string, unknown>,
  decoded: WorkflowEvidenceRecord,
  seq: number
): void {
  const checks: Array<[string, unknown, unknown]> = [
    ['seq', row.seq, decoded.seq],
    ['id', row.id, decoded.id],
    ['evidence_id', row.evidence_id, decoded.evidenceId],
    ['project_id', row.project_id, decoded.projectId],
    ['goal_id', nullableColumn(row.goal_id), decoded.goalId],
    ['work_item_id', nullableColumn(row.work_item_id), decoded.workItemId],
    ['run_id', nullableColumn(row.run_id), decoded.runId],
    ['artifact_id', nullableColumn(row.artifact_id), decoded.artifactId],
    ['kind', row.kind, decoded.kind],
    ['source', row.source, decoded.source],
    ['title', row.title, decoded.title],
    ['summary', nullableColumn(row.summary), decoded.summary],
    ['uri', nullableColumn(row.uri), decoded.uri],
    ['media_type', nullableColumn(row.media_type), decoded.mediaType],
    ['verifier', row.verifier, decoded.verifier],
    ['observed_at', row.observed_at, decoded.observedAt],
    ['content_digest', row.content_digest, decoded.contentDigest],
    ['metadata_json', nullableColumn(row.metadata_json), decoded.metadata === undefined ? undefined : canonicalJson(decoded.metadata)],
    ['created_at', row.created_at, decoded.createdAt],
    ['prev_digest', row.prev_digest, decoded.prevDigest]
  ]
  for (const [column, sqlValue, payloadValue] of checks) {
    if (sqlValue !== payloadValue) {
      throw new WorkflowLedgerCorruptionError(`workflow evidence SQL ${column} differs from payload`, seq)
    }
  }
}

function withStoredEvidenceDigest(
  value: unknown,
  decoded: WorkflowEvidenceRecord,
  seq: number
): WorkflowEvidenceRecord {
  const recordDigest = storedDigest(value, 'workflow evidence record digest', seq)
  if (recordDigest !== decoded.digest) {
    throw new WorkflowLedgerCorruptionError('workflow evidence record digest does not match payload', seq)
  }
  return { ...decoded, digest: recordDigest }
}

function withoutDigest(record: WorkflowEvidenceRecord): Omit<WorkflowEvidenceRecord, 'digest'> {
  const { digest: _digest, ...rest } = record
  return rest
}

function scopedWorkflowEvidence(
  db: WorkflowLedgerDatabase,
  scope: WorkflowEvidenceScope
): WorkflowEvidenceRecord[] {
  return readAllWorkflowEvidenceForIntegrity(db)
    .filter((record) => matchesScope(record, scope))
}

function pageWorkflowEvidence(
  records: WorkflowEvidenceRecord[],
  scope: WorkflowEvidenceScope
): WorkflowLedgerPage<WorkflowEvidenceRecord> {
  const limit = pageSize(scope.limit)
  const offset = cursorOffset(scope.cursor)
  const items = records.slice(offset, offset + limit)
  const hasMore = offset + items.length < records.length
  return {
    items,
    total: records.length,
    hasMore,
    ...(hasMore ? { nextCursor: String(offset + items.length) } : {})
  }
}

function normalizedEvidenceCursor(value: unknown): string {
  if (typeof value !== 'string') {
    throw new WorkflowLedgerCorruptionError('workflow evidence scope cursor must be text')
  }
  const normalized = value.trim()
  cursorOffset(normalized)
  return normalized
}

function matchesScope(record: WorkflowEvidenceRecord, scope: WorkflowEvidenceScope): boolean {
  return (!scope.evidenceId || record.evidenceId === scope.evidenceId) &&
    (!scope.projectId || record.projectId === scope.projectId) &&
    (!scope.goalId || record.goalId === scope.goalId) &&
    (!scope.workItemId || record.workItemId === scope.workItemId) &&
    (!scope.runId || record.runId === scope.runId) &&
    (!scope.artifactId || record.artifactId === scope.artifactId) &&
    (!scope.kind || record.kind === scope.kind)
}

function tableExists(db: WorkflowLedgerDatabase): boolean {
  const stmt = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
  try {
    stmt.bind([TABLE])
    return stmt.step()
  } finally {
    stmt.free()
  }
}

function assertColumnContract(db: WorkflowLedgerDatabase): void {
  const rows = db.exec(`PRAGMA table_info(${TABLE})`)[0]?.values ?? []
  const columns = new Map<string, { type: string; notNull: boolean; primaryKey: boolean }>()
  for (const row of rows) {
    const name = row[1]
    const type = row[2]
    if (typeof name !== 'string' || typeof type !== 'string') continue
    columns.set(name, { type: type.toUpperCase(), notNull: row[3] === 1, primaryKey: row[5] === 1 })
  }
  for (const [name, expected] of REQUIRED_COLUMNS) {
    const actual = columns.get(name)
    if (!actual || actual.type !== expected.type || actual.notNull !== expected.notNull ||
        actual.primaryKey !== (expected.primaryKey ?? false)) {
      throw new WorkflowLedgerCorruptionError(`workflow evidence SQLite schema column ${name} is incompatible`)
    }
  }
}

function assertUniqueContract(db: WorkflowLedgerDatabase, column: string): void {
  const indexes = db.exec(`PRAGMA index_list(${TABLE})`)[0]?.values ?? []
  for (const row of indexes) {
    if (row[2] !== 1 || typeof row[1] !== 'string') continue
    const escapedName = row[1].replace(/'/g, "''")
    const info = db.exec(`PRAGMA index_info('${escapedName}')`)[0]?.values ?? []
    if (info.length === 1 && info[0]?.[2] === column) return
  }
  throw new WorkflowLedgerCorruptionError(`workflow evidence SQLite schema requires UNIQUE(${column})`)
}

function strictRecord(value: unknown, label: string, seq?: number): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkflowLedgerCorruptionError(`${label} must be an object`, seq)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WorkflowLedgerCorruptionError(`${label} must be a plain object`, seq)
  }
  return value as Record<string, unknown>
}

function assertKnownKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
  seq?: number
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new WorkflowLedgerCorruptionError(`${label} contains unsupported field ${key}`, seq)
  }
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new WorkflowLedgerCorruptionError(`${label} is required`)
  return value.trim()
}

function contentDigest(value: unknown): string {
  const normalized = requiredText(value, 'workflow evidence contentDigest')
  if (!/^[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new WorkflowLedgerCorruptionError('workflow evidence contentDigest must be 64 hexadecimal characters')
  }
  return normalized.toLowerCase()
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim()) throw new WorkflowLedgerCorruptionError(`${label} must be non-empty text`)
  return value.trim()
}

function normalizedTimestamp(value: unknown, label: string, seq?: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new WorkflowLedgerCorruptionError(`${label} must be a non-negative safe integer`, seq)
  }
  return value
}

function positiveSequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new WorkflowLedgerCorruptionError('workflow evidence sequence is invalid')
  }
  return value
}

function storedDigest(value: unknown, label: string, seq?: number): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new WorkflowLedgerCorruptionError(`${label} is invalid`, seq)
  }
  return value
}

function normalizeOptionalMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  const metadata = strictRecord(value, 'workflow evidence metadata')
  assertJsonValue(metadata, 'workflow evidence metadata', new Set<object>(), { nodes: 0 }, 0)
  return JSON.parse(canonicalJson(metadata)) as Record<string, unknown>
}

function assertJsonValue(
  value: unknown,
  label: string,
  seen: Set<object>,
  count: { nodes: number },
  depth: number
): void {
  count.nodes += 1
  if (count.nodes > 4096 || depth > 32) {
    throw new WorkflowLedgerCorruptionError(`${label} exceeds the supported JSON shape`)
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new WorkflowLedgerCorruptionError(`${label} contains a non-finite number`)
    return
  }
  if (typeof value !== 'object') {
    throw new WorkflowLedgerCorruptionError(`${label} must contain only JSON values`)
  }
  if (seen.has(value)) throw new WorkflowLedgerCorruptionError(`${label} must not be cyclic`)
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertJsonValue(item, label, seen, count, depth + 1)
      return
    }
    strictRecord(value, label)
    for (const child of Object.values(value)) assertJsonValue(child, label, seen, count, depth + 1)
  } finally {
    seen.delete(value)
  }
}

function nullableColumn(value: unknown): unknown {
  return value === null ? undefined : value
}

function optionalField<K extends string, T>(key: K, value: T | undefined): { [P in K]?: T } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: T }
}

function optionalNumberField<K extends string>(key: K, value: number | undefined): { [P in K]?: number } {
  return optionalField(key, value)
}

type NormalizedEvidenceInput = Omit<WorkflowEvidenceInput, 'source'> & {
  source: WorkflowEvidenceSource
}

type NormalizedAppendOptions = Pick<
  AppendWorkflowEvidenceOptions,
  'source' | 'verifier' | 'observedAt' | 'createdAt'
>
