import type {
  EngineKind,
  OpenAIProtocol,
  Provider,
  ProviderApiKey,
  ProviderInput
} from '../../shared/types'

interface ProviderPatchFields {
  baseUrl: string
  customHeaders?: string
  credentialHeaderNames?: string[]
}

interface ProviderPatchFieldDependencies {
  normalizedCustomHeaders(value: string | undefined): string | undefined
  normalizedCredentialHeaderNames(value: unknown): string[] | undefined
  normalizeBaseUrl(baseUrl: string, engine: EngineKind, protocol?: OpenAIProtocol): string
  resolveProviderEngine(provider: Provider): EngineKind
}

interface ProviderMergeDependencies {
  normalizeBudget(value: unknown): number
  resolveProviderEngine(provider: Provider): EngineKind
}

export function resolveProviderPatchFields(
  previous: Provider,
  patch: Partial<ProviderInput>,
  dependencies: ProviderPatchFieldDependencies
): ProviderPatchFields {
  const customHeaders = patch.customHeaders === undefined
    ? previous.customHeaders
    : dependencies.normalizedCustomHeaders(patch.customHeaders)
  const credentialHeaderNames = patch.credentialHeaderNames === undefined
    ? previous.credentialHeaderNames
    : dependencies.normalizedCredentialHeaderNames(patch.credentialHeaderNames)
  const baseUrl = patch.baseUrl === undefined
    ? previous.baseUrl
    : dependencies.normalizeBaseUrl(
        patch.baseUrl,
        patch.engine ?? dependencies.resolveProviderEngine(previous),
        patch.openaiProtocol ?? previous.openaiProtocol
      )
  return { baseUrl, customHeaders, credentialHeaderNames }
}

export function removeProviderKeys(
  providerId: string,
  keys: ProviderApiKey[],
  removeKeyIds: string[] | undefined,
  forgetCredential: (providerId: string, keyId: string) => void
): ProviderApiKey[] {
  const removeIds = new Set((removeKeyIds ?? []).filter(Boolean))
  if (removeIds.size === 0) return keys
  for (const keyId of removeIds) forgetCredential(providerId, keyId)
  return keys.filter((key) => !removeIds.has(key.id))
}

export function mergeProviderPatch(
  previous: Provider,
  patch: Partial<ProviderInput>,
  fields: ProviderPatchFields,
  apiKeys: ProviderApiKey[],
  activeKeyId: string | undefined,
  dependencies: ProviderMergeDependencies
): Provider {
  const activeKey = apiKeys.find((key) => key.id === activeKeyId)
  return {
    ...previous,
    name: patch.name ?? previous.name,
    baseUrl: fields.baseUrl,
    models: patch.models ?? previous.models,
    engine: patch.engine ?? dependencies.resolveProviderEngine(previous),
    customHeaders: fields.customHeaders,
    credentialHeaderNames: fields.credentialHeaderNames,
    budgetUsd: patch.budgetUsd === undefined
      ? dependencies.normalizeBudget(previous.budgetUsd)
      : dependencies.normalizeBudget(patch.budgetUsd),
    openaiProtocol: patch.openaiProtocol ?? previous.openaiProtocol,
    note: patch.note ?? previous.note,
    credentialMigrationRequired: providerPatchAcknowledgesMigration(patch)
      ? false
      : previous.credentialMigrationRequired,
    encryptedToken: activeKey?.encryptedToken ?? '',
    apiKeys,
    activeKeyId
  }
}

function providerPatchAcknowledgesMigration(patch: Partial<ProviderInput>): boolean {
  return patch.baseUrl !== undefined
    || patch.customHeaders !== undefined
    || patch.credentialHeaderNames !== undefined
    || Boolean(patch.token?.trim())
    || patch.additionalTokens?.some((item) => Boolean(item.token.trim())) === true
}
