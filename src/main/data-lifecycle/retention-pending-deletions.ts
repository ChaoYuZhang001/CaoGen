import type {
  DataPurgeEvaluationInput,
  DataRetentionPendingDeletion,
  DataRetentionPendingDeletionView
} from '../../shared/data-lifecycle-types'
import { ProjectDeletionJournal, type ProjectDeletionJournalEntry } from './project-deletion-journal'
import { evaluateDataPurge } from './retention-authority'
import { SessionDeletionJournal, type SessionDeletionJournalEntry } from './session-deletion-journal'

export function readDataRetentionPendingDeletions(
  userDataRoot: string,
  now = Date.now()
): DataRetentionPendingDeletionView {
  const projects = new ProjectDeletionJournal(userDataRoot).listPending().map((entry) =>
    pendingProject(userDataRoot, entry, now))
  const sessions = new SessionDeletionJournal(userDataRoot).listPending().map((entry) =>
    pendingSession(userDataRoot, entry, now))
  return {
    generatedAt: now,
    items: [...projects, ...sessions].sort((left, right) =>
      left.requestedAt - right.requestedAt || left.operationId.localeCompare(right.operationId))
  }
}

function pendingProject(
  root: string,
  entry: ProjectDeletionJournalEntry,
  now: number
): DataRetentionPendingDeletion {
  return pending(root, {
    kind: 'project',
    id: entry.projectId,
    operationId: entry.operationId,
    phase: entry.phase,
    requestedAt: entry.createdAt,
    input: {
      targets: entry.retentionTargets ?? [{
        subject: { kind: 'project', id: entry.projectId },
        retentionAnchorAt: entry.createdAt
      }],
      relatedLegalHoldSubjects: entry.legalHoldSubjects ?? [
        { kind: 'project', id: entry.projectId },
        ...entry.sessionIds.map((id) => ({ kind: 'session' as const, id }))
      ]
    }
  }, now)
}

function pendingSession(
  root: string,
  entry: SessionDeletionJournalEntry,
  now: number
): DataRetentionPendingDeletion {
  return pending(root, {
    kind: 'session',
    id: entry.sessionId,
    operationId: entry.operationId,
    phase: entry.phase,
    requestedAt: entry.createdAt,
    input: {
      targets: entry.retentionTargets ?? [{
        subject: { kind: 'session', id: entry.sessionId },
        retentionAnchorAt: entry.createdAt
      }],
      relatedLegalHoldSubjects: entry.legalHoldSubjects ?? [{ kind: 'session', id: entry.sessionId }]
    }
  }, now)
}

function pending(
  root: string,
  value: Omit<DataRetentionPendingDeletion, 'decision'> & { input: DataPurgeEvaluationInput },
  now: number
): DataRetentionPendingDeletion {
  const { input, ...identity } = value
  return { ...identity, decision: evaluateDataPurge(root, input, now) }
}
