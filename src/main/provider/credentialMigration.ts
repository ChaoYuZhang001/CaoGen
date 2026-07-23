import type { Provider, ProviderApiKey } from '../../shared/types'
import { inspectProviderBaseUrl, inspectProviderCustomHeaders } from '../providerCredentialBroker'

interface HeaderNameInspection {
  names: string[]
  rejected: string[]
}

interface LegacyCredentialMigration {
  encryptedToken: string
  sessionOnly?: boolean
}

interface CredentialMigrationDependencies {
  inspectCredentialHeaderNames(value: unknown): HeaderNameInspection
  legacyKeyId(providerId: string): string
  migrateLegacy(
    ref: { providerId: string; keyId: string },
    encryptedToken: string
  ): LegacyCredentialMigration | null
  migrationMarker: { credentialMigrationRequired: true }
}

interface RuntimeSanitizationDependencies {
  inspectCredentialHeaderNames(value: unknown): HeaderNameInspection
  migrationMarker: { credentialMigrationRequired: true }
}

interface ProviderMigration {
  provider: Provider
  changed: boolean
}

export function migrateProviderCredentials(
  providers: Provider[],
  dependencies: CredentialMigrationDependencies
): { providers: Provider[]; changed: boolean } {
  let changed = false
  const migrated = providers.map((provider) => {
    const migration = migrateProviderCredential(provider, dependencies)
    if (migration.changed) changed = true
    return migration.provider
  })
  return { providers: migrated, changed }
}

export function sanitizeProviderCredentialsForRuntime(
  providers: Provider[],
  dependencies: RuntimeSanitizationDependencies
): Provider[] {
  return providers.map((provider) => sanitizeProviderCredentialForRuntime(provider, dependencies))
}

function migrateProviderCredential(
  provider: Provider,
  dependencies: CredentialMigrationDependencies
): ProviderMigration {
  const metadata = sanitizeStoredProviderMetadata(provider, dependencies)
  const keys = migrateStoredApiKeys(metadata.provider, dependencies)
  const legacy = migrateTopLevelLegacyCredential(keys.provider, dependencies)
  return {
    provider: legacy.provider,
    changed: metadata.changed || keys.changed || legacy.changed
  }
}

function sanitizeStoredProviderMetadata(
  provider: Provider,
  dependencies: CredentialMigrationDependencies
): ProviderMigration {
  let changed = false
  let next = provider
  const inspectedBaseUrl = inspectProviderBaseUrl(provider.baseUrl)
  if (inspectedBaseUrl.rejectedNames.length > 0) {
    changed = true
    next = {
      ...next,
      baseUrl: inspectedBaseUrl.safeValue,
      ...dependencies.migrationMarker
    }
  }

  const inspectedHeaders = inspectProviderCustomHeaders(provider.customHeaders ?? '')
  if (inspectedHeaders.rejectedNames.length > 0) {
    changed = true
    next = {
      ...next,
      customHeaders: inspectedHeaders.safeValue.trim() || undefined,
      ...dependencies.migrationMarker
    }
  }

  const credentialHeaders = sanitizeStoredCredentialHeaderNames(provider, dependencies)
  if (credentialHeaders.changed) {
    changed = true
    next = {
      ...next,
      credentialHeaderNames: credentialHeaders.names.length > 0 ? credentialHeaders.names : undefined,
      ...(credentialHeaders.rejected ? dependencies.migrationMarker : {})
    }
  }
  return { provider: next, changed }
}

function sanitizeStoredCredentialHeaderNames(
  provider: Provider,
  dependencies: Pick<CredentialMigrationDependencies, 'inspectCredentialHeaderNames'>
): { names: string[]; changed: boolean; rejected: boolean } {
  const inspected = dependencies.inspectCredentialHeaderNames(provider.credentialHeaderNames)
  const stored = Array.isArray(provider.credentialHeaderNames)
    ? provider.credentialHeaderNames.filter((item): item is string => typeof item === 'string')
    : []
  return {
    names: inspected.names,
    changed: inspected.rejected.length > 0 || JSON.stringify(inspected.names) !== JSON.stringify(stored),
    rejected: inspected.rejected.length > 0
  }
}

function migrateStoredApiKeys(
  provider: Provider,
  dependencies: CredentialMigrationDependencies
): ProviderMigration {
  if (!Array.isArray(provider.apiKeys)) return { provider, changed: false }
  let changed = false
  const apiKeys = provider.apiKeys.map((key, index) => {
    const migration = migrateStoredApiKey(provider.id, key, index, dependencies)
    if (migration.changed) changed = true
    return migration.key
  }) as ProviderApiKey[]
  return { provider: { ...provider, apiKeys }, changed }
}

function migrateStoredApiKey(
  providerId: string,
  key: ProviderApiKey,
  index: number,
  dependencies: CredentialMigrationDependencies
): { key: ProviderApiKey; changed: boolean } {
  if (!key || typeof key.encryptedToken !== 'string') return { key, changed: false }
  const id = typeof key.id === 'string' && key.id.trim() ? key.id : `${providerId}:legacy-${index + 1}`
  const legacyMigration = dependencies.migrateLegacy({ providerId, keyId: id }, key.encryptedToken)
  if (!legacyMigration && id === key.id) return { key, changed: false }
  return {
    key: {
      ...key,
      id,
      ...(legacyMigration
        ? {
            encryptedToken: legacyMigration.encryptedToken,
            sessionOnly: legacyMigration.sessionOnly
          }
        : {})
    },
    changed: true
  }
}

function migrateTopLevelLegacyCredential(
  provider: Provider,
  dependencies: CredentialMigrationDependencies
): ProviderMigration {
  if (typeof provider.encryptedToken !== 'string' || !provider.encryptedToken.startsWith('b64:')) {
    return { provider, changed: false }
  }
  const migration = dependencies.migrateLegacy(
    { providerId: provider.id, keyId: provider.activeKeyId || dependencies.legacyKeyId(provider.id) },
    provider.encryptedToken
  )
  return migration
    ? { provider: { ...provider, encryptedToken: migration.encryptedToken }, changed: true }
    : { provider, changed: false }
}

function sanitizeProviderCredentialForRuntime(
  provider: Provider,
  dependencies: RuntimeSanitizationDependencies
): Provider {
  const inspectedBaseUrl = inspectProviderBaseUrl(provider.baseUrl)
  const inspectedHeaders = inspectProviderCustomHeaders(provider.customHeaders ?? '')
  const inspectedCredentialHeaders = dependencies.inspectCredentialHeaderNames(provider.credentialHeaderNames)
  if (
    inspectedBaseUrl.rejectedNames.length === 0
    && inspectedHeaders.rejectedNames.length === 0
    && inspectedCredentialHeaders.rejected.length === 0
  ) {
    return provider
  }
  return {
    ...provider,
    baseUrl: inspectedBaseUrl.safeValue,
    customHeaders: inspectedHeaders.safeValue.trim() || undefined,
    credentialHeaderNames: inspectedCredentialHeaders.names.length > 0
      ? inspectedCredentialHeaders.names
      : undefined,
    ...dependencies.migrationMarker
  }
}
