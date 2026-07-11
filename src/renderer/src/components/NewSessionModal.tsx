import { useEffect, useMemo, useState } from 'react'
import { DRIVE_MODE_OPTIONS, MODEL_OPTIONS, PERMISSION_OPTIONS, useStore } from '../store'
import { useT } from '../i18n'
import { AUTO_MODEL, caogenDrivePolicyView } from '../../../shared/types'
import type { CaoGenDriveMode, EngineInfo, EngineKind, PermissionModeId } from '../../../shared/types'

export default function NewSessionModal(): React.JSX.Element {
  const t = useT()
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const projects = useStore((s) => s.projects)
  const createSession = useStore((s) => s.createSession)
  const setShowNewSession = useStore((s) => s.setShowNewSession)

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

  useEffect(() => {
    void window.agentDesk.listEngines().then(setEngines)
  }, [providers])

  const requiresProvider = engine === 'claude' || engine === 'openai'

  // 选定 Provider 时,模型下拉用该 Provider 声明的模型列表。
  // 不再提供"默认模型"选项;自动调度也必须由用户显式选择。
  const modelOptions = useMemo(() => {
    const provider = providers.find((p) => p.id === providerId)
    if (provider && provider.models.length > 0) {
      return [
        { value: AUTO_MODEL, label: t('autoRoute') },
        ...provider.models.map((m) => ({ value: m, label: m }))
      ]
    }
    return [{ value: AUTO_MODEL, label: t('autoRoute') }, ...MODEL_OPTIONS.filter((item) => item.value !== AUTO_MODEL)]
  }, [providers, providerId, t])

  const onProviderChange = (id: string): void => {
    setProviderId(id)
    // 切换 Provider 后旧的具体模型可能不在新列表里,重置为默认;但保留"自动"意图
    if (model !== AUTO_MODEL) setModel('')
  }

  const onDriveChange = (mode: CaoGenDriveMode): void => {
    const policy = caogenDrivePolicyView(mode)
    setDriveMode(mode)
    setModel('')
    setPermissionMode(policy.defaultPermissionMode)
  }

  const browse = async (): Promise<void> => {
    const dir = await window.agentDesk.pickDirectory()
    if (dir) setCwd(dir)
  }

  const create = async (): Promise<void> => {
    if (!cwd.trim()) {
      setError(t('errNeedProjectDir'))
      return
    }
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
    setBusy(true)
    setError('')
    try {
      await createSession({ cwd: cwd.trim(), driveMode, model, providerId, engine, permissionMode })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => setShowNewSession(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{t('newSessionTitle')}</h2>

        {projects.length > 0 && (
          <>
            <label className="field-label">{t('recentProjects')}</label>
            <div className="project-chips">
              {projects.slice(0, 8).map((p) => (
                <button
                  key={p.id}
                  className={`project-chip ${cwd === p.path ? 'active' : ''}`}
                  title={p.path}
                  onClick={() => setCwd(p.path)}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </>
        )}

        <label className="field-label">{t('driveMode')}</label>
        <select
          className="select select-block"
          value={driveMode}
          onChange={(e) => onDriveChange(e.target.value as CaoGenDriveMode)}
        >
          {DRIVE_MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <label className="field-label">{t('projectDir')}</label>
        <div className="field-row">
          <input
            className="input"
            value={cwd}
            placeholder="/path/to/project"
            onChange={(e) => setCwd(e.target.value)}
          />
          <button className="btn btn-ghost" onClick={() => void browse()}>
            {t('browse')}
          </button>
        </div>

        <label className="field-label">{t('engineLabel')}</label>
        <select
          className="select select-block"
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
            <option key={en.kind} value={en.kind} disabled={!en.available || (en.optional && !en.configured)}>
              {en.label}
              {en.optional ? ` (${t(en.configured ? 'optionalEngine' : 'optionalEngineNotConfigured')})` : ''}
            </option>
          ))}
        </select>

        {requiresProvider && (
          <>
            <label className="field-label">{t('providerLabel')}</label>
            <select
              className="select select-block"
              value={providerId}
              onChange={(e) => onProviderChange(e.target.value)}
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
          </>
        )}

        {requiresProvider && (
          <>
            <label className="field-label">{t('model')}</label>
            <select className="select select-block" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="" disabled>
                {t('selectModelPlaceholder')}
              </option>
              {modelOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </>
        )}

        <label className="field-label">{t('permissionMode')}</label>
        <select
          className="select select-block"
          value={permissionMode}
          onChange={(e) => setPermissionMode(e.target.value as PermissionModeId)}
        >
          {PERMISSION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        {error && <div className="notice notice-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={() => setShowNewSession(false)}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void create()}>
            {busy ? t('creating') : t('create')}
          </button>
        </div>
      </div>
    </div>
  )
}
