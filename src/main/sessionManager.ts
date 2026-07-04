import { BrowserWindow } from 'electron'
import { newSessionMeta } from './agentSession'
import { createEngine } from './engine'
import type { Engine } from './engine'
import { registerBuiltinEngines } from './engines'
import { upsertHistory, listHistory } from './history'
import { getSettings } from './settings'
import { cleanupTranscripts } from './transcript'
import { touchProject } from './projects'
import { prepareWorktree } from './worktrees'
import type {
  AgentEvent,
  CreateSessionOptions,
  SessionEventPayload,
  SessionMeta,
  TranscriptEntry
} from '../shared/types'

class SessionManager {
  private readonly sessions = new Map<string, Engine>()

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
      model: opts.model ?? settings.defaultModel,
      providerId: opts.providerId ?? settings.defaultProviderId,
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
      permissionMode: meta.permissionMode,
      sdkSessionId: meta.sdkSessionId,
      createdAt: meta.createdAt,
      updatedAt: Date.now(),
      costUsd: meta.costUsd
    })
  }
}

export const sessionManager = new SessionManager()
