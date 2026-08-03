import { existsSync, lstatSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { MutationOptions, ProjectDeletionResult } from '../../shared/project-workspace-types'
import { AssignmentOwnerJournal } from '../assignment-owner-coordinator/journal'
import { DigitalWorkerStore } from '../digital-worker/domain-store'
import { learningStatePath } from '../learning/learning-store'
import { createProductionProjectAggregateService } from '../project-aggregate/project-aggregate-factory'
import { projectLearningNamespace } from '../project-aggregate/project-memory-adapter'
import { openProjectWorkspaceStore } from '../project-workspace/store'
import { SupervisorStateStore } from '../task/supervisor-state'
import { readTaskSnapshotDatabase } from '../task/task-snapshot'
import { findWorkflowLedgerAuthorizedPurge } from '../task/workflow-ledger-authorized-purge'
import { selectConversationLedgerProjectSessionInventory } from '../task/conversation-ledger-store'
import { projectAggregateCanonicalJson } from '../project-aggregate/codec'
import { ProjectDeletionBackupStore } from './project-deletion-backup-store'
import {
  PROJECT_DELETION_PHASES,
  ProjectDeletionJournal,
  type ProjectDeletionJournalEntry,
  type ProjectDeletionPhase
} from './project-deletion-journal'
import {
  collectProjectSessionInventory,
  purgeProjectSessionData,
  scanProjectSessionResiduals
} from './project-session-purge'
import {
  captureProjectExternalResourceBoundaries,
  ProjectDeletionProofStore,
  type ProjectDeletionProof
} from './project-deletion-proof-store'
import {
  planWorkflowProjectPurgeBlobs,
  purgeWorkflowProjectData,
  scanWorkflowProjectResiduals
} from './workflow-project-purge'
import { purgeProjectRoutineSlice, scanProjectRoutineResiduals } from '../routines/routine-project-store'

export interface ProjectDeletionCoordinatorOptions {
  afterPhase?: (phase: ProjectDeletionPhase, entry: ProjectDeletionJournalEntry) => void | Promise<void>
}

type DeletionReceiptPatch = Partial<Pick<ProjectDeletionJournalEntry,
  'backupPath' | 'backupDigest' | 'exportDigest' | 'proofPath' | 'proofDigest'>>

interface DeletionProgress {
  current: () => number
  entry: () => ProjectDeletionJournalEntry
  advance: (phase: ProjectDeletionPhase, patch?: DeletionReceiptPatch) => Promise<void>
}

export async function purgeProjectPermanently(
  projectId: string,
  userDataRoot: string,
  mutationOptions: MutationOptions = {},
  options: ProjectDeletionCoordinatorOptions = {}
): Promise<ProjectDeletionResult> {
  const root = requiredRoot(userDataRoot)
  const id = requiredId(projectId, 'projectId')
  const journal = new ProjectDeletionJournal(root)
  let entry = journal.getPendingProject(id)
  if (!entry) entry = await prepareDeletion(id, root, mutationOptions, journal)
  return executeDeletion(root, entry, journal, options)
}

export async function resumeProjectDeletions(
  userDataRoot: string,
  options: ProjectDeletionCoordinatorOptions = {}
): Promise<ProjectDeletionResult[]> {
  const root = requiredRoot(userDataRoot)
  const journal = new ProjectDeletionJournal(root)
  const results: ProjectDeletionResult[] = []
  for (const entry of journal.listPending()) {
    results.push(await executeDeletion(root, entry, journal, options))
  }
  return results
}

async function prepareDeletion(
  projectId: string,
  root: string,
  mutationOptions: MutationOptions,
  journal: ProjectDeletionJournal
): Promise<ProjectDeletionJournalEntry> {
  const workspaceStore = await openProjectWorkspaceStore(root)
  const workspace = await workspaceStore.getWorkspace(projectId)
  if (!workspace) throw new Error(`Project not found: ${projectId}`)
  if (workspace.status !== 'deleted') {
    throw new Error(`Project ${projectId} must be moved to deleted state before permanent deletion`)
  }
  if (mutationOptions.expectedRevision !== undefined && mutationOptions.expectedRevision !== workspace.revision) {
    throw new Error(`stale_revision: Project ${projectId} is at ${workspace.revision}`)
  }
  const service = createProductionProjectAggregateService(root)
  const currentSeal = service.seals.readProject(projectId)
  const seal = await service.sealProject(projectId, {
    expectedAggregateRevision: currentSeal?.aggregateRevision ?? 0
  })
  const aggregate = await service.exportProject(projectId, {
    expectedAggregateRevision: seal.aggregateRevision,
    expectedAggregateDigest: seal.aggregateDigest
  })
  const workflowSessionIds = aggregate.bundle.aggregate.workflow.runs.map((run) => run.sessionId)
  const routineSessionIds = (aggregate.bundle.automation?.runs ?? [])
    .map((run) => run.sessionId)
    .filter((sessionId): sessionId is string => Boolean(sessionId))
  const conversationInventory = await readTaskSnapshotDatabase(root, (db) =>
    selectConversationLedgerProjectSessionInventory(db, projectId))
  const inventory = collectProjectSessionInventory(
    root,
    projectId,
    [...workflowSessionIds, ...routineSessionIds, ...conversationInventory.sessionIds],
    conversationInventory.sdkSessionIds
  )
  const artifactBlobDigests = await planWorkflowProjectPurgeBlobs(projectId, root)
  return journal.begin({
    projectId,
    expectedWorkspaceRevision: workspace.revision,
    sessionIds: inventory.sessionIds,
    sdkSessionIds: inventory.sdkSessionIds,
    artifactBlobDigests,
    externalResources: captureProjectExternalResourceBoundaries(aggregate.bundle.aggregate.resources)
  })
}

async function executeDeletion(
  root: string,
  initial: ProjectDeletionJournalEntry,
  journal: ProjectDeletionJournal,
  options: ProjectDeletionCoordinatorOptions
): Promise<ProjectDeletionResult> {
  let entry = initial
  const current = (): number => PROJECT_DELETION_PHASES.indexOf(entry.phase)
  const advance = async (
    phase: ProjectDeletionPhase,
    patch: DeletionReceiptPatch = {}
  ): Promise<void> => {
    entry = await journal.advance(entry.operationId, phase, patch)
    await options.afterPhase?.(phase, entry)
  }
  const progress: DeletionProgress = { current, entry: () => entry, advance }

  if (current() < phaseIndex('backup_written')) {
    const aggregate = await verifiedAggregateExport(root, entry.projectId)
    const receipt = new ProjectDeletionBackupStore(root).write(entry.operationId, entry.projectId, aggregate)
    await advance('backup_written', {
      backupPath: receipt.path,
      backupDigest: receipt.backupDigest,
      exportDigest: receipt.exportDigest
    })
  } else {
    requireBackupReceipt(root, entry)
  }

  if (current() < phaseIndex('workflow_purged')) {
    await purgeWorkflowProjectData(
      entry.projectId,
      root,
      entry.operationId,
      entry.sessionIds,
      entry.artifactBlobDigests
    )
    await advance('workflow_purged')
  }

  if (current() < phaseIndex('project_stores_purged')) {
    await new DigitalWorkerStore(root).purgeProject(entry.projectId)
    await new AssignmentOwnerJournal(root).purgeProject(entry.projectId)
    await new SupervisorStateStore(root).purgeProject(entry.projectId)
    createProductionProjectAggregateService(root).seals.purgeProject(entry.projectId)
    await advance('project_stores_purged')
  }

  if (current() < phaseIndex('automation_purged')) {
    await purgeProjectRoutineSlice(join(root, 'routines'), entry.projectId)
    await advance('automation_purged')
  } else {
    const residual = await scanProjectRoutineResiduals(join(root, 'routines'), entry.projectId)
    if (residual.routines > 0 || residual.runs > 0) {
      await purgeProjectRoutineSlice(join(root, 'routines'), entry.projectId)
    }
  }

  if (current() < phaseIndex('session_data_purged')) {
    purgeProjectSessionData(root, entry.projectId, entry.sessionIds, entry.sdkSessionIds)
    await advance('session_data_purged')
  }

  if (current() < phaseIndex('learning_purged')) {
    purgeCanonicalLearning(root, entry.projectId)
    await advance('learning_purged')
  }

  await purgeWorkspacePhase(root, progress)
  const residuals = await verifyAndWriteProof(root, progress)

  if (current() < phaseIndex('completed')) await advance('completed')
  const proof = await verifyProjectDeletionProof(root, entry.operationId)
  return {
    operationId: entry.operationId,
    projectId: entry.projectId,
    phase: 'completed',
    backupPath: entry.backupPath as string,
    backupDigest: entry.backupDigest as string,
    exportDigest: entry.exportDigest as string,
    proofPath: proof.proofPath,
    proofDigest: proof.proofDigest,
    sessionIds: [...entry.sessionIds],
    sdkSessionIds: [...entry.sdkSessionIds],
    residuals
  }
}

async function purgeWorkspacePhase(root: string, progress: DeletionProgress): Promise<void> {
  if (progress.current() >= phaseIndex('workspace_purged')) return
  const entry = progress.entry()
  const workspaceStore = await openProjectWorkspaceStore(root)
  const workspace = await workspaceStore.getWorkspace(entry.projectId)
  if (workspace) {
    if (workspace.status !== 'deleted') throw new Error(`Project ${entry.projectId} is no longer deleted`)
    if (workspace.revision !== entry.expectedWorkspaceRevision) {
      throw new Error(`stale_revision: Project ${entry.projectId} changed during permanent deletion`)
    }
    await workspaceStore.purgeWorkspace(entry.projectId, { expectedRevision: entry.expectedWorkspaceRevision })
  }
  await progress.advance('workspace_purged')
}

async function verifyAndWriteProof(
  root: string,
  progress: DeletionProgress
): Promise<Record<string, number>> {
  let entry = progress.entry()
  const residuals = await scanProjectDeletionResiduals(root, entry)
  if (progress.current() < phaseIndex('verified')) {
    assertNoResiduals(residuals)
    await progress.advance('verified')
    entry = progress.entry()
  }
  if (progress.current() < phaseIndex('proof_written')) {
    const proof = await writeDeletionProof(root, entry, residuals)
    await progress.advance('proof_written', { proofPath: proof.path, proofDigest: proof.proofDigest })
  } else {
    requireProofReceipt(root, entry)
  }
  return residuals
}

function assertNoResiduals(residuals: Readonly<Record<string, number>>): void {
  const total = Object.values(residuals).reduce((sum, value) => sum + value, 0)
  if (total !== 0) throw new Error(`Project deletion left ${total} residual records: ${JSON.stringify(residuals)}`)
}

async function writeDeletionProof(
  root: string,
  entry: ProjectDeletionJournalEntry,
  residuals: Readonly<Record<string, number>>
) {
  requireBackupReceipt(root, entry)
  const backup = new ProjectDeletionBackupStore(root).read(
    entry.backupPath as string,
    entry.operationId,
    entry.projectId
  )
  const authorization = await readTaskSnapshotDatabase(root, (db) =>
    findWorkflowLedgerAuthorizedPurge(db, entry.operationId))
  if (!authorization) throw new Error('project deletion authorized purge record is missing')
  return new ProjectDeletionProofStore(root).write({
    operationId: entry.operationId,
    projectId: entry.projectId,
    expectedWorkspaceRevision: entry.expectedWorkspaceRevision,
    backupPath: entry.backupPath as string,
    backupDigest: entry.backupDigest as string,
    exportDigest: entry.exportDigest as string,
    sessionIds: entry.sessionIds,
    sdkSessionIds: entry.sdkSessionIds,
    artifactBlobDigests: entry.artifactBlobDigests,
    authorizedPurge: authorization,
    residuals,
    externalResourcesBefore: entry.externalResources ??
      captureProjectExternalResourceBoundaries(backup.aggregateExport.aggregate.resources)
  })
}

export async function verifyProjectDeletionProof(
  userDataRoot: string,
  operationId: string
): Promise<{ proofPath: string; proofDigest: string; proof: ProjectDeletionProof; verifiedAt: number }> {
  const root = requiredRoot(userDataRoot)
  const operation = requiredId(operationId, 'operationId')
  const entry = new ProjectDeletionJournal(root).getOperation(operation)
  if (!entry) throw new Error(`project deletion operation not found: ${operation}`)
  if (entry.phase !== 'completed' || !entry.completedAt) {
    throw new Error(`project deletion operation ${operation} is not completed`)
  }
  if (!entry.proofPath || !entry.proofDigest) throw new Error('project deletion journal is missing its proof receipt')
  requireBackupReceipt(root, entry)
  const proof = new ProjectDeletionProofStore(root).read(entry.proofPath, operation, entry.projectId)
  if (proof.proofDigest !== entry.proofDigest) throw new Error('project deletion proof receipt changed')
  const authorization = await readTaskSnapshotDatabase(root, (db) =>
    findWorkflowLedgerAuthorizedPurge(db, operation))
  if (!authorization || authorization.projectId !== entry.projectId ||
      authorization.seq !== proof.authorizedPurge.seq || authorization.digest !== proof.authorizedPurge.recordDigest ||
      projectAggregateCanonicalJson(authorization.removed) !== projectAggregateCanonicalJson(proof.authorizedPurge.removed)) {
    throw new Error('project deletion proof no longer matches its authorized purge record')
  }
  const residuals = await scanProjectDeletionResiduals(root, entry)
  if (projectAggregateCanonicalJson(residuals) !== projectAggregateCanonicalJson(proof.residuals)) {
    throw new Error('project deletion proof no longer matches the live residual scan')
  }
  const total = Object.values(residuals).reduce((sum, value) => sum + value, 0)
  if (total !== 0) throw new Error(`project deletion proof verification found ${total} residual records`)
  return {
    proofPath: entry.proofPath,
    proofDigest: entry.proofDigest,
    proof,
    verifiedAt: Date.now()
  }
}

async function verifiedAggregateExport(root: string, projectId: string) {
  const service = createProductionProjectAggregateService(root)
  const currentSeal = service.seals.readProject(projectId)
  const seal = await service.sealProject(projectId, {
    expectedAggregateRevision: currentSeal?.aggregateRevision ?? 0
  })
  return service.exportProject(projectId, {
    expectedAggregateRevision: seal.aggregateRevision,
    expectedAggregateDigest: seal.aggregateDigest
  })
}

async function scanProjectDeletionResiduals(
  root: string,
  entry: ProjectDeletionJournalEntry
): Promise<Record<string, number>> {
  const workflow = await scanWorkflowProjectResiduals(entry.projectId, root, entry.sessionIds)
  const workers = new DigitalWorkerStore(root).read()
  const assignmentJournal = await new AssignmentOwnerJournal(root).countProject(entry.projectId)
  const supervisor = await new SupervisorStateStore(root).listRuns({ projectId: entry.projectId })
  const sessions = scanProjectSessionResiduals(root, entry.projectId, entry.sessionIds, entry.sdkSessionIds)
  const automation = await scanProjectRoutineResiduals(join(root, 'routines'), entry.projectId)
  const workspaceStore = await openProjectWorkspaceStore(root)
  const [workspace, workspaceState] = await Promise.all([
    workspaceStore.getWorkspace(entry.projectId),
    workspaceStore.getState()
  ])
  return {
    workflow: workflow.total,
    digitalWorkers: workers.workers.filter((record) => record.projectId === entry.projectId).length,
    assignments: workers.assignments.filter((record) => record.projectId === entry.projectId).length,
    leases: workers.leases.filter((record) => record.projectId === entry.projectId).length,
    workerAudit: workers.audit.filter((record) => record.projectId === entry.projectId).length,
    assignmentJournal: assignmentJournal.entries + assignmentJournal.audit,
    supervisor: supervisor.length,
    aggregateSeal: createProductionProjectAggregateService(root).seals.readProject(entry.projectId) ? 1 : 0,
    learning: existsSync(canonicalLearningPath(root, entry.projectId)) ? 1 : 0,
    routines: automation.routines,
    routineRuns: automation.runs,
    workspace: workspace ? 1 : 0,
    squads: workspaceState.squads.filter((record) => record.projectId === entry.projectId).length,
    comments: workspaceState.comments.filter((record) => record.projectId === entry.projectId).length,
    ...Object.fromEntries(Object.entries(sessions).map(([key, value]) => [`sessions.${key}`, value]))
  }
}

function purgeCanonicalLearning(root: string, projectId: string): void {
  const target = canonicalLearningPath(root, projectId)
  if (!existsSync(target)) return
  const stat = lstatSync(target)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('canonical Project Learning state is not a regular file')
  rmSync(target, { force: true })
}

function canonicalLearningPath(root: string, projectId: string): string {
  return learningStatePath(join(root, 'learning'), projectLearningNamespace(projectId))
}

function requireBackupReceipt(root: string, entry: ProjectDeletionJournalEntry): void {
  if (!entry.backupPath || !entry.backupDigest || !entry.exportDigest) {
    throw new Error('project deletion journal is missing its verified backup receipt')
  }
  const receipt = new ProjectDeletionBackupStore(root).verify(entry.backupPath, entry.operationId, entry.projectId)
  if (receipt.backupDigest !== entry.backupDigest || receipt.exportDigest !== entry.exportDigest) {
    throw new Error('project deletion backup receipt changed')
  }
}

function requireProofReceipt(root: string, entry: ProjectDeletionJournalEntry): void {
  if (!entry.proofPath || !entry.proofDigest) {
    throw new Error('project deletion journal is missing its proof receipt')
  }
  const receipt = new ProjectDeletionProofStore(root).verify(entry.proofPath, entry.operationId, entry.projectId)
  if (receipt.proofDigest !== entry.proofDigest) throw new Error('project deletion proof receipt changed')
}

function phaseIndex(phase: ProjectDeletionPhase): number {
  return PROJECT_DELETION_PHASES.indexOf(phase)
}

function requiredRoot(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('userDataRoot is required')
  return resolve(value)
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\0-\x1f\x7f]/.test(value)) throw new Error(`${label} is required`)
  return value.trim()
}
