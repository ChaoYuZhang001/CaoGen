import { useT } from '../../i18n'
import type { LocalComputeUnavailableReason } from '../../../../shared/types'

type Translate = ReturnType<typeof useT>
type RecoveryKind = 'compute' | 'provider' | 'workspace'

interface AssistantStartNoticeProps {
  busy: boolean
  computeReason: LocalComputeUnavailableReason | null
  error: string
  recoveryKind: RecoveryKind | null
  onChooseWorkspace: () => void
  onOpenSettings: () => void
  onRetry: () => void
}

function primaryRecoveryAction(
  recoveryKind: RecoveryKind | null,
  t: Translate,
  onChooseWorkspace: () => void,
  onOpenSettings: () => void
): { action: 'choose-workspace' | 'configure'; label: string; run: () => void } {
  if (recoveryKind === 'workspace') {
    return { action: 'choose-workspace', label: t('assistantChooseWorkspace'), run: onChooseWorkspace }
  }
  const label = recoveryKind === 'provider'
    ? t('welcomeConfigureProvider')
    : t('assistantConfigureCompute')
  return { action: 'configure', label, run: onOpenSettings }
}

function retryRecoveryLabel(recoveryKind: RecoveryKind | null, busy: boolean, t: Translate): string {
  if (recoveryKind === 'provider') {
    return busy ? t('welcomeRefreshingProviders') : t('welcomeRetryProviders')
  }
  return busy ? t('assistantCheckingCompute') : t('assistantRetryCompute')
}

function localComputeHelp(
  recoveryKind: RecoveryKind | null,
  computeReason: LocalComputeUnavailableReason | null,
  t: Translate
): { href: string; label: string } | null {
  if (recoveryKind !== 'compute') return null
  if (computeReason === 'runtime-missing') {
    return { href: 'https://ollama.com/download', label: t('assistantInstallOllama') }
  }
  if (computeReason === 'model-missing') {
    return { href: 'https://ollama.com/library', label: t('assistantBrowseOllamaModels') }
  }
  return null
}

export default function AssistantStartNotice({
  busy,
  computeReason,
  error,
  onChooseWorkspace,
  onOpenSettings,
  onRetry,
  recoveryKind
}: AssistantStartNoticeProps): React.JSX.Element | null {
  const t = useT()
  if (!error) return null
  const recoverable = recoveryKind !== null
  const primaryAction = primaryRecoveryAction(recoveryKind, t, onChooseWorkspace, onOpenSettings)
  const retryLabel = retryRecoveryLabel(recoveryKind, busy, t)
  const localHelp = localComputeHelp(recoveryKind, computeReason, t)
  return (
    <div
      className={`notice ${recoveryKind === 'workspace' ? 'notice-info' : 'notice-error'} welcome-error assistant-start-notice`}
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
            data-assistant-start-action={primaryAction.action}
            data-welcome-recovery-action={primaryAction.action}
            onClick={primaryAction.run}
          >
            {primaryAction.label}
          </button>
          {recoveryKind !== 'workspace' && (
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
          )}
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
