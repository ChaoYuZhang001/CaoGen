import type { EffectRecord, TaskRunRecord } from '../../shared/types'
import type {
  WorkflowAcceptanceStatus,
  WorkflowProjectionSource,
  WorkflowRunRecord
} from '../../shared/workflow-types'
import {
  getPersistedArtifactLifecycle,
  registerPersistedArtifactLifecycle
} from './artifact-lifecycle-api'
import { assertSha256Digest } from './artifact-lifecycle-content'
import type { ArtifactLifecycleRecord } from './artifact-lifecycle-types'
import { readTaskSnapshotDatabase } from './task-snapshot'
import {
  findWorkflowAcceptance,
  findWorkflowRun,
  findWorkflowWorkItem
} from './workflow-ledger-store'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'
import { effectRecordIntegrityMatches } from './effect-record-integrity'
import { attachProducedArtifactToStage } from './workflow-stage-handoff'
import {
  createWorkflowEvidence,
  saveWorkflowAcceptance,
  createWorkflowEvidenceLink
} from './workflow-ledger-api'
import { runOfficeSelfCheck, type OfficeSelfCheckResult } from '../agent/tools/office-self-check'
import { stableValueDigest } from './tool-idempotency'

export async function registerConfirmedRunArtifactLifecycles(
  run: TaskRunRecord,
  rootDir?: string
): Promise<ArtifactLifecycleRecord[]> {
  const effects = (run.effects ?? []).filter((effect) =>
    isConfirmedCodeForgePatchEffect(effect) || isConfirmedOfficeArtifactEffect(effect)
  )
  if (effects.length === 0) return []
  const { workflowRun, projectionSource } = await readTaskSnapshotDatabase(rootDir, (db) => {
    const workflowRun = findWorkflowRun(db, run.id)
    return {
      workflowRun,
      projectionSource: workflowRun
        ? findWorkflowWorkItem(db, workflowRun.workItemId)?.source
        : undefined
    }
  })
  assertCanonicalProducerRun(run, workflowRun)
  if (!projectionSource) {
    throw new WorkflowLedgerCorruptionError(
      `confirmed Artifact producer lacks its canonical WorkItem projection: ${run.id}`
    )
  }
  const records: ArtifactLifecycleRecord[] = []
  for (const effect of effects) {
    assertCanonicalProducerEffect(effect, workflowRun)
    if (isConfirmedCodeForgePatchEffect(effect)) {
      records.push(await registerCodeForgePatchLifecycle(run, effect, workflowRun, rootDir))
      continue
    }
    if (isConfirmedOfficeArtifactEffect(effect)) {
      records.push(await registerOfficeArtifactLifecycle(
        run,
        effect,
        workflowRun,
        projectionSource,
        rootDir
      ))
    }
  }
  return records
}

function assertCanonicalProducerRun(
  run: TaskRunRecord,
  workflowRun: WorkflowRunRecord | null
): asserts workflowRun is WorkflowRunRecord & { projectId: string } {
  if (!workflowRun?.projectId || workflowRun.id !== run.id || workflowRun.sessionId !== run.sessionId ||
      workflowRun.taskId !== run.taskId || workflowRun.taskRun.id !== run.id ||
      workflowRun.taskRun.sessionId !== run.sessionId) {
    throw new WorkflowLedgerCorruptionError(
      `confirmed Artifact producer lacks matching canonical Project-owned Run: ${run.id}`
    )
  }
}

function assertCanonicalProducerEffect(
  effect: EffectRecord,
  workflowRun: WorkflowRunRecord
): void {
  const persisted = workflowRun.taskRun.effects?.find((candidate) => candidate.id === effect.id)
  if (!persisted || !effectRecordIntegrityMatches(effect) || !effectRecordIntegrityMatches(persisted) ||
      persistedEffectDigest(persisted) !== persistedEffectDigest(effect)) {
    throw new WorkflowLedgerCorruptionError(
      `confirmed Artifact producer Effect differs from canonical persisted Run: ${effect.id}`
    )
  }
}

function persistedEffectDigest(effect: EffectRecord): string {
  // SQLite stores the Effect as JSON, where optional `undefined` fields are omitted.
  // Compare the exact durable representation so an in-memory object cannot forge
  // persisted values while harmless pre-serialization shape differences are ignored.
  return stableValueDigest(JSON.parse(JSON.stringify(effect)) as EffectRecord)
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
  workflowRun: WorkflowRunRecord & { projectId: string },
  rootDir?: string
): Promise<ArtifactLifecycleRecord> {
  assertEffectOwnership(run, effect)
  const artifactId = `artifact:code-forge-patch:${effect.id}`
  const digest = assertSha256Digest(`sha256:${effect.target.patchSha256}`)
  const existing = await getPersistedArtifactLifecycle(artifactId, rootDir)
  if (existing) {
    assertExistingProducerArtifact(existing, run.id, digest, effect.target.artifactPath)
    await attachProducedArtifactToStage({
      artifactId: existing.artifactId,
      projectId: existing.projectId,
      workItemId: existing.workItemId,
      runId: existing.runId,
      rootDir
    })
    return existing
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
  await attachProducedArtifactToStage({
    artifactId: registered.lifecycle.artifactId,
    projectId: registered.lifecycle.projectId,
    workItemId: registered.lifecycle.workItemId,
    runId: registered.lifecycle.runId,
    rootDir
  })
  return registered.lifecycle
}

type OfficeArtifactEffect = EffectRecord & {
  target: Extract<EffectRecord['target'], { kind: 'office_artifact' }>
}

function isConfirmedOfficeArtifactEffect(effect: EffectRecord): effect is OfficeArtifactEffect {
  return effect.status === 'confirmed' && officeArtifactEffectHasOutputBinding(effect)
}

export function officeArtifactEffectHasOutputBinding(effect: EffectRecord): effect is OfficeArtifactEffect {
  return effect.target.kind === 'office_artifact' && effect.target.outputBindingVersion === 1 &&
    Array.isArray(effect.target.sourceSnapshots) &&
    typeof effect.target.expectedSha256 === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test(effect.target.expectedSha256) &&
    Number.isSafeInteger(effect.target.expectedBytes) && (effect.target.expectedBytes as number) >= 0
}

/** 由 self-check 结果派生 Acceptance 状态：绿→passed，红→failed（默认采纳 B/C）。 */
export function deriveOfficeAcceptanceStatus(selfCheck: OfficeSelfCheckResult): WorkflowAcceptanceStatus {
  return selfCheck.ok ? 'passed' : 'failed'
}

async function registerOfficeArtifactLifecycle(
  run: TaskRunRecord,
  effect: OfficeArtifactEffect,
  workflowRun: WorkflowRunRecord & { projectId: string },
  provenance: WorkflowProjectionSource,
  rootDir?: string
): Promise<ArtifactLifecycleRecord> {
  assertOfficeEffectOwnership(run, effect)
  const expectedOutput = requiredOfficeEffectOutput(effect)
  const artifactId = `artifact:office:${effect.id}`
  const existing = await getPersistedArtifactLifecycle(artifactId, rootDir)
  if (existing) {
    assertExistingOfficeArtifact(
      existing,
      run.id,
      effect.target.artifactKind,
      effect.target.workspacePath,
      expectedOutput
    )
    const status = await attachOfficeAcceptance(existing, effect, rootDir)
    if (status === 'passed') await attachOfficeArtifactToStage(existing, rootDir)
    return existing
  }
  const registered = await registerPersistedArtifactLifecycle({
    id: artifactId,
    projectId: workflowRun.projectId,
    goalId: workflowRun.goalId,
    workItemId: workflowRun.workItemId,
    runId: workflowRun.id,
    lineageId: `lineage:office:${effect.id}`,
    kind: effect.target.artifactKind,
    title: effect.target.title,
    version: 1,
    provenance,
    mediaType: effect.target.mediaType,
    retention: { mode: 'retain' },
    content: {
      storageKind: 'source_ref',
      sourceRef: effect.target.workspacePath,
      expectedDigest: expectedOutput.sha256
    },
    metadata: {
      producer: 'office_delivery',
      effectId: effect.id,
      toolUseId: effect.toolUseId,
      artifactKind: effect.target.artifactKind,
      sourceRefs: effect.target.sourceRefs,
      outputBindingVersion: 1,
      expectedSha256: expectedOutput.sha256,
      expectedBytes: expectedOutput.bytes
    },
    createdAt: effect.terminalAt ?? effect.updatedAt
  }, rootDir)
  assertExistingOfficeArtifact(
    registered.lifecycle,
    run.id,
    effect.target.artifactKind,
    effect.target.workspacePath,
    expectedOutput
  )

  const status = await attachOfficeAcceptance(registered.lifecycle, effect, rootDir)
  if (status === 'passed') await attachOfficeArtifactToStage(registered.lifecycle, rootDir)

  return registered.lifecycle
}

async function attachOfficeArtifactToStage(
  lifecycle: ArtifactLifecycleRecord,
  rootDir?: string
): Promise<void> {
  if (lifecycle.provenance === 'legacy-derived') return
  await attachProducedArtifactToStage({
    artifactId: lifecycle.artifactId,
    projectId: lifecycle.projectId,
    workItemId: lifecycle.workItemId,
    runId: lifecycle.runId,
    rootDir
  })
}

async function attachOfficeAcceptance(
  lifecycle: ArtifactLifecycleRecord,
  effect: OfficeArtifactEffect,
  rootDir?: string
): Promise<WorkflowAcceptanceStatus> {
  const acceptanceId = `acceptance:office:${effect.id}`
  const evidenceId = `evidence:office:${effect.id}`
  const criterionId = `criterion:office:${effect.id}:deliverable`
  const observedAt = effect.terminalAt ?? effect.updatedAt
  const criteria = [
    'Office 成品可打开、类型与字节完整性一致，并能追溯到实际来源材料'
  ]
  const criterionPolicies = [{
    criterionId,
    criterionIndex: 0,
    evidenceKind: 'delivery_check' as const,
    allowedSources: ['runtime' as const]
  }]
  let acceptance = await readTaskSnapshotDatabase(
    rootDir,
    (db) => findWorkflowAcceptance(db, acceptanceId)
  )
  if (!acceptance) {
    acceptance = await saveWorkflowAcceptance({
      id: acceptanceId,
      projectId: lifecycle.projectId,
      goalId: lifecycle.goalId,
      workItemId: lifecycle.workItemId,
      criteria,
      criterionPolicies,
      status: 'verifying',
      evidenceRefs: [],
      revision: 1,
      createdAt: observedAt,
      updatedAt: observedAt
    }, rootDir, { caller: 'automatic', actorId: 'office-delivery' })
  } else if (acceptance.status === 'pending') {
    acceptance = await saveWorkflowAcceptance({
      ...acceptance,
      status: 'verifying',
      evidenceRefs: [],
      criterionEvidence: undefined,
      verifier: undefined,
      verifiedAt: undefined,
      revision: acceptance.revision + 1,
      updatedAt: observedAt
    }, rootDir, { caller: 'automatic', actorId: 'office-delivery' })
  }

  const selfCheck = await runOfficeSelfCheck({
    workspacePath: effect.target.workspacePath,
    expectedSha256: effect.target.expectedSha256,
    artifactKind: effect.target.artifactKind,
    mediaType: effect.target.mediaType,
    sourceRefs: effect.target.sourceRefs,
    sourceSnapshots: effect.target.sourceSnapshots,
    runtimeTraceable: true
  })
  const status: WorkflowAcceptanceStatus = deriveOfficeAcceptanceStatus(selfCheck)
  const evidence = await createWorkflowEvidence({
    evidenceId,
    projectId: lifecycle.projectId,
    goalId: lifecycle.goalId,
    workItemId: lifecycle.workItemId,
    runId: lifecycle.runId,
    artifactId: lifecycle.artifactId,
    kind: 'delivery_check',
    title: `Office 成品结构/打开性校验：${effect.target.title}`,
    summary: selfCheck.ok
      ? `文件可解析；artifactKind/mediaType/字节 digest 一致；来源可追溯：${effect.target.workspacePath}`
      : `结构/打开性/来源校验失败：${selfCheck.reason}`,
    contentDigest: workflowEvidenceContentDigest(lifecycle.digest),
    metadata: {
      producer: 'office_delivery',
      artifactKind: effect.target.artifactKind,
      mediaType: effect.target.mediaType,
      sourceSnapshots: effect.target.sourceSnapshots,
      selfCheck
    }
  }, rootDir, {
    source: 'runtime',
    verifier: 'office-delivery',
    observedAt
  })
  await createWorkflowEvidenceLink({
    id: `link:office:${effect.id}`,
    evidenceId: evidence.evidenceId,
    projectId: lifecycle.projectId,
    runId: lifecycle.runId,
    artifactId: lifecycle.artifactId,
    acceptanceId,
    criterionId,
    evidenceOrigin: 'workflow',
    relation: 'verifies',
    createdAt: observedAt
  }, rootDir)

  if (acceptance.status === 'verifying') {
    await saveWorkflowAcceptance({
      ...acceptance,
      status,
      evidenceRefs: [evidence.evidenceId],
      criterionEvidence: [{ criterionId, criterionIndex: 0, evidenceRefs: [evidence.evidenceId] }],
      verifier: 'office-delivery',
      verifiedAt: observedAt,
      revision: acceptance.revision + 1,
      updatedAt: observedAt
    }, rootDir, { caller: 'automatic', actorId: 'office-delivery' })
    return status
  }
  if (acceptance.status !== status || !acceptance.evidenceRefs.includes(evidence.evidenceId)) {
    throw new WorkflowLedgerCorruptionError(
      `Office Acceptance replay differs from persisted result: ${acceptance.id}`
    )
  }
  return status
}

function workflowEvidenceContentDigest(artifactDigest: string): string {
  return assertSha256Digest(artifactDigest).slice('sha256:'.length)
}

function assertOfficeEffectOwnership(run: TaskRunRecord, effect: EffectRecord): void {
  if (effect.runId !== run.id || effect.sessionId !== run.sessionId) {
    throw new WorkflowLedgerCorruptionError(
      `confirmed Office Artifact Effect ownership differs from Run: ${effect.id}`
    )
  }
}

function assertExistingOfficeArtifact(
  record: ArtifactLifecycleRecord,
  runId: string,
  artifactKind: 'document' | 'spreadsheet' | 'presentation' | 'pdf',
  sourceRef: string,
  expectedOutput: { sha256: string; bytes: number }
): void {
  if (
    record.runId !== runId ||
    record.kind !== artifactKind ||
    record.storageKind !== 'source_ref' ||
    record.sourceRef !== sourceRef ||
    record.digest !== expectedOutput.sha256 ||
    record.sizeBytes !== expectedOutput.bytes
  ) {
    throw new WorkflowLedgerCorruptionError(
      `confirmed Office Artifact lifecycle differs from producer output: ${record.artifactId}`
    )
  }
}

function requiredOfficeEffectOutput(effect: OfficeArtifactEffect): { sha256: string; bytes: number } {
  const { expectedSha256, expectedBytes } = effect.target
  if (!officeArtifactEffectHasOutputBinding(effect) || !expectedSha256 || expectedBytes === undefined) {
    throw new WorkflowLedgerCorruptionError(
      `confirmed Office Artifact Effect lacks frozen output identity: ${effect.id}`
    )
  }
  return { sha256: assertSha256Digest(expectedSha256), bytes: expectedBytes }
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
