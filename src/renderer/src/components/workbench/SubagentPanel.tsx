import { useMemo, useState } from 'react'
import { formatCost, formatTime } from '../../format'
import type { SessionMeta, SessionStatus, SubagentDispatchResult } from '../../../../shared/types'

interface SubagentPanelProps {
  childSessions?: SessionMeta[]
  busy?: boolean
  error?: string
  message?: string
  lastResult?: SubagentDispatchResult
  onClose?: () => void
  onSelectChild?: (sessionId: string) => void
  onDispatch: (tasksText: string) => Promise<SubagentDispatchResult | undefined>
}

const EXAMPLE_TASKS = [
  'frontend: 实现前端界面与交互',
  'backend: 实现 IPC / API / 数据模型',
  'tester: 补 smoke 与集成测试'
].join('\n')

const ULTIMATE_TASKS = [
  'm12-sdk-agents: 接入 supportedAgents()/agents,让主 Agent 能按 SDK 能力派发专职子 Agent',
  'm12-taskgraph: 设计 TaskGraph 数据模型,覆盖依赖、owner、预算、验收命令、产物和状态',
  'm12-events: 建立 child session 事件回传总线,把子 Agent 进度汇总回父会话时间线',
  'm12-merge-queue: 设计子 Agent diff 汇总、冲突检测、合并队列和逐块验收流程',
  'm12-permissions: 为子 Agent 增加预算、权限模式、最大运行时和失败策略闸门',
  'm5-realistic-3d: 把写实 3D 办公区改为消费真实 child session/task/worktree 状态',
  'm5-rendering: 提升 3D 材质、光影、相机、动效和成本/卡点可读性',
  'm9-checkpoint-sdk: 研究并实现 Claude SDK 上下文级回溯或等价重建方案',
  'm9-checkpoint-index: 建立 message、checkpoint、tool diff、worktree 路径的可索引链路',
  'm9-rewind-ux: 回退前展示代码 diff、聊天范围、风险和可恢复项',
  'm9-worktree-merge: 接通合并回主工作区、PR 创建、冲突三栏和合并后 checkpoint 验收',
  'm10-diff: 实现逐 hunk/行 accept-reject,并写回当前 worktree',
  'm10-layout: 实现拖拽分屏、停靠、布局保存和面板恢复',
  'm10-terminal-bg: 把后台任务升级/绑定到内置终端,输出可回灌 Agent',
  'm10-editor: 文件编辑器接 Monaco 或等价能力,补保存前 checkpoint 与修改高亮',
  'm10-preview-pdf: PDF 页级渲染、缩略图、搜索、批注和批注发给 Agent',
  'm10-preview-sheet: 表格/CSV 预览补筛选、公式、图表识别和结构化批注',
  'm10-preview-ppt: PPT 预览补页缩略图、页批注和修复闭环',
  'm11-browser-dom: 浏览器批注补 DOM 圈选、元素路径、截图批注和移动端视口',
  'm11-browser-observe: Agent 只读观测网页,读取控制台/网络错误并复验修复结果',
  'm13-memory-ui: 项目记忆确认 UI,区分 confirmed/draft/source 并支持撤销',
  'm13-routine-local: 本地调度器、Routine Inbox、run log、artifact、diff、checkpoint 回传',
  'm13-start-suggest: 开工时主动建议排序、来源解释和一键继续长任务',
  'm14-cloud-routines: 云端 Scheduler/Runner 或 GitHub Actions 桥接,支持关机后按计划跑',
  'm14-cloud-security: 云端 Routine 加密上下文、仓库授权、Secrets 范围、预算闸门和最大运行时',
  'm15-plugin-browser: 插件浏览器 UI,展示 skills/agents/MCP,支持搜索、诊断和来源',
  'm15-plugin-governance: 插件安装/启用/禁用/权限/版本治理,不伪造未持久化的开关',
  'm15-plugin-coverage: 建立 90+ 插件能力目录、验收标准和缺口导入流程',
  'm8-input-ocr: 图片多图标注、OCR、引用快照回显和大图压缩策略',
  'm8-slash-params: 斜杠命令支持插件/Routine 参数表单、最近使用和失败诊断',
  'm6-engines: Codex CLI/Gemini CLI 原生 EngineAdapter,统一事件模型与权限请求',
  'm7-update: 自动更新、签名、公证、发布通道和失败回滚',
  'qa-migration: 设计 Codex/Claude/Gemini/Cursor/Cline/Aider 深度用户一天迁移验收脚本'
].join('\n')

function parseCount(text: string): number {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 34).length
}

function childSummary(result: SubagentDispatchResult | undefined): string {
  if (!result) return '尚未派发'
  return `${result.children.length} 个子 Agent · ${result.orchestrationId.slice(0, 8)}`
}

function statusLabel(status: SessionStatus): string {
  switch (status) {
    case 'starting':
      return '启动中'
    case 'running':
      return '运行中'
    case 'idle':
      return '空闲'
    case 'error':
      return '错误'
    case 'closed':
      return '已关闭'
    default:
      return status
  }
}

export default function SubagentPanel({
  childSessions = [],
  busy = false,
  error,
  lastResult,
  message,
  onClose,
  onSelectChild,
  onDispatch
}: SubagentPanelProps): React.JSX.Element {
  const [tasksText, setTasksText] = useState(EXAMPLE_TASKS)
  const taskCount = useMemo(() => parseCount(tasksText), [tasksText])
  const invalid = taskCount === 0 || taskCount > 33

  return (
    <section className="subagent-panel">
      <header className="subagent-panel-header">
        <div>
          <h2 className="subagent-panel-title">子代理编排</h2>
          <div className="subagent-panel-subtitle">真实 child sessions · 每个任务独立 worktree</div>
        </div>
        <div className="subagent-panel-actions">
          <span className="subagent-panel-count">{taskCount}/33</span>
          {onClose && (
            <button className="btn btn-ghost btn-sm" onClick={onClose}>
              关闭
            </button>
          )}
        </div>
      </header>

      {error && <div className="notice notice-error subagent-panel-notice">{error}</div>}
      {message && <div className="notice notice-info subagent-panel-notice">{message}</div>}

      <div className="subagent-panel-body">
        <label className="subagent-panel-label" htmlFor="subagent-tasks">
          每行一个任务,可写成 role: prompt
        </label>
        <div className="subagent-panel-templates">
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setTasksText(EXAMPLE_TASKS)}>
            三路模板
          </button>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setTasksText(ULTIMATE_TASKS)}>
            终极目标 33 路模板
          </button>
        </div>
        <textarea
          id="subagent-tasks"
          className="subagent-panel-textarea"
          value={tasksText}
          spellCheck={false}
          onChange={(event) => setTasksText(event.target.value)}
        />
        {taskCount > 33 && <div className="subagent-panel-warning">一次最多派发 33 个子 Agent。</div>}
        <button
          className="btn btn-primary subagent-panel-dispatch"
          disabled={busy || invalid}
          onClick={() => void onDispatch(tasksText)}
        >
          {busy ? '派发中...' : '派发子 Agent'}
        </button>

        <section className="subagent-panel-result">
          <div className="subagent-panel-result-head">
            <span>最近编排</span>
            <b>{childSummary(lastResult)}</b>
          </div>
          {lastResult && (
            <div className="subagent-panel-child-list">
              {lastResult.children.map((child) => (
                <div key={child.meta.id} className="subagent-panel-child">
                  <span className="subagent-panel-child-role">{child.meta.childRole || child.taskId}</span>
                  <span className="subagent-panel-child-title">{child.meta.title}</span>
                  <code className="subagent-panel-child-path">{child.meta.worktreePath || child.meta.cwd}</code>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="subagent-panel-result">
          <div className="subagent-panel-result-head">
            <span>实时子 Agent</span>
            <b>{childSessions.length} 个</b>
          </div>
          {childSessions.length === 0 ? (
            <div className="subagent-panel-empty">当前父会话还没有打开的子 Agent。</div>
          ) : (
            <div className="subagent-panel-child-list">
              {childSessions.map((child) => (
                <button
                  key={child.id}
                  className="subagent-panel-child subagent-panel-child-button"
                  onClick={() => onSelectChild?.(child.id)}
                >
                  <span className={`subagent-panel-live-status status-${child.status}`}>
                    {statusLabel(child.status)}
                  </span>
                  <span className="subagent-panel-child-title">
                    {child.childRole || child.childTaskId || 'child'} · {child.title}
                  </span>
                  <code className="subagent-panel-child-path" title={child.worktreePath || child.cwd}>
                    {child.worktreePath || child.cwd}
                  </code>
                  <span className="subagent-panel-child-meta">
                    {formatCost(child.costUsd)} · {formatTime(child.createdAt)}
                    {child.orchestrationId ? ` · ${child.orchestrationId.slice(0, 8)}` : ''}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </section>
  )
}
