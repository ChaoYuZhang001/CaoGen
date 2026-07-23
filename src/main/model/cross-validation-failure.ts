import { createHash } from 'node:crypto'
import type { SessionMeta } from '../../shared/types'
import {
  crossValidationFailureVerdict,
  parseCrossValidationArbitrationConclusion,
  type CrossValidationArbitrationConclusion,
  type CrossValidationReviewConclusion
} from './cross-validation'

export interface CrossValidationFailureCandidate {
  arbitrationSessionId: string
  parentRunId?: string
  eventId: string
  observedAt: number
  resultText: string
  reviewerConclusion: CrossValidationReviewConclusion
  parentMeta: SessionMeta
  verifier: string
}

export interface PlannedCrossValidationFailureInput {
  sourceKind: 'cross_validation'
  sourceEventId: string
  projectId: string
  goalId?: string
  workItemId: string
  runId: string
  title: string
  summary: string
  verifier: string
  verdict: 'concerns' | 'blocked'
  observedAt: number
  contentDigest: string
}

export type CrossValidationFailureIngressPlan =
  | { disposition: 'ignore'; conclusion: CrossValidationArbitrationConclusion | null }
  | { disposition: 'unowned'; conclusion: CrossValidationArbitrationConclusion }
  | {
      disposition: 'ingest'
      conclusion: CrossValidationArbitrationConclusion
      input: PlannedCrossValidationFailureInput
    }

export function planCrossValidationFailureIngress(
  candidate: CrossValidationFailureCandidate
): CrossValidationFailureIngressPlan {
  const conclusion = parseCrossValidationArbitrationConclusion(candidate.resultText)
  const verdict = crossValidationFailureVerdict(candidate.reviewerConclusion, conclusion)
  if (!conclusion || !verdict) return { disposition: 'ignore', conclusion }

  const { workspaceId, goalId, workItemId } = candidate.parentMeta
  if (!workspaceId || !workItemId || !candidate.parentRunId) return { disposition: 'unowned', conclusion }
  const nativeEventIdentity = `${candidate.arbitrationSessionId}\0${candidate.eventId}`
  return {
    disposition: 'ingest',
    conclusion,
    input: {
      sourceKind: 'cross_validation',
      sourceEventId: `model-arbitration:${sha256(nativeEventIdentity)}`,
      projectId: workspaceId,
      ...(goalId === undefined ? {} : { goalId }),
      workItemId,
      runId: candidate.parentRunId,
      title: oneLine(`Cross-validation failure: ${candidate.parentMeta.title}`, 'Cross-validation failure', 256),
      summary: oneLine(candidate.resultText, conclusion, 4000),
      verifier: oneLine(candidate.verifier, 'model-arbitration', 256),
      verdict,
      observedAt: candidate.observedAt,
      contentDigest: sha256(candidate.resultText)
    }
  }
}

function oneLine(value: string, fallback: string, maxLength: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  return (normalized || fallback).slice(0, maxLength)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
