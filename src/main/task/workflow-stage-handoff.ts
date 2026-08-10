import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import type { ProjectAggregateSnapshot } from '../../shared/project-aggregate-types'
import type { SessionMeta } from '../../shared/types'
import type { WorkItem, WorkItemType } from '../../shared/project-workspace-types'
import type { WorkflowArtifactRecord } from '../../shared/workflow-types'
import { createProductionProjectAggregateService } from '../project-aggregate/project-aggregate-factory'
import { openProjectWorkspaceCommandService } from '../project-workspace/command-service'
import { openProjectWorkspaceStore } from '../project-workspace/store'
import { createWorkflowArtifactEdge } from './workflow-ledger-api'
import { taskSnapshotsDbFile } from './task-snapshot'

const MAX_HANDOFF_ARTIFACTS = 24
const MAX_HANDOFF_PROMPT_CHARS = 24_000
const STAGE_ORDER: Partial<Record<WorkItemType, number>> = {
  research: 0,
  analysis: 1,
  planning: 2,
  writing: 3,
  design: 4,
  coding: 5,
  review: 6,
  testing: 7,
  documentation: 8,
  operations: 9,
  delivery: 10
}

type AggregateArtifact = ProjectAggregateSnapshot['workflow']['artifacts'][number]
type AggregateLocation = ProjectAggregateSnapshot['workflow']['artifactLocations'][number]

export interface WorkflowStageHandoffArtifact {
  artifact: AggregateArtifact
  location?: AggregateLocation
  source: 'explicit' | 'dependency' | 'parent' | 'prior_stage'
}

export interface WorkflowStageHandoff {
  projectId: string
  goalId?: string
  workItemId: string
  workItemType: WorkItemType
  artifacts: WorkflowStageHandoffArtifact[]
}

export async function resolveWorkflowStageHandoff(input: {
  projectId: string
  workItemId: string
  rootDir: string
}): Promise<WorkflowStageHandoff> {
  const aggregate = await createProductionProjectAggregateService(input.rootDir)
    .verifyLiveProject(input.projectId)
  const workItem = aggregate.workItems.find((candidate) => candidate.id === input.workItemId)
  if (!workItem || workItem.projectId !== aggregate.projectId) {
    throw new Error(`workflow handoff WorkItem does not belong to Project:${input.workItemId}`)
  }
  return {
    projectId: aggregate.projectId,
    goalId: workItem.goalId,
    workItemId: workItem.id,
    workItemType: workItem.type,
    artifacts: selectHandoffArtifacts(aggregate, workItem)
  }
}

export async function buildWorkflowStageHandoffPrompt(
  meta: SessionMeta,
  rootDir: string
): Promise<string> {
  const projectId = meta.workspaceId ?? meta.projectId
  if (!projectId || !meta.workItemId) return ''
  const handoff = await resolveWorkflowStageHandoff({ projectId, workItemId: meta.workItemId, rootDir })
  if (handoff.artifacts.length === 0) return ''
  const lines = [
    '# CaoGen Workflow Handoff',
    `Current WorkItem: ${handoff.workItemId} (${handoff.workItemType})`,
    'The following durable upstream Artifacts are already attached. Treat them as source material; do not ask the user to upload or restate them.'
  ]
  for (const item of handoff.artifacts) {
    const location = artifactLocationLabel(item.location, item.artifact)
    lines.push(
      `- [${item.artifact.kind}] ${item.artifact.title}`,
      `  artifactId: ${item.artifact.id}`,
      `  source: ${item.source}`,
      `  digest: ${item.artifact.digest}`,
      `  location: ${location}`
    )
  }
  lines.push('Use read_file/view for workspace file locations and preserve Artifact IDs in downstream provenance.')
  return lines.join('\n').slice(0, MAX_HANDOFF_PROMPT_CHARS)
}

export async function attachProducedArtifactToStage(input: {
  artifactId: string
  projectId: string
  workItemId: string
  runId: string
  rootDir?: string
}): Promise<void> {
  const rootDir = input.rootDir ?? dirname(taskSnapshotsDbFile())
  const aggregate = await createProductionProjectAggregateService(rootDir)
    .verifyLiveProject(input.projectId)
  const output = aggregate.workflow.artifacts.find((artifact) => artifact.id === input.artifactId)
  if (!output || output.projectId !== input.projectId || output.workItemId !== input.workItemId ||
      output.runId !== input.runId) {
    throw new Error(`produced Artifact is not bound to the current workflow stage:${input.artifactId}`)
  }
  const workItem = aggregate.workItems.find((candidate) => candidate.id === input.workItemId)
  if (!workItem) throw new Error(`produced Artifact WorkItem is missing:${input.workItemId}`)
  const sources = selectHandoffArtifacts(aggregate, workItem)
    .map((item) => item.artifact)
    .filter((artifact) => artifact.id !== output.id && artifact.runId !== output.runId)
  for (const source of sources) {
    await createWorkflowArtifactEdge({
      id: handoffEdgeId(source.id, output.id),
      fromArtifactId: source.id,
      toArtifactId: output.id,
      relation: 'input_to',
      projectId: input.projectId,
      ...(source.goalId && source.goalId === output.goalId ? { goalId: source.goalId } : {}),
      metadata: {
        automatic: true,
        sourceWorkItemId: source.workItemId,
        targetWorkItemId: input.workItemId,
        targetRunId: input.runId,
        targetStage: workItem.type
      },
      createdAt: output.createdAt,
      updatedAt: output.createdAt
    }, rootDir)
  }
  await attachArtifactReference(input.workItemId, input.artifactId, rootDir)
}

export function selectHandoffArtifacts(
  aggregate: ProjectAggregateSnapshot,
  workItem: WorkItem
): WorkflowStageHandoffArtifact[] {
  const sourceByArtifactId = new Map<string, WorkflowStageHandoffArtifact['source']>()
  for (const artifactId of workItem.artifactRefs) sourceByArtifactId.set(artifactId, 'explicit')

  const dependencyIds = dependencyClosure(aggregate.workItems, workItem)
  for (const artifact of aggregate.workflow.artifacts) {
    if (artifact.workItemId && dependencyIds.has(artifact.workItemId) && !sourceByArtifactId.has(artifact.id)) {
      sourceByArtifactId.set(artifact.id, 'dependency')
    }
    if (workItem.parentId && artifact.workItemId === workItem.parentId && !sourceByArtifactId.has(artifact.id)) {
      sourceByArtifactId.set(artifact.id, 'parent')
    }
  }

  if (sourceByArtifactId.size === 0 && workItem.goalId && STAGE_ORDER[workItem.type] !== undefined) {
    const currentOrder = STAGE_ORDER[workItem.type] as number
    const priorIds = new Set(aggregate.workItems
      .filter((candidate) => candidate.goalId === workItem.goalId && candidate.status === 'done' &&
        candidate.id !== workItem.id && STAGE_ORDER[candidate.type] !== undefined &&
        (STAGE_ORDER[candidate.type] as number) < currentOrder)
      .map((candidate) => candidate.id))
    for (const artifact of aggregate.workflow.artifacts) {
      if (artifact.workItemId && priorIds.has(artifact.workItemId)) {
        sourceByArtifactId.set(artifact.id, 'prior_stage')
      }
    }
  }

  const supersededIds = new Set(aggregate.workflow.artifacts
    .map((artifact) => artifact.supersedesId)
    .filter((id): id is string => Boolean(id)))
  const locations = availableLocationsByArtifact(aggregate.workflow.artifactLocations)
  return aggregate.workflow.artifacts
    .filter((artifact) =>
      sourceByArtifactId.has(artifact.id) &&
      !supersededIds.has(artifact.id) &&
      artifactAcceptanceAllowsHandoff(aggregate, artifact.id) &&
      artifactOutputBindingAllowsHandoff(artifact, locations.get(artifact.id))
    )
    .sort((left, right) => artifactPriority(sourceByArtifactId.get(left.id)!) -
      artifactPriority(sourceByArtifactId.get(right.id)!) || right.updatedAt - left.updatedAt ||
      left.id.localeCompare(right.id))
    .slice(0, MAX_HANDOFF_ARTIFACTS)
    .map((artifact) => ({
      artifact,
      location: locations.get(artifact.id),
      source: sourceByArtifactId.get(artifact.id)!
    }))
}

function artifactAcceptanceAllowsHandoff(
  aggregate: ProjectAggregateSnapshot,
  artifactId: string
): boolean {
  const acceptanceIds = new Set(aggregate.workflow.evidenceLinks
    .filter((link) => link.artifactId === artifactId && link.acceptanceId)
    .map((link) => link.acceptanceId as string))
  if (acceptanceIds.size === 0) return false
  const statuses = aggregate.workflow.acceptances
    .filter((acceptance) => acceptanceIds.has(acceptance.id))
    .map((acceptance) => acceptance.status)
  return statuses.length === acceptanceIds.size &&
    statuses.every((status) => status === 'passed' || status === 'waived')
}

function artifactOutputBindingAllowsHandoff(
  artifact: AggregateArtifact,
  location: AggregateLocation | undefined
): boolean {
  if (artifact.metadata?.producer !== 'office_delivery') return true
  const expectedSha256 = artifact.metadata.expectedSha256
  const expectedBytes = artifact.metadata.expectedBytes
  return artifact.metadata.outputBindingVersion === 1 && expectedSha256 === artifact.digest &&
    Number.isSafeInteger(expectedBytes) && (expectedBytes as number) >= 0 &&
    location?.checksum === expectedSha256 && location.sizeBytes === expectedBytes
}

function dependencyClosure(workItems: WorkItem[], workItem: WorkItem): Set<string> {
  const byId = new Map(workItems.map((candidate) => [candidate.id, candidate]))
  const result = new Set<string>()
  const pending = [...workItem.dependencyIds]
  while (pending.length > 0) {
    const id = pending.shift()!
    if (result.has(id)) continue
    const candidate = byId.get(id)
    if (!candidate || candidate.projectId !== workItem.projectId) continue
    result.add(id)
    pending.push(...candidate.dependencyIds)
  }
  return result
}

function availableLocationsByArtifact(locations: AggregateLocation[]): Map<string, AggregateLocation> {
  const rank: Record<AggregateLocation['kind'], number> = {
    file: 0, workspace: 1, attachment: 2, preview: 3, git: 4,
    url: 5, external: 6, blob: 7, custom: 8
  }
  const result = new Map<string, AggregateLocation>()
  for (const location of locations) {
    if (location.availability !== 'available') continue
    const existing = result.get(location.artifactId)
    if (!existing || rank[location.kind] < rank[existing.kind] ||
        (rank[location.kind] === rank[existing.kind] && location.updatedAt > existing.updatedAt)) {
      result.set(location.artifactId, location)
    }
  }
  return result
}

function artifactLocationLabel(location: AggregateLocation | undefined, artifact: WorkflowArtifactRecord): string {
  if (location?.path) return location.path
  if (location?.uri) return location.uri
  if (artifact.uri) return artifact.uri
  return 'durable store (resolve by artifactId)'
}

function artifactPriority(source: WorkflowStageHandoffArtifact['source']): number {
  if (source === 'explicit') return 0
  if (source === 'dependency') return 1
  if (source === 'parent') return 2
  return 3
}

function handoffEdgeId(fromArtifactId: string, toArtifactId: string): string {
  const digest = createHash('sha256')
    .update(`caogen.workflow-handoff.v1\0${fromArtifactId}\0${toArtifactId}`)
    .digest('hex')
    .slice(0, 32)
  return `artifact-handoff:${digest}`
}

async function attachArtifactReference(workItemId: string, artifactId: string, rootDir?: string): Promise<void> {
  const store = await openProjectWorkspaceStore(rootDir)
  const commands = await openProjectWorkspaceCommandService(rootDir)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const workItem = await store.getWorkItem(workItemId)
    if (!workItem) throw new Error(`Artifact target WorkItem is missing:${workItemId}`)
    if (workItem.artifactRefs.includes(artifactId)) return
    try {
      await commands.updateWorkItem(workItem.id, {
        artifactRefs: [...workItem.artifactRefs, artifactId]
      }, { expectedRevision: workItem.revision })
      return
    } catch (error) {
      if (!String(error).includes('stale_revision') || attempt === 3) throw error
    }
  }
}
