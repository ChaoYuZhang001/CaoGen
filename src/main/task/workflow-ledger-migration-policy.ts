import {
  assertWorkflowLedgerReadinessForMode,
  blockedWorkflowLedgerReadiness
} from './workflow-ledger-migration-read-mode'
import type {
  WorkflowLedgerCanonicalReadinessReport,
  WorkflowLedgerMigrationMode
} from './workflow-ledger-migration-types'

const CANONICAL_SUPERSET_DIAGNOSTICS = new Set([
  'workflow_run_without_legacy_source',
  'workflow_recovery_without_legacy_source',
  'task_evidence_without_legacy_run'
])

export function selectMigrationMode(report: WorkflowLedgerCanonicalReadinessReport): WorkflowLedgerMigrationMode {
  if (report.safeForShadowUse || report.repairableAdditiveProjection) return 'shadow'
  if (report.readyForCanonicalRead || isRepairableCanonicalSuperset(report)) return 'canonical'
  throw blockedWorkflowLedgerReadiness(report)
}

function isRepairableCanonicalSuperset(report: WorkflowLedgerCanonicalReadinessReport): boolean {
  const hasCanonicalOnlyState = report.diagnostics.some((item) => CANONICAL_SUPERSET_DIAGNOSTICS.has(item.code))
  const hasAdditiveGap = report.diagnostics.some((item) => item.category === 'additive_projection')
  const hasOtherCorruption = report.diagnostics.some((item) =>
    item.category === 'corruption' && !CANONICAL_SUPERSET_DIAGNOSTICS.has(item.code)
  )
  return hasCanonicalOnlyState && hasAdditiveGap && !hasOtherCorruption
}

export function assertMigrationCandidateReadiness(
  report: WorkflowLedgerCanonicalReadinessReport,
  mode: WorkflowLedgerMigrationMode,
  errorCode = 'CANONICAL_READINESS_BLOCKED'
): void {
  const canonical = mode === 'canonical'
  assertWorkflowLedgerReadinessForMode(
    report,
    canonical ? 'canonical' : 'compare',
    !canonical,
    errorCode
  )
}
