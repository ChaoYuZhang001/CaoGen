import { dirname, join, resolve } from 'node:path'
import { listMigrationJournals } from './workflow-ledger-migration-storage'
import {
  WORKFLOW_LEDGER_MIGRATION_KIND,
  WORKFLOW_LEDGER_MIGRATION_VERSION,
  WorkflowLedgerMigrationError,
  type EnsureWorkflowLedgerTaskStoreReadyOptions,
  type PreparedWorkflowLedgerMigration,
  type WorkflowLedgerCanonicalReadinessReport
} from './workflow-ledger-migration-types'

const BACKUP_DIR = join('backups', 'workflow-ledger')

export async function findCommittedWorkflowLedgerMigration(
  options: EnsureWorkflowLedgerTaskStoreReadyOptions,
  targetPath: string
): Promise<PreparedWorkflowLedgerMigration | null> {
  const resolvedTarget = resolve(targetPath)
  const root = resolve(options.backupsRoot ?? join(dirname(resolvedTarget), BACKUP_DIR))
  const journals = await listMigrationJournals(root)
  const found = journals
    .filter(({ journal }) => journal.migrationKind === WORKFLOW_LEDGER_MIGRATION_KIND &&
      journal.migrationVersion === WORKFLOW_LEDGER_MIGRATION_VERSION &&
      journal.targetPath === resolvedTarget &&
      journal.toVersion <= options.targetStoreVersion &&
      journal.state === 'committed')
    .sort((left, right) =>
      right.journal.toVersion - left.journal.toVersion || right.journal.updatedAt - left.journal.updatedAt
    )[0]
  if (!found) return null
  return {
    migrationId: found.journal.migrationId,
    journalPath: found.path,
    backupPath: found.journal.backup.path,
    journal: found.journal,
    alreadyCommitted: true
  }
}

export function assertCommittedWorkflowLedgerTargetContinuity(input: {
  currentVersion: number
  current: WorkflowLedgerCanonicalReadinessReport
  committed: PreparedWorkflowLedgerMigration | null
}): void {
  if (!input.committed) return
  const committedVersion = input.committed.journal.toVersion
  if (input.currentVersion < committedVersion) {
    throw new WorkflowLedgerMigrationError(
      'COMMITTED_TARGET_VERSION_REGRESSION',
      `Committed migration target version regressed:${input.currentVersion} < ${committedVersion}`
    )
  }
  const prior = input.committed.journal.readiness
  if (!prior) {
    throw new WorkflowLedgerMigrationError('MIGRATION_JOURNAL_INVALID', 'Committed migration has no readiness evidence')
  }
  if (prior.storeId && input.current.storeId !== prior.storeId) {
    throw new WorkflowLedgerMigrationError(
      'COMMITTED_TARGET_IDENTITY_MISMATCH',
      'Committed migration target store identity changed'
    )
  }
  assertHighWaterNotRegressed(prior, input.current)
}

function assertHighWaterNotRegressed(
  prior: WorkflowLedgerCanonicalReadinessReport,
  current: WorkflowLedgerCanonicalReadinessReport
): void {
  const priorWorkflow = prior.verification?.workflowLedger
  const currentWorkflow = current.verification?.workflowLedger
  const priorEvidence = prior.verification?.taskEvidence
  const currentEvidence = current.verification?.taskEvidence
  const regressed = current.counts.workflowRuns < prior.counts.workflowRuns ||
    current.counts.taskRuns < prior.counts.taskRuns ||
    Boolean(priorWorkflow && (!currentWorkflow ||
      currentWorkflow.runs < priorWorkflow.runs ||
      currentWorkflow.events < priorWorkflow.events ||
      currentWorkflow.lastSeq < priorWorkflow.lastSeq)) ||
    Boolean(priorEvidence && (!currentEvidence ||
      currentEvidence.count < priorEvidence.count ||
      currentEvidence.lastSeq < priorEvidence.lastSeq))
  if (regressed) {
    throw new WorkflowLedgerMigrationError(
      'COMMITTED_TARGET_STATE_REGRESSION',
      'Committed migration target durable history regressed'
    )
  }
}
