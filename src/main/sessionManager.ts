import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { newSessionMeta } from './agentSession'
import { createEngine } from './engine'
import type { Engine } from './engine'
import { registerBuiltinEngines } from './engines'
import { upsertHistory, listHistory } from './history'
import { getSettings } from './settings'
import { cleanupTranscripts } from './transcript'
import { touchProject } from './projects'
import { prepareWorktree } from './worktrees'
import { showDesktopNotification } from './desktopNotify'
import type {
  AgentEvent,
  CreateSessionOptions,
  DispatchSubagentsInput,
  SubagentDispatchResult,
  SessionEventPayload,
  SessionMeta,
  TranscriptEntry
} from '../shared/types'

interface SessionNotificationState {
  turnActive: boolean
  permissionNotified: boolean
  terminalNotified: boolean
}

function trimForNotification(text: string, max = 120): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function formatDuration(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return undefined
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`
}

function cleanOneLine(text: string, fallback: string, max = 80): string {
  const clean = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
  return (clean || fallback).slice(0, max)
}

function normalizeTaskId(value: string | undefined, fallback: string): string {
  const clean = typeof value === 'string' ? value.trim() : ''
  if (!clean) return fallback
  return clean.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 80) || fallback
}

class SessionManager {
  private readonly sessions = new Map<string, Engine>()
  private readonly notificationStates = new Map<string, SessionNotificationState>()

  list(): SessionMeta[] {
    return [...this.sessions.values()].map((s) => ({ ...s.meta }))
  }

  get(id: string): Engine | undefined {
    return this.sessions.get(id)
  }

  create(opts: CreateSessionOptions): SessionMeta {
    const settings = getSettings()
    const baseMeta = newSessionMeta({
      cwd: opts.cwd,
      parentSessionId: opts.parentSessionId,
      orchestrationId: opts.orchestrationId,
      childTaskId: opts.childTaskId,
      childRole: opts.childRole,
      model: opts.model ?? settings.defaultModel,
      providerId: opts.providerId ?? settings.defaultProviderId,
      budgetUsd: opts.budgetUsd,
      engine: opts.engine,
      permissionMode: opts.permissionMode ?? settings.defaultPermissionMode,
      title: opts.title
    })
    const worktree =
      opts.resumeSdkSessionId !== undefined
        ? { ok: true as const, isolated: false, cwd: opts.cwd }
        : prepareWorktree({ sessionId: baseMeta.id, cwd: opts.cwd, isolated: opts.isolated })
    if (!worktree.ok) throw new Error(worktree.error)
    const meta = newSessionMeta({
      cwd: worktree.cwd,
      parentSessionId: opts.parentSessionId,
      orchestrationId: opts.orchestrationId,
      childTaskId: opts.childTaskId,
      childRole: opts.childRole,
      isolated: worktree.isolated,
      sourceCwd: worktree.record?.sourceCwd,
      repoRoot: worktree.record?.repoRoot,
      worktreePath: worktree.record?.worktreePath,
      branch: worktree.record?.branch,
      baseBranch: worktree.record?.baseBranch,
      baseSha: worktree.record?.baseSha,
      worktreeState: worktree.record?.state,
      model: opts.model ?? settings.defaultModel,
      providerId: opts.providerId ?? settings.defaultProviderId,
      budgetUsd: opts.budgetUsd,
      engine: opts.engine,
      permissionMode: opts.permissionMode ?? settings.defaultPermissionMode,
      title: opts.title
    })
    meta.id = baseMeta.id
    const session = createEngine(
      opts.engine,
      meta,
      (event, seq) => this.dispatch(meta.id, event, seq),
      opts.resumeSdkSessionId
    )
    this.sessions.set(meta.id, session)
    void session.start()
    touchProject(meta.sourceCwd ?? meta.cwd)
    return { ...meta }
  }

  dispatchSubagents(parentSessionId: string, input: DispatchSubagentsInput): SubagentDispatchResult {
    const parent = this.sessions.get(parentSessionId)
    if (!parent) throw new Error('父会话不存在')
    const tasks = Array.isArray(input?.tasks) ? input.tasks : []
    if (tasks.length === 0) throw new Error('至少需要一个子代理任务')
    if (tasks.length > 33) throw new Error('一次最多派发 33 个子代理')

    const orchestrationId = randomUUID()
    const children: SubagentDispatchResult['children'] = []
    const usedTaskIds = new Set<string>()

    tasks.forEach((task, index) => {
      const prompt = typeof task.prompt === 'string' ? task.prompt.trim() : ''
      if (!prompt) throw new Error(`子代理任务 ${index + 1} 缺少 prompt`)
      let taskId = normalizeTaskId(task.id, `task-${index + 1}`)
      while (usedTaskIds.has(taskId)) taskId = `${taskId}-${index + 1}`
      usedTaskIds.add(taskId)
      const role = cleanOneLine(task.role ?? '', '', 40) || undefined
      const title = cleanOneLine(task.title ?? role ?? prompt, `子代理 ${index + 1}`, 42)
      const meta = this.create({
        cwd: task.cwd ?? input.cwd ?? parent.meta.sourceCwd ?? parent.meta.cwd,
        isolated: task.isolated ?? input.isolated ?? true,
        model: task.model ?? input.model ?? parent.meta.model,
        providerId: task.providerId ?? input.providerId ?? parent.meta.providerId,
        engine: task.engine ?? input.engine ?? parent.meta.engine,
        permissionMode: task.permissionMode ?? input.permissionMode ?? parent.meta.permissionMode,
        title,
        parentSessionId,
        orchestrationId,
        childTaskId: taskId,
        childRole: role
      })
      this.sessions.get(meta.id)?.send(prompt)
      children.push({ taskId, prompt, meta })
    })

    return { orchestrationId, parentSessionId, children }
  }

  close(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    this.notificationStates.delete(id)
    session.dispose()
  }

  updateWorktreeState(id: string, state: SessionMeta['worktreeState']): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.meta.worktreeState = state
    this.persist(id)
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) session.dispose()
    this.sessions.clear()
    this.notificationStates.clear()
  }

  getTranscript(id: string): TranscriptEntry[] {
    return this.sessions.get(id)?.getTranscript() ?? []
  }

  /** 启动时:注册内置引擎 + 清理不可达转录文件 */
  init(): void {
    registerBuiltinEngines()
    const keep = new Set(listHistory().map((h) => h.sdkSessionId))
    cleanupTranscripts(keep)
  }

  private dispatch(sessionId: string, event: AgentEvent, seq: number): void {
    const payload: SessionEventPayload = { sessionId, seq, event }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('session:event', payload)
    }
    const session = this.sessions.get(sessionId)
    const parentSessionId = session?.meta.parentSessionId
    if (event.kind === 'turn-result' && parentSessionId && this.sessions.has(parentSessionId)) {
      const childResult: AgentEvent = {
        kind: 'subagent-result',
        orchestrationId: session.meta.orchestrationId,
        childTaskId: session.meta.childTaskId,
        childSessionId: sessionId,
        childRole: session.meta.childRole,
        status: event.isError ? 'error' : 'done',
        resultText: event.resultText,
        costUsd: event.costUsd,
        durationMs: event.durationMs
      }
      const parentPayload: SessionEventPayload = { sessionId: parentSessionId, seq: 0, event: childResult }
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('session:event', parentPayload)
      }
    }
    this.handleNotification(sessionId, event)
    if (event.kind === 'init' || event.kind === 'turn-result' || event.kind === 'meta') {
      this.persist(sessionId)
    }
  }

  private notificationState(sessionId: string): SessionNotificationState {
    let state = this.notificationStates.get(sessionId)
    if (!state) {
      state = {
        turnActive: false,
        permissionNotified: false,
        terminalNotified: false
      }
      this.notificationStates.set(sessionId, state)
    }
    return state
  }

  private sessionNotificationLabel(meta: SessionMeta | undefined): string {
    if (!meta) return '未知会话'
    if (meta.title && meta.title !== '新会话') return trimForNotification(meta.title, 80)
    return trimForNotification(meta.cwd, 100)
  }

  private notify(sessionId: string, title: string, body: string): void {
    showDesktopNotification({ title, body, sessionId })
  }

  private handleNotification(sessionId: string, event: AgentEvent): void {
    if (!this.sessions.has(sessionId) && !this.notificationStates.has(sessionId)) return
    const state = this.notificationState(sessionId)
    const meta = this.sessions.get(sessionId)?.meta
    const label = this.sessionNotificationLabel(meta)

    if (event.kind === 'user-message') {
      state.turnActive = true
      state.permissionNotified = false
      state.terminalNotified = false
      return
    }

    if (event.kind === 'status') {
      if (event.status === 'running' && !state.turnActive) {
        state.turnActive = true
        state.permissionNotified = false
        state.terminalNotified = false
      } else if (event.status === 'error') {
        if (!state.terminalNotified) {
          const error = event.error || meta?.lastError || '未知错误'
          this.notify(sessionId, 'CaoGen: 任务失败', `${label} · ${trimForNotification(error)}`)
          state.terminalNotified = true
        }
        state.turnActive = false
      } else if (event.status === 'idle' || event.status === 'closed') {
        state.turnActive = false
        if (event.status === 'closed') this.notificationStates.delete(sessionId)
      }
      return
    }

    if (event.kind === 'permission-request') {
      if (!state.permissionNotified) {
        const tool = trimForNotification(event.request.toolName, 60)
        this.notify(sessionId, 'CaoGen: 等待权限', `${label} · ${tool}`)
        state.permissionNotified = true
      }
      return
    }

    if (event.kind === 'turn-result') {
      if (!state.terminalNotified) {
        const bits = [label]
        const duration = formatDuration(event.durationMs)
        if (duration) bits.push(duration)
        if (typeof event.costUsd === 'number' && Number.isFinite(event.costUsd)) {
          bits.push(`$${event.costUsd.toFixed(4)}`)
        }
        if (event.isError && event.resultText) {
          bits.push(trimForNotification(event.resultText))
        }
        this.notify(sessionId, event.isError ? 'CaoGen: 任务失败' : 'CaoGen: 任务完成', bits.join(' · '))
        state.terminalNotified = true
      }
      state.turnActive = false
    }
  }

  private persist(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const meta = session.meta
    if (!meta.sdkSessionId) return
    upsertHistory({
      id: meta.id,
      title: meta.title,
      cwd: meta.cwd,
      parentSessionId: meta.parentSessionId,
      orchestrationId: meta.orchestrationId,
      childTaskId: meta.childTaskId,
      childRole: meta.childRole,
      isolated: meta.isolated,
      sourceCwd: meta.sourceCwd,
      repoRoot: meta.repoRoot,
      worktreePath: meta.worktreePath,
      branch: meta.branch,
      baseBranch: meta.baseBranch,
      baseSha: meta.baseSha,
      worktreeState: meta.worktreeState,
      model: meta.model,
      providerId: meta.providerId,
      engine: meta.engine,
      permissionMode: meta.permissionMode,
      sdkSessionId: meta.sdkSessionId,
      createdAt: meta.createdAt,
      updatedAt: Date.now(),
      costUsd: meta.costUsd
    })
  }
}

export const sessionManager = new SessionManager()
