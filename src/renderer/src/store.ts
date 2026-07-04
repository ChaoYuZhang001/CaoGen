import { create } from 'zustand'
import { AUTO_MODEL } from '../../shared/types'
import type {
  AgentEvent,
  AppSettings,
  AssistantBlock,
  BrowserAnnotation,
  BrowserBounds,
  BrowserEvent,
  BrowserViewState,
  CreateSessionOptions,
  HistoryEntry,
  PermissionModeId,
  ProjectFileEntry,
  PermissionRequestInfo,
  PreparedPreview,
  Project,
  ProviderInput,
  ProviderView,
  WriteTextFileResult,
  SchedulerStrategy,
  SendMessagePayload,
  SessionMeta,
  UserMessageAttachmentView,
  TranscriptEntry,
  TerminalEvent,
  TerminalInfo,
  UsageTotals,
  WorkspaceDiff,
  WorktreePatchResult,
  WorktreeRemoveResult,
  WorktreeSummary
} from '../../shared/types'

let seq = 0
const genId = (): string => `it-${Date.now().toString(36)}-${seq++}`

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

export interface ToolResultInfo {
  content: string
  isError: boolean
}

export type ChatItem =
  | {
      id: string
      kind: 'user'
      text: string
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
    lastSeq: 0
  }
}

function reduceSession(s: SessionState, ev: AgentEvent): SessionState {
  switch (ev.kind) {
    case 'user-message':
      return {
        ...s,
        items: [
          ...s.items,
          {
            id: ev.messageId ?? genId(),
            kind: 'user',
            text: ev.text,
            attachments: ev.attachments
          }
        ]
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
  worktreeOpen: boolean
  worktreeLoading: boolean
  worktree?: WorktreeSummary
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
  previewOpen: boolean
  previewLoading: boolean
  preview?: PreparedPreview
  previewPath?: string
  previewError?: string
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
  init(): Promise<void>
  handleEvent(sessionId: string, event: AgentEvent, seq: number): void
  handleTerminalEvent(event: TerminalEvent): void
  handleBrowserEvent(event: BrowserEvent): void
  createSession(opts: CreateSessionOptions): Promise<void>
  resumeFromHistory(entry: HistoryEntry): Promise<void>
  selectSession(id: string): void
  sendMessage(input: string | SendMessagePayload): Promise<void>
  interrupt(): Promise<void>
  closeSession(id: string): Promise<void>
  respondPermission(sessionId: string, requestId: string, allow: boolean): Promise<void>
  setPermissionMode(mode: PermissionModeId): Promise<void>
  setModel(model: string): Promise<void>
  renameSession(id: string, title: string): Promise<void>
  updateSettings(patch: Partial<AppSettings>): Promise<void>
  setView(view: AppView): void
  openDiffPanel(): Promise<void>
  closeDiffPanel(): void
  refreshDiffPanel(): Promise<void>
  openWorktreePanel(): Promise<void>
  closeWorktreePanel(): void
  refreshWorktreePanel(): Promise<void>
  exportWorktreePatch(): Promise<WorktreePatchResult | undefined>
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
}

export const useStore = create<AppStore>((set, get) => ({
  ready: false,
  sessions: {},
  order: [],
  activeId: null,
  history: [],
  settings: {
    defaultModel: '',
    defaultPermissionMode: 'default',
    defaultProviderId: '',
    schedulerStrategy: 'balanced',
    failoverEnabled: true,
    language: 'zh',
    theme: 'dark',
    persona: '',
    allowedTools: '',
    disallowedTools: '',
    office: { showBadges: true, liveliness: 1, catEars: false }
  },
  providers: [],
  projects: [],
  view: 'list',
  workbench: {
    diffOpen: false,
    diffLoading: false,
    worktreeOpen: false,
    worktreeLoading: false,
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
    previewLoading: false
  },
  rewindPanel: { open: false },
  showNewSession: false,
  showSettings: false,

  async init() {
    if (get().ready) return
    set({ ready: true })
    window.agentDesk.onSessionEvent((sessionId, event, seq) => get().handleEvent(sessionId, event, seq))
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

  async resumeFromHistory(entry) {
    await get().createSession({
      cwd: entry.cwd,
      model: entry.model,
      providerId: entry.providerId,
      permissionMode: entry.permissionMode,
      resumeSdkSessionId: entry.sdkSessionId,
      title: entry.title
    })
  },

  selectSession(id) {
    set({ activeId: id })
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

  async updateSettings(patch) {
    const settings = await window.agentDesk.updateSettings(patch)
    set({ settings })
  },

  setView(view) {
    set({ view })
  },

  async openDiffPanel() {
    set((s) => ({
      workbench: {
        ...s.workbench,
        diffOpen: true,
        worktreeOpen: false,
        terminalOpen: false,
        filesOpen: false,
        browserOpen: false,
        previewOpen: false
      }
    }))
    await get().refreshDiffPanel()
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

  async openWorktreePanel() {
    set((s) => ({
      workbench: {
        ...s.workbench,
        diffOpen: false,
        worktreeOpen: true,
        terminalOpen: false,
        filesOpen: false,
        browserOpen: false,
        previewOpen: false
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
    set((s) => ({
      workbench: {
        ...s.workbench,
        diffOpen: false,
        worktreeOpen: false,
        terminalOpen: true,
        filesOpen: false,
        browserOpen: false,
        previewOpen: false
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
    set((s) => ({
      workbench: {
        ...s.workbench,
        diffOpen: false,
        worktreeOpen: false,
        terminalOpen: false,
        filesOpen: true,
        browserOpen: false,
        previewOpen: false
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
  }
}))

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
 * Provider 预设模板。底层 SDK 只讲 Anthropic Messages API 协议,
 * 要接入 OpenAI / Gemini / 国产模型,需经 Anthropic 兼容网关翻译。
 * 模板预填 baseUrl 占位与常见模型名,降低配置成本。
 */
export interface ProviderPreset {
  key: string
  label: string
  baseUrl: string
  models: string[]
  hint: string
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
    key: 'deepseek',
    label: 'DeepSeek(官方直连)',
    baseUrl: 'https://api.deepseek.com/anthropic',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    hint: 'DeepSeek 官方 Anthropic 兼容端点,无须网关。api.deepseek.com 申请 Key。'
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
