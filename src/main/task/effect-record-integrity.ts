import type { EffectRecord } from '../../shared/types'
import { stableValueDigest } from './tool-idempotency'

export function effectRecordIntegrityMatches(effect: EffectRecord): boolean {
  if (stableValueDigest(effect.target) !== effect.targetDigest) return false
  return stableValueDigest({
    toolName: effect.toolName,
    targetDigest: effect.targetDigest,
    inputDigest: effect.inputDigest
  }) === effect.intentDigest
}
