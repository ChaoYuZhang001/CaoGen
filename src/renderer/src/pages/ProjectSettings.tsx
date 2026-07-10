import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import type { ProjectContextReadResult } from '../../../shared/types'
import {
  PROJECT_RULE_SECTIONS,
  emptyProjectRuleDraft,
  mergeProjectRuleDraft,
  parseProjectRuleDraft,
  type ProjectRuleDraft,
  type ProjectRuleSectionKey
} from './projectRuleDraft'

const SECTION_PLACEHOLDERS: Record<ProjectRuleSectionKey, string> = {
  prompt: '- 本项目中 Agent 的默认工作方式:\n- 回答语言 / 风格:\n- 需要长期遵守的业务边界:',
  background: '- 项目目标:\n- 主要用户 / 使用场景:\n- 当前阶段:',
  techStack: '- 技术栈:\n- 关键模块:\n- 数据 / 状态来源:',
  commands: '- install:\n- dev:',
  testCommands: '- 默认测试命令:\n- 专项 smoke:\n- 回归门禁:',
  buildCommands: '- 默认构建命令:\n- 发布前检查:',
  forbiddenPaths: '- dist/\n- node_modules/\n- 含密钥或证书的本地文件',
  isolation: '- 默认是否使用隔离 worktree:\n- 可直接修改的范围:\n- 需要用户确认的范围:',
  modelDispatch: '- 简单任务: provider/model\n- 复杂任务: provider/model\n- 审查 / 复核任务: provider/model\n- 成本 / 速度 / 质量偏好: balanced',
  memory: '- 已确认事实:\n- 重要文件 / 入口:\n- 不要重复尝试:',
  decisions: '- YYYY-MM-DD: 决策、原因、影响范围',
  acceptance: '- 验证命令:\n- 完成标准:\n- 风险说明:'
}

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
  const [draft, setDraft] = useState<ProjectRuleDraft>(() => emptyProjectRuleDraft())
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
      setDraft(parseProjectRuleDraft(result.content || result.template))
      setProjectPath(result.projectRoot)
      setMessage(result.source ? `已加载 ${result.source.fileName}` : '未找到 caogen.md,可生成项目规则模板后保存')
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
      setDraft(parseProjectRuleDraft(template))
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

  const updateDraft = (key: ProjectRuleSectionKey, value: string): void => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const syncDraftFromContent = (): void => {
    setDraft(parseProjectRuleDraft(content || context?.template || ''))
    setMessage('已从正文解析到结构化规则')
  }

  const syncDraftToContent = (): string => {
    const merged = mergeProjectRuleDraft(content || context?.template || '', draft)
    setContent(merged)
    setMessage('结构化规则已写入 caogen.md 正文')
    return merged
  }

  const saveStructured = async (): Promise<void> => {
    if (!projectPath.trim()) return
    setBusy(true)
    setMessage('')
    try {
      const merged = mergeProjectRuleDraft(content || context?.template || '', draft)
      const result = await window.agentDesk.writeProjectContext(projectPath.trim(), merged)
      setContext(result)
      setProjectPath(result.projectRoot)
      setContent(result.content)
      setDraft(parseProjectRuleDraft(result.content))
      setMessage('已同步并保存项目规则,下一轮 Agent 消息生效')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="project-settings">
      <div className="settings-section-head">
        <h3 className="settings-h3">项目规则</h3>
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

      <section className="project-rule-assistant">
        <div className="project-rule-assistant-head">
          <div>
            <h4>结构化规则助手</h4>
            <p>编辑项目提示词、命令、边界、隔离策略、调度策略和记忆摘要;内容仍写入当前项目的 caogen.md。</p>
          </div>
          <div className="project-rule-assistant-actions">
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={syncDraftFromContent}>
              从正文解析
            </button>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={syncDraftToContent}>
              写入正文
            </button>
            <button className="btn btn-primary btn-sm" disabled={busy || !projectPath.trim()} onClick={() => void saveStructured()}>
              同步并保存
            </button>
          </div>
        </div>
        <div className="project-rule-grid">
          {PROJECT_RULE_SECTIONS.map((section) => (
            <label key={section.key} className="project-rule-field">
              <span>{section.title}</span>
              <textarea
                className="input input-block textarea"
                rows={section.key === 'prompt' || section.key === 'modelDispatch' ? 5 : 4}
                value={draft[section.key]}
                placeholder={SECTION_PLACEHOLDERS[section.key]}
                onChange={(e) => updateDraft(section.key, e.target.value)}
              />
            </label>
          ))}
        </div>
      </section>

      <label className="field-label">caogen.md 项目规则</label>
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
