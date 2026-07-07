import type {
  TaskDagExecutionTask,
  TaskDagExecutionView,
  TaskDagTaskStatus
} from '../../../shared/types'

interface TaskDagGraphProps {
  execution?: TaskDagExecutionView
  onSelectSession?: (sessionId: string) => void
}

function statusLabel(status: TaskDagTaskStatus): string {
  switch (status) {
    case 'waiting':
      return '等待'
    case 'running':
      return '运行'
    case 'success':
      return '成功'
    case 'failed':
      return '失败'
    default:
      return status
  }
}

function latestSessionId(task: TaskDagExecutionTask): string | undefined {
  return task.sessionIds[task.sessionIds.length - 1]
}

function duration(task: TaskDagExecutionTask): string {
  if (!task.startedAt) return ''
  const end = task.completedAt ?? Date.now()
  return `${Math.max(1, Math.round((end - task.startedAt) / 1000))}s`
}

export default function TaskDagGraph({
  execution,
  onSelectSession
}: TaskDagGraphProps): React.JSX.Element {
  if (!execution) {
    return (
      <section className="task-dag-graph task-dag-graph-empty">
        <div className="task-dag-empty-title">暂无 DAG 调度</div>
        <div className="task-dag-empty-copy">输入复杂需求后可自动拆解为依赖任务图。</div>
      </section>
    )
  }

  const tasks = new Map(execution.tasks.map((task) => [task.task.id, task]))

  return (
    <section className="task-dag-graph" aria-label="DAG 任务图">
      <header className="task-dag-header">
        <div>
          <div className="task-dag-title">{execution.dag.title}</div>
          <div className="task-dag-subtitle">
            {execution.tasks.length} 任务 · 重试上限 {execution.maxRetries} · {execution.status}
          </div>
        </div>
        <span className={`task-dag-status status-${execution.status}`}>
          {execution.status === 'failed' ? '有失败' : execution.status === 'success' ? '完成' : '调度中'}
        </span>
      </header>

      <div className="task-dag-layers">
        {execution.layers.map((layer, index) => (
          <div key={`${index}:${layer.join('|')}`} className="task-dag-layer">
            <div className="task-dag-layer-label">L{index + 1}</div>
            <div className="task-dag-layer-nodes">
              {layer.map((taskId) => {
                const item = tasks.get(taskId)
                if (!item) return null
                const sessionId = latestSessionId(item)
                const NodeTag = sessionId && onSelectSession ? 'button' : 'div'
                return (
                  <NodeTag
                    key={taskId}
                    className={`task-dag-node task-dag-node-${item.status}`}
                    onClick={sessionId && onSelectSession ? () => onSelectSession(sessionId) : undefined}
                  >
                    <span className="task-dag-node-status">{statusLabel(item.status)}</span>
                    <span className="task-dag-node-title">{item.task.title}</span>
                    <span className="task-dag-node-meta">
                      {item.task.role} · 尝试 {item.attempts}
                      {duration(item) ? ` · ${duration(item)}` : ''}
                    </span>
                    {item.task.dependencies.length > 0 && (
                      <span className="task-dag-node-deps">依赖 {item.task.dependencies.join(', ')}</span>
                    )}
                    {(item.error || item.resultText) && (
                      <span className="task-dag-node-note" title={item.error || item.resultText}>
                        {item.error || item.resultText}
                      </span>
                    )}
                  </NodeTag>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      {execution.autoMerge && (
        <section className={`task-dag-node task-dag-auto-merge task-dag-node-${execution.autoMerge.status}`}>
          <span className="task-dag-node-status">自动合并</span>
          <span className="task-dag-node-title">{execution.autoMerge.summary ?? execution.autoMerge.status}</span>
          <span className="task-dag-node-meta">
            已合并 {execution.autoMerge.mergedCount} · 阻塞 {execution.autoMerge.blockedCount} · 跳过{' '}
            {execution.autoMerge.skippedCount}
          </span>
          {execution.autoMerge.verification && (
            <span
              className="task-dag-node-note"
              title={execution.autoMerge.verification.output || execution.autoMerge.error}
            >
              验收 {execution.autoMerge.verification.status}
              {execution.autoMerge.verification.command ? ` · ${execution.autoMerge.verification.command}` : ''}
            </span>
          )}
        </section>
      )}
    </section>
  )
}
