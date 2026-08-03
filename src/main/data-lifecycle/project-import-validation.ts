import type {
  ProjectAggregateExportBundle,
  ProjectAggregateSnapshot
} from '../../shared/project-aggregate-types'
import {
  PROJECT_AGGREGATE_EXPORT_FORMAT,
  PROJECT_AGGREGATE_SCHEMA_VERSION
} from '../../shared/project-aggregate-types'
import {
  assertNoCredentialMaterial,
  projectAggregateCanonicalJson,
  projectAggregateDigest
} from '../project-aggregate/codec'
import { verifyProjectAggregateSnapshot } from '../project-aggregate/project-ownership-verifier'
import { validateProjectRoutineSlice } from '../routines/routine-project-store'

export function parseProjectAggregateImport(value: unknown): ProjectAggregateExportBundle {
  const parsed = typeof value === 'string' ? parseJson(value) : structuredClone(value)
  if (!isRecord(parsed) || parsed.schemaVersion !== PROJECT_AGGREGATE_SCHEMA_VERSION ||
      parsed.format !== PROJECT_AGGREGATE_EXPORT_FORMAT || !isRecord(parsed.aggregate) ||
      !isRecord(parsed.dependencies) || !Array.isArray(parsed.dependencies.roleTemplates) ||
      !isRecord(parsed.verification) || typeof parsed.exportDigest !== 'string') {
    throw new Error('Project import must be a CaoGen Project Aggregate export')
  }
  const bundle = parsed as unknown as ProjectAggregateExportBundle
  const { exportDigest, ...body } = bundle
  if (projectAggregateDigest(body) !== exportDigest) throw new Error('Project import export digest mismatch')
  verifyProjectAggregateSnapshot(bundle.aggregate)
  validateProjectRoutineSlice(bundle.projectId, bundle.automation)
  assertDependencyClosure(bundle)
  assertVerificationBinding(bundle)
  assertNoCredentialMaterial(bundle)
  return structuredClone(bundle)
}

function assertDependencyClosure(bundle: ProjectAggregateExportBundle): void {
  const roles = bundle.dependencies.roleTemplates
  const roleIds = new Set<string>()
  for (const value of roles) {
    if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || !value.id.trim() ||
        !Number.isSafeInteger(value.version) || Number(value.version) < 1) {
      throw new Error('Project import contains an invalid RoleTemplate dependency')
    }
    if (roleIds.has(value.id)) throw new Error(`Project import contains duplicate RoleTemplate dependency: ${value.id}`)
    roleIds.add(value.id)
  }
  const required = new Set(bundle.aggregate.digitalWorkers.map((worker) => worker.roleTemplateId))
  const missing = [...required].filter((id) => !roleIds.has(id)).sort()
  const unrelated = [...roleIds].filter((id) => !required.has(id)).sort()
  if (missing.length > 0) throw new Error(`Project import is missing RoleTemplate dependencies: ${missing.join(', ')}`)
  if (unrelated.length > 0) throw new Error(`Project import contains unrelated RoleTemplate dependencies: ${unrelated.join(', ')}`)
  for (const worker of bundle.aggregate.digitalWorkers) {
    const role = roles.find((entry) => entry.id === worker.roleTemplateId)
    if (!role || role.version < worker.roleTemplateVersion) {
      throw new Error(`Project import RoleTemplate version is older than DigitalWorker ${worker.id}`)
    }
  }
}

export function projectImportSemanticDigest(aggregate: ProjectAggregateSnapshot): string {
  return projectAggregateDigest(normalizeAggregate(aggregate))
}

function assertVerificationBinding(bundle: ProjectAggregateExportBundle): void {
  const verification = bundle.verification
  const aggregate = bundle.aggregate
  if (bundle.projectId !== aggregate.projectId || verification.projectId !== aggregate.projectId ||
      verification.valid !== true || verification.sanitized !== true || verification.sealed !== true ||
      verification.schemaVersion !== aggregate.schemaVersion ||
      verification.aggregateRevision !== bundle.aggregateRevision ||
      verification.identityDigest !== aggregate.identityDigest ||
      verification.aggregateDigest !== aggregate.aggregateDigest ||
      projectAggregateCanonicalJson(verification.objectCounts) !== projectAggregateCanonicalJson(aggregate.objectCounts)) {
    throw new Error('Project import verification does not bind the exported aggregate')
  }
}

function normalizeAggregate(aggregate: ProjectAggregateSnapshot): unknown {
  return {
    projectId: aggregate.projectId,
    identityDigest: aggregate.identityDigest,
    projectRevision: aggregate.projectRevision,
    workspace: aggregate.workspace,
    resources: aggregate.resources,
    goals: aggregate.goals,
    workItems: aggregate.workItems,
    squads: aggregate.squads,
    comments: aggregate.comments,
    digitalWorkers: aggregate.digitalWorkers,
    assignments: aggregate.assignments,
    leases: aggregate.leases,
    workflow: {
      ...aggregate.workflow,
      taskEvidence: aggregate.workflow.taskEvidence.map(stripChain),
      workflowEvidence: aggregate.workflow.workflowEvidence.map(stripChain)
    },
    memory: aggregate.memory,
    budgets: aggregate.budgets,
    policies: aggregate.policies,
    audit: aggregate.audit.map((entry) => entry.source === 'workflow_ledger'
      ? { ...entry, value: normalizeWorkflowEvent(entry.value) }
      : entry)
  }
}

function normalizeWorkflowEvent(value: unknown): unknown {
  if (!isRecord(value)) return value
  const { seq: _seq, prevDigest: _prevDigest, digest: _digest, payload, ...event } = value
  if (event.kind === 'workflow.effect.evidence' && isRecord(payload)) {
    const {
      evidenceSeq: _evidenceSeq,
      taskEvidenceRecordDigest: _recordDigest,
      taskEvidencePrevDigest: _recordPrevDigest,
      ...semanticPayload
    } = payload
    return { ...event, payload: semanticPayload }
  }
  if (event.kind === 'workflow.evidence.recorded') return { ...event, payload: stripChain(payload) }
  return { ...event, payload }
}

function stripChain<T>(value: T): unknown {
  if (!isRecord(value)) return value
  const { seq: _seq, prevDigest: _prevDigest, digest: _digest, ...semantic } = value
  return semantic
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error('Project import JSON is invalid')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
