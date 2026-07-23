import type { WorkflowLedgerReadMode } from './workflow-ledger-recovery'
import {
  WorkflowLedgerMigrationError,
  type WorkflowLedgerCanonicalReadinessReport
} from './workflow-ledger-migration-types'

export function workflowLedgerReadinessSupportsMode(
  report: Pick<WorkflowLedgerCanonicalReadinessReport, 'safeForShadowUse' | 'readyForCanonicalRead'>,
  readMode: WorkflowLedgerReadMode | undefined,
  requireShadowParity = false
): boolean {
  if (requireShadowParity && !report.safeForShadowUse) return false
  return readMode === 'canonical' ? report.readyForCanonicalRead : report.safeForShadowUse
}

export function assertWorkflowLedgerReadinessForMode(
  report: WorkflowLedgerCanonicalReadinessReport,
  readMode: WorkflowLedgerReadMode | undefined,
  requireShadowParity = false,
  errorCode = 'CANONICAL_READINESS_BLOCKED'
): void {
  if (workflowLedgerReadinessSupportsMode(report, readMode, requireShadowParity)) return
  const requirement = readMode === 'canonical' ? 'canonical read readiness' : 'legacy/canonical parity'
  const diagnostics = report.diagnostics
    .map((item) => `${item.code}${item.entityId ? `:${item.entityId}` : ''}`)
    .join(', ') || report.status
  throw new WorkflowLedgerMigrationError(errorCode, `Task store failed ${requirement}: ${diagnostics}`)
}

export function blockedWorkflowLedgerReadiness(
  report: WorkflowLedgerCanonicalReadinessReport
): WorkflowLedgerMigrationError {
  const diagnostics = report.diagnostics
    .map((item) => `${item.code}${item.entityId ? `:${item.entityId}` : ''}`)
    .join(', ') || report.status
  return new WorkflowLedgerMigrationError('CANONICAL_READINESS_BLOCKED', diagnostics)
}
