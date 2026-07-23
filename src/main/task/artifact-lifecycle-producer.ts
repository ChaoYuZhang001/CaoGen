import type { EffectRecord, TaskRunRecord } from '../../shared/types'
import {
  getPersistedArtifactLifecycle,
  registerPersistedArtifactLifecycle
} from './artifact-lifecycle-api'
import { assertSha256Digest } from './artifact-lifecycle-content'
import type { ArtifactLifecycleRecord } from './artifact-lifecycle-types'
import { readTaskSnapshotDatabase } from './task-snapshot'
import { findWorkflowRun } from './workflow-ledger-store'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'

export async function registerConfirmedRunArtifactLifecycles(
  run: TaskRunRecord,
  rootDir?: string
): Promise<ArtifactLifecycleRecord[]> {
  const records: ArtifactLifecycleRecord[] = []
  for (const effect of run.effects ?? []) {
    if (!isConfirmedCodeForgePatchEffect(effect)) continue
    records.push(await registerCodeForgePatchLifecycle(run, effect, rootDir))
  }
  return records
}

type CodeForgePatchEffect = EffectRecord & {
  target: Extract<EffectRecord['target'], { kind: 'code_forge_patch' }>
}

function isConfirmedCodeForgePatchEffect(effect: EffectRecord): effect is CodeForgePatchEffect {
  return effect.status === 'confirmed' && effect.target.kind === 'code_forge_patch'
}

async function registerCodeForgePatchLifecycle(
  run: TaskRunRecord,
  effect: CodeForgePatchEffect,
  rootDir?: string
): Promise<ArtifactLifecycleRecord> {
  assertEffectOwnership(run, effect)
  const artifactId = `artifact:code-forge-patch:${effect.id}`
  const digest = assertSha256Digest(`sha256:${effect.target.patchSha256}`)
  const existing = await getPersistedArtifactLifecycle(artifactId, rootDir)
  if (existing) {
    assertExistingProducerArtifact(existing, run.id, digest, effect.target.artifactPath)
    return existing
  }
  const workflowRun = await readTaskSnapshotDatabase(rootDir, (db) => findWorkflowRun(db, run.id))
  if (!workflowRun?.projectId) {
    throw new WorkflowLedgerCorruptionError(
      `confirmed Code Forge Artifact lacks canonical Project-owned Run: ${run.id}`
    )
  }
  const registered = await registerPersistedArtifactLifecycle({
    id: artifactId,
    projectId: workflowRun.projectId,
    goalId: workflowRun.goalId,
    workItemId: workflowRun.workItemId,
    runId: workflowRun.id,
    lineageId: `lineage:code-forge-patch:${effect.id}`,
    kind: 'patch',
    title: 'Code Forge patch',
    version: 1,
    provenance: 'explicit',
    mediaType: 'text/x-diff',
    retention: { mode: 'retain' },
    content: {
      storageKind: 'source_ref',
      sourceRef: effect.target.artifactPath,
      expectedDigest: digest
    },
    metadata: {
      producer: 'code_forge_delivery',
      effectId: effect.id,
      toolUseId: effect.toolUseId,
      targetKind: effect.target.targetKind,
      patchBytes: effect.target.patchBytes,
      changedPathCount: effect.target.changedPaths.length
    },
    createdAt: effect.terminalAt ?? effect.updatedAt
  }, rootDir)
  return registered.lifecycle
}

function assertEffectOwnership(run: TaskRunRecord, effect: EffectRecord): void {
  if (effect.runId !== run.id || effect.sessionId !== run.sessionId) {
    throw new WorkflowLedgerCorruptionError(
      `confirmed Artifact Effect ownership differs from Run: ${effect.id}`
    )
  }
  if (effect.target.kind === 'code_forge_patch' &&
      effect.target.sessionId && effect.target.sessionId !== run.sessionId) {
    throw new WorkflowLedgerCorruptionError(
      `confirmed Code Forge Artifact session differs from Run: ${effect.id}`
    )
  }
}

function assertExistingProducerArtifact(
  record: ArtifactLifecycleRecord,
  runId: string,
  digest: string,
  sourceRef: string
): void {
  if (record.runId !== runId || record.kind !== 'patch' || record.digest !== digest ||
      record.storageKind !== 'source_ref' || record.sourceRef !== sourceRef) {
    throw new WorkflowLedgerCorruptionError(
      `confirmed Code Forge Artifact lifecycle differs from producer output: ${record.artifactId}`
    )
  }
}
