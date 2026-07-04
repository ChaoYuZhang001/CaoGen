import { useState } from 'react'
import { PERMISSION_OPTIONS, useStore } from '../store'
import { useT } from '../i18n'
import type { CreateRoutineInput, Routine, RoutinePermissionMode } from '../../../shared/types'

interface Props {
  /** null / undefined = 新建;否则编辑该 Routine */
  routine?: Routine | null
  onClose: () => void
}

/** cron 速查:主控接入真实执行器前仅作输入提示,不做严格校验 */
const CRON_EXAMPLES: Array<{ expr: string; desc: string }> = [
  { expr: '0 9 * * *', desc: '每天 09:00' },
  { expr: '*/30 * * * *', desc: '每 30 分钟' },
  { expr: '0 */2 * * *', desc: '每 2 小时' },
  { expr: '0 9 * * 1-5', desc: '工作日 09:00' },
  { expr: '0 0 1 * *', desc: '每月 1 号 00:00' }
]

export default function RoutineEditor({ routine = null, onClose }: Props): React.JSX.Element {
  const t = useT()
  const providers = useStore((s) => s.providers)

  const isEdit = routine !== null

  const [name, setName] = useState(routine?.name ?? '')
  const [prompt, setPrompt] = useState(routine?.prompt ?? '')
  const [projectCwd, setProjectCwd] = useState(routine?.projectCwd ?? '')
  const [schedule, setSchedule] = useState(routine?.schedule ?? '')
  const [providerId, setProviderId] = useState(routine?.providerId ?? '')
  const [model, setModel] = useState(routine?.model ?? '')
  const [permissionMode, setPermissionMode] = useState<RoutinePermissionMode>(
    routine?.permissionMode ?? 'default'
  )
  const [enabled, setEnabled] = useState(routine?.enabled ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const browse = async (): Promise<void> => {
    const dir = await window.agentDesk.pickDirectory()
    if (dir) setProjectCwd(dir)
  }

  const applyCron = (expr: string): void => {
    if (expr) setSchedule(expr)
  }

  const save = async (): Promise<void> => {
    if (!name.trim()) {
      setError(t('errNameRequired'))
      return
    }
    if (!prompt.trim()) {
      setError(t('routineErrPromptRequired'))
      return
    }
    if (!projectCwd.trim()) {
      setError(t('routineErrCwdRequired'))
      return
    }
    if (!schedule.trim()) {
      setError(t('routineErrScheduleRequired'))
      return
    }

    setBusy(true)
    setError('')
    try {
      if (isEdit && routine) {
        await window.agentDesk.updateRoutine(routine.id, {
          name: name.trim(),
          prompt: prompt.trim(),
          projectCwd: projectCwd.trim(),
          schedule: schedule.trim(),
          providerId: providerId.trim(),
          model: model.trim(),
          permissionMode,
          enabled
        })
      } else {
        const input: CreateRoutineInput = {
          name: name.trim(),
          prompt: prompt.trim(),
          projectCwd: projectCwd.trim(),
          schedule: schedule.trim(),
          providerId: providerId.trim(),
          model: model.trim(),
          permissionMode,
          enabled
        }
        await window.agentDesk.createRoutine(input)
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop modal-backdrop-nested" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">
          {isEdit ? t('routineEditTitle') : t('routineAddTitle')}
        </h2>

        <label className="field-label">{t('nameLabel')}</label>
        <input
          className="input input-block"
          value={name}
          placeholder={t('routineNamePlaceholder')}
          onChange={(e) => setName(e.target.value)}
        />

        <label className="field-label">{t('routinePromptLabel')}</label>
        <textarea
          className="input input-block textarea"
          value={prompt}
          rows={4}
          placeholder={t('routinePromptPlaceholder')}
          onChange={(e) => setPrompt(e.target.value)}
        />

        <label className="field-label">{t('routineProjectLabel')}</label>
        <div className="field-row">
          <input
            className="input input-block"
            value={projectCwd}
            placeholder="/path/to/project"
            onChange={(e) => setProjectCwd(e.target.value)}
          />
          <button className="btn btn-ghost" onClick={() => void browse()}>
            {t('browse')}
          </button>
        </div>

        <div className="field-label-row">
          <label className="field-label">{t('routineScheduleLabel')}</label>
          <select
            className="select"
            defaultValue=""
            onChange={(e) => applyCron(e.target.value)}
          >
            <option value="" disabled>
              {t('routineCronPick')}
            </option>
            {CRON_EXAMPLES.map((c) => (
              <option key={c.expr} value={c.expr}>
                {c.expr} — {c.desc}
              </option>
            ))}
          </select>
        </div>
        <input
          className="input input-block"
          value={schedule}
          placeholder="0 9 * * *"
          onChange={(e) => setSchedule(e.target.value)}
        />
        <p className="field-hint">{t('routineCronHint')}</p>

        <label className="field-label">{t('providerLabel')}</label>
        <select
          className="select select-block"
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
        >
          <option value="">{t('officialAnthropicDefault')}</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.hasToken ? '' : ` (${t('noKeyConfigured')})`}
            </option>
          ))}
        </select>

        <label className="field-label">{t('model')}</label>
        <input
          className="input input-block"
          value={model}
          placeholder={t('defaultModel')}
          onChange={(e) => setModel(e.target.value)}
        />

        <label className="field-label">{t('permissionMode')}</label>
        <select
          className="select select-block"
          value={permissionMode}
          onChange={(e) => setPermissionMode(e.target.value as RoutinePermissionMode)}
        >
          {PERMISSION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <label className="settings-check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          {t('routineEnabledLabel')}
        </label>

        {error && <div className="notice notice-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? t('saving') : t('save')}
          </button>
        </div>
      </div>
    </div>
  )
}
