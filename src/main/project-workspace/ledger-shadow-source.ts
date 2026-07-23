import type { ProjectWorkspaceState } from '../../shared/project-workspace-types'
import { digest } from './codec'
import {
  projectWorkspaceFile,
  readProjectWorkspaceState
} from './persistence'
import type {
  ProjectWorkspaceLedgerPreparedDisposition,
  ProjectWorkspaceLedgerShadowEntity,
  ProjectWorkspaceLedgerShadowEntityType,
  ProjectWorkspaceLedgerShadowJournal,
  ProjectWorkspaceLedgerShadowSourceState
} from './ledger-shadow-types'

export function readProjectWorkspaceLedgerShadowSource(rootDir: string): Promise<ProjectWorkspaceState> {
  return readProjectWorkspaceState(projectWorkspaceFile(rootDir))
}

export function findProjectWorkspaceLedgerShadowEntity(
  state: ProjectWorkspaceState,
  entityType: ProjectWorkspaceLedgerShadowEntityType,
  entityId: string
): ProjectWorkspaceLedgerShadowEntity | undefined {
  return entityType === 'goal'
    ? state.goals.find((item) => item.id === entityId)
    : state.workItems.find((item) => item.id === entityId)
}

export function classifyPreparedShadowJournal(
  journal: ProjectWorkspaceLedgerShadowJournal,
  state: ProjectWorkspaceState
): ProjectWorkspaceLedgerPreparedDisposition {
  if (state.revision < journal.source.storeRevisionBefore) {
    return ambiguous('ProjectWorkspace store revision regressed below the prepared intent')
  }
  const entity = findProjectWorkspaceLedgerShadowEntity(state, journal.entityType, journal.entityId)
  const priorRevision = journal.source.entityRevisionBefore
  if (priorRevision === undefined) return classifyPreparedCreate(journal, state, entity)
  return classifyPreparedUpdate(journal, state, entity, priorRevision)
}

function classifyPreparedCreate(
  journal: ProjectWorkspaceLedgerShadowJournal,
  state: ProjectWorkspaceState,
  entity: ProjectWorkspaceLedgerShadowEntity | undefined
): ProjectWorkspaceLedgerPreparedDisposition {
  if (!entity) return { kind: 'not_committed' }
  if (journal.workspaceId && entity.projectId !== journal.workspaceId) {
    return ambiguous('Created entity ownership differs from the prepared intent')
  }
  return { kind: 'source_committed', state, entity, workspaceId: entity.projectId }
}

function classifyPreparedUpdate(
  journal: ProjectWorkspaceLedgerShadowJournal,
  state: ProjectWorkspaceState,
  entity: ProjectWorkspaceLedgerShadowEntity | undefined,
  priorRevision: number
): ProjectWorkspaceLedgerPreparedDisposition {
  if (!entity) return ambiguous('Prepared entity disappeared from the ProjectWorkspace source')
  if (journal.workspaceId && entity.projectId !== journal.workspaceId) {
    return ambiguous('Prepared entity changed immutable Workspace ownership')
  }
  if (entity.revision < priorRevision) return ambiguous('Prepared entity revision regressed in the source')
  if (entity.revision === priorRevision) {
    if (journal.source.entityDigestBefore && digest(entity) !== journal.source.entityDigestBefore) {
      return ambiguous('Prepared entity changed without a revision increment')
    }
    return { kind: 'not_committed' }
  }
  return { kind: 'source_committed', state, entity, workspaceId: entity.projectId }
}

function ambiguous(reason: string): ProjectWorkspaceLedgerPreparedDisposition {
  return { kind: 'ambiguous', reason }
}

export function assertShadowCommittedSourceContinuity(
  journal: ProjectWorkspaceLedgerShadowJournal,
  state: ProjectWorkspaceState
): string | undefined {
  const entity = findProjectWorkspaceLedgerShadowEntity(state, journal.entityType, journal.entityId)
  const afterRevision = journal.source.entityRevisionAfter
  if (!journal.workspaceId || !entity || afterRevision === undefined) {
    return 'Committed shadow journal no longer has a complete ProjectWorkspace source entity'
  }
  const storeRevision = journal.source.storeRevisionAfter ?? journal.source.storeRevisionBefore
  if (sourceRegressed(state, entity, storeRevision, afterRevision, journal.workspaceId)) {
    return 'ProjectWorkspace source regressed after its shadow journal recorded a commit'
  }
  if (entity.revision === afterRevision && journal.source.entityDigestAfter &&
      digest(entity) !== journal.source.entityDigestAfter) {
    return 'ProjectWorkspace source changed without revision after its shadow commit'
  }
  return undefined
}

function sourceRegressed(
  state: ProjectWorkspaceState,
  entity: ProjectWorkspaceLedgerShadowEntity,
  storeRevision: number,
  entityRevision: number,
  workspaceId: string
): boolean {
  return state.revision < storeRevision || entity.revision < entityRevision || entity.projectId !== workspaceId
}

export function shadowSourceAfter(
  source: ProjectWorkspaceLedgerShadowSourceState,
  state: ProjectWorkspaceState,
  entity: ProjectWorkspaceLedgerShadowEntity
): ProjectWorkspaceLedgerShadowSourceState {
  return {
    ...source,
    storeRevisionAfter: state.revision,
    entityRevisionAfter: entity.revision,
    entityDigestAfter: digest(entity)
  }
}

export function shadowProjectionCoversSource(
  journal: ProjectWorkspaceLedgerShadowJournal,
  state: ProjectWorkspaceState
): boolean {
  if (!journal.projection || journal.projection.stateRevision !== state.revision) return false
  const entity = findProjectWorkspaceLedgerShadowEntity(state, journal.entityType, journal.entityId)
  return Boolean(entity && entity.projectId === journal.workspaceId &&
    entity.revision === journal.source.entityRevisionAfter &&
    digest(entity) === journal.source.entityDigestAfter)
}
