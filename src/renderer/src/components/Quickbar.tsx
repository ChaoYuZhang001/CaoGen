import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import type { QuickbarTargetMode, QuickbarWindowContext } from '../../../shared/types'

function filePath(file: File): string | undefined {
  return (file as File & { path?: string }).path
}

function splitPathDraft(draft: string): string[] {
  return draft
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function windowLabel(item: QuickbarWindowContext): string {
  const name = item.title || item.name
  const owner = item.processName ? ` · ${item.processName}` : ''
  return `${item.kind === 'screen' ? '屏幕' : '窗口'} · ${name}${owner}`
}

export default function Quickbar(): React.JSX.Element | null {
  const activeId = useStore((s) => s.activeId)
  const activeCwd = useStore((s) => (s.activeId ? s.sessions[s.activeId]?.meta.cwd : undefined))
  const projects = useStore((s) => s.projects)
  const sendClipboard = useStore((s) => s.sendQuickbarClipboard)
  const sendScreenshot = useStore((s) => s.sendQuickbarScreenshot)
  const sendFiles = useStore((s) => s.sendQuickbarFiles)

  const fallbackCwd = activeCwd || projects[0]?.path || ''
  const [visible, setVisible] = useState(false)
  const [target, setTarget] = useState<QuickbarTargetMode>(activeId ? 'current' : 'new')
  const [cwd, setCwd] = useState(fallbackCwd)
  const [sourceId, setSourceId] = useState('')
  const [windows, setWindows] = useState<QuickbarWindowContext[]>([])
  const [pathDraft, setPathDraft] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const currentCwd = useMemo(() => cwd.trim() || fallbackCwd, [cwd, fallbackCwd])

  useEffect(() => {
    if (fallbackCwd && !cwd.trim()) setCwd(fallbackCwd)
  }, [cwd, fallbackCwd])

  useEffect(() => {
    if (!activeId && target === 'current') setTarget('new')
  }, [activeId, target])

  useEffect(() => {
    let disposed = false
    void window.agentDesk.quickbarGetState().then((state) => {
      if (!disposed) setVisible(state.visible)
    })
    const off = window.agentDesk.onQuickbarEvent((event) => {
      if (event.kind === 'visibility') setVisible(event.visible)
    })
    return () => {
      disposed = true
      off()
    }
  }, [])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    void window.agentDesk.quickbarGetWindowContext(currentCwd || undefined).then((result) => {
      if (cancelled) return
      setWindows(result.windows)
      if (sourceId && !result.windows.some((item) => item.id === sourceId)) setSourceId('')
    })
    return () => {
      cancelled = true
    }
  }, [currentCwd, sourceId, visible])

  useEffect(() => {
    if (!visible) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      void window.agentDesk.quickbarSetVisible(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [visible])

  const run = async (
    key: string,
    action: () => Promise<{ ok: boolean; sessionId?: string; error?: string } | undefined>
  ): Promise<void> => {
    setBusy(key)
    setError('')
    setMessage('')
    try {
      const result = await action()
      if (!result?.ok) {
        setError(result?.error || 'Quickbar 投递失败')
        return
      }
      setMessage(`已投递到 ${result.sessionId?.slice(0, 8) ?? '会话'}`)
      setPathDraft('')
      setNote('')
      await window.agentDesk.quickbarSetVisible(false)
    } finally {
      setBusy(null)
    }
  }

  const options = {
    target,
    cwd: currentCwd || undefined,
    sourceId: sourceId || undefined,
    note: note.trim() || undefined
  }

  const pickFiles = async (): Promise<void> => {
    const picked = await window.agentDesk.quickbarPickFiles()
    if (picked.length === 0) return
    setPathDraft(picked.join('\n'))
  }

  const sendPathDraft = async (): Promise<void> => {
    const paths = splitPathDraft(pathDraft)
    await run('files', () => sendFiles({ ...options, paths }))
  }

  if (!visible) return null

  return (
    <div className="quickbar-backdrop" onMouseDown={() => void window.agentDesk.quickbarSetVisible(false)}>
      <div className="quickbar" onMouseDown={(event) => event.stopPropagation()}>
        <div className="quickbar-head">
          <div className="quickbar-title">Quickbar</div>
          <button
            type="button"
            className="quickbar-close"
            aria-label="关闭 Quickbar"
            onClick={() => void window.agentDesk.quickbarSetVisible(false)}
          >
            ×
          </button>
        </div>

        <div className="quickbar-row quickbar-targets">
          <button
            type="button"
            className={`quickbar-segment ${target === 'current' ? 'active' : ''}`}
            disabled={!activeId}
            onClick={() => setTarget('current')}
          >
            当前会话
          </button>
          <button
            type="button"
            className={`quickbar-segment ${target === 'new' ? 'active' : ''}`}
            onClick={() => setTarget('new')}
          >
            新会话
          </button>
        </div>

        {(target === 'new' || !activeId) && (
          <input
            className="quickbar-input"
            value={cwd}
            placeholder="/path/to/project"
            onChange={(event) => setCwd(event.target.value)}
          />
        )}

        <select className="quickbar-input" value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
          <option value="">默认截图源</option>
          {windows.map((item) => (
            <option key={item.id} value={item.id}>
              {windowLabel(item)}
            </option>
          ))}
        </select>

        <textarea
          className="quickbar-input quickbar-note"
          value={note}
          rows={2}
          placeholder="备注"
          onChange={(event) => setNote(event.target.value)}
        />

        <textarea
          className="quickbar-input quickbar-paths"
          value={pathDraft}
          rows={3}
          placeholder="文件或目录路径"
          onChange={(event) => setPathDraft(event.target.value)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault()
            const paths = [...event.dataTransfer.files].map(filePath).filter((path): path is string => Boolean(path))
            if (paths.length > 0) setPathDraft(paths.join('\n'))
          }}
        />

        {error && <div className="quickbar-status quickbar-error">{error}</div>}
        {message && <div className="quickbar-status">{message}</div>}

        <div className="quickbar-actions">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy !== null}
            onClick={() => void run('clipboard', () => sendClipboard(options))}
          >
            {busy === 'clipboard' ? '投递中' : '剪贴板'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy !== null}
            onClick={() => void run('screenshot', () => sendScreenshot(options))}
          >
            {busy === 'screenshot' ? '截图中' : '截图'}
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => void pickFiles()}>
            选文件
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy !== null || splitPathDraft(pathDraft).length === 0}
            onClick={() => void sendPathDraft()}
          >
            {busy === 'files' ? '投递中' : '投递文件'}
          </button>
        </div>
      </div>
    </div>
  )
}
