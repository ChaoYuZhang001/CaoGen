import { useState } from 'react'
import type { AssistantBlock } from '../../../shared/types'
import type { ToolResultInfo } from '../store'
import DiffView from './DiffView'

type ToolUseBlock = Extract<AssistantBlock, { type: 'tool_use' }>

const RESULT_PREVIEW_CHARS = 4000

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function toolSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return str(input.command)
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return str(input.file_path) || str(input.notebook_path)
    case 'Glob':
    case 'Grep':
      return str(input.pattern)
    case 'WebFetch':
    case 'WebSearch':
      return str(input.url) || str(input.query)
    case 'Task':
    case 'Agent':
      return str(input.description)
    case 'TodoWrite':
      return '更新任务清单'
    default: {
      try {
        const json = JSON.stringify(input)
        return json === '{}' ? '' : json
      } catch {
        return ''
      }
    }
  }
}

function ToolIcon({ name }: { name: string }): React.JSX.Element {
  const icon =
    name === 'Bash'
      ? '❯'
      : name === 'Read' || name === 'Glob' || name === 'Grep'
        ? '🔍'
        : name === 'Edit' || name === 'MultiEdit' || name === 'Write'
          ? '✎'
          : name === 'TodoWrite'
            ? '☑'
            : name === 'Task' || name === 'Agent'
              ? '🤖'
              : name.startsWith('WebFetch') || name.startsWith('WebSearch')
                ? '🌐'
                : '⚙'
  return <span className="tool-icon">{icon}</span>
}

function TodoList({ input }: { input: Record<string, unknown> }): React.JSX.Element | null {
  const todos = Array.isArray(input.todos) ? input.todos : []
  if (todos.length === 0) return null
  return (
    <ul className="todo-list">
      {todos.map((raw, i) => {
        const t = asRecord(raw)
        const status = str(t.status)
        const mark = status === 'completed' ? '✓' : status === 'in_progress' ? '◐' : '○'
        return (
          <li key={i} className={`todo-item todo-${status || 'pending'}`}>
            <span className="todo-mark">{mark}</span>
            {str(t.content) || str(t.subject)}
          </li>
        )
      })}
    </ul>
  )
}

function ToolBody({ block }: { block: ToolUseBlock }): React.JSX.Element {
  const input = asRecord(block.input)
  switch (block.name) {
    case 'Bash':
      return <pre className="code-block">{str(input.command)}</pre>
    case 'Edit':
      return (
        <DiffView filePath={str(input.file_path)} oldText={str(input.old_string)} newText={str(input.new_string)} />
      )
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits : []
      return (
        <div>
          {edits.map((raw, i) => {
            const e = asRecord(raw)
            return (
              <DiffView
                key={i}
                filePath={i === 0 ? str(input.file_path) : undefined}
                oldText={str(e.old_string)}
                newText={str(e.new_string)}
              />
            )
          })}
        </div>
      )
    }
    case 'Write':
      return <DiffView filePath={str(input.file_path)} oldText="" newText={str(input.content)} />
    case 'TodoWrite':
      return <TodoList input={input} />
    default: {
      let json = ''
      try {
        json = JSON.stringify(input, null, 2)
      } catch {
        json = String(block.input)
      }
      return <pre className="code-block">{json}</pre>
    }
  }
}

export default function ToolCallCard({
  block,
  result,
  running
}: {
  block: ToolUseBlock
  result?: ToolResultInfo
  running: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [showFullResult, setShowFullResult] = useState(false)
  const input = asRecord(block.input)
  const summary = toolSummary(block.name, input)

  const status = result ? (result.isError ? 'error' : 'done') : running ? 'running' : 'pending'
  const statusLabel =
    status === 'running' ? '运行中' : status === 'done' ? '完成' : status === 'error' ? '失败' : '等待'

  const resultText = result?.content ?? ''
  const truncated = !showFullResult && resultText.length > RESULT_PREVIEW_CHARS
  const displayResult = truncated ? resultText.slice(0, RESULT_PREVIEW_CHARS) : resultText

  return (
    <div className={`tool-card tool-${status}`}>
      <button className="tool-header" onClick={() => setExpanded(!expanded)}>
        <ToolIcon name={block.name} />
        <span className="tool-name">{block.name}</span>
        {summary && <span className="tool-summary">{summary}</span>}
        <span className={`tool-status tool-status-${status}`}>
          {status === 'running' && <span className="spinner" />}
          {statusLabel}
        </span>
        <span className="tool-chevron">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="tool-body">
          <ToolBody block={block} />
          {result && (
            <div className={`tool-result ${result.isError ? 'tool-result-error' : ''}`}>
              <div className="tool-result-label">{result.isError ? '错误输出' : '输出'}</div>
              <pre className="code-block">{displayResult || '(无输出)'}</pre>
              {truncated && (
                <button className="btn btn-ghost btn-sm" onClick={() => setShowFullResult(true)}>
                  显示全部({resultText.length} 字符)
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
