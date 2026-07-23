import { stableValueDigest } from './tool-idempotency'

export const EFFECT_RECONCILER_VERSION = 'effect-reconciler-v1'

export interface EffectReconciliationResult {
  kind: 'confirmed' | 'not_applied' | 'unresolved'
  evidenceDigest: string
  verifier: string
  reason: string
}

export function confirmed(payload: unknown, reason: string): EffectReconciliationResult {
  return result('confirmed', payload, reason)
}

export function notApplied(payload: unknown, reason: string): EffectReconciliationResult {
  return result('not_applied', payload, reason)
}

export function unresolved(payload: unknown): EffectReconciliationResult {
  const reason = typeof payload === 'object' && payload && 'reason' in payload
    ? String((payload as { reason: unknown }).reason)
    : '外部状态无法确认'
  return result('unresolved', payload, reason)
}

function result(
  kind: EffectReconciliationResult['kind'],
  payload: unknown,
  reason: string
): EffectReconciliationResult {
  return {
    kind,
    evidenceDigest: stableValueDigest(payload),
    verifier: EFFECT_RECONCILER_VERSION,
    reason
  }
}
