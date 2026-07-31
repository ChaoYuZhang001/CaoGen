import type { EffectStatus } from './effect-types'
import type { McpProbeResult } from './types'

export type McpProbeOperationResult =
  | {
      ok: true
      results: McpProbeResult[]
      effectStatus?: EffectStatus
      operationId?: string
    }
  | {
      ok: false
      error: string
      effectStatus?: EffectStatus
      operationId?: string
      snapshotId?: string
    }
