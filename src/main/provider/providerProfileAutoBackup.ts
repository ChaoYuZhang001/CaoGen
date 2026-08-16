import type { Provider } from '../../shared/types'
import { normalizedProviderKeys } from './providerKeyRecords'
import { writeProviderProfileBackup } from './providerProfileBackupWriter'

export type AutomaticProviderBackupReason = 'provider-create' | 'provider-update' | 'provider-delete'

export function writeAutomaticProviderProfileBackup(
  userDataRoot: string,
  reason: AutomaticProviderBackupReason,
  providers: Provider[],
  persistedProviders: Provider[]
): void {
  let excludedCredentialCount = 0
  const sanitized = persistedProviders.map((provider) => {
    const keyCount = normalizedProviderKeys(provider).length || Number(Boolean(provider.encryptedToken))
    excludedCredentialCount += keyCount
    return {
      ...provider,
      encryptedToken: '',
      apiKeys: [],
      activeKeyId: undefined,
      credentialMigrationRequired: provider.authMode === 'none'
        ? false
        : keyCount > 0 || provider.credentialMigrationRequired === true
    }
  })
  writeProviderProfileBackup(userDataRoot, reason, {
    providers: sanitized,
    nonPersistentCredentialCount: providers.reduce(
      (count, provider) => count + normalizedProviderKeys(provider).filter((key) => key.sessionOnly === true).length,
      0
    ),
    excludedCredentialCount
  })
}
