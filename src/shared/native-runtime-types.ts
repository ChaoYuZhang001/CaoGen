import type {
  EngineKind,
  SessionStatus,
  TaskRunStatus,
  UsageTotals
} from './types'

export const NATIVE_RUNTIME_SCHEMA_VERSION = 1 as const
export const NATIVE_RUNTIME_CONTRACT_ID = 'caogen.native-runtime.v1' as const

export type NativeRuntimeCapabilityDomain =
  | 'session'
  | 'run'
  | 'context'
  | 'tool'
  | 'permission'
  | 'usage'
  | 'error'
  | 'checkpoint'
  | 'hook'
  | 'recovery'

export type NativeRuntimeCapabilityMatrix = Readonly<
  Record<NativeRuntimeCapabilityDomain, readonly string[]>
>

export interface NativeRuntimeContract {
  readonly schemaVersion: typeof NATIVE_RUNTIME_SCHEMA_VERSION
  readonly id: typeof NATIVE_RUNTIME_CONTRACT_ID
  readonly capabilities: NativeRuntimeCapabilityMatrix
}

export interface NativeRuntimeAdapterDeclaration {
  readonly schemaVersion: typeof NATIVE_RUNTIME_SCHEMA_VERSION
  readonly contractId: typeof NATIVE_RUNTIME_CONTRACT_ID
  readonly engineKind: EngineKind
  /** Wire protocol identity only; product semantics stay in the canonical runtime. */
  readonly protocol: string
  readonly capabilities: NativeRuntimeCapabilityMatrix
}

export interface NativeRuntimeRunBinding {
  readonly id: string
  readonly sessionId: string
  readonly taskId: string
  readonly status: TaskRunStatus
  readonly revision: number
  readonly attempt: number
  readonly recoveryCount: number
}

export interface NativeRuntimeCursor {
  readonly streamId: string | null
  readonly eventId: string | null
  readonly seq: number
}

export interface NativeRuntimeContextState {
  readonly active: boolean
  readonly lastMessageId: string | null
  readonly turns: number
}

export interface NativeRuntimeToolState {
  readonly activeIds: readonly string[]
  readonly settledIds: readonly string[]
  readonly failed: number
}

export interface NativeRuntimePermissionState {
  readonly pendingIds: readonly string[]
  readonly resolved: number
}

export interface NativeRuntimeUsageState extends UsageTotals {
  readonly costUsd: number
}

export interface NativeRuntimeErrorState {
  readonly source: 'session' | 'turn' | 'tool'
  readonly code: string
  /** Runtime state never persists raw provider or tool error text. */
  readonly hasDetail: boolean
}

export interface NativeRuntimeCheckpointState {
  readonly lastMessageId: string | null
  readonly restores: number
}

export interface NativeRuntimeHookState {
  readonly lastEvent: string | null
  readonly count: number
}

export interface NativeRuntimeRecoveryState {
  readonly generation: number
  readonly hydratedEvents: number
}

export interface NativeRuntimeSnapshot {
  readonly schemaVersion: typeof NATIVE_RUNTIME_SCHEMA_VERSION
  readonly contractId: typeof NATIVE_RUNTIME_CONTRACT_ID
  readonly adapter: NativeRuntimeAdapterDeclaration
  readonly session: {
    readonly id: string
    readonly engineKind: EngineKind
    readonly status: SessionStatus
  }
  readonly run: NativeRuntimeRunBinding | null
  readonly context: NativeRuntimeContextState
  readonly tools: NativeRuntimeToolState
  readonly permissions: NativeRuntimePermissionState
  readonly usage: NativeRuntimeUsageState
  readonly error: NativeRuntimeErrorState | null
  readonly checkpoint: NativeRuntimeCheckpointState
  readonly hook: NativeRuntimeHookState
  readonly recovery: NativeRuntimeRecoveryState
  readonly cursor: NativeRuntimeCursor
  readonly revision: number
  readonly eventCount: number
}
