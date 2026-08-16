import { useEffect, useMemo, useState } from 'react'
import { Film, FolderKanban, LoaderCircle, Plus } from 'lucide-react'
import { useStore } from '../../store'
import { VideoStudioPanel } from './VideoStudioPanel'
import './video-studio-view.css'

export default function VideoStudioView({ active = true }: { active?: boolean }): React.JSX.Element {
  const projects = useStore((state) => state.projectWorkspaces)
  const loading = useStore((state) => state.projectWorkspacesLoading)
  const loadError = useStore((state) => state.projectWorkspacesError)
  const preferredProjectId = useStore((state) => state.preferredProjectWorkspaceId)
  const refreshProjects = useStore((state) => state.refreshProjectWorkspaces)
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
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

  const createVideoProject = async (): Promise<void> => {
    const projectName = name.trim()
    if (!projectName || creating) return
    setCreating(true)
    setError('')
    try {
      const created = await window.agentDesk.createProjectWorkspace({ name: projectName, kind: 'custom' })
      await refreshProjects()
      setSelectedProjectId(created.id)
      setName('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCreating(false)
    }
  }

  return (
    <section className="video-studio-view" data-video-studio-view aria-label="视频工作室">
      <header className="video-studio-shell-header">
        <div>
          <span className="video-studio-shell-icon"><Film size={17} aria-hidden="true" /></span>
          <span><strong>视频工作室</strong><small>剧本、分镜、素材、生成与成片</small></span>
        </div>
        {availableProjects.length > 0 && (
          <label className="video-studio-project-picker">
            <FolderKanban size={14} aria-hidden="true" />
            <span>归属项目</span>
            <select
              className="input"
              value={selectedProjectId}
              onChange={(event) => setSelectedProjectId(event.target.value)}
              aria-label="选择视频归属项目"
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
        <div className="video-studio-shell-state" role="status"><LoaderCircle className="video-studio-shell-spinner" size={20} />加载项目...</div>
      ) : selectedProjectId ? (
        <VideoStudioPanel active={active} projectId={selectedProjectId} />
      ) : (
        <div className="video-studio-shell-empty">
          <Film size={24} aria-hidden="true" />
          <h2>创建第一个视频项目</h2>
          <p>视频制作会保存素材版本、任务状态、成本和最终成片，并可关联项目工作台交付。</p>
          <form onSubmit={(event) => { event.preventDefault(); void createVideoProject() }}>
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：产品宣传片"
              aria-label="视频项目名称"
              maxLength={120}
              autoFocus
            />
            <button type="submit" className="btn btn-primary btn-sm" disabled={creating || !name.trim()}>
              {creating ? <LoaderCircle className="video-studio-shell-spinner" size={14} /> : <Plus size={14} />}
              创建视频项目
            </button>
          </form>
        </div>
      )}
    </section>
  )
}
