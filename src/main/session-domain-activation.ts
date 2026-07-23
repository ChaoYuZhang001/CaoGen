import { ensureProjectWorkspaceLedgerProjection } from './project-workspace/ledger-migration'
import {
  assertPersistedSessionDomainOwnership,
  type SessionDomainOwnership
} from './session-create-lifecycle'
import type { SessionMeta } from '../shared/types'
import { createDigitalWorkerSessionBinding, resolveDigitalWorkerSessionScope } from './digital-worker/session-binding'

type SessionDomainActivationClaim = SessionDomainOwnership & { unassigned?: boolean }

/**
 * Bind Session ownership to both persistence domains before a Run or Engine is
 * created. ProjectWorkspace remains the write source, so verify it again after
 * the projection to reject concurrent source changes.
 */
export async function prepareSessionDomainOwnershipForActivation(
  claim: SessionDomainActivationClaim,
  rootDir?: string
): Promise<SessionDomainOwnership> {
  const ownership = await assertPersistedSessionDomainOwnership(claim, rootDir)
  if (!ownership.workspaceId || claim.unassigned === true) return ownership

  await ensureProjectWorkspaceLedgerProjection(ownership.workspaceId, rootDir)
  return assertPersistedSessionDomainOwnership({ ...claim, ...ownership }, rootDir)
}

export async function prepareSessionIdentityForActivation(
  meta: SessionMeta,
  rootDir: string,
  resuming: boolean
): Promise<SessionMeta> {
  const ownership = await prepareSessionDomainOwnershipForActivation(meta, rootDir)
  const owned = { ...meta, ...ownership }
  const digitalWorkerBinding = resuming
    ? resolveDigitalWorkerSessionScope(owned, rootDir, { allowLegacyUnscoped: true }).binding
    : createDigitalWorkerSessionBinding(owned, rootDir)
  return { ...owned, digitalWorkerBinding }
}
