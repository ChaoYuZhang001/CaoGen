import type {
  AgentEvent,
  AgentEventIdentity,
  CheckpointRestoreMode,
  CheckpointRestoreResult,
  PermissionModeId,
  PermissionRequestInfo,
  RewindResult,
  SdkAgentInfo,
  SendMessagePayload,
  SessionMeta,
  TranscriptEntry
} from '../shared/types'

/**
 * M6 · EngineAdapter:桌面会话与底层 Agent 引擎之间的契约。
 * 事件模型(AgentEvent)与引擎解耦——任何能产出这组事件、
 * 吃进用户消息的 CLI/SDK 都可以成为一个引擎。
 *
 * 现有实现:ClaudeEngine(= AgentSession,Claude Agent SDK)、OpenAIEngine。
 * 注意:创建会话必须显式选择引擎;这里不再静默回退 Claude。
 */
export interface Engine {
  readonly meta: SessionMeta
  start(): Promise<void>
  send(input: string | SendMessagePayload): void
  rejectSend(message: string): void
  interrupt(): Promise<void>
  respondPermission(requestId: string, allow: boolean, message?: string): void
  pendingPermissions(): PermissionRequestInfo[]
  getTranscript(): TranscriptEntry[]
  /** 由 SessionManager 注入的本地合成事件,用于让编排/状态事件进入同一条转录链。 */
  emitSyntheticEvent?(event: AgentEvent): void
  setPermissionMode(mode: PermissionModeId): Promise<void>
  setModel(model: string): Promise<void>
  /** Claude SDK 原生 agents 列表;不支持的引擎可不实现。 */
  supportedAgents?(): Promise<SdkAgentInfo[]>
  rename(title: string): void
  /** 文件检查点回退(引擎可选;不支持则返回 canRewind:false) */
  rewindFiles?(messageId: string, dryRun: boolean): Promise<RewindResult>
  /** 代码/对话/两者检查点回退(引擎可选) */
  restoreCheckpoint?(
    messageId: string,
    mode: CheckpointRestoreMode,
    dryRun: boolean
  ): Promise<CheckpointRestoreResult>
  dispose(): void
}

export type EngineEmit = (event: AgentEvent, seq: number, identity?: AgentEventIdentity) => void

export interface EngineFactory {
  /** 引擎标识,会话按 meta.engine 选择。 */
  kind: string
  /** 人类可读名(设置/新建会话下拉用) */
  label: string
  /** 当前环境是否可用(CLI 是否安装等);不可用则 UI 置灰 */
  available(): boolean
  create(meta: SessionMeta, emit: EngineEmit, resumeSdkSessionId?: string, initialEventSeq?: number): Engine
}

const registry = new Map<string, EngineFactory>()

export function registerEngine(factory: EngineFactory): void {
  registry.set(factory.kind, factory)
}

export function listEngines(): Array<{ kind: string; label: string; available: boolean }> {
  return [...registry.values()].map((f) => ({
    kind: f.kind,
    label: f.label,
    available: f.available()
  }))
}

/** 按 kind 创建引擎;未注册/不可用时直接失败,避免暗中换成别的模型/账号体系。 */
export function createEngine(
  kind: string | undefined,
  meta: SessionMeta,
  emit: EngineEmit,
  resumeSdkSessionId?: string,
  initialEventSeq = 0
): Engine {
  if (!kind) throw new Error('请选择 Agent 引擎')
  const factory = registry.get(kind)
  if (!factory) throw new Error(`Agent 引擎未注册:${kind}`)
  if (!factory.available()) throw new Error(`Agent 引擎不可用:${factory.label}`)
  return factory.create(meta, emit, resumeSdkSessionId, initialEventSeq)
}
