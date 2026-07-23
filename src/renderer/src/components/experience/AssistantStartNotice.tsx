import { useT } from '../../i18n'

interface AssistantStartNoticeProps {
  busy: boolean
  error: string
  recoverable: boolean
  onOpenSettings: () => void
  onRetry: () => void
}

export default function AssistantStartNotice({
  busy,
  error,
  onOpenSettings,
  onRetry,
  recoverable
}: AssistantStartNoticeProps): React.JSX.Element | null {
  const t = useT()
  if (!error) return null
  return (
    <div className="notice notice-error welcome-error assistant-start-notice" role="alert" data-assistant-start-state={recoverable ? 'compute-unavailable' : 'error'}>
      <span>{error}</span>
      {recoverable && (
        <div className="assistant-start-actions">
          <button type="button" className="btn btn-primary btn-sm" data-assistant-start-action="configure" onClick={onOpenSettings}>
            {t('assistantConfigureCompute')}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" data-assistant-start-action="retry" disabled={busy} onClick={onRetry}>
            {busy ? t('assistantCheckingCompute') : t('assistantRetryCompute')}
          </button>
        </div>
      )}
    </div>
  )
}
