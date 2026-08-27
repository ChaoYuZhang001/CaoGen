import type {
  CaoGenDriveMode,
  ProviderView
} from '../../../../shared/types'
import { DRIVE_MODE_OPTIONS } from '../../store'
import type { ModelOption } from '../../commands'
import { useT } from '../../i18n'
import type { WelcomeRoutingMode } from '../../store/welcome-draft'
import BoundedSelect from '../BoundedSelect'

interface WelcomeRoutingControlsProps {
  driveMode: CaoGenDriveMode
  fixedModelOptions: ModelOption[]
  model: string
  providerId: string
  providers: ProviderView[]
  routingMode: WelcomeRoutingMode
  routingStrategyLabel: string
  onDriveChange: (mode: CaoGenDriveMode) => void
  onModelChange: (model: string) => void
  onProviderChange: (providerId: string) => void
  onRoutingModeChange: (mode: WelcomeRoutingMode) => void
}

export default function WelcomeRoutingControls({
  driveMode,
  fixedModelOptions,
  model,
  onDriveChange,
  onModelChange,
  onProviderChange,
  onRoutingModeChange,
  providerId,
  providers,
  routingMode,
  routingStrategyLabel
}: WelcomeRoutingControlsProps): React.JSX.Element {
  const t = useT()
  return (
    <div className="welcome-expert-routing" data-expert-controls="routing">
      <div className="welcome-routing-modes" role="group" aria-label={t('routingMode')}>
        {(['fixed', 'provider', 'global'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className={routingMode === mode ? 'active' : ''}
            data-welcome-routing-mode={mode}
            onClick={() => onRoutingModeChange(mode)}
          >
            {t(routingModeLabel(mode))}
          </button>
        ))}
      </div>
      {routingMode !== 'global' && (
        <BoundedSelect
          ariaLabel={t('provider')}
          nativeClassName="welcome-mini-select"
          nativeDataAttributes={{ 'data-welcome-routing-control': 'provider' }}
          rootClassName="welcome-bounded-select-mini"
          value={providerId}
          onChange={onProviderChange}
          options={[
            { value: '', label: t('selectProviderPlaceholder'), disabled: true },
            ...providers.map((provider) => ({
              value: provider.id,
              label: `${provider.name}${provider.ready ? '' : ` (${t('noKeyConfigured')})`}`,
              disabled: !provider.ready
            }))
          ]}
        />
      )}
      <select
        className="welcome-mini-select"
        data-welcome-routing-control="drive"
        value={driveMode}
        onChange={(event) => onDriveChange(event.target.value as CaoGenDriveMode)}
      >
        {DRIVE_MODE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      {routingMode === 'fixed' ? (
        <BoundedSelect
          ariaLabel={t('model')}
          nativeClassName="welcome-mini-select"
          nativeDataAttributes={{ 'data-welcome-routing-control': 'model' }}
          rootClassName="welcome-bounded-select-mini"
          value={model}
          onChange={onModelChange}
          options={[
            { value: '', label: t('selectModelPlaceholder'), disabled: true },
            ...fixedModelOptions.map((option) => ({ value: option.value, label: option.label }))
          ]}
        />
      ) : (
        <span className="welcome-routing-summary">
          {routingMode === 'global' ? t('routingModeGlobalSummary') : t('routingModeProviderSummary')}
          {' · '}{routingStrategyLabel}
        </span>
      )}
    </div>
  )
}

export function AssistantComputeIndicator({
  available,
  checking = false
}: {
  available: boolean
  checking?: boolean
}): React.JSX.Element {
  const t = useT()
  return (
    <span
      className="assistant-compute-indicator"
      data-assistant-compute-state
      data-compute-available={available}
      data-compute-status={checking ? 'checking' : available ? 'ready' : 'unavailable'}
    >
      {t(checking ? 'assistantComputeCheckingLocal' : available ? 'assistantComputeReady' : 'assistantComputeUnavailableShort')}
    </span>
  )
}

function routingModeLabel(mode: WelcomeRoutingMode): string {
  if (mode === 'fixed') return 'routingModeFixed'
  if (mode === 'provider') return 'routingModeProvider'
  return 'routingModeGlobal'
}
