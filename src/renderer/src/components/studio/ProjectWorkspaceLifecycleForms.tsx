import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent
} from 'react'
import type {
  ProjectResourceInput,
  ProjectWorkspace,
  ProjectWorkspaceManifest,
  ProjectWorkspacePatch
} from '../../../../shared/types'
import {
  PROJECT_KIND_OPTIONS,
  PROJECT_RESOURCE_OPTIONS,
  TEXT,
  projectEditDraft,
  resourceInputFromDraft,
  type ProjectResourceDraft
} from './projectWorkspaceStudioModel'

export function ProjectEditForm({
  busy,
  onCancel,
  onSubmit,
  project
}: {
  busy: boolean
  onCancel: () => void
  onSubmit: (patch: ProjectWorkspacePatch) => Promise<void>
  project: ProjectWorkspace
}): React.JSX.Element {
  const baseId = useId()
  const [draft, setDraft] = useState(() => projectEditDraft(project))
  const update = <K extends keyof typeof draft>(field: K, value: typeof draft[K]): void => {
    setDraft((current) => ({ ...current, [field]: value }))
  }
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    void onSubmit({
      name: draft.name.trim(),
      kind: draft.kind,
      ownerId: draft.ownerId.trim(),
      rulesRef: draft.rulesRef.trim()
    })
  }
  return (
    <form className="pws-create-form pws-lifecycle-form" aria-labelledby={`${baseId}-title`} onSubmit={submit} onKeyDown={(event) => closeOnEscape(event, onCancel)} data-project-form="edit">
      <LifecycleFormHeader id={`${baseId}-title`} title={TEXT.editProject} disabled={busy} onCancel={onCancel} />
      <fieldset className="pws-fieldset" disabled={busy}>
        <div className="pws-form-grid pws-form-grid-2">
          <LifecycleField id={`${baseId}-name`} label={TEXT.projectName}>
            <input id={`${baseId}-name`} name="projectName" className="input" value={draft.name} onChange={(event) => update('name', event.target.value)} required autoFocus />
          </LifecycleField>
          <LifecycleField id={`${baseId}-kind`} label={TEXT.projectKind}>
            <select id={`${baseId}-kind`} name="projectKind" className="select select-block" value={draft.kind} onChange={(event) => update('kind', event.target.value as typeof draft.kind)}>
              {PROJECT_KIND_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </LifecycleField>
          <LifecycleField id={`${baseId}-owner`} label={TEXT.ownerIdOptional}>
            <input id={`${baseId}-owner`} name="projectOwnerId" className="input" value={draft.ownerId} onChange={(event) => update('ownerId', event.target.value)} />
          </LifecycleField>
          <LifecycleField id={`${baseId}-rules`} label={TEXT.rulesRefOptional}>
            <input id={`${baseId}-rules`} name="projectRulesRef" className="input" value={draft.rulesRef} onChange={(event) => update('rulesRef', event.target.value)} />
          </LifecycleField>
        </div>
        <LifecycleFormActions busy={busy} submitLabel={TEXT.saveProject} onCancel={onCancel} />
      </fieldset>
    </form>
  )
}

export function ProjectResourceForm({
  busy,
  onCancel,
  onSubmit
}: {
  busy: boolean
  onCancel: () => void
  onSubmit: (input: ProjectResourceInput) => Promise<void>
}): React.JSX.Element {
  const baseId = useId()
  const [draft, setDraft] = useState<ProjectResourceDraft>({ kind: 'directory', label: '', location: '' })
  const update = <K extends keyof ProjectResourceDraft>(field: K, value: ProjectResourceDraft[K]): void => {
    setDraft((current) => ({ ...current, [field]: value }))
  }
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    void onSubmit(resourceInputFromDraft(draft))
  }
  return (
    <form className="pws-create-form pws-lifecycle-form" aria-labelledby={`${baseId}-title`} onSubmit={submit} onKeyDown={(event) => closeOnEscape(event, onCancel)} data-project-form="resource">
      <LifecycleFormHeader id={`${baseId}-title`} title={TEXT.addResource} disabled={busy} onCancel={onCancel} />
      <fieldset className="pws-fieldset" disabled={busy}>
        <div className="pws-form-grid pws-form-grid-3">
          <LifecycleField id={`${baseId}-kind`} label={TEXT.resourceKind}>
            <select id={`${baseId}-kind`} name="resourceKind" className="select select-block" value={draft.kind} onChange={(event) => update('kind', event.target.value as ProjectResourceDraft['kind'])}>
              {PROJECT_RESOURCE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </LifecycleField>
          <LifecycleField id={`${baseId}-label`} label={TEXT.resourceLabel}>
            <input id={`${baseId}-label`} name="resourceLabel" className="input" value={draft.label} onChange={(event) => update('label', event.target.value)} autoFocus />
          </LifecycleField>
          <LifecycleField id={`${baseId}-location`} label={TEXT.resourceLocation}>
            <input id={`${baseId}-location`} name="resourceLocation" className="input" value={draft.location} onChange={(event) => update('location', event.target.value)} required />
          </LifecycleField>
        </div>
        <LifecycleFormActions busy={busy} submitLabel={TEXT.addResourceSubmit} onCancel={onCancel} />
      </fieldset>
    </form>
  )
}

export function ProjectDeleteDialog({
  busy,
  onCancel,
  onConfirm,
  permanent,
  project
}: {
  busy: boolean
  onCancel: () => void
  onConfirm: () => Promise<void>
  permanent: boolean
  project: ProjectWorkspace
}): React.JSX.Element {
  const dialogRef = useModalDialog(onCancel)
  const titleId = useId()
  const descriptionId = useId()
  const inputId = useId()
  const [confirmation, setConfirmation] = useState('')
  const confirmed = confirmation === project.name
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (confirmed && !busy) void onConfirm()
  }
  return (
    <dialog ref={dialogRef} className="pws-dialog" aria-labelledby={titleId} aria-describedby={descriptionId} aria-modal="true" data-project-delete-dialog={permanent ? 'permanent' : 'soft'}>
      <form onSubmit={submit}>
        <h2 id={titleId}>{permanent ? TEXT.purgeProjectTitle : TEXT.deleteProjectTitle}</h2>
        <p id={descriptionId}>{permanent ? TEXT.purgeProjectHint : TEXT.deleteProjectHint}</p>
        <label htmlFor={inputId}>{TEXT.confirmProjectName(project.name)}</label>
        <input id={inputId} name="projectDeleteConfirmation" className="input" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" autoFocus />
        <div className="pws-form-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>{TEXT.cancel}</button>
          <button type="submit" className="btn btn-danger" disabled={!confirmed || busy} data-project-delete-confirm>
            {permanent ? TEXT.confirmPurge : TEXT.confirmDelete}
          </button>
        </div>
      </form>
    </dialog>
  )
}

export function ProjectManifestDialog({
  manifest,
  onClose,
  onCopy,
  projectName
}: {
  manifest: ProjectWorkspaceManifest
  onClose: () => void
  onCopy: () => Promise<void>
  projectName: string
}): React.JSX.Element {
  const dialogRef = useModalDialog(onClose)
  const titleId = useId()
  const json = JSON.stringify(manifest, null, 2)
  return (
    <dialog ref={dialogRef} className="pws-dialog pws-manifest-dialog" aria-labelledby={titleId} aria-modal="true" data-project-manifest>
      <h2 id={titleId}>{TEXT.manifestTitle}</h2>
      <div className="pws-manifest-digest">
        <span>{TEXT.manifestDigest}</span>
        <output data-manifest-digest>{manifest.digest}</output>
      </div>
      <textarea className="input pws-manifest-json" aria-label={TEXT.manifestTitle} readOnly value={json} data-manifest-json />
      <div className="pws-form-actions">
        <button type="button" className="btn btn-ghost" onClick={() => void onCopy()}>{TEXT.copyManifest}</button>
        <button type="button" className="btn btn-ghost" onClick={() => downloadManifest(projectName, json)}>{TEXT.downloadManifest}</button>
        <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>{TEXT.closeManifest}</button>
      </div>
    </dialog>
  )
}

function LifecycleFormHeader({ id, title, disabled, onCancel }: { id: string; title: string; disabled: boolean; onCancel: () => void }): React.JSX.Element {
  return (
    <div className="pws-form-header">
      <h3 id={id}>{title}</h3>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={disabled} aria-label={TEXT.closeForm}>{TEXT.cancel}</button>
    </div>
  )
}

function LifecycleFormActions({ busy, submitLabel, onCancel }: { busy: boolean; submitLabel: string; onCancel: () => void }): React.JSX.Element {
  return (
    <div className="pws-form-actions">
      <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>{TEXT.cancel}</button>
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? TEXT.creating : submitLabel}</button>
    </div>
  )
}

function LifecycleField({ id, label, children }: { id: string; label: string; children: React.ReactNode }): React.JSX.Element {
  return <div className="pws-field"><label htmlFor={id}>{label}</label>{children}</div>
}

function useModalDialog(onCancel: () => void) {
  const dialogRef = useRef<HTMLDialogElement>(null!)
  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [])
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const cancel = (event: Event): void => {
      event.preventDefault()
      onCancel()
    }
    dialog.addEventListener('cancel', cancel)
    return () => dialog.removeEventListener('cancel', cancel)
  }, [onCancel])
  return dialogRef
}

function closeOnEscape(event: KeyboardEvent<HTMLFormElement>, onCancel: () => void): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  onCancel()
}

function downloadManifest(projectName: string, json: string): void {
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${projectName.replace(/[^a-z0-9_-]+/gi, '-') || 'project'}-manifest.json`
  link.click()
  URL.revokeObjectURL(url)
}
