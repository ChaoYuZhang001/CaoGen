/**
 * 主进程 / 预加载 / 渲染进程共享的类型定义。
 * 仅包含类型(编译期擦除),两侧 tsconfig 都会引入本目录。
 */

export type PermissionModeId = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

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
  permissionMode: PermissionModeId
  sdkSessionId: string
  createdAt: number
  updatedAt: number
  costUsd: number
}

export interface CreateSessionOptions {
  cwd: string
  model?: string
  permissionMode?: PermissionModeId
  /** 传入历史会话的 sdkSessionId 可恢复上下文 */
  resumeSdkSessionId?: string
  title?: string
}

export interface AppSettings {
  /** 空字符串 = 跟随 CLI 默认 */
  defaultModel: string
  defaultPermissionMode: PermissionModeId
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
  pickDirectory(): Promise<string | null>
  onSessionEvent(cb: (sessionId: string, event: AgentEvent, seq: number) => void): () => void
}
