import type { ProviderApiKeyInput, ProviderApiKeyUpdateInput, ProviderInput } from '../../shared/types'

const TOKEN_CONTROL_CHARACTERS = /[\0\r\n]/

export function validateProviderCredentialInput(input: Partial<ProviderInput>): void {
  assertOptionalStringFields(input)
  assertTokenValue(input.token, 'Provider token 不得包含 NUL 或换行符')
  assertAdditionalTokens(input.additionalTokens)
  assertKeyUpdates(input.keyUpdates)
  assertRemoveKeyIds(input.removeKeyIds)
  assertRoutingMode(input.credentialRoutingMode)
}

function assertOptionalStringFields(input: Partial<ProviderInput>): void {
  for (const [field, value] of [
    ['token', input.token],
    ['tokenLabel', input.tokenLabel],
    ['activeKeyId', input.activeKeyId]
  ] as const) {
    if (value !== undefined && typeof value !== 'string') {
      throw new Error(`Provider ${field} 必须是字符串`)
    }
  }
}

function assertTokenValue(value: unknown, message: string): void {
  if (typeof value === 'string' && TOKEN_CONTROL_CHARACTERS.test(value)) throw new Error(message)
}

function assertAdditionalTokens(value: ProviderApiKeyInput[] | undefined): void {
  if (value === undefined) return
  if (!Array.isArray(value)) throw new Error('Provider additionalTokens 必须是数组')
  for (const item of value) assertAdditionalToken(item)
}

function assertAdditionalToken(item: ProviderApiKeyInput): void {
  if (!item || typeof item !== 'object' || typeof item.token !== 'string') {
    throw new Error('Provider additionalTokens 项必须包含字符串 token')
  }
  assertTokenValue(item.token, 'Provider additionalTokens.token 不得包含 NUL 或换行符')
  if (item.label !== undefined && typeof item.label !== 'string') {
    throw new Error('Provider additionalTokens.label 必须是字符串')
  }
  if (item.disabled !== undefined && typeof item.disabled !== 'boolean') {
    throw new Error('Provider additionalTokens.disabled 必须是布尔值')
  }
  assertPolicy(item.policy, 'Provider additionalTokens.policy')
}

function assertKeyUpdates(value: ProviderApiKeyUpdateInput[] | undefined): void {
  if (value === undefined) return
  if (!Array.isArray(value)) throw new Error('Provider keyUpdates 必须是数组')
  for (const item of value) assertKeyUpdate(item)
}

function assertKeyUpdate(item: ProviderApiKeyUpdateInput): void {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string') {
    throw new Error('Provider keyUpdates 项必须包含字符串 id')
  }
  if (item.label !== undefined && typeof item.label !== 'string') {
    throw new Error('Provider keyUpdates.label 必须是字符串')
  }
  if (item.disabled !== undefined && typeof item.disabled !== 'boolean') {
    throw new Error('Provider keyUpdates.disabled 必须是布尔值')
  }
  assertPolicy(item.policy, 'Provider keyUpdates.policy')
}

function assertRoutingMode(value: ProviderInput['credentialRoutingMode'] | undefined): void {
  if (value !== undefined && !['manual', 'preferred', 'automatic'].includes(value)) {
    throw new Error('Provider credentialRoutingMode 无效')
  }
}

function assertPolicy(value: unknown, field: string): void {
  if (value === undefined) return
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} 必须是对象`)
  const policy = value as Record<string, unknown>
  for (const name of ['priority', 'monthlyBudgetUsd', 'minimumBalanceUsd', 'failureCooldownMinutes']) {
    const item = policy[name]
    if (item !== undefined && (typeof item !== 'number' || !Number.isFinite(item) || item < 0)) {
      throw new Error(`${field}.${name} 必须是非负有限数字`)
    }
  }
}

function assertRemoveKeyIds(value: string[] | undefined): void {
  if (value !== undefined && (!Array.isArray(value) || value.some((id) => typeof id !== 'string'))) {
    throw new Error('Provider removeKeyIds 必须是字符串数组')
  }
}
