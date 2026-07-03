/**
 * 主进程 / 预加载 / 渲染进程共享的类型定义。
 * 仅包含类型(编译期擦除),两侧 tsconfig 都会引入本目录。
 */

export type PermissionModeId = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

export type SchedulerStrategy = 'quality' | 'cost' | 'balanced'

/** 会话 model 字段取此哨兵值 = 启用智能自动调度 */
export const AUTO_MODEL = 'auto'

export interface ProviderHealthView {
  /** '' / 'official' = 官方 Anthropic;否则 Provider id */
  providerId: string
  successes: number
  failures: number
  consecutiveFailures: number
  lastLatencyMs?: number
  lastError?: string
  lastUsedAt?: number
  healthy: boolean
}

export type SessionStatus = 'starting' | 'running' | 'idle' | 'error' | 'closed'

export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

export interface SessionMeta {
  id: string
  title: string
  cwd: string
  /** 空字符串表示跟随 CLI 默认模型 */
  model: string
  /** 此会话绑定的 Provider ID;空字符串 = 官方 Anthropic */
  providerId: string
  permissionMode: PermissionModeId
  status: SessionStatus
  sdkSessionId?: string
  costUsd: number
  usage: UsageTotals
  contextTokens: number
  createdAt: number
  lastError?: string
}

export interface HistoryEntry {
  id: string
  title: string
  cwd: string
  model: string
  providerId: string
  permissionMode: PermissionModeId
  sdkSessionId: string
  createdAt: number
  updatedAt: number
  costUsd: number
}

export interface CreateSessionOptions {
  cwd: string
  model?: string
  providerId?: string
  permissionMode?: PermissionModeId
  /** 传入历史会话的 sdkSessionId 可恢复上下文 */
  resumeSdkSessionId?: string
  title?: string
}

export interface AppSettings {
  /** 空字符串 = 跟随 CLI 默认 */
  defaultModel: string
  defaultPermissionMode: PermissionModeId
  /** 新会话默认使用的 Provider ID;空字符串 = 官方 Anthropic */
  defaultProviderId: string
  /** 自动调度策略 */
  schedulerStrategy: SchedulerStrategy
}

export interface Provider {
  id: string
  name: string
  /** 空字符串 = 官方 Anthropic API */
  baseUrl: string
  /** safeStorage 加密后的 token;空字符串 = 继承环境变量。仅存在于主进程 */
  encryptedToken: string
  /** 此 Provider 支持的模型列表(供 UI 下拉) */
  models: string[]
  /**
   * 自定义请求头,每行 "Name: value",注入 ANTHROPIC_CUSTOM_HEADERS。
   * 某些网关需要额外头(如自定义鉴权、路由标签)。
   */
  customHeaders?: string
  /** 用户备注 */
  note?: string
  createdAt: number
}

/** 渲染进程可见的 Provider:不含密钥,只标记是否已配置 token */
export interface ProviderView {
  id: string
  name: string
  baseUrl: string
  models: string[]
  customHeaders?: string
  note?: string
  createdAt: number
  hasToken: boolean
}

export interface ProviderInput {
  name: string
  baseUrl: string
  models: string[]
  customHeaders?: string
  note?: string
  /** 明文 token,经 IPC 传入主进程后加密落盘 */
  token: string
}

export type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }

export interface PermissionRequestInfo {
  requestId: string
  toolName: string
  input: unknown
  toolUseId?: string
  decisionReason?: string
}

export type AgentEvent =
  | { kind: 'status'; status: SessionStatus; error?: string }
  | {
      kind: 'init'
      sdkSessionId: string
      model?: string
      tools?: string[]
      permissionMode?: string
    }
  | { kind: 'meta'; meta: SessionMeta }
  | { kind: 'user-message'; text: string }
  | { kind: 'routing'; model: string; reason: string; providerId: string }
  | { kind: 'text-delta'; text: string }
  | { kind: 'thinking-delta'; text: string }
  | { kind: 'tool-start'; toolUseId: string; name: string }
  | { kind: 'assistant-message'; blocks: AssistantBlock[] }
  | { kind: 'tool-result'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'permission-request'; request: PermissionRequestInfo }
  | { kind: 'permission-resolved'; requestId: string; behavior: 'allow' | 'deny' }
  | {
      kind: 'turn-result'
      subtype: string
      isError: boolean
      costUsd?: number
      usage?: UsageTotals
      durationMs?: number
      numTurns?: number
      resultText?: string
    }

export interface SessionEventPayload {
  sessionId: string
  /** 会话内单调递增;渲染进程用它对"转录回放 + 实时广播"去重 */
  seq: number
  event: AgentEvent
}

/** 转录文件(JSONL)中的一行 */
export interface TranscriptEntry {
  seq: number
  event: AgentEvent
}

/** 通过 contextBridge 暴露给渲染进程的 API */
export interface AgentDeskApi {
  listSessions(): Promise<SessionMeta[]>
  listPendingPermissions(sessionId: string): Promise<PermissionRequestInfo[]>
  getTranscript(sessionId: string): Promise<TranscriptEntry[]>
  createSession(opts: CreateSessionOptions): Promise<SessionMeta>
  sendMessage(sessionId: string, text: string): Promise<void>
  interrupt(sessionId: string): Promise<void>
  closeSession(sessionId: string): Promise<void>
  respondPermission(
    sessionId: string,
    requestId: string,
    allow: boolean,
    message?: string
  ): Promise<void>
  setPermissionMode(sessionId: string, mode: PermissionModeId): Promise<void>
  setModel(sessionId: string, model: string): Promise<void>
  listHistory(): Promise<HistoryEntry[]>
  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  listProviders(): Promise<ProviderView[]>
  createProvider(provider: ProviderInput): Promise<ProviderView>
  updateProvider(id: string, patch: Partial<ProviderInput>): Promise<ProviderView>
  deleteProvider(id: string): Promise<void>
  fetchProviderModels(opts: { baseUrl: string; token?: string; providerId?: string }): Promise<string[]>
  listProviderHealth(): Promise<ProviderHealthView[]>
  pickDirectory(): Promise<string | null>
  onSessionEvent(cb: (sessionId: string, event: AgentEvent, seq: number) => void): () => void
}
