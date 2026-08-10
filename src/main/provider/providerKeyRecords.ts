import { randomUUID } from 'node:crypto'
import type { Provider, ProviderApiKey, ProviderApiKeyUpdateInput } from '../../shared/types'
import { normalizeProviderCredentialPolicy } from '../providerKeyRouting'

export const LEGACY_KEY_LABEL = '主密钥'

export function legacyKeyId(providerId: string): string {
  return `${providerId}:legacy-primary`
}

export function cleanKeyLabel(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback
}

export function normalizedProviderKeys(provider: Provider): ProviderApiKey[] {
  const seen = new Set<string>()
  const keys: ProviderApiKey[] = []
  const storedKeys = Array.isArray(provider.apiKeys) ? provider.apiKeys : []
  for (const [index, key] of storedKeys.entries()) {
    const normalized = normalizeStoredProviderKey(key, index)
    if (!normalized || seen.has(normalized.id)) continue
    seen.add(normalized.id)
    keys.push(normalized)
  }
  if (keys.length === 0 && provider.encryptedToken) keys.push(legacyProviderKey(provider))
  return keys
}

function normalizeStoredProviderKey(value: unknown, index: number): ProviderApiKey | undefined {
  if (!value || typeof value !== 'object') return undefined
  const key = value as ProviderApiKey
  if (typeof key.encryptedToken !== 'string' || (!key.encryptedToken && key.sessionOnly !== true)) return undefined
  return {
    id: typeof key.id === 'string' && key.id.trim() ? key.id : randomUUID(),
    label: cleanKeyLabel(key.label, `Key ${index + 1}`),
    encryptedToken: key.encryptedToken,
    sessionOnly: key.sessionOnly === true,
    createdAt: finiteTimestamp(key.createdAt) ?? Date.now(),
    lastUsedAt: finiteTimestamp(key.lastUsedAt),
    lastFailureAt: finiteTimestamp(key.lastFailureAt),
    lastFailureReason: cleanFailureReason(key.lastFailureReason),
    disabled: key.disabled === true,
    policy: normalizeProviderCredentialPolicy(key.policy)
  }
}

function legacyProviderKey(provider: Provider): ProviderApiKey {
  return {
    id: legacyKeyId(provider.id),
    label: LEGACY_KEY_LABEL,
    encryptedToken: provider.encryptedToken,
    createdAt: provider.createdAt || Date.now(),
    disabled: false,
    policy: normalizeProviderCredentialPolicy(undefined)
  }
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function cleanFailureReason(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : undefined
}

export function applyKeyUpdates(
  keys: ProviderApiKey[],
  updates: ProviderApiKeyUpdateInput[] | undefined
): ProviderApiKey[] {
  if (!updates?.length) return keys
  const byId = new Map(updates.filter((item) => item.id).map((item) => [item.id, item]))
  return keys.map((key, index) => {
    const update = byId.get(key.id)
    if (!update) return key
    return {
      ...key,
      label: update.label === undefined ? key.label : cleanKeyLabel(update.label, `Key ${index + 1}`),
      disabled: update.disabled === undefined ? key.disabled : update.disabled,
      policy: update.policy === undefined
        ? key.policy
        : normalizeProviderCredentialPolicy({ ...key.policy, ...update.policy })
    }
  })
}
