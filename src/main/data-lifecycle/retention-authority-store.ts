import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  DataLegalHold,
  DataLegalHoldCreateInput,
  DataLegalHoldReleaseInput,
  DataRetentionAuditAction,
  DataRetentionAuditEvent,
  DataRetentionAuthorityView,
  DataRetentionPolicy,
  DataRetentionPolicyUpdateInput,
  DataRetentionSubject,
  DataRetentionSubjectOverride
} from '../../shared/data-lifecycle-types'
import { acquireFileLock, enqueueMutation, releaseFileLock } from '../digital-worker/persistence'
import { writeDurableFileSync } from '../durable-file'
import { withDataLifecycleMutation } from './data-lifecycle-mutation-lock'

const SCHEMA_VERSION = 1 as const
const MAX_MINIMUM_RETENTION_MS = 100 * 365 * 24 * 60 * 60 * 1000
const MAX_SUBJECT_OVERRIDES = 1_024
const MAX_REASON_LENGTH = 2_000
const MAX_ID_LENGTH = 512

interface DataRetentionAuthorityDocument extends DataRetentionAuthorityView {}

export class DataRetentionAuthorityStore {
  readonly filePath: string
  private readonly lockPath: string
  private readonly userDataRoot: string

  constructor(userDataRoot: string) {
    this.userDataRoot = requiredRoot(userDataRoot)
    this.filePath = join(this.userDataRoot, 'private', 'data-retention-authority.json')
    this.lockPath = `${this.filePath}.lock`
  }

  read(): DataRetentionAuthorityView {
    return clone(readDocument(this.filePath))
  }

  async updatePolicy(
    rawInput: DataRetentionPolicyUpdateInput,
    actorIdInput: string
  ): Promise<DataRetentionAuthorityView> {
    const input = normalizePolicyUpdate(rawInput)
    const actorId = requiredId(actorIdInput, 'actorId')
    const requestDigest = digest({
      action: 'policy_updated',
      projectMinimumRetentionMs: input.projectMinimumRetentionMs,
      sessionMinimumRetentionMs: input.sessionMinimumRetentionMs,
      subjectOverrides: input.subjectOverrides
    })
    return this.mutate(input.requestId, 'policy_updated', requestDigest, input.expectedRevision, (document) => {
      const now = Date.now()
      const policy: DataRetentionPolicy = {
        projectMinimumRetentionMs: input.projectMinimumRetentionMs,
        sessionMinimumRetentionMs: input.sessionMinimumRetentionMs,
        subjectOverrides: clone(input.subjectOverrides),
        updatedAt: now,
        updatedBy: actorId
      }
      const previousDigest = digest(document.policy)
      document.policy = policy
      return auditMutation(document, {
        action: 'policy_updated', actorId, requestId: input.requestId, requestDigest,
        previousDigest, nextDigest: digest(policy), createdAt: now
      })
    })
  }

  async createLegalHold(
    rawInput: DataLegalHoldCreateInput,
    actorIdInput: string
  ): Promise<DataRetentionAuthorityView> {
    const input = normalizeLegalHoldCreate(rawInput)
    const actorId = requiredId(actorIdInput, 'actorId')
    const requestDigest = digest({
      action: 'legal_hold_created', subject: input.subject, reason: input.reason
    })
    return this.mutate(input.requestId, 'legal_hold_created', requestDigest, input.expectedRevision, (document) => {
      const now = Date.now()
      const revision = document.revision + 1
      const hold: DataLegalHold = {
        id: `hold-${randomUUID()}`,
        requestId: input.requestId,
        subject: clone(input.subject),
        reason: input.reason,
        status: 'active',
        createdAt: now,
        createdBy: actorId,
        createdRevision: revision
      }
      const previousDigest = digest(document.legalHolds)
      document.legalHolds.push(hold)
      document.legalHolds.sort(compareHolds)
      return auditMutation(document, {
        action: 'legal_hold_created', actorId, requestId: input.requestId, requestDigest,
        subject: hold.subject, holdId: hold.id, previousDigest,
        nextDigest: digest(document.legalHolds), createdAt: now
      })
    })
  }

  async releaseLegalHold(
    rawInput: DataLegalHoldReleaseInput,
    actorIdInput: string
  ): Promise<DataRetentionAuthorityView> {
    const input = normalizeLegalHoldRelease(rawInput)
    const actorId = requiredId(actorIdInput, 'actorId')
    const requestDigest = digest({
      action: 'legal_hold_released', holdId: input.holdId, reason: input.reason
    })
    return this.mutate(input.requestId, 'legal_hold_released', requestDigest, input.expectedRevision, (document) => {
      const hold = document.legalHolds.find((candidate) => candidate.id === input.holdId)
      if (!hold) throw new Error(`data legal hold not found: ${input.holdId}`)
      if (hold.status === 'released') throw new Error(`data legal hold is already released: ${input.holdId}`)
      const now = Date.now()
      const previousDigest = digest(document.legalHolds)
      hold.status = 'released'
      hold.releasedAt = now
      hold.releasedBy = actorId
      hold.releaseReason = input.reason
      hold.releasedRevision = document.revision + 1
      return auditMutation(document, {
        action: 'legal_hold_released', actorId, requestId: input.requestId, requestDigest,
        subject: hold.subject, holdId: hold.id, previousDigest,
        nextDigest: digest(document.legalHolds), createdAt: now
      })
    })
  }

  private async mutate(
    requestId: string,
    action: DataRetentionAuditAction,
    requestDigest: string,
    expectedRevision: number,
    operation: (document: DataRetentionAuthorityDocument) => DataRetentionAuditEvent | undefined
  ): Promise<DataRetentionAuthorityView> {
    return withDataLifecycleMutation(this.userDataRoot, () => enqueueMutation(this.filePath, async () => {
      const lock = acquireFileLock(this.lockPath)
      try {
        const document = readDocument(this.filePath)
        const replay = document.audit.find((event) => event.requestId === requestId)
        if (replay) {
          if (replay.action !== action || replay.requestDigest !== requestDigest) {
            throw new Error(`data retention requestId conflicts with an existing mutation: ${requestId}`)
          }
          return clone(document)
        }
        if (document.revision !== expectedRevision) {
          throw new Error(`stale_revision: data retention authority is at ${document.revision}`)
        }
        const event = operation(document)
        if (!event) return clone(document)
        document.revision += 1
        if (event.revision !== document.revision || event.seq !== document.audit.length + 1) {
          throw new Error('data retention audit sequence is inconsistent')
        }
        document.audit.push(event)
        writeDocument(this.filePath, document)
        return clone(document)
      } finally {
        releaseFileLock(this.lockPath, lock)
      }
    }))
  }
}

function auditMutation(
  document: DataRetentionAuthorityDocument,
  input: Omit<DataRetentionAuditEvent, 'seq' | 'revision'>
): DataRetentionAuditEvent {
  return {
    seq: document.audit.length + 1,
    revision: document.revision + 1,
    ...clone(input)
  }
}

function readDocument(filePath: string): DataRetentionAuthorityDocument {
  if (!existsSync(filePath)) return emptyDocument()
  const stat = lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('data retention authority is not a regular file')
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
  assertDocument(parsed)
  return clone(parsed)
}

function writeDocument(filePath: string, document: DataRetentionAuthorityDocument): void {
  assertDocument(document)
  writeDurableFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
}

function emptyDocument(): DataRetentionAuthorityDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    policy: {
      projectMinimumRetentionMs: 0,
      sessionMinimumRetentionMs: 0,
      subjectOverrides: [],
      updatedAt: 0,
      updatedBy: 'system:default'
    },
    legalHolds: [],
    audit: []
  }
}

function assertDocument(value: unknown): asserts value is DataRetentionAuthorityDocument {
  if (!isRecord(value)) throw new Error('data retention authority is invalid')
  if (value.schemaVersion !== SCHEMA_VERSION || !nonNegativeInteger(value.revision) ||
      !Array.isArray(value.legalHolds) || !Array.isArray(value.audit)) {
    throw new Error('data retention authority is invalid')
  }
  assertPolicy(value.policy)
  const holds = value.legalHolds as unknown[]
  const holdIds = new Set<string>()
  const holdRequests = new Set<string>()
  for (const hold of holds) {
    assertLegalHold(hold)
    if (holdIds.has(hold.id) || holdRequests.has(hold.requestId)) {
      throw new Error('data retention authority contains duplicate legal holds')
    }
    holdIds.add(hold.id)
    holdRequests.add(hold.requestId)
  }
  const audit = value.audit as unknown[]
  const requests = new Set<string>()
  audit.forEach((event, index) => {
    assertAuditEvent(event, index + 1)
    if (requests.has(event.requestId)) throw new Error('data retention audit contains duplicate requests')
    requests.add(event.requestId)
  })
  if (value.revision !== audit.length) throw new Error('data retention revision does not match its audit chain')
  assertAuditContinuity(value as unknown as DataRetentionAuthorityDocument)
}

function assertAuditContinuity(document: DataRetentionAuthorityDocument): void {
  let policyDigest = digest(emptyDocument().policy)
  let holdsDigest = digest([])
  const holdsById = new Map(document.legalHolds.map((hold) => [hold.id, hold]))
  for (const event of document.audit) {
    if (event.action === 'policy_updated') {
      if (event.previousDigest !== policyDigest) throw new Error('data retention policy audit chain is broken')
      policyDigest = event.nextDigest
      continue
    }
    if (event.previousDigest !== holdsDigest) throw new Error('data legal hold audit chain is broken')
    holdsDigest = event.nextDigest
    if (!event.holdId || !event.subject) throw new Error('data legal hold audit event is incomplete')
    const hold = holdsById.get(event.holdId)
    if (!hold || hold.requestId !== (event.action === 'legal_hold_created' ? event.requestId : hold.requestId)) {
      throw new Error('data legal hold audit identity is inconsistent')
    }
    if (event.action === 'legal_hold_created' && hold.createdRevision !== event.revision) {
      throw new Error('data legal hold creation revision is inconsistent')
    }
    if (event.action === 'legal_hold_released' && hold.releasedRevision !== event.revision) {
      throw new Error('data legal hold release revision is inconsistent')
    }
  }
  if (policyDigest !== digest(document.policy) || holdsDigest !== digest(document.legalHolds)) {
    throw new Error('data retention authority does not match its audit chain')
  }
}

function assertPolicy(value: unknown): asserts value is DataRetentionPolicy {
  if (!isRecord(value) || !minimumRetention(value.projectMinimumRetentionMs) ||
      !minimumRetention(value.sessionMinimumRetentionMs) || !Array.isArray(value.subjectOverrides) ||
      value.subjectOverrides.length > MAX_SUBJECT_OVERRIDES || !nonNegativeTimestamp(value.updatedAt) ||
      !safeText(value.updatedBy, MAX_ID_LENGTH)) {
    throw new Error('data retention policy is invalid')
  }
  normalizeOverrides(value.subjectOverrides as DataRetentionSubjectOverride[])
}

function assertLegalHold(value: unknown): asserts value is DataLegalHold {
  if (!isRecord(value) || !safeText(value.id, MAX_ID_LENGTH) || !safeText(value.requestId, MAX_ID_LENGTH) ||
      !safeText(value.reason, MAX_REASON_LENGTH) || (value.status !== 'active' && value.status !== 'released') ||
      !positiveTimestamp(value.createdAt) || !safeText(value.createdBy, MAX_ID_LENGTH) ||
      !positiveInteger(value.createdRevision)) {
    throw new Error('data legal hold is invalid')
  }
  normalizeSubject(value.subject)
  if (value.status === 'active') {
    if (value.releasedAt !== undefined || value.releasedBy !== undefined ||
        value.releaseReason !== undefined || value.releasedRevision !== undefined) {
      throw new Error('active data legal hold contains release metadata')
    }
    return
  }
  if (!positiveTimestamp(value.releasedAt) || !safeText(value.releasedBy, MAX_ID_LENGTH) ||
      !safeText(value.releaseReason, MAX_REASON_LENGTH) || !positiveInteger(value.releasedRevision) ||
      value.releasedRevision < value.createdRevision) {
    throw new Error('released data legal hold is missing release metadata')
  }
}

function assertAuditEvent(value: unknown, expectedSeq: number): asserts value is DataRetentionAuditEvent {
  if (!isRecord(value) || value.seq !== expectedSeq || value.revision !== expectedSeq ||
      !safeText(value.requestId, MAX_ID_LENGTH) || !isDigest(value.requestDigest) ||
      !['policy_updated', 'legal_hold_created', 'legal_hold_released'].includes(String(value.action)) ||
      !safeText(value.actorId, MAX_ID_LENGTH) || !positiveTimestamp(value.createdAt) ||
      !isDigest(value.previousDigest) || !isDigest(value.nextDigest)) {
    throw new Error('data retention audit event is invalid')
  }
  if (value.subject !== undefined) normalizeSubject(value.subject)
  if (value.holdId !== undefined && !safeText(value.holdId, MAX_ID_LENGTH)) {
    throw new Error('data retention audit holdId is invalid')
  }
}

function normalizePolicyUpdate(input: DataRetentionPolicyUpdateInput): Required<DataRetentionPolicyUpdateInput> {
  return {
    requestId: requiredId(input.requestId, 'requestId'),
    expectedRevision: requiredRevision(input.expectedRevision),
    projectMinimumRetentionMs: requiredMinimumRetention(input.projectMinimumRetentionMs),
    sessionMinimumRetentionMs: requiredMinimumRetention(input.sessionMinimumRetentionMs),
    subjectOverrides: normalizeOverrides(input.subjectOverrides ?? [])
  }
}

function normalizeLegalHoldCreate(input: DataLegalHoldCreateInput): DataLegalHoldCreateInput {
  return {
    requestId: requiredId(input.requestId, 'requestId'),
    expectedRevision: requiredRevision(input.expectedRevision),
    subject: normalizeSubject(input.subject),
    reason: requiredReason(input.reason)
  }
}

function normalizeLegalHoldRelease(input: DataLegalHoldReleaseInput): DataLegalHoldReleaseInput {
  return {
    requestId: requiredId(input.requestId, 'requestId'),
    expectedRevision: requiredRevision(input.expectedRevision),
    holdId: requiredId(input.holdId, 'holdId'),
    reason: requiredReason(input.reason)
  }
}

export function normalizeDataRetentionSubject(value: DataRetentionSubject): DataRetentionSubject {
  return normalizeSubject(value)
}

export function normalizeDataRetentionSubjects(values: readonly DataRetentionSubject[]): DataRetentionSubject[] {
  if (!Array.isArray(values) || values.length > 4_096) throw new Error('data retention subjects are invalid')
  const byKey = new Map<string, DataRetentionSubject>()
  for (const value of values) {
    const subject = normalizeSubject(value)
    byKey.set(subjectKey(subject), subject)
  }
  return [...byKey.values()].sort(compareSubjects)
}

function normalizeSubject(value: unknown): DataRetentionSubject {
  if (!isRecord(value) || !['application', 'project', 'session'].includes(String(value.kind))) {
    throw new Error('data retention subject is invalid')
  }
  if (value.kind === 'application') {
    if (value.id !== undefined && value.id !== '') throw new Error('application retention subject must not include an ID')
    return { kind: 'application' }
  }
  return { kind: value.kind as 'project' | 'session', id: requiredId(value.id, `${value.kind} id`) }
}

function normalizeOverrides(values: readonly DataRetentionSubjectOverride[]): DataRetentionSubjectOverride[] {
  if (!Array.isArray(values) || values.length > MAX_SUBJECT_OVERRIDES) {
    throw new Error('data retention subject overrides are invalid')
  }
  const byKey = new Map<string, DataRetentionSubjectOverride>()
  for (const value of values) {
    if (!isRecord(value)) throw new Error('data retention subject override is invalid')
    const subject = normalizeSubject(value.subject)
    if (subject.kind === 'application' || !subject.id) throw new Error('application retention override is not supported')
    const key = subjectKey(subject)
    if (byKey.has(key)) throw new Error(`duplicate data retention override: ${key}`)
    byKey.set(key, {
      subject: { kind: subject.kind, id: subject.id },
      minimumRetentionMs: requiredMinimumRetention(value.minimumRetentionMs)
    })
  }
  return [...byKey.values()].sort((left, right) => compareSubjects(left.subject, right.subject))
}

function compareHolds(left: DataLegalHold, right: DataLegalHold): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id)
}

function compareSubjects(left: DataRetentionSubject, right: DataRetentionSubject): number {
  return subjectKey(left).localeCompare(subjectKey(right))
}

function subjectKey(subject: DataRetentionSubject): string {
  return subject.kind === 'application' ? 'application' : `${subject.kind}:${subject.id}`
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function requiredRoot(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('userDataRoot is required')
  return resolve(value)
}

function requiredId(value: unknown, label: string): string {
  if (!safeText(value, MAX_ID_LENGTH)) throw new Error(`${label} is required`)
  return (value as string).trim()
}

function requiredReason(value: unknown): string {
  if (!safeText(value, MAX_REASON_LENGTH)) throw new Error('legal hold reason is required')
  return (value as string).trim()
}

function requiredRevision(value: unknown): number {
  if (!nonNegativeInteger(value)) throw new Error('expectedRevision is invalid')
  return value
}

function requiredMinimumRetention(value: unknown): number {
  if (!minimumRetention(value)) throw new Error('minimum retention duration is invalid')
  return value
}

function safeText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= maxLength && !/[\0-\x1f\x7f]/.test(value)
}

function minimumRetention(value: unknown): value is number {
  return nonNegativeInteger(value) && value <= MAX_MINIMUM_RETENTION_MS
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function nonNegativeTimestamp(value: unknown): value is number {
  return nonNegativeInteger(value)
}

function positiveTimestamp(value: unknown): value is number {
  return positiveInteger(value)
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}
