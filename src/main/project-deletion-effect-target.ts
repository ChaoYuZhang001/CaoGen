import { isAbsolute, resolve } from 'node:path'
import type { EffectTarget } from '../shared/effect-types'
import { ProjectDeletionJournal } from './data-lifecycle/project-deletion-journal'
import { verifyProjectDeletionProof } from './data-lifecycle/project-deletion-coordinator'
import { getPersistedArtifactLifecycle } from './task/artifact-lifecycle-api'
import {
  confirmed,
  notApplied,
  unresolved,
  type EffectReconciliationResult
} from './task/effect-reconciliation-result'
import { queryWorkflowEvidence } from './task/workflow-ledger-api'
import { readTaskSnapshotDatabase } from './task/task-snapshot'
import { findWorkflowAcceptance } from './task/workflow-ledger-store'

export type ProjectPermanentDeletionEffectTarget = Extract<EffectTarget, { kind: 'project_permanent_deletion' }>

export function buildProjectPermanentDeletionEffectTarget(
  input: Record<string, unknown>
): ProjectPermanentDeletionEffectTarget {
  const target = input as Partial<ProjectPermanentDeletionEffectTarget>
  const identifiers = [
    target.deletionOperationId,
    target.deletedProjectId,
    target.projectId,
    target.goalId,
    target.workItemId,
    target.runId,
    target.artifactId,
    target.evidenceId,
    target.acceptanceId
  ]
  if (target.kind !== 'project_permanent_deletion' ||
      !identifiers.every((value) => typeof value === 'string' && value.trim().length > 0) ||
      !Number.isSafeInteger(target.expectedWorkspaceRevision) || Number(target.expectedWorkspaceRevision) < 1) {
    throw new Error('project permanent deletion EffectTarget is invalid')
  }
  return JSON.parse(JSON.stringify(target)) as ProjectPermanentDeletionEffectTarget
}

export async function reconcileProjectPermanentDeletionEffectTarget(
  target: ProjectPermanentDeletionEffectTarget,
  rootDir?: string
): Promise<EffectReconciliationResult> {
  const root = projectDeletionRoot(rootDir)
  if (!root) {
    return unresolved({
      kind: target.kind,
      deletionOperationId: target.deletionOperationId,
      deletedProjectId: target.deletedProjectId,
      reason: 'Project deletion private journal is not bound in this process'
    })
  }
  const entry = new ProjectDeletionJournal(root).getOperation(target.deletionOperationId)
  if (!entry) {
    return notApplied({
      kind: target.kind,
      deletionOperationId: target.deletionOperationId,
      deletedProjectId: target.deletedProjectId,
      state: 'missing'
    }, 'Project deletion journal does not exist, so the operation was not applied')
  }
  const observation = {
    kind: target.kind,
    deletionOperationId: target.deletionOperationId,
    deletedProjectId: entry.projectId,
    expectedWorkspaceRevision: entry.expectedWorkspaceRevision,
    phase: entry.phase,
    exportDigest: entry.exportDigest,
    proofDigest: entry.proofDigest
  }
  if (entry.projectId !== target.deletedProjectId || entry.expectedWorkspaceRevision !== target.expectedWorkspaceRevision) {
    return unresolved({ ...observation, reason: 'Project deletion journal identity differs from EffectTarget' })
  }
  if (entry.phase !== 'completed') {
    return unresolved({ ...observation, reason: `Project deletion is not terminal:${entry.phase}` })
  }
  const proof = await verifyProjectDeletionProof(root, target.deletionOperationId)
  const lifecycle = await getPersistedArtifactLifecycle(target.artifactId, root)
  const evidence = await queryWorkflowEvidence({ evidenceId: target.evidenceId, limit: 2 }, root)
  const acceptance = await readTaskSnapshotDatabase(root, (db) => findWorkflowAcceptance(db, target.acceptanceId))
  const valid = proof.proof.proofDigest === entry.proofDigest && lifecycle?.projectId === target.projectId &&
    lifecycle.goalId === target.goalId && lifecycle.workItemId === target.workItemId &&
    lifecycle.runId === target.runId && lifecycle.kind === 'report' && lifecycle.storageKind === 'blob' &&
    evidence.items.length === 1 && evidence.items[0].artifactId === target.artifactId &&
    evidence.items[0].runId === target.runId && acceptance?.status === 'passed' &&
    acceptance.evidenceRefs.length === 1 && acceptance.evidenceRefs[0] === target.evidenceId
  return valid
    ? confirmed({ ...observation, artifactId: target.artifactId, proofDigest: proof.proofDigest }, 'Project deletion proof and report are committed')
    : unresolved({ ...observation, reason: 'Project deletion or its canonical report differs from the frozen EffectTarget' })
}

function projectDeletionRoot(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() && isAbsolute(value) ? resolve(value) : undefined
}
