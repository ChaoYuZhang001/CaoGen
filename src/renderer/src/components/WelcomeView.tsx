import { useMemo, useRef, useState } from 'react'
import { MODEL_OPTIONS, PERMISSION_OPTIONS, useStore } from '../store'
import { useT } from '../i18n'
import type { PermissionModeId } from '../../../shared/types'

/**
 * 首屏"打开即输入"(对标 Codex Desktop):居中引导语 + 中央大输入框,
 * 内嵌项目选择 / Provider / 模型 / 权限,回车直接建会话并发送首条消息。
 */
export default function WelcomeView(): React.JSX.Element {
  const t = useT()
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const projects = useStore((s) => s.projects)
  const startSessionWithPrompt = useStore((s) => s.startSessionWithPrompt)

  const [text, setText] = useState('')
  const [cwd, setCwd] = useState('')
  const [providerId, setProviderId] = useState(settings.defaultProviderId)
  const [model, setModel] = useState(settings.defaultModel)
  const [permissionMode, setPermissionMode] = useState<PermissionModeId>(settings.defaultPermissionMode)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  const modelOptions = useMemo(() => {
    const p = providers.find((x) => x.id === providerId)
    if (p && p.models.length > 0) {
      return [{ value: '', label: t('defaultModel') }, ...p.models.map((m) => ({ value: m, label: m }))]
    }
    return MODEL_OPTIONS
  }, [providers, providerId, t])

  const browse = async (): Promise<void> => {
    const dir = await window.agentDesk.pickDirectory()
    if (dir) {
      setCwd(dir)
      setError('')
    }
  }

  const submit = async (): Promise<void> => {
    const prompt = text.trim()
    if (!prompt || busy) return
    if (!cwd.trim()) {
      setError(t('welcomeNeedProject'))
      return
    }
    setBusy(true)
    setError('')
    try {
      await startSessionWithPrompt({ cwd: cwd.trim(), model, providerId, permissionMode }, prompt)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  const projectName = cwd ? cwd.split('/').filter(Boolean).pop() : ''

  return (
    <div className="welcome welcome-hero">
      <div className="welcome-hero-inner">
        <div className="welcome-mark">◆</div>
        <h1 className="welcome-ask">{t('welcomeAsk')}</h1>

        <div className="welcome-composer">
          <textarea
            ref={taRef}
            className="welcome-composer-input"
            placeholder={t('welcomeInputPlaceholder')}
            value={text}
            rows={2}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            autoFocus
          />
          <div className="welcome-composer-bar">
            <button className="welcome-chip" onClick={() => void browse()} title={cwd}>
              📁 {projectName || t('welcomePickProject')}
            </button>
            {providers.length > 0 && (
              <select
                className="welcome-mini-select"
                value={providerId}
                onChange={(e) => {
                  setProviderId(e.target.value)
                  setModel('')
                }}
              >
                <option value="">官方</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            <select className="welcome-mini-select" value={model} onChange={(e) => setModel(e.target.value)}>
              {modelOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <select
              className="welcome-mini-select"
              value={permissionMode}
              onChange={(e) => setPermissionMode(e.target.value as PermissionModeId)}
            >
              {PERMISSION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <button className="welcome-send" disabled={busy || !text.trim()} onClick={() => void submit()}>
              {busy ? '···' : '↑'}
            </button>
          </div>
        </div>

        {projects.length > 0 && !cwd && (
          <div className="welcome-recent">
            {projects.slice(0, 5).map((p) => (
              <button key={p.id} className="welcome-recent-chip" title={p.path} onClick={() => setCwd(p.path)}>
                {p.name}
              </button>
            ))}
          </div>
        )}

        {error && <div className="notice notice-error welcome-error">{error}</div>}
      </div>
    </div>
  )
}
