import { createHash } from 'node:crypto'
import type { RoutineRunRecord } from './routine-runner'
import { registerCanonicalProducedArtifact } from '../task/artifact-production-boundary'

export interface RoutineResultEvidenceBinding {
  artifactId: string
  evidenceId: string
}

export async function persistRoutineResultEvidence(
  workflowRoot: string,
  workspaceRoot: string,
  record: RoutineRunRecord,
  workflowRunId: string,
  resultText: string | undefined,
  observedAt: number
): Promise<RoutineResultEvidenceBinding> {
  const projectId = requiredBinding(record.projectId, 'projectId')
  const workItemId = requiredBinding(record.workItemId, 'workItemId')
  const runId = requiredBinding(workflowRunId, 'workflowRunId')
  const artifactId = routineResultArtifactId(record.id)
  const evidenceId = routineResultEvidenceId(record.id)
  const content = Buffer.from(resultText ?? '', 'utf8')
  const persisted = await registerCanonicalProducedArtifact({
    lifecycle: {
      id: artifactId,
      projectId,
      ...(record.goalId ? { goalId: record.goalId } : {}),
      workItemId,
      runId,
      lineageId: artifactId,
      kind: 'report',
      title: resultTitle(record.routineName),
      version: 1,
      provenance: 'explicit',
      mediaType: 'text/markdown; charset=utf-8',
      retention: { mode: 'retain' },
      content: { storageKind: 'blob', bytes: content },
      metadata: {
        producer: 'routine',
        routineId: record.routineId,
        routineRunId: record.id
      },
      createdAt: observedAt
    },
    evidence: {
      id: evidenceId,
      kind: 'observation',
      title: resultTitle(record.routineName),
      summary: 'Routine execution produced a persisted result Artifact.',
      verifier: 'routine-runtime',
      metadata: {
        routineId: record.routineId,
        routineRunId: record.id
      }
    },
    attachToStage: false
  }, { workflowRoot, workspaceRoot })
  return { artifactId: persisted.artifact.id, evidenceId: persisted.evidenceId }
}

function routineResultArtifactId(routineRunId: string): string {
  return `routine-result-${bindingDigest('artifact', routineRunId)}`
}

function routineResultEvidenceId(routineRunId: string): string {
  return `routine-result-${bindingDigest('evidence', routineRunId)}`
}

function bindingDigest(kind: string, routineRunId: string): string {
  return createHash('sha256')
    .update(`caogen.routine-result.v1\0${kind}\0${routineRunId}`)
    .digest('hex')
    .slice(0, 32)
}

function resultTitle(name: string): string {
  const title = `Routine result: ${name}`.replace(/\s+/g, ' ').trim()
  return title.length <= 160 ? title : title.slice(0, 160)
}

function requiredBinding(value: string | undefined, label: string): string {
  const clean = value?.trim()
  if (!clean || /[\0-\x1f\x7f]/.test(clean)) throw new Error(`Routine result ${label} is required`)
  return clean
}
