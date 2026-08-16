import { createHash } from 'node:crypto'
import type {
  DataRetentionAuthorityExport,
  DataRetentionAuthorityView,
  DataRetentionExportSubject,
  DataRetentionSubject
} from '../../shared/data-lifecycle-types'
import { redactSensitiveText } from '../security/secret-redaction'

export function buildDataRetentionAuthorityExport(
  authority: DataRetentionAuthorityView,
  exportedAt = Date.now()
): DataRetentionAuthorityExport {
  const body = {
    schemaVersion: 1 as const,
    format: 'caogen.data-retention-authority.export.v1' as const,
    exportedAt: requiredTimestamp(exportedAt),
    authorityRevision: authority.revision,
    authorityDigest: digest(authority),
    policy: {
      projectMinimumRetentionMs: authority.policy.projectMinimumRetentionMs,
      sessionMinimumRetentionMs: authority.policy.sessionMinimumRetentionMs,
      subjectOverrides: authority.policy.subjectOverrides.map((item) => ({
        subject: exportSubject(item.subject),
        minimumRetentionMs: item.minimumRetentionMs
      })),
      updatedAt: authority.policy.updatedAt,
      updatedByDigest: identityDigest(authority.policy.updatedBy)
    },
    legalHolds: authority.legalHolds.map((hold) => ({
      holdIdDigest: identityDigest(hold.id),
      requestIdDigest: identityDigest(hold.requestId),
      subject: exportSubject(hold.subject),
      reason: redactSensitiveText(hold.reason),
      status: hold.status,
      createdAt: hold.createdAt,
      createdByDigest: identityDigest(hold.createdBy),
      createdRevision: hold.createdRevision,
      ...(hold.releasedAt === undefined ? {} : { releasedAt: hold.releasedAt }),
      ...(hold.releasedBy === undefined ? {} : { releasedByDigest: identityDigest(hold.releasedBy) }),
      ...(hold.releaseReason === undefined ? {} : { releaseReason: redactSensitiveText(hold.releaseReason) }),
      ...(hold.releasedRevision === undefined ? {} : { releasedRevision: hold.releasedRevision })
    })),
    audit: authority.audit.map((event) => ({
      seq: event.seq,
      revision: event.revision,
      requestIdDigest: identityDigest(event.requestId),
      requestDigest: event.requestDigest,
      action: event.action,
      actorIdDigest: identityDigest(event.actorId),
      createdAt: event.createdAt,
      ...(event.subject === undefined ? {} : { subject: exportSubject(event.subject) }),
      ...(event.holdId === undefined ? {} : { holdIdDigest: identityDigest(event.holdId) }),
      previousDigest: event.previousDigest,
      nextDigest: event.nextDigest
    }))
  }
  return { ...body, exportDigest: digest(body) }
}

export function serializeDataRetentionAuthorityExport(value: DataRetentionAuthorityExport): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function exportSubject(subject: DataRetentionSubject): DataRetentionExportSubject {
  return subject.kind === 'application'
    ? { kind: 'application' }
    : { kind: subject.kind, idDigest: identityDigest(subject.id ?? '') }
}

function identityDigest(value: string): string {
  return createHash('sha256').update(`caogen-retention-identity-v1\0${value}`).digest('hex')
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function requiredTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('exportedAt is invalid')
  return value
}
