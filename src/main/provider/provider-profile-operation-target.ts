import type { EffectTarget } from '../../shared/effect-types'
import { getPersistedArtifactLifecycle } from '../task/artifact-lifecycle-api'
import {
  confirmed,
  unresolved,
  type EffectReconciliationResult
} from '../task/effect-reconciliation-result'
import { queryWorkflowEvidence } from '../task/workflow-ledger-api'
import { readTaskSnapshotDatabase } from '../task/task-snapshot'
import { findWorkflowAcceptance } from '../task/workflow-ledger-store'

export type ProviderProfileOperationTarget = Extract<EffectTarget, { kind: 'provider_profile_operation' }>

export function buildProviderProfileOperationTarget(
  input: Record<string, unknown>
): ProviderProfileOperationTarget {
  const target = input as Partial<ProviderProfileOperationTarget>
  const identifiers = [
    target.projectId,
    target.goalId,
    target.workItemId,
    target.runId,
    target.artifactId,
    target.evidenceId,
    target.acceptanceId
  ]
  if (target.kind !== 'provider_profile_operation' ||
      !isProviderProfileOperation(target.operation) || !isProviderProfileTransport(target.transport) ||
      !identifiers.every((value) => typeof value === 'string' && value.trim().length > 0) ||
      (target.operation === 'backup_delete' && !isSha256(target.backupIdDigest))) {
    throw new Error('Provider Profile operation EffectTarget is invalid')
  }
  return JSON.parse(JSON.stringify(target)) as ProviderProfileOperationTarget
}

export async function reconcileProviderProfileOperationTarget(
  target: ProviderProfileOperationTarget,
  rootDir?: string
): Promise<EffectReconciliationResult> {
  const lifecycle = await getPersistedArtifactLifecycle(target.artifactId, rootDir)
  if (!lifecycle) {
    return unresolved({
      kind: target.kind,
      operation: target.operation,
      transport: target.transport,
      artifactId: target.artifactId,
      reason: 'Provider Profile operation may have completed without committing its canonical report'
    })
  }
  const evidence = await queryWorkflowEvidence({ evidenceId: target.evidenceId, limit: 2 }, rootDir)
  const acceptance = await readTaskSnapshotDatabase(rootDir, (db) => findWorkflowAcceptance(db, target.acceptanceId))
  const valid = lifecycle.projectId === target.projectId && lifecycle.goalId === target.goalId &&
    lifecycle.workItemId === target.workItemId && lifecycle.runId === target.runId &&
    lifecycle.kind === 'report' && lifecycle.storageKind === 'blob' &&
    evidence.items.length === 1 && evidence.items[0].artifactId === target.artifactId &&
    evidence.items[0].runId === target.runId && acceptance?.status === 'passed' &&
    acceptance.evidenceRefs.length === 1 && acceptance.evidenceRefs[0] === target.evidenceId
  const observation = {
    kind: target.kind,
    operation: target.operation,
    transport: target.transport,
    artifactId: target.artifactId,
    lifecycleDigest: lifecycle.digest,
    sizeBytes: lifecycle.sizeBytes,
    evidenceDigest: evidence.items[0]?.digest,
    acceptanceStatus: acceptance?.status
  }
  return valid
    ? confirmed(observation, 'Provider Profile report, Evidence and Acceptance are committed')
    : unresolved({ ...observation, reason: 'Provider Profile report records differ from the frozen EffectTarget' })
}

function isProviderProfileOperation(value: unknown): value is ProviderProfileOperationTarget['operation'] {
  return value === 'profile_import' || value === 'backup_restore' ||
    value === 'backup_delete' || value === 'sync_publish' || value === 'sync_apply'
}

function isProviderProfileTransport(value: unknown): value is ProviderProfileOperationTarget['transport'] {
  return value === 'local' || value === 'folder' || value === 'webdav' || value === 's3'
}

function isSha256(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}
