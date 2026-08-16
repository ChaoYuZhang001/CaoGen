import { resolve } from 'node:path'
import type {
  DataPurgeBlocker,
  DataPurgeDecision,
  DataPurgeEvaluationInput,
  DataPurgeTarget,
  DataRetentionAuthorityView,
  DataRetentionSubject
} from '../../shared/data-lifecycle-types'
import {
  DataRetentionAuthorityStore,
  normalizeDataRetentionSubject,
  normalizeDataRetentionSubjects
} from './retention-authority-store'

export class DataRetentionBlockedError extends Error {
  readonly code = 'DATA_RETENTION_BLOCKED' as const
  constructor(readonly decision: DataPurgeDecision) {
    super(`Deletion request is queued by data retention authority: ${blockerSummary(decision.blockers)}`)
    this.name = 'DataRetentionBlockedError'
  }
}

export function readDataRetentionAuthority(userDataRoot: string): DataRetentionAuthorityView {
  return new DataRetentionAuthorityStore(requiredRoot(userDataRoot)).read()
}

export function evaluateDataPurge(
  userDataRoot: string,
  rawInput: DataPurgeEvaluationInput,
  nowInput = Date.now()
): DataPurgeDecision {
  const root = requiredRoot(userDataRoot)
  const input = normalizeEvaluationInput(rawInput)
  const now = positiveTimestamp(nowInput, 'evaluatedAt')
  const authority = new DataRetentionAuthorityStore(root).read()
  const holdSubjects = normalizeDataRetentionSubjects([
    ...input.targets.map((target) => target.subject),
    ...(input.relatedLegalHoldSubjects ?? [])
  ])
  const holdKeys = new Set(holdSubjects.map(subjectKey))
  const blockers: DataPurgeBlocker[] = []
  for (const hold of authority.legalHolds) {
    if (hold.status !== 'active') continue
    if (hold.subject.kind !== 'application' && !holdKeys.has(subjectKey(hold.subject))) continue
    blockers.push({
      kind: 'legal_hold',
      subject: structuredClone(hold.subject),
      holdId: hold.id,
      reason: hold.reason
    })
  }
  for (const target of input.targets) {
    const minimumRetentionMs = retentionFor(authority, target.subject)
    const earliestPurgeAt = safeTimestampAdd(target.retentionAnchorAt, minimumRetentionMs)
    if (now < earliestPurgeAt) {
      blockers.push({
        kind: 'minimum_retention',
        subject: structuredClone(target.subject),
        retentionAnchorAt: target.retentionAnchorAt,
        minimumRetentionMs,
        earliestPurgeAt
      })
    }
  }
  blockers.sort(compareBlockers)
  return {
    allowed: blockers.length === 0,
    evaluatedAt: now,
    authorityRevision: authority.revision,
    blockers
  }
}

export function assertDataPurgeAllowed(
  userDataRoot: string,
  input: DataPurgeEvaluationInput
): DataPurgeDecision {
  const decision = evaluateDataPurge(userDataRoot, input)
  if (!decision.allowed) throw new DataRetentionBlockedError(decision)
  return decision
}

export function isDataRetentionBlockedError(error: unknown): error is DataRetentionBlockedError {
  return error instanceof DataRetentionBlockedError || (
    Boolean(error) && typeof error === 'object' &&
    (error as { code?: unknown }).code === 'DATA_RETENTION_BLOCKED'
  )
}

export function normalizeDataPurgeTargets(values: readonly DataPurgeTarget[]): DataPurgeTarget[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 4_096) {
    throw new Error('data purge targets are invalid')
  }
  const byKey = new Map<string, DataPurgeTarget>()
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('data purge target is invalid')
    const subject = normalizeDataRetentionSubject(value.subject)
    if (subject.kind === 'application' || !subject.id) throw new Error('application data cannot be a purge target')
    const retentionAnchorAt = positiveTimestamp(value.retentionAnchorAt, 'retentionAnchorAt')
    const key = subjectKey(subject)
    const existing = byKey.get(key)
    if (existing && existing.retentionAnchorAt !== retentionAnchorAt) {
      throw new Error(`data purge target has conflicting retention anchors: ${key}`)
    }
    byKey.set(key, {
      subject: { kind: subject.kind, id: subject.id },
      retentionAnchorAt
    })
  }
  return [...byKey.values()].sort((left, right) => subjectKey(left.subject).localeCompare(subjectKey(right.subject)))
}

function normalizeEvaluationInput(input: DataPurgeEvaluationInput): DataPurgeEvaluationInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('data purge evaluation input is invalid')
  return {
    targets: normalizeDataPurgeTargets(input.targets),
    relatedLegalHoldSubjects: normalizeDataRetentionSubjects(input.relatedLegalHoldSubjects ?? [])
  }
}

function retentionFor(
  authority: DataRetentionAuthorityView,
  subject: DataPurgeTarget['subject']
): number {
  const override = authority.policy.subjectOverrides.find((candidate) =>
    candidate.subject.kind === subject.kind && candidate.subject.id === subject.id)
  if (override) return override.minimumRetentionMs
  return subject.kind === 'project'
    ? authority.policy.projectMinimumRetentionMs
    : authority.policy.sessionMinimumRetentionMs
}

function safeTimestampAdd(timestamp: number, duration: number): number {
  return timestamp > Number.MAX_SAFE_INTEGER - duration ? Number.MAX_SAFE_INTEGER : timestamp + duration
}

function blockerSummary(blockers: readonly DataPurgeBlocker[]): string {
  return blockers.map((blocker) => blocker.kind === 'legal_hold'
    ? `legal hold ${blocker.holdId} on ${subjectKey(blocker.subject)}`
    : `${subjectKey(blocker.subject)} retained until ${new Date(blocker.earliestPurgeAt).toISOString()}`
  ).join('; ')
}

function compareBlockers(left: DataPurgeBlocker, right: DataPurgeBlocker): number {
  const kind = left.kind.localeCompare(right.kind)
  if (kind !== 0) return kind
  const subject = subjectKey(left.subject).localeCompare(subjectKey(right.subject))
  if (subject !== 0) return subject
  if (left.kind === 'legal_hold' && right.kind === 'legal_hold') return left.holdId.localeCompare(right.holdId)
  return 0
}

function subjectKey(subject: DataRetentionSubject): string {
  return subject.kind === 'application' ? 'application' : `${subject.kind}:${subject.id}`
}

function positiveTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} is invalid`)
  return Number(value)
}

function requiredRoot(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('userDataRoot is required')
  return resolve(value)
}
