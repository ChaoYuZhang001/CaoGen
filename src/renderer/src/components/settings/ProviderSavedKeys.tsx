import { useT } from '../../i18n'
import type {
  ProviderApiKeyView,
  ProviderCredentialPolicy,
  ProviderCredentialRoutingMode,
  ProviderCredentialStorage,
  ProviderView
} from '../../../../shared/types'

export interface ProviderKeyDraft {
  label: string
  disabled: boolean
  remove: boolean
  priority: string
  monthlyBudgetUsd: string
  minimumBalanceUsd: string
  failureCooldownMinutes: string
}

interface Props {
  provider: ProviderView | null
  savedKeys: ProviderApiKeyView[]
  keyDrafts: Record<string, ProviderKeyDraft>
  activeKeyId: string
  routingMode: ProviderCredentialRoutingMode
  onActiveKeyChange: (keyId: string) => void
  onRoutingModeChange: (mode: ProviderCredentialRoutingMode) => void
  onKeyDraftsChange: React.Dispatch<React.SetStateAction<Record<string, ProviderKeyDraft>>>
}

export default function ProviderSavedKeys({
  provider,
  savedKeys,
  keyDrafts,
  activeKeyId,
  routingMode,
  onActiveKeyChange,
  onRoutingModeChange,
  onKeyDraftsChange
}: Props): React.JSX.Element | null {
  const t = useT()
  if (!provider || savedKeys.length === 0) return null

  const usableKeyCount = provider.keyCount ?? savedKeys.filter((key) => !key.disabled).length
  const selectedKeyId = activeKeyId || provider.activeKeyId || ''
  return (
    <div className="provider-key-panel">
      <div className="field-label-row">
        <label className="field-label">{t('apiKeyListLabel')}</label>
        <span className="field-hint">{t('apiKeyCountLabel', { n: usableKeyCount })}</span>
      </div>
      <div className="provider-key-routing-head">
        <label>
          <span>{t('credentialRoutingModeLabel')}</span>
          <select
            className="select"
            value={routingMode}
            data-provider-credential-routing-mode
            onChange={(event) => onRoutingModeChange(event.target.value as ProviderCredentialRoutingMode)}
          >
            <option value="manual">{t('credentialRoutingModeManual')}</option>
            <option value="preferred">{t('credentialRoutingModePreferred')}</option>
            <option value="automatic">{t('credentialRoutingModeAutomatic')}</option>
          </select>
        </label>
        {provider.credentialRouteReason && <span className="provider-key-route-reason">{provider.credentialRouteReason}</span>}
      </div>
      <div className="provider-key-list">
        {savedKeys.map((apiKey) => (
          <SavedKeyRow
            key={apiKey.id}
            apiKey={apiKey}
            draft={keyDrafts[apiKey.id] ?? initialKeyDraft(apiKey)}
            activeKeyId={selectedKeyId}
            onActive={() => onActiveKeyChange(apiKey.id)}
            onChange={(patch) =>
              onKeyDraftsChange((previous) => patchKeyDraft(previous, apiKey, patch))
            }
          />
        ))}
      </div>
    </div>
  )
}

function SavedKeyRow({
  apiKey,
  draft,
  activeKeyId,
  onActive,
  onChange
}: {
  apiKey: ProviderApiKeyView
  draft: ProviderKeyDraft
  activeKeyId: string
  onActive: () => void
  onChange: (patch: Partial<ProviderKeyDraft>) => void
}): React.JSX.Element {
  const t = useT()
  const removed = draft.remove
  const disabled = draft.disabled || removed
  const lastUsed = apiKey.lastUsedAt
    ? t('apiKeyLastUsed', { time: new Date(apiKey.lastUsedAt).toLocaleString() })
    : t('apiKeyNeverUsed')
  const lastFailure = apiKey.lastFailureAt
    ? t('apiKeyLastFailure', {
        reason: apiKey.lastFailureReason || '-',
        time: new Date(apiKey.lastFailureAt).toLocaleString()
      })
    : ''
  const storage = t(providerCredentialStorageLabelKey(apiKey.credentialStorage))
  const availability = apiKey.available ? '' : t('apiKeyCurrentlyUnavailable')
  return (
    <div className={`provider-key-row ${removed ? 'provider-key-row-removed' : ''}`}>
      <div className="provider-key-summary">
        <label className="provider-key-active">
          <input
            type="radio"
            name="provider-active-key"
            checked={activeKeyId === apiKey.id}
            disabled={disabled}
            onChange={onActive}
          />
          <span>{t('apiKeyActive')}</span>
        </label>
        <input
          className="input input-block provider-key-name"
          value={draft.label}
          disabled={removed}
          onChange={(event) => onChange({ label: event.target.value })}
        />
        <div className="provider-key-meta">
          {[storage, availability, spendText(apiKey, t), balanceText(apiKey, t), apiKey.routingBlockedReason, lastUsed, lastFailure].filter(Boolean).join(' · ')}
        </div>
      </div>
      <div className="provider-key-policy-grid">
        <PolicyNumber label={t('credentialPriority')} value={draft.priority} min="1" max="100" disabled={removed} onChange={(priority) => onChange({ priority })} />
        <PolicyNumber label={t('credentialMonthlyBudget')} value={draft.monthlyBudgetUsd} min="0" step="0.01" disabled={removed} onChange={(monthlyBudgetUsd) => onChange({ monthlyBudgetUsd })} />
        <PolicyNumber label={t('credentialMinimumBalance')} value={draft.minimumBalanceUsd} min="0" step="0.01" disabled={removed} onChange={(minimumBalanceUsd) => onChange({ minimumBalanceUsd })} />
        <PolicyNumber label={t('credentialFailureCooldown')} value={draft.failureCooldownMinutes} min="1" max="1440" disabled={removed} onChange={(failureCooldownMinutes) => onChange({ failureCooldownMinutes })} />
      </div>
      <div className="provider-key-actions">
        <label className="provider-key-check">
          <input type="checkbox" checked={draft.disabled} disabled={removed} onChange={(event) => onChange({ disabled: event.target.checked })} />
          <span>{t('apiKeyDisabled')}</span>
        </label>
        <label className="provider-key-check">
          <input type="checkbox" checked={removed} onChange={(event) => onChange({ remove: event.target.checked })} />
          <span>{t('apiKeyRemove')}</span>
        </label>
      </div>
    </div>
  )
}

function PolicyNumber({ label, value, min, max, step, disabled, onChange }: {
  label: string
  value: string
  min: string
  max?: string
  step?: string
  disabled: boolean
  onChange: (value: string) => void
}): React.JSX.Element {
  return <label><span>{label}</span><input className="input" type="number" value={value} min={min} max={max} step={step} disabled={disabled} onChange={(event) => onChange(event.target.value)} /></label>
}

function initialKeyDraft(apiKey: ProviderApiKeyView): ProviderKeyDraft {
  return {
    label: apiKey.label,
    disabled: apiKey.disabled,
    remove: false,
    priority: String(apiKey.policy.priority),
    monthlyBudgetUsd: apiKey.policy.monthlyBudgetUsd ? String(apiKey.policy.monthlyBudgetUsd) : '',
    minimumBalanceUsd: apiKey.policy.minimumBalanceUsd ? String(apiKey.policy.minimumBalanceUsd) : '',
    failureCooldownMinutes: String(apiKey.policy.failureCooldownMinutes)
  }
}

export function createProviderKeyDrafts(keys: ProviderApiKeyView[]): Record<string, ProviderKeyDraft> {
  return Object.fromEntries(keys.map((key) => [key.id, initialKeyDraft(key)]))
}

export function providerKeyPolicyFromDraft(draft: ProviderKeyDraft): ProviderCredentialPolicy {
  return {
    priority: numericPolicyValue(draft.priority, 50),
    monthlyBudgetUsd: numericPolicyValue(draft.monthlyBudgetUsd, 0),
    minimumBalanceUsd: numericPolicyValue(draft.minimumBalanceUsd, 0),
    failureCooldownMinutes: numericPolicyValue(draft.failureCooldownMinutes, 5)
  }
}

function numericPolicyValue(value: string, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

function spendText(apiKey: ProviderApiKeyView, t: ReturnType<typeof useT>): string {
  return t('credentialMonthlySpend', { amount: apiKey.monthlySpendUsd.toFixed(2) })
}

function balanceText(apiKey: ProviderApiKeyView, t: ReturnType<typeof useT>): string {
  return apiKey.balanceRemainingUsd === undefined
    ? ''
    : t('credentialKnownBalance', { amount: apiKey.balanceRemainingUsd.toFixed(2) })
}

function patchKeyDraft(
  previous: Record<string, ProviderKeyDraft>,
  apiKey: ProviderApiKeyView,
  patch: Partial<ProviderKeyDraft>
): Record<string, ProviderKeyDraft> {
  return {
    ...previous,
    [apiKey.id]: {
      ...(previous[apiKey.id] ?? initialKeyDraft(apiKey)),
      ...patch
    }
  }
}

function providerCredentialStorageLabelKey(storage: ProviderCredentialStorage): string {
  switch (storage) {
    case 'encrypted':
      return 'apiKeyStorageEncrypted'
    case 'session':
      return 'apiKeyStorageSession'
    case 'legacy-b64':
      return 'apiKeyStorageLegacy'
    case 'unavailable':
      return 'apiKeyStorageUnavailable'
    case 'mixed':
      return 'apiKeyStorageMixed'
    case 'none':
      return 'apiKeyStorageNone'
  }
}
