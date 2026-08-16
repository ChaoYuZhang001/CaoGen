import { isAbsolute, resolve } from 'node:path'
import type { EffectTarget } from '../shared/effect-types'
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
import { ProjectImportJournal } from './data-lifecycle/project-import-journal'
import { verifyProjectImport } from './data-lifecycle/project-import-coordinator'

export type ProjectPortableImportEffectTarget = Extract<EffectTarget, { kind: 'project_portable_import' }>

export function buildProjectPortableImportEffectTarget(
  input: Record<string, unknown>
): ProjectPortableImportEffectTarget {
  const target = input as Partial<ProjectPortableImportEffectTarget>
  const identifiers = [
    target.operationId,
    target.importedProjectId,
    target.projectId,
    target.goalId,
    target.workItemId,
    target.runId,
    target.artifactId,
    target.evidenceId,
    target.acceptanceId
  ]
  const digests = [target.exportDigest, target.sourceAggregateDigest]
  if (target.kind !== 'project_portable_import' || target.format !== 'caogen.project-aggregate.v1' ||
      !identifiers.every((value) => typeof value === 'string' && value.trim().length > 0) ||
      !digests.every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) {
    throw new Error('project portable import EffectTarget is invalid')
  }
  return JSON.parse(JSON.stringify(target)) as ProjectPortableImportEffectTarget
}

export async function reconcileProjectPortableImportEffectTarget(
  target: ProjectPortableImportEffectTarget,
  rootDir?: string
): Promise<EffectReconciliationResult> {
  const root = projectImportRoot(rootDir)
  if (!root) {
    return unresolved({
      kind: target.kind,
      operationId: target.operationId,
      importedProjectId: target.importedProjectId,
      reason: 'Project import private journal is not bound in this process'
    })
  }
  const entry = new ProjectImportJournal(root).getOperation(target.operationId)
  if (!entry) {
    return notApplied({
      kind: target.kind,
      operationId: target.operationId,
      importedProjectId: target.importedProjectId,
      state: 'missing'
    }, 'Project import journal does not exist, so the operation was not applied')
  }
  const observation = {
    kind: target.kind,
    operationId: target.operationId,
    importedProjectId: entry.projectId,
    phase: entry.phase,
    sourceDigest: entry.sourceDigest,
    exportDigest: entry.exportDigest,
    sourceAggregateDigest: entry.sourceAggregateDigest
  }
  if (entry.projectId !== target.importedProjectId || entry.exportDigest !== target.exportDigest ||
      entry.sourceAggregateDigest !== target.sourceAggregateDigest) {
    return unresolved({ ...observation, reason: 'Project import journal identity differs from EffectTarget' })
  }
  if (entry.phase !== 'completed') {
    return unresolved({ ...observation, reason: `Project import is not terminal:${entry.phase}` })
  }
  const result = await verifyProjectImport(root, target.operationId)
  const lifecycle = await getPersistedArtifactLifecycle(target.artifactId, root)
  const evidence = await queryWorkflowEvidence({ evidenceId: target.evidenceId, limit: 2 }, root)
  const acceptance = await readTaskSnapshotDatabase(root, (db) => findWorkflowAcceptance(db, target.acceptanceId))
  const valid = result.projectId === target.importedProjectId && result.exportDigest === target.exportDigest &&
    result.sourceAggregateDigest === target.sourceAggregateDigest && lifecycle?.projectId === target.projectId &&
    lifecycle.goalId === target.goalId && lifecycle.workItemId === target.workItemId &&
    lifecycle.runId === target.runId && lifecycle.kind === 'report' && lifecycle.storageKind === 'blob' &&
    evidence.items.length === 1 && evidence.items[0].artifactId === target.artifactId &&
    evidence.items[0].runId === target.runId && acceptance?.status === 'passed' &&
    acceptance.evidenceRefs.length === 1 && acceptance.evidenceRefs[0] === target.evidenceId
  return valid
    ? confirmed({ ...observation, artifactId: target.artifactId, acceptanceStatus: acceptance.status }, 'Project import and its report are committed')
    : unresolved({ ...observation, reason: 'Project import or its canonical report differs from the frozen EffectTarget' })
}

function projectImportRoot(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() && isAbsolute(value) ? resolve(value) : undefined
}
