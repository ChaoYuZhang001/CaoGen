import type { EffectTarget } from '../shared/effect-types'
import {
  getPersistedArtifactLifecycle
} from './task/artifact-lifecycle-api'
import {
  confirmed,
  notApplied,
  unresolved,
  type EffectReconciliationResult
} from './task/effect-reconciliation-result'
import { queryWorkflowEvidence } from './task/workflow-ledger-api'
import { readTaskSnapshotDatabase } from './task/task-snapshot'
import { findWorkflowAcceptance } from './task/workflow-ledger-store'

export type ProjectPortableExportEffectTarget = Extract<EffectTarget, { kind: 'project_portable_export' }>

export function buildProjectPortableExportEffectTarget(
  input: Record<string, unknown>
): ProjectPortableExportEffectTarget {
  const target = input as Partial<ProjectPortableExportEffectTarget>
  const fields = [
    target.projectId,
    target.goalId,
    target.workItemId,
    target.runId,
    target.artifactId,
    target.evidenceId,
    target.acceptanceId
  ]
  if (target.kind !== 'project_portable_export' || target.format !== 'caogen.project-aggregate.v1' ||
      !fields.every((value) => typeof value === 'string' && value.trim().length > 0)) {
    throw new Error('project portable export EffectTarget is invalid')
  }
  return JSON.parse(JSON.stringify(target)) as ProjectPortableExportEffectTarget
}

export async function reconcileProjectPortableExportEffectTarget(
  target: ProjectPortableExportEffectTarget,
  rootDir?: string
): Promise<EffectReconciliationResult> {
  const lifecycle = await getPersistedArtifactLifecycle(target.artifactId, rootDir)
  if (!lifecycle) {
    return notApplied({
      kind: target.kind,
      artifactId: target.artifactId,
      state: 'missing'
    }, 'project export Artifact does not exist')
  }
  const evidence = await queryWorkflowEvidence({ evidenceId: target.evidenceId, limit: 2 }, rootDir)
  const acceptance = await readTaskSnapshotDatabase(rootDir, (db) => findWorkflowAcceptance(db, target.acceptanceId))
  const valid = lifecycle.projectId === target.projectId && lifecycle.goalId === target.goalId &&
    lifecycle.workItemId === target.workItemId && lifecycle.runId === target.runId &&
    lifecycle.kind === 'custom' && lifecycle.storageKind === 'blob' &&
    evidence.items.length === 1 && evidence.items[0].artifactId === target.artifactId &&
    evidence.items[0].runId === target.runId && acceptance?.status === 'passed' &&
    acceptance.evidenceRefs.length === 1 && acceptance.evidenceRefs[0] === target.evidenceId
  const observation = {
    kind: target.kind,
    artifactId: target.artifactId,
    lifecycleDigest: lifecycle.digest,
    sizeBytes: lifecycle.sizeBytes,
    evidenceDigest: evidence.items[0]?.digest,
    acceptanceStatus: acceptance?.status
  }
  return valid
    ? confirmed(observation, 'project export Artifact, Evidence and Acceptance are committed')
    : unresolved({ ...observation, reason: 'project export records differ from the frozen EffectTarget' })
}
