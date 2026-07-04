import { create } from 'zustand'
import { AUTO_MODEL } from '../../shared/types'
import type {
  AgentEvent,
  AppSettings,
  AssistantBlock,
  CreateSessionOptions,
  HistoryEntry,
  PermissionModeId,
  PermissionRequestInfo,
  Project,
  ProviderInput,
  ProviderView,
  SchedulerStrategy,
  SessionMeta,
  TranscriptEntry,
  UsageTotals
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
  | { id: string; kind: 'user'; text: string; checkpointId?: string }
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
      return { ...s, items: [...s.items, { id: genId(), kind: 'user', text: ev.text }] }
    case 'checkpoint': {
      // 把检查点挂到最近一条尚无检查点的用户消息上
      const items = [...s.items]
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
  showNewSession: boolean
  showSettings: boolean
  init(): Promise<void>
  handleEvent(sessionId: string, event: AgentEvent, seq: number): void
  createSession(opts: CreateSessionOptions): Promise<void>
  resumeFromHistory(entry: HistoryEntry): Promise<void>
  selectSession(id: string): void
  sendMessage(text: string): Promise<void>
  interrupt(): Promise<void>
  closeSession(id: string): Promise<void>
  respondPermission(sessionId: string, requestId: string, allow: boolean): Promise<void>
  setPermissionMode(mode: PermissionModeId): Promise<void>
  setModel(model: string): Promise<void>
  renameSession(id: string, title: string): Promise<void>
  updateSettings(patch: Partial<AppSettings>): Promise<void>
  setView(view: AppView): void
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
  showNewSession: false,
  showSettings: false,

  async init() {
    if (get().ready) return
    set({ ready: true })
    window.agentDesk.onSessionEvent((sessionId, event, seq) => get().handleEvent(sessionId, event, seq))
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

  async sendMessage(text) {
    const id = get().activeId
    if (!id) return
    set((s) => {
      const session = s.sessions[id]
      if (!session) return s
      return {
        sessions: {
          ...s.sessions,
          [id]: {
            ...session,
            items: [...session.items, { id: genId(), kind: 'user', text }],
            meta: { ...session.meta, status: 'running' }
          }
        }
      }
    })
    await window.agentDesk.sendMessage(id, text)
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
