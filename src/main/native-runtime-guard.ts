import type {
  AgentEvent,
  AgentEventIdentity,
  SessionMeta,
  SessionStatus,
  TaskRunRecord,
  TranscriptEntry,
  UsageTotals
} from '../shared/types'
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
  defineNativeRuntimeAdapter
} from './native-runtime-contract'
import {
  freezeNativeRuntimeSnapshot,
  parseNativeRuntimeSnapshot
} from './native-runtime-snapshot'

const SESSION_STATUSES = new Set<SessionStatus>(['starting', 'running', 'idle', 'error', 'closed'])
const RUN_STATUSES = new Set<TaskRunRecord['status']>([
  'queued', 'planning', 'executing', 'waiting_approval', 'waiting_reconciliation',
  'verifying', 'recovering', 'completed', 'failed', 'cancelled'
])
const TERMINAL_RUN_STATUSES = new Set<TaskRunRecord['status']>(['completed', 'failed', 'cancelled'])
const RECENT_EVENT_LIMIT = 256
type EventDomain = 'session' | 'context' | 'tool' | 'terminal' | 'hook'
const EVENT_DOMAINS = {
  status: 'session',
  init: 'session',
  meta: 'session',
  'user-message': 'context',
  checkpoint: 'context',
  'checkpoint-restore': 'context',
  routing: 'context',
  failover: 'context',
  'provider-key-failover': 'context',
  'text-delta': 'context',
  'thinking-delta': 'context',
  'assistant-message': 'context',
  'tool-start': 'tool',
  'tool-result': 'tool',
  'permission-request': 'tool',
  'permission-resolved': 'tool',
  'turn-result': 'terminal',
  'subagent-result': 'terminal',
  'task-dag-update': 'terminal',
  'hook-event': 'hook'
} as const satisfies Record<AgentEvent['kind'], EventDomain>

interface MutableNativeRuntimeState {
  status: SessionStatus
  run: NativeRuntimeRunBinding | null
  contextActive: boolean
  lastMessageId: string | null
  turns: number
  activeTools: Set<string>
  settledTools: Set<string>
  failedTools: number
  pendingPermissions: Set<string>
  resolvedPermissions: number
  usage: NativeRuntimeUsageState
  error: NativeRuntimeErrorState | null
  checkpointMessageId: string | null
  checkpointRestores: number
  lastHook: string | null
  hookCount: number
  recoveryGeneration: number
  hydratedEvents: number
  streamId: string | null
  eventId: string | null
  seq: number
  revision: number
  eventCount: number
}

export interface NativeRuntimeGuardOptions {
  adapter: NativeRuntimeAdapterDeclaration
  meta: SessionMeta
  initialSeq?: number
}

export class NativeRuntimeGuard {
  readonly adapter: NativeRuntimeAdapterDeclaration
  private readonly sessionId: string
  private state: MutableNativeRuntimeState
  private recentEventIds: string[] = []
  private allowRestartStream = false

  constructor(options: NativeRuntimeGuardOptions) {
    assertNativeRuntimeAdapterDeclaration(options.adapter)
    this.adapter = defineNativeRuntimeAdapter(options.adapter.engineKind, options.adapter.protocol)
    this.sessionId = requiredString(options.meta.id, 'Session id')
    this.assertMetaIdentity(options.meta)
    const initialSeq = safeInteger(options.initialSeq ?? 0, 'initial event sequence')
    this.state = initialState(options.meta, initialSeq)
  }

  static restore(
    adapter: NativeRuntimeAdapterDeclaration,
    meta: SessionMeta,
    serialized: string
  ): NativeRuntimeGuard {
    const snapshot = parseNativeRuntimeSnapshot(serialized, adapter, meta)
    const guard = new NativeRuntimeGuard({ adapter, meta, initialSeq: snapshot.cursor.seq })
    guard.state = mutableState(snapshot)
    guard.recentEventIds = snapshot.cursor.eventId ? [snapshot.cursor.eventId] : []
    guard.allowRestartStream = true
    return guard
  }

  bindRun(run: TaskRunRecord): void {
    const binding = readRunBinding(run, this.sessionId)
    const current = this.state.run
    if (current?.id === binding.id && binding.revision < current.revision) {
      fail('run_revision', 'native runtime rejected a stale canonical Run revision')
    }
    if (current && current.id !== binding.id) {
      if (!TERMINAL_RUN_STATUSES.has(current.status) || this.state.contextActive) {
        fail('run_identity', 'native runtime cannot replace a non-terminal canonical Run')
      }
      this.state.activeTools.clear()
      this.state.settledTools.clear()
      this.state.pendingPermissions.clear()
    }
    this.state.run = binding
    this.state.revision += 1
  }

  accept(event: AgentEvent, seq: number, identity?: AgentEventIdentity): void {
    this.assertEvent(event)
    const receipt = this.assertIdentity(seq, identity)
    this.reduce(event, false)
    this.recordReceipt(receipt)
  }

  hydrateTranscript(entries: readonly TranscriptEntry[]): void {
    const ordered = [...entries].sort((left, right) => left.seq - right.seq)
    const seenSequences = new Set<number>()
    for (const entry of ordered) {
      if (!Number.isSafeInteger(entry.seq) || entry.seq <= 0 || seenSequences.has(entry.seq)) {
        fail('recovery_sequence', 'native runtime transcript sequence is invalid')
      }
      seenSequences.add(entry.seq)
      this.assertEvent(entry.event)
      this.reduce(entry.event, true)
      this.state.hydratedEvents += 1
      this.state.eventCount += 1
      if (entry.eventId) this.rememberEventId(entry.eventId)
    }
    if (ordered.length > 0) this.state.revision += 1
  }

  snapshot(): NativeRuntimeSnapshot {
    return freezeNativeRuntimeSnapshot({
      schemaVersion: NATIVE_RUNTIME_SCHEMA_VERSION,
      contractId: NATIVE_RUNTIME_CONTRACT_ID,
      adapter: this.adapter,
      session: { id: this.sessionId, engineKind: this.adapter.engineKind, status: this.state.status },
      run: this.state.run,
      context: {
        active: this.state.contextActive,
        lastMessageId: this.state.lastMessageId,
        turns: this.state.turns
      },
      tools: {
        activeIds: [...this.state.activeTools].sort(),
        settledIds: [...this.state.settledTools].sort(),
        failed: this.state.failedTools
      },
      permissions: {
        pendingIds: [...this.state.pendingPermissions].sort(),
        resolved: this.state.resolvedPermissions
      },
      usage: { ...this.state.usage },
      error: this.state.error,
      checkpoint: {
        lastMessageId: this.state.checkpointMessageId,
        restores: this.state.checkpointRestores
      },
      hook: { lastEvent: this.state.lastHook, count: this.state.hookCount },
      recovery: {
        generation: this.state.recoveryGeneration,
        hydratedEvents: this.state.hydratedEvents
      },
      cursor: {
        streamId: this.state.streamId,
        eventId: this.state.eventId,
        seq: this.state.seq
      },
      revision: this.state.revision,
      eventCount: this.state.eventCount
    })
  }

  serialize(): string {
    return JSON.stringify(this.snapshot())
  }

  private assertIdentity(seq: number, identity: AgentEventIdentity | undefined): AgentEventIdentity {
    if (!identity || identity.schemaVersion !== NATIVE_RUNTIME_SCHEMA_VERSION) {
      fail('event_identity', 'native runtime event identity is required')
    }
    if (identity.seq !== seq || !Number.isSafeInteger(seq) || seq !== this.state.seq + 1) {
      fail('event_sequence', 'native runtime event sequence is not the next canonical sequence')
    }
    requiredString(identity.streamId, 'event streamId')
    requiredString(identity.eventId, 'event eventId')
    if (!Number.isFinite(identity.occurredAt) || identity.occurredAt < 0) {
      fail('event_identity', 'native runtime event occurredAt is invalid')
    }
    if (this.recentEventIds.includes(identity.eventId)) {
      fail('event_identity', 'native runtime event identity was replayed')
    }
    if (this.state.streamId && identity.streamId !== this.state.streamId && !this.allowRestartStream) {
      fail('event_stream', 'native runtime event stream changed without a restart boundary')
    }
    return identity
  }

  private recordReceipt(identity: AgentEventIdentity): void {
    if (this.state.streamId && identity.streamId !== this.state.streamId) {
      this.state.recoveryGeneration += 1
    }
    this.allowRestartStream = false
    this.state.streamId = identity.streamId
    this.state.eventId = identity.eventId
    this.state.seq = identity.seq
    this.state.eventCount += 1
    this.state.revision += 1
    this.rememberEventId(identity.eventId)
  }

  private reduce(event: AgentEvent, rehydrating: boolean): void {
    const domain: EventDomain = EVENT_DOMAINS[event.kind]
    if (domain === 'session') return this.reduceSessionEvent(event)
    if (domain === 'context') return this.reduceContextEvent(event)
    if (domain === 'tool') return this.reduceToolEvent(event, rehydrating)
    if (domain === 'terminal') return this.reduceTerminalEvent(event)
    this.state.lastHook = event.kind === 'hook-event' ? event.event : null
    this.state.hookCount += 1
  }

  private reduceSessionEvent(event: AgentEvent): void {
    switch (event.kind) {
      case 'status': this.reduceStatus(event); return
      case 'init': return
      case 'meta': this.reduceMeta(event.meta); return
      default: fail('event_domain', 'native runtime session event domain is inconsistent')
    }
  }

  private reduceContextEvent(event: AgentEvent): void {
    switch (event.kind) {
      case 'user-message': this.reduceUserMessage(event.messageId); return
      case 'checkpoint': this.state.checkpointMessageId = event.messageId; return
      case 'checkpoint-restore': this.reduceCheckpointRestore(event.messageId); return
      case 'routing':
      case 'failover':
      case 'provider-key-failover':
      case 'text-delta':
      case 'thinking-delta':
      case 'assistant-message': return
      default: fail('event_domain', 'native runtime context event domain is inconsistent')
    }
  }

  private reduceToolEvent(event: AgentEvent, rehydrating: boolean): void {
    switch (event.kind) {
      case 'tool-start': this.reduceToolStart(event.toolUseId, rehydrating); return
      case 'tool-result': this.reduceToolResult(event, rehydrating); return
      case 'permission-request': this.reducePermissionRequest(event.request.requestId); return
      case 'permission-resolved': this.reducePermissionResolution(event.requestId, rehydrating); return
      default: fail('event_domain', 'native runtime tool event domain is inconsistent')
    }
  }

  private reduceTerminalEvent(event: AgentEvent): void {
    switch (event.kind) {
      case 'turn-result': this.reduceTurnResult(event); return
      case 'subagent-result':
      case 'task-dag-update': return
      default: fail('event_domain', 'native runtime terminal event domain is inconsistent')
    }
  }

  private reduceStatus(event: Extract<AgentEvent, { kind: 'status' }>): void {
    this.state.status = event.status
    if (event.status === 'error') {
      this.state.error = { source: 'session', code: 'session-error', hasDetail: Boolean(event.error) }
    }
  }

  private reduceMeta(meta: SessionMeta): void {
    this.assertMetaIdentity(meta)
    this.state.status = meta.status
    this.state.usage = usageState(meta.usage, meta.costUsd)
  }

  private reduceUserMessage(messageId: string | undefined): void {
    this.state.contextActive = true
    this.state.turns += 1
    if (messageId) this.state.lastMessageId = messageId
  }

  private reduceCheckpointRestore(messageId: string): void {
    this.state.checkpointMessageId = messageId
    this.state.checkpointRestores += 1
  }

  private reduceToolStart(toolUseId: string, rehydrating: boolean): void {
    if (!rehydrating && (this.state.activeTools.has(toolUseId) || this.state.settledTools.has(toolUseId))) {
      fail('tool_identity', 'native runtime tool identity was reused')
    }
    if (!this.state.settledTools.has(toolUseId)) this.state.activeTools.add(toolUseId)
  }

  private reduceToolResult(
    event: Extract<AgentEvent, { kind: 'tool-result' }>,
    rehydrating: boolean
  ): void {
    if (this.state.settledTools.has(event.toolUseId)) {
      if (rehydrating) return
      fail('tool_identity', 'native runtime tool result settled more than once')
    }
    this.state.activeTools.delete(event.toolUseId)
    this.state.settledTools.add(event.toolUseId)
    if (event.isError) {
      this.state.failedTools += 1
      this.state.error = { source: 'tool', code: 'tool-error', hasDetail: Boolean(event.content) }
    }
  }

  private reducePermissionRequest(requestId: string): void {
    if (this.state.pendingPermissions.has(requestId)) {
      fail('permission_identity', 'native runtime permission request identity was reused')
    }
    this.state.pendingPermissions.add(requestId)
  }

  private reducePermissionResolution(requestId: string, rehydrating: boolean): void {
    if (!this.state.pendingPermissions.delete(requestId) && !rehydrating) {
      fail('permission_identity', 'native runtime permission resolution has no pending request')
    }
    this.state.resolvedPermissions += 1
  }

  private reduceTurnResult(event: Extract<AgentEvent, { kind: 'turn-result' }>): void {
    this.state.contextActive = false
    if (event.usage) this.state.usage = usageState(event.usage, event.costUsd ?? this.state.usage.costUsd)
    else if (event.costUsd !== undefined) {
      this.state.usage = { ...this.state.usage, costUsd: nonNegative(event.costUsd, 'costUsd') }
    }
    if (event.isError) {
      this.state.error = { source: 'turn', code: event.subtype, hasDetail: Boolean(event.resultText) }
    } else {
      this.state.error = null
    }
    if (this.state.run) {
      const status = event.isError
        ? event.subtype === 'cancelled' ? 'cancelled' : 'failed'
        : 'completed'
      this.state.run = { ...this.state.run, status }
    }
  }

  private assertEvent(event: AgentEvent): void {
    if (!event || typeof event !== 'object') fail('event_schema', 'native runtime event must be an object')
    const kind = (event as { kind?: unknown }).kind
    if (typeof kind !== 'string' || !Object.hasOwn(EVENT_DOMAINS, kind)) {
      fail('event_schema', 'native runtime event kind is unsupported')
    }
    const domain: EventDomain = EVENT_DOMAINS[kind as AgentEvent['kind']]
    if (domain === 'session') return this.assertSessionEvent(event)
    if (domain === 'context') return this.assertContextEvent(event)
    if (domain === 'tool') return this.assertToolEvent(event)
    if (domain === 'terminal') return this.assertTerminalEvent(event)
    if (event.kind !== 'hook-event') fail('event_domain', 'native runtime hook event domain is inconsistent')
    requiredString(event.event, 'hook-event.event')
  }

  private assertSessionEvent(event: AgentEvent): void {
    switch (event.kind) {
      case 'status': if (!SESSION_STATUSES.has(event.status)) fail('event_schema', 'invalid status event'); return
      case 'init': requiredString(event.sdkSessionId, 'init.sdkSessionId'); return
      case 'meta': this.assertMetaIdentity(event.meta); return
      default: fail('event_domain', 'native runtime session event domain is inconsistent')
    }
  }

  private assertContextEvent(event: AgentEvent): void {
    switch (event.kind) {
      case 'user-message': if (typeof event.text !== 'string') fail('event_schema', 'user-message.text is required'); return
      case 'checkpoint': requiredString(event.messageId, 'checkpoint.messageId'); return
      case 'checkpoint-restore': requiredString(event.messageId, 'checkpoint-restore.messageId'); return
      case 'routing': requiredString(event.providerId, 'routing.providerId'); requiredString(event.model, 'routing.model'); return
      case 'failover': requiredString(event.fromProviderId, 'failover.fromProviderId'); requiredString(event.toProviderId, 'failover.toProviderId'); return
      case 'provider-key-failover': requiredString(event.fromKeyId, 'provider-key-failover.fromKeyId'); requiredString(event.toKeyId, 'provider-key-failover.toKeyId'); return
      case 'text-delta':
      case 'thinking-delta': if (typeof event.text !== 'string') fail('event_schema', `${event.kind}.text is required`); return
      case 'assistant-message': if (!Array.isArray(event.blocks)) fail('event_schema', 'assistant-message.blocks is required'); return
      default: fail('event_domain', 'native runtime context event domain is inconsistent')
    }
  }

  private assertToolEvent(event: AgentEvent): void {
    switch (event.kind) {
      case 'tool-start': requiredString(event.toolUseId, 'tool-start.toolUseId'); requiredString(event.name, 'tool-start.name'); return
      case 'tool-result': requiredString(event.toolUseId, 'tool-result.toolUseId'); if (typeof event.content !== 'string' || typeof event.isError !== 'boolean') fail('event_schema', 'tool-result is invalid'); return
      case 'permission-request': requiredString(event.request?.requestId, 'permission-request.requestId'); requiredString(event.request?.toolName, 'permission-request.toolName'); return
      case 'permission-resolved': requiredString(event.requestId, 'permission-resolved.requestId'); if (event.behavior !== 'allow' && event.behavior !== 'deny') fail('event_schema', 'permission resolution is invalid'); return
      default: fail('event_domain', 'native runtime tool event domain is inconsistent')
    }
  }

  private assertTerminalEvent(event: AgentEvent): void {
    switch (event.kind) {
      case 'turn-result': requiredString(event.subtype, 'turn-result.subtype'); if (typeof event.isError !== 'boolean') fail('event_schema', 'turn-result.isError is required'); if (event.usage) usageState(event.usage, event.costUsd ?? 0); return
      case 'subagent-result':
      case 'task-dag-update': return
      default: fail('event_domain', 'native runtime terminal event domain is inconsistent')
    }
  }

  private assertMetaIdentity(meta: SessionMeta): void {
    if (meta.id !== this.sessionId || meta.engine !== this.adapter.engineKind) {
      fail('session_identity', 'native runtime Session or Engine identity changed')
    }
  }

  private rememberEventId(eventId: string): void {
    this.recentEventIds = [...this.recentEventIds, eventId].slice(-RECENT_EVENT_LIMIT)
  }
}

function initialState(meta: SessionMeta, initialSeq: number): MutableNativeRuntimeState {
  return {
    status: meta.status,
    run: null,
    contextActive: false,
    lastMessageId: null,
    turns: 0,
    activeTools: new Set(),
    settledTools: new Set(),
    failedTools: 0,
    pendingPermissions: new Set(),
    resolvedPermissions: 0,
    usage: usageState(meta.usage, meta.costUsd),
    error: null,
    checkpointMessageId: null,
    checkpointRestores: 0,
    lastHook: null,
    hookCount: 0,
    recoveryGeneration: 0,
    hydratedEvents: 0,
    streamId: null,
    eventId: null,
    seq: initialSeq,
    revision: 0,
    eventCount: 0
  }
}

function mutableState(snapshot: NativeRuntimeSnapshot): MutableNativeRuntimeState {
  return {
    status: snapshot.session.status,
    run: snapshot.run ? { ...snapshot.run } : null,
    contextActive: snapshot.context.active,
    lastMessageId: snapshot.context.lastMessageId,
    turns: snapshot.context.turns,
    activeTools: new Set(snapshot.tools.activeIds),
    settledTools: new Set(snapshot.tools.settledIds),
    failedTools: snapshot.tools.failed,
    pendingPermissions: new Set(snapshot.permissions.pendingIds),
    resolvedPermissions: snapshot.permissions.resolved,
    usage: { ...snapshot.usage },
    error: snapshot.error ? { ...snapshot.error } : null,
    checkpointMessageId: snapshot.checkpoint.lastMessageId,
    checkpointRestores: snapshot.checkpoint.restores,
    lastHook: snapshot.hook.lastEvent,
    hookCount: snapshot.hook.count,
    recoveryGeneration: snapshot.recovery.generation,
    hydratedEvents: snapshot.recovery.hydratedEvents,
    streamId: snapshot.cursor.streamId,
    eventId: snapshot.cursor.eventId,
    seq: snapshot.cursor.seq,
    revision: snapshot.revision,
    eventCount: snapshot.eventCount
  }
}

function readRunBinding(run: TaskRunRecord, sessionId: string): NativeRuntimeRunBinding {
  if (run?.schemaVersion !== 1 || run.sessionId !== sessionId) {
    fail('run_identity', 'native runtime Run does not belong to the canonical Session')
  }
  if (!RUN_STATUSES.has(run.status)) fail('run_status', 'native runtime Run status is invalid')
  return {
    id: requiredString(run.id, 'Run id'),
    sessionId,
    taskId: requiredString(run.taskId, 'Run taskId'),
    status: run.status,
    revision: safeInteger(run.revision, 'Run revision'),
    attempt: positiveInteger(run.attempt, 'Run attempt'),
    recoveryCount: safeInteger(run.recoveryCount, 'Run recoveryCount')
  }
}

function usageState(usage: UsageTotals, costUsd: number): NativeRuntimeUsageState {
  return {
    input: nonNegative(usage.input, 'usage.input'),
    output: nonNegative(usage.output, 'usage.output'),
    cacheRead: nonNegative(usage.cacheRead, 'usage.cacheRead'),
    cacheCreation: nonNegative(usage.cacheCreation, 'usage.cacheCreation'),
    costUsd: nonNegative(costUsd, 'usage.costUsd')
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) fail('required_field', `${label} is required`)
  return value
}

function nonNegative(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail('number_field', `${label} must be a non-negative finite number`)
  }
  return value
}

function safeInteger(value: unknown, label: string): number {
  const result = nonNegative(value, label)
  if (!Number.isSafeInteger(result)) fail('number_field', `${label} must be a safe integer`)
  return result
}

function positiveInteger(value: unknown, label: string): number {
  const result = safeInteger(value, label)
  if (result === 0) fail('number_field', `${label} must be positive`)
  return result
}

function fail(code: string, message: string): never {
  throw new NativeRuntimeContractError(code, message)
}
