import type { EffectStatus } from './effect-types'

export type ProjectContextOperationResult<TContext> =
  | {
      ok: true
      context: TContext
      effectStatus: EffectStatus
      operationId: string
    }
  | {
      ok: false
      error: string
      effectStatus?: EffectStatus
      operationId?: string
      snapshotId?: string
    }
