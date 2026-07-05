import { create } from 'zustand'
import { AUTO_MODEL, DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_PROVIDER_ID } from '../../shared/types'
import type {
  AgentEvent,
  AppSettings,
  AssistantBlock,
  OpenAIProtocol,
  BrowserAnnotation,
  BrowserBounds,
  BrowserEvent,
  BrowserViewState,
  CheckpointRestoreMode,
  CheckpointRestoreResult,
  CreateSessionOptions,
  DispatchSubagentsInput,
  GitCommitResult,
  GitOperationResult,
  GitStatus,
  SubagentDispatchResult,
  SubagentResult,
  HistoryEntry,
  MemorySuggestionEvent,
  PermissionModeId,
  PluginRegistryItem,
  PluginRegistryView,
  ProjectFileEntry,
  PermissionRequestInfo,
  PreparedPreview,
  Project,
  ProviderInput,
  ProviderView,
  Routine,
  WriteTextFileResult,
  SchedulerStrategy,
  SendMessagePayload,
  SessionMeta,
  StartSuggestion,
  UserMessageAttachmentView,
  TranscriptEntry,
  TerminalEvent,
  TerminalInfo,
  UsageTotals,
  WorkspaceDiff,
  WorkspaceHunkResult,
  WorktreeApplyCheckResult,
  WorktreeApplyResult,
  WorktreeMergeSummary,
  WorktreePatchResult,
  WorktreePullRequestResult,
  WorktreeRemoveResult,
  WorktreeSummary
} from '../../shared/types'

let seq = 0
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

/**
 * createSession IPC 返回前主进程可能已开始广播该会话的事件(status/init),
 * 此时 store 里还没有对应条目;先缓存,注册时按序重放,避免丢 sdkSessionId 等状态。
 */
const pendingEvents = new Map<string, Array<{ seq: number; event: AgentEvent }>>()
const PENDING_EVENTS_CAP = 200

function stashPendingEvent(sessionId: string, seq: number, event: AgentEvent): void {
  const queue = pendingEvents.get(sessionId) ?? []
  if (queue.length < PENDING_EVENTS_CAP) queue.push({ seq, event })
  pendingEvents.set(sessionId, queue)
}

function drainPendingEvents(sessionId: string, state: SessionState): SessionState {
  const queue = pendingEvents.get(sessionId)
  if (!queue) return state
  pendingEvents.delete(sessionId)
  return queue.reduce((s, item) => applyEvent(s, item.seq, item.event), state)
}

/** 应用单条事件(seq 去重 + reduce) */
function applyEvent(s: SessionState, seq: number, event: AgentEvent): SessionState {
  if (seq <= s.lastSeq) return s
  return { ...reduceSession(s, event), lastSeq: seq }
}

/** 批量回放转录(已按 seq 排序) */
function replayTranscript(s: SessionState, entries: TranscriptEntry[]): SessionState {
  return entries.reduce((state, e) => applyEvent(state, e.seq, e.event), s)
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
  | { id: string; kind: 'routing'; model: string; reason: string }
  | {
      id: string
      kind: 'failover'
      fromName: string
      toName: string
      model?: string
      reason: string
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
        items: [...s.items, { id: genId(), kind: 'routing', model: ev.model, reason: ev.reason }],
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
    case 'status': {
      const meta = { ...s.meta, status: ev.status, lastError: ev.error ?? s.meta.lastError }
      let items = s.items
      if (ev.status === 'error' && ev.error) {
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
          [ev.toolUseId]: { content: ev.content, isError: ev.isError }
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
  previewError?: string
  pluginRegistryOpen: boolean
  pluginRegistryLoading: boolean
  pluginRegistry?: PluginRegistryView
  pluginRegistryError?: string
  pluginRegistryMessage?: string
  selectedPluginRegistryItemId?: string
  subagentOpen: boolean
  subagentBusy: boolean
  subagentError?: string
  subagentMessage?: string
  lastSubagentDispatch?: SubagentDispatchResult
  routineOpen: boolean
  routineLoading: boolean
  routines: Routine[]
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

interface AppStore {
  ready: boolean
  sessions: Record<string, SessionState>
  order: string[]
  activeId: string | null
  history: HistoryEntry[]
  settings: AppSettings
  providers: ProviderView[]
  projects: Project[]
  view: AppView
  workbench: WorkbenchState
  rewindPanel: RewindPanelState
  showNewSession: boolean
  showSettings: boolean
  showCommandPalette: boolean
  sidebarQuery: string
  init(): Promise<void>
  handleEvent(sessionId: string, event: AgentEvent, seq: number): void
  handleMemorySuggestion(event: MemorySuggestionEvent): void
  handleTerminalEvent(event: TerminalEvent): void
  handleBrowserEvent(event: BrowserEvent): void
  createSession(opts: CreateSessionOptions): Promise<void>
  /** 建会话并立即发送首条消息(首屏"打开即输入"用) */
  startSessionWithPrompt(opts: CreateSessionOptions, prompt: string): Promise<void>
  dispatchSubagents(input: DispatchSubagentsInput): Promise<SubagentDispatchResult | undefined>
  resumeFromHistory(entry: HistoryEntry): Promise<void>
  selectSession(id: string): void
  sendMessage(input: string | SendMessagePayload): Promise<void>
  interrupt(): Promise<void>
  closeSession(id: string): Promise<void>
  respondPermission(sessionId: string, requestId: string, allow: boolean): Promise<void>
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
  deleteProject(id: string): Promise<void>
  setShowNewSession(v: boolean): void
  setShowSettings(v: boolean): void
  setShowCommandPalette(v: boolean): void
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
  sessions: {},
  order: [],
  activeId: null,
  history: [],
  settings: {
    defaultModel: DEEPSEEK_DEFAULT_MODEL,
    defaultPermissionMode: 'default',
    defaultProviderId: DEEPSEEK_PROVIDER_ID,
    schedulerStrategy: 'balanced',
    budgetUsdPerSession: 0,
    failoverEnabled: true,
    language: 'zh',
    theme: 'dark',
    persona: '',
    allowedTools: '',
    disallowedTools: '',
    notificationsEnabled: true,
    preventDisplaySleep: true,
    office: { showBadges: true, liveliness: 1, catEars: false }
  },
  providers: [],
  projects: [],
  view: 'list',
  sidebarQuery: '',
  workbench: {
    diffOpen: false,
    diffLoading: false,
    gitLoading: false,
    gitBusy: false,
    worktreeOpen: false,
    worktreeLoading: false,
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
    pluginRegistryOpen: false,
    pluginRegistryLoading: false,
    subagentOpen: false,
    subagentBusy: false,
    routineOpen: false,
    routineLoading: false,
    routines: [],
    selectedRoutineId: null,
    memoryOpen: false,
    startSuggestions: [],
    startSuggestionsLoading: false,
    ignoredStartSuggestions: {},
    laterStartSuggestions: {}
  },
  rewindPanel: { open: false },
  showNewSession: false,
  showSettings: false,
  showCommandPalette: false,

  async init() {
    if (get().ready) return
    set({ ready: true })
    window.agentDesk.onSessionEvent((sessionId, event, seq) => get().handleEvent(sessionId, event, seq))
    window.agentDesk.onMemorySuggestion((event) => get().handleMemorySuggestion(event))
    window.agentDesk.onTerminalEvent((event) => get().handleTerminalEvent(event))
    window.agentDesk.onBrowserEvent((event) => get().handleBrowserEvent(event))
    const [metas, history, settings, providers, projects] = await Promise.all([
      window.agentDesk.listSessions(),
      window.agentDesk.listHistory(),
      window.agentDesk.getSettings(),
      window.agentDesk.listProviders(),
      window.agentDesk.listProjects()
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
        sessions,
        order,
        history,
        settings,
        providers,
        projects,
        activeId: s.activeId ?? order[0] ?? null
      }
    })
    // 渲染进程重载会丢掉未决权限请求 + 聊天记录;从主进程补回
    for (const meta of metas) {
      const [reqs, transcript] = await Promise.all([
        window.agentDesk.listPendingPermissions(meta.id),
        window.agentDesk.getTranscript(meta.id)
      ])
      set((s) => {
        const session = s.sessions[meta.id]
        if (!session) return s
        let next = session
        if (reqs.length > 0) {
          const known = new Set(session.pendingPermissions.map((p) => p.requestId))
          const merged = [...session.pendingPermissions, ...reqs.filter((r) => !known.has(r.requestId))]
          next = { ...next, pendingPermissions: merged }
        }
        if (transcript.length > 0) {
          next = replayTranscript(next, transcript)
        }
        return { sessions: { ...s.sessions, [meta.id]: next } }
      })
    }
  },

  handleEvent(sessionId, event, seq) {
    if (event.kind === 'subagent-result') {
      flushStreamBuffer(sessionId)
      set((s) => {
        const session = s.sessions[sessionId]
        if (!session) return s
        return { sessions: { ...s.sessions, [sessionId]: reduceSession(session, event) } }
      })
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
        stashPendingEvent(sessionId, seq, event)
        return s
      }
      return { sessions: { ...s.sessions, [sessionId]: applyEvent(session, seq, event) } }
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
            terminalError: event.terminal.fallbackReason
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
      showNewSession: false
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

  async resumeFromHistory(entry) {
    await get().createSession({
      cwd: entry.cwd,
      model: entry.model,
      providerId: entry.providerId,
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

  async interrupt() {
    const id = get().activeId
    if (id) await window.agentDesk.interrupt(id)
  },

  async closeSession(id) {
    closeNativeBrowserView(id)
    await window.agentDesk.closeSession(id)
    pendingEvents.delete(id)
    set((s) => {
      const sessions = { ...s.sessions }
      delete sessions[id]
      const order = s.order.filter((x) => x !== id)
      return {
        sessions,
        order,
        activeId: s.activeId === id ? (order[order.length - 1] ?? null) : s.activeId
      }
    })
    const history = await window.agentDesk.listHistory()
    set({ history })
  },

  async respondPermission(sessionId, requestId, allow) {
    await window.agentDesk.respondPermission(sessionId, requestId, allow)
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
    await Promise.all([get().refreshDiffPanel(), get().refreshGitStatus()])
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
        previewError: undefined
      }
    }))
    await get().refreshPreviewPanel()
  },

  closePreviewPanel() {
    set((s) => ({ workbench: { ...s.workbench, previewOpen: false } }))
  },

  async refreshPreviewPanel() {
    const id = get().activeId
    const path = get().workbench.previewPath
    if (!id || !path) return
    set((s) => ({
      workbench: {
        ...s.workbench,
        previewLoading: true,
        previewError: undefined
      }
    }))
    try {
      const preview = await window.agentDesk.preparePreview(id, path)
      set((s) => ({
        workbench: {
          ...s.workbench,
          previewOpen: true,
          preview,
          previewLoading: false,
          previewError: preview.ok ? undefined : preview.error
        }
      }))
    } catch (err) {
      set((s) => ({
        workbench: {
          ...s.workbench,
          previewLoading: false,
          previewError: err instanceof Error ? err.message : String(err)
        }
      }))
    }
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
      const routines = await window.agentDesk.listRoutines()
      set((s) => ({
        workbench: {
          ...s.workbench,
          routines,
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
        startSuggestionsLoading: true,
        startSuggestionsError: undefined
      }
    }))
    try {
      const suggestions = await window.agentDesk.getStartSuggestions(id)
      set((s) => ({
        workbench: {
          ...s.workbench,
          startSuggestions: suggestions,
          startSuggestionsLoading: false,
          startSuggestionsError: undefined
        }
      }))
    } catch (err) {
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
    // 若默认 Provider 被删,回退到官方
    if (get().settings.defaultProviderId === id) {
      await get().updateSettings({ defaultProviderId: '' })
    }
  },

  async refreshProjects() {
    const projects = await window.agentDesk.listProjects()
    set({ projects })
  },

  async deleteProject(id) {
    await window.agentDesk.deleteProject(id)
    await get().refreshProjects()
  },

  setShowNewSession(v) {
    set({ showNewSession: v })
  },

  setShowSettings(v) {
    set({ showSettings: v })
  },

  setShowCommandPalette(v) {
    set({ showCommandPalette: v })
  }
  }
})

export const MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: AUTO_MODEL, label: '🧭 自动调度' },
  { value: '', label: '默认模型' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' }
]

export const STRATEGY_OPTIONS: Array<{ value: SchedulerStrategy; label: string }> = [
  { value: 'balanced', label: '均衡' },
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
 * Provider 预设模板。Claude 引擎使用 Anthropic Messages API;OpenAI 引擎
 * 支持 Responses(官方)与 Chat Completions(通用)两种协议,按预设的
 * openaiProtocol 预填。模板预填 baseUrl 与常见模型名,降低配置成本。
 */
export interface ProviderPreset {
  key: string
  label: string
  baseUrl: string
  models: string[]
  hint: string
  /** 该预设推荐的 OpenAI 引擎协议(undefined = responses) */
  openaiProtocol?: OpenAIProtocol
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: 'anthropic',
    label: '官方 Anthropic 兼容端点',
    baseUrl: '',
    models: ['claude-opus-4', 'claude-sonnet-4', 'claude-haiku-4'],
    hint: '直连 Anthropic 或任何原生 Messages API 端点,填入自己的 API Key。'
  },
  {
    key: 'openai',
    label: 'OpenAI(官方直连)',
    baseUrl: 'https://api.openai.com',
    models: ['gpt-4.1', 'gpt-4o', 'o3', 'o4-mini'],
    hint: '选择 OpenAI 引擎时原生直连(Responses 协议),填入 OpenAI API Key。Claude 引擎使用该 Provider 仍需要兼容网关。'
  },
  {
    key: 'deepseek',
    label: 'DeepSeek(官方直连)',
    baseUrl: 'https://api.deepseek.com/anthropic',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    hint: 'DeepSeek 官方 Anthropic 兼容端点,无须网关。api.deepseek.com 申请 Key。'
  },
  {
    key: 'deepseek-chat',
    label: 'DeepSeek(OpenAI 引擎 · Chat 协议)',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    hint: '走 OpenAI 引擎的 Chat Completions 协议直连 DeepSeek。新建会话时引擎选 OpenAI。',
    openaiProtocol: 'chat'
  },
  {
    key: 'kimi',
    label: 'Kimi / 月之暗面(官方直连)',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    models: ['kimi-k2-0711-preview', 'moonshot-v1-auto'],
    hint: 'Moonshot 官方 Anthropic 兼容端点,无须网关。platform.moonshot.cn 申请 Key。'
  },
  {
    key: 'glm',
    label: '智谱 GLM(官方直连)',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    models: ['glm-4.5', 'glm-4.5-air'],
    hint: '智谱官方 Anthropic 兼容端点,无须网关。open.bigmodel.cn 申请 Key。'
  },
  {
    key: 'grok',
    label: 'Grok / xAI(官方直连)',
    baseUrl: 'https://api.x.ai',
    models: ['grok-4', 'grok-4-fast'],
    hint: 'xAI 官方同时提供 Anthropic 兼容(/v1/messages,配 Claude 引擎)与 Chat Completions(配 OpenAI 引擎 Chat 协议)。console.x.ai 申请 Key。',
    openaiProtocol: 'chat'
  },
  {
    key: 'qwen',
    label: '通义千问 Qwen(DashScope)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
    hint: '阿里 DashScope OpenAI 兼容端点,配 OpenAI 引擎 Chat 协议。bailian.console.aliyun.com 申请 Key。',
    openaiProtocol: 'chat'
  },
  {
    key: 'local-openai',
    label: '本地 / 自部署(vLLM · Ollama · LM Studio)',
    baseUrl: 'http://localhost:11434',
    models: ['qwen3', 'llama3.3', 'deepseek-r1'],
    hint: '任何自部署 OpenAI 兼容服务(vLLM/Ollama/LM Studio 等),配 OpenAI 引擎 Chat 协议。按你的服务地址改 baseUrl。',
    openaiProtocol: 'chat'
  },
  {
    key: 'oneapi',
    label: 'one-api / new-api 网关',
    baseUrl: 'http://localhost:3000',
    models: ['gpt-4o', 'gpt-4o-mini', 'gemini-1.5-pro', 'deepseek-chat'],
    hint: '经 one-api/new-api 网关转译:请求走 Anthropic 协议,网关翻译到 OpenAI/Gemini 等后端。模型名需与网关映射一致。'
  },
  {
    key: 'litellm',
    label: 'LiteLLM 网关',
    baseUrl: 'http://localhost:4000',
    models: ['gpt-4o', 'claude-3-5-sonnet', 'gemini/gemini-1.5-pro'],
    hint: 'LiteLLM 以 /v1/messages 暴露 Anthropic 兼容端点,后端可接 OpenAI/Azure/Bedrock 等。'
  },
  {
    key: 'custom',
    label: '自定义',
    baseUrl: '',
    models: [],
    hint: '手动填写全部字段。'
  }
]
