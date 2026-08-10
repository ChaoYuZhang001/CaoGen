import { createHash } from 'node:crypto'

/** Canonical non-secret credential identity used by the ModelAttempt ledger. */
export function credentialFingerprint(providerId: string, keyId: string): string {
  const payload = JSON.stringify({ material: keyId, providerId })
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`
}
