import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import type { ProjectContextReadResult } from '../../../shared/types'

export default function ProjectSettings(): React.JSX.Element {
  const activeSession = useStore((s) => (s.activeId ? s.sessions[s.activeId] : undefined))
  const projects = useStore((s) => s.projects)
  const defaultPath = useMemo(
    () => activeSession?.meta.sourceCwd ?? activeSession?.meta.cwd ?? projects[0]?.path ?? '',
    [activeSession, projects]
  )
  const [projectPath, setProjectPath] = useState(defaultPath)
  const [context, setContext] = useState<ProjectContextReadResult | null>(null)
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!defaultPath) return
    setProjectPath(defaultPath)
    void load(defaultPath)
  }, [defaultPath])

  const load = async (path: string): Promise<void> => {
    if (!path.trim()) return
    setBusy(true)
    setMessage('')
    try {
      const result = await window.agentDesk.readProjectContext(path.trim())
      setContext(result)
      setContent(result.content)
      setProjectPath(result.projectRoot)
      setMessage(result.source ? `已加载 ${result.source.fileName}` : '未找到 caogen.md,可生成模板后保存')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const applyTemplate = async (): Promise<void> => {
    if (!projectPath.trim()) return
    setBusy(true)
    setMessage('')
    try {
      const template = context?.template ?? (await window.agentDesk.generateProjectContextTemplate(projectPath.trim()))
      setContent(template)
      setMessage('模板已生成')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!projectPath.trim()) return
    setBusy(true)
    setMessage('')
    try {
      const result = await window.agentDesk.writeProjectContext(projectPath.trim(), content)
      setContext(result)
      setProjectPath(result.projectRoot)
      setContent(result.content)
      setMessage('已保存 caogen.md,下一轮 Agent 消息生效')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const stack = context?.detected.techStack ?? []
  const projectRootLabel = context?.projectRoot ?? (projectPath ? projectPath : '-')

  return (
    <div className="project-settings">
      <div className="settings-section-head">
        <h3 className="settings-h3">项目上下文</h3>
        <button className="btn btn-ghost btn-sm" disabled={busy || !projectPath.trim()} onClick={() => void load(projectPath)}>
          {busy ? '处理中...' : '重新加载'}
        </button>
      </div>

      <label className="field-label">项目目录</label>
      <div className="field-row">
        <input
          className="input"
          value={projectPath}
          placeholder="/path/to/project"
          onChange={(e) => setProjectPath(e.target.value)}
        />
        {projects.length > 0 && (
          <select
            className="select project-settings-select"
            value={projects.find((item) => item.path === projectPath)?.id ?? ''}
            onChange={(e) => {
              const selected = projects.find((item) => item.id === e.target.value)
              if (selected) {
                setProjectPath(selected.path)
                void load(selected.path)
              }
            }}
          >
            <option value="">最近项目</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="project-context-meta">
        <span>根目录: {projectRootLabel}</span>
        <span>来源: {context?.source ? context.source.fileName : 'caogen.md'}</span>
        {context?.source?.truncated && <span>已截断读取</span>}
      </div>

      {stack.length > 0 && (
        <div className="project-context-tags">
          {stack.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      )}

      <label className="field-label">caogen.md</label>
      <textarea
        className="input input-block textarea project-context-editor"
        value={content}
        spellCheck={false}
        onChange={(e) => setContent(e.target.value)}
      />

      <div className="project-context-actions">
        <button className="btn btn-ghost" disabled={busy || !projectPath.trim()} onClick={() => void applyTemplate()}>
          生成模板
        </button>
        <button className="btn btn-primary" disabled={busy || !projectPath.trim()} onClick={() => void save()}>
          保存
        </button>
      </div>

      {message && <div className="notice notice-info project-context-message">{message}</div>}
    </div>
  )
}
