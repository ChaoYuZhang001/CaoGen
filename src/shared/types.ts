/**
 * 主进程 / 预加载 / 渲染进程共享的类型定义。
 * 仅包含类型(编译期擦除),两侧 tsconfig 都会引入本目录。
 */

export type PermissionModeId = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

export type SandboxMode = 'strictDocker' | 'standardSystem' | 'loose'

export type ToolRiskLevel = 'low' | 'medium' | 'high' | 'critical'

export type SchedulerStrategy = 'quality' | 'cost' | 'balanced'

export type CaoGenDriveMode = 'spark' | 'core' | 'forge' | 'command' | 'genesis'

export type CaoGenDriveValidationDepth = 'light' | 'basic' | 'local' | 'guarded' | 'closedLoop'

export interface CaoGenDrivePolicyView {
  mode: CaoGenDriveMode
  label: string
  zhLabel: string
  summary: string
  schedulerStrategy: SchedulerStrategy
  defaultModel: string
  defaultPermissionMode: PermissionModeId
  sessionBudgetUsd: number
  validationDepth: CaoGenDriveValidationDepth
  smartModelRoutingEnabled: boolean
  modelCrossValidationAutoRunEnabled: boolean
  toolPolicySummary: string
}

export interface ModelRoutePlanView {
  enabled: boolean
  primary: { providerId: string; providerName?: string; model: string }
  validators: Array<{ providerId: string; providerName?: string; model: string }>
  policy: 'compare-answer' | 'review-primary' | 'skip'
  reason: string
}

/** 会话 model 字段取此哨兵值 = 启用智能自动调度 */
export const AUTO_MODEL = 'auto'
export const DEEPSEEK_PROVIDER_ID = 'deepseek-official'
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-chat'

export const CAOGEN_DRIVE_POLICIES: readonly CaoGenDrivePolicyView[] = [
  {
    mode: 'spark',
    label: 'Spark',
    zhLabel: '星火',
    summary: '快速模型、低推理、少工具、轻验证',
    schedulerStrategy: 'cost',
    defaultModel: AUTO_MODEL,
    defaultPermissionMode: 'default',
    sessionBudgetUsd: 0.05,
    validationDepth: 'light',
    smartModelRoutingEnabled: true,
    modelCrossValidationAutoRunEnabled: false,
    toolPolicySummary: '低风险工具优先，阻止高风险、GUI、DAG 和发布类动作'
  },
  {
    mode: 'core',
    label: 'Core',
    zhLabel: '中枢',
    summary: '默认日用，均衡模型、常规工具、基础验证',
    schedulerStrategy: 'balanced',
    defaultModel: AUTO_MODEL,
    defaultPermissionMode: 'default',
    sessionBudgetUsd: 0.25,
    validationDepth: 'basic',
    smartModelRoutingEnabled: true,
    modelCrossValidationAutoRunEnabled: false,
    toolPolicySummary: '常规读写按权限模式执行，阻止 critical 风险与 Genesis 编排动作'
  },
  {
    mode: 'forge',
    label: 'Forge',
    zhLabel: '熔铸',
    summary: '多文件工程、强推理、局部测试、diff/review',
    schedulerStrategy: 'quality',
    defaultModel: AUTO_MODEL,
    defaultPermissionMode: 'acceptEdits',
    sessionBudgetUsd: 1.5,
    validationDepth: 'local',
    smartModelRoutingEnabled: true,
    modelCrossValidationAutoRunEnabled: false,
    toolPolicySummary: '自动接受编辑，命令和高风险动作仍走审批；Genesis 编排需升级到 Command/Genesis'
  },
  {
    mode: 'command',
    label: 'Command',
    zhLabel: '指挥',
    summary: '高风险任务、强模型、GUI/IDE/Git/权限强管控',
    schedulerStrategy: 'quality',
    defaultModel: AUTO_MODEL,
    defaultPermissionMode: 'default',
    sessionBudgetUsd: 5,
    validationDepth: 'guarded',
    smartModelRoutingEnabled: true,
    modelCrossValidationAutoRunEnabled: true,
    toolPolicySummary: '强模型与自动复核，GUI 可逐次审批，critical 风险仍阻止'
  },
  {
    mode: 'genesis',
    label: 'Genesis',
    zhLabel: '创生',
    summary: '多 Agent、DAG、worktree、交叉复核、自动验证、交付闭环',
    schedulerStrategy: 'quality',
    defaultModel: AUTO_MODEL,
    defaultPermissionMode: 'acceptEdits',
    sessionBudgetUsd: 12,
    validationDepth: 'closedLoop',
    smartModelRoutingEnabled: true,
    modelCrossValidationAutoRunEnabled: true,
    toolPolicySummary: '允许多 Agent/DAG 底座，编辑自动化，命令、GUI 和发布动作保留审批'
  }
]

export function normalizeCaoGenDriveMode(value: unknown): CaoGenDriveMode {
  return CAOGEN_DRIVE_POLICIES.some((policy) => policy.mode === value)
    ? (value as CaoGenDriveMode)
    : 'core'
}

export function caogenDrivePolicyView(mode: unknown): CaoGenDrivePolicyView {
  const normalized = normalizeCaoGenDriveMode(mode)
  return CAOGEN_DRIVE_POLICIES.find((policy) => policy.mode === normalized) ?? CAOGEN_DRIVE_POLICIES[1]
}

export interface ProviderHealthView {
  /** Provider id;历史健康记录里可能出现 official,但新会话不再使用空 Provider 默认。 */
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

/** Agent 引擎标识:claude = Claude Agent SDK;openai = OpenAI Responses API;codex / gemini 经 EngineAdapter 接入 */
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

export type ContextPressureLevel = 'normal' | 'warning' | 'critical'

export interface SessionMeta {
  id: string
  title: string
  cwd: string
  /** CaoGen Drive 档位:控制默认模型路由、预算、验证深度和工具权限策略。 */
  driveMode?: CaoGenDriveMode
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
  /** 此会话绑定的 Provider ID;Claude/OpenAI 新会话必须显式选择。CLI 引擎可为空。 */
  providerId: string
  /** 本会话预算上限;0/undefined = 继承 Provider 或全局设置。 */
  budgetUsd?: number
  /** 下次 resume SDK 会话时截断到此用户消息/检查点。 */
  resumeSessionAt?: string
  /** Agent 引擎;新会话必须显式选择。 */
  engine?: EngineKind
  permissionMode: PermissionModeId
  status: SessionStatus
  sdkSessionId?: string
  costUsd: number
  usage: UsageTotals
  contextTokens: number
  contextWindowTokens?: number
  contextRemainingTokens?: number
  contextUsageRatio?: number
  contextPressure?: ContextPressureLevel
  createdAt: number
  lastError?: string
}

export interface HistoryEntry {
  id: string
  title: string
  cwd: string
  driveMode?: CaoGenDriveMode
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
  resumeSessionAt?: string
  /** 归档:从主列表收起到归档区(不删) */
  archived?: boolean
  /** 置顶:排在最前 */
  pinned?: boolean
}

export interface CreateSessionOptions {
  cwd: string
  driveMode?: CaoGenDriveMode
  parentSessionId?: string
  orchestrationId?: string
  childTaskId?: string
  childRole?: string
  /** undefined = Git 仓库自动隔离;false = 主工作区直接运行;true = 强制隔离。 */
  isolated?: boolean
  model?: string
  providerId?: string
  budgetUsd?: number
  resumeSessionAt?: string
  /** Agent 引擎;新会话必须显式传入。 */
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
  driveMode?: CaoGenDriveMode
  model?: string
  providerId?: string
  engine?: EngineKind
  permissionMode?: PermissionModeId
}

export interface DispatchSubagentsInput {
  tasks: DispatchSubagentTaskInput[]
  cwd?: string
  isolated?: boolean
  driveMode?: CaoGenDriveMode
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

export type TaskDagRole = 'frontend' | 'backend' | 'qa' | 'docs' | 'devops' | 'review' | 'general'

export type TaskDagComplexity = 'single' | 'multi'

export interface TaskDagTask {
  id: string
  title: string
  description: string
  dependencies: string[]
  role: TaskDagRole
  prompt: string
}

export interface TaskDag {
  id: string
  title: string
  source: string
  complexity: TaskDagComplexity
  createdAt: number
  tasks: TaskDagTask[]
}

export interface TaskDecomposeInput {
  request: string
  cwd?: string
  /** 强推理模型拆解开关;false 时只使用本地启发式拆解。 */
  useModel?: boolean
  /** 可选:覆盖用于 DAG 拆解的 Provider。 */
  providerId?: string
  /** 可选:覆盖用于 DAG 拆解的模型。 */
  model?: string
}

export interface TaskDecomposeResult {
  dag: TaskDag
  strategy: 'local-heuristic' | 'model'
  reason: string
  warnings: string[]
}

export type TaskDagTaskStatus = 'waiting' | 'running' | 'success' | 'failed'
export type TaskDagExecutionStatus = 'waiting' | 'running' | 'success' | 'failed'

export interface TaskDagExecutionTask {
  task: TaskDagTask
  status: TaskDagTaskStatus
  attempts: number
  sessionIds: string[]
  startedAt?: number
  completedAt?: number
  resultText?: string
  error?: string
}

export interface TaskDagExecutionView {
  id: string
  parentSessionId: string
  dag: TaskDag
  status: TaskDagExecutionStatus
  maxRetries: number
  startedAt: number
  completedAt?: number
  layers: string[][]
  tasks: TaskDagExecutionTask[]
  summary?: string
  error?: string
  autoMerge?: TaskDagAutoMergeView
}

export interface TaskDagRuntimeDispatchOptions {
  cwd?: string
  isolated?: boolean
  driveMode?: CaoGenDriveMode
  model?: string
  providerId?: string
  engine?: EngineKind
  permissionMode?: PermissionModeId
  taskTimeoutMs: number
}

export interface TaskDagRuntimeRunningTask {
  taskId: string
  sessionId: string
}

export interface TaskDagRuntimeAutoMergeOptions {
  enabled: boolean
  verificationCommand?: string
}

export interface TaskDagRuntimeMergeSession {
  sessionId: string
  taskId?: string
  repoRoot?: string
  worktreePath?: string
  baseSha?: string
  branch?: string
  resultText?: string
}

export interface TaskDagRuntimeSnapshot {
  executionId: string
  parentSessionId: string
  capturedAt: number
  dispatchOptions: TaskDagRuntimeDispatchOptions
  runningTasks: TaskDagRuntimeRunningTask[]
  mergeSessions?: TaskDagRuntimeMergeSession[]
  autoMerge?: TaskDagRuntimeAutoMergeOptions
}

export interface TaskDagDispatchInput {
  dag: TaskDag
  cwd?: string
  isolated?: boolean
  driveMode?: CaoGenDriveMode
  model?: string
  providerId?: string
  engine?: EngineKind
  permissionMode?: PermissionModeId
  maxRetries?: number
  /** Per-child timeout in milliseconds. Omit for the default watchdog; <=0 disables it. */
  taskTimeoutMs?: number
  /** 自动合并默认关闭；显式开启后才会把成功子任务 worktree 合回主工作区。 */
  autoMerge?: boolean
  /** 覆盖 caogen.md 中的验收命令，主要用于测试和临时调度。 */
  verificationCommand?: string
}

export interface TaskDagDispatchResult {
  execution: TaskDagExecutionView
  /** 当前调度调用已经启动的 child sessions;后续依赖层通过 task-dag-update 同步。 */
  children: SubagentDispatchItem[]
}

export type TaskDagAutoMergeStatus = 'running' | 'success' | 'partial' | 'failed' | 'rolled-back'
export type TaskDagAutoMergeEntryStatus =
  | 'merged'
  | 'skipped'
  | 'blocked'
  | 'failed'
  | 'rolled-back'
export type TaskDagAutoMergeVerificationStatus = 'passed' | 'failed' | 'skipped' | 'not-run'

export interface TaskDagAutoMergeVerification {
  status: TaskDagAutoMergeVerificationStatus
  command?: string
  cwd?: string
  exitCode?: number | null
  durationMs?: number
  output?: string
  error?: string
}

export interface TaskDagAutoMergeConflict {
  path: string
  base: string
  worktree: string
  main: string
  baseMissing?: boolean
  worktreeMissing?: boolean
  mainMissing?: boolean
  truncated?: boolean
}

export interface TaskDagAutoMergeEntry {
  taskId: string
  sessionId?: string
  branch?: string
  worktreePath?: string
  status: TaskDagAutoMergeEntryStatus
  changedFiles?: number
  insertions?: number
  deletions?: number
  conflictRisk?: WorktreeConflictRisk
  patchSha256?: string
  patchPath?: string
  commitSha?: string
  error?: string
  conflicts?: TaskDagAutoMergeConflict[]
  resolverPrompt?: string
}

export interface TaskDagAutoMergeRollback {
  attempted: boolean
  ok: boolean
  error?: string
}

export interface TaskDagAutoMergeView {
  enabled: true
  status: TaskDagAutoMergeStatus
  startedAt: number
  completedAt?: number
  repoRoot?: string
  entries: TaskDagAutoMergeEntry[]
  mergedCount: number
  blockedCount: number
  skippedCount: number
  verification?: TaskDagAutoMergeVerification
  rollback?: TaskDagAutoMergeRollback
  summary?: string
  error?: string
}

export interface SdkAgentInfo {
  name: string
  description: string
  model?: string
}

export type TaskSnapshotReason =
  | 'created'
  | 'important-event'
  | 'event-batch'
  | 'shutdown'
  | 'recovered'

export interface TaskSnapshotWorktreeInfo {
  isolated?: boolean
  sourceCwd?: string
  repoRoot?: string
  worktreePath?: string
  branch?: string
  baseBranch?: string | null
  baseSha?: string
  state?: 'active' | 'removed'
}

export interface TaskSnapshotExecutionPosition {
  status: SessionStatus
  lastSeq: number
  lastEventKind?: AgentEvent['kind']
  lastEventAt: number
  sdkSessionId?: string
  resumeSessionAt?: string
  lastCheckpointMessageId?: string
  lastUserMessageId?: string
}

export interface TaskSnapshotReplayCandidate {
  messageId: string
  text: string
  seq: number
  capturedAt: number
  reason: 'running-user-message'
}

export type TaskSnapshotSubtaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'closed'

export interface TaskSnapshotSubtaskState {
  taskId?: string
  role?: string
  sessionId: string
  status: TaskSnapshotSubtaskStatus
  resultText?: string
  costUsd?: number
  branch?: string
  worktreePath?: string
}

export interface TaskSnapshotRecord {
  id: string
  taskId: string
  sessionId: string
  title: string
  projectPath: string
  engine?: EngineKind
  model: string
  providerId: string
  createdAt: number
  updatedAt: number
  eventCount: number
  reason: TaskSnapshotReason
  meta: SessionMeta
  execution: TaskSnapshotExecutionPosition
  replayCandidate?: TaskSnapshotReplayCandidate
  worktree?: TaskSnapshotWorktreeInfo
  transcript: TranscriptEntry[]
  subtasks: TaskSnapshotSubtaskState[]
  dagExecutions: TaskDagExecutionView[]
  dagRuntimes?: TaskDagRuntimeSnapshot[]
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

export type ProjectContextFileName = 'caogen.md' | '.caogen.md' | 'README.md'

export interface ProjectContextSource {
  fileName: ProjectContextFileName
  path: string
  bytes: number
  truncated: boolean
}

export interface ProjectDetectedStack {
  packageName?: string
  packageManager?: string
  nodeScripts: Array<{ name: string; command: string }>
  dependencies: Array<{ name: string; version: string; scope: 'runtime' | 'dev' }>
  techStack: string[]
  python?: { projectName?: string; dependencies: string[] }
  go?: { module?: string; version?: string; requirements: string[] }
  rust?: { packageName?: string; dependencies: string[] }
}

export interface ProjectContextReadResult {
  projectRoot: string
  source?: ProjectContextSource
  content: string
  detected: ProjectDetectedStack
  template: string
  prompt: string
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

export type MemoryLayer = 'working' | 'project' | 'user'

export interface LayeredMemoryEntry {
  id: string
  layer: MemoryLayer
  projectHash?: string
  title: string
  body: string
  source: string
  tags: string[]
  createdAt: string
  updatedAt: string
  lastUsedAt: string
  archivedAt?: string
  vector: Record<string, number>
}

export interface LayeredMemoryWriteInput {
  layer: MemoryLayer
  projectRoot?: string
  title: string
  body: string
  source: string
  tags?: string[]
}

export interface LayeredMemoryUpdateInput {
  title?: string
  body?: string
  tags?: string[]
  archivedAt?: string | null
}

export interface LayeredMemorySearchInput {
  query: string
  projectRoot?: string
  layers?: MemoryLayer[]
  includeArchived?: boolean
  limit?: number
}

export interface LayeredMemorySearchHit {
  entry: LayeredMemoryEntry
  score: number
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
  /** 控制室动效强度倍率(0.2 静态 ~ 1.2 活跃) */
  liveliness: number
  /** 趣味外观:给小人加猫耳 */
  catEars: boolean
}

export type ChatDensity = 'comfortable' | 'compact'

export interface LayoutSettings {
  /** 桌面侧栏是否收回;窄屏仍走抽屉模式。 */
  sidebarCollapsed: boolean
  /** 桌面侧栏宽度(px)。 */
  sidebarWidth: number
  /** 工作台右侧工具面板宽度(px)。 */
  workbenchSideWidth: number
  /** 聊天内容缩放倍率。 */
  chatScale: number
  /** 聊天内容密度。 */
  chatDensity: ChatDensity
}

export interface AppSettings {
  /** CaoGen Drive 默认档位;新会话默认继承此档位。 */
  driveMode: CaoGenDriveMode
  /** 空字符串 = 跟随 CLI 默认 */
  defaultModel: string
  defaultPermissionMode: PermissionModeId
  /** 新会话默认使用的 Provider ID;空字符串 = 不设置默认,创建时必须显式选择。 */
  defaultProviderId: string
  /** 自动调度策略 */
  schedulerStrategy: SchedulerStrategy
  /** 多模型智能混合调度: 默认关闭, 开启后 auto 会话按任务/预算/覆盖路由 */
  smartModelRoutingEnabled: boolean
  /** P2-003 自动交叉验证执行开关；默认关闭，仅在智能调度生成复核计划后派发第二模型 */
  modelCrossValidationAutoRunEnabled: boolean
  /** 单会话全局预算上限;0 = 不限制 */
  budgetUsdPerSession: number
  /** 月度总预算上限;0 = 不限制,用于 P2-003 成本管控和自动降级 */
  budgetUsdPerMonth: number
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
  /** 沙箱模式:strictDocker 优先 Docker,standardSystem 使用系统 shell,loose 保持最宽松兼容 */
  sandboxMode: SandboxMode
  /** Docker 沙箱镜像;strictDocker 模式使用,为空时使用内置默认镜像 */
  sandboxDockerImage: string
  /** 国产生态镜像:默认关闭;开启后才向沙箱命令注入 npm/pip/docker 镜像配置 */
  chinaEcosystemMirrorEnabled: boolean
  /** 国产生态镜像:npm registry,仅 chinaEcosystemMirrorEnabled=true 时生效 */
  chinaNpmRegistry: string
  /** 国产生态镜像:pip index-url,仅 chinaEcosystemMirrorEnabled=true 时生效 */
  chinaPipIndexUrl: string
  /** 国产生态镜像:Docker registry 前缀,仅 chinaEcosystemMirrorEnabled=true 时生效 */
  chinaDockerRegistryMirror: string
  /** 权限白名单规则:支持 tool/path/risk 组合;空表示不额外放行 */
  permissionAllowlist: string
  /** 权限黑名单规则:支持 tool/path/risk 组合;空表示不额外拒绝 */
  permissionDenylist: string
  /** 临时允许规则:同白名单,可追加 until=<ms 时间戳> */
  permissionTemporaryAllowlist: string
  /** 权限:GUI 自动化总开关;默认关闭,避免 Agent 直接操作真实桌面。 */
  guiAutomationEnabled: boolean
  /** 权限:GUI 自动化临时授权过期时间戳(ms);0 = 无临时授权。 */
  guiAutomationTemporaryGrantUntil: number
  /** 桌面通知:关闭后任务完成/权限/失败均不弹系统通知 */
  notificationsEnabled: boolean
  /** 会话运行时阻止显示器休眠(prevent-display-sleep) */
  preventDisplaySleep: boolean
  /** Claude SDK agents 桥接:默认关闭,避免老会话系统提示词/Agent 工具上下文变化 */
  sdkAgentsEnabled: boolean
  /** IDE Bridge:默认关闭,开启后 VS Code/JetBrains 插件可通过本机 WebSocket 连接桌面端。 */
  ideBridgeEnabled: boolean
  /** IDE Bridge 监听地址,默认仅本机。 */
  ideBridgeHost: string
  /** IDE Bridge 监听端口,默认 17365。 */
  ideBridgePort: number
  /** IDE Bridge 可选 token,为空表示本机连接无需 token。 */
  ideBridgeToken: string
  /**
   * Hooks:文件写入类工具(Edit/Write)成功后执行的 shell 命令,
   * 在会话 cwd 下运行,空 = 关闭。典型用法:自动格式化/测试。
   */
  hookPostEditCommand: string
  /** Hooks:每轮结束(Stop)后执行的 shell 命令,空 = 关闭 */
  hookTurnEndCommand: string
  /** 自动 Skill 沉淀:任务成功完成后后台复盘、验证并写入项目本地 Skill 库。默认关闭。 */
  autoSkillLearningEnabled: boolean
  /** Agent 控制室外观设置 */
  office: OfficeSettings
  /** 工作台布局、缩放和可调节面板设置 */
  layout: LayoutSettings
}

export interface Provider {
  id: string
  name: string
  /** 空字符串 = 该 Provider 使用引擎/本机默认端点;不会作为新会话隐式默认。 */
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
  /**
   * OpenAI 引擎协议:'responses'(OpenAI 官方 Responses API,默认)或
   * 'chat'(通用 /v1/chat/completions,DeepSeek/Qwen/网关/自部署 vLLM 等)。
   * 仅 openai 引擎读取;Claude 引擎忽略。
   */
  openaiProtocol?: OpenAIProtocol
  /** 用户备注 */
  note?: string
  createdAt: number
}

/** OpenAI 引擎可用的 API 协议 */
export type OpenAIProtocol = 'responses' | 'chat'

/** 渲染进程可见的 Provider:不含密钥,只标记是否已配置 token */
export interface ProviderView {
  id: string
  name: string
  baseUrl: string
  models: string[]
  customHeaders?: string
  budgetUsd: number
  openaiProtocol?: OpenAIProtocol
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

/** OCR 结果(引擎:macOS Vision 或 tesseract) */
export interface ImageOcrResult {
  ok: boolean
  text?: string
  engine?: 'vision' | 'tesseract'
  error?: string
}

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

export type QuickbarTargetMode = 'current' | 'new'
export type QuickbarEventSource = 'global-shortcut' | 'renderer' | 'menu'

export interface QuickbarState {
  visible: boolean
  accelerator: string
  registered: boolean
  registrationError?: string
}

export interface QuickbarEvent {
  kind: 'visibility'
  visible: boolean
  source: QuickbarEventSource
}

export interface QuickbarWindowContext {
  id: string
  name: string
  kind: 'screen' | 'window'
  title?: string
  processName?: string
  pid?: number
  platform?: string
  minimized?: boolean
}

export interface QuickbarContextResult {
  ok: boolean
  cwd: string
  capturedAt: number
  current?: QuickbarWindowContext
  windows: QuickbarWindowContext[]
  error?: string
}

export interface QuickbarClipboardInput {
  cwd?: string
  note?: string
  includeWindowContext?: boolean
}

export interface QuickbarScreenshotInput {
  sessionId: string
  cwd?: string
  sourceId?: string
  note?: string
  maxWidth?: number
  includeWindowContext?: boolean
}

export interface QuickbarFileInput {
  cwd?: string
  paths: string[]
  note?: string
  includeWindowContext?: boolean
}

export interface QuickbarPayloadResult {
  ok: boolean
  payload?: SendMessagePayload
  context?: QuickbarContextResult
  screenshotPath?: string
  files?: Array<{
    path: string
    kind: 'file' | 'directory' | 'other'
    exists: boolean
    bytes?: number
    error?: string
  }>
  error?: string
}

export interface QuickbarDispatchOptions {
  target: QuickbarTargetMode
  cwd?: string
  sourceId?: string
  paths?: string[]
  note?: string
}

export interface QuickbarDispatchResult {
  ok: boolean
  sessionId?: string
  error?: string
}

export interface ProviderInput {
  name: string
  baseUrl: string
  models: string[]
  customHeaders?: string
  budgetUsd?: number
  openaiProtocol?: OpenAIProtocol
  note?: string
  /** 明文 token,经 IPC 传入主进程后加密落盘 */
  token: string
}

export type ProviderModelErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'server'
  | 'network'
  | 'gateway'
  | 'not_found'
  | 'unknown'

export interface ProviderModelFetchInput {
  baseUrl: string
  token?: string
  providerId?: string
  openaiProtocol?: OpenAIProtocol
}

export interface ProviderModelFetchError {
  kind: ProviderModelErrorKind
  message: string
  status?: number
  providerId?: string
  baseUrl: string
}

export interface ProviderModelFetchResult {
  ok: boolean
  providerId?: string
  baseUrl: string
  cacheKey: string
  models: string[]
  fetchedAt?: number
  stale: boolean
  error?: ProviderModelFetchError
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
  | {
      kind: 'routing'
      model: string
      reason: string
      providerId: string
      crossValidationPlan?: ModelRoutePlanView
    }
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
  | { kind: 'task-dag-update'; execution: TaskDagExecutionView }
  | {
      /** SDK Hook 事件桥:把引擎生命周期钩子转发到时间线(可观测性) */
      kind: 'hook-event'
      event: string
      toolName?: string
      detail?: string
      /** 用户 shell 钩子执行结果(配置了才有) */
      shellCommand?: string
      shellOk?: boolean
      shellOutput?: string
    }

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
  /** manifest / frontmatter 声明的版本;未声明为空 */
  version?: string
  /** manifest 声明的权限/能力清单(mcp 为环境变量名);仅声明,未经运行时验证 */
  permissions?: string[]
  /** 位于 ~/.claude/plugins 下(CaoGen 托管,可卸载) */
  managed?: boolean
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
  /** CaoGen 托管插件根;位于其下的条目标记 managed 可卸载 */
  managedRoot?: string
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

/** 本地插件安装结果 */
export interface PluginInstallResult {
  ok: boolean
  installedPath?: string
  name?: string
  error?: string
}

/** 插件卸载结果(回收站式) */
export interface PluginUninstallResult {
  ok: boolean
  trashedTo?: string
  error?: string
}

/** MCP 运行态探测结果(stdio initialize 握手 / http 可达) */
export interface McpProbeResult {
  id: string
  ok: boolean
  transport: 'stdio' | 'http' | 'unknown'
  serverName?: string
  serverVersion?: string
  latencyMs?: number
  error?: string
}

export type RoutinePermissionMode = PermissionModeId

export interface RoutineNotificationOptions {
  /** 是否为该 Routine 发送桌面通知 */
  enabled: boolean
  /** 执行成功后通知 */
  onSuccess: boolean
  /** 执行失败后通知 */
  onFailure: boolean
}

export interface Routine extends Record<string, unknown> {
  id: string
  name: string
  prompt: string
  content?: string
  projectCwd: string
  schedule: string
  frequency?: string
  providerId: string
  model: string
  engine?: EngineKind
  permissionMode: RoutinePermissionMode
  budgetUsd: number
  notification: RoutineNotificationOptions
  enabled: boolean
  createdAt: number
  updatedAt: number
  lastRunAt: number | null
  nextRunAt?: number
}

export type CreateRoutineInput = {
  id?: string
  name: string
  prompt?: string
  content?: string
  projectCwd: string
  schedule?: string
  frequency?: string
  providerId?: string
  model?: string
  engine?: EngineKind
  permissionMode?: RoutinePermissionMode
  budgetUsd?: number
  notification?: RoutineNotificationOptions
  enabled?: boolean
  createdAt?: number
  updatedAt?: number
  lastRunAt?: number | null
  nextRunAt?: number | null
} & Record<string, unknown>

export type UpdateRoutineInput = {
  name?: string
  prompt?: string
  content?: string
  projectCwd?: string
  schedule?: string
  frequency?: string
  providerId?: string
  model?: string
  engine?: EngineKind
  permissionMode?: RoutinePermissionMode
  budgetUsd?: number
  notification?: RoutineNotificationOptions
  enabled?: boolean
  lastRunAt?: number | null
  nextRunAt?: number | null
} & Record<string, unknown>

export interface MarkRunOptions {
  ranAt?: number
  nextRunAt?: number | null
}

export type RoutineRunStatus = 'queued' | 'running' | 'succeeded' | 'failed'

export interface RoutineRunRecord {
  id: string
  routineId: string
  routineName: string
  projectCwd: string
  startedAt: number
  finishedAt?: number
  status: RoutineRunStatus
  sessionId?: string
  nextRunAt?: number | null
  error?: string
}

export interface RoutineTemplate {
  id: string
  name: string
  description: string
  content: string
  frequency: string
  permissionMode: RoutinePermissionMode
  tags: string[]
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

export type WorktreePullRequestTool = 'gh' | 'glab'

/** 冲突三栏:单文件三份内容(基线/worktree/主工作区) */
export interface WorktreeConflictFile {
  path: string
  base: string
  worktree: string
  main: string
  baseMissing?: boolean
  worktreeMissing?: boolean
  mainMissing?: boolean
  truncated?: boolean
}

/** 单对象可选字段形态(同 GitResult 模式),规避非严格 tsc 判别联合收窄问题 */
export interface WorktreeConflictFilesResult {
  ok: boolean
  files?: WorktreeConflictFile[]
  truncatedList?: boolean
  error?: string
}

/** 合并回执:applyWorktreePatch 成功后落盘的验收记录 */
export interface WorktreeMergeReceipt {
  sessionId: string
  branch: string
  baseSha: string
  filesChanged: number
  insertions: number
  deletions: number
  mergedAt: number
  patchSha256: string
}

export type WorktreePullRequestResult =
  | {
      ok: true
      created: true
      tool: WorktreePullRequestTool
      branch: string
      url: string
      pushed: boolean
    }
  | { ok: true; created: false; message: string }
  | { ok: false; error: string }

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

export interface PreviewAnnotationLocator {
  page?: number
  row?: number
  column?: number
  quote?: string
  selector?: string
}

export interface PreviewAnnotation {
  id: string
  sessionId: string
  path: string
  type?: PreviewType
  mime?: string
  note: string
  locator?: PreviewAnnotationLocator
  boundingBox?: BrowserAnnotationBoundingBox
  screenshotPath?: string
  createdAt: string
}

export interface PreviewAnnotationInput {
  id?: string
  sessionId: string
  path: string
  type?: PreviewType | null
  mime?: string | null
  note: string
  locator?: PreviewAnnotationLocator | null
  boundingBox?: BrowserAnnotationBoundingBox | null
  screenshotPath?: string | null
  createdAt?: string
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

/** DOM 圈选结果:pickElement 注入拾取器后用户选定的元素信息 */
export interface BrowserPickResult {
  cancelled: boolean
  url?: string
  title?: string
  selector?: string
  text?: string
  boundingBox?: BrowserAnnotationBoundingBox
  viewport?: BrowserAnnotationViewport
}

/** Agent 只读观测:当前页面状态快照(不注入不点击) */
export interface BrowserObservation {
  sessionId: string
  url: string
  title: string
  loading: boolean
  pageTextSnippet: string
  consoleErrors: string[]
  networkFailures: string[]
}

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

/** 会话全文搜索:单条命中片段 */
export interface TranscriptSearchHit {
  seq: number
  role: 'user' | 'assistant'
  /** 命中词前后 ±60 字符的上下文片段 */
  snippet: string
}

/** 会话全文搜索:按会话聚合的命中结果 */
export interface TranscriptSearchResult {
  sdkSessionId: string
  title: string
  cwd: string
  hits: TranscriptSearchHit[]
  /** 文件被跳过等异常说明(如转录超过大小上限) */
  note?: string
}

export type MenuCommand =
  | { type: 'new-session' }
  | { type: 'settings' }
  | { type: 'command-palette' }
  | { type: 'open-search' }
  | { type: 'select-session'; index: number }

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
  listTaskSnapshots(): Promise<TaskSnapshotRecord[]>
  recoverTaskSnapshot(snapshotId: string): Promise<SessionMeta>
  deleteTaskSnapshot(snapshotId: string): Promise<boolean>
  createSession(opts: CreateSessionOptions): Promise<SessionMeta>
  decomposeTask(parentSessionId: string, input: TaskDecomposeInput): Promise<TaskDecomposeResult>
  dispatchSubagents(
    parentSessionId: string,
    input: DispatchSubagentsInput
  ): Promise<SubagentDispatchResult>
  dispatchTaskDag(
    parentSessionId: string,
    input: TaskDagDispatchInput
  ): Promise<TaskDagDispatchResult>
  listSupportedAgents(sessionId: string): Promise<SdkAgentInfo[]>
  copyImageAttachment(sessionId: string, sourcePath: string): Promise<ImageAttachmentResult>
  saveImageAttachmentBytes(
    sessionId: string,
    input: SaveImageAttachmentBytesInput
  ): Promise<ImageAttachmentResult>
  /** OCR 附件图片(Vision/tesseract 降级;无引擎时 ok=false 如实报告) */
  ocrImageAttachment(sessionId: string, imagePath: string): Promise<ImageOcrResult>
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
  /** 会话全文搜索:跨历史会话检索转录中的消息内容 */
  searchTranscripts(query: string): Promise<TranscriptSearchResult[]>
  setHistoryArchived(id: string, archived: boolean): Promise<void>
  setHistoryPinned(id: string, pinned: boolean): Promise<void>
  renameHistory(id: string, title: string): Promise<void>
  deleteHistory(id: string): Promise<void>
  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  listProviders(): Promise<ProviderView[]>
  createProvider(provider: ProviderInput): Promise<ProviderView>
  updateProvider(id: string, patch: Partial<ProviderInput>): Promise<ProviderView>
  deleteProvider(id: string): Promise<void>
  fetchProviderModels(opts: ProviderModelFetchInput): Promise<ProviderModelFetchResult>
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
  /** MCP 运行态探测:stdio 真握手 / http 可达性(最多 20 项) */
  probeMcpServers(items: PluginRegistryItem[], sessionId?: string): Promise<McpProbeResult[]>
  /** 本地安装插件:不传路径则弹目录选择器;仅复制入 ~/.claude/plugins */
  installLocalPlugin(sourcePath?: string, overwrite?: boolean): Promise<PluginInstallResult>
  /** 卸载托管插件:移入回收站(可恢复),仅限 ~/.claude/plugins 内 */
  uninstallPlugin(targetPath: string): Promise<PluginUninstallResult>
  listRoutines(): Promise<Routine[]>
  createRoutine(input: CreateRoutineInput): Promise<Routine>
  deleteRoutine(id: string): Promise<boolean>
  updateRoutine(id: string, patch: UpdateRoutineInput): Promise<Routine | null>
  markRoutineRun(id: string, options?: MarkRunOptions): Promise<Routine | null>
  runRoutineNow(id: string): Promise<RoutineRunRecord | null>
  listRoutineRuns(routineId?: string): Promise<RoutineRunRecord[]>
  listRoutineTemplates(): Promise<RoutineTemplate[]>
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
  /** 冲突三栏:apply-check 被拒时取冲突文件的 基线/worktree/主工作区 三份内容 */
  getWorktreeConflictFiles(sessionId: string): Promise<WorktreeConflictFilesResult>
  /** 合并回执列表(最新在前),验收"上次到底合了什么" */
  listWorktreeMergeReceipts(): Promise<WorktreeMergeReceipt[]>
  createWorktreePullRequest(sessionId: string): Promise<WorktreePullRequestResult>
  removeWorktree(
    sessionId: string,
    opts?: { deleteBranch?: boolean; force?: boolean }
  ): Promise<WorktreeRemoveResult>
  listProjectFiles(sessionId: string): Promise<ListProjectFilesResult>
  readTextFile(sessionId: string, path: string): Promise<ReadTextFileResult>
  writeTextFile(sessionId: string, path: string, content: string): Promise<WriteTextFileResult>
  preparePreview(sessionId: string, path: string): Promise<PreparedPreview>
  savePreviewAnnotation(sessionId: string, input: PreviewAnnotationInput): Promise<PreviewAnnotation>
  listPreviewAnnotations(sessionId: string, path?: string): Promise<PreviewAnnotation[]>
  openBrowser(sessionId: string, url?: string): Promise<BrowserViewState>
  navigateBrowser(sessionId: string, url: string): Promise<BrowserViewState>
  setBrowserBounds(sessionId: string, bounds: BrowserBounds): Promise<void>
  browserGoBack(sessionId: string): Promise<BrowserViewState>
  browserGoForward(sessionId: string): Promise<BrowserViewState>
  reloadBrowser(sessionId: string): Promise<BrowserViewState>
  closeBrowser(sessionId: string): Promise<void>
  captureBrowserAnnotation(sessionId: string, note: string): Promise<BrowserAnnotation>
  listBrowserAnnotations(sessionId: string): Promise<BrowserAnnotation[]>
  pickBrowserElement(sessionId: string): Promise<BrowserPickResult>
  captureBrowserElementAnnotation(
    sessionId: string,
    pick: BrowserPickResult,
    note: string
  ): Promise<BrowserAnnotation>
  observeBrowser(sessionId: string): Promise<BrowserObservation>
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
  readProjectContext(projectPath: string): Promise<ProjectContextReadResult>
  writeProjectContext(projectPath: string, content: string): Promise<ProjectContextReadResult>
  generateProjectContextTemplate(projectPath: string): Promise<string>
  readProjectMemory(sessionId: string): Promise<ReadProjectMemoryResult>
  proposeMemoryDraft(sessionId: string, input: ProjectMemoryDraftInput): Promise<ProjectMemoryDraft>
  acceptMemoryDraft(sessionId: string, draftId: string): Promise<ProjectMemoryEntry>
  deleteMemoryEntry(sessionId: string, entryId: string): Promise<{ id: string; deleted: boolean; deletedFrom: Array<'confirmed' | 'drafts'> }>
  listLayeredMemories(): Promise<LayeredMemoryEntry[]>
  searchLayeredMemories(
    sessionId: string | undefined,
    input: LayeredMemorySearchInput
  ): Promise<LayeredMemorySearchHit[]>
  addLayeredMemory(
    sessionId: string | undefined,
    input: LayeredMemoryWriteInput
  ): Promise<LayeredMemoryEntry>
  archiveLayeredMemories(olderThanDays?: number): Promise<number>
  exportLayeredMemories(): Promise<string>
  updateLayeredMemory(entryId: string, input: LayeredMemoryUpdateInput): Promise<LayeredMemoryEntry | null>
  deleteLayeredMemory(entryId: string): Promise<boolean>
  pickDirectory(): Promise<string | null>
  quickbarGetState(): Promise<QuickbarState>
  quickbarSetVisible(visible: boolean): Promise<QuickbarState>
  quickbarGetWindowContext(cwd?: string, sourceId?: string): Promise<QuickbarContextResult>
  quickbarReadClipboard(input?: QuickbarClipboardInput): Promise<QuickbarPayloadResult>
  quickbarCaptureScreenshot(input: QuickbarScreenshotInput): Promise<QuickbarPayloadResult>
  quickbarPickFiles(): Promise<string[]>
  quickbarPrepareFiles(input: QuickbarFileInput): Promise<QuickbarPayloadResult>
  onMenuCommand(cb: (command: MenuCommand) => void): () => void
  onQuickbarEvent(cb: (event: QuickbarEvent) => void): () => void
  onSessionEvent(cb: (sessionId: string, event: AgentEvent, seq: number) => void): () => void
  onMemorySuggestion(cb: (event: MemorySuggestionEvent) => void): () => void
}
