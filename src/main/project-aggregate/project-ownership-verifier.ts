import {
  PROJECT_AGGREGATE_FORMAT,
  PROJECT_AGGREGATE_OBJECT_KINDS,
  PROJECT_AGGREGATE_SCHEMA_VERSION,
  type ProjectAggregateObjectCounts,
  type ProjectAggregateObjectDigests,
  type ProjectAggregateObjectKind,
  type ProjectAggregateReference,
  type ProjectAggregateSeal,
  type ProjectAggregateSnapshot
} from '../../shared/project-aggregate-types'
import type { WorkflowGoalRecord, WorkflowWorkItemRecord } from '../../shared/workflow-types'
import {
  assertNoCredentialMaterial,
  projectAggregateCanonicalJson,
  projectAggregateDigest
} from './codec'
import { aggregateIntegrityError, ProjectAggregateError, requiredObjectId, requiredProjectId } from './errors'

export type ProjectAggregateDraft = Omit<
  ProjectAggregateSnapshot,
  | 'schemaVersion'
  | 'format'
  | 'identityDigest'
  | 'objectCounts'
  | 'objectDigests'
  | 'aggregateDigest'
  | 'sanitized'
>

export interface ProjectAggregateCanonicalParity {
  goals: WorkflowGoalRecord[]
  workItems: WorkflowWorkItemRecord[]
}

export function finalizeProjectAggregate(
  draft: ProjectAggregateDraft,
  parity?: ProjectAggregateCanonicalParity
): ProjectAggregateSnapshot {
  const projectId = requiredProjectId(draft.projectId)
  const identityDigest = projectIdentityDigest(projectId)
  const base = {
    schemaVersion: PROJECT_AGGREGATE_SCHEMA_VERSION,
    format: PROJECT_AGGREGATE_FORMAT,
    ...draft,
    projectId,
    identityDigest,
    sanitized: true as const
  }
  verifyProjectAggregateRelations(base, parity)
  const entries = objectEntries(base)
  const objectCounts = objectCountsFromEntries(entries)
  const objectDigests = objectDigestsFromEntries(entries)
  const aggregateWithoutDigest = { ...base, objectCounts, objectDigests }
  const aggregate: ProjectAggregateSnapshot = {
    ...aggregateWithoutDigest,
    aggregateDigest: projectAggregateDigest(aggregateWithoutDigest)
  }
  verifyProjectAggregateSnapshot(aggregate, parity)
  return aggregate
}

export function verifyProjectAggregateSnapshot(
  aggregate: ProjectAggregateSnapshot,
  parity?: ProjectAggregateCanonicalParity
): void {
  if (aggregate.schemaVersion !== PROJECT_AGGREGATE_SCHEMA_VERSION || aggregate.format !== PROJECT_AGGREGATE_FORMAT) {
    throw aggregateIntegrityError('Project aggregate schema identity is invalid')
  }
  if (aggregate.sanitized !== true) throw aggregateIntegrityError('Project aggregate is not sanitized')
  if (aggregate.identityDigest !== projectIdentityDigest(aggregate.projectId)) {
    throw aggregateIntegrityError('Project aggregate identity digest mismatch', { projectId: aggregate.projectId })
  }
  verifyProjectAggregateRelations(aggregate, parity)
  const entries = objectEntries(aggregate)
  const expectedCounts = objectCountsFromEntries(entries)
  const expectedDigests = objectDigestsFromEntries(entries)
  if (projectAggregateCanonicalJson(aggregate.objectCounts) !== projectAggregateCanonicalJson(expectedCounts)) {
    throw aggregateIntegrityError('Project aggregate object counts mismatch', { projectId: aggregate.projectId })
  }
  if (projectAggregateCanonicalJson(aggregate.objectDigests) !== projectAggregateCanonicalJson(expectedDigests)) {
    throw aggregateIntegrityError('Project aggregate object digests mismatch', { projectId: aggregate.projectId })
  }
  const { aggregateDigest, ...withoutDigest } = aggregate
  if (aggregateDigest !== projectAggregateDigest(withoutDigest)) {
    throw aggregateIntegrityError('Project aggregate digest mismatch', { projectId: aggregate.projectId })
  }
  assertNoCredentialMaterial(aggregate)
}

export function verifyProjectAggregateSeal(
  aggregate: ProjectAggregateSnapshot,
  seal: ProjectAggregateSeal
): void {
  if (seal.projectId !== aggregate.projectId || seal.identityDigest !== aggregate.identityDigest) {
    throw aggregateIntegrityError('Project aggregate seal identity mismatch', { projectId: aggregate.projectId })
  }
  if (
    seal.projectRevision !== aggregate.projectRevision ||
    seal.aggregateDigest !== aggregate.aggregateDigest ||
    projectAggregateCanonicalJson(seal.objectCounts) !== projectAggregateCanonicalJson(aggregate.objectCounts) ||
    projectAggregateCanonicalJson(seal.objectDigests) !== projectAggregateCanonicalJson(aggregate.objectDigests)
  ) {
    throw aggregateIntegrityError('Project aggregate differs from its durable seal', {
      projectId: aggregate.projectId,
      aggregateRevision: seal.aggregateRevision
    })
  }
}

export function assertProjectOwnsReferences(
  aggregate: ProjectAggregateSnapshot,
  references: readonly ProjectAggregateReference[]
): ProjectAggregateReference[] {
  const normalized = references.map((reference) => ({
    kind: normalizeKind(reference.kind),
    id: requiredObjectId(reference.id, `${reference.kind} id`)
  }))
  for (const reference of normalized) {
    if (!aggregate.objectDigests[reference.kind][reference.id]) {
      throw new ProjectAggregateError(
        'PROJECT_SCOPE_CONFLICT',
        `${reference.kind} ${reference.id} is not owned by Project ${aggregate.projectId}`,
        { projectId: aggregate.projectId, kind: reference.kind, id: reference.id }
      )
    }
  }
  return normalized
}

export function projectIdentityDigest(projectId: string): string {
  return projectAggregateDigest({
    schemaVersion: PROJECT_AGGREGATE_SCHEMA_VERSION,
    namespace: 'caogen.project.identity.v1',
    projectId: requiredProjectId(projectId)
  })
}

function verifyProjectAggregateRelations(
  aggregate: ProjectAggregateDraft & {
    schemaVersion: 1
    format: typeof PROJECT_AGGREGATE_FORMAT
    identityDigest: string
    sanitized: true
  },
  parity?: ProjectAggregateCanonicalParity
): void {
  const projectId = requiredProjectId(aggregate.projectId)
  const { goals, workItems } = verifyWorkspaceRelations(aggregate, projectId, parity)
  verifyWorkforceRelations(aggregate, projectId, workItems)
  verifyWorkflowRelations(aggregate, goals, workItems)
  verifyProjectOwnedCollections(aggregate, projectId)
}

function verifyWorkspaceRelations(
  aggregate: ProjectAggregateDraft & { workspace: ProjectAggregateSnapshot['workspace'] },
  projectId: string,
  parity?: ProjectAggregateCanonicalParity
): {
  goals: Map<string, ProjectAggregateSnapshot['goals'][number]>
  workItems: Map<string, ProjectAggregateSnapshot['workItems'][number]>
} {
  if (aggregate.workspace.id !== projectId) fail('Workspace does not own the aggregate Project', projectId)
  if (aggregate.projectRevision !== aggregate.workspace.revision) fail('Project revision does not match Workspace', projectId)
  assertUnique(aggregate.resources.map((resource) => resource.id), 'Resource', projectId)
  const workspaceResources = [...aggregate.workspace.resources].sort((left, right) => left.id.localeCompare(right.id))
  if (projectAggregateCanonicalJson(aggregate.resources) !== projectAggregateCanonicalJson(workspaceResources)) {
    fail('Aggregate Resources differ from Workspace Resources', projectId)
  }

  const goals = uniqueMap(aggregate.goals, 'Goal', projectId)
  const workItems = uniqueMap(aggregate.workItems, 'WorkItem', projectId)
  for (const goal of goals.values()) assertProject(goal.projectId, projectId, `Goal ${goal.id}`)
  for (const item of workItems.values()) {
    assertProject(item.projectId, projectId, `WorkItem ${item.id}`)
    if (item.goalId && !goals.has(item.goalId)) fail(`WorkItem ${item.id} references missing Goal ${item.goalId}`, projectId)
    if (item.parentId && !workItems.has(item.parentId)) fail(`WorkItem ${item.id} references missing parent ${item.parentId}`, projectId)
    for (const dependencyId of item.dependencyIds) {
      if (!workItems.has(dependencyId)) fail(`WorkItem ${item.id} references missing dependency ${dependencyId}`, projectId)
    }
  }
  if (parity) verifyCanonicalParity(goals, workItems, parity, projectId)
  return { goals, workItems }
}

function verifyWorkforceRelations(
  aggregate: ProjectAggregateDraft,
  projectId: string,
  workItems: Map<string, ProjectAggregateSnapshot['workItems'][number]>
): void {
  const workers = uniqueMap(aggregate.digitalWorkers, 'DigitalWorker', projectId)
  const assignments = uniqueMap(aggregate.assignments, 'Assignment', projectId)
  const leases = uniqueMap(aggregate.leases, 'lease', projectId)
  for (const worker of workers.values()) assertProject(worker.projectId, projectId, `DigitalWorker ${worker.id}`)
  for (const assignment of assignments.values()) {
    assertProject(assignment.projectId, projectId, `Assignment ${assignment.id}`)
    if (!workItems.has(assignment.workItemId)) {
      fail(`Assignment ${assignment.id} references missing WorkItem ${assignment.workItemId}`, projectId)
    }
    if (assignment.assigneeKind === 'digital_worker') {
      const worker = workers.get(assignment.assigneeId)
      if (!worker) fail(`Assignment ${assignment.id} references missing DigitalWorker ${assignment.assigneeId}`, projectId)
    }
  }
  for (const lease of leases.values()) {
    assertProject(lease.projectId, projectId, `lease ${lease.id}`)
    if (!workItems.has(lease.workItemId)) fail(`lease ${lease.id} references missing WorkItem ${lease.workItemId}`, projectId)
    if (!assignments.has(lease.assignmentId)) fail(`lease ${lease.id} references missing Assignment ${lease.assignmentId}`, projectId)
    if (!workers.has(lease.workerId)) fail(`lease ${lease.id} references missing DigitalWorker ${lease.workerId}`, projectId)
  }
}

function verifyProjectOwnedCollections(aggregate: ProjectAggregateDraft, projectId: string): void {
  for (const memory of aggregate.memory) {
    assertProject(memory.projectId, projectId, `Memory ${memory.id}`)
    if (memory.record.id !== memory.id || memory.record.project !== memory.namespaceDigest) {
      fail(`Memory ${memory.id} namespace identity mismatch`, projectId)
    }
  }
  assertUnique(aggregate.memory.map((memory) => memory.id), 'Memory', projectId)
  for (const budget of aggregate.budgets) assertProject(budget.projectId, projectId, `Budget ${budget.id}`)
  for (const policy of aggregate.policies) assertProject(policy.projectId, projectId, `Policy ${policy.id}`)
  for (const event of aggregate.audit) assertProject(event.projectId, projectId, `Audit ${event.id}`)
  assertUnique(aggregate.budgets.map((budget) => budget.id), 'Budget', projectId)
  assertUnique(aggregate.policies.map((policy) => policy.id), 'Policy', projectId)
  assertUnique(aggregate.audit.map((event) => event.id), 'Audit', projectId)
}

function verifyCanonicalParity(
  goals: Map<string, ProjectAggregateSnapshot['goals'][number]>,
  workItems: Map<string, ProjectAggregateSnapshot['workItems'][number]>,
  parity: ProjectAggregateCanonicalParity,
  projectId: string
): void {
  const ledgerGoals = uniqueMap(parity.goals, 'Workflow Goal', projectId)
  const ledgerItems = uniqueMap(parity.workItems, 'Workflow WorkItem', projectId)
  assertExactIds(goals, ledgerGoals, 'Goal', projectId)
  assertExactIds(workItems, ledgerItems, 'WorkItem', projectId)
  verifyGoalParity(goals, ledgerGoals, projectId)
  verifyWorkItemParity(workItems, ledgerItems, projectId)
}

function verifyGoalParity(
  goals: Map<string, ProjectAggregateSnapshot['goals'][number]>,
  ledgerGoals: Map<string, ProjectAggregateCanonicalParity['goals'][number]>,
  projectId: string
): void {
  for (const [id, goal] of goals) {
    const ledger = ledgerGoals.get(id)!
    assertProject(ledger.projectId, projectId, `Workflow Goal ${id}`)
    if (!sameGoalProjection(goal, ledger)) fail(`Goal ${id} differs from its canonical Workflow Ledger projection`, projectId)
  }
}

function verifyWorkItemParity(
  workItems: Map<string, ProjectAggregateSnapshot['workItems'][number]>,
  ledgerItems: Map<string, ProjectAggregateCanonicalParity['workItems'][number]>,
  projectId: string
): void {
  for (const [id, item] of workItems) {
    const ledger = ledgerItems.get(id)!
    assertProject(ledger.projectId, projectId, `Workflow WorkItem ${id}`)
    if (!sameWorkItemProjection(item, ledger)) {
      fail(`WorkItem ${id} differs from its canonical Workflow Ledger projection`, projectId)
    }
  }
}

function sameGoalProjection(
  goal: ProjectAggregateSnapshot['goals'][number],
  ledger: ProjectAggregateCanonicalParity['goals'][number]
): boolean {
  return ledger.title === goal.title && ledger.objective === goal.objective &&
    ledger.status === goal.status && ledger.revision === goal.revision && ledger.source === 'explicit' &&
    ledger.createdAt === goal.createdAt && ledger.updatedAt === goal.updatedAt &&
    ledger.dueAt === goal.dueAt && ledger.archivedAt === goal.archivedAt
}

function sameWorkItemProjection(
  item: ProjectAggregateSnapshot['workItems'][number],
  ledger: ProjectAggregateCanonicalParity['workItems'][number]
): boolean {
  const sameRuns = projectAggregateCanonicalJson([...ledger.runIds].sort()) ===
    projectAggregateCanonicalJson([...item.runRefs].sort())
  const currentRunOwned = ledger.currentRunId === undefined || item.runRefs.includes(ledger.currentRunId)
  return ledger.goalId === item.goalId && ledger.parentId === item.parentId && ledger.type === item.type &&
    ledger.title === item.title && ledger.description === item.description && ledger.status === item.status &&
    ledger.revision === item.revision && ledger.source === 'explicit' && ledger.createdAt === item.createdAt &&
    ledger.updatedAt === item.updatedAt && ledger.dueAt === item.dueAt && sameRuns && currentRunOwned
}

function verifyWorkflowRelations(
  aggregate: ProjectAggregateDraft,
  goals: Map<string, ProjectAggregateSnapshot['goals'][number]>,
  workItems: Map<string, ProjectAggregateSnapshot['workItems'][number]>
): void {
  const projectId = aggregate.projectId
  const context: WorkflowRelationContext = {
    projectId,
    goals,
    workItems,
    runs: uniqueMap(aggregate.workflow.runs, 'Run', projectId),
    artifacts: uniqueMap(aggregate.workflow.artifacts, 'Artifact', projectId),
    acceptances: uniqueMap(aggregate.workflow.acceptances, 'Acceptance', projectId),
    workflowEvidence: uniqueMapBy(
    aggregate.workflow.workflowEvidence,
    (record) => record.evidenceId,
    'Workflow Evidence',
    projectId
    ),
    taskEvidence: uniqueMapBy(
    aggregate.workflow.taskEvidence,
    (record) => record.evidenceId,
    'Task Evidence',
    projectId
    )
  }
  verifyRunArtifactAcceptanceRelations(context)
  verifyEvidenceRelations(aggregate, context)
  verifyArtifactGraphRelations(aggregate, context)
}

interface WorkflowRelationContext {
  projectId: string
  goals: Map<string, ProjectAggregateSnapshot['goals'][number]>
  workItems: Map<string, ProjectAggregateSnapshot['workItems'][number]>
  runs: Map<string, ProjectAggregateSnapshot['workflow']['runs'][number]>
  artifacts: Map<string, ProjectAggregateSnapshot['workflow']['artifacts'][number]>
  acceptances: Map<string, ProjectAggregateSnapshot['workflow']['acceptances'][number]>
  workflowEvidence: Map<string, ProjectAggregateSnapshot['workflow']['workflowEvidence'][number]>
  taskEvidence: Map<string, ProjectAggregateSnapshot['workflow']['taskEvidence'][number]>
}

function verifyRunArtifactAcceptanceRelations(context: WorkflowRelationContext): void {
  const { projectId, goals, workItems, runs, artifacts, acceptances, workflowEvidence, taskEvidence } = context
  for (const run of runs.values()) verifyRunRelation(run, context)
  for (const artifact of artifacts.values()) {
    assertOptionalProject(artifact.projectId, projectId, `Artifact ${artifact.id}`)
    assertWorkflowOwners(artifact, goals, workItems, runs, `Artifact ${artifact.id}`, projectId)
    if (artifact.supersedesId && !artifacts.has(artifact.supersedesId)) {
      fail(`Artifact ${artifact.id} supersedes missing Artifact ${artifact.supersedesId}`, projectId)
    }
  }
  for (const acceptance of acceptances.values()) {
    assertOptionalProject(acceptance.projectId, projectId, `Acceptance ${acceptance.id}`)
    assertWorkflowOwners(acceptance, goals, workItems, runs, `Acceptance ${acceptance.id}`, projectId)
    for (const evidenceId of acceptance.evidenceRefs) {
      if (!workflowEvidence.has(evidenceId) && !taskEvidence.has(evidenceId)) {
        fail(`Acceptance ${acceptance.id} references missing Evidence ${evidenceId}`, projectId)
      }
    }
  }
}

function verifyRunRelation(
  run: ProjectAggregateSnapshot['workflow']['runs'][number],
  context: WorkflowRelationContext
): void {
  const { projectId, goals, workItems } = context
  assertOptionalProject(run.projectId, projectId, `Run ${run.id}`)
  const workItem = workItems.get(run.workItemId)
  if (!workItem) fail(`Run ${run.id} references missing WorkItem ${run.workItemId}`, projectId)
  if (run.goalId && (!goals.has(run.goalId) || workItem?.goalId !== run.goalId)) {
    fail(`Run ${run.id} has inconsistent Goal ownership`, projectId)
  }
}

function verifyEvidenceRelations(aggregate: ProjectAggregateDraft, context: WorkflowRelationContext): void {
  const { projectId, goals, workItems, runs, artifacts, acceptances, workflowEvidence, taskEvidence } = context
  for (const [id] of taskEvidence) {
    if (workflowEvidence.has(id)) fail(`Evidence ${id} is ambiguous across evidence stores`, projectId)
  }
  for (const evidence of workflowEvidence.values()) {
    assertProject(evidence.projectId, projectId, `Workflow Evidence ${evidence.evidenceId}`)
    assertWorkflowOwners(evidence, goals, workItems, runs, `Workflow Evidence ${evidence.evidenceId}`, projectId)
    if (evidence.artifactId && !artifacts.has(evidence.artifactId)) {
      fail(`Workflow Evidence ${evidence.evidenceId} references missing Artifact ${evidence.artifactId}`, projectId)
    }
  }
  for (const evidence of taskEvidence.values()) {
    assertOptionalProject(evidence.projectId, projectId, `Task Evidence ${evidence.evidenceId}`)
    if (!runs.has(evidence.runId)) fail(`Task Evidence ${evidence.evidenceId} references missing Run ${evidence.runId}`, projectId)
  }
  verifyEvidenceLinks(aggregate, context)
}

function verifyEvidenceLinks(aggregate: ProjectAggregateDraft, context: WorkflowRelationContext): void {
  const { projectId, runs, artifacts, acceptances, workflowEvidence, taskEvidence } = context
  for (const link of aggregate.workflow.evidenceLinks) {
    assertOptionalProject(link.projectId, projectId, `Evidence Link ${link.id}`)
    if (!workflowEvidence.has(link.evidenceId) && !taskEvidence.has(link.evidenceId)) {
      fail(`Evidence Link ${link.id} references missing Evidence ${link.evidenceId}`, projectId)
    }
    if (link.runId && !runs.has(link.runId)) fail(`Evidence Link ${link.id} references missing Run ${link.runId}`, projectId)
    if (link.artifactId && !artifacts.has(link.artifactId)) fail(`Evidence Link ${link.id} references missing Artifact ${link.artifactId}`, projectId)
    if (link.acceptanceId && !acceptances.has(link.acceptanceId)) {
      fail(`Evidence Link ${link.id} references missing Acceptance ${link.acceptanceId}`, projectId)
    }
  }
  assertUnique(aggregate.workflow.evidenceLinks.map((link) => link.id), 'Evidence Link', projectId)
}

function verifyArtifactGraphRelations(aggregate: ProjectAggregateDraft, context: WorkflowRelationContext): void {
  const { projectId, artifacts } = context
  for (const edge of aggregate.workflow.artifactEdges) {
    assertOptionalProject(edge.projectId, projectId, `Artifact Edge ${edge.id}`)
    if (!artifacts.has(edge.fromArtifactId) || !artifacts.has(edge.toArtifactId)) {
      fail(`Artifact Edge ${edge.id} references an Artifact outside Project ${projectId}`, projectId)
    }
  }
  for (const location of aggregate.workflow.artifactLocations) {
    assertOptionalProject(location.projectId, projectId, `Artifact Location ${location.id}`)
    if (!artifacts.has(location.artifactId)) {
      fail(`Artifact Location ${location.id} references missing Artifact ${location.artifactId}`, projectId)
    }
  }
  assertUnique(aggregate.workflow.artifactEdges.map((edge) => edge.id), 'Artifact Edge', projectId)
  assertUnique(aggregate.workflow.artifactLocations.map((location) => location.id), 'Artifact Location', projectId)
}

function assertWorkflowOwners(
  record: { goalId?: string; workItemId?: string; runId?: string },
  goals: Map<string, unknown>,
  workItems: Map<string, { goalId?: string }>,
  runs: Map<string, { goalId?: string; workItemId: string }>,
  label: string,
  projectId: string
): void {
  const workItem = record.workItemId ? workItems.get(record.workItemId) : undefined
  const run = record.runId ? runs.get(record.runId) : undefined
  if (record.goalId && !goals.has(record.goalId)) fail(`${label} references missing Goal ${record.goalId}`, projectId)
  if (record.workItemId && !workItem) fail(`${label} references missing WorkItem ${record.workItemId}`, projectId)
  if (record.runId && !run) fail(`${label} references missing Run ${record.runId}`, projectId)
  if (goalWorkItemMismatch(record, workItem)) {
    fail(`${label} has inconsistent Goal/WorkItem ownership`, projectId)
  }
  if (runWorkItemMismatch(record, run)) {
    fail(`${label} has inconsistent Run/WorkItem ownership`, projectId)
  }
  if (runGoalMismatch(record, run)) {
    fail(`${label} has inconsistent Run/Goal ownership`, projectId)
  }
}

function goalWorkItemMismatch(
  record: { goalId?: string },
  workItem?: { goalId?: string }
): boolean {
  return Boolean(record.goalId && workItem?.goalId && workItem.goalId !== record.goalId)
}

function runWorkItemMismatch(
  record: { workItemId?: string },
  run?: { workItemId: string }
): boolean {
  return Boolean(run && record.workItemId && run.workItemId !== record.workItemId)
}

function runGoalMismatch(
  record: { goalId?: string },
  run?: { goalId?: string }
): boolean {
  return Boolean(run && record.goalId && run.goalId !== record.goalId)
}

function objectEntries(
  aggregate: ProjectAggregateDraft & { workspace: ProjectAggregateSnapshot['workspace'] }
): Record<ProjectAggregateObjectKind, Array<readonly [string, unknown]>> {
  const workflow = aggregate.workflow
  return {
    project: [[aggregate.workspace.id, aggregate.workspace]],
    resource: aggregate.resources.map((record) => [record.id, record]),
    goal: aggregate.goals.map((record) => [record.id, record]),
    work_item: aggregate.workItems.map((record) => [record.id, record]),
    digital_worker: aggregate.digitalWorkers.map((record) => [record.id, record]),
    assignment: aggregate.assignments.map((record) => [record.id, record]),
    lease: aggregate.leases.map((record) => [record.id, record]),
    run: workflow.runs.map((record) => [record.id, record]),
    artifact: workflow.artifacts.map((record) => [record.id, record]),
    artifact_edge: workflow.artifactEdges.map((record) => [record.id, record]),
    artifact_location: workflow.artifactLocations.map((record) => [record.id, record]),
    evidence: [
      ...workflow.taskEvidence.map((record) => [record.evidenceId, record] as const),
      ...workflow.workflowEvidence.map((record) => [record.evidenceId, record] as const)
    ],
    evidence_link: workflow.evidenceLinks.map((record) => [record.id, record]),
    acceptance: workflow.acceptances.map((record) => [record.id, record]),
    memory: aggregate.memory.map((record) => [record.id, record]),
    budget: aggregate.budgets.map((record) => [record.id, record]),
    policy: aggregate.policies.map((record) => [record.id, record]),
    audit: aggregate.audit.map((record) => [record.id, record])
  }
}

function objectCountsFromEntries(
  entries: Record<ProjectAggregateObjectKind, Array<readonly [string, unknown]>>
): ProjectAggregateObjectCounts {
  return Object.fromEntries(PROJECT_AGGREGATE_OBJECT_KINDS.map((kind) => [kind, entries[kind].length])) as ProjectAggregateObjectCounts
}

function objectDigestsFromEntries(
  entries: Record<ProjectAggregateObjectKind, Array<readonly [string, unknown]>>
): ProjectAggregateObjectDigests {
  const result = {} as ProjectAggregateObjectDigests
  for (const kind of PROJECT_AGGREGATE_OBJECT_KINDS) {
    const values: Record<string, string> = {}
    for (const [rawId, value] of entries[kind]) {
      const id = requiredObjectId(rawId, `${kind} id`)
      if (values[id]) throw aggregateIntegrityError(`Duplicate ${kind} id ${id}`)
      values[id] = projectAggregateDigest(value)
    }
    result[kind] = Object.fromEntries(Object.entries(values).sort(([left], [right]) => left.localeCompare(right)))
  }
  return result
}

function uniqueMap<T extends { id: string }>(items: readonly T[], label: string, projectId: string): Map<string, T> {
  return uniqueMapBy(items, (item) => item.id, label, projectId)
}

function uniqueMapBy<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  label: string,
  projectId: string
): Map<string, T> {
  const result = new Map<string, T>()
  for (const item of items) {
    const id = requiredObjectId(idOf(item), `${label} id`)
    if (result.has(id)) fail(`Duplicate ${label} ${id}`, projectId)
    result.set(id, item)
  }
  return result
}

function assertExactIds(
  expected: Map<string, unknown>,
  actual: Map<string, unknown>,
  label: string,
  projectId: string
): void {
  const expectedIds = [...expected.keys()].sort()
  const actualIds = [...actual.keys()].sort()
  if (projectAggregateCanonicalJson(expectedIds) !== projectAggregateCanonicalJson(actualIds)) {
    fail(`${label} ownership is incomplete between ProjectWorkspace and Workflow Ledger`, projectId)
  }
}

function assertUnique(ids: readonly string[], label: string, projectId: string): void {
  if (new Set(ids).size !== ids.length) fail(`Duplicate ${label} identity`, projectId)
}

function assertProject(actual: string | undefined, expected: string, label: string): void {
  if (actual !== expected) fail(`${label} is owned by Project ${String(actual)}, expected ${expected}`, expected)
}

function assertOptionalProject(actual: string | undefined, expected: string, label: string): void {
  if (actual !== undefined && actual !== expected) assertProject(actual, expected, label)
}

function normalizeKind(kind: ProjectAggregateObjectKind): ProjectAggregateObjectKind {
  if (!(PROJECT_AGGREGATE_OBJECT_KINDS as readonly string[]).includes(kind)) {
    throw new ProjectAggregateError('INVALID_INPUT', `Unknown Project aggregate object kind: ${String(kind)}`)
  }
  return kind
}

function fail(message: string, projectId: string): never {
  throw aggregateIntegrityError(message, { projectId })
}
