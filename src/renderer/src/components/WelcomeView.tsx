import { useEffect, useMemo, useRef, useState } from 'react'
import { DRIVE_MODE_OPTIONS, MODEL_OPTIONS, PERMISSION_OPTIONS, useStore } from '../store'
import { useT } from '../i18n'
import { AUTO_MODEL, caogenDrivePolicyView } from '../../../shared/types'
import type { CaoGenDriveMode, EngineInfo, EngineKind, PermissionModeId } from '../../../shared/types'

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
  const [driveMode, setDriveMode] = useState<CaoGenDriveMode>(settings.driveMode)
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [engine, setEngine] = useState<EngineKind | ''>('')
  const [engines, setEngines] = useState<EngineInfo[]>([])
  const [permissionMode, setPermissionMode] = useState<PermissionModeId>(
    caogenDrivePolicyView(settings.driveMode).defaultPermissionMode
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    void window.agentDesk.listEngines().then(setEngines)
  }, [])

  const requiresProvider = engine === 'claude' || engine === 'openai'

  const modelOptions = useMemo(() => {
    const p = providers.find((x) => x.id === providerId)
    if (p && p.models.length > 0) {
      return [
        { value: AUTO_MODEL, label: t('autoRoute') },
        ...p.models.map((m) => ({ value: m, label: m }))
      ]
    }
    return [{ value: AUTO_MODEL, label: t('autoRoute') }, ...MODEL_OPTIONS.filter((item) => item.value !== AUTO_MODEL)]
  }, [providers, providerId, t])

  const onDriveChange = (mode: CaoGenDriveMode): void => {
    const policy = caogenDrivePolicyView(mode)
    setDriveMode(mode)
    setModel('')
    setPermissionMode(policy.defaultPermissionMode)
  }

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
    if (!engine) {
      setError(t('explicitEngineRequired'))
      return
    }
    if (requiresProvider && !providerId) {
      setError(t('explicitProviderRequired'))
      return
    }
    if (requiresProvider && !model) {
      setError(t('explicitModelRequired'))
      return
    }
    // 未选项目目录也可发起:走"对话分组"(主进程回退到用户主目录、不隔离)
    setBusy(true)
    setError('')
    try {
      await startSessionWithPrompt({ cwd: cwd.trim(), driveMode, model, providerId, engine, permissionMode }, prompt)
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
            <button className="welcome-chip" onClick={() => void browse()} title={cwd || t('welcomePickProject')}>
              📁 {projectName || t('welcomePickProject')}
            </button>
            <select
              className="welcome-mini-select"
              value={engine}
              onChange={(e) => {
                setEngine(e.target.value as EngineKind | '')
                setProviderId('')
                setModel('')
              }}
            >
              <option value="" disabled>
                {t('selectEnginePlaceholder')}
              </option>
              {engines.map((en) => (
                <option key={en.kind} value={en.kind} disabled={!en.available}>
                  {en.label}
                </option>
              ))}
            </select>
            {requiresProvider && (
              <select
                className="welcome-mini-select"
                value={providerId}
                onChange={(e) => {
                  setProviderId(e.target.value)
                  setModel('')
                }}
              >
                <option value="" disabled>
                  {t('selectProviderPlaceholder')}
                </option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.hasToken}>
                    {p.name}
                    {p.hasToken ? '' : ` (${t('noKeyConfigured')})`}
                  </option>
                ))}
              </select>
            )}
            <select
              className="welcome-mini-select"
              value={driveMode}
              onChange={(e) => onDriveChange(e.target.value as CaoGenDriveMode)}
            >
              {DRIVE_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {requiresProvider && (
              <select className="welcome-mini-select" value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="" disabled>
                  {t('selectModelPlaceholder')}
                </option>
                {modelOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
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
