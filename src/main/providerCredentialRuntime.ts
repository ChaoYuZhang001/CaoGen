import { safeStorage } from 'electron'
import {
  ProviderCredentialBroker,
  type ProviderCredentialLease,
  type ProviderCredentialLeaseOptions,
  type ProviderCredentialLeaseScope,
  type ProviderCredentialRecord,
  type ProviderCredentialRef,
  type ProviderCredentialResolution,
  type ProviderCredentialSessionSnapshot
} from './providerCredentialBroker'

const broker = new ProviderCredentialBroker(safeStorage)

export function storeProviderCredential(ref: ProviderCredentialRef, token: string): ProviderCredentialRecord {
  return broker.store(ref, token)
}

export function inspectProviderCredential(
  ref: ProviderCredentialRef,
  record: ProviderCredentialRecord
): Omit<ProviderCredentialResolution, 'token'> {
  return broker.inspect(ref, record)
}

export function resolveProviderCredential(
  ref: ProviderCredentialRef,
  record: ProviderCredentialRecord
): ProviderCredentialResolution {
  return broker.resolve(ref, record)
}

export function issueStoredProviderCredentialLease(
  ref: ProviderCredentialRef,
  record: ProviderCredentialRecord,
  scope: ProviderCredentialLeaseScope,
  options?: ProviderCredentialLeaseOptions
): ProviderCredentialLease {
  return broker.issueLease(ref, record, scope, options)
}

export function issueEphemeralProviderCredentialLease(
  ref: ProviderCredentialRef,
  token: string,
  scope: ProviderCredentialLeaseScope,
  options?: ProviderCredentialLeaseOptions
): ProviderCredentialLease {
  return broker.issueTokenLease(ref, token, scope, options)
}

export function redeemProviderCredentialLease(
  lease: ProviderCredentialLease,
  scope: ProviderCredentialLeaseScope,
  now?: number
): ProviderCredentialResolution {
  return broker.redeemLease(lease, scope, now)
}

export function revokeProviderCredentialLease(leaseId: string): void {
  broker.revokeLease(leaseId)
}

export function redactProviderCredentials(value: string): string {
  return broker.redactKnownCredentials(value)
}

export function migrateLegacyProviderCredential(
  ref: ProviderCredentialRef,
  encryptedToken: string
): ProviderCredentialRecord | null {
  return broker.migrateLegacy(ref, encryptedToken)
}

export function forgetProviderCredential(ref: ProviderCredentialRef): void {
  broker.forget(ref)
}

export function forgetProviderCredentials(providerId: string): void {
  broker.forgetProvider(providerId)
}

export function snapshotProviderCredentials(providerId: string): ProviderCredentialSessionSnapshot {
  return broker.snapshotProvider(providerId)
}

export function restoreProviderCredentials(
  providerId: string,
  snapshot: ProviderCredentialSessionSnapshot
): void {
  broker.restoreProvider(providerId, snapshot)
}
