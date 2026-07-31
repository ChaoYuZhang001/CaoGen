import { useT } from '../../i18n'

interface AssistantStartNoticeProps {
  busy: boolean
  error: string
  recoveryKind: 'compute' | 'provider' | null
  onOpenSettings: () => void
  onRetry: () => void
}

export default function AssistantStartNotice({
  busy,
  error,
  onOpenSettings,
  onRetry,
  recoveryKind
}: AssistantStartNoticeProps): React.JSX.Element | null {
  const t = useT()
  if (!error) return null
  const recoverable = recoveryKind !== null
  const configureLabel = recoveryKind === 'provider'
    ? t('welcomeConfigureProvider')
    : t('assistantConfigureCompute')
  const retryLabel = recoveryKind === 'provider'
    ? busy ? t('welcomeRefreshingProviders') : t('welcomeRetryProviders')
    : busy ? t('assistantCheckingCompute') : t('assistantRetryCompute')
  return (
    <div
      className="notice notice-error welcome-error assistant-start-notice"
      role="alert"
      data-assistant-start-state={recoveryKind ? `${recoveryKind}-unavailable` : 'error'}
      data-welcome-recovery-state={recoveryKind ?? 'error'}
    >
      <span>{error}</span>
      {recoverable && (
        <div className="assistant-start-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-assistant-start-action="configure"
            data-welcome-recovery-action="configure"
            onClick={onOpenSettings}
          >
            {configureLabel}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-assistant-start-action="retry"
            data-welcome-recovery-action="retry"
            disabled={busy}
            onClick={onRetry}
          >
            {retryLabel}
          </button>
        </div>
      )}
    </div>
  )
}
