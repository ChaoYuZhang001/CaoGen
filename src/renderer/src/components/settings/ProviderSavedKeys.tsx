import { useT } from '../../i18n'
import type { ProviderApiKeyView, ProviderCredentialStorage, ProviderView } from '../../../../shared/types'

export interface ProviderKeyDraft {
  label: string
  disabled: boolean
  remove: boolean
}

interface Props {
  provider: ProviderView | null
  savedKeys: ProviderApiKeyView[]
  keyDrafts: Record<string, ProviderKeyDraft>
  activeKeyId: string
  onActiveKeyChange: (keyId: string) => void
  onKeyDraftsChange: React.Dispatch<React.SetStateAction<Record<string, ProviderKeyDraft>>>
}

export default function ProviderSavedKeys({
  provider,
  savedKeys,
  keyDrafts,
  activeKeyId,
  onActiveKeyChange,
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
      <div className="provider-key-main">
        <input
          className="input input-block provider-key-name"
          value={draft.label}
          disabled={removed}
          onChange={(event) => onChange({ label: event.target.value })}
        />
        <div className="provider-key-meta">
          {[storage, availability, lastUsed, lastFailure].filter(Boolean).join(' · ')}
        </div>
      </div>
      <label className="provider-key-check">
        <input
          type="checkbox"
          checked={draft.disabled}
          disabled={removed}
          onChange={(event) => onChange({ disabled: event.target.checked })}
        />
        <span>{t('apiKeyDisabled')}</span>
      </label>
      <label className="provider-key-check">
        <input
          type="checkbox"
          checked={removed}
          onChange={(event) => onChange({ remove: event.target.checked })}
        />
        <span>{t('apiKeyRemove')}</span>
      </label>
    </div>
  )
}

function initialKeyDraft(apiKey: ProviderApiKeyView): ProviderKeyDraft {
  return { label: apiKey.label, disabled: apiKey.disabled, remove: false }
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
