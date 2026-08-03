import { resolve } from 'node:path'
import type {
  ProjectAggregateAuthorization,
  ProjectAggregateAutomation,
  ProjectAggregateBudgetRecord,
  ProjectAggregateDependencies,
  ProjectAggregatePolicyRecord,
  ProjectAggregateQueryOptions,
  ProjectAggregateReference,
  ProjectAggregateRoots,
  ProjectAggregateSeal,
  ProjectAggregateSealOptions,
  ProjectAggregateSnapshot,
  ProjectAggregateVerification
} from '../../shared/project-aggregate-types'
import type { WorkflowLedgerExportSelection } from '../../shared/workflow-types'
import { DigitalWorkerStore } from '../digital-worker/domain-store'
import { ProjectWorkspaceStore } from '../project-workspace'
import { exportPersistedWorkflowLedger } from '../task/workflow-ledger-maintenance'
import { readRuns } from '../task/workflow-ledger-query'
import { digest as workflowDigest } from '../task/workflow-ledger-codec'
import { readTaskSnapshotDatabase } from '../task/task-snapshot'
import { readProjectRoutineSlice } from '../routines/routine-project-store'
import { projectAggregateCanonicalJson, sanitizeProjectAggregateValue } from './codec'
import { aggregateIntegrityError, ProjectAggregateError, requiredProjectId } from './errors'
import { buildProjectAggregateExport, buildProjectAggregateVerification } from './project-aggregate-export'
import { ProjectAggregateSealStore } from './project-aggregate-seal-store'
import {
  memoryAuditEvents,
  memoryRecords,
  readProjectMemoryNamespaces
} from './project-memory-adapter'
import {
  assertProjectOwnsReferences,
  finalizeProjectAggregate,
  verifyProjectAggregateSeal,
  type ProjectAggregateDraft
} from './project-ownership-verifier'

const LIVE_AGGREGATE_STABILITY_ATTEMPTS = 6
const LIVE_AGGREGATE_RETRY_BASE_MS = 20

export class ProjectAggregateService {
  readonly roots: ProjectAggregateRoots
  readonly seals: ProjectAggregateSealStore

  constructor(roots: ProjectAggregateRoots) {
    this.roots = normalizeRoots(roots)
    this.seals = new ProjectAggregateSealStore(this.roots.aggregateRoot)
  }

  /**
   * Seal is the commit point for the cross-store aggregate. Existing Projects
   * require an aggregate CAS revision, so stale writers cannot bless a newer
   * cross-store state accidentally.
   */
  async sealProject(
    projectId: string,
    options: ProjectAggregateSealOptions = {}
  ): Promise<ProjectAggregateSeal> {
    const id = requiredProjectId(projectId)
    const current = this.seals.readProject(id)
    if (current && options.expectedAggregateRevision === undefined) {
      throw new ProjectAggregateError(
        'REVISION_CONFLICT',
        `expectedAggregateRevision is required to reseal Project ${id}`,
        { projectId: id, actualAggregateRevision: current.aggregateRevision }
      )
    }
    if (!current && options.expectedAggregateRevision !== undefined && options.expectedAggregateRevision !== 0) {
      throw new ProjectAggregateError(
        'REVISION_CONFLICT',
        `stale_revision: Project aggregate ${id} has not been sealed`,
        { projectId: id, expectedAggregateRevision: options.expectedAggregateRevision, actualAggregateRevision: 0 }
      )
    }
    const firstRead = await this.collectProject(id)
    const aggregate = await this.collectProject(id)
    assertStableAggregateRead(firstRead, aggregate)
    const now = options.now ?? Date.now()
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new ProjectAggregateError('INVALID_INPUT', 'seal timestamp must be a non-negative safe integer')
    }
    const seal = this.seals.writeProject({
      schemaVersion: 1,
      projectId: id,
      projectRevision: aggregate.projectRevision,
      identityDigest: aggregate.identityDigest,
      aggregateDigest: aggregate.aggregateDigest,
      objectCounts: aggregate.objectCounts,
      objectDigests: aggregate.objectDigests,
      sealedAt: now
    }, current ? options.expectedAggregateRevision : 0)
    const committedRead = await this.collectProject(id)
    verifyProjectAggregateSeal(committedRead, seal)
    return seal
  }

  async queryProject(
    projectId: string,
    options: ProjectAggregateQueryOptions = {}
  ): Promise<ProjectAggregateSnapshot> {
    const id = requiredProjectId(projectId)
    const seal = this.requireSeal(id)
    assertExpectedSeal(seal, options)
    const aggregate = await this.collectProject(id)
    verifyProjectAggregateSeal(aggregate, seal)
    const currentSeal = this.requireSeal(id)
    if (
      currentSeal.aggregateRevision !== seal.aggregateRevision ||
      currentSeal.aggregateDigest !== seal.aggregateDigest
    ) {
      throw new ProjectAggregateError(
        'REVISION_CONFLICT',
        `Project aggregate ${id} was resealed during the query`,
        {
          projectId: id,
          expectedAggregateRevision: seal.aggregateRevision,
          actualAggregateRevision: currentSeal.aggregateRevision
        }
      )
    }
    return aggregate
  }

  async verifyProject(
    projectId: string,
    options: ProjectAggregateQueryOptions = {}
  ): Promise<ProjectAggregateVerification> {
    const aggregate = await this.queryProject(projectId, options)
    return buildProjectAggregateVerification(aggregate, this.stableSealFor(aggregate))
  }

  async exportProject(
    projectId: string,
    options: ProjectAggregateQueryOptions = {}
  ): Promise<ReturnType<typeof buildProjectAggregateExport>> {
    const aggregate = await this.queryProject(projectId, options)
    const firstAutomation = await readProjectRoutineSlice(this.roots.routineRoot, aggregate.projectId)
    const automation = await readProjectRoutineSlice(this.roots.routineRoot, aggregate.projectId)
    if (projectAggregateCanonicalJson(firstAutomation) !== projectAggregateCanonicalJson(automation)) {
      throw new ProjectAggregateError(
        'REVISION_CONFLICT',
        `Project automation ${aggregate.projectId} changed during export`,
        { projectId: aggregate.projectId }
      )
    }
    return buildProjectAggregateExport(
      aggregate,
      this.stableSealFor(aggregate),
      this.collectExportDependencies(aggregate),
      sanitizeProjectAggregateValue(automation) as ProjectAggregateAutomation
    )
  }

  async authorizeReferences(
    projectId: string,
    references: readonly ProjectAggregateReference[],
    options: ProjectAggregateQueryOptions = {}
  ): Promise<ProjectAggregateAuthorization> {
    const aggregate = await this.queryProject(projectId, options)
    const normalized = assertProjectOwnsReferences(aggregate, references)
    const seal = this.stableSealFor(aggregate)
    return {
      projectId: aggregate.projectId,
      aggregateRevision: seal.aggregateRevision,
      aggregateDigest: aggregate.aggregateDigest,
      references: normalized
    }
  }

  /** Validate the current cross-store state without requiring a release seal. */
  async verifyLiveProject(projectId: string): Promise<ProjectAggregateSnapshot> {
    const id = requiredProjectId(projectId)
    let firstRead = await this.collectProject(id, false)
    for (let attempt = 0; attempt < LIVE_AGGREGATE_STABILITY_ATTEMPTS; attempt += 1) {
      const aggregate = await this.collectProject(id, false)
      try {
        assertStableAggregateRead(firstRead, aggregate)
        return aggregate
      } catch (error) {
        if (!(error instanceof ProjectAggregateError) || error.code !== 'REVISION_CONFLICT' ||
            attempt + 1 >= LIVE_AGGREGATE_STABILITY_ATTEMPTS) {
          throw error
        }
        firstRead = aggregate
        await delay(LIVE_AGGREGATE_RETRY_BASE_MS * (2 ** attempt))
      }
    }
    throw new ProjectAggregateError('REVISION_CONFLICT', `Project aggregate ${id} did not stabilize`)
  }

  async authorizeLiveReferences(
    projectId: string,
    references: readonly ProjectAggregateReference[]
  ): Promise<ProjectAggregateAuthorization> {
    const aggregate = await this.verifyLiveProject(projectId)
    const normalized = assertProjectOwnsReferences(aggregate, references)
    return {
      projectId: aggregate.projectId,
      aggregateRevision: this.seals.readProject(aggregate.projectId)?.aggregateRevision ?? 0,
      aggregateDigest: aggregate.aggregateDigest,
      references: normalized
    }
  }

  private requireSeal(projectId: string): ProjectAggregateSeal {
    const seal = this.seals.readProject(projectId)
    if (!seal) {
      throw new ProjectAggregateError(
        'PROJECT_NOT_SEALED',
        `Project aggregate is not sealed: ${projectId}`,
        { projectId }
      )
    }
    return seal
  }

  private stableSealFor(aggregate: ProjectAggregateSnapshot): ProjectAggregateSeal {
    const seal = this.requireSeal(aggregate.projectId)
    verifyProjectAggregateSeal(aggregate, seal)
    return seal
  }

  private collectExportDependencies(aggregate: ProjectAggregateSnapshot): ProjectAggregateDependencies {
    const requiredRoleIds = new Set(aggregate.digitalWorkers.map((worker) => worker.roleTemplateId))
    const roleTemplates = new DigitalWorkerStore(this.roots.digitalWorkerRoot).read().roleTemplates
      .filter((role) => requiredRoleIds.has(role.id))
      .sort(byId)
    const foundRoleIds = new Set(roleTemplates.map((role) => role.id))
    const missing = [...requiredRoleIds].filter((id) => !foundRoleIds.has(id)).sort()
    if (missing.length > 0) {
      throw aggregateIntegrityError(`Project export is missing RoleTemplate dependencies: ${missing.join(', ')}`, {
        projectId: aggregate.projectId
      })
    }
    return sanitizeProjectAggregateValue({ roleTemplates }) as ProjectAggregateDependencies
  }

  private async collectProject(projectId: string, enforceCanonicalParity = true): Promise<ProjectAggregateSnapshot> {
    const workspaceStore = new ProjectWorkspaceStore(this.roots.workspaceRoot)
    const workerStore = new DigitalWorkerStore(this.roots.digitalWorkerRoot)
    const legacyRoots = this.roots.legacyLearningRoots?.[projectId] ?? []
    const [workspaceState, workflowExport, memoryStates, workflowRuns] = await Promise.all([
      workspaceStore.open().then(() => workspaceStore.getState()),
      exportPersistedWorkflowLedger({ scope: { projectId } }, this.roots.workflowRoot),
      readProjectMemoryNamespaces(projectId, this.roots.learningRoot, legacyRoots),
      readTaskSnapshotDatabase(this.roots.workflowRoot, (db) =>
        readRuns(db).filter((run) => run.projectId === projectId).sort(byId))
    ])
    const workerState = workerStore.read()
    const workspace = workspaceState.workspaces.find((candidate) => candidate.id === projectId)
    if (!workspace) {
      throw new ProjectAggregateError('PROJECT_NOT_FOUND', `Project not found: ${projectId}`, { projectId })
    }

    const goals = workspaceState.goals.filter((goal) => goal.projectId === projectId).sort(byId)
    const workItems = workspaceState.workItems.filter((item) => item.projectId === projectId).sort(byId)
    const squads = workspaceState.squads.filter((squad) => squad.projectId === projectId).sort(byId)
    const comments = workspaceState.comments.filter((comment) => comment.projectId === projectId).sort(byId)
    const workspaceAudit = workspaceState.events.filter((event) => event.projectId === projectId).sort(byEvent)
    const digitalWorkers = workerState.workers.filter((worker) => worker.projectId === projectId).sort(byId)
    const assignments = workerState.assignments.filter((assignment) => assignment.projectId === projectId).sort(byId)
    const leases = workerState.leases.filter((lease) => lease.projectId === projectId).sort(byId)
    const workerAudit = workerState.audit.filter((event) => event.projectId === projectId).sort(byOccurredAt)
    const memories = memoryRecords(projectId, memoryStates).sort(byId)
    const learningAudit = memoryAuditEvents(projectId, memoryStates).sort((left, right) =>
      Date.parse(left.event.at) - Date.parse(right.event.at) || left.id.localeCompare(right.id)
    )
    const ledger = workflowExport.ledger
    const workflow = workflowSelection(ledger, workflowRuns)
    const audit = [
      ...workspaceAudit.map((event) => ({
        id: `project-workspace:${event.id}`,
        projectId,
        source: 'project_workspace' as const,
        occurredAt: event.occurredAt,
        value: event
      })),
      ...ledger.events.items.map((event) => ({
        id: `workflow-ledger:${event.eventId}`,
        projectId,
        source: 'workflow_ledger' as const,
        occurredAt: event.occurredAt,
        value: event
      })),
      ...workerAudit.map((event) => ({
        id: `digital-worker:${event.id}`,
        projectId,
        source: 'digital_worker' as const,
        occurredAt: event.occurredAt,
        value: event
      })),
      ...learningAudit.map((entry) => ({
        id: `learning:${entry.id}`,
        projectId,
        source: 'learning' as const,
        occurredAt: entry.event.at,
        value: entry
      }))
    ].sort(byOccurredAt)

    const rawDraft: ProjectAggregateDraft = {
      projectId,
      projectRevision: workspace.revision,
      workspace,
      resources: [...workspace.resources].sort(byId),
      goals,
      workItems,
      squads,
      comments,
      digitalWorkers,
      assignments,
      leases,
      workflow,
      memory: memories,
      budgets: buildBudgets(projectId, workspace, goals, digitalWorkers),
      policies: buildPolicies(projectId, workspace, digitalWorkers),
      audit
    }
    const sanitized = sanitizeProjectAggregateValue(rawDraft) as ProjectAggregateDraft
    return finalizeProjectAggregate(sanitized, enforceCanonicalParity ? {
      goals: ledger.goals.items,
      workItems: ledger.workItems.items
    } : undefined)
  }
}

function workflowSelection(
  ledger: WorkflowLedgerExportSelection,
  fullRuns: ProjectAggregateDraft['workflow']['runs']
): ProjectAggregateDraft['workflow'] {
  const payloads = new Map(fullRuns.map((run) => [run.id, run]))
  const runs = ledger.runs.items.map((metadata) => {
    const full = payloads.get(metadata.id)
    if (!full || workflowDigest(full.taskRun) !== metadata.taskRunDigest) {
      throw aggregateIntegrityError(`Run ${metadata.id} restorable payload does not match its export digest`, {
        projectId: metadata.projectId
      })
    }
    const { taskRunDigest: _taskRunDigest, ...projection } = metadata
    return { ...projection, taskRun: full.taskRun }
  })
  if (runs.length !== fullRuns.length) {
    throw aggregateIntegrityError('Project Run export is not closed over its restorable payloads')
  }
  return {
    runs: runs.sort(byId),
    artifacts: [...ledger.artifacts.items].sort(byId),
    artifactEdges: [...ledger.artifactEdges.items].sort(byId),
    artifactLocations: [...ledger.artifactLocations.items].sort(byId),
    acceptances: [...ledger.acceptances.items].sort(byId),
    evidenceLinks: [...ledger.evidenceLinks.items].sort(byId),
    taskEvidence: [...ledger.taskEvidence.items].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)),
    workflowEvidence: [...ledger.workflowEvidence.items].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))
  }
}

function buildBudgets(
  projectId: string,
  workspace: ProjectAggregateDraft['workspace'],
  goals: ProjectAggregateDraft['goals'],
  workers: ProjectAggregateDraft['digitalWorkers']
): ProjectAggregateBudgetRecord[] {
  const budgets: ProjectAggregateBudgetRecord[] = [
    {
      id: `project:${projectId}:budget`,
      projectId,
      ownerKind: 'project' as const,
      ownerId: projectId,
      value: workspace.budgetPolicy ?? {}
    },
    ...goals.filter((goal) => goal.budget).map((goal) => ({
      id: `goal:${goal.id}:budget`,
      projectId,
      ownerKind: 'goal' as const,
      ownerId: goal.id,
      value: goal.budget as unknown as Record<string, unknown>
    })),
    ...workers.map((worker) => ({
      id: `digital-worker:${worker.id}:budget`,
      projectId,
      ownerKind: 'digital_worker' as const,
      ownerId: worker.id,
      value: worker.budgetPolicy
    }))
  ]
  return budgets.sort(byId)
}

function buildPolicies(
  projectId: string,
  workspace: ProjectAggregateDraft['workspace'],
  workers: ProjectAggregateDraft['digitalWorkers']
): ProjectAggregatePolicyRecord[] {
  const projectPolicies: ProjectAggregatePolicyRecord[] = [
    ['permission', workspace.permissionPolicy ?? {}],
    ['retention', workspace.retentionPolicy ?? {}],
    ['rules', workspace.rulesRef ?? null]
  ].map(([policyKind, value]) => ({
    id: `project:${projectId}:policy:${String(policyKind)}`,
    projectId,
    ownerKind: 'project',
    ownerId: projectId,
    policyKind: String(policyKind),
    value
  }))
  const workerPolicyKeys = [
    'toolPolicy', 'dataScope', 'memoryNamespace', 'budgetPolicy', 'concurrencyLimit',
    'acceptancePolicy', 'schedulePolicy', 'escalationPolicy'
  ] as const
  const workerPolicies = workers.flatMap((worker) => workerPolicyKeys.map((policyKind) => ({
    id: `digital-worker:${worker.id}:policy:${policyKind}`,
    projectId,
    ownerKind: 'digital_worker' as const,
    ownerId: worker.id,
    policyKind,
    value: worker[policyKind]
  })))
  return [...projectPolicies, ...workerPolicies].sort(byId)
}

function normalizeRoots(roots: ProjectAggregateRoots): ProjectAggregateRoots {
  if (!roots || typeof roots !== 'object') throw new ProjectAggregateError('INVALID_INPUT', 'Project aggregate roots are required')
  return {
    workspaceRoot: normalizeRoot(roots.workspaceRoot, 'workspaceRoot'),
    workflowRoot: normalizeRoot(roots.workflowRoot, 'workflowRoot'),
    digitalWorkerRoot: normalizeRoot(roots.digitalWorkerRoot, 'digitalWorkerRoot'),
    routineRoot: normalizeRoot(roots.routineRoot, 'routineRoot'),
    learningRoot: normalizeRoot(roots.learningRoot, 'learningRoot'),
    aggregateRoot: normalizeRoot(roots.aggregateRoot, 'aggregateRoot'),
    legacyLearningRoots: roots.legacyLearningRoots
  }
}

function normalizeRoot(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new ProjectAggregateError('INVALID_INPUT', `${label} is required`)
  }
  return resolve(value.trim())
}

function assertExpectedSeal(seal: ProjectAggregateSeal, options: ProjectAggregateQueryOptions): void {
  if (
    options.expectedAggregateRevision !== undefined &&
    options.expectedAggregateRevision !== seal.aggregateRevision
  ) {
    throw new ProjectAggregateError(
      'REVISION_CONFLICT',
      `stale_revision: Project aggregate ${seal.projectId} is at ${seal.aggregateRevision}`,
      {
        projectId: seal.projectId,
        expectedAggregateRevision: options.expectedAggregateRevision,
        actualAggregateRevision: seal.aggregateRevision
      }
    )
  }
  if (options.expectedAggregateDigest !== undefined && options.expectedAggregateDigest !== seal.aggregateDigest) {
    throw new ProjectAggregateError(
      'REVISION_CONFLICT',
      `stale_digest: Project aggregate ${seal.projectId} changed`,
      { projectId: seal.projectId }
    )
  }
}

function assertStableAggregateRead(
  first: ProjectAggregateSnapshot,
  second: ProjectAggregateSnapshot
): void {
  if (!isStableAggregateRead(first, second)) {
    throw new ProjectAggregateError(
      'REVISION_CONFLICT',
      `Project aggregate ${second.projectId} changed during the cross-store stable read`,
      {
        projectId: second.projectId,
        firstProjectRevision: first.projectRevision,
        secondProjectRevision: second.projectRevision,
        firstAggregateDigest: first.aggregateDigest,
        secondAggregateDigest: second.aggregateDigest
      }
    )
  }
}

function isStableAggregateRead(first: ProjectAggregateSnapshot, second: ProjectAggregateSnapshot): boolean {
  return first.projectId === second.projectId &&
    first.identityDigest === second.identityDigest &&
    first.projectRevision === second.projectRevision &&
    first.aggregateDigest === second.aggregateDigest
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function byId<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id)
}

function byEvent<T extends { occurredAt: number; id: string }>(left: T, right: T): number {
  return left.occurredAt - right.occurredAt || left.id.localeCompare(right.id)
}

function byOccurredAt<T extends { occurredAt: number | string; id: string }>(left: T, right: T): number {
  const leftTime = typeof left.occurredAt === 'number' ? left.occurredAt : Date.parse(left.occurredAt)
  const rightTime = typeof right.occurredAt === 'number' ? right.occurredAt : Date.parse(right.occurredAt)
  return leftTime - rightTime || left.id.localeCompare(right.id)
}
