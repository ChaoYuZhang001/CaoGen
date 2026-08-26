import { useEffect, useMemo, useState } from 'react'
import { Film, FolderKanban, LoaderCircle } from 'lucide-react'
import { useStore } from '../../store'
import { videoStudioText } from '../../i18n/studioTranslations'
import { VideoStudioPanel } from './VideoStudioPanel'
import VideoQuickStart from './VideoQuickStart'
import './video-studio-view.css'

export default function VideoStudioView({ active = true }: { active?: boolean }): React.JSX.Element {
  const language = useStore((state) => state.settings.language)
  const text = videoStudioText(language)
  const projects = useStore((state) => state.projectWorkspaces)
  const loading = useStore((state) => state.projectWorkspacesLoading)
  const loadError = useStore((state) => state.projectWorkspacesError)
  const preferredProjectId = useStore((state) => state.preferredProjectWorkspaceId)
  const refreshProjects = useStore((state) => state.refreshProjectWorkspaces)
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [name, setName] = useState('')
  const [script, setScript] = useState('')
  const [creating, setCreating] = useState(false)
  const [showQuickStart, setShowQuickStart] = useState(false)
  const [selectedProductionId, setSelectedProductionId] = useState('')
  const [error, setError] = useState('')

  const availableProjects = useMemo(
    () => projects.filter((project) => project.status === 'active'),
    [projects]
  )

  useEffect(() => {
    if (!active || loaded) return
    let cancelled = false
    void refreshProjects()
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [active, loaded, refreshProjects])

  useEffect(() => {
    setSelectedProjectId((current) => {
      if (availableProjects.some((project) => project.id === current)) return current
      if (preferredProjectId && availableProjects.some((project) => project.id === preferredProjectId)) {
        return preferredProjectId
      }
      return availableProjects[0]?.id ?? ''
    })
  }, [availableProjects, preferredProjectId])

  useEffect(() => {
    return bindVideoSidebarEvents(setShowQuickStart, setSelectedProjectId, setSelectedProductionId)
  }, [])

  const createVideoProject = async (draft?: { name?: string; script?: string }): Promise<void> => {
    const productionScript = (draft?.script ?? script).trim()
    const projectName = (draft?.name ?? name).trim() || titleFromScript(productionScript, text.defaultProductionTitle)
    if (!productionScript || creating) return
    setCreating(true)
    setError('')
    try {
      const created = await window.agentDesk.createProjectWorkspace({ name: projectName, kind: 'custom' })
      await window.agentDesk.createVideoProduction({
        projectId: created.id,
        title: projectName,
        script: productionScript,
        autoStructure: true
      })
      window.dispatchEvent(new Event('caogen:video-updated'))
      await refreshProjects()
      setSelectedProjectId(created.id)
      setShowQuickStart(false)
      setName('')
      setScript('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCreating(false)
    }
  }

  return (
    <section className="video-studio-view" data-video-studio-view data-language={language} aria-label={text.studioLabel}>
      <header className="video-studio-shell-header">
        <div>
          <span className="video-studio-shell-icon"><Film size={17} aria-hidden="true" /></span>
          <span><strong>{text.studioTitle}</strong><small>{text.studioSubtitle}</small></span>
        </div>
        {availableProjects.length > 0 && (
          <label className="video-studio-project-picker">
            <FolderKanban size={14} aria-hidden="true" />
            <span>{text.projectLabel}</span>
            <select
              className="input"
              value={selectedProjectId}
              onChange={(event) => setSelectedProjectId(event.target.value)}
              aria-label={text.projectPickerLabel}
            >
              {availableProjects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
        )}
      </header>

      {(error || loadError) && <p className="video-studio-shell-error" role="alert">{error || loadError}</p>}
      {(!loaded || loading) && availableProjects.length === 0 ? (
        <div className="video-studio-shell-state" role="status"><LoaderCircle className="video-studio-shell-spinner" size={20} />{text.loadingProjects}</div>
      ) : selectedProjectId && !showQuickStart ? (
        <VideoStudioPanel active={active} projectId={selectedProjectId} productionId={selectedProductionId} />
      ) : (
        <VideoQuickStart
          name={name}
          script={script}
          creating={creating}
          onNameChange={setName}
          onScriptChange={setScript}
          onSubmit={(draft) => void createVideoProject(draft)}
        />
      )}
    </section>
  )
}

function titleFromScript(script: string, fallback: string): string {
  const firstLine = script.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''
  return firstLine.slice(0, 80) || fallback
}

function bindVideoSidebarEvents(
  setQuickStart: (value: boolean) => void,
  setProjectId: (value: string) => void,
  setProductionId: (value: string) => void
): () => void {
  const onNew = (): void => { setQuickStart(true); setProductionId('') }
  const onSelect = (event: Event): void => {
    const detail = (event as CustomEvent<{ projectId?: string; productionId?: string }>).detail
    if (!detail?.projectId) return
    setQuickStart(false)
    setProjectId(detail.projectId)
    setProductionId(detail.productionId ?? '')
  }
  window.addEventListener('caogen:video-new', onNew)
  window.addEventListener('caogen:video-select-production', onSelect)
  return () => {
    window.removeEventListener('caogen:video-new', onNew)
    window.removeEventListener('caogen:video-select-production', onSelect)
  }
}
