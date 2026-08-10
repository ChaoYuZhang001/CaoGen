import { useT } from '../../i18n'
import type { LocalComputeUnavailableReason } from '../../../../shared/types'

interface AssistantStartNoticeProps {
  busy: boolean
  computeReason: LocalComputeUnavailableReason | null
  error: string
  recoveryKind: 'compute' | 'provider' | null
  onOpenSettings: () => void
  onRetry: () => void
}

export default function AssistantStartNotice({
  busy,
  computeReason,
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
  const localHelp = recoveryKind === 'compute' && computeReason === 'runtime-missing'
    ? { href: 'https://ollama.com/download', label: t('assistantInstallOllama') }
    : recoveryKind === 'compute' && computeReason === 'model-missing'
      ? { href: 'https://ollama.com/library', label: t('assistantBrowseOllamaModels') }
      : null
  return (
    <div
      className="notice notice-error welcome-error assistant-start-notice"
      role="alert"
      data-assistant-start-state={recoveryKind ? `${recoveryKind}-unavailable` : 'error'}
      data-welcome-recovery-state={recoveryKind ?? 'error'}
      data-local-compute-reason={computeReason ?? undefined}
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
          {localHelp && (
            <a
              className="btn btn-ghost btn-sm"
              data-assistant-start-action="local-help"
              href={localHelp.href}
              target="_blank"
              rel="noreferrer"
            >
              {localHelp.label}
            </a>
          )}
        </div>
      )}
    </div>
  )
}
