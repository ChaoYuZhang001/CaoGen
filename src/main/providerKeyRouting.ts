import type { ProviderApiKey } from '../shared/types'
import type { FailureClass } from './providerHealth'

export const PROVIDER_KEY_FAILURE_COOLDOWN_MS = 5 * 60_000

export function canRotateProviderKey(failure: FailureClass): boolean {
  return ['quota', 'rate_limit', 'auth', 'forbidden'].includes(failure.kind)
}

export function pickNextProviderKey(
  keys: ProviderApiKey[],
  options: {
    activeKeyId?: string
    failedKeyId?: string
    excludedKeyIds?: ReadonlySet<string>
    now?: number
    cooldownMs?: number
  }
): ProviderApiKey | undefined {
  const enabled = keys.filter((key) => (key.encryptedToken || key.sessionOnly) && !key.disabled)
  if (enabled.length < 2) return undefined

  const now = options.now ?? Date.now()
  const cooldownMs = options.cooldownMs ?? PROVIDER_KEY_FAILURE_COOLDOWN_MS
  const failedKeyId = options.failedKeyId || options.activeKeyId
  const excluded = new Set(options.excludedKeyIds ?? [])
  if (failedKeyId) excluded.add(failedKeyId)
  const available = (key: ProviderApiKey): boolean => {
    if (excluded.has(key.id)) return false
    return !key.lastFailureAt || now - key.lastFailureAt >= cooldownMs
  }

  const active = enabled.find((key) => key.id === options.activeKeyId)
  if (active && active.id !== failedKeyId && available(active)) return active

  const failedIndex = Math.max(0, enabled.findIndex((key) => key.id === failedKeyId))
  for (let offset = 1; offset <= enabled.length; offset += 1) {
    const candidate = enabled[(failedIndex + offset) % enabled.length]
    if (available(candidate)) return candidate
  }
  return undefined
}
