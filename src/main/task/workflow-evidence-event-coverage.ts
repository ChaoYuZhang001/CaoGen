import type {
  WorkflowEventRecord,
  WorkflowEvidenceRecord
} from '../../shared/workflow-types'
import { digest } from './workflow-ledger-codec'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'

export function assertWorkflowEvidenceEventCoverage(
  records: readonly WorkflowEvidenceRecord[],
  events: readonly WorkflowEventRecord[]
): void {
  const eventsById = new Map(events.map((event) => [event.eventId, event]))
  for (const record of records) {
    const event = eventsById.get(`workflow:evidence-record:${record.evidenceId}`)
    if (!event) {
      throw new WorkflowLedgerCorruptionError(
        `workflow evidence ${record.evidenceId} is missing its verified Workflow event`,
        record.seq
      )
    }
    assertWorkflowEvidenceEventEnvelope(record, event)
  }
}

function assertWorkflowEvidenceEventEnvelope(
  record: WorkflowEvidenceRecord,
  event: WorkflowEventRecord
): void {
  const expected: Record<string, unknown> = {
    schemaVersion: 1,
    eventId: `workflow:evidence-record:${record.evidenceId}`,
    streamId: record.runId ? `run:${record.runId}` : `project:${record.projectId}`,
    entityType: 'system',
    entityId: record.evidenceId,
    kind: 'workflow.evidence.recorded',
    projectId: record.projectId,
    goalId: record.goalId,
    workItemId: record.workItemId,
    runId: record.runId,
    sessionId: undefined,
    occurredAt: record.createdAt,
    causationId: undefined,
    correlationId: record.runId ?? record.workItemId ?? record.goalId ?? record.evidenceId,
    payloadDigest: digest(record)
  }
  const actual: Record<string, unknown> = {
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    streamId: event.streamId,
    entityType: event.entityType,
    entityId: event.entityId,
    kind: event.kind,
    projectId: event.projectId,
    goalId: event.goalId,
    workItemId: event.workItemId,
    runId: event.runId,
    sessionId: event.sessionId,
    occurredAt: event.occurredAt,
    causationId: event.causationId,
    correlationId: event.correlationId,
    payloadDigest: digest(event.payload)
  }
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (actual[field] !== expectedValue) {
      throw new WorkflowLedgerCorruptionError(
        `workflow evidence ${record.evidenceId} Workflow event ${field} differs from source`,
        record.seq
      )
    }
  }
}
