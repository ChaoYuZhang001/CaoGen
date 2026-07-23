import { lstat } from 'node:fs/promises'
import type {
  Goal,
  ProjectWorkspace,
  ProjectWorkspaceState,
  WorkItem
} from '../../shared/project-workspace-types'
import { digest, requiredId } from './codec'
import {
  listVerifiedCanonicalProjectWorkspaceIds,
  readVerifiedCanonicalProjectWorkspaceView,
  type VerifiedCanonicalProjectWorkspaceView
} from './ledger-canonical-view'
import {
  ensureProjectWorkspaceLedgerProjection,
  ensureProjectWorkspaceLedgerProjectionForScopedRead
} from './ledger-migration'
import { createProjectWorkspaceLedgerShadowBoundary } from './ledger-shadow-write'
import { createProjectWorkspaceCanonicalWriteBoundary } from './canonical-write'
import { ProjectWorkspaceError } from './errors'
import { projectWorkspaceFile } from './persistence'
import { openProjectWorkspaceStore, type ListOptions } from './store'

export type ProjectWorkspaceReadMode = 'legacy' | 'compare' | 'canonical'

export const PROJECT_WORKSPACE_READ_MODE_ENV = 'CAOGEN_PROJECT_WORKSPACE_READ_MODE'

const MAX_STABILITY_ATTEMPTS = 3
const canonicalSnapshotFlights = new Map<string, Promise<CanonicalReadSnapshot>>()

interface CanonicalReadSnapshot {
  state: ProjectWorkspaceState
  views: VerifiedCanonicalProjectWorkspaceView[]
}

type CanonicalReadScope =
  | { kind: 'all' }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'goal'; entityId: string }
  | { kind: 'workItem'; entityId: string }

export function normalizeProjectWorkspaceReadMode(value: unknown): ProjectWorkspaceReadMode {
  if (value === 'legacy' || value === 'compare' || value === 'canonical') return value
  throw new ProjectWorkspaceError(
    'invalid_read_mode',
    `ProjectWorkspace read mode must be legacy, compare, or canonical; received ${String(value)}`
  )
}

export function getProjectWorkspaceReadMode(): ProjectWorkspaceReadMode {
  const value = process.env[PROJECT_WORKSPACE_READ_MODE_ENV]
  return value === undefined || value.trim() === ''
    ? 'canonical'
    : normalizeProjectWorkspaceReadMode(value.trim())
}

/**
 * Goal/WorkItem payload reads default to the verified Ledger view. JSON remains
 * the write source and Workspace visibility registry until that lifecycle flips.
 */
export class ProjectWorkspaceReadService {
  constructor(
    readonly rootDir?: string,
    readonly mode: ProjectWorkspaceReadMode = getProjectWorkspaceReadMode()
  ) {}

  async listGoals(projectId?: string, options: ListOptions = {}): Promise<Goal[]> {
    if (this.mode === 'legacy') return (await openProjectWorkspaceStore(this.rootDir)).listGoals(projectId, options)
    const normalizedProjectId = projectId === undefined ? undefined : requiredId(projectId, 'projectId')
    const snapshot = await this.readCanonicalSnapshot(normalizedProjectId === undefined
      ? { kind: 'all' }
      : { kind: 'workspace', workspaceId: normalizedProjectId })
    const canonical = filterGoals(snapshot, normalizedProjectId, options)
    if (this.mode === 'compare') {
      assertParity('Goal list', canonical, filterLegacyGoals(snapshot.state, normalizedProjectId, options))
    }
    return canonical
  }

  async getGoal(id: string): Promise<Goal | undefined> {
    if (this.mode === 'legacy') return (await openProjectWorkspaceStore(this.rootDir)).getGoal(id)
    const snapshot = await this.readCanonicalSnapshot({ kind: 'goal', entityId: id })
    const canonical = uniqueEntity(snapshot.views.flatMap((view) => view.goals), id, 'Goal')
    if (this.mode === 'compare') {
      assertParity('Goal', canonical, snapshot.state.goals.find((goal) => goal.id === id))
    }
    return canonical
  }

  async listWorkItems(projectId?: string, options: ListOptions = {}): Promise<WorkItem[]> {
    if (this.mode === 'legacy') {
      return (await openProjectWorkspaceStore(this.rootDir)).listWorkItems(projectId, options)
    }
    const normalizedProjectId = projectId === undefined ? undefined : requiredId(projectId, 'projectId')
    const snapshot = await this.readCanonicalSnapshot(normalizedProjectId === undefined
      ? { kind: 'all' }
      : { kind: 'workspace', workspaceId: normalizedProjectId })
    const canonical = filterWorkItems(snapshot, normalizedProjectId, options)
    if (this.mode === 'compare') {
      assertParity('WorkItem list', canonical, filterLegacyWorkItems(snapshot.state, normalizedProjectId, options))
    }
    return canonical
  }

  async getWorkItem(id: string): Promise<WorkItem | undefined> {
    if (this.mode === 'legacy') return (await openProjectWorkspaceStore(this.rootDir)).getWorkItem(id)
    const snapshot = await this.readCanonicalSnapshot({ kind: 'workItem', entityId: id })
    const canonical = uniqueEntity(snapshot.views.flatMap((view) => view.workItems), id, 'WorkItem')
    if (this.mode === 'compare') {
      assertParity('WorkItem', canonical, snapshot.state.workItems.find((item) => item.id === id))
    }
    return canonical
  }

  private readCanonicalSnapshot(scope: CanonicalReadScope): Promise<CanonicalReadSnapshot> {
    const boundary = createProjectWorkspaceLedgerShadowBoundary(this.rootDir)
    const flightKey = `${boundary.rootDir}\u0000${canonicalScopeKey(scope)}`
    const existing = canonicalSnapshotFlights.get(flightKey)
    if (existing) return existing
    const flight = createProjectWorkspaceCanonicalWriteBoundary(boundary.rootDir).reconcile()
      .then(() => boundary.withConsistentProjectionRead((rootDir) => this.readStableSnapshot(rootDir, scope)))
    canonicalSnapshotFlights.set(flightKey, flight)
    void flight.finally(() => {
      if (canonicalSnapshotFlights.get(flightKey) === flight) {
        canonicalSnapshotFlights.delete(flightKey)
      }
    }).catch(() => undefined)
    return flight
  }

  private async readStableSnapshot(rootDir: string, scope: CanonicalReadScope): Promise<CanonicalReadSnapshot> {
    await assertCanonicalSourceRegistry(rootDir)
    const store = await openProjectWorkspaceStore(rootDir)
    for (let attempt = 0; attempt < MAX_STABILITY_ATTEMPTS; attempt += 1) {
      const before = await store.getState()
      try {
        const workspaces = workspacesForScope(before, scope)
        for (const workspace of workspaces) {
          if (scope.kind === 'all') {
            await ensureProjectWorkspaceLedgerProjection(workspace.id, rootDir)
          } else {
            await ensureProjectWorkspaceLedgerProjectionForScopedRead(workspace.id, rootDir)
          }
        }
        const views = await Promise.all(workspaces.map((workspace) =>
          readVerifiedCanonicalProjectWorkspaceView(workspace.id, rootDir)
        ))
        const after = await store.getState()
        if (after.revision !== before.revision) continue
        assertWorkspaceRegistryParity(workspacesForScope(after, scope), views)
        return { state: after, views }
      } catch (error) {
        const after = await store.getState()
        if (after.revision !== before.revision && attempt + 1 < MAX_STABILITY_ATTEMPTS) continue
        throw error
      }
    }
    throw new ProjectWorkspaceError(
      'canonical_read_source_unstable',
      'ProjectWorkspace source changed repeatedly while preparing a verified canonical read'
    )
  }
}

export function createProjectWorkspaceReadService(
  rootDir?: string,
  mode: ProjectWorkspaceReadMode = getProjectWorkspaceReadMode()
): ProjectWorkspaceReadService {
  return new ProjectWorkspaceReadService(rootDir, mode)
}

async function assertCanonicalSourceRegistry(rootDir: string): Promise<void> {
  try {
    const info = await lstat(projectWorkspaceFile(rootDir))
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new ProjectWorkspaceError(
        'canonical_read_source_invalid',
        'ProjectWorkspace canonical read requires a regular JSON workspace registry'
      )
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const canonicalIds = await listVerifiedCanonicalProjectWorkspaceIds(rootDir)
    if (canonicalIds.length > 0) {
      throw new ProjectWorkspaceError(
        'canonical_read_source_missing',
        'ProjectWorkspace JSON registry is missing after canonical migrations were committed',
        { canonicalWorkspaceIds: canonicalIds }
      )
    }
  }
}

function assertWorkspaceRegistryParity(
  workspaces: readonly ProjectWorkspace[],
  views: readonly VerifiedCanonicalProjectWorkspaceView[]
): void {
  if (workspaces.length !== views.length) {
    throw new ProjectWorkspaceError(
      'canonical_workspace_set_mismatch',
      'ProjectWorkspace registry and verified canonical Workspace set differ'
    )
  }
  const viewById = new Map(views.map((view) => [view.workspaceId, view]))
  for (const workspace of workspaces) {
    const view = viewById.get(workspace.id)
    if (!view || digest(view.workspace) !== digest(workspace)) {
      throw new ProjectWorkspaceError(
        'canonical_workspace_mismatch',
        `Workspace ${workspace.id} differs from its verified canonical view`
      )
    }
  }
}

function canonicalScopeKey(scope: CanonicalReadScope): string {
  if (scope.kind === 'all') return 'all'
  if (scope.kind === 'workspace') return `workspace:${scope.workspaceId}`
  return `${scope.kind}:${scope.entityId}`
}

function workspacesForScope(
  state: ProjectWorkspaceState,
  scope: CanonicalReadScope
): ProjectWorkspace[] {
  if (scope.kind === 'all') return state.workspaces
  if (scope.kind === 'workspace') return workspaceMatches(state, scope.workspaceId)
  const entities = scope.kind === 'goal' ? state.goals : state.workItems
  const matches = entities.filter((entity) => entity?.id === scope.entityId)
  if (matches.length > 1) {
    throw new ProjectWorkspaceError(
      'canonical_entity_identity_conflict',
      `${scope.kind === 'goal' ? 'Goal' : 'WorkItem'} ${scope.entityId} appears multiple times in the JSON source`
    )
  }
  const match = matches[0]
  if (!match) return []
  if (typeof match.projectId !== 'string' || match.projectId.trim().length === 0) {
    throw new ProjectWorkspaceError(
      'canonical_entity_workspace_invalid',
      `${scope.kind === 'goal' ? 'Goal' : 'WorkItem'} ${scope.entityId} has no valid Workspace identity`
    )
  }
  return workspaceMatches(state, match.projectId)
}

function workspaceMatches(state: ProjectWorkspaceState, workspaceId: string): ProjectWorkspace[] {
  const matches = state.workspaces.filter((workspace) => workspace?.id === workspaceId)
  if (matches.length > 1) {
    throw new ProjectWorkspaceError(
      'canonical_workspace_identity_conflict',
      `Workspace ${workspaceId} appears multiple times in the JSON source`
    )
  }
  if (matches.length === 0) {
    const referenced = state.goals.some((goal) => goal?.projectId === workspaceId) ||
      state.workItems.some((item) => item?.projectId === workspaceId)
    if (referenced) {
      throw new ProjectWorkspaceError(
        'canonical_workspace_reference_missing',
        `Workspace ${workspaceId} is referenced by a ProjectWorkspace entity but is missing`
      )
    }
  }
  return matches
}

function filterGoals(
  snapshot: CanonicalReadSnapshot,
  projectId: string | undefined,
  options: ListOptions
): Goal[] {
  const canonical = canonicalEntityMap(snapshot.views.flatMap((view) => view.goals), 'Goal')
  const workspaceById = new Map(snapshot.state.workspaces.map((workspace) => [workspace.id, workspace]))
  return snapshot.state.goals
    .filter((goal) => projectId === undefined || goal.projectId === projectId)
    .filter((goal) => options.includeArchived || goal.status !== 'archived')
    .filter((goal) => options.includeDeleted || workspaceStatus(workspaceById, goal.projectId) !== 'deleted')
    .map((goal) => canonicalEntity(canonical, goal.id, goal.projectId, 'Goal'))
}

function filterWorkItems(
  snapshot: CanonicalReadSnapshot,
  projectId: string | undefined,
  options: ListOptions
): WorkItem[] {
  const canonical = canonicalEntityMap(snapshot.views.flatMap((view) => view.workItems), 'WorkItem')
  const workspaceById = new Map(snapshot.state.workspaces.map((workspace) => [workspace.id, workspace]))
  return snapshot.state.workItems
    .filter((item) => projectId === undefined || item.projectId === projectId)
    .filter((item) => options.goalId === undefined || item.goalId === options.goalId)
    .filter((item) => options.includeDeleted || workspaceStatus(workspaceById, item.projectId) !== 'deleted')
    .map((item) => canonicalEntity(canonical, item.id, item.projectId, 'WorkItem'))
}

function filterLegacyGoals(
  state: ProjectWorkspaceState,
  projectId: string | undefined,
  options: ListOptions
): Goal[] {
  const workspaceById = new Map(state.workspaces.map((workspace) => [workspace.id, workspace]))
  return state.goals.filter((goal) => projectId === undefined || goal.projectId === projectId)
    .filter((goal) => options.includeArchived || goal.status !== 'archived')
    .filter((goal) => options.includeDeleted || workspaceById.get(goal.projectId)?.status !== 'deleted')
}

function filterLegacyWorkItems(
  state: ProjectWorkspaceState,
  projectId: string | undefined,
  options: ListOptions
): WorkItem[] {
  const workspaceById = new Map(state.workspaces.map((workspace) => [workspace.id, workspace]))
  return state.workItems.filter((item) => projectId === undefined || item.projectId === projectId)
    .filter((item) => options.goalId === undefined || item.goalId === options.goalId)
    .filter((item) => options.includeDeleted || workspaceById.get(item.projectId)?.status !== 'deleted')
}

function canonicalEntityMap<T extends { id: string }>(items: readonly T[], label: string): Map<string, T> {
  const result = new Map<string, T>()
  for (const item of items) {
    if (result.has(item.id)) {
      throw new ProjectWorkspaceError(
        'canonical_entity_identity_conflict',
        `${label} ${item.id} appears in multiple verified Workspace views`
      )
    }
    result.set(item.id, item)
  }
  return result
}

function canonicalEntity<T extends { id: string; projectId: string }>(
  entities: ReadonlyMap<string, T>,
  id: string,
  projectId: string,
  label: string
): T {
  const entity = entities.get(id)
  if (!entity || entity.projectId !== projectId) {
    throw new ProjectWorkspaceError(
      'canonical_entity_set_mismatch',
      `${label} ${id} is missing from its verified canonical Workspace view`
    )
  }
  return entity
}

function workspaceStatus(
  workspaces: ReadonlyMap<string, ProjectWorkspace>,
  projectId: string
): ProjectWorkspace['status'] {
  const workspace = workspaces.get(projectId)
  if (!workspace) {
    throw new ProjectWorkspaceError(
      'canonical_workspace_reference_missing',
      `Workspace ${projectId} is referenced by a ProjectWorkspace entity but is missing`
    )
  }
  return workspace.status
}

function uniqueEntity<T extends { id: string }>(items: readonly T[], id: string, label: string): T | undefined {
  const matches = items.filter((item) => item.id === id)
  if (matches.length > 1) {
    throw new ProjectWorkspaceError(
      'canonical_entity_identity_conflict',
      `${label} ${id} appears in multiple verified Workspace views`
    )
  }
  return matches[0]
}

function assertParity(label: string, canonical: unknown, legacy: unknown): void {
  if (digest(canonical) !== digest(legacy)) {
    throw new ProjectWorkspaceError(
      'canonical_read_mismatch',
      `${label} differs between canonical and legacy ProjectWorkspace read sources`
    )
  }
}
