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

/** Agent 引擎标识:claude = Claude Agent SDK(默认);codex / gemini 经 EngineAdapter 接入 */
export type EngineKind = 'claude' | 'codex' | 'gemini'

export interface EngineInfo {
  kind: string
  label: string
  /** 该引擎在本机是否可用(CLI 已安装等) */
  available: boolean
}

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
  /** Agent 引擎;缺省 = 'claude' */
  engine?: EngineKind
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
  /** Agent 引擎;缺省 claude */
  engine?: EngineKind
  permissionMode?: PermissionModeId
  /** 传入历史会话的 sdkSessionId 可恢复上下文 */
  resumeSdkSessionId?: string
  title?: string
}

export type AppLanguage = 'zh' | 'en'

/** 主题偏好:白天(主白副黑)/ 夜晚(主黑副白)/ 跟随系统 */
export type AppTheme = 'light' | 'dark' | 'system'

/** 收藏的项目目录(快速新建会话) */
export interface Project {
  id: string
  name: string
  path: string
  lastUsedAt: number
}

export interface OfficeSettings {
  /** 显示桌上厂商工牌 */
  showBadges: boolean
  /** 小人动画活跃度倍率(0.5 沉稳 ~ 1.5 活泼) */
  liveliness: number
  /** 宠物化:给小人加猫耳 */
  catEars: boolean
}

export interface AppSettings {
  /** 空字符串 = 跟随 CLI 默认 */
  defaultModel: string
  defaultPermissionMode: PermissionModeId
  /** 新会话默认使用的 Provider ID;空字符串 = 官方 Anthropic */
  defaultProviderId: string
  /** 自动调度策略 */
  schedulerStrategy: SchedulerStrategy
  /** 厂商故障时自动切换到其他 Provider 重试(M4.1) */
  failoverEnabled: boolean
  /** 界面语言 */
  language: AppLanguage
  /** 主题:light 白天 / dark 夜晚 / system 跟随系统 */
  theme: AppTheme
  /** 人设:追加到系统提示词的自定义指令 */
  persona: string
  /** 权限:工具白名单(每行一个,空=不限制) */
  allowedTools: string
  /** 权限:工具黑名单(每行一个) */
  disallowedTools: string
  /** 3D 办公区 / 宠物设置 */
  office: OfficeSettings
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
  | { kind: 'checkpoint'; messageId: string }
  | {
      kind: 'checkpoint-restore'
      messageId: string
      filesChanged: string[]
      insertions?: number
      deletions?: number
    }
  | { kind: 'routing'; model: string; reason: string; providerId: string }
  | {
      /** 跨厂商故障切换:旧 Provider 失败,已自动切到新 Provider 重试 */
      kind: 'failover'
      fromProviderId: string
      toProviderId: string
      fromName: string
      toName: string
      /** 切换后使用的模型(目标厂商无模型列表时为空,走其默认) */
      model?: string
      reason: string
    }
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

/** 文件回退结果(对应 SDK RewindFilesResult) */
export interface RewindResult {
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
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
  suggestFiles(sessionId: string, query: string): Promise<string[]>
  rewindFiles(sessionId: string, messageId: string, dryRun: boolean): Promise<RewindResult>
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
  renameSession(sessionId: string, title: string): Promise<void>
  listHistory(): Promise<HistoryEntry[]>
  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  listProviders(): Promise<ProviderView[]>
  createProvider(provider: ProviderInput): Promise<ProviderView>
  updateProvider(id: string, patch: Partial<ProviderInput>): Promise<ProviderView>
  deleteProvider(id: string): Promise<void>
  fetchProviderModels(opts: { baseUrl: string; token?: string; providerId?: string }): Promise<string[]>
  listProviderHealth(): Promise<ProviderHealthView[]>
  listEngines(): Promise<EngineInfo[]>
  listProjects(): Promise<Project[]>
  updateProject(id: string, patch: { name?: string }): Promise<Project | null>
  deleteProject(id: string): Promise<void>
  pickDirectory(): Promise<string | null>
  onSessionEvent(cb: (sessionId: string, event: AgentEvent, seq: number) => void): () => void
}
