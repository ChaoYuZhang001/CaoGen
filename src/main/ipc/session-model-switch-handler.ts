import type { Engine } from '../engine'
import { assertSessionModelSwitchAllowed } from '../session-model-switch-policy'

export async function applySessionModelSwitch(
  session: Engine | undefined,
  requestedModel: unknown
): Promise<void> {
  if (!session) return
  const decision = assertSessionModelSwitchAllowed({
    currentModel: session.meta.model,
    pendingPermissionCount: session.pendingPermissions().length,
    status: session.meta.status
  }, requestedModel)
  if (decision.changed) await session.setModel(decision.model)
}
