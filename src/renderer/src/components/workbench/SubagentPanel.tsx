import { useMemo, useState } from 'react'
import { formatCost, formatTime } from '../../format'
import TaskDagGraph from '../TaskDagGraph'
import type {
  SessionMeta,
  SessionStatus,
  SubagentDispatchResult,
  SubagentResult,
  TaskDagDispatchResult,
  TaskDagExecutionView
} from '../../../../shared/types'
import { MAX_DIRECT_SUBAGENT_TASKS } from '../../../../shared/agent-capacity-policy'

interface SubagentPanelProps {
  childSessions?: SessionMeta[]
  busy?: boolean
  error?: string
  message?: string
  lastResult?: SubagentDispatchResult
  dagExecution?: TaskDagExecutionView
  childResults?: Record<string, SubagentResult>
  onClose?: () => void
  onSelectChild?: (sessionId: string) => void
  onDispatch: (tasksText: string) => Promise<SubagentDispatchResult | undefined>
  onDecomposeAndDispatch: (
    request: string,
    options?: { autoMerge?: boolean; verificationCommand?: string }
  ) => Promise<TaskDagDispatchResult | undefined>
}

const EXAMPLE_TASKS = [
  'builder: 实现功能与交互',
  'reviewer: 补测试并复核实现'
].join('\n')

const DAG_EXAMPLE_REQUEST = '实现完整登录功能，含前端表单、后端认证接口、会话状态和全流程测试'

function parseCount(text: string): number {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_DIRECT_SUBAGENT_TASKS + 1).length
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
  childResults = {},
  dagExecution,
  lastResult,
  message,
  onClose,
  onSelectChild,
  onDispatch,
  onDecomposeAndDispatch
}: SubagentPanelProps): React.JSX.Element {
  const [tasksText, setTasksText] = useState(EXAMPLE_TASKS)
  const [requestText, setRequestText] = useState(DAG_EXAMPLE_REQUEST)
  const [autoMerge, setAutoMerge] = useState(false)
  const [verificationCommand, setVerificationCommand] = useState('npm.cmd run test:dag')
  const taskCount = useMemo(() => parseCount(tasksText), [tasksText])
  const invalid = taskCount === 0 || taskCount > MAX_DIRECT_SUBAGENT_TASKS
  const requestInvalid = requestText.trim().length === 0

  return (
    <section className="subagent-panel">
      <header className="subagent-panel-header">
        <div>
          <h2 className="subagent-panel-title">子代理编排</h2>
          <div className="subagent-panel-subtitle">真实 child sessions · 每个任务独立 worktree</div>
        </div>
        <div className="subagent-panel-actions">
          <span className="subagent-panel-count">{taskCount}/{MAX_DIRECT_SUBAGENT_TASKS}</span>
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
        <section className="subagent-panel-result">
          <div className="subagent-panel-result-head">
            <span>DAG 自动拆解</span>
            <b>可选</b>
          </div>
          <div className="subagent-dag-form">
            <textarea
              className="subagent-panel-textarea subagent-dag-textarea"
              value={requestText}
              spellCheck={false}
              onChange={(event) => setRequestText(event.target.value)}
            />
            <div className="subagent-dag-options">
              <label className="subagent-dag-toggle">
                <input
                  type="checkbox"
                  checked={autoMerge}
                  disabled={busy}
                  onChange={(event) => setAutoMerge(event.currentTarget.checked)}
                />
                <span>DAG 完成后自动合并</span>
              </label>
              <input
                className="subagent-dag-command"
                value={verificationCommand}
                disabled={busy || !autoMerge}
                spellCheck={false}
                placeholder="验收命令，例如 npm.cmd run test:dag"
                onChange={(event) => setVerificationCommand(event.target.value)}
              />
            </div>
            <button
              className="btn btn-primary subagent-panel-dispatch"
              disabled={busy || requestInvalid}
              onClick={() =>
                void onDecomposeAndDispatch(requestText, {
                  autoMerge,
                  verificationCommand
                })
              }
            >
              {busy ? '调度中...' : '拆解为 DAG 并调度'}
            </button>
          </div>
          <TaskDagGraph execution={dagExecution} onSelectSession={onSelectChild} />
        </section>

        <label className="subagent-panel-label" htmlFor="subagent-tasks">
          每行一个任务,可写成 role: prompt
        </label>
        <div className="subagent-panel-templates">
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setTasksText(EXAMPLE_TASKS)}>
            双 Agent 模板
          </button>
        </div>
        <textarea
          id="subagent-tasks"
          className="subagent-panel-textarea"
          value={tasksText}
          spellCheck={false}
          onChange={(event) => setTasksText(event.target.value)}
        />
        {taskCount > MAX_DIRECT_SUBAGENT_TASKS && (
          <div className="subagent-panel-warning">直接派发最多 {MAX_DIRECT_SUBAGENT_TASKS} 个子 Agent；更多任务请使用 DAG 排队。</div>
        )}
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
            <span>编排结果</span>
            <b>{Object.keys(childResults).length} 个</b>
          </div>
          {Object.keys(childResults).length === 0 ? (
            <div className="subagent-panel-empty">子 Agent 完成后会在这里汇总结果。</div>
          ) : (
            <div className="subagent-panel-child-list">
              {Object.entries(childResults).map(([key, result]) => (
                <button
                  key={key}
                  className="subagent-panel-child subagent-panel-child-button"
                  onClick={() => onSelectChild?.(result.childSessionId)}
                >
                  <span className={`subagent-panel-live-status status-${result.status === 'error' ? 'error' : 'idle'}`}>
                    {result.status === 'error' ? '错误' : '完成'}
                  </span>
                  <span className="subagent-panel-child-title">
                    {result.childRole || result.childTaskId || result.childSessionId.slice(0, 8)}
                  </span>
                  <span className="subagent-panel-child-path" title={result.resultText || ''}>
                    {result.resultText || '无摘要'}
                  </span>
                  <span className="subagent-panel-child-meta">
                    {formatCost(result.costUsd ?? 0)}
                    {result.durationMs !== undefined ? ` · ${Math.round(result.durationMs / 1000)}s` : ''}
                  </span>
                </button>
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
