import type {
  AgentEvent,
  PermissionModeId,
  PermissionRequestInfo,
  SessionMeta,
  TranscriptEntry
} from '../shared/types'

/**
 * M6 · EngineAdapter:桌面会话与底层 Agent 引擎之间的契约。
 * 事件模型(AgentEvent)与引擎解耦——任何能产出这组事件、
 * 吃进用户消息的 CLI/SDK 都可以成为一个引擎。
 *
 * 现有实现:ClaudeEngine(= AgentSession,Claude Agent SDK)。
 * 规划实现:CodexEngine(Codex CLI)、GeminiEngine(Gemini CLI)。
 */
export interface Engine {
  readonly meta: SessionMeta
  start(): Promise<void>
  send(text: string): void
  interrupt(): Promise<void>
  respondPermission(requestId: string, allow: boolean, message?: string): void
  pendingPermissions(): PermissionRequestInfo[]
  getTranscript(): TranscriptEntry[]
  setPermissionMode(mode: PermissionModeId): Promise<void>
  setModel(model: string): Promise<void>
  rename(title: string): void
  dispose(): void
}

export type EngineEmit = (event: AgentEvent, seq: number) => void

export interface EngineFactory {
  /** 引擎标识,会话按 meta.engine 选择;'claude' 为默认 */
  kind: string
  /** 人类可读名(设置/新建会话下拉用) */
  label: string
  /** 当前环境是否可用(CLI 是否安装等);不可用则 UI 置灰 */
  available(): boolean
  create(meta: SessionMeta, emit: EngineEmit, resumeSdkSessionId?: string): Engine
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

/** 按 kind 创建引擎;未注册/不可用时回退默认 claude 引擎 */
export function createEngine(
  kind: string | undefined,
  meta: SessionMeta,
  emit: EngineEmit,
  resumeSdkSessionId?: string
): Engine {
  let factory = kind ? registry.get(kind) : undefined
  if (!factory || !factory.available()) factory = registry.get('claude')
  if (!factory) throw new Error('没有可用的 Agent 引擎(claude 引擎未注册)')
  return factory.create(meta, emit, resumeSdkSessionId)
}
