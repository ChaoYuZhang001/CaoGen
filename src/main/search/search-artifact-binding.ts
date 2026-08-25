import { createHash } from 'node:crypto'
import type { SessionMeta } from '../../shared/types'
import { registerCanonicalProducedArtifact } from '../task/artifact-production-boundary'
import { createWorkflowEvidence } from '../task/workflow-ledger-api'
import { getPersistedArtifactLifecycle } from '../task/artifact-lifecycle-api'
import { readTaskSnapshotDatabase } from '../task/task-snapshot'
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
  const digest = createHash('sha256').update(`search-artifact\0${projectId}\0${runId}\0${operationId}`).digest('hex')
  return {
    artifactId: `artifact:search:${digest}`,
    lineageId: `lineage:search:${digest}`,
    projectId,
    ...(binding.run.goalId ? { goalId: binding.run.goalId } : {}),
    workItemId: binding.run.workItemId,
    runId: binding.run.id,
    operationId
  }
}

export async function persistSearchArtifact(
  artifact: SearchArtifactContext,
  result: Extract<SearchBrokerResult, { ok: true }>,
  evidence: readonly SearchBrokerEvidenceRecord[],
  rootDir: string
): Promise<void> {
  const first = evidence[0]
  if (!first) return
  const identity = createHash('sha256').update(`${artifact.artifactId}\0${result.operationId}`).digest('hex')
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
      verifier: first.verifier,
      metadata: first.metadata
    },
    acceptance: {
      id: `acceptance:search:${identity}`,
      criterionId: `criterion:search:${identity}`,
      criterion: '搜索报告、来源摘要、内容摘要值和 Evidence 归属于同一 Run，并可在重启后重放。',
      status: 'passed',
      verifier: 'caogen-search-broker'
    }
  }, rootDir)
  for (const record of evidence.slice(1)) {
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
  await getPersistedArtifactLifecycle(artifact.artifactId, rootDir)
}
