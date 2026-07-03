import { BrowserWindow } from 'electron'
import { AgentSession, newSessionMeta } from './agentSession'
import { upsertHistory, listHistory } from './history'
import { getSettings } from './settings'
import { cleanupTranscripts } from './transcript'
import type {
  AgentEvent,
  CreateSessionOptions,
  SessionEventPayload,
  SessionMeta,
  TranscriptEntry
} from '../shared/types'

class SessionManager {
  private readonly sessions = new Map<string, AgentSession>()

  list(): SessionMeta[] {
    return [...this.sessions.values()].map((s) => ({ ...s.meta }))
  }

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id)
  }

  create(opts: CreateSessionOptions): SessionMeta {
    const settings = getSettings()
    const meta = newSessionMeta({
      cwd: opts.cwd,
      model: opts.model ?? settings.defaultModel,
      providerId: opts.providerId ?? settings.defaultProviderId,
      permissionMode: opts.permissionMode ?? settings.defaultPermissionMode,
      title: opts.title
    })
    const session = new AgentSession(
      meta,
      (event, seq) => this.dispatch(meta.id, event, seq),
      opts.resumeSdkSessionId
    )
    this.sessions.set(meta.id, session)
    void session.start()
    return { ...meta }
  }

  close(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    session.dispose()
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) session.dispose()
    this.sessions.clear()
  }

  getTranscript(id: string): TranscriptEntry[] {
    return this.sessions.get(id)?.getTranscript() ?? []
  }

  /** 启动时清理不可达转录文件 */
  init(): void {
    const keep = new Set(listHistory().map((h) => h.sdkSessionId))
    cleanupTranscripts(keep)
  }

  private dispatch(sessionId: string, event: AgentEvent, seq: number): void {
    const payload: SessionEventPayload = { sessionId, seq, event }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('session:event', payload)
    }
    if (event.kind === 'init' || event.kind === 'turn-result' || event.kind === 'meta') {
      this.persist(sessionId)
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
      model: meta.model,
      providerId: meta.providerId,
      permissionMode: meta.permissionMode,
      sdkSessionId: meta.sdkSessionId,
      createdAt: meta.createdAt,
      updatedAt: Date.now(),
      costUsd: meta.costUsd
    })
  }
}

export const sessionManager = new SessionManager()
