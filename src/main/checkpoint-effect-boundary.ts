import type { EffectRecord, TaskRunRecord } from '../shared/types'

const CHECKPOINT_BLOCKING_EFFECT_STATUSES = new Set<EffectRecord['status']>([
  'prepared',
  'executing',
  'waiting_reconciliation'
])

export interface CheckpointRestoreEffectBoundary {
  allowed: boolean
  previewOnly: boolean
  unresolvedEffectIds: string[]
  reason?: string
}

/**
 * A preview is read-only. Applying a restore changes conversation and possibly
 * workspace history, so it cannot cross an unresolved external-effect boundary.
 */
export function checkpointRestoreEffectBoundary(
  run: TaskRunRecord | undefined,
  dryRun: boolean
): CheckpointRestoreEffectBoundary {
  const unresolvedEffectIds = (run?.effects ?? [])
    .filter((effect) => CHECKPOINT_BLOCKING_EFFECT_STATUSES.has(effect.status))
    .map((effect) => effect.id)
  const waitingReconciliation = run?.status === 'waiting_reconciliation'

  if (dryRun) {
    return {
      allowed: true,
      previewOnly: true,
      unresolvedEffectIds,
      ...(waitingReconciliation || unresolvedEffectIds.length > 0
        ? { reason: checkpointBoundaryReason(unresolvedEffectIds) }
        : {})
    }
  }
  if (!waitingReconciliation && unresolvedEffectIds.length === 0) {
    return { allowed: true, previewOnly: false, unresolvedEffectIds: [] }
  }
  return {
    allowed: false,
    previewOnly: false,
    unresolvedEffectIds,
    reason: checkpointBoundaryReason(unresolvedEffectIds)
  }
}

function checkpointBoundaryReason(effectIds: readonly string[]): string {
  const suffix = effectIds.length > 0 ? ` (${effectIds.join(', ')})` : ''
  return `TaskRun 存在未决外部 Effect${suffix}，已阻止应用 checkpoint；请先完成效果对账。`
}
