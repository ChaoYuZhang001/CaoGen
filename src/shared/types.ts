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

/** Agent 引擎标识:claude = Claude Agent SDK(默认);openai = OpenAI Responses API;codex / gemini 经 EngineAdapter 接入 */
export type EngineKind = 'claude' | 'openai' | 'codex' | 'gemini'

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
  /** 父会话 ID;存在时此会话是主会话派出的真实子 Agent。 */
  parentSessionId?: string
  /** 一次子代理编排批次 ID,用于聚合同一轮派活。 */
  orchestrationId?: string
  /** 子代理任务 ID;父会话下唯一。 */
  childTaskId?: string
  /** 子代理角色/分工,如 frontend/backend/test/review。 */
  childRole?: string
  /** 是否使用 CaoGen managed Git worktree 隔离运行。 */
  isolated?: boolean
  /** 用户最初选择的目录;隔离会话中 cwd 会改为 worktree 内对应目录。 */
  sourceCwd?: string
  /** 原仓库根目录。 */
  repoRoot?: string
  /** CaoGen 管理的 worktree 根目录。 */
  worktreePath?: string
  /** worktree 分支名。 */
  branch?: string
  /** 创建 worktree 时的基点分支;detached HEAD 时为空。 */
  baseBranch?: string | null
  /** 创建 worktree 时的 HEAD sha。 */
  baseSha?: string
  /** managed worktree 生命周期状态。 */
  worktreeState?: 'active' | 'removed'
  /** 空字符串表示跟随 CLI 默认模型 */
  model: string
  /** 此会话绑定的 Provider ID;空字符串 = 官方 Anthropic */
  providerId: string
  /** 本会话预算上限;0/undefined = 继承 Provider 或全局设置。 */
  budgetUsd?: number
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
  parentSessionId?: string
  orchestrationId?: string
  childTaskId?: string
  childRole?: string
  isolated?: boolean
  sourceCwd?: string
  repoRoot?: string
  worktreePath?: string
  branch?: string
  baseBranch?: string | null
  baseSha?: string
  worktreeState?: 'active' | 'removed'
  model: string
  providerId: string
  engine?: EngineKind
  permissionMode: PermissionModeId
  sdkSessionId: string
  createdAt: number
  updatedAt: number
  costUsd: number
}

export interface CreateSessionOptions {
  cwd: string
  parentSessionId?: string
  orchestrationId?: string
  childTaskId?: string
  childRole?: string
  /** undefined = Git 仓库自动隔离;false = 主工作区直接运行;true = 强制隔离。 */
  isolated?: boolean
  model?: string
  providerId?: string
  budgetUsd?: number
  /** Agent 引擎;缺省 claude */
  engine?: EngineKind
  permissionMode?: PermissionModeId
  /** 传入历史会话的 sdkSessionId 可恢复上下文 */
  resumeSdkSessionId?: string
  title?: string
}

export interface DispatchSubagentTaskInput {
  id?: string
  title?: string
  role?: string
  prompt: string
  cwd?: string
  isolated?: boolean
  model?: string
  providerId?: string
  engine?: EngineKind
  permissionMode?: PermissionModeId
}

export interface DispatchSubagentsInput {
  tasks: DispatchSubagentTaskInput[]
  cwd?: string
  isolated?: boolean
  model?: string
  providerId?: string
  engine?: EngineKind
  permissionMode?: PermissionModeId
}

export interface SubagentDispatchItem {
  taskId: string
  prompt: string
  meta: SessionMeta
}

export interface SubagentDispatchResult {
  orchestrationId: string
  parentSessionId: string
  children: SubagentDispatchItem[]
}

export interface SubagentResult {
  orchestrationId?: string
  childTaskId?: string
  childSessionId: string
  childRole?: string
  status: 'done' | 'error'
  resultText?: string
  costUsd?: number
  durationMs?: number
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

/** 项目记忆:确认制条目(agent 提议 → 用户批准)。按项目隔离 */
export interface ProjectMemoryEntry {
  id: string
  kind: string
  title: string
  body: string
  source: string
  reason: string
  createdAt: string
  updatedAt: string
}
export interface ProjectMemoryDraft extends ProjectMemoryEntry {
  status: 'draft'
}
export interface ProjectMemoryDraftInput {
  kind: string
  title: string
  body: string
  source: string
  reason: string
}
export interface ReadProjectMemoryResult {
  projectHash: string
  markdown: string
  entries: ProjectMemoryEntry[]
  drafts: ProjectMemoryDraft[]
}

export interface MemorySuggestionEvent {
  sessionId: string
  text: string
}

export type StartSuggestionPriority = 'high' | 'medium' | 'low'

export interface StartSuggestion {
  id: string
  title: string
  body: string
  source: string
  priority: StartSuggestionPriority
  prompt: string
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
  /** 单会话全局预算上限;0 = 不限制 */
  budgetUsdPerSession: number
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
  /** Provider 级预算上限;0/undefined = 继承全局设置 */
  budgetUsd?: number
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
  budgetUsd: number
  note?: string
  createdAt: number
  hasToken: boolean
}

export interface ImageAttachmentView {
  id: string
  hash: string
  path: string
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | string
  bytes: number
  createdAt: string
}

export type ImageAttachmentResult =
  | ({ ok: true } & ImageAttachmentView)
  | { ok: false; error: string }

export interface UserMessageAttachmentView {
  id: string
  mime: string
  bytes: number
}

export interface SaveImageAttachmentBytesInput {
  data: string | ArrayBuffer
  mime?: string
}

export interface SendMessagePayload {
  text: string
  images?: ImageAttachmentView[]
}

export interface ProviderInput {
  name: string
  baseUrl: string
  models: string[]
  customHeaders?: string
  budgetUsd?: number
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
  | {
      kind: 'user-message'
      text: string
      messageId?: string
      attachments?: UserMessageAttachmentView[]
    }
  | { kind: 'checkpoint'; messageId: string; userMessageId?: string }
  | {
      kind: 'checkpoint-restore'
      messageId: string
      mode?: CheckpointRestoreMode
      filesChanged: string[]
      insertions?: number
      deletions?: number
      chatRemovedEntries?: number
      note?: string
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
  | ({ kind: 'subagent-result' } & SubagentResult)

/** 文件回退结果(对应 SDK RewindFilesResult) */
export interface RewindResult {
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
}

export type CheckpointRestoreMode = 'code' | 'chat' | 'both'

export interface TranscriptRestorePlanView {
  ok: boolean
  checkpointId: string
  checkpointFound: boolean
  checkpointSeq?: number
  userSeq?: number
  userMessageId?: string
  userText?: string
  keepThroughSeq: number
  removeFromSeq?: number
  keptEntries: number
  removedEntries: number
  removedKinds: AgentEvent['kind'][]
  reason?: string
}

export interface CheckpointRestoreResult {
  mode: CheckpointRestoreMode
  checkpointId: string
  canRewind: boolean
  applied?: boolean
  code?: RewindResult
  chat?: TranscriptRestorePlanView
  transcript?: TranscriptEntry[]
  filesChanged?: string[]
  insertions?: number
  deletions?: number
  chatRemovedEntries?: number
  error?: string
  note?: string
}

export type PluginRegistryKind = 'plugin' | 'skill' | 'agent' | 'mcp'
export type PluginRegistrySourceKind = 'project' | 'user' | 'codex' | 'other'
export type PluginRegistryEnabledSource = 'manifest' | 'user'

export interface PluginRegistryItem {
  id: string
  name: string
  kind: PluginRegistryKind
  sourceKind?: PluginRegistrySourceKind
  sourceRoot: string
  path: string
  enabled: boolean
  enabledSource?: PluginRegistryEnabledSource
  enabledUpdatedAt?: string
  summary?: string
}

export interface PluginRegistryDiagnostic {
  code:
    | 'root_missing'
    | 'read_failed'
    | 'json_parse_failed'
    | 'json_shape_invalid'
    | 'max_files_reached'
  message: string
  path: string
}

export interface PluginRegistryView {
  roots: string[]
  items: PluginRegistryItem[]
  diagnostics: PluginRegistryDiagnostic[]
  limits: {
    maxFiles: number
    maxDepth: number
  }
  scannedAt: string
  truncated: boolean
}

export interface PluginRegistryScanOptions {
  maxFiles?: number
  maxDepth?: number
  maxReadBytes?: number
  includeSiblingProjectMcp?: boolean
}

export interface PluginRegistryRevealResult {
  ok: boolean
  path?: string
  error?: string
}

export interface PluginRegistrySetEnabledResult {
  ok: boolean
  item?: PluginRegistryItem
  error?: string
}

export type RoutinePermissionMode = PermissionModeId

export interface Routine extends Record<string, unknown> {
  id: string
  name: string
  prompt: string
  projectCwd: string
  schedule: string
  providerId: string
  model: string
  permissionMode: RoutinePermissionMode
  budgetUsd: number
  enabled: boolean
  createdAt: number
  updatedAt: number
  lastRunAt: number | null
  nextRunAt?: number
}

export type CreateRoutineInput = {
  id?: string
  name: string
  prompt: string
  projectCwd: string
  schedule: string
  providerId?: string
  model?: string
  permissionMode?: RoutinePermissionMode
  budgetUsd?: number
  enabled?: boolean
  createdAt?: number
  updatedAt?: number
  lastRunAt?: number | null
  nextRunAt?: number | null
} & Record<string, unknown>

export type UpdateRoutineInput = {
  name?: string
  prompt?: string
  projectCwd?: string
  schedule?: string
  providerId?: string
  model?: string
  permissionMode?: RoutinePermissionMode
  budgetUsd?: number
  enabled?: boolean
  lastRunAt?: number | null
  nextRunAt?: number | null
} & Record<string, unknown>

export interface MarkRunOptions {
  ranAt?: number
  nextRunAt?: number | null
}

export interface GitFileStatus {
  path: string
  oldPath?: string
  indexStatus: string
  worktreeStatus: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
  kind: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'unknown'
}

export interface GitStatus {
  ok: boolean
  cwd: string
  branch: string
  files: GitFileStatus[]
  staged: number
  unstaged: number
  untracked: number
  error?: string
}

export type GitOperationResult = { ok: true } | { ok: false; error: string }

export type GitCommitResult = { ok: true; sha: string } | { ok: false; error: string }

export type WorkspaceHunkResult = { ok: true } | { ok: false; error: string }

export interface WorkspaceDiffLine {
  type: 'context' | 'add' | 'delete'
  text: string
  oldLine?: number
  newLine?: number
}

export interface WorkspaceDiffHunk {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  patch?: string
  lines: WorkspaceDiffLine[]
}

export interface WorkspaceDiffFile {
  oldPath: string
  newPath: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'binary' | 'unknown'
  hunks: WorkspaceDiffHunk[]
  binary?: boolean
}

export interface WorkspaceDiff {
  ok: boolean
  cwd: string
  files: WorkspaceDiffFile[]
  rawBytes: number
  truncated?: boolean
  error?: string
}

export interface ManagedWorktreeView {
  sessionId: string
  repoRoot: string
  sourceCwd: string
  worktreePath: string
  cwd: string
  branch: string
  baseSha: string
  baseBranch: string | null
  state: 'active' | 'removed'
  createdAt: number
  updatedAt: number
}

export interface WorktreeSummary {
  ok: boolean
  isolated: boolean
  record?: ManagedWorktreeView
  changedFiles: number
  insertions?: number
  deletions?: number
  dirty: boolean
  error?: string
}

export type WorktreeConflictRisk = 'low' | 'medium' | 'unknown'

export type WorktreeMergeSummary =
  | {
      ok: true
      repoRoot: string
      worktreePath: string
      baseSha: string
      headSha: string
      changedFiles: number
      insertions: number
      deletions: number
      conflictRisk: WorktreeConflictRisk
    }
  | { ok: false; error: string }

export type WorktreePatchResult =
  | {
      ok: true
      repoRoot?: string
      worktreePath?: string
      baseSha?: string
      headSha?: string
      path?: string
      patchText?: string
      bytes?: number
    }
  | { ok: false; error: string }

export type WorktreeApplyCheckResult =
  | { ok: true; canApply: true }
  | { ok: true; canApply: false; error: string }
  | { ok: false; error: string }

export type WorktreeApplyResult =
  | {
      ok: true
      repoRoot: string
      worktreePath?: string
      baseSha?: string
      headSha?: string
      path?: string
      bytes: number
      changedFiles: number
      applied: boolean
    }
  | { ok: false; error: string }

export interface WorktreeRemoveResult {
  ok: boolean
  record?: ManagedWorktreeView
  error?: string
}

export type ProjectFileKind = 'file' | 'directory'

export interface ProjectFileEntry {
  path: string
  name: string
  kind: ProjectFileKind
  size?: number
  mtimeMs: number
}

export interface ListProjectFilesResult {
  ok: boolean
  root?: string
  entries: ProjectFileEntry[]
  truncated?: boolean
  error?: string
}

export interface ReadTextFileResult {
  ok: boolean
  path?: string
  content?: string
  bytes?: number
  mtimeMs?: number
  error?: string
}

export interface WriteTextFileResult {
  ok: boolean
  path?: string
  bytes?: number
  mtimeMs?: number
  error?: string
}

export type PreviewType = 'html' | 'markdown' | 'text' | 'csv' | 'json' | 'image' | 'pdf' | 'unknown'
export type PreviewMode = 'text' | 'asset' | 'unsupported'

export interface PreparedPreview {
  ok: boolean
  path?: string
  type?: PreviewType
  mode?: PreviewMode
  mime?: string
  bytes?: number
  mtimeMs?: number
  content?: string
  dataUrl?: string
  error?: string
}

export type TerminalBackend = 'pty' | 'pipe'

export interface TerminalExitInfo {
  exitCode: number | null
  signal?: number | string
  reason?: string
  at: number
}

export interface TerminalInfo {
  id: string
  sessionId?: string
  cwd: string
  shell: string
  pid?: number
  backend: TerminalBackend
  cols: number
  rows: number
  startedAt: number
  fallbackReason?: string
  exit?: TerminalExitInfo
}

export type TerminalEvent =
  | { kind: 'started'; terminal: TerminalInfo }
  | { kind: 'output'; id: string; data: string }
  | { kind: 'exit'; id: string; exit: TerminalExitInfo }
  | { kind: 'error'; id?: string; message: string; fatal: boolean }

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserAnnotationBoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserAnnotationViewport {
  width: number
  height: number
  deviceScaleFactor?: number
}

export interface BrowserAnnotation {
  id: string
  sessionId: string
  url: string
  title?: string
  selector?: string
  boundingBox?: BrowserAnnotationBoundingBox
  screenshotPath?: string
  note: string
  consoleErrors: string[]
  viewport?: BrowserAnnotationViewport
  createdAt: string
}

export interface BrowserViewState {
  sessionId: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export type BrowserEvent =
  | { kind: 'state'; sessionId: string; state: BrowserViewState }
  | { kind: 'annotation'; sessionId: string; annotation: BrowserAnnotation }
  | { kind: 'closed'; sessionId: string }
  | { kind: 'error'; sessionId?: string; message: string }

/** D11 迁移向导:检测到的他家 Agent 资产 */
export interface MigrationAsset {
  /** 来源 Agent 名(Cursor / Codex / Cline …) */
  agent: string
  /** rules = 规则/记忆文件;mcp = MCP 配置;config = 其他配置 */
  kind: 'rules' | 'mcp' | 'config'
  path: string
  name: string
  preview: string
}

export interface MigrationScan {
  cwd: string
  assets: MigrationAsset[]
  /** 本机/本项目已有 Claude Code 原生资产(CaoGen 直接继承,无需导入) */
  claudeNative: boolean
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
  restoreCheckpoint(
    sessionId: string,
    messageId: string,
    mode: CheckpointRestoreMode,
    dryRun: boolean
  ): Promise<CheckpointRestoreResult>
  createSession(opts: CreateSessionOptions): Promise<SessionMeta>
  dispatchSubagents(
    parentSessionId: string,
    input: DispatchSubagentsInput
  ): Promise<SubagentDispatchResult>
  copyImageAttachment(sessionId: string, sourcePath: string): Promise<ImageAttachmentResult>
  saveImageAttachmentBytes(
    sessionId: string,
    input: SaveImageAttachmentBytesInput
  ): Promise<ImageAttachmentResult>
  sendMessage(sessionId: string, payload: string | SendMessagePayload): Promise<void>
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
  scanPluginRegistry(
    sessionId?: string,
    options?: PluginRegistryScanOptions
  ): Promise<PluginRegistryView>
  revealPluginRegistryItem(path: string, sessionId?: string): Promise<PluginRegistryRevealResult>
  setPluginRegistryItemEnabled(
    item: PluginRegistryItem,
    enabled: boolean,
    sessionId?: string
  ): Promise<PluginRegistrySetEnabledResult>
  listRoutines(): Promise<Routine[]>
  createRoutine(input: CreateRoutineInput): Promise<Routine>
  deleteRoutine(id: string): Promise<boolean>
  updateRoutine(id: string, patch: UpdateRoutineInput): Promise<Routine | null>
  markRoutineRun(id: string, options?: MarkRunOptions): Promise<Routine | null>
  getStartSuggestions(sessionId: string): Promise<StartSuggestion[]>
  gitStatus(sessionId: string): Promise<GitStatus>
  stageFiles(sessionId: string, paths: string[]): Promise<GitOperationResult>
  stageAll(sessionId: string): Promise<GitOperationResult>
  unstageFiles(sessionId: string, paths: string[]): Promise<GitOperationResult>
  gitCommit(sessionId: string, message: string): Promise<GitCommitResult>
  getWorkspaceDiff(sessionId: string): Promise<WorkspaceDiff>
  applyWorkspaceHunk(sessionId: string, filePath: string, hunkPatch: string): Promise<WorkspaceHunkResult>
  discardWorkspaceHunk(sessionId: string, filePath: string, hunkPatch: string): Promise<WorkspaceHunkResult>
  getWorktreeSummary(sessionId: string): Promise<WorktreeSummary>
  exportWorktreePatch(sessionId: string): Promise<WorktreePatchResult>
  inspectWorktreeMerge(sessionId: string): Promise<WorktreeMergeSummary>
  createWorktreeMergePatch(sessionId: string): Promise<WorktreePatchResult>
  checkWorktreeApply(sessionId: string): Promise<WorktreeApplyCheckResult>
  applyWorktreePatch(sessionId: string): Promise<WorktreeApplyResult>
  removeWorktree(
    sessionId: string,
    opts?: { deleteBranch?: boolean; force?: boolean }
  ): Promise<WorktreeRemoveResult>
  listProjectFiles(sessionId: string): Promise<ListProjectFilesResult>
  readTextFile(sessionId: string, path: string): Promise<ReadTextFileResult>
  writeTextFile(sessionId: string, path: string, content: string): Promise<WriteTextFileResult>
  preparePreview(sessionId: string, path: string): Promise<PreparedPreview>
  openBrowser(sessionId: string, url?: string): Promise<BrowserViewState>
  navigateBrowser(sessionId: string, url: string): Promise<BrowserViewState>
  setBrowserBounds(sessionId: string, bounds: BrowserBounds): Promise<void>
  browserGoBack(sessionId: string): Promise<BrowserViewState>
  browserGoForward(sessionId: string): Promise<BrowserViewState>
  reloadBrowser(sessionId: string): Promise<BrowserViewState>
  closeBrowser(sessionId: string): Promise<void>
  captureBrowserAnnotation(sessionId: string, note: string): Promise<BrowserAnnotation>
  listBrowserAnnotations(sessionId: string): Promise<BrowserAnnotation[]>
  onBrowserEvent(cb: (event: BrowserEvent) => void): () => void
  listTerminals(): Promise<TerminalInfo[]>
  startTerminal(sessionId: string, opts?: { cols?: number; rows?: number; reuse?: boolean }): Promise<TerminalInfo>
  writeTerminal(id: string, data: string): Promise<void>
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>
  closeTerminal(id: string): Promise<void>
  onTerminalEvent(cb: (event: TerminalEvent) => void): () => void
  scanMigration(cwd: string): Promise<MigrationScan>
  importMigrationAssets(cwd: string, paths: string[]): Promise<string>
  listProjects(): Promise<Project[]>
  updateProject(id: string, patch: { name?: string }): Promise<Project | null>
  deleteProject(id: string): Promise<void>
  readProjectMemory(sessionId: string): Promise<ReadProjectMemoryResult>
  proposeMemoryDraft(sessionId: string, input: ProjectMemoryDraftInput): Promise<ProjectMemoryDraft>
  acceptMemoryDraft(sessionId: string, draftId: string): Promise<ProjectMemoryEntry>
  deleteMemoryEntry(sessionId: string, entryId: string): Promise<{ id: string; deleted: boolean; deletedFrom: Array<'confirmed' | 'drafts'> }>
  pickDirectory(): Promise<string | null>
  onSessionEvent(cb: (sessionId: string, event: AgentEvent, seq: number) => void): () => void
  onMemorySuggestion(cb: (event: MemorySuggestionEvent) => void): () => void
}
