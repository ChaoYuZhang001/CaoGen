import { useCallback, useId, useState } from 'react'
import type { ProjectResource, ProjectWorkspace } from '../../../../shared/types'
import {
  PROJECT_STATUS_LABELS,
  TEXT,
  resourceKindLabel,
  resourceLocation,
  type ProjectLifecyclePanel
} from './projectWorkspaceStudioModel'
import {
  ProjectDeleteDialog,
  ProjectEditForm,
  ProjectManifestDialog,
  ProjectResourceForm
} from './ProjectWorkspaceLifecycleForms'
import { useProjectWorkspaceLifecycle } from './useProjectWorkspaceLifecycle'
import './project-workspace-lifecycle.css'

interface Props {
  project: ProjectWorkspace
  refreshContents: () => Promise<void>
  refreshProjects: (preferredId?: string) => Promise<void>
}

export default function ProjectWorkspaceLifecycle({
  project,
  refreshContents,
  refreshProjects
}: Props): React.JSX.Element {
  const titleId = useId()
  const [panel, setPanel] = useState<ProjectLifecyclePanel>(null)
  const [deleteMode, setDeleteMode] = useState<'soft' | 'permanent' | null>(null)
  const closeInteraction = useCallback(() => {
    setPanel(null)
    setDeleteMode(null)
  }, [])
  const actions = useProjectWorkspaceLifecycle({
    project,
    refreshContents,
    refreshProjects,
    onMutationSuccess: closeInteraction
  })
  const busy = actions.busy !== null
  const openPanel = (next: Exclude<ProjectLifecyclePanel, null>): void => {
    actions.clearFeedback()
    setDeleteMode(null)
    setPanel((current) => current === next ? null : next)
  }
  const openDelete = (mode: 'soft' | 'permanent'): void => {
    actions.clearFeedback()
    setPanel(null)
    setDeleteMode(mode)
  }

  return (
    <section className="pws-lifecycle" aria-labelledby={titleId} aria-busy={busy} data-project-lifecycle data-project-status={project.status} data-project-revision={project.revision}>
      <header className="pws-lifecycle-header">
        <div className="pws-section-title">
          <h2 id={titleId}>{TEXT.projectSettings}</h2>
          <span className={`pws-status pws-status-${project.status}`}>{PROJECT_STATUS_LABELS[project.status]}</span>
        </div>
        <ProjectActionBar
          busy={busy}
          project={project}
          onArchive={() => void actions.archiveProject()}
          onDelete={() => openDelete('soft')}
          onEdit={() => openPanel('edit')}
          onExport={() => void actions.exportManifest()}
          onPurge={() => openDelete('permanent')}
          onResource={() => openPanel('resource')}
          onRestore={() => void actions.restoreProject()}
        />
      </header>

      {actions.error && <div className="notice notice-error pws-lifecycle-feedback" role="alert">{actions.error}</div>}
      {actions.announcement && <div className="pws-lifecycle-feedback pws-lifecycle-success" role="status" aria-live="polite">{actions.announcement}</div>}
      {project.status !== 'active' && (
        <p className="pws-lifecycle-notice">
          {project.status === 'archived' ? TEXT.archivedProjectNotice : TEXT.deletedProjectNotice}
        </p>
      )}

      {panel === 'edit' && project.status === 'active' && (
        <ProjectEditForm project={project} busy={busy} onCancel={() => setPanel(null)} onSubmit={actions.updateProject} />
      )}
      {panel === 'resource' && project.status === 'active' && (
        <ProjectResourceForm busy={busy} onCancel={() => setPanel(null)} onSubmit={actions.addResource} />
      )}

      <ProjectResourceList
        busy={busy}
        editable={project.status === 'active'}
        resources={project.resources}
        onAdd={() => openPanel('resource')}
        onRemove={(id) => void actions.removeResource(id)}
      />

      {deleteMode && (
        <ProjectDeleteDialog
          project={project}
          permanent={deleteMode === 'permanent'}
          busy={busy}
          onCancel={() => setDeleteMode(null)}
          onConfirm={deleteMode === 'permanent' ? actions.purgeProject : actions.softDeleteProject}
        />
      )}
      {actions.manifest && (
        <ProjectManifestDialog
          manifest={actions.manifest}
          projectName={project.name}
          onClose={actions.closeManifest}
          onCopy={actions.copyManifest}
        />
      )}
    </section>
  )
}

function ProjectActionBar({
  busy,
  onArchive,
  onDelete,
  onEdit,
  onExport,
  onPurge,
  onResource,
  onRestore,
  project
}: {
  busy: boolean
  onArchive: () => void
  onDelete: () => void
  onEdit: () => void
  onExport: () => void
  onPurge: () => void
  onResource: () => void
  onRestore: () => void
  project: ProjectWorkspace
}): React.JSX.Element {
  return (
    <div className="pws-lifecycle-actions" aria-label={TEXT.projectSettings}>
      {project.status === 'active' && <button type="button" className="btn btn-ghost btn-sm" onClick={onEdit} disabled={busy} data-project-action="edit">{TEXT.editProject}</button>}
      {project.status === 'active' && <button type="button" className="btn btn-ghost btn-sm" onClick={onResource} disabled={busy} data-project-action="add-resource">{TEXT.addResource}</button>}
      {project.status === 'active' && <button type="button" className="btn btn-ghost btn-sm" onClick={onArchive} disabled={busy} data-project-action="archive">{TEXT.archiveProject}</button>}
      {project.status !== 'active' && <button type="button" className="btn btn-primary btn-sm" onClick={onRestore} disabled={busy} data-project-action="restore">{TEXT.restoreProject}</button>}
      <button type="button" className="btn btn-ghost btn-sm" onClick={onExport} disabled={busy} data-project-action="export">{TEXT.exportManifest}</button>
      {project.status !== 'deleted' && <button type="button" className="btn btn-danger btn-sm" onClick={onDelete} disabled={busy} data-project-action="soft-delete">{TEXT.deleteProject}</button>}
      {project.status === 'deleted' && <button type="button" className="btn btn-danger btn-sm" onClick={onPurge} disabled={busy} data-project-action="purge">{TEXT.purgeProject}</button>}
    </div>
  )
}

function ProjectResourceList({
  busy,
  editable,
  onAdd,
  onRemove,
  resources
}: {
  busy: boolean
  editable: boolean
  onAdd: () => void
  onRemove: (id: string) => void
  resources: ProjectResource[]
}): React.JSX.Element {
  const titleId = useId()
  return (
    <div className="pws-resources" aria-labelledby={titleId}>
      <div className="pws-resources-header">
        <div className="pws-section-title"><h3 id={titleId}>{TEXT.resources}</h3><span>{resources.length}</span></div>
        {editable && <button type="button" className="btn btn-ghost btn-sm" onClick={onAdd} disabled={busy} data-project-action="add-resource-inline">{TEXT.addResource}</button>}
      </div>
      {resources.length === 0 ? <p className="pws-muted pws-resource-empty">{TEXT.noResources}</p> : (
        <div className="pws-resource-list" role="list">
          {resources.map((resource) => <ProjectResourceRow key={resource.id} resource={resource} busy={busy} editable={editable} onRemove={onRemove} />)}
        </div>
      )}
    </div>
  )
}

function ProjectResourceRow({
  busy,
  editable,
  onRemove,
  resource
}: {
  busy: boolean
  editable: boolean
  onRemove: (id: string) => void
  resource: ProjectResource
}): React.JSX.Element {
  const label = resource.label || resourceLocation(resource) || resource.id
  const kind = resource.kind === 'directory' && resource.metadata?.resourceType === 'repository'
    ? 'repository'
    : resource.kind
  return (
    <div className="pws-resource-row" role="listitem" data-project-resource-id={resource.id} data-project-resource-kind={kind}>
      <span className="pws-resource-kind">{resourceKindLabel(resource)}</span>
      <span className="pws-resource-copy"><strong>{label}</strong><small>{resourceLocation(resource)}</small></span>
      {editable && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRemove(resource.id)} disabled={busy} aria-label={TEXT.removeResource(label)} data-resource-action="remove">移除</button>}
    </div>
  )
}
