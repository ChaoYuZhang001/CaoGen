import { create } from 'zustand'
import type {
  AgentEvent,
  AppSettings,
  AssistantBlock,
  CreateSessionOptions,
  HistoryEntry,
  PermissionModeId,
  PermissionRequestInfo,
  SessionMeta,
  UsageTotals
} from '../../shared/types'

let seq = 0
const genId = (): string => `it-${Date.now().toString(36)}-${seq++}`

/**
 * createSession IPC 返回前主进程可能已开始广播该会话的事件(status/init),
 * 此时 store 里还没有对应条目;先缓存,注册时按序重放,避免丢 sdkSessionId 等状态。
 */
const pendingEvents = new Map<string, AgentEvent[]>()
const PENDING_EVENTS_CAP = 200

function stashPendingEvent(sessionId: string, event: AgentEvent): void {
  const queue = pendingEvents.get(sessionId) ?? []
  if (queue.length < PENDING_EVENTS_CAP) queue.push(event)
  pendingEvents.set(sessionId, queue)
}

function drainPendingEvents(sessionId: string, state: SessionState): SessionState {
  const queue = pendingEvents.get(sessionId)
  if (!queue) return state
  pendingEvents.delete(sessionId)
  return queue.reduce(reduceSession, state)
}

export interface ToolResultInfo {
  content: string
  isError: boolean
}

export type ChatItem =
  | { id: string; kind: 'user'; text: string }
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
}

function newSessionState(meta: SessionMeta): SessionState {
  return {
    meta,
    items: [],
    streamText: '',
    streamThinking: '',
    toolResults: {},
    runningTools: {},
    pendingPermissions: []
  }
}

function reduceSession(s: SessionState, ev: AgentEvent): SessionState {
  switch (ev.kind) {
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

interface AppStore {
  ready: boolean
  sessions: Record<string, SessionState>
  order: string[]
  activeId: string | null
  history: HistoryEntry[]
  settings: AppSettings
  showNewSession: boolean
  showSettings: boolean
  init(): Promise<void>
  handleEvent(sessionId: string, event: AgentEvent): void
  createSession(opts: CreateSessionOptions): Promise<void>
  resumeFromHistory(entry: HistoryEntry): Promise<void>
  selectSession(id: string): void
  sendMessage(text: string): Promise<void>
  interrupt(): Promise<void>
  closeSession(id: string): Promise<void>
  respondPermission(sessionId: string, requestId: string, allow: boolean): Promise<void>
  setPermissionMode(mode: PermissionModeId): Promise<void>
  setModel(model: string): Promise<void>
  updateSettings(patch: Partial<AppSettings>): Promise<void>
  setShowNewSession(v: boolean): void
  setShowSettings(v: boolean): void
}

export const useStore = create<AppStore>((set, get) => ({
  ready: false,
  sessions: {},
  order: [],
  activeId: null,
  history: [],
  settings: { defaultModel: '', defaultPermissionMode: 'default' },
  showNewSession: false,
  showSettings: false,

  async init() {
    if (get().ready) return
    set({ ready: true })
    window.agentDesk.onSessionEvent((sessionId, event) => get().handleEvent(sessionId, event))
    const [metas, history, settings] = await Promise.all([
      window.agentDesk.listSessions(),
      window.agentDesk.listHistory(),
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
        sessions,
        order,
        history,
        settings,
        activeId: s.activeId ?? order[0] ?? null
      }
    })
    // 渲染进程重载会丢掉未决权限请求;从主进程补回,否则会话会永远卡在等待授权
    for (const meta of metas) {
      void window.agentDesk.listPendingPermissions(meta.id).then((reqs) => {
        if (reqs.length === 0) return
        set((s) => {
          const session = s.sessions[meta.id]
          if (!session) return s
          const known = new Set(session.pendingPermissions.map((p) => p.requestId))
          const merged = [...session.pendingPermissions, ...reqs.filter((r) => !known.has(r.requestId))]
          return {
            sessions: {
              ...s.sessions,
              [meta.id]: { ...session, pendingPermissions: merged }
            }
          }
        })
      })
    }
  },

  handleEvent(sessionId, event) {
    set((s) => {
      const session = s.sessions[sessionId]
      if (!session) {
        stashPendingEvent(sessionId, event)
        return s
      }
      return { sessions: { ...s.sessions, [sessionId]: reduceSession(session, event) } }
    })
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
  },

  async resumeFromHistory(entry) {
    await get().createSession({
      cwd: entry.cwd,
      model: entry.model,
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

  async updateSettings(patch) {
    const settings = await window.agentDesk.updateSettings(patch)
    set({ settings })
  },

  setShowNewSession(v) {
    set({ showNewSession: v })
  },

  setShowSettings(v) {
    set({ showSettings: v })
  }
}))

export const MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '默认模型' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' }
]

export const PERMISSION_OPTIONS: Array<{ value: PermissionModeId; label: string }> = [
  { value: 'default', label: '默认(询问)' },
  { value: 'acceptEdits', label: '自动接受编辑' },
  { value: 'plan', label: '规划模式' },
  { value: 'bypassPermissions', label: '跳过权限' }
]
