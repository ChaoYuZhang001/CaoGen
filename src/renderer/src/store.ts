import { create } from 'zustand'
import { AUTO_MODEL, CAOGEN_DRIVE_POLICIES } from '../../shared/types'
import type {
  AgentEvent,
  AppSettings,
  AssistantBlock,
  McpProbeResult,
  OpenAIProtocol,
  BrowserAnnotation,
  BrowserBounds,
  BrowserEvent,
  BrowserViewState,
  CheckpointRestoreMode,
  CheckpointRestoreResult,
  CreateSessionOptions,
  DispatchSubagentsInput,
  EffectStatus,
  EngineKind,
  GitCommitResult,
  GitOperationResult,
  GitStatus,
  SubagentDispatchResult,
  SubagentResult,
  TaskDagDispatchResult,
  TaskDagExecutionView,
  HistoryEntry,
  MemorySuggestionEvent,
  ModelRoutingDecisionView,
  ModelRoutePlanView,
  PermissionModeId,
  PluginRegistryItem,
  PluginRegistryView,
  ProjectFileEntry,
  PermissionRequestInfo,
  OfficeVisualPreview,
  PreparedPreview,
  PreviewAnnotation,
  PreviewAnnotationLocator,
  Project,
  ProviderInput,
  ProviderView,
  QuickbarDispatchOptions,
  QuickbarDispatchResult,
  Routine,
  RoutineRunRecord,
  WriteTextFileResult,
  SchedulerStrategy,
  SendMessagePayload,
  SessionMeta,
  StartSuggestion,
  TaskSnapshotRecord,
  UserMessageAttachmentView,
  TranscriptEntry,
  TranscriptSearchResult,
  TerminalEvent,
  TerminalInfo,
  UsageTotals,
  WorkspaceDiff,
  WorkspaceHunkResult,
  WorktreeApplyCheckResult,
  WorktreeApplyResult,
  WorktreeConflictFilesResult,
  WorktreeMergeReceipt,
  WorktreeMergeSummary,
  WorktreePatchResult,
  WorktreePullRequestResult,
  WorktreeRemoveResult,
  WorktreeSummary
} from '../../shared/types'
import { createTaskRecoveryActions, type TaskRecoveryActions } from './store/task-recovery-actions'
import { createExperienceModeSlice, type ExperienceModeSlice } from './store/experience-mode'

let seq = 0
let previewRequestSeq = 0
let previewVisualRequestSeq = 0
const genId = (): string => `it-${Date.now().toString(36)}-${seq++}`

function pluginRegistryItemPrompt(item: PluginRegistryItem): string {
  const kindLabel =
    item.kind === 'plugin'
      ? '插件包'
      : item.kind === 'skill'
        ? 'Skill'
        : item.kind === 'agent'
          ? 'Agent 定义'
          : 'MCP 服务'
  const usageHint =
    item.kind === 'plugin'
      ? '这是一个插件包容器。先查看该目录下的 .codex-plugin/plugin.json、skills/、agents/、mcp/ 等子资源,再选择最适合当前目标的能力使用。'
      : item.kind === 'skill'
      ? '如果需要细节,先读取该目录下的 SKILL.md,再按其中的触发条件和步骤执行。'
      : item.kind === 'agent'
        ? '如果需要细节,先读取这个 Agent 定义文件,再判断是否应该按它的角色拆分或执行任务。'
        : '先判断当前会话是否已经暴露对应 MCP 工具;如果没有可调用工具,不要假装调用成功,请说明需要启用或配置该 MCP。'
  return [
    `请在当前任务中合理使用这个 ${kindLabel},但只在它确实适合当前目标时使用。`,
    '',
    `名称: ${item.name}`,
    `类型: ${item.kind}`,
    `状态: ${item.enabled ? '已启用' : '未启用或不可用'}`,
    `来源根目录: ${item.sourceRoot}`,
    `路径: ${item.path}`,
    `摘要: ${item.summary || '(无摘要)'}`,
    '',
    usageHint,
    '使用前请先核对实际文件/工具状态;不要仅凭名称推断能力。'
  ].join('\n')
}

function pluginRegistryAgentTaskId(item: PluginRegistryItem): string {
  const slug = item.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36)
  return slug || 'plugin-agent'
}

function pluginRegistryAgentDispatchPrompt(item: PluginRegistryItem): string {
  return [
    `你将作为子 Agent「${item.name}」参与当前父会话任务。`,
    '',
    '请先核对你的 Agent 定义文件,再执行工作:',
    `定义路径: ${item.path}`,
    `来源根目录: ${item.sourceRoot}`,
    `摘要: ${item.summary || '(无摘要)'}`,
    `当前扫描状态: ${item.enabled ? '已启用' : '未启用或不可用'}`,
    '',
    '工作要求:',
    '1. 读取并遵守该 Agent 定义文件中的角色、边界和输出格式。',
    '2. 围绕父会话当前目标推进一个可验证的子任务;如果上下文不足,先从仓库中的 REQUIREMENTS.md、ROADMAP.md、DESIGN-V2.md 或相关源码提取事实。',
    '3. 不要假装具备定义文件没有提供的工具或权限;遇到缺口要明确说明。',
    '4. 产出应包含你检查过的证据、做出的修改或建议、以及可运行的验证命令。'
  ].join('\n')
}

function closeNativeBrowserView(sessionId: string | null | undefined): void {
  if (!sessionId) return
  void window.agentDesk.closeBrowser(sessionId).catch(() => undefined)
}

function quickbarCwd(state: AppStore, requested?: string): string {
  const clean = requested?.trim()
  if (clean) return clean
  const activeCwd = state.activeId ? state.sessions[state.activeId]?.meta.cwd : undefined
  return activeCwd || state.projects[0]?.path || ''
}

async function ensureQuickbarSession(
  getState: () => AppStore,
  options: QuickbarDispatchOptions
): Promise<{ sessionId: string; cwd: string }> {
  const state = getState()
  const currentId = state.activeId && state.sessions[state.activeId] ? state.activeId : null
  if (options.target === 'current' && currentId) {
    return { sessionId: currentId, cwd: state.sessions[currentId].meta.cwd }
  }

  const cwd = quickbarCwd(state, options.cwd)
  if (!cwd) throw new Error('Quickbar 创建新会话需要工作目录')
  await state.createSession({ cwd, title: 'Quickbar' })
  const sessionId = getState().activeId
  if (!sessionId) throw new Error('Quickbar 新会话创建失败')
  return { sessionId, cwd: getState().sessions[sessionId]?.meta.cwd ?? cwd }
}

async function sendQuickbarPayload(
  getState: () => AppStore,
  sessionId: string,
  payload: SendMessagePayload
): Promise<void> {
  if (getState().activeId !== sessionId) getState().selectSession(sessionId)
  await getState().sendMessage(payload)
}

/**
 * createSession IPC 返回前主进程可能已开始广播该会话的事件(status/init),
 * 此时 store 里还没有对应条目;先缓存,注册时按序重放,避免丢 sdkSessionId 等状态。
 */
const pendingEvents = new Map<string, Array<{ seq: number; event: AgentEvent; eventId?: string }>>()
const appliedEventIds = new Map<string, string[]>()
const PENDING_EVENTS_CAP = 200
const APPLIED_EVENT_IDS_CAP = 256

function stashPendingEvent(sessionId: string, seq: number, event: AgentEvent, eventId?: string): void {
  const queue = pendingEvents.get(sessionId) ?? []
  if (queue.length < PENDING_EVENTS_CAP) queue.push({ seq, event, eventId })
  pendingEvents.set(sessionId, queue)
}

function drainPendingEvents(sessionId: string, state: SessionState): SessionState {
  const queue = pendingEvents.get(sessionId)
  if (!queue) return state
  pendingEvents.delete(sessionId)
  return queue.reduce((s, item) => applyEvent(s, item.seq, item.event, item.eventId), state)
}

/** 应用单条事件(eventId + seq 去重 + reduce) */
function applyEvent(s: SessionState, seq: number, event: AgentEvent, eventId?: string): SessionState {
  const recent = appliedEventIds.get(s.meta.id) ?? []
  if (eventId && recent.includes(eventId)) return s
  if (seq <= s.lastSeq) return s
  if (eventId) {
    recent.push(eventId)
    appliedEventIds.set(s.meta.id, recent.slice(-APPLIED_EVENT_IDS_CAP))
  }
  return { ...reduceSession(s, event), lastSeq: seq }
}

/** 批量回放转录(已按 seq 排序) */
function replayTranscript(s: SessionState, entries: TranscriptEntry[]): SessionState {
  return entries.reduce((state, e) => applyEvent(state, e.seq, e.event, e.eventId), s)
}

function replaceTranscript(s: SessionState, entries: TranscriptEntry[]): SessionState {
  return replayTranscript(newSessionState(s.meta), [...entries].sort((a, b) => a.seq - b.seq))
}

interface StreamDeltaBuffer {
  text: string
  thinking: string
  maxSeq: number
  frame: number | null
}

const streamDeltaBuffers = new Map<string, StreamDeltaBuffer>()

// 会话全文搜索:防抖定时器 + 递增令牌(丢弃乱序返回的过期结果)
let transcriptSearchTimer: number | null = null
let transcriptSearchToken = 0

function isStreamDelta(event: AgentEvent): event is Extract<AgentEvent, { kind: 'text-delta' | 'thinking-delta' }> {
  return event.kind === 'text-delta' || event.kind === 'thinking-delta'
}

function requestStreamFrame(cb: () => void): number {
  return typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(cb)
    : window.setTimeout(cb, 16)
}

function cancelStreamFrame(frame: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
  else window.clearTimeout(frame)
}

export interface ToolResultInfo {
  content: string
  isError: boolean
  effectStatus?: EffectStatus
}

export type ChatItem =
  | {
      id: string
      kind: 'user'
      text: string
      /** 主进程回传的权威消息 id;乐观追加时为空,user-message 事件到达后补上 */
      messageId?: string
      checkpointId?: string
      attachments?: UserMessageAttachmentView[]
    }
  | { id: string; kind: 'assistant'; blocks: AssistantBlock[] }
  | {
      id: string
      kind: 'turn-result'
      subtype: string
      isError: boolean
      costUsd?: number
      usage?: UsageTotals
      durationMs?: number
      resultText?: string
    }
  | {
      id: string
      kind: 'routing'
      providerId: string
      providerName?: string
      model: string
      reason: string
      decision?: ModelRoutingDecisionView
      crossValidationPlan?: ModelRoutePlanView
    }
  | {
      id: string
      kind: 'failover'
      fromName: string
      toName: string
      model?: string
      reason: string
    }
  | {
      id: string
      kind: 'provider-key-failover'
      providerName: string
      fromKeyLabel: string
      toKeyLabel: string
      reason: string
    }
  | {
      id: string
      kind: 'workspace'
      event: 'checkpoint-restore'
      filesChanged: string[]
      insertions?: number
      deletions?: number
      note?: string
    }
  | { id: string; kind: 'notice'; level: 'info' | 'error'; text: string }

export interface SessionState {
  meta: SessionMeta
  items: ChatItem[]
  streamText: string
  streamThinking: string
  toolResults: Record<string, ToolResultInfo>
  runningTools: Record<string, true>
  pendingPermissions: PermissionRequestInfo[]
  childResults: Record<string, SubagentResult>
  taskDagExecution?: TaskDagExecutionView
  effectiveModel?: string
  tools?: string[]
  /** 已处理的最大 seq,供去重(转录回放 + 实时事件) */
  lastSeq: number
}

function newSessionState(meta: SessionMeta): SessionState {
  return {
    meta,
    items: [],
    streamText: '',
    streamThinking: '',
    toolResults: {},
    runningTools: {},
    pendingPermissions: [],
    childResults: {},
    taskDagExecution: undefined,
    lastSeq: 0
  }
}

function reduceSession(s: SessionState, ev: AgentEvent): SessionState {
  switch (ev.kind) {
    case 'user-message': {
      // 去重:sendMessage 已乐观追加一条 user 项(pending);此事件是主进程回传的
      // 权威副本。若末尾是尚未确认(无 messageId)且文本一致的 user 项,就"确认"它
      // (补上 messageId),而非再追加一条 —— 否则聊天流出现重复气泡。
      // 重载转录回放时没有乐观项,走正常追加分支。
      const last = s.items[s.items.length - 1]
      if (
        last &&
        last.kind === 'user' &&
        !last.messageId &&
        last.text === ev.text
      ) {
        const items = s.items.slice()
        items[items.length - 1] = {
          ...last,
          messageId: ev.messageId,
          attachments: last.attachments ?? ev.attachments
        }
        return { ...s, items }
      }
      return {
        ...s,
        items: [
          ...s.items,
          {
            id: ev.messageId ?? genId(),
            kind: 'user',
            messageId: ev.messageId,
            text: ev.text,
            attachments: ev.attachments
          }
        ]
      }
    }
    case 'checkpoint': {
      // 新事件按本地用户消息 id 精确绑定;旧转录没有 userMessageId 时才回退到邻近匹配。
      const items = [...s.items]
      if (ev.userMessageId) {
        const idx = items.findIndex((it) => it.kind === 'user' && it.id === ev.userMessageId)
        if (idx >= 0) {
          const it = items[idx]
          if (it.kind === 'user') items[idx] = { ...it, checkpointId: ev.messageId }
          return { ...s, items }
        }
      }
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]
        if (it.kind === 'user' && !it.checkpointId) {
          items[i] = { ...it, checkpointId: ev.messageId }
          break
        }
      }
      return { ...s, items }
    }
    case 'checkpoint-restore': {
      const count = ev.filesChanged.length
      return {
        ...s,
        items: [
          ...s.items,
          {
            id: genId(),
            kind: 'workspace',
            event: 'checkpoint-restore',
            filesChanged: ev.filesChanged,
            insertions: ev.insertions,
            deletions: ev.deletions,
            note: ev.note
          },
          {
            id: genId(),
            kind: 'notice',
            level: 'info',
            text:
              count > 0
                ? `已回退 ${count} 个文件 (+${ev.insertions ?? 0}/-${ev.deletions ?? 0})`
                : '已执行回退,没有文件需要恢复'
          }
        ]
      }
    }
    case 'routing':
      return {
        ...s,
        items: [
          ...s.items,
          {
            id: genId(),
            kind: 'routing',
            providerId: ev.providerId,
            providerName: ev.providerName,
            model: ev.model,
            reason: ev.reason,
            decision: ev.decision,
            crossValidationPlan: ev.crossValidationPlan
          }
        ],
        effectiveModel: ev.model
      }
    case 'failover':
      return {
        ...s,
        // 切换即换厂商:清掉进行中的流式/工具状态(旧引擎已终止)
        streamText: '',
        streamThinking: '',
        runningTools: {},
        effectiveModel: ev.model ?? s.effectiveModel,
        items: [
          ...s.items,
          {
            id: genId(),
            kind: 'failover',
            fromName: ev.fromName,
            toName: ev.toName,
            model: ev.model,
            reason: ev.reason
          }
        ]
      }
    case 'provider-key-failover':
      return {
        ...s,
        streamText: '',
        streamThinking: '',
        runningTools: {},
        items: [
          ...s.items,
          {
            id: genId(),
            kind: 'provider-key-failover',
            providerName: ev.providerName,
            fromKeyLabel: ev.fromKeyLabel,
            toKeyLabel: ev.toKeyLabel,
            reason: ev.reason
          }
        ]
      }
    case 'status': {
      const meta = { ...s.meta, status: ev.status, lastError: ev.error ?? s.meta.lastError }
      let items = s.items
      if (ev.error && ev.status !== 'closed') {
        items = [...items, { id: genId(), kind: 'notice', level: 'error', text: ev.error }]
      }
      return { ...s, meta, items }
    }
    case 'init':
      return {
        ...s,
        meta: { ...s.meta, sdkSessionId: ev.sdkSessionId },
        effectiveModel: ev.model ?? s.effectiveModel,
        tools: ev.tools ?? s.tools
      }
    case 'meta':
      return { ...s, meta: ev.meta }
    case 'text-delta':
      return { ...s, streamText: s.streamText + ev.text }
    case 'thinking-delta':
      return { ...s, streamThinking: s.streamThinking + ev.text }
    case 'tool-start':
      return { ...s, runningTools: { ...s.runningTools, [ev.toolUseId]: true } }
    case 'assistant-message': {
      const runningTools = { ...s.runningTools }
      for (const b of ev.blocks) {
        if (b.type === 'tool_use' && !(b.id in s.toolResults)) runningTools[b.id] = true
      }
      return {
        ...s,
        items: [...s.items, { id: genId(), kind: 'assistant', blocks: ev.blocks }],
        streamText: '',
        streamThinking: '',
        runningTools
      }
    }
    case 'tool-result': {
      const runningTools = { ...s.runningTools }
      delete runningTools[ev.toolUseId]
      return {
        ...s,
        toolResults: {
          ...s.toolResults,
          [ev.toolUseId]: {
            content: ev.content,
            isError: ev.isError,
            effectStatus: ev.effectStatus
          }
        },
        runningTools
      }
    }
    case 'permission-request':
      return { ...s, pendingPermissions: [...s.pendingPermissions, ev.request] }
    case 'permission-resolved':
      return {
        ...s,
        pendingPermissions: s.pendingPermissions.filter((p) => p.requestId !== ev.requestId)
      }
    case 'turn-result': {
      const meta = { ...s.meta }
      if (ev.costUsd !== undefined) meta.costUsd = ev.costUsd
      if (ev.usage) {
        meta.usage = ev.usage
        meta.contextTokens = ev.usage.input + ev.usage.cacheRead + ev.usage.cacheCreation
      }
      return {
        ...s,
        meta,
        streamText: '',
        streamThinking: '',
        runningTools: {},
        items: [
          ...s.items,
          {
            id: genId(),
            kind: 'turn-result',
            subtype: ev.subtype,
            isError: ev.isError,
            costUsd: ev.costUsd,
            usage: ev.usage,
            durationMs: ev.durationMs,
            resultText: ev.isError ? ev.resultText : undefined
          }
        ]
      }
    }
    case 'subagent-result': {
      const key = ev.childTaskId || ev.childSessionId
      return {
        ...s,
        childResults: {
          ...s.childResults,
          [key]: {
            orchestrationId: ev.orchestrationId,
            childTaskId: ev.childTaskId,
            childSessionId: ev.childSessionId,
            childRole: ev.childRole,
            status: ev.status,
            resultText: ev.resultText,
            costUsd: ev.costUsd,
            durationMs: ev.durationMs
          }
        }
      }
    }
    case 'task-dag-update':
      return { ...s, taskDagExecution: ev.execution }
    case 'hook-event': {
      // 只把"有信息量"的钩子进时间线:配置了 shell 的(有命令输出/结果),
      // 或失败的;纯 post-edit 标记事件不刷屏。
      if (!ev.shellCommand) {
        if (ev.event !== 'context-warning' && ev.event !== 'context-compressed') return s
        return {
          ...s,
          items: [
            ...s.items,
            {
              id: genId(),
              kind: 'notice',
              level: ev.event === 'context-warning' ? 'error' : 'info',
              text: ev.detail ?? ev.event
            }
          ]
        }
      }
      const text = [
        `钩子 ${ev.event}${ev.toolName ? `(${ev.toolName})` : ''}: ${ev.shellCommand}`,
        ev.shellOutput ? ev.shellOutput : ''
      ]
        .filter(Boolean)
        .join('\n')
      return {
        ...s,
        items: [
          ...s.items,
          { id: genId(), kind: 'notice', level: ev.shellOk === false ? 'error' : 'info', text }
        ]
      }
    }
    default:
      return s
  }
}

export type AppView = 'list' | 'office'

export interface WorkbenchState {
  diffOpen: boolean
  diffLoading: boolean
  diff?: WorkspaceDiff
  diffError?: string
  diffMessage?: string
  hunkBusyKey?: string
  gitStatus?: GitStatus
  gitLoading: boolean
  gitBusy: boolean
  gitMessage?: string
  gitError?: string
  worktreeOpen: boolean
  worktreeLoading: boolean
  worktree?: WorktreeSummary
  worktreeMergeSummary?: WorktreeMergeSummary
  worktreeMergePatch?: WorktreePatchResult
  worktreeApplyCheck?: WorktreeApplyCheckResult
  worktreeApplyResult?: WorktreeApplyResult
  worktreePrResult?: WorktreePullRequestResult
  /** 冲突三栏数据(apply-check 被拒时按需加载) */
  worktreeConflictFiles?: WorktreeConflictFilesResult
  worktreeConflictLoading: boolean
  /** 当前会话最近一条合并回执("上次合并"验收展示) */
  worktreeLastReceipt?: WorktreeMergeReceipt
  worktreeMergeInspecting: boolean
  worktreeApplying: boolean
  worktreeCreatingPr: boolean
  worktreeMessage?: string
  worktreeError?: string
  terminalOpen: boolean
  terminalLoading: boolean
  terminal?: TerminalInfo
  terminalBuffer: string
  terminalError?: string
  filesOpen: boolean
  filesLoading: boolean
  fileEntries: ProjectFileEntry[]
  filesRoot?: string
  filesTruncated?: boolean
  filesError?: string
  fileLoading: boolean
  fileSaving: boolean
  currentFilePath?: string
  currentFileContent: string
  savedFileContent: string
  currentFileBytes?: number
  currentFileMtimeMs?: number
  fileMessage?: string
  fileError?: string
  browserOpen: boolean
  browserLoading: boolean
  browserState?: BrowserViewState
  browserUrlDraft: string
  browserAnnotations: BrowserAnnotation[]
  browserError?: string
  browserMessage?: string
  /** DOM 圈选进行中(拾取器已注入,等用户点选) */
  browserPicking?: boolean
  previewOpen: boolean
  previewLoading: boolean
  preview?: PreparedPreview
  previewPath?: string
  previewAnnotations: PreviewAnnotation[]
  previewError?: string
  previewVisualLoading: boolean
  previewVisual?: OfficeVisualPreview
  previewVisualError?: string
  pluginRegistryOpen: boolean
  pluginRegistryLoading: boolean
  pluginRegistry?: PluginRegistryView
  pluginRegistryError?: string
  pluginRegistryMessage?: string
  selectedPluginRegistryItemId?: string
  /** MCP 运行态探测:id → 结果;probing = 进行中 */
  mcpProbeResults: Record<string, McpProbeResult>
  mcpProbing: boolean
  subagentOpen: boolean
  subagentBusy: boolean
  subagentError?: string
  subagentMessage?: string
  lastSubagentDispatch?: SubagentDispatchResult
  routineOpen: boolean
  routineLoading: boolean
  routines: Routine[]
  routineRuns: RoutineRunRecord[]
  routineError?: string
  routineMessage?: string
  selectedRoutineId?: string | null
  memoryOpen: boolean
  memorySuggestion?: MemorySuggestionEvent
  memoryInitialForm?: { kind: string; title: string; body: string; reason: string }
  startSuggestions: StartSuggestion[]
  startSuggestionsLoading: boolean
  startSuggestionsError?: string
  ignoredStartSuggestions: Record<string, true>
  laterStartSuggestions: Record<string, number>
}

export interface RewindPanelState {
  open: boolean
  messageId?: string
  sourceText?: string
  reason?: 'button' | 'shortcut' | 'command'
}

interface AppStore extends ExperienceModeSlice, TaskRecoveryActions {
  ready: boolean
  hydrated: boolean
  sessions: Record<string, SessionState>
  order: string[]
  activeId: string | null
  history: HistoryEntry[]
  settings: AppSettings
  providers: ProviderView[]
  projects: Project[]
  taskSnapshots: TaskSnapshotRecord[]
  taskSnapshotsLoading: boolean
  taskSnapshotsError?: string
  view: AppView
  workbench: WorkbenchState
  rewindPanel: RewindPanelState
  showNewSession: boolean
  newSessionProjectId: string | null
  showSettings: boolean
  showCommandPalette: boolean
  showTaskRecovery: boolean
  sidebarQuery: string
  /** 会话全文搜索结果(随 sidebarQuery 防抖刷新;<2 字符时为空) */
  transcriptSearchResults: TranscriptSearchResult[]
  transcriptSearchLoading: boolean
  init(): Promise<void>
  handleEvent(sessionId: string, event: AgentEvent, seq: number, eventId?: string): void
  handleMemorySuggestion(event: MemorySuggestionEvent): void
  handleTerminalEvent(event: TerminalEvent): void
  handleBrowserEvent(event: BrowserEvent): void
  createSession(opts: CreateSessionOptions): Promise<void>
  /** 建会话并立即发送首条消息(首屏"打开即输入"用) */
  startSessionWithPrompt(opts: CreateSessionOptions, prompt: string): Promise<void>
  recoverTaskSnapshot(snapshotId: string): Promise<void>
  dispatchSubagents(input: DispatchSubagentsInput): Promise<SubagentDispatchResult | undefined>
  decomposeAndDispatchTaskDag(
    request: string,
    options?: { autoMerge?: boolean; verificationCommand?: string }
  ): Promise<TaskDagDispatchResult | undefined>
  resumeFromHistory(entry: HistoryEntry): Promise<void>
  selectSession(id: string): void
  sendMessage(input: string | SendMessagePayload): Promise<void>
  sendQuickbarClipboard(options: QuickbarDispatchOptions): Promise<QuickbarDispatchResult | undefined>
  sendQuickbarScreenshot(options: QuickbarDispatchOptions): Promise<QuickbarDispatchResult | undefined>
  sendQuickbarFiles(options: QuickbarDispatchOptions): Promise<QuickbarDispatchResult | undefined>
  interrupt(): Promise<void>
  closeSession(id: string): Promise<void>
  respondPermission(sessionId: string, requestId: string, allow: boolean, message?: string): Promise<void>
  restoreCheckpoint(
    messageId: string,
    mode: CheckpointRestoreMode,
    dryRun: boolean
  ): Promise<CheckpointRestoreResult | undefined>
  setPermissionMode(mode: PermissionModeId): Promise<void>
  setModel(model: string): Promise<void>
  renameSession(id: string, title: string): Promise<void>
  archiveHistory(id: string, archived: boolean): Promise<void>
  pinHistory(id: string, pinned: boolean): Promise<void>
  renameHistoryEntry(id: string, title: string): Promise<void>
  deleteHistoryEntry(id: string): Promise<void>
  setSidebarQuery(q: string): void
  /** 打开全文搜索命中的会话:已打开则切换,否则按 sdkSessionId 从历史恢复 */
  openTranscriptSearchHit(result: TranscriptSearchResult): Promise<void>
  updateSettings(patch: Partial<AppSettings>): Promise<void>
  setView(view: AppView): void
  openDiffPanel(): Promise<void>
  closeDiffPanel(): void
  refreshDiffPanel(): Promise<void>
  refreshGitStatus(): Promise<void>
  applyWorkspaceHunk(filePath: string, hunkPatch: string, hunkKey: string): Promise<WorkspaceHunkResult | undefined>
  discardWorkspaceHunk(filePath: string, hunkPatch: string, hunkKey: string): Promise<WorkspaceHunkResult | undefined>
  stageGitFiles(paths: string[]): Promise<GitOperationResult | undefined>
  stageAllGitFiles(): Promise<GitOperationResult | undefined>
  unstageGitFiles(paths: string[]): Promise<GitOperationResult | undefined>
  commitGit(message: string): Promise<GitCommitResult | undefined>
  openWorktreePanel(): Promise<void>
  closeWorktreePanel(): void
  refreshWorktreePanel(): Promise<void>
  exportWorktreePatch(): Promise<WorktreePatchResult | undefined>
  inspectWorktreeMerge(): Promise<void>
  applyWorktreePatch(): Promise<WorktreeApplyResult | undefined>
  /** 冲突三栏:拉取冲突文件的 基线/worktree/主工作区 三份内容 */
  loadWorktreeConflictFiles(): Promise<void>
  /** 刷新当前会话最近一条合并回执 */
  refreshWorktreeMergeReceipt(): Promise<void>
  createWorktreePullRequest(): Promise<WorktreePullRequestResult | undefined>
  removeWorktree(opts?: { deleteBranch?: boolean; force?: boolean }): Promise<WorktreeRemoveResult | undefined>
  openTerminalPanel(): Promise<void>
  closeTerminalPanel(): void
  startTerminal(): Promise<void>
  sendTerminalInput(text: string): Promise<void>
  closeTerminal(): Promise<void>
  openFilesPanel(): Promise<void>
  closeFilesPanel(): void
  refreshFilesPanel(): Promise<void>
  openFile(path: string): Promise<void>
  updateFileDraft(content: string): void
  saveOpenFile(): Promise<WriteTextFileResult | undefined>
  openPreviewPanel(path?: string): Promise<void>
  closePreviewPanel(): void
  refreshPreviewPanel(): Promise<void>
  savePreviewAnnotation(note: string, locator?: PreviewAnnotationLocator): Promise<void>
  refreshPreviewAnnotations(): Promise<void>
  openBrowserPanel(url?: string): Promise<void>
  closeBrowserPanel(): Promise<void>
  navigateBrowser(url: string): Promise<void>
  browserGoBack(): Promise<void>
  browserGoForward(): Promise<void>
  reloadBrowser(): Promise<void>
  setBrowserBounds(bounds: BrowserBounds): Promise<void>
  captureBrowserAnnotation(note: string): Promise<void>
  refreshBrowserAnnotations(): Promise<void>
  /** DOM 圈选:注入拾取器→用户点选→截图落批注 */
  pickBrowserElementAnnotation(note: string): Promise<void>
  /** 只读观测当前页面并发给 Agent 复验 */
  observeBrowserForAgent(): Promise<void>
  openPluginRegistryPanel(): Promise<void>
  closePluginRegistryPanel(): void
  refreshPluginRegistryPanel(): Promise<void>
  /** 探测 MCP server 运行态(真实连接测试) */
  probeMcpRuntime(items: PluginRegistryItem[]): Promise<void>
  /** 本地安装插件(弹目录选择器);成功后重扫 */
  installPluginFromLocal(): Promise<void>
  /** 卸载托管插件(回收站式);成功后重扫 */
  uninstallManagedPlugin(item: PluginRegistryItem): Promise<void>
  loadPluginRegistryForSlash(): Promise<void>
  selectPluginRegistryItem(id: string): void
  revealPluginRegistryItem(item: PluginRegistryItem): Promise<void>
  togglePluginRegistryItem(item: PluginRegistryItem, enabled: boolean): Promise<void>
  sendPluginRegistryItemToAgent(item: PluginRegistryItem): Promise<void>
  dispatchPluginAgent(item: PluginRegistryItem): Promise<void>
  openSubagentPanel(): void
  closeSubagentPanel(): void
  dispatchSubagentText(tasksText: string): Promise<SubagentDispatchResult | undefined>
  openRoutinePanel(): Promise<void>
  closeRoutinePanel(): void
  refreshRoutinePanel(): Promise<void>
  selectRoutine(id: string): void
  toggleRoutine(id: string, enabled: boolean): Promise<void>
  markRoutineRun(id: string): Promise<void>
  deleteRoutine(id: string): Promise<void>
  refreshStartSuggestions(): Promise<void>
  sendStartSuggestion(suggestion: StartSuggestion): Promise<void>
  ignoreStartSuggestion(id: string): void
  laterStartSuggestion(id: string): void
  visibleStartSuggestions(): StartSuggestion[]
  refreshTaskSnapshots(): Promise<void>
  deleteTaskSnapshot(snapshotId: string): Promise<void>
  openMemoryPanel(): void
  acceptMemorySuggestion(): void
  dismissMemorySuggestion(): void
  closeMemoryPanel(): void
  openRewindPanel(messageId: string, sourceText?: string, reason?: RewindPanelState['reason']): void
  openLatestRewindPanel(reason?: RewindPanelState['reason']): void
  closeRewindPanel(): void
  refreshProviders(): Promise<void>
  createProvider(input: ProviderInput): Promise<void>
  updateProvider(id: string, patch: Partial<ProviderInput>): Promise<void>
  deleteProvider(id: string): Promise<void>
  refreshProjects(): Promise<void>
  archiveProject(id: string, archived: boolean): Promise<void>
  deleteProject(id: string): Promise<void>
  setShowNewSession(v: boolean, projectId?: string): void
  setShowSettings(v: boolean): void
  setShowCommandPalette(v: boolean): void
  setShowTaskRecovery(v: boolean): void
}

export const useStore = create<AppStore>((set, get) => {
  const clearStreamBuffer = (sessionId: string): void => {
    const buffer = streamDeltaBuffers.get(sessionId)
    if (!buffer) return
    if (buffer.frame !== null) cancelStreamFrame(buffer.frame)
    streamDeltaBuffers.delete(sessionId)
  }

  const flushStreamBuffer = (sessionId: string): void => {
    const buffer = streamDeltaBuffers.get(sessionId)
    if (!buffer) return
    if (buffer.frame !== null) cancelStreamFrame(buffer.frame)
    streamDeltaBuffers.delete(sessionId)
    if (!buffer.text && !buffer.thinking) return
    set((s) => {
      const session = s.sessions[sessionId]
      if (!session || buffer.maxSeq <= session.lastSeq) return s
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...session,
            streamText: session.streamText + buffer.text,
            streamThinking: session.streamThinking + buffer.thinking,
            lastSeq: Math.max(session.lastSeq, buffer.maxSeq)
          }
        }
      }
    })
  }

  const queueStreamDelta = (
    sessionId: string,
    seq: number,
    event: Extract<AgentEvent, { kind: 'text-delta' | 'thinking-delta' }>
  ): void => {
    const session = get().sessions[sessionId]
    if (!session) {
      stashPendingEvent(sessionId, seq, event)
      return
    }
    const current = streamDeltaBuffers.get(sessionId)
    if (seq <= Math.max(session.lastSeq, current?.maxSeq ?? 0)) return
    const buffer = current ?? { text: '', thinking: '', maxSeq: 0, frame: null }
    if (event.kind === 'text-delta') buffer.text += event.text
    else buffer.thinking += event.text
    buffer.maxSeq = Math.max(buffer.maxSeq, seq)
    if (buffer.frame === null) {
      buffer.frame = requestStreamFrame(() => {
        const scheduled = streamDeltaBuffers.get(sessionId)
        if (scheduled) scheduled.frame = null
        flushStreamBuffer(sessionId)
      })
    }
    streamDeltaBuffers.set(sessionId, buffer)
  }

  return {
  ready: false,
  hydrated: false,
  sessions: {},
  order: [],
  activeId: null,
  history: [],
  settings: {
    driveMode: 'core',
    defaultModel: '',
    defaultPermissionMode: 'default',
    defaultProviderId: '',
    fallbackProviderId: '',
    fallbackModel: '',
    lowCostProviderId: '',
    lowCostModel: '',
    strongReasoningProviderId: '',
    strongReasoningModel: '',
    reviewProviderId: '',
    reviewModel: '',
    researchProviderId: '',
    researchModel: '',
    planningProviderId: '',
    planningModel: '',
    codingProviderId: '',
    codingModel: '',
    testingProviderId: '',
    testingModel: '',
    documentationProviderId: '',
    documentationModel: '',
    schedulerStrategy: 'balanced',
    modelRoutingRules: [],
    smartModelRoutingEnabled: false,
    modelCrossValidationAutoRunEnabled: false,
    budgetUsdPerSession: 0,
    budgetUsdPerMonth: 0,
    failoverEnabled: true,
    language: 'zh',
    theme: 'dark',
    persona: '',
    allowedTools: '',
    disallowedTools: '',
    sandboxMode: 'restrictedLocal',
    chinaEcosystemMirrorEnabled: false,
    chinaNpmRegistry: '',
    chinaPipIndexUrl: '',
    permissionAllowlist: '',
    permissionDenylist: '',
    permissionTemporaryAllowlist: '',
    guiAutomationEnabled: false,
    guiAutomationTemporaryGrantUntil: 0,
    notificationsEnabled: true,
    preventDisplaySleep: true,
    sdkAgentsEnabled: false,
    ideBridgeEnabled: false,
    ideBridgeHost: '127.0.0.1',
    ideBridgePort: 17365,
    ideBridgeToken: '',
    hookPostEditCommand: '',
    hookTurnEndCommand: '',
    autoSkillLearningEnabled: false,
    office: { qualityMode: 'auto', showBadges: true, liveliness: 1, catEars: false },
    layout: {
      sidebarCollapsed: false,
      sidebarWidth: 264,
      workbenchSideWidth: 560,
      chatScale: 1,
      chatDensity: 'comfortable'
    }
  },
  providers: [],
  projects: [],
  taskSnapshots: [],
  taskSnapshotsLoading: false,
  view: 'list',
  ...createExperienceModeSlice((update) => set(update)),
  sidebarQuery: '',
  transcriptSearchResults: [],
  transcriptSearchLoading: false,
  workbench: {
    diffOpen: false,
    diffLoading: false,
    gitLoading: false,
    gitBusy: false,
    worktreeOpen: false,
    worktreeLoading: false,
    worktreeConflictLoading: false,
    worktreeMergeInspecting: false,
    worktreeApplying: false,
    worktreeCreatingPr: false,
    terminalOpen: false,
    terminalLoading: false,
    terminalBuffer: '',
    filesOpen: false,
    filesLoading: false,
    fileEntries: [],
    fileLoading: false,
    fileSaving: false,
    currentFileContent: '',
    savedFileContent: '',
    browserOpen: false,
    browserLoading: false,
    browserUrlDraft: '',
    browserAnnotations: [],
    previewOpen: false,
    previewLoading: false,
    previewAnnotations: [],
    previewVisualLoading: false,
    pluginRegistryOpen: false,
    pluginRegistryLoading: false,
    mcpProbeResults: {},
    mcpProbing: false,
    subagentOpen: false,
    subagentBusy: false,
    routineOpen: false,
    routineLoading: false,
    routines: [],
    routineRuns: [],
    selectedRoutineId: null,
    memoryOpen: false,
    startSuggestions: [],
    startSuggestionsLoading: false,
    ignoredStartSuggestions: {},
    laterStartSuggestions: {}
  },
  rewindPanel: { open: false },
  showNewSession: false,
  newSessionProjectId: null,
  showSettings: false,
  showCommandPalette: false,
  showTaskRecovery: true,

  async init() {
    if (get().ready) return
    set({ ready: true })
    window.agentDesk.onSessionEvent((sessionId, event, seq, eventId) =>
      get().handleEvent(sessionId, event, seq, eventId)
    )
    window.agentDesk.onMemorySuggestion((event) => get().handleMemorySuggestion(event))
    window.agentDesk.onTerminalEvent((event) => get().handleTerminalEvent(event))
    window.agentDesk.onBrowserEvent((event) => get().handleBrowserEvent(event))
    // Sessions and persisted Office quality define the first usable workspace frame.
    // Secondary panels hydrate independently so they cannot block navigation or transcript recovery.
    const [metas, settings] = await Promise.all([
      window.agentDesk.listSessions(),
      window.agentDesk.getSettings()
    ])
    set((s) => {
      const sessions = { ...s.sessions }
      const order = [...s.order]
      for (const meta of metas) {
        if (!sessions[meta.id]) {
          sessions[meta.id] = drainPendingEvents(meta.id, newSessionState(meta))
          order.push(meta.id)
        }
      }
      return {
        hydrated: true,
        sessions,
        order,
        settings,
        activeId: s.activeId ?? order[0] ?? null
      }
    })
    // 渲染进程重载会丢掉未决权限请求 + 聊天记录;从主进程补回
    const transcriptHydration = Promise.all(
      metas.map(async (meta) => {
        const [permissionsResult, transcriptResult] = await Promise.allSettled([
          window.agentDesk.listPendingPermissions(meta.id),
          window.agentDesk.getTranscript(meta.id)
        ])
        if (permissionsResult.status === 'rejected') {
          console.warn(`Failed to restore pending permissions for ${meta.id}`, permissionsResult.reason)
        }
        if (transcriptResult.status === 'rejected') {
          console.warn(`Failed to restore transcript for ${meta.id}`, transcriptResult.reason)
        }
        const reqs = permissionsResult.status === 'fulfilled' ? permissionsResult.value : []
        const transcript = transcriptResult.status === 'fulfilled' ? transcriptResult.value : []
        if (reqs.length === 0 && transcript.length === 0) return
        set((s) => {
          const session = s.sessions[meta.id]
          if (!session) return s
          let next = session
          if (reqs.length > 0) {
            const known = new Set(session.pendingPermissions.map((p) => p.requestId))
            const merged = [...session.pendingPermissions, ...reqs.filter((r) => !known.has(r.requestId))]
            next = { ...next, pendingPermissions: merged }
          }
          if (transcript.length > 0) next = replayTranscript(next, transcript)
          return { sessions: { ...s.sessions, [meta.id]: next } }
        })
      })
    )
    const secondaryLabels = ['history', 'providers', 'projects', 'task recovery']
    const secondaryResults = await Promise.allSettled([
      window.agentDesk.listHistory().then((history) => set({ history })),
      window.agentDesk.listProviders().then((providers) => set({ providers })),
      window.agentDesk.listProjects().then((projects) => set({ projects })),
      get().hydrateTaskRecoveryCandidates()
    ])
    secondaryResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.warn(`Failed to hydrate ${secondaryLabels[index]}`, result.reason)
      }
    })
    await transcriptHydration
  },

  handleEvent(sessionId, event, seq, eventId) {
    if (event.kind === 'subagent-result' || event.kind === 'task-dag-update') {
      flushStreamBuffer(sessionId)
      set((s) => {
        const session = s.sessions[sessionId]
        if (!session) return s
        return { sessions: { ...s.sessions, [sessionId]: applyEvent(session, seq, event, eventId) } }
      })
      if (event.kind === 'task-dag-update') {
        void window.agentDesk.listSessions().then((metas) => {
          set((s) => {
            const sessions = { ...s.sessions }
            const order = [...s.order]
            for (const meta of metas) {
              sessions[meta.id] = sessions[meta.id]
                ? { ...sessions[meta.id], meta }
                : drainPendingEvents(meta.id, newSessionState(meta))
              if (!order.includes(meta.id)) order.push(meta.id)
            }
            return { sessions, order }
          })
        })
      }
      return
    }
    if (isStreamDelta(event)) {
      queueStreamDelta(sessionId, seq, event)
      return
    }
    flushStreamBuffer(sessionId)
    set((s) => {
      const session = s.sessions[sessionId]
      if (!session) {
        stashPendingEvent(sessionId, seq, event, eventId)
        return s
      }
      return { sessions: { ...s.sessions, [sessionId]: applyEvent(session, seq, event, eventId) } }
    })
    // init 到达意味着 sdkSessionId 已确定,转录文件已可读;触发回放(仅 resume 会话需要)
    if (event.kind === 'init' && event.sdkSessionId) {
      void window.agentDesk.getTranscript(sessionId).then((transcript) => {
        if (transcript.length === 0) return
        set((s) => {
          const session = s.sessions[sessionId]
          if (!session) return s
          return { sessions: { ...s.sessions, [sessionId]: replayTranscript(session, transcript) } }
        })
      })
    }
    if (event.kind === 'turn-result' || event.kind === 'init') {
      void window.agentDesk.listHistory().then((history) => set({ history }))
    }
    if (
      event.kind === 'assistant-message' ||
      event.kind === 'turn-result' ||
      (event.kind === 'status' && (event.status === 'error' || event.status === 'closed'))
    ) {
      clearStreamBuffer(sessionId)
    }
  },

  handleMemorySuggestion(event) {
    set((s) => {
      const current = s.workbench.memorySuggestion
      if (current?.sessionId === event.sessionId && current.text === event.text) return s
      return {
        workbench: {
          ...s.workbench,
          memorySuggestion: event
        }
      }
    })
  },

  handleTerminalEvent(event) {
    set((s) => {
      const current = s.workbench.terminal
      if (event.kind === 'started') {
        return {
          workbench: {
            ...s.workbench,
            terminal: event.terminal,
            terminalLoading: false,
            terminalError: undefined
          }
        }
      }
      if (event.kind === 'output') {
        if (current && current.id !== event.id) return s
        const next = `${s.workbench.terminalBuffer}${event.data}`
        return {
          workbench: {
            ...s.workbench,
            terminalBuffer: next.length > 80_000 ? next.slice(next.length - 80_000) : next
          }
        }
      }
      if (event.kind === 'exit') {
        if (current && current.id !== event.id) return s
        return {
          workbench: {
            ...s.workbench,
            terminal: current ? { ...current, exit: event.exit } : current,
            terminalError: event.exit.reason ? `终端已退出:${event.exit.reason}` : undefined
          }
        }
      }
      if (event.kind === 'error') {
        if (event.id && current && current.id !== event.id) return s
        return { workbench: { ...s.workbench, terminalError: event.message } }
      }
      return s
    })
  },

  handleBrowserEvent(event) {
    set((s) => {
      const activeId = s.activeId
      if (event.kind === 'state') {
        if (activeId && event.sessionId !== activeId) return s
        return {
          workbench: {
            ...s.workbench,
            browserState: event.state,
            browserUrlDraft: event.state.url,
            browserLoading: event.state.loading,
            browserError: undefined
          }
        }
      }
      if (event.kind === 'annotation') {
        if (activeId && event.sessionId !== activeId) return s
        const known = new Set(s.workbench.browserAnnotations.map((item) => item.id))
        return {
          workbench: {
            ...s.workbench,
            browserAnnotations: known.has(event.annotation.id)
              ? s.workbench.browserAnnotations
              : [event.annotation, ...s.workbench.browserAnnotations],
            browserMessage: '已保存网页批注'
          }
        }
      }
      if (event.kind === 'closed') {
        if (activeId && event.sessionId !== activeId) return s
        return {
          workbench: {
            ...s.workbench,
            browserOpen: false,
            browserState: undefined,
            browserLoading: false
          }
        }
      }
      if (event.kind === 'error') {
        if (event.sessionId && activeId && event.sessionId !== activeId) return s
        return { workbench: { ...s.workbench, browserError: event.message, browserLoading: false } }
      }
      return s
    })
  },

  async createSession(opts) {
    const meta = await window.agentDesk.createSession(opts)
    set((s) => ({
      sessions: {
        ...s.sessions,
        [meta.id]: drainPendingEvents(meta.id, s.sessions[meta.id] ?? newSessionState(meta))
      },
      order: s.order.includes(meta.id) ? s.order : [...s.order, meta.id],
      activeId: meta.id,
      showNewSession: false,
      newSessionProjectId: null
    }))
    // M2 缺陷修复:resume 会话的 init 事件先于本 IPC 返回抵达,被 stash 后
    // drain 只做 reduce,不会触发 handleEvent 里的 init→转录回放副作用,
    // 导致恢复的会话聊天记录空白。此处注册完成后主动补拉一次转录。
    if (opts.resumeSdkSessionId) {
      const transcript = await window.agentDesk.getTranscript(meta.id)
      if (transcript.length > 0) {
        set((s) => {
          const session = s.sessions[meta.id]
          if (!session) return s
          return { sessions: { ...s.sessions, [meta.id]: replayTranscript(session, transcript) } }
        })
      }
    }
    void get().refreshProjects() // 新会话的 cwd 已被主进程收藏,刷新项目列表
  },

  async startSessionWithPrompt(opts, prompt) {
    await get().createSession(opts) // 建完 activeId 已指向新会话
    const text = prompt.trim()
    if (text) await get().sendMessage(text)
  },

  async recoverTaskSnapshot(snapshotId) {
    set({ taskSnapshotsLoading: true, taskSnapshotsError: undefined })
    try {
      const previousId = get().activeId
      const meta = await window.agentDesk.recoverTaskSnapshot(snapshotId)
      if (previousId && previousId !== meta.id) closeNativeBrowserView(previousId)
      set((s) => {
        const current = s.sessions[meta.id]
        const base = current ? { ...current, meta } : newSessionState(meta)
        return {
          sessions: {
            ...s.sessions,
            [meta.id]: drainPendingEvents(meta.id, base)
          },
          order: s.order.includes(meta.id) ? s.order : [...s.order, meta.id],
          activeId: meta.id
        }
      })
      const transcript = await window.agentDesk.getTranscript(meta.id)
      if (transcript.length > 0) {
        set((s) => {
          const session = s.sessions[meta.id]
          if (!session) return s
          return { sessions: { ...s.sessions, [meta.id]: replayTranscript(session, transcript) } }
        })
      }
      const [history, projects, taskSnapshots] = await Promise.all([
        window.agentDesk.listHistory(),
        window.agentDesk.listProjects(),
        window.agentDesk.listTaskSnapshots()
      ])
      set({ history, projects, taskSnapshots, taskSnapshotsLoading: false, taskSnapshotsError: undefined })
    } catch (err) {
      set({
        taskSnapshotsLoading: false,
        taskSnapshotsError: err instanceof Error ? err.message : String(err)
      })
    }
  },
  ...createTaskRecoveryActions((update) => set(update), get),

  async dispatchSubagents(input) {
    const parentId = get().activeId
    if (!parentId) return undefined
    const result = await window.agentDesk.dispatchSubagents(parentId, input)
    set((s) => {
      const sessions = { ...s.sessions }
      const order = [...s.order]
      for (const child of result.children) {
        sessions[child.meta.id] = drainPendingEvents(
          child.meta.id,
          sessions[child.meta.id] ?? newSessionState(child.meta)
        )
        if (!order.includes(child.meta.id)) order.push(child.meta.id)
      }
      return { sessions, order }
    })
    void get().refreshProjects()
    return result
  },

  async decomposeAndDispatchTaskDag(request, options) {
    const parentId = get().activeId
    const text = request.trim()
    if (!parentId || !text) return undefined
    set((s) => ({
      workbench: {
        ...s.workbench,
        subagentBusy: true,
        subagentError: undefined,
        subagentMessage: undefined
      }
    }))
    try {
      const decompose = await window.agentDesk.decomposeTask(parentId, { request: text })
      const verificationCommand = options?.verificationCommand?.trim()
      const result = await window.agentDesk.dispatchTaskDag(parentId, {
        dag: decompose.dag,
        autoMerge: options?.autoMerge === true,
        ...(verificationCommand ? { verificationCommand } : {})
      })
      set((s) => {
        const sessions = { ...s.sessions }
        const order = [...s.order]
        for (const child of result.children) {
          sessions[child.meta.id] = drainPendingEvents(
            child.meta.id,
            sessions[child.meta.id] ?? newSessionState(child.meta)
          )
          if (!order.includes(child.meta.id)) order.push(child.meta.id)
        }
        if (sessions[parentId]) {
          sessions[parentId] = {
            ...sessions[parentId],
            taskDagExecution: result.execution
          }
        }
        return {
          sessions,
          order,
          workbench: {
            ...s.workbench,
            subagentBusy: false,
            subagentMessage: `已拆解为 ${result.execution.tasks.length} 个 DAG 子任务`,
            subagentError: undefined
          }
        }
      })
      void get().refreshProjects()
      return result
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          subagentBusy: false,
          subagentError: err instanceof Error ? err.message : String(err)
        }
      }))
      return undefined
    }
  },

  async resumeFromHistory(entry) {
    await get().createSession({
      cwd: entry.cwd,
      projectId: entry.projectId,
      unassigned: entry.unassigned,
      model: entry.model,
      providerId: entry.providerId,
      routingScope: entry.routingScope,
      engine: entry.engine,
      permissionMode: entry.permissionMode,
      resumeSdkSessionId: entry.sdkSessionId,
      resumeSessionAt: entry.resumeSessionAt,
      title: entry.title
    })
  },

  selectSession(id) {
    const previousId = get().activeId
    if (previousId && previousId !== id) closeNativeBrowserView(previousId)
    set((s) => ({
      activeId: id,
      showNewSession: false,
      newSessionProjectId: null,
      workbench:
        previousId && previousId !== id
          ? {
              ...s.workbench,
              browserState: undefined,
              browserAnnotations: [],
              browserLoading: false,
              browserError: undefined,
              browserMessage: undefined
            }
          : s.workbench
    }))
  },

  async sendMessage(input) {
    const id = get().activeId
    if (!id) return
    const payload: SendMessagePayload =
      typeof input === 'string'
        ? { text: input.trim() }
        : {
            text: input.text.trim(),
            images: input.images
          }
    const displayText =
      payload.text || (payload.images && payload.images.length > 0 ? `图片输入 (${payload.images.length} 张)` : '')
    if (!displayText && (!payload.images || payload.images.length === 0)) return
    set((s) => {
      const session = s.sessions[id]
      if (!session) return s
      return {
        sessions: {
          ...s.sessions,
          [id]: {
            ...session,
            items: [
              ...session.items,
              {
                id: genId(),
                kind: 'user',
                text: displayText,
                attachments: payload.images?.map((image) => ({
                  id: image.id,
                  mime: image.mime,
                  bytes: image.bytes
                }))
              }
            ],
            meta: { ...session.meta, status: 'running' }
          }
        }
      }
    })
    await window.agentDesk.sendMessage(id, payload)
  },

  async sendQuickbarClipboard(options) {
    try {
      const target = await ensureQuickbarSession(get, options)
      const result = await window.agentDesk.quickbarReadClipboard({
        cwd: target.cwd,
        note: options.note,
        includeWindowContext: true
      })
      if (!result.ok || !result.payload) return { ok: false, sessionId: target.sessionId, error: result.error }
      await sendQuickbarPayload(get, target.sessionId, result.payload)
      return { ok: true, sessionId: target.sessionId }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async sendQuickbarScreenshot(options) {
    try {
      const target = await ensureQuickbarSession(get, options)
      const result = await window.agentDesk.quickbarCaptureScreenshot({
        sessionId: target.sessionId,
        cwd: target.cwd,
        sourceId: options.sourceId,
        note: options.note,
        includeWindowContext: true
      })
      if (!result.ok || !result.payload) return { ok: false, sessionId: target.sessionId, error: result.error }
      await sendQuickbarPayload(get, target.sessionId, result.payload)
      return { ok: true, sessionId: target.sessionId }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async sendQuickbarFiles(options) {
    try {
      const target = await ensureQuickbarSession(get, options)
      const result = await window.agentDesk.quickbarPrepareFiles({
        cwd: target.cwd,
        paths: options.paths ?? [],
        note: options.note,
        includeWindowContext: true
      })
      if (!result.ok || !result.payload) return { ok: false, sessionId: target.sessionId, error: result.error }
      await sendQuickbarPayload(get, target.sessionId, result.payload)
      return { ok: true, sessionId: target.sessionId }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async interrupt() {
    const id = get().activeId
    if (!id) return
    await window.agentDesk.interrupt(id)
    const [metas, history, taskSnapshots] = await Promise.all([
      window.agentDesk.listSessions(),
      window.agentDesk.listHistory(),
      window.agentDesk.listTaskSnapshots()
    ])
    const interruptedMeta = metas.find((meta) => meta.id === id)
    if (!interruptedMeta) {
      closeNativeBrowserView(id)
      pendingEvents.delete(id)
    }
    set((s) => {
      if (interruptedMeta) {
        const session = s.sessions[id]
        return {
          sessions: session
            ? { ...s.sessions, [id]: { ...session, meta: interruptedMeta } }
            : s.sessions,
          history,
          taskSnapshots
        }
      }
      const sessions = { ...s.sessions }
      delete sessions[id]
      const order = s.order.filter((sessionId) => sessionId !== id)
      return {
        sessions,
        order,
        activeId: s.activeId === id ? (order[order.length - 1] ?? null) : s.activeId,
        history,
        taskSnapshots
      }
    })
  },

  async closeSession(id) {
    closeNativeBrowserView(id)
    await window.agentDesk.closeSession(id)
    pendingEvents.delete(id)
    const [historyResult, taskSnapshotsResult] = await Promise.allSettled([
      window.agentDesk.listHistory(),
      window.agentDesk.listTaskSnapshots()
    ])
    set((s) => {
      const sessions = { ...s.sessions }
      delete sessions[id]
      const order = s.order.filter((x) => x !== id)
      const requestedActiveId = s.activeId === id ? null : s.activeId
      const activeId = requestedActiveId && sessions[requestedActiveId]
        ? requestedActiveId
        : (order[order.length - 1] ?? null)
      return {
        sessions,
        order,
        activeId,
        history: historyResult.status === 'fulfilled' ? historyResult.value : s.history,
        taskSnapshots: taskSnapshotsResult.status === 'fulfilled' ? taskSnapshotsResult.value : s.taskSnapshots,
        taskSnapshotsLoading: false,
        taskSnapshotsError:
          taskSnapshotsResult.status === 'rejected'
            ? taskSnapshotsResult.reason instanceof Error
              ? taskSnapshotsResult.reason.message
              : String(taskSnapshotsResult.reason)
            : undefined,
        showNewSession: activeId === null ? true : s.showNewSession,
        newSessionProjectId: activeId === null ? null : s.newSessionProjectId,
        showTaskRecovery: false,
        view: activeId === null ? 'list' : s.view
      }
    })
  },

  async respondPermission(sessionId, requestId, allow, message) {
    await window.agentDesk.respondPermission(sessionId, requestId, allow, message)
    if (message === 'gui-temporary-grant:5m') {
      const settings = await window.agentDesk.getSettings()
      set({ settings })
    }
  },

  async restoreCheckpoint(messageId, mode, dryRun) {
    const id = get().activeId
    if (!id) return undefined
    const result = await window.agentDesk.restoreCheckpoint(id, messageId, mode, dryRun)
    if (!dryRun && result.transcript) {
      set((s) => {
        const session = s.sessions[id]
        if (!session) return s
        return { sessions: { ...s.sessions, [id]: replaceTranscript(session, result.transcript ?? []) } }
      })
    }
    return result
  },

  async setPermissionMode(mode) {
    const id = get().activeId
    if (id) await window.agentDesk.setPermissionMode(id, mode)
  },

  async setModel(model) {
    const id = get().activeId
    if (id) await window.agentDesk.setModel(id, model)
  },

  async renameSession(id, title) {
    const t = title.trim()
    if (!t) return
    // 本地即时更新 + 主进程持久化
    set((s) => {
      const session = s.sessions[id]
      if (!session) return s
      return {
        sessions: { ...s.sessions, [id]: { ...session, meta: { ...session.meta, title: t } } }
      }
    })
    await window.agentDesk.renameSession(id, t)
  },

  async archiveHistory(id, archived) {
    await window.agentDesk.setHistoryArchived(id, archived)
    const history = await window.agentDesk.listHistory()
    set({ history })
  },

  async pinHistory(id, pinned) {
    await window.agentDesk.setHistoryPinned(id, pinned)
    const history = await window.agentDesk.listHistory()
    set({ history })
  },

  async renameHistoryEntry(id, title) {
    const t = title.trim()
    if (!t) return
    await window.agentDesk.renameHistory(id, t)
    const history = await window.agentDesk.listHistory()
    set({ history })
  },

  async deleteHistoryEntry(id) {
    await window.agentDesk.deleteHistory(id)
    const history = await window.agentDesk.listHistory()
    set({ history })
  },

  setSidebarQuery(q) {
    set({ sidebarQuery: q })
    // 全文搜索防抖 300ms;<2 字符不搜,直接清空结果
    if (transcriptSearchTimer !== null) window.clearTimeout(transcriptSearchTimer)
    transcriptSearchTimer = null
    const trimmed = q.trim()
    if (trimmed.length < 2) {
      set({ transcriptSearchResults: [], transcriptSearchLoading: false })
      return
    }
    set({ transcriptSearchLoading: true })
    const token = ++transcriptSearchToken
    transcriptSearchTimer = window.setTimeout(() => {
      transcriptSearchTimer = null
      void window.agentDesk
        .searchTranscripts(trimmed)
        .then((results) => {
          if (token !== transcriptSearchToken) return // 已有更新的搜索,丢弃过期结果
          set({ transcriptSearchResults: results, transcriptSearchLoading: false })
        })
        .catch(() => {
          if (token !== transcriptSearchToken) return
          set({ transcriptSearchResults: [], transcriptSearchLoading: false })
        })
    }, 300)
  },

  async openTranscriptSearchHit(result) {
    const state = get()
    // 已打开的会话直接切换
    const openId = state.order.find(
      (id) => state.sessions[id]?.meta.sdkSessionId === result.sdkSessionId
    )
    if (openId) {
      state.selectSession(openId)
      return
    }
    // 未打开:找到对应历史条目,走既有恢复路径
    const entry = state.history.find((item) => item.sdkSessionId === result.sdkSessionId)
    if (entry) await state.resumeFromHistory(entry)
  },

  async updateSettings(patch) {
    const settings = await window.agentDesk.updateSettings(patch)
    set({ settings })
  },

  setView(view) {
    set({ view })
  },

  async openDiffPanel() {
    closeNativeBrowserView(get().activeId)
    set((s) => ({
      workbench: {
        ...s.workbench,
        diffOpen: true,
        worktreeOpen: false,
        terminalOpen: false,
        filesOpen: false,
        browserOpen: false,
        previewOpen: false,
        pluginRegistryOpen: false,
        subagentOpen: false,
        routineOpen: false,
        memoryOpen: false
      }
    }))
    await Promise.all([get().refreshDiffPanel(), get().refreshGitStatus()])
  },

  closeDiffPanel() {
    set((s) => ({ workbench: { ...s.workbench, diffOpen: false } }))
  },

  async refreshDiffPanel() {
    const id = get().activeId
    if (!id) return
    set((s) => ({ workbench: { ...s.workbench, diffLoading: true, diffError: undefined } }))
    try {
      const diff = await window.agentDesk.getWorkspaceDiff(id)
      set((s) => ({
        workbench: {
          ...s.workbench,
          diffOpen: true,
          diff,
          diffLoading: false,
          diffError: diff.ok ? undefined : diff.error
        }
      }))
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          diffLoading: false,
          diffError: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  },

  async refreshGitStatus() {
    const id = get().activeId
    if (!id) return
    set((s) => ({ workbench: { ...s.workbench, gitLoading: true, gitError: undefined } }))
    try {
      const status = await window.agentDesk.gitStatus(id)
      set((s) => ({
        workbench: {
          ...s.workbench,
          gitStatus: status,
          gitLoading: false,
          gitError: status.ok ? undefined : status.error
        }
      }))
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          gitLoading: false,
          gitError: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  },

  async applyWorkspaceHunk(filePath, hunkPatch, hunkKey) {
    const id = get().activeId
    if (!id) return undefined
    set((s) => ({
      workbench: {
        ...s.workbench,
        hunkBusyKey: hunkKey,
        diffError: undefined,
        diffMessage: undefined,
        gitError: undefined,
        gitMessage: undefined
      }
    }))
    const result = await window.agentDesk.applyWorkspaceHunk(id, filePath, hunkPatch)
    set((s) => ({
      workbench: {
        ...s.workbench,
        hunkBusyKey: undefined,
        diffMessage: result.ok ? '已暂存 hunk' : undefined,
        diffError: result.ok ? undefined : result.error
      }
    }))
    await Promise.all([get().refreshDiffPanel(), get().refreshGitStatus()])
    return result
  },

  async discardWorkspaceHunk(filePath, hunkPatch, hunkKey) {
    const id = get().activeId
    if (!id) return undefined
    set((s) => ({
      workbench: {
        ...s.workbench,
        hunkBusyKey: hunkKey,
        diffError: undefined,
        diffMessage: undefined,
        gitError: undefined,
        gitMessage: undefined
      }
    }))
    const result = await window.agentDesk.discardWorkspaceHunk(id, filePath, hunkPatch)
    set((s) => ({
      workbench: {
        ...s.workbench,
        hunkBusyKey: undefined,
        diffMessage: result.ok ? '已丢弃 hunk' : undefined,
        diffError: result.ok ? undefined : result.error
      }
    }))
    await Promise.all([get().refreshDiffPanel(), get().refreshGitStatus(), ...(result.effectStatus === 'waiting_reconciliation' ? [get().refreshTaskSnapshots()] : [])])
    return result
  },

  async stageGitFiles(paths) {
    const id = get().activeId
    if (!id) return undefined
    set((s) => ({ workbench: { ...s.workbench, gitBusy: true, gitError: undefined, gitMessage: undefined } }))
    const result = await window.agentDesk.stageFiles(id, paths)
    set((s) => ({
      workbench: {
        ...s.workbench,
        gitBusy: false,
        gitMessage: result.ok ? '已暂存选中文件' : undefined,
        gitError: result.ok ? undefined : result.error
      }
    }))
    await Promise.all([get().refreshGitStatus(), get().refreshDiffPanel()])
    return result
  },

  async stageAllGitFiles() {
    const id = get().activeId
    if (!id) return undefined
    set((s) => ({ workbench: { ...s.workbench, gitBusy: true, gitError: undefined, gitMessage: undefined } }))
    const result = await window.agentDesk.stageAll(id)
    set((s) => ({
      workbench: {
        ...s.workbench,
        gitBusy: false,
        gitMessage: result.ok ? '已暂存全部改动' : undefined,
        gitError: result.ok ? undefined : result.error
      }
    }))
    await Promise.all([get().refreshGitStatus(), get().refreshDiffPanel()])
    return result
  },

  async unstageGitFiles(paths) {
    const id = get().activeId
    if (!id) return undefined
    set((s) => ({ workbench: { ...s.workbench, gitBusy: true, gitError: undefined, gitMessage: undefined } }))
    const result = await window.agentDesk.unstageFiles(id, paths)
    set((s) => ({
      workbench: {
        ...s.workbench,
        gitBusy: false,
        gitMessage: result.ok ? '已取消暂存选中文件' : undefined,
        gitError: result.ok ? undefined : result.error
      }
    }))
    await Promise.all([get().refreshGitStatus(), get().refreshDiffPanel()])
    return result
  },

  async commitGit(message) {
    const id = get().activeId
    if (!id) return undefined
    set((s) => ({ workbench: { ...s.workbench, gitBusy: true, gitError: undefined, gitMessage: undefined } }))
    const result = await window.agentDesk.gitCommit(id, message)
    set((s) => ({
      workbench: {
        ...s.workbench,
        gitBusy: false,
        gitMessage: result.ok ? `已提交 ${result.sha.slice(0, 8)}` : undefined,
        gitError: result.ok ? undefined : result.error
      }
    }))
    await Promise.all([get().refreshGitStatus(), get().refreshDiffPanel()])
    return result
  },

  async openWorktreePanel() {
    closeNativeBrowserView(get().activeId)
    set((s) => ({
      workbench: {
        ...s.workbench,
        diffOpen: false,
        worktreeOpen: true,
        worktreeMergeSummary: undefined,
        worktreeMergePatch: undefined,
        worktreeApplyCheck: undefined,
        worktreeApplyResult: undefined,
        worktreePrResult: undefined,
        worktreeConflictFiles: undefined,
        worktreeConflictLoading: false,
        worktreeLastReceipt: undefined,
        worktreeMergeInspecting: false,
        worktreeApplying: false,
        worktreeCreatingPr: false,
        terminalOpen: false,
        filesOpen: false,
        browserOpen: false,
        previewOpen: false,
        pluginRegistryOpen: false,
        subagentOpen: false,
        routineOpen: false,
        memoryOpen: false
      }
    }))
    await get().refreshWorktreePanel()
  },

  closeWorktreePanel() {
    set((s) => ({ workbench: { ...s.workbench, worktreeOpen: false } }))
  },

  async refreshWorktreePanel() {
    const id = get().activeId
    if (!id) return
    set((s) => ({
      workbench: {
        ...s.workbench,
        worktreeLoading: true,
        worktreeApplyResult: undefined,
        worktreeError: undefined,
        worktreeMessage: undefined
      }
    }))
    try {
      const worktree = await window.agentDesk.getWorktreeSummary(id)
      set((s) => ({
        workbench: {
          ...s.workbench,
          worktree,
          worktreeLoading: false,
          worktreeError: worktree.ok ? undefined : worktree.error
        }
      }))
      // 顺带刷新最近一条合并回执(失败静默,不影响面板主数据)。
      await get().refreshWorktreeMergeReceipt()
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          worktreeLoading: false,
          worktreeError: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  },

  async exportWorktreePatch() {
    const id = get().activeId
    if (!id) return undefined
    const result = await window.agentDesk.exportWorktreePatch(id)
    set((s) => ({
      workbench: {
        ...s.workbench,
        worktreeMessage: result.ok ? `Patch 已导出: ${result.path}` : undefined,
        worktreeError: result.ok ? undefined : result.error
      }
    }))
    return result
  },

  async inspectWorktreeMerge() {
    const id = get().activeId
    if (!id) return
    set((s) => ({
      workbench: {
        ...s.workbench,
        worktreeMergeInspecting: true,
        worktreeApplyResult: undefined,
        worktreeConflictFiles: undefined,
        worktreeConflictLoading: false,
        worktreeError: undefined,
        worktreeMessage: undefined
      }
    }))
    try {
      const [summary, patch, applyCheck] = await Promise.all([
        window.agentDesk.inspectWorktreeMerge(id),
        window.agentDesk.createWorktreeMergePatch(id),
        window.agentDesk.checkWorktreeApply(id)
      ])
      const firstError =
        !summary.ok
          ? summary.error
          : !patch.ok
            ? patch.error
            : !applyCheck.ok
              ? applyCheck.error
              : !applyCheck.canApply
                ? applyCheck.error
                : undefined
      set((s) => ({
        workbench: {
          ...s.workbench,
          worktreeMergeSummary: summary,
          worktreeMergePatch: patch,
          worktreeApplyCheck: applyCheck,
          worktreeMergeInspecting: false,
          worktreeError: firstError,
          worktreeMessage: firstError ? undefined : '合并检查通过，可应用到主工作区'
        }
      }))
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          worktreeMergeInspecting: false,
          worktreeError: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  },

  async applyWorktreePatch() {
    const id = get().activeId
    if (!id) return undefined
    set((s) => ({
      workbench: {
        ...s.workbench,
        worktreeApplying: true,
        worktreeApplyResult: undefined,
        worktreeError: undefined,
        worktreeMessage: undefined
      }
    }))
    try {
      const result = await window.agentDesk.applyWorktreePatch(id)
      const worktree = await window.agentDesk.getWorktreeSummary(id).catch(() => undefined)
      set((s) => ({
        workbench: {
          ...s.workbench,
          ...(worktree ? { worktree } : {}),
          worktreeApplyResult: result,
          worktreeApplying: false,
          worktreeError: result.ok ? undefined : result.error,
          worktreeMessage: result.ok
            ? result.applied
              ? `已应用 ${result.changedFiles} 个文件到主工作区`
              : '没有需要应用的改动'
            : undefined
        }
      }))
      // 合并成功会写回执,刷新"上次合并"展示。
      if (result.ok) await get().refreshWorktreeMergeReceipt()
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set((s) => ({
        workbench: {
          ...s.workbench,
          worktreeApplying: false,
          worktreeError: message
        }
      }))
      return { ok: false, error: message }
    }
  },

  async loadWorktreeConflictFiles() {
    const id = get().activeId
    if (!id) return
    set((s) => ({
      workbench: { ...s.workbench, worktreeConflictLoading: true, worktreeConflictFiles: undefined }
    }))
    try {
      const result = await window.agentDesk.getWorktreeConflictFiles(id)
      set((s) => ({
        workbench: { ...s.workbench, worktreeConflictFiles: result, worktreeConflictLoading: false }
      }))
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          worktreeConflictFiles: { ok: false, error: err instanceof Error ? err.message : String(err) },
          worktreeConflictLoading: false
        }
      }))
    }
  },

  async refreshWorktreeMergeReceipt() {
    const id = get().activeId
    if (!id) return
    try {
      const receipts = await window.agentDesk.listWorktreeMergeReceipts()
      // 回执按 mergedAt 倒序返回,取当前会话最近一条。
      const last = receipts.find((item) => item.sessionId === id)
      set((s) => ({ workbench: { ...s.workbench, worktreeLastReceipt: last } }))
    } catch {
      // 回执是附加验收信息,拉取失败静默即可。
    }
  },

  async createWorktreePullRequest() {
    const id = get().activeId
    if (!id) return undefined
    set((s) => ({
      workbench: {
        ...s.workbench,
        worktreeCreatingPr: true,
        worktreePrResult: undefined,
        worktreeError: undefined,
        worktreeMessage: undefined
      }
    }))
    try {
      const result = await window.agentDesk.createWorktreePullRequest(id)
      set((s) => ({
        workbench: {
          ...s.workbench,
          worktreePrResult: result,
          worktreeCreatingPr: false,
          worktreeError: result.ok ? undefined : result.error,
          worktreeMessage: result.ok
            ? result.created
              ? `已创建 PR: ${result.url}`
              : result.message
            : undefined
        }
      }))
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set((s) => ({
        workbench: {
          ...s.workbench,
          worktreeCreatingPr: false,
          worktreeError: message
        }
      }))
      return { ok: false, error: message }
    }
  },

  async removeWorktree(opts) {
    const id = get().activeId
    if (!id) return undefined
    const result = await window.agentDesk.removeWorktree(id, opts)
    set((s) => {
      const session = s.sessions[id]
      return {
        sessions:
          session && result.ok
            ? {
                ...s.sessions,
                [id]: {
                  ...session,
                  meta: {
                    ...session.meta,
                    worktreeState: result.record?.state ?? 'removed'
                  }
                }
              }
            : s.sessions,
        workbench: {
          ...s.workbench,
          worktree: result.ok
            ? s.workbench.worktree
              ? { ...s.workbench.worktree, record: result.record, dirty: false }
              : s.workbench.worktree
            : s.workbench.worktree,
          worktreeMessage: result.ok ? '隔离 worktree 已丢弃' : undefined,
          worktreeError: result.ok ? undefined : result.error
        }
      }
    })
    return result
  },

  async openTerminalPanel() {
    closeNativeBrowserView(get().activeId)
    set((s) => ({
      workbench: {
        ...s.workbench,
        diffOpen: false,
        worktreeOpen: false,
        terminalOpen: true,
        filesOpen: false,
        browserOpen: false,
        previewOpen: false,
        pluginRegistryOpen: false,
        subagentOpen: false,
        routineOpen: false,
        memoryOpen: false
      }
    }))
    await get().startTerminal()
  },

  closeTerminalPanel() {
    set((s) => ({ workbench: { ...s.workbench, terminalOpen: false } }))
  },

  async startTerminal() {
    const id = get().activeId
    if (!id) return
    set((s) => ({ workbench: { ...s.workbench, terminalLoading: true, terminalError: undefined } }))
    try {
      const terminal = await window.agentDesk.startTerminal(id, { cols: 100, rows: 28, reuse: true })
      set((s) => ({
        workbench: {
          ...s.workbench,
          terminal,
          terminalLoading: false,
          terminalBuffer: s.workbench.terminal?.id === terminal.id ? s.workbench.terminalBuffer : ''
        }
      }))
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          terminalLoading: false,
          terminalError: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  },

  async sendTerminalInput(text) {
    const terminal = get().workbench.terminal
    if (!terminal || terminal.exit) return
    await window.agentDesk.writeTerminal(terminal.id, text)
  },

  async closeTerminal() {
    const terminal = get().workbench.terminal
    if (!terminal) return
    await window.agentDesk.closeTerminal(terminal.id)
    set((s) => ({
      workbench: {
        ...s.workbench,
        terminal: undefined,
        terminalBuffer: '',
        terminalError: undefined
      }
    }))
  },

  async openFilesPanel() {
    closeNativeBrowserView(get().activeId)
    set((s) => ({
      workbench: {
        ...s.workbench,
        diffOpen: false,
        worktreeOpen: false,
        terminalOpen: false,
        filesOpen: true,
        browserOpen: false,
        previewOpen: false,
        pluginRegistryOpen: false,
        subagentOpen: false,
        routineOpen: false,
        memoryOpen: false
      }
    }))
    await get().refreshFilesPanel()
  },

  closeFilesPanel() {
    set((s) => ({ workbench: { ...s.workbench, filesOpen: false } }))
  },

  async refreshFilesPanel() {
    const id = get().activeId
    if (!id) return
    set((s) => ({
      workbench: {
        ...s.workbench,
        filesLoading: true,
        filesError: undefined,
        fileMessage: undefined
      }
    }))
    try {
      const result = await window.agentDesk.listProjectFiles(id)
      set((s) => ({
        workbench: {
          ...s.workbench,
          filesOpen: true,
          filesLoading: false,
          fileEntries: result.ok ? result.entries : s.workbench.fileEntries,
          filesRoot: result.ok ? result.root : s.workbench.filesRoot,
          filesTruncated: result.truncated,
          filesError: result.ok ? undefined : result.error
        }
      }))
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          filesLoading: false,
          filesError: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  },

  async openFile(path) {
    const id = get().activeId
    if (!id) return
    set((s) => ({
      workbench: {
        ...s.workbench,
        filesOpen: true,
        fileLoading: true,
        fileError: undefined,
        fileMessage: undefined
      }
    }))
    try {
      const result = await window.agentDesk.readTextFile(id, path)
      set((s) => ({
        workbench: result.ok
          ? {
              ...s.workbench,
              fileLoading: false,
              currentFilePath: result.path,
              currentFileContent: result.content ?? '',
              savedFileContent: result.content ?? '',
              currentFileBytes: result.bytes,
              currentFileMtimeMs: result.mtimeMs,
              fileError: undefined
            }
          : {
              ...s.workbench,
              fileLoading: false,
              fileError: result.error
            }
      }))
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          fileLoading: false,
          fileError: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  },

  updateFileDraft(content) {
    set((s) => ({ workbench: { ...s.workbench, currentFileContent: content, fileMessage: undefined } }))
  },

  async saveOpenFile() {
    const id = get().activeId
    const { currentFilePath, currentFileContent } = get().workbench
    if (!id || !currentFilePath) return undefined
    set((s) => ({
      workbench: {
        ...s.workbench,
        fileSaving: true,
        fileError: undefined,
        fileMessage: undefined
      }
    }))
    try {
      const result = await window.agentDesk.writeTextFile(id, currentFilePath, currentFileContent)
      set((s) => ({
        workbench: result.ok
          ? {
              ...s.workbench,
              fileSaving: false,
              savedFileContent: currentFileContent,
              currentFileBytes: result.bytes,
              currentFileMtimeMs: result.mtimeMs,
              fileMessage: `已保存 ${result.path ?? currentFilePath}`,
              fileError: undefined
            }
          : {
              ...s.workbench,
              fileSaving: false,
              fileError: result.error
            }
      }))
      if (result.ok) void get().refreshFilesPanel()
      return result
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          fileSaving: false,
          fileError: err instanceof Error ? err.message : String(err)
        }
      }))
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async openPreviewPanel(path) {
    closeNativeBrowserView(get().activeId)
    const nextPath = path ?? get().workbench.previewPath ?? get().workbench.currentFilePath
    const pathChanged = Boolean(nextPath && nextPath !== get().workbench.previewPath)
    if (pathChanged) {
      previewRequestSeq += 1
      previewVisualRequestSeq += 1
    }
    set((s) => ({
      workbench: {
        ...s.workbench,
        diffOpen: false,
        worktreeOpen: false,
        terminalOpen: false,
        filesOpen: false,
        browserOpen: false,
        previewOpen: true,
        pluginRegistryOpen: false,
        subagentOpen: false,
        routineOpen: false,
        memoryOpen: false,
        previewPath: nextPath,
        previewError: undefined,
        ...(pathChanged
          ? {
              preview: undefined,
              previewAnnotations: [],
              previewLoading: false,
              previewVisual: undefined,
              previewVisualLoading: false,
              previewVisualError: undefined
            }
          : {})
      }
    }))
    await get().refreshPreviewPanel()
  },

  closePreviewPanel() {
    previewRequestSeq += 1
    previewVisualRequestSeq += 1
    set((s) => ({
      workbench: {
        ...s.workbench,
        previewOpen: false,
        previewLoading: false,
        previewVisualLoading: false
      }
    }))
  },

  async refreshPreviewPanel() {
    const id = get().activeId
    const path = get().workbench.previewPath
    if (!id || !path) return
    const requestId = ++previewRequestSeq
    const visualRequestId = ++previewVisualRequestSeq
    set((s) => ({
      workbench: {
        ...s.workbench,
        previewLoading: true,
        previewError: undefined,
        previewVisual: undefined,
        previewVisualLoading: false,
        previewVisualError: undefined
      }
    }))
    const annotationsPromise = window.agentDesk.listPreviewAnnotations(id, path).catch(() => [])
    try {
      const preview = await window.agentDesk.preparePreview(id, path)
      if (
        requestId !== previewRequestSeq ||
        get().activeId !== id ||
        get().workbench.previewPath !== path
      ) {
        return
      }
      const shouldPrepareVisual = preview.ok && preview.type === 'office'
      set((s) => ({
        workbench: {
          ...s.workbench,
          previewOpen: true,
          preview,
          previewLoading: false,
          previewError: preview.ok ? undefined : preview.error,
          previewVisualLoading: shouldPrepareVisual
        }
      }))

      if (shouldPrepareVisual) {
        void window.agentDesk
          .preparePreviewVisual(id, path)
          .then((visual) => {
            if (
              visualRequestId !== previewVisualRequestSeq ||
              get().activeId !== id ||
              get().workbench.previewPath !== path
            ) {
              return
            }
            set((s) => ({
              workbench: {
                ...s.workbench,
                previewVisual: visual.ok ? visual : undefined,
                previewVisualLoading: false,
                previewVisualError: visual.ok ? undefined : visual.error
              }
            }))
          })
          .catch((error) => {
            if (
              visualRequestId !== previewVisualRequestSeq ||
              get().activeId !== id ||
              get().workbench.previewPath !== path
            ) {
              return
            }
            set((s) => ({
              workbench: {
                ...s.workbench,
                previewVisualLoading: false,
                previewVisualError: error instanceof Error ? error.message : String(error)
              }
            }))
          })
      }

      const annotations = await annotationsPromise
      if (
        requestId === previewRequestSeq &&
        get().activeId === id &&
        get().workbench.previewPath === path
      ) {
        set((s) => ({ workbench: { ...s.workbench, previewAnnotations: annotations } }))
      }
    } catch (err) {
      if (
        requestId !== previewRequestSeq ||
        get().activeId !== id ||
        get().workbench.previewPath !== path
      ) {
        return
      }
      set((s) => ({
        workbench: {
          ...s.workbench,
          previewLoading: false,
          previewVisualLoading: false,
          previewError: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  },

  async savePreviewAnnotation(note, locator) {
    const id = get().activeId
    const { preview, previewPath } = get().workbench
    const cleanNote = note.trim()
    const path = preview?.path ?? previewPath
    if (!id || !path || !cleanNote) return
    try {
      const annotation = await window.agentDesk.savePreviewAnnotation(id, {
        sessionId: id,
        path,
        type: preview?.type ?? null,
        mime: preview?.mime ?? null,
        note: cleanNote,
        locator: locator ?? null
      })
      set((s) => {
        const known = new Set(s.workbench.previewAnnotations.map((item) => item.id))
        return {
          workbench: {
            ...s.workbench,
            previewAnnotations: known.has(annotation.id)
              ? s.workbench.previewAnnotations
              : [annotation, ...s.workbench.previewAnnotations],
            previewError: undefined
          }
        }
      })
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          previewError: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  },

  async refreshPreviewAnnotations() {
    const id = get().activeId
    const path = get().workbench.previewPath
    if (!id) return
    const annotations = await window.agentDesk.listPreviewAnnotations(id, path)
    set((s) => ({ workbench: { ...s.workbench, previewAnnotations: annotations } }))
  },

  async openBrowserPanel(url) {
    const id = get().activeId
    if (!id) return
    set((s) => ({
      workbench: {
        ...s.workbench,
        diffOpen: false,
        worktreeOpen: false,
        terminalOpen: false,
        filesOpen: false,
        previewOpen: false,
        browserOpen: true,
        pluginRegistryOpen: false,
        subagentOpen: false,
        routineOpen: false,
        memoryOpen: false,
        browserLoading: true,
        browserError: undefined,
        browserMessage: undefined
      }
    }))
    try {
      const state = await window.agentDesk.openBrowser(id, url)
      const annotations = await window.agentDesk.listBrowserAnnotations(id).catch(() => [])
      set((s) => ({
        workbench: {
          ...s.workbench,
          browserOpen: true,
          browserLoading: state.loading,
          browserState: state,
          browserUrlDraft: state.url,
          browserAnnotations: annotations,
          browserError: undefined
        }
      }))
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          browserLoading: false,
          browserError: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  },

  async closeBrowserPanel() {
    const id = get().activeId
    if (id) await window.agentDesk.closeBrowser(id).catch(() => undefined)
    set((s) => ({
      workbench: {
        ...s.workbench,
        browserOpen: false,
        browserLoading: false,
        browserError: undefined
      }
    }))
  },

  async navigateBrowser(url) {
    const id = get().activeId
    const target = url.trim()
    if (!id || !target) return
    set((s) => ({ workbench: { ...s.workbench, browserLoading: true, browserError: undefined } }))
    try {
      const state = await window.agentDesk.navigateBrowser(id, target)
      set((s) => ({
        workbench: {
          ...s.workbench,
          browserState: state,
          browserUrlDraft: state.url,
          browserLoading: state.loading
        }
      }))
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          browserLoading: false,
          browserError: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  },

  async browserGoBack() {
    const id = get().activeId
    if (!id) return
    const state = await window.agentDesk.browserGoBack(id)
    set((s) => ({ workbench: { ...s.workbench, browserState: state, browserUrlDraft: state.url } }))
  },

  async browserGoForward() {
    const id = get().activeId
    if (!id) return
    const state = await window.agentDesk.browserGoForward(id)
    set((s) => ({ workbench: { ...s.workbench, browserState: state, browserUrlDraft: state.url } }))
  },

  async reloadBrowser() {
    const id = get().activeId
    if (!id) return
    const state = await window.agentDesk.reloadBrowser(id)
    set((s) => ({ workbench: { ...s.workbench, browserState: state, browserLoading: state.loading } }))
  },

  async setBrowserBounds(bounds) {
    const id = get().activeId
    if (!id || !get().workbench.browserOpen) return
    await window.agentDesk.setBrowserBounds(id, bounds)
  },

  async captureBrowserAnnotation(note) {
    const id = get().activeId
    if (!id) return
    set((s) => ({ workbench: { ...s.workbench, browserError: undefined, browserMessage: undefined } }))
    try {
      const annotation = await window.agentDesk.captureBrowserAnnotation(id, note)
      set((s) => {
        const known = new Set(s.workbench.browserAnnotations.map((item) => item.id))
        return {
          workbench: {
            ...s.workbench,
            browserAnnotations: known.has(annotation.id)
              ? s.workbench.browserAnnotations
              : [annotation, ...s.workbench.browserAnnotations],
            browserMessage: '已保存网页批注'
          }
        }
      })
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          browserError: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  },

  async refreshBrowserAnnotations() {
    const id = get().activeId
    if (!id) return
    const annotations = await window.agentDesk.listBrowserAnnotations(id)
    set((s) => ({ workbench: { ...s.workbench, browserAnnotations: annotations } }))
  },

  async pickBrowserElementAnnotation(note) {
    const id = get().activeId
    if (!id) return
    set((s) => ({
      workbench: {
        ...s.workbench,
        browserError: undefined,
        browserMessage: '圈选中:在页面上点击目标元素(Esc 取消)',
        browserPicking: true
      }
    }))
    try {
      const pick = await window.agentDesk.pickBrowserElement(id)
      if (pick.cancelled) {
        set((s) => ({
          workbench: { ...s.workbench, browserPicking: false, browserMessage: '已取消圈选' }
        }))
        return
      }
      const annotation = await window.agentDesk.captureBrowserElementAnnotation(id, pick, note)
      set((s) => {
        const known = new Set(s.workbench.browserAnnotations.map((item) => item.id))
        return {
          workbench: {
            ...s.workbench,
            browserPicking: false,
            browserAnnotations: known.has(annotation.id)
              ? s.workbench.browserAnnotations
              : [annotation, ...s.workbench.browserAnnotations],
            browserMessage: '已保存 DOM 圈选批注(含截图)'
          }
        }
      })
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          browserPicking: false,
          browserError: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  },

  async observeBrowserForAgent() {
    const id = get().activeId
    if (!id) return
    try {
      const obs = await window.agentDesk.observeBrowser(id)
      const lines = [
        '以下是内置浏览器当前页面的只读观测快照(未做任何交互):',
        '',
        `URL: ${obs.url}`,
        `标题: ${obs.title}`,
        obs.pageTextSnippet ? `\n页面文本摘要:\n${obs.pageTextSnippet.slice(0, 2000)}` : '',
        obs.consoleErrors.length ? `\n控制台错误(${obs.consoleErrors.length}):\n${obs.consoleErrors.join('\n')}` : '\n控制台错误: 无',
        obs.networkFailures.length ? `\n网络失败(${obs.networkFailures.length}):\n${obs.networkFailures.join('\n')}` : '网络失败: 无',
        '',
        '请基于该快照复验/诊断当前页面。'
      ]
        .filter(Boolean)
        .join('\n')
      await get().sendMessage(lines)
      set((s) => ({ workbench: { ...s.workbench, browserMessage: '页面观测已发给 Agent' } }))
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          browserError: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  },

  async openPluginRegistryPanel() {
    closeNativeBrowserView(get().activeId)
    set((s) => ({
      workbench: {
        ...s.workbench,
        diffOpen: false,
        worktreeOpen: false,
        terminalOpen: false,
        filesOpen: false,
        browserOpen: false,
        previewOpen: false,
        pluginRegistryOpen: true,
        subagentOpen: false,
        routineOpen: false,
        memoryOpen: false,
        pluginRegistryError: undefined,
        pluginRegistryMessage: undefined
      }
    }))
    await get().refreshPluginRegistryPanel()
  },

  closePluginRegistryPanel() {
    set((s) => ({ workbench: { ...s.workbench, pluginRegistryOpen: false } }))
  },

  async refreshPluginRegistryPanel() {
    const id = get().activeId ?? undefined
    set((s) => ({
      workbench: {
        ...s.workbench,
        pluginRegistryOpen: true,
        pluginRegistryLoading: true,
        pluginRegistryError: undefined,
        pluginRegistryMessage: undefined
      }
    }))
    try {
      const pluginRegistry = await window.agentDesk.scanPluginRegistry(id)
      set((s) => ({
        workbench: {
          ...s.workbench,
          pluginRegistry,
          pluginRegistryLoading: false,
          pluginRegistryError: undefined,
          selectedPluginRegistryItemId:
            s.workbench.selectedPluginRegistryItemId &&
            pluginRegistry.items.some((item) => item.id === s.workbench.selectedPluginRegistryItemId)
              ? s.workbench.selectedPluginRegistryItemId
              : pluginRegistry.items[0]?.id
        }
      }))
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          pluginRegistryLoading: false,
          pluginRegistryError: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  },

  async probeMcpRuntime(items) {
    const id = get().activeId ?? undefined
    const mcpItems = items.filter((item) => item.kind === 'mcp')
    if (mcpItems.length === 0) return
    set((s) => ({ workbench: { ...s.workbench, mcpProbing: true, pluginRegistryError: undefined } }))
    try {
      const results = await window.agentDesk.probeMcpServers(mcpItems, id)
      set((s) => {
        const merged = { ...s.workbench.mcpProbeResults }
        for (const result of results) merged[result.id] = result
        const okCount = results.filter((r) => r.ok).length
        return {
          workbench: {
            ...s.workbench,
            mcpProbing: false,
            mcpProbeResults: merged,
            pluginRegistryMessage: `MCP 探测完成:${okCount}/${results.length} 连通`
          }
        }
      })
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          mcpProbing: false,
          pluginRegistryError: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  },

  async installPluginFromLocal() {
    set((s) => ({ workbench: { ...s.workbench, pluginRegistryError: undefined, pluginRegistryMessage: undefined } }))
    try {
      const result = await window.agentDesk.installLocalPlugin()
      if (!result.ok) {
        // 用户取消不算错误
        if (result.error !== 'canceled') {
          set((s) => ({ workbench: { ...s.workbench, pluginRegistryError: result.error } }))
        }
        return
      }
      set((s) => ({
        workbench: { ...s.workbench, pluginRegistryMessage: `已安装 ${result.name}(${result.installedPath})` }
      }))
      await get().refreshPluginRegistryPanel()
    } catch (err) {
      set((s) => ({
        workbench: { ...s.workbench, pluginRegistryError: err instanceof Error ? err.message : String(err) }
      }))
    }
  },

  async uninstallManagedPlugin(item) {
    set((s) => ({ workbench: { ...s.workbench, pluginRegistryError: undefined, pluginRegistryMessage: undefined } }))
    try {
      const result = await window.agentDesk.uninstallPlugin(item.path)
      if (!result.ok) {
        set((s) => ({ workbench: { ...s.workbench, pluginRegistryError: result.error } }))
        return
      }
      set((s) => ({
        workbench: { ...s.workbench, pluginRegistryMessage: `已卸载 ${item.name},可从回收站恢复(${result.trashedTo})` }
      }))
      await get().refreshPluginRegistryPanel()
    } catch (err) {
      set((s) => ({
        workbench: { ...s.workbench, pluginRegistryError: err instanceof Error ? err.message : String(err) }
      }))
    }
  },

  async loadPluginRegistryForSlash() {
    const id = get().activeId ?? undefined
    if (get().workbench.pluginRegistryLoading) return
    set((s) => ({
      workbench: {
        ...s.workbench,
        pluginRegistryLoading: true,
        pluginRegistryError: undefined
      }
    }))
    try {
      const pluginRegistry = await window.agentDesk.scanPluginRegistry(id)
      set((s) => ({
        workbench: {
          ...s.workbench,
          pluginRegistry,
          pluginRegistryLoading: false,
          pluginRegistryError: undefined,
          selectedPluginRegistryItemId:
            s.workbench.selectedPluginRegistryItemId &&
            pluginRegistry.items.some((item) => item.id === s.workbench.selectedPluginRegistryItemId)
              ? s.workbench.selectedPluginRegistryItemId
              : pluginRegistry.items[0]?.id
        }
      }))
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          pluginRegistryLoading: false,
          pluginRegistryError: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  },

  selectPluginRegistryItem(id) {
    set((s) => ({ workbench: { ...s.workbench, selectedPluginRegistryItemId: id } }))
  },

  async revealPluginRegistryItem(item) {
    const id = get().activeId ?? undefined
    set((s) => ({
      workbench: {
        ...s.workbench,
        pluginRegistryError: undefined,
        pluginRegistryMessage: undefined,
        selectedPluginRegistryItemId: item.id
      }
    }))
    const result = await window.agentDesk.revealPluginRegistryItem(item.path, id)
    set((s) => ({
      workbench: {
        ...s.workbench,
        pluginRegistryMessage: result.ok ? `已定位 ${item.name}` : undefined,
        pluginRegistryError: result.ok ? undefined : result.error
      }
    }))
  },

  async togglePluginRegistryItem(item, enabled) {
    const id = get().activeId ?? undefined
    set((s) => ({
      workbench: {
        ...s.workbench,
        selectedPluginRegistryItemId: item.id,
        pluginRegistryError: undefined,
        pluginRegistryMessage: undefined
      }
    }))
    try {
      const result = await window.agentDesk.setPluginRegistryItemEnabled(item, enabled, id)
      if (!result.ok || !result.item) {
        set((s) => ({
          workbench: {
            ...s.workbench,
            pluginRegistryError: result.error || '插件状态更新失败',
            pluginRegistryMessage: undefined
          }
        }))
        return
      }
      const updatedItem = result.item
      set((s) => ({
        workbench: {
          ...s.workbench,
          pluginRegistry: s.workbench.pluginRegistry
            ? {
                ...s.workbench.pluginRegistry,
                items: s.workbench.pluginRegistry.items.map((candidate) =>
                  candidate.id === updatedItem.id &&
                  candidate.kind === updatedItem.kind &&
                  candidate.sourceRoot === updatedItem.sourceRoot &&
                  candidate.path === updatedItem.path &&
                  candidate.name === updatedItem.name
                    ? updatedItem
                    : candidate
                )
              }
            : s.workbench.pluginRegistry,
          selectedPluginRegistryItemId: updatedItem.id,
          pluginRegistryMessage: `${updatedItem.name} 已${updatedItem.enabled ? '启用' : '停用'}`,
          pluginRegistryError: undefined
        }
      }))
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          pluginRegistryError: err instanceof Error ? err.message : String(err),
          pluginRegistryMessage: undefined
        }
      }))
    }
  },

  async sendPluginRegistryItemToAgent(item) {
    const id = get().activeId
    if (!id) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          pluginRegistryError: '请先选择一个会话',
          pluginRegistryMessage: undefined
        }
      }))
      return
    }
    if (!item.enabled) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          selectedPluginRegistryItemId: item.id,
          pluginRegistryError: '该插件条目已停用,请先启用再交给 Agent',
          pluginRegistryMessage: undefined
        }
      }))
      return
    }
    set((s) => ({
      workbench: {
        ...s.workbench,
        selectedPluginRegistryItemId: item.id,
        pluginRegistryError: undefined,
        pluginRegistryMessage: undefined
      }
    }))
    try {
      await get().sendMessage(pluginRegistryItemPrompt(item))
      set((s) => ({
        workbench: {
          ...s.workbench,
          pluginRegistryMessage: `已把 ${item.name} 发给当前 Agent`,
          pluginRegistryError: undefined
        }
      }))
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          pluginRegistryError: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  },

  async dispatchPluginAgent(item) {
    if (item.kind !== 'agent') {
      set((s) => ({
        workbench: {
          ...s.workbench,
          pluginRegistryError: '只有 Agent 定义可以派发为子 Agent',
          pluginRegistryMessage: undefined
        }
      }))
      return
    }
    if (!item.enabled) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          selectedPluginRegistryItemId: item.id,
          pluginRegistryError: '该 Agent 定义已停用,请先启用再派发子 Agent',
          pluginRegistryMessage: undefined
        }
      }))
      return
    }
    const parentId = get().activeId
    if (!parentId) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          pluginRegistryError: '请先选择一个父会话',
          pluginRegistryMessage: undefined
        }
      }))
      return
    }
    set((s) => ({
      workbench: {
        ...s.workbench,
        selectedPluginRegistryItemId: item.id,
        pluginRegistryError: undefined,
        pluginRegistryMessage: undefined
      }
    }))
    try {
      const result = await get().dispatchSubagents({
        tasks: [
          {
            id: pluginRegistryAgentTaskId(item),
            role: item.name,
            title: `${item.name} 子 Agent`,
            prompt: pluginRegistryAgentDispatchPrompt(item)
          }
        ]
      })
      set((s) => ({
        workbench: {
          ...s.workbench,
          lastSubagentDispatch: result ?? s.workbench.lastSubagentDispatch,
          pluginRegistryMessage: result ? `已派发 ${item.name} 子 Agent` : undefined,
          pluginRegistryError: result ? undefined : '子 Agent 派发失败'
        }
      }))
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          pluginRegistryError: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  },

  openSubagentPanel() {
    closeNativeBrowserView(get().activeId)
    set((s) => ({
      workbench: {
        ...s.workbench,
        diffOpen: false,
        worktreeOpen: false,
        terminalOpen: false,
        filesOpen: false,
        browserOpen: false,
        previewOpen: false,
        pluginRegistryOpen: false,
        subagentOpen: true,
        routineOpen: false,
        memoryOpen: false,
        subagentError: undefined,
        subagentMessage: undefined
      }
    }))
  },

  closeSubagentPanel() {
    set((s) => ({ workbench: { ...s.workbench, subagentOpen: false } }))
  },

  async dispatchSubagentText(tasksText) {
    const tasks = tasksText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        const match = /^([A-Za-z0-9._-]{1,40})\s*:\s*(.+)$/.exec(line)
        return match
          ? { id: match[1], role: match[1], title: match[1], prompt: match[2].trim() }
          : { id: `task-${index + 1}`, prompt: line }
      })
    if (tasks.length === 0) return undefined
    if (tasks.length > 33) {
      set((s) => ({ workbench: { ...s.workbench, subagentError: '一次最多派发 33 个子 Agent' } }))
      return undefined
    }
    set((s) => ({ workbench: { ...s.workbench, subagentBusy: true, subagentError: undefined, subagentMessage: undefined } }))
    try {
      const result = await get().dispatchSubagents({ tasks })
      set((s) => ({
        workbench: {
          ...s.workbench,
          subagentBusy: false,
          lastSubagentDispatch: result ?? s.workbench.lastSubagentDispatch,
          subagentMessage: result ? `已派发 ${result.children.length} 个子 Agent` : undefined
        }
      }))
      return result
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          subagentBusy: false,
          subagentError: err instanceof Error ? err.message : String(err)
        }
      }))
      return undefined
    }
  },

  async openRoutinePanel() {
    closeNativeBrowserView(get().activeId)
    set((s) => ({
      workbench: {
        ...s.workbench,
        diffOpen: false,
        worktreeOpen: false,
        terminalOpen: false,
        filesOpen: false,
        browserOpen: false,
        previewOpen: false,
        pluginRegistryOpen: false,
        subagentOpen: false,
        routineOpen: true,
        memoryOpen: false,
        routineError: undefined,
        routineMessage: undefined
      }
    }))
    await get().refreshRoutinePanel()
  },

  closeRoutinePanel() {
    set((s) => ({ workbench: { ...s.workbench, routineOpen: false } }))
  },

  async refreshRoutinePanel() {
    set((s) => ({
      workbench: {
        ...s.workbench,
        routineOpen: true,
        routineLoading: true,
        routineError: undefined,
        routineMessage: undefined
      }
    }))
    try {
      const [routines, routineRuns] = await Promise.all([
        window.agentDesk.listRoutines(),
        window.agentDesk.listRoutineRuns()
      ])
      set((s) => ({
        workbench: {
          ...s.workbench,
          routines,
          routineRuns,
          routineLoading: false,
          routineError: undefined,
          selectedRoutineId:
            s.workbench.selectedRoutineId && routines.some((routine) => routine.id === s.workbench.selectedRoutineId)
              ? s.workbench.selectedRoutineId
              : (routines[0]?.id ?? null)
        }
      }))
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          routineLoading: false,
          routineError: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  },

  selectRoutine(id) {
    set((s) => ({ workbench: { ...s.workbench, selectedRoutineId: id } }))
  },

  async toggleRoutine(id, enabled) {
    set((s) => ({ workbench: { ...s.workbench, routineError: undefined, routineMessage: undefined } }))
    try {
      const routine = await window.agentDesk.updateRoutine(id, { enabled })
      set((s) => ({
        workbench: {
          ...s.workbench,
          routines: routine
            ? s.workbench.routines.map((item) => (item.id === id ? routine : item))
            : s.workbench.routines,
          routineError: routine ? undefined : '未找到 Routine',
          routineMessage: routine ? `${routine.name} 已${routine.enabled ? '启用' : '停用'}` : undefined
        }
      }))
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          routineError: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  },

  async markRoutineRun(id) {
    set((s) => ({ workbench: { ...s.workbench, routineError: undefined, routineMessage: undefined } }))
    try {
      const run = await window.agentDesk.runRoutineNow(id)
      const [routines, routineRuns] = await Promise.all([
        window.agentDesk.listRoutines(),
        window.agentDesk.listRoutineRuns()
      ])
      set((s) => ({
        workbench: {
          ...s.workbench,
          routines,
          routineRuns,
          routineError: run ? undefined : '未找到 Routine',
          routineMessage: run ? `${run.routineName} 已启动手动运行` : undefined
        }
      }))
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          routineError: err instanceof Error ? err.message : String(err)
        }
      }))
    }
    return

    try {
      const routine = await window.agentDesk.markRoutineRun(id, { ranAt: Date.now() })
      set((s) => ({
        workbench: {
          ...s.workbench,
          routines: routine
            ? s.workbench.routines.map((item) => (item.id === id ? routine : item))
            : s.workbench.routines,
          routineError: routine ? undefined : '未找到 Routine',
          routineMessage: routine
            ? `${routine.name} 已手动更新运行时间`
            : undefined
        }
      }))
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          routineError: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  },

  async deleteRoutine(id) {
    set((s) => ({ workbench: { ...s.workbench, routineError: undefined, routineMessage: undefined } }))
    try {
      const routineName = get().workbench.routines.find((routine) => routine.id === id)?.name ?? 'Routine'
      const ok = await window.agentDesk.deleteRoutine(id)
      set((s) => ({
        workbench: ok
          ? {
              ...s.workbench,
              routines: s.workbench.routines.filter((routine) => routine.id !== id),
              selectedRoutineId:
                s.workbench.selectedRoutineId === id
                  ? (s.workbench.routines.find((routine) => routine.id !== id)?.id ?? null)
                  : s.workbench.selectedRoutineId,
              routineMessage: `${routineName} 已删除`,
              routineError: undefined
            }
          : {
              ...s.workbench,
              routineError: '未找到 Routine'
            }
      }))
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          routineError: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  },

  async refreshStartSuggestions() {
    const id = get().activeId
    if (!id) return
    set((s) => ({
      workbench: {
        ...s.workbench,
        startSuggestions: [],
        startSuggestionsLoading: true,
        startSuggestionsError: undefined
      }
    }))
    try {
      const suggestions = await window.agentDesk.getStartSuggestions(id)
      if (get().activeId !== id) return
      set((s) => ({
        workbench: {
          ...s.workbench,
          startSuggestions: suggestions,
          startSuggestionsLoading: false,
          startSuggestionsError: undefined
        }
      }))
    } catch (err) {
      if (get().activeId !== id) return
      set((s) => ({
        workbench: {
          ...s.workbench,
          startSuggestionsLoading: false,
          startSuggestionsError: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  },

  async sendStartSuggestion(suggestion) {
    await get().sendMessage(suggestion.prompt)
    get().ignoreStartSuggestion(suggestion.id)
  },

  ignoreStartSuggestion(id) {
    const activeId = get().activeId
    if (!activeId) return
    const key = `${activeId}:${id}`
    set((s) => ({
      workbench: {
        ...s.workbench,
        ignoredStartSuggestions: { ...s.workbench.ignoredStartSuggestions, [key]: true }
      }
    }))
  },

  laterStartSuggestion(id) {
    const activeId = get().activeId
    if (!activeId) return
    const key = `${activeId}:${id}`
    set((s) => ({
      workbench: {
        ...s.workbench,
        laterStartSuggestions: { ...s.workbench.laterStartSuggestions, [key]: Date.now() + 30 * 60 * 1000 }
      }
    }))
  },

  visibleStartSuggestions() {
    const activeId = get().activeId
    if (!activeId) return []
    const now = Date.now()
    const { ignoredStartSuggestions, laterStartSuggestions, startSuggestions } = get().workbench
    return startSuggestions.filter((suggestion) => {
      const key = `${activeId}:${suggestion.id}`
      return !ignoredStartSuggestions[key] && (laterStartSuggestions[key] ?? 0) <= now
    })
  },

  async refreshTaskSnapshots() {
    await get().hydrateTaskRecoveryCandidates()
  },

  async deleteTaskSnapshot(snapshotId) {
    set({ taskSnapshotsLoading: true, taskSnapshotsError: undefined })
    try {
      const ok = await window.agentDesk.deleteTaskSnapshot(snapshotId)
      set((s) => ({
        taskSnapshots: ok
          ? s.taskSnapshots.filter((snapshot) => snapshot.id !== snapshotId)
          : s.taskSnapshots,
        taskSnapshotsLoading: false,
        taskSnapshotsError: ok ? undefined : '未找到任务快照'
      }))
    } catch (err) {
      set({
        taskSnapshotsLoading: false,
        taskSnapshotsError: err instanceof Error ? err.message : String(err)
      })
    }
  },

  openMemoryPanel() {
    closeNativeBrowserView(get().activeId)
    set((s) => ({
      workbench: {
        ...s.workbench,
        diffOpen: false,
        worktreeOpen: false,
        terminalOpen: false,
        filesOpen: false,
        browserOpen: false,
        previewOpen: false,
        pluginRegistryOpen: false,
        subagentOpen: false,
        routineOpen: false,
        memoryOpen: true,
        memoryInitialForm: undefined
      }
    }))
  },

  acceptMemorySuggestion() {
    const suggestion = get().workbench.memorySuggestion
    if (!suggestion) return
    const text = suggestion.text.trim()
    const title = text.length > 28 ? `${text.slice(0, 28)}...` : text || '用户约定'
    closeNativeBrowserView(get().activeId)
    set((s) => ({
      activeId: suggestion.sessionId,
      workbench: {
        ...s.workbench,
        diffOpen: false,
        worktreeOpen: false,
        terminalOpen: false,
        filesOpen: false,
        browserOpen: false,
        previewOpen: false,
        pluginRegistryOpen: false,
        subagentOpen: false,
        routineOpen: false,
        memoryOpen: true,
        memorySuggestion: undefined,
        memoryInitialForm: {
          kind: 'convention',
          title,
          body: text,
          reason: '用户输入包含长期约定关键词'
        }
      }
    }))
  },

  dismissMemorySuggestion() {
    set((s) => ({ workbench: { ...s.workbench, memorySuggestion: undefined } }))
  },

  closeMemoryPanel() {
    set((s) => ({ workbench: { ...s.workbench, memoryOpen: false, memoryInitialForm: undefined } }))
  },

  openRewindPanel(messageId, sourceText, reason = 'button') {
    set({ rewindPanel: { open: true, messageId, sourceText, reason } })
  },

  openLatestRewindPanel(reason = 'shortcut') {
    const id = get().activeId
    const session = id ? get().sessions[id] : undefined
    const latest = session?.items
      .slice()
      .reverse()
      .find((item) => item.kind === 'user' && item.checkpointId)
    if (latest?.kind === 'user' && latest.checkpointId) {
      set({
        rewindPanel: {
          open: true,
          messageId: latest.checkpointId,
          sourceText: latest.text,
          reason
        }
      })
      return
    }
    if (id && session) {
      const notice: ChatItem = {
        id: genId(),
        kind: 'notice',
        level: 'info',
        text: '当前会话还没有可回退的检查点'
      }
      set((s) => ({
        sessions: { ...s.sessions, [id]: { ...session, items: [...session.items, notice] } }
      }))
    }
  },

  closeRewindPanel() {
    set({ rewindPanel: { open: false } })
  },

  async refreshProviders() {
    const providers = await window.agentDesk.listProviders()
    set({ providers })
  },

  async createProvider(input) {
    await window.agentDesk.createProvider(input)
    await get().refreshProviders()
  },

  async updateProvider(id, patch) {
    await window.agentDesk.updateProvider(id, patch)
    await get().refreshProviders()
  },

  async deleteProvider(id) {
    await window.agentDesk.deleteProvider(id)
    await get().refreshProviders()
    // 若 Provider 偏好被删,清空偏好;新建会话必须显式再选。
    if (get().settings.defaultProviderId === id) {
      await get().updateSettings({ defaultProviderId: '' })
    }
  },

  async refreshProjects() {
    const projects = await window.agentDesk.listProjects()
    set({ projects })
  },

  async archiveProject(id, archived) {
    await window.agentDesk.updateProject(id, { archived })
    const projects = await window.agentDesk.listProjects()
    set((s) => ({
      projects,
      newSessionProjectId: s.newSessionProjectId === id ? null : s.newSessionProjectId
    }))
  },

  async deleteProject(id) {
    await window.agentDesk.deleteProject(id)
    const projects = await window.agentDesk.listProjects()
    set((s) => ({
      projects,
      newSessionProjectId: s.newSessionProjectId === id ? null : s.newSessionProjectId
    }))
  },

  setShowNewSession(v, projectId) {
    set((s) => ({
      showNewSession: v,
      newSessionProjectId: v ? projectId ?? null : null,
      showSettings: v ? false : s.showSettings,
      showTaskRecovery: v ? false : s.showTaskRecovery,
      view: v ? 'list' : s.view
    }))
  },

  setShowSettings(v) {
    set({ showSettings: v })
  },

  setShowCommandPalette(v) {
    set({ showCommandPalette: v })
  },

  setShowTaskRecovery(v) {
    set({ showTaskRecovery: v })
  }
  }
})

/** 全局只定义调度哨兵;真实模型必须来自当前 Provider。 */
export const MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: AUTO_MODEL, label: '🧭 自动调度' }
]

export function modelOptionsForProvider(
  providers: ProviderView[],
  providerId: string,
  autoLabel = MODEL_OPTIONS[0].label,
  currentModel = ''
): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = [
    { value: AUTO_MODEL, label: autoLabel }
  ]
  const seen = new Set([AUTO_MODEL])
  const provider = providers.find((item) => item.id === providerId)
  for (const model of provider?.models ?? []) {
    const value = model.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    options.push({ value, label: value })
  }
  const current = currentModel.trim()
  if (current && !seen.has(current)) options.push({ value: current, label: current })
  return options
}

export const DRIVE_MODE_OPTIONS = CAOGEN_DRIVE_POLICIES.map((policy) => ({
  value: policy.mode,
  label: `${policy.label} · ${policy.zhLabel}`,
  summary: policy.summary,
  budgetUsd: policy.sessionBudgetUsd,
  defaultModel: policy.defaultModel,
  defaultPermissionMode: policy.defaultPermissionMode,
  validationDepth: policy.validationDepth,
  toolPolicySummary: policy.toolPolicySummary
}))

export const STRATEGY_OPTIONS: Array<{ value: SchedulerStrategy; label: string }> = [
  { value: 'balanced', label: '均衡' },
  { value: 'speed', label: '速度优先' },
  { value: 'quality', label: '质量优先' },
  { value: 'cost', label: '成本优先' }
]

export const PERMISSION_OPTIONS: Array<{ value: PermissionModeId; label: string }> = [
  { value: 'default', label: '默认(询问)' },
  { value: 'acceptEdits', label: '自动接受编辑' },
  { value: 'plan', label: '规划模式' },
  { value: 'bypassPermissions', label: '跳过权限' }
]

/**
 * Provider 预设模板。Anthropic 引擎使用原生 Messages API;Claude 引擎使用
 * Claude Agent SDK;OpenAI 引擎支持 Responses(OpenAI 原生)与 Chat Completions
 * (通用)两种协议。模板预填 baseUrl 与常见模型名,降低配置成本。
 */
export interface ProviderPreset {
  key: string
  label: string
  baseUrl: string
  models: string[]
  engine: EngineKind
  hint: string
  /** 该预设推荐的 OpenAI 引擎协议(undefined = responses) */
  openaiProtocol?: OpenAIProtocol
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: 'caogen-relay',
    label: 'CaoGen 中转站模板(需配置 Key)',
    baseUrl: 'https://gpt.zhangrui.xyz/dashboard',
    models: [],
    engine: 'openai',
    hint: 'CaoGen 中转站预设入口。服务暂不作为默认可用 Provider;请填写自己的 API Key,再用“获取模型”确认可用模型。若控制台给出的 API 路径不同,按实际路径调整 Base URL。',
    openaiProtocol: 'chat'
  },
  {
    key: 'anthropic',
    label: 'Anthropic(Messages API 直连)',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-opus-4', 'claude-sonnet-4', 'claude-haiku-4'],
    engine: 'anthropic',
    hint: '直连 Anthropic 官方 Messages API,不经过 Claude Agent SDK;填入自己的 Anthropic API Key。'
  },
  {
    key: 'openai',
    label: 'OpenAI(厂商直连)',
    baseUrl: 'https://api.openai.com',
    models: ['gpt-4.1', 'gpt-4o', 'o3', 'o4-mini'],
    engine: 'openai',
    hint: '选择 OpenAI 引擎时原生直连(Responses 协议),填入 OpenAI API Key。Claude 引擎使用该 Provider 仍需要兼容网关。'
  },
  {
    key: 'deepseek',
    label: 'DeepSeek(厂商直连)',
    baseUrl: 'https://api.deepseek.com/anthropic',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    engine: 'claude',
    hint: 'DeepSeek 厂商 Anthropic 兼容端点,无须网关。api.deepseek.com 申请 Key。'
  },
  {
    key: 'deepseek-chat',
    label: 'DeepSeek(OpenAI 引擎 · Chat 协议)',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    engine: 'openai',
    hint: '走 OpenAI 引擎的 Chat Completions 协议直连 DeepSeek。会话会自动继承此处配置的执行引擎。',
    openaiProtocol: 'chat'
  },
  {
    key: 'kimi',
    label: 'Kimi / 月之暗面(厂商直连)',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    models: ['kimi-k2-0711-preview', 'moonshot-v1-auto'],
    engine: 'claude',
    hint: 'Moonshot 厂商 Anthropic 兼容端点,无须网关。platform.moonshot.cn 申请 Key。'
  },
  {
    key: 'glm',
    label: '智谱 GLM(厂商直连)',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    models: ['glm-4.5', 'glm-4.5-air'],
    engine: 'claude',
    hint: '智谱厂商 Anthropic 兼容端点,无须网关。open.bigmodel.cn 申请 Key。'
  },
  {
    key: 'grok',
    label: 'Grok / xAI(厂商直连)',
    baseUrl: 'https://api.x.ai',
    models: ['grok-4', 'grok-4-fast'],
    engine: 'openai',
    hint: 'xAI 厂商端点同时提供 Anthropic 兼容(/v1/messages,配 Claude 引擎)与 Chat Completions(配 OpenAI 引擎 Chat 协议)。console.x.ai 申请 Key。',
    openaiProtocol: 'chat'
  },
  {
    key: 'qwen',
    label: '通义千问 Qwen(DashScope)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
    engine: 'openai',
    hint: '阿里 DashScope OpenAI 兼容端点,配 OpenAI 引擎 Chat 协议。bailian.console.aliyun.com 申请 Key。',
    openaiProtocol: 'chat'
  },
  {
    key: 'baichuan',
    label: '百川智能 Baichuan',
    baseUrl: 'https://api.baichuan-ai.com/v1',
    models: ['Baichuan4-Turbo', 'Baichuan4-Air'],
    engine: 'openai',
    hint: '百川 OpenAI 兼容端点,配 OpenAI 引擎 Chat 协议。若端点或模型名变化,按控制台文档调整。',
    openaiProtocol: 'chat'
  },
  {
    key: 'doubao',
    label: '豆包 Doubao / 火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-seed-1-6', 'doubao-1-5-pro-32k'],
    engine: 'openai',
    hint: '火山方舟 OpenAI 兼容端点,配 OpenAI 引擎 Chat 协议。模型 ID 以方舟控制台实际 endpoint 为准。',
    openaiProtocol: 'chat'
  },
  {
    key: 'local-openai',
    label: '本地 / 自部署(vLLM · Ollama · LM Studio)',
    baseUrl: 'http://localhost:11434',
    models: ['qwen3', 'llama3.3', 'deepseek-r1'],
    engine: 'openai',
    hint: '任何自部署 OpenAI 兼容服务(vLLM/Ollama/LM Studio 等),配 OpenAI 引擎 Chat 协议。按你的服务地址改 baseUrl。',
    openaiProtocol: 'chat'
  },
  {
    key: 'oneapi',
    label: 'one-api / new-api 网关',
    baseUrl: 'http://localhost:3000',
    models: ['gpt-4o', 'gpt-4o-mini', 'gemini-1.5-pro', 'deepseek-chat'],
    engine: 'claude',
    hint: '经 one-api/new-api 网关转译:请求走 Anthropic 协议,网关翻译到 OpenAI/Gemini 等后端。模型名需与网关映射一致。'
  },
  {
    key: 'litellm',
    label: 'LiteLLM 网关',
    baseUrl: 'http://localhost:4000',
    models: ['gpt-4o', 'claude-3-5-sonnet', 'gemini/gemini-1.5-pro'],
    engine: 'claude',
    hint: 'LiteLLM 以 /v1/messages 暴露 Anthropic 兼容端点,后端可接 OpenAI/Azure/Bedrock 等。'
  },
  {
    key: 'custom',
    label: '自定义',
    baseUrl: '',
    models: [],
    engine: 'openai',
    hint: '手动填写全部字段。'
  }
]
