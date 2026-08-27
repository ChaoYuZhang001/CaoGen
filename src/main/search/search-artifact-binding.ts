import { createHash } from 'node:crypto'
import type { SessionMeta } from '../../shared/types'
import { goalTaskIds } from '../project-workspace/goal-task-service'
import { ensureManagedPersonalWorkspace } from '../project-workspace/managed-personal-workspace'
import { registerCanonicalProducedArtifact } from '../task/artifact-production-boundary'
import { createWorkflowEvidence } from '../task/workflow-ledger-api'
import { getPersistedArtifactLifecycle } from '../task/artifact-lifecycle-api'
import { createTaskRun, transitionTaskRun } from '../task/task-run'
import { deleteTaskSnapshot, mutateTaskSnapshotDatabase, readTaskSnapshotDatabase } from '../task/task-snapshot'
import {
  prepareCanonicalSystemOperation,
  settleCanonicalSystemOperation
} from '../task/system-operation-context'
import { bindWorkflowRunToCanonicalWorkItem } from '../task/workflow-run-canonical-binding'
import { projectRunIntoWorkflow } from '../task/workflow-ledger-projection'
import { findWorkflowRun, findWorkflowWorkItem } from '../task/workflow-ledger-store'
import type { SearchBrokerEvidenceRecord, SearchBrokerResult } from './search-broker'

export interface SearchArtifactContext {
  artifactId: string
  lineageId: string
  projectId: string
  goalId?: string
  workItemId: string
  runId: string
  operationId: string
  acceptanceId: string
  criterionId: string
  scope: 'project' | 'personal'
}

export async function prepareSearchArtifact(
  rootDir: string,
  meta: SessionMeta,
  projectId: string,
  runId: string | undefined,
  operationId: string
): Promise<SearchArtifactContext | undefined> {
  if (!runId || !meta.workItemId) return undefined
  const binding = await readTaskSnapshotDatabase(rootDir, (db) => {
    const run = findWorkflowRun(db, runId)
    const workItem = run ? findWorkflowWorkItem(db, run.workItemId) : null
    return run && workItem ? { run } : undefined
  })
  if (!binding || binding.run.projectId !== projectId || binding.run.workItemId !== meta.workItemId) return undefined
  const ids = searchArtifactIds(projectId, runId, operationId)
  return {
    ...ids,
    projectId,
    ...(binding.run.goalId ? { goalId: binding.run.goalId } : {}),
    workItemId: binding.run.workItemId,
    runId: binding.run.id,
    operationId,
    scope: 'project'
  }
}

/**
 * Give an unassigned Assistant search a real, app-owned workflow identity.
 * The user-facing Session remains unassigned; this scope only owns the
 * durable search result inside the managed personal Workspace.
 */
export async function preparePersonalSearchArtifact(
  rootDir: string,
  meta: SessionMeta,
  operationId: string,
  query: string
): Promise<SearchArtifactContext> {
  const managed = await ensureManagedPersonalWorkspace(rootDir)
  if (meta.personalWorkspaceId && meta.personalWorkspaceId !== managed.workspace.id) {
    throw new Error(`Assistant personal Workspace identity conflict:${meta.id}`)
  }
  const identity = personalSearchIdentity(managed.workspace.id, operationId)
  const taskIds = goalTaskIds(managed.workspace.id, identity.requestId)
  const context: SearchArtifactContext = {
    ...searchArtifactIds(managed.workspace.id, identity.runId, operationId),
    projectId: managed.workspace.id,
    goalId: taskIds.goalId,
    workItemId: taskIds.workItemId,
    runId: identity.runId,
    operationId,
    scope: 'personal'
  }
  const existing = await getPersistedArtifactLifecycle(context.artifactId, rootDir)
  if (existing) {
    assertArtifactScope(existing, context)
    return context
  }

  const operation = await prepareCanonicalSystemOperation({
    rootDir,
    requestId: identity.requestId,
    objective: `联网搜索：${query}`,
    workspaceId: managed.workspace.id,
    cwd: managed.cwd
  })
  if (operation.goalId !== context.goalId || operation.workItemId !== context.workItemId) {
    throw new Error(`Assistant search operation identity drift:${operationId}`)
  }
  await ensurePersonalSearchRun(rootDir, operation, identity.runId, identity.scopeId)
  return context
}

export async function persistSearchArtifact(
  artifact: SearchArtifactContext,
  result: Extract<SearchBrokerResult, { ok: true }>,
  evidence: readonly SearchBrokerEvidenceRecord[],
  rootDir: string
): Promise<void> {
  const first = evidence[0]
  if (!first) return
  const existing = await getPersistedArtifactLifecycle(artifact.artifactId, rootDir)
  if (existing) {
    assertArtifactScope(existing, artifact)
    await persistAdditionalSearchEvidence(artifact, evidence.slice(1), rootDir)
    await settlePersonalSearchOperation(artifact, first.evidenceId, rootDir)
    return
  }
  const content = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    operationId: artifact.operationId,
    citations: result.results
  }, null, 2))
  await registerCanonicalProducedArtifact({
    lifecycle: {
      id: artifact.artifactId,
      projectId: artifact.projectId,
      ...(artifact.goalId ? { goalId: artifact.goalId } : {}),
      workItemId: artifact.workItemId,
      runId: artifact.runId,
      lineageId: artifact.lineageId,
      kind: 'report',
      title: '联网搜索报告',
      version: 1,
      provenance: 'explicit',
      mediaType: 'application/json',
      retention: { mode: 'retain' },
      content: { storageKind: 'blob', bytes: new Uint8Array(content) },
      metadata: { producer: 'caogen-search-broker', operationId: artifact.operationId, sourceCount: evidence.length }
    },
    evidence: {
      id: first.evidenceId,
      kind: first.kind,
      title: '联网搜索来源已绑定',
      summary: first.summary,
      uri: first.uri,
      mediaType: first.mediaType,
      observedAt: first.observedAt,
      contentDigest: first.contentDigest,
      verifier: first.verifier,
      metadata: first.metadata
    },
    acceptance: {
      id: artifact.acceptanceId,
      criterionId: artifact.criterionId,
      criterion: '搜索报告、来源摘要、内容摘要值和 Evidence 归属于同一 Run，并可在重启后重放。',
      status: 'passed',
      verifier: 'caogen-search-broker'
    }
  }, rootDir)
  await persistAdditionalSearchEvidence(artifact, evidence.slice(1), rootDir)
  await settlePersonalSearchOperation(artifact, first.evidenceId, rootDir)
}

async function persistAdditionalSearchEvidence(
  artifact: SearchArtifactContext,
  evidence: readonly SearchBrokerEvidenceRecord[],
  rootDir: string
): Promise<void> {
  for (const record of evidence) {
    await createWorkflowEvidence({
      evidenceId: record.evidenceId,
      projectId: artifact.projectId,
      ...(artifact.goalId ? { goalId: artifact.goalId } : {}),
      workItemId: artifact.workItemId,
      runId: artifact.runId,
      artifactId: artifact.artifactId,
      kind: record.kind,
      title: record.title,
      summary: record.summary,
      uri: record.uri,
      mediaType: record.mediaType,
      contentDigest: record.contentDigest,
      metadata: record.metadata
    }, rootDir, { source: 'runtime', verifier: record.verifier, observedAt: record.observedAt })
  }
}

export async function assertSearchArtifactReplay(
  artifact: SearchArtifactContext,
  rootDir: string
): Promise<void> {
  const lifecycle = await getPersistedArtifactLifecycle(artifact.artifactId, rootDir)
  if (!lifecycle) throw new Error(`Search Artifact replay is missing:${artifact.artifactId}`)
  assertArtifactScope(lifecycle, artifact)
}

export function searchEvidenceRecordsFromResult(
  result: Extract<SearchBrokerResult, { ok: true }>
): SearchBrokerEvidenceRecord[] {
  return result.results.map((citation) => ({
    evidenceId: citation.evidenceId,
    ...(result.projectId ? { projectId: result.projectId } : {}),
    ...(result.goalId ? { goalId: result.goalId } : {}),
    ...(result.workItemId ? { workItemId: result.workItemId } : {}),
    ...(result.runId ? { runId: result.runId } : {}),
    kind: 'research_source',
    title: `Web search source: ${new URL(citation.url).hostname}`,
    summary: citation.summary,
    uri: citation.url,
    mediaType: 'text/plain',
    verifier: 'caogen-search-broker',
    observedAt: citation.fetchedAt,
    contentDigest: citation.contentSha256,
    metadata: {
      mode: result.mode,
      fetchedAt: citation.fetchedAt,
      contentSha256: citation.contentSha256,
      citation: citation.citation
    }
  }))
}

function searchArtifactIds(projectId: string, runId: string, operationId: string): Pick<
  SearchArtifactContext,
  'artifactId' | 'lineageId' | 'acceptanceId' | 'criterionId'
> {
  const digest = createHash('sha256')
    .update(`search-artifact\0${projectId}\0${runId}\0${operationId}`)
    .digest('hex')
  const acceptanceDigest = createHash('sha256')
    .update(`artifact:search:${digest}\0${operationId}`)
    .digest('hex')
  return {
    artifactId: `artifact:search:${digest}`,
    lineageId: `lineage:search:${digest}`,
    acceptanceId: `acceptance:search:${acceptanceDigest}`,
    criterionId: `criterion:search:${acceptanceDigest}`
  }
}

function personalSearchIdentity(projectId: string, operationId: string): {
  requestId: string
  runId: string
  scopeId: string
} {
  const digest = createHash('sha256')
    .update(`caogen.personal-search-operation.v1\0${projectId}\0${operationId}`)
    .digest('hex')
  return {
    requestId: `assistant-search-${digest.slice(0, 40)}`,
    runId: `run:assistant-search:${digest}`,
    scopeId: `assistant-search:${digest}`
  }
}

async function ensurePersonalSearchRun(
  rootDir: string,
  operation: Awaited<ReturnType<typeof prepareCanonicalSystemOperation>>,
  runId: string,
  scopeId: string
): Promise<void> {
  const existing = await readTaskSnapshotDatabase(rootDir, (db) => findWorkflowRun(db, runId))
  let run = existing?.taskRun
  if (existing) {
    if (existing.projectId !== operation.projectId || existing.goalId !== operation.goalId ||
        existing.workItemId !== operation.workItemId || existing.taskRun.sessionId !== scopeId) {
      throw new Error(`Assistant search Run identity conflict:${runId}`)
    }
  } else {
    const now = Date.now()
    run = transitionTaskRun(
      transitionTaskRun(createTaskRun({ id: runId, sessionId: scopeId, taskId: operation.requestId, now }), 'executing', { now }),
      'completed',
      { now }
    )
    // The canonical WorkItem writer verifies each runRef immediately. Persist
    // the Run first so the later rich-source binding can never point at a
    // missing Run. A retry can resume safely from either committed stage.
    await mutateTaskSnapshotDatabase(rootDir, (db) => projectRunIntoWorkflow(db, run!, {
      projectId: operation.projectId,
      goalId: operation.goalId,
      workItemId: operation.workItemId,
      workItemTitle: 'Assistant 联网搜索',
      source: 'explicit',
      canonicalSourceAuthority: true
    }))
  }
  const bindingMeta = {
    id: scopeId,
    workspaceId: operation.workspaceId,
    goalId: operation.goalId,
    workItemId: operation.workItemId
  }
  await bindWorkflowRunToCanonicalWorkItem(bindingMeta, run, rootDir)
  // Keep TaskRun parity without exposing a synthetic recoverable Session.
  await deleteTaskSnapshot(scopeId, rootDir, run)
}

async function settlePersonalSearchOperation(
  artifact: SearchArtifactContext,
  evidenceId: string,
  rootDir: string
): Promise<void> {
  if (artifact.scope !== 'personal' || !artifact.goalId) return
  await settleCanonicalSystemOperation({
    rootDir,
    goalId: artifact.goalId,
    workItemId: artifact.workItemId
  }, {
    status: 'passed',
    evidenceRefs: [evidenceId],
    verifiedBy: 'caogen-search-broker'
  })
}

function assertArtifactScope(
  lifecycle: NonNullable<Awaited<ReturnType<typeof getPersistedArtifactLifecycle>>>,
  artifact: SearchArtifactContext
): void {
  if (lifecycle.projectId !== artifact.projectId || lifecycle.goalId !== artifact.goalId ||
      lifecycle.workItemId !== artifact.workItemId || lifecycle.runId !== artifact.runId ||
      lifecycle.lineageId !== artifact.lineageId) {
    throw new Error(`Search Artifact replay scope differs:${artifact.artifactId}`)
  }
}
