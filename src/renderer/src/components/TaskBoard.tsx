import type { SessionMeta, TaskDagExecutionView } from '../../../shared/types'

export interface TaskBoardProps {
  sessions: SessionMeta[]
  dagExecution?: TaskDagExecutionView
  activeId?: string | null
  onSelectSession?: (sessionId: string) => void
  onStopSession?: (sessionId: string) => void
}

function statusText(status: SessionMeta['status']): string {
  if (status === 'running') return '运行中'
  if (status === 'starting') return '启动中'
  if (status === 'idle') return '空闲'
  if (status === 'error') return '失败'
  return '已关闭'
}

export default function TaskBoard({
  activeId,
  dagExecution,
  onSelectSession,
  onStopSession,
  sessions
}: TaskBoardProps): React.JSX.Element {
  const taskBySession = new Map<string, string>()
  for (const task of dagExecution?.tasks ?? []) {
    for (const sessionId of task.sessionIds) taskBySession.set(sessionId, task.task.title)
  }

  return (
    <section className="task-board" aria-label="任务看板">
      <header className="task-board-header">
        <div className="task-board-title">任务看板</div>
        <div className="task-board-subtitle">{sessions.length} 个会话</div>
      </header>
      <div className="task-board-list" role="list">
        {sessions.map((session) => {
          const title = taskBySession.get(session.id) ?? session.title
          return (
            <article
              key={session.id}
              className={`task-board-row ${session.id === activeId ? 'task-board-row-active' : ''}`}
              role="listitem"
            >
              <button className="task-board-main" onClick={() => onSelectSession?.(session.id)}>
                <span className={`task-board-status task-board-status-${session.status}`}>{statusText(session.status)}</span>
                <span className="task-board-name">{title}</span>
                <span className="task-board-meta">{session.engine} / {session.model}</span>
              </button>
              {(session.status === 'running' || session.status === 'starting') && (
                <button className="btn btn-ghost btn-sm" onClick={() => onStopSession?.(session.id)}>
                  停止
                </button>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}
