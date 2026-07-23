import type { SessionMeta, SessionStatus, TaskRunStatus } from '../shared/types'
import {
  NATIVE_RUNTIME_CONTRACT_ID,
  NATIVE_RUNTIME_SCHEMA_VERSION,
  type NativeRuntimeAdapterDeclaration,
  type NativeRuntimeErrorState,
  type NativeRuntimeRunBinding,
  type NativeRuntimeSnapshot,
  type NativeRuntimeUsageState
} from '../shared/native-runtime-types'
import {
  NativeRuntimeContractError,
  assertNativeRuntimeAdapterDeclaration,
  nativeRuntimeAdapterFingerprint
} from './native-runtime-contract'

const SESSION_STATUSES = new Set<SessionStatus>(['starting', 'running', 'idle', 'error', 'closed'])
const RUN_STATUSES = new Set<TaskRunStatus>([
  'queued',
  'planning',
  'executing',
  'waiting_approval',
  'waiting_reconciliation',
  'verifying',
  'recovering',
  'completed',
  'failed',
  'cancelled'
])

export function parseNativeRuntimeSnapshot(
  serialized: string,
  adapter: NativeRuntimeAdapterDeclaration,
  meta: SessionMeta
): NativeRuntimeSnapshot {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    fail('snapshot_json', 'native runtime snapshot is not valid JSON')
  }
  return readSnapshot(value, adapter, meta)
}

export function freezeNativeRuntimeSnapshot(
  snapshot: NativeRuntimeSnapshot
): NativeRuntimeSnapshot {
  const frozen: NativeRuntimeSnapshot = {
    ...snapshot,
    session: Object.freeze({ ...snapshot.session }),
    run: snapshot.run ? Object.freeze({ ...snapshot.run }) : null,
    context: Object.freeze({ ...snapshot.context }),
    tools: Object.freeze({
      ...snapshot.tools,
      activeIds: Object.freeze([...snapshot.tools.activeIds]),
      settledIds: Object.freeze([...snapshot.tools.settledIds])
    }),
    permissions: Object.freeze({
      ...snapshot.permissions,
      pendingIds: Object.freeze([...snapshot.permissions.pendingIds])
    }),
    usage: Object.freeze({ ...snapshot.usage }),
    error: snapshot.error ? Object.freeze({ ...snapshot.error }) : null,
    checkpoint: Object.freeze({ ...snapshot.checkpoint }),
    hook: Object.freeze({ ...snapshot.hook }),
    recovery: Object.freeze({ ...snapshot.recovery }),
    cursor: Object.freeze({ ...snapshot.cursor })
  }
  return Object.freeze(frozen)
}

function readSnapshot(
  value: unknown,
  adapter: NativeRuntimeAdapterDeclaration,
  meta: SessionMeta
): NativeRuntimeSnapshot {
  const root = record(value, 'snapshot')
  if (root.schemaVersion !== NATIVE_RUNTIME_SCHEMA_VERSION || root.contractId !== NATIVE_RUNTIME_CONTRACT_ID) {
    fail('snapshot_contract', 'native runtime snapshot contract identity is invalid')
  }
  assertNativeRuntimeAdapterDeclaration(root.adapter)
  if (nativeRuntimeAdapterFingerprint(root.adapter) !== nativeRuntimeAdapterFingerprint(adapter)) {
    fail('snapshot_adapter', 'native runtime snapshot adapter identity changed')
  }
  const session = readSession(root.session, adapter, meta)
  const run = root.run === null ? null : readRun(root.run, meta.id)
  const context = record(root.context, 'snapshot.context')
  const tools = record(root.tools, 'snapshot.tools')
  const permissions = record(root.permissions, 'snapshot.permissions')
  const checkpoint = record(root.checkpoint, 'snapshot.checkpoint')
  const hook = record(root.hook, 'snapshot.hook')
  const recovery = record(root.recovery, 'snapshot.recovery')
  const cursor = record(root.cursor, 'snapshot.cursor')
  const snapshot: NativeRuntimeSnapshot = {
    schemaVersion: NATIVE_RUNTIME_SCHEMA_VERSION,
    contractId: NATIVE_RUNTIME_CONTRACT_ID,
    adapter,
    session,
    run,
    context: {
      active: bool(context.active, 'snapshot.context.active'),
      lastMessageId: nullableString(context.lastMessageId, 'snapshot.context.lastMessageId'),
      turns: uint(context.turns, 'snapshot.context.turns')
    },
    tools: {
      activeIds: uniqueStrings(tools.activeIds, 'snapshot.tools.activeIds'),
      settledIds: uniqueStrings(tools.settledIds, 'snapshot.tools.settledIds'),
      failed: uint(tools.failed, 'snapshot.tools.failed')
    },
    permissions: {
      pendingIds: uniqueStrings(permissions.pendingIds, 'snapshot.permissions.pendingIds'),
      resolved: uint(permissions.resolved, 'snapshot.permissions.resolved')
    },
    usage: readUsage(root.usage),
    error: root.error === null ? null : readError(root.error),
    checkpoint: {
      lastMessageId: nullableString(checkpoint.lastMessageId, 'snapshot.checkpoint.lastMessageId'),
      restores: uint(checkpoint.restores, 'snapshot.checkpoint.restores')
    },
    hook: {
      lastEvent: nullableString(hook.lastEvent, 'snapshot.hook.lastEvent'),
      count: uint(hook.count, 'snapshot.hook.count')
    },
    recovery: {
      generation: uint(recovery.generation, 'snapshot.recovery.generation'),
      hydratedEvents: uint(recovery.hydratedEvents, 'snapshot.recovery.hydratedEvents')
    },
    cursor: {
      streamId: nullableString(cursor.streamId, 'snapshot.cursor.streamId'),
      eventId: nullableString(cursor.eventId, 'snapshot.cursor.eventId'),
      seq: uint(cursor.seq, 'snapshot.cursor.seq')
    },
    revision: uint(root.revision, 'snapshot.revision'),
    eventCount: uint(root.eventCount, 'snapshot.eventCount')
  }
  disjoint(snapshot.tools.activeIds, snapshot.tools.settledIds)
  return freezeNativeRuntimeSnapshot(snapshot)
}

function readSession(
  value: unknown,
  adapter: NativeRuntimeAdapterDeclaration,
  meta: SessionMeta
): NativeRuntimeSnapshot['session'] {
  const session = record(value, 'snapshot.session')
  if (session.id !== meta.id || session.engineKind !== adapter.engineKind) {
    fail('snapshot_session', 'native runtime snapshot session identity changed')
  }
  if (!SESSION_STATUSES.has(session.status as SessionStatus)) {
    fail('snapshot_session', 'native runtime snapshot session status is invalid')
  }
  return { id: meta.id, engineKind: adapter.engineKind, status: session.status as SessionStatus }
}

function readRun(value: unknown, sessionId: string): NativeRuntimeRunBinding {
  const run = record(value, 'snapshot.run')
  const status = run.status as TaskRunStatus
  if (string(run.sessionId, 'snapshot.run.sessionId') !== sessionId) {
    fail('snapshot_run', 'native runtime snapshot Run belongs to another Session')
  }
  if (!RUN_STATUSES.has(status)) fail('snapshot_run', 'native runtime snapshot Run status is invalid')
  return {
    id: string(run.id, 'snapshot.run.id'),
    sessionId,
    taskId: string(run.taskId, 'snapshot.run.taskId'),
    status,
    revision: uint(run.revision, 'snapshot.run.revision'),
    attempt: positiveInt(run.attempt, 'snapshot.run.attempt'),
    recoveryCount: uint(run.recoveryCount, 'snapshot.run.recoveryCount')
  }
}

function readUsage(value: unknown): NativeRuntimeUsageState {
  const usage = record(value, 'snapshot.usage')
  return {
    input: nonNegative(usage.input, 'snapshot.usage.input'),
    output: nonNegative(usage.output, 'snapshot.usage.output'),
    cacheRead: nonNegative(usage.cacheRead, 'snapshot.usage.cacheRead'),
    cacheCreation: nonNegative(usage.cacheCreation, 'snapshot.usage.cacheCreation'),
    costUsd: nonNegative(usage.costUsd, 'snapshot.usage.costUsd')
  }
}

function readError(value: unknown): NativeRuntimeErrorState {
  const error = record(value, 'snapshot.error')
  if (error.source !== 'session' && error.source !== 'turn' && error.source !== 'tool') {
    fail('snapshot_error', 'native runtime snapshot error source is invalid')
  }
  return {
    source: error.source,
    code: string(error.code, 'snapshot.error.code'),
    hasDetail: bool(error.hasDetail, 'snapshot.error.hasDetail')
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('snapshot_field', `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) fail('snapshot_field', `${label} is required`)
  return value
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null
  return string(value, label)
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail('snapshot_field', `${label} must be boolean`)
  return value
}

function nonNegative(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail('snapshot_field', `${label} must be a non-negative finite number`)
  }
  return value
}

function uint(value: unknown, label: string): number {
  const result = nonNegative(value, label)
  if (!Number.isSafeInteger(result)) fail('snapshot_field', `${label} must be a safe integer`)
  return result
}

function positiveInt(value: unknown, label: string): number {
  const result = uint(value, label)
  if (result === 0) fail('snapshot_field', `${label} must be positive`)
  return result
}

function uniqueStrings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) fail('snapshot_field', `${label} must be an array`)
  const values = value.map((item, index) => string(item, `${label}[${index}]`)).sort()
  if (new Set(values).size !== values.length) fail('snapshot_field', `${label} contains duplicates`)
  return values
}

function disjoint(left: readonly string[], right: readonly string[]): void {
  const rightSet = new Set(right)
  if (left.some((value) => rightSet.has(value))) {
    fail('snapshot_tool', 'active and settled tool identities overlap')
  }
}

function fail(code: string, message: string): never {
  throw new NativeRuntimeContractError(code, message)
}
