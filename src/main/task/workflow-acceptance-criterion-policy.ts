import type {
  WorkflowAcceptanceCriterionPolicy,
  WorkflowAcceptanceRecord,
  WorkflowEvidenceKind,
  WorkflowEvidenceLinkRecord,
  WorkflowEvidenceSource
} from '../../shared/workflow-types'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'

const EVIDENCE_KINDS: readonly WorkflowEvidenceKind[] = [
  'research_source', 'review_result', 'test_result', 'approval', 'observation',
  'metric', 'security_scan', 'delivery_check', 'custom'
]
const EVIDENCE_SOURCES: readonly WorkflowEvidenceSource[] = [
  'runtime', 'human', 'imported', 'recovery'
]
const POLICY_KEYS = new Set(['criterionId', 'criterionIndex', 'evidenceKind', 'allowedSources'])

export type CriterionPolicyErrorFactory = (
  reason: string,
  message: string,
  details?: Record<string, unknown>
) => Error

export interface CriterionEvidenceResolution {
  evidence: { evidenceId: string; kind: string; source?: string }
  link: WorkflowEvidenceLinkRecord
}

export function normalizeAcceptanceCriterionPolicies(
  value: unknown,
  criteriaCount: number
): WorkflowAcceptanceCriterionPolicy[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new WorkflowLedgerCorruptionError('acceptance criterionPolicies must be an array')
  }
  if (value.length !== criteriaCount) {
    throw new WorkflowLedgerCorruptionError('acceptance criterionPolicies must cover every criterion')
  }
  const criterionIds = new Set<string>()
  const criterionIndexes = new Set<number>()
  const policies = value.map((candidate) => {
    if (!isRecord(candidate) || Object.keys(candidate).some((key) => !POLICY_KEYS.has(key))) {
      throw new WorkflowLedgerCorruptionError('acceptance criterion policy must be a strict object')
    }
    const criterionId = requiredId(candidate.criterionId, 'acceptance criterion policy id')
    const criterionIndex = candidate.criterionIndex
    if (typeof criterionIndex !== 'number' || !Number.isSafeInteger(criterionIndex) ||
        criterionIndex < 0 || criterionIndex >= criteriaCount) {
      throw new WorkflowLedgerCorruptionError('acceptance criterion policy index is invalid')
    }
    if (criterionIds.has(criterionId) || criterionIndexes.has(criterionIndex)) {
      throw new WorkflowLedgerCorruptionError('acceptance criterion policies must have unique ids and indexes')
    }
    const evidenceKind = candidate.evidenceKind
    if (!EVIDENCE_KINDS.includes(evidenceKind as WorkflowEvidenceKind)) {
      throw new WorkflowLedgerCorruptionError('acceptance criterion policy evidenceKind is invalid')
    }
    if (!Array.isArray(candidate.allowedSources) || candidate.allowedSources.length === 0) {
      throw new WorkflowLedgerCorruptionError('acceptance criterion policy allowedSources must not be empty')
    }
    const allowedSources = candidate.allowedSources.map((source) => {
      if (!EVIDENCE_SOURCES.includes(source as WorkflowEvidenceSource)) {
        throw new WorkflowLedgerCorruptionError('acceptance criterion policy source is invalid')
      }
      return source as WorkflowEvidenceSource
    })
    if (new Set(allowedSources).size !== allowedSources.length) {
      throw new WorkflowLedgerCorruptionError('acceptance criterion policy sources must be unique')
    }
    criterionIds.add(criterionId)
    criterionIndexes.add(criterionIndex)
    return {
      criterionId,
      criterionIndex,
      evidenceKind: evidenceKind as WorkflowEvidenceKind,
      allowedSources: [...allowedSources].sort(compareEvidenceSource)
    }
  })
  return policies.sort((left, right) => left.criterionIndex - right.criterionIndex)
}

export function isNormalizedAcceptanceCriterionPolicies(value: unknown, criteriaCount: number): boolean {
  try {
    normalizeAcceptanceCriterionPolicies(value, criteriaCount)
    return true
  } catch {
    return false
  }
}

export function workflowAcceptanceCriterionId(
  acceptance: WorkflowAcceptanceRecord,
  criterionIndex: number
): string {
  return acceptance.criterionPolicies
    ?.find((policy) => policy.criterionIndex === criterionIndex)?.criterionId ??
    acceptance.criterionEvidence
      ?.find((coverage) => coverage.criterionIndex === criterionIndex)?.criterionId ??
    `criterion:${criterionIndex + 1}`
}

export function matchingAcceptanceCriterionIndexes(
  acceptance: WorkflowAcceptanceRecord,
  kind: WorkflowEvidenceKind,
  source: WorkflowEvidenceSource
): number[] | undefined {
  if (!acceptance.criterionPolicies) return undefined
  return acceptance.criterionPolicies
    .filter((policy) => policy.evidenceKind === kind && policy.allowedSources.includes(source))
    .map((policy) => policy.criterionIndex)
    .sort((left, right) => left - right)
}

export function assertAcceptanceCriterionLink(
  acceptance: WorkflowAcceptanceRecord,
  link: WorkflowEvidenceLinkRecord,
  createError: CriterionPolicyErrorFactory
): void {
  if (!acceptance.criterionPolicies || link.relation !== 'verifies') return
  const policy = acceptance.criterionPolicies.find((candidate) => candidate.criterionId === link.criterionId)
  if (!policy) {
    throw createError(
      'criterion_policy_id_mismatch',
      `acceptance ${acceptance.id} evidence link ${link.id} has no declared criterion policy`,
      { criterionId: link.criterionId, evidenceId: link.evidenceId }
    )
  }
  if (link.evidenceOrigin !== 'workflow') {
    throw createError(
      'criterion_policy_origin_mismatch',
      `acceptance ${acceptance.id} criterion ${policy.criterionId} requires Workflow evidence`,
      { criterionId: policy.criterionId, criterionIndex: policy.criterionIndex, evidenceId: link.evidenceId }
    )
  }
}

export function assertAcceptanceCriterionEvidence(
  acceptance: WorkflowAcceptanceRecord,
  resolutions: readonly CriterionEvidenceResolution[],
  createError: CriterionPolicyErrorFactory
): void {
  const coverage = acceptance.criterionEvidence ?? []
  assertPassedCoverageShape(acceptance, coverage, createError)
  if (coverage.length === 0) return

  for (const item of coverage) {
    const policy = acceptance.criterionPolicies
      ?.find((candidate) => candidate.criterionIndex === item.criterionIndex)
    if (policy && policy.criterionId !== item.criterionId) {
      throw createError(
        'criterion_policy_id_mismatch',
        `acceptance ${acceptance.id} criterion ${item.criterionIndex} changed its policy identity`,
        { criterionId: item.criterionId, criterionIndex: item.criterionIndex, expectedCriterionId: policy.criterionId }
      )
    }
    for (const evidenceId of item.evidenceRefs) {
      if (!acceptance.evidenceRefs.includes(evidenceId)) {
        throw createError(
          'criterion_evidence_not_declared',
          `acceptance ${acceptance.id} criterion ${item.criterionId} references undeclared evidence ${evidenceId}`,
          { criterionId: item.criterionId, criterionIndex: item.criterionIndex, evidenceId }
        )
      }
      const matches = resolutions.filter((resolution) =>
        resolution.evidence.evidenceId === evidenceId &&
        resolution.link.relation === 'verifies' &&
        resolution.link.criterionId === item.criterionId
      )
      if (matches.length === 0) {
        throw createError(
          'criterion_verification_link_missing',
          `acceptance ${acceptance.id} criterion ${item.criterionId} lacks a matching verifies link`,
          { criterionId: item.criterionId, criterionIndex: item.criterionIndex, evidenceId }
        )
      }
      if (policy) {
        for (const resolution of matches) {
          assertResolutionMatchesPolicy(acceptance, policy, resolution, createError)
        }
      }
    }
  }
}

function assertPassedCoverageShape(
  acceptance: WorkflowAcceptanceRecord,
  coverage: NonNullable<WorkflowAcceptanceRecord['criterionEvidence']>,
  createError: CriterionPolicyErrorFactory
): void {
  if (acceptance.status !== 'passed') return
  if (coverage.length === 0 && acceptance.criteria.length === 1 && !acceptance.criterionPolicies) return
  if (coverage.length !== acceptance.criteria.length) {
    throw createError(
      'criterion_coverage_incomplete',
      `acceptance ${acceptance.id} does not cover every criterion`
    )
  }
  for (let criterionIndex = 0; criterionIndex < acceptance.criteria.length; criterionIndex += 1) {
    if (coverage.some((candidate) => candidate.criterionIndex === criterionIndex)) continue
    throw createError(
      'criterion_coverage_missing',
      `acceptance ${acceptance.id} criterion ${criterionIndex} has no evidence coverage`,
      { criterionIndex }
    )
  }
}

function assertResolutionMatchesPolicy(
  acceptance: WorkflowAcceptanceRecord,
  policy: WorkflowAcceptanceCriterionPolicy,
  resolution: CriterionEvidenceResolution,
  createError: CriterionPolicyErrorFactory
): void {
  const details = {
    criterionId: policy.criterionId,
    criterionIndex: policy.criterionIndex,
    evidenceId: resolution.evidence.evidenceId
  }
  if (resolution.link.evidenceOrigin !== 'workflow') {
    throw createError(
      'criterion_policy_origin_mismatch',
      `acceptance ${acceptance.id} criterion ${policy.criterionId} requires Workflow evidence`,
      details
    )
  }
  if (resolution.evidence.kind !== policy.evidenceKind) {
    throw createError(
      'criterion_policy_kind_mismatch',
      `acceptance ${acceptance.id} criterion ${policy.criterionId} rejects evidence kind ${resolution.evidence.kind}`,
      { ...details, expectedKind: policy.evidenceKind, actualKind: resolution.evidence.kind }
    )
  }
  if (!resolution.evidence.source || !policy.allowedSources.includes(resolution.evidence.source as WorkflowEvidenceSource)) {
    throw createError(
      'criterion_policy_source_mismatch',
      `acceptance ${acceptance.id} criterion ${policy.criterionId} rejects evidence source ${resolution.evidence.source ?? 'missing'}`,
      { ...details, allowedSources: [...policy.allowedSources], actualSource: resolution.evidence.source }
    )
  }
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorkflowLedgerCorruptionError(`${label} must not be empty`)
  }
  return value.trim()
}

function compareEvidenceSource(left: WorkflowEvidenceSource, right: WorkflowEvidenceSource): number {
  return EVIDENCE_SOURCES.indexOf(left) - EVIDENCE_SOURCES.indexOf(right)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
