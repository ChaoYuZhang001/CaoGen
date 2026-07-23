import type { ProviderApiKeyInput, ProviderApiKeyUpdateInput, ProviderInput } from '../../shared/types'

const TOKEN_CONTROL_CHARACTERS = /[\0\r\n]/

export function validateProviderCredentialInput(input: Partial<ProviderInput>): void {
  assertOptionalStringFields(input)
  assertTokenValue(input.token, 'Provider token 不得包含 NUL 或换行符')
  assertAdditionalTokens(input.additionalTokens)
  assertKeyUpdates(input.keyUpdates)
  assertRemoveKeyIds(input.removeKeyIds)
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
}

function assertRemoveKeyIds(value: string[] | undefined): void {
  if (value !== undefined && (!Array.isArray(value) || value.some((id) => typeof id !== 'string'))) {
    throw new Error('Provider removeKeyIds 必须是字符串数组')
  }
}
