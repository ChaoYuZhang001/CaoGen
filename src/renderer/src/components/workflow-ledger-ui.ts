import type { WorkflowEvidenceKind, WorkflowEvidenceSource } from '../../../shared/types'

export const EVIDENCE_KINDS: readonly WorkflowEvidenceKind[] = [
  'research_source', 'review_result', 'test_result', 'approval', 'observation',
  'metric', 'security_scan', 'delivery_check', 'custom'
]

export const EVIDENCE_SOURCES: readonly WorkflowEvidenceSource[] = [
  'runtime', 'human', 'imported', 'recovery'
]

export interface CriterionDraft {
  id: string
  criterion: string
  evidenceKind: WorkflowEvidenceKind
  allowedSources: WorkflowEvidenceSource[]
}

export function newWorkflowId(prefix: string): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  return `${prefix}:${random}`
}

export function newCriterion(): CriterionDraft {
  return {
    id: newWorkflowId('criterion'),
    criterion: '',
    evidenceKind: 'test_result',
    allowedSources: ['runtime']
  }
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
