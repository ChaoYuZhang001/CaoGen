import { useCallback, useEffect, useState } from 'react'
import type {
  LayeredMemoryEntry,
  ProjectMemoryDraft,
  ProjectMemoryEntry,
  ReadProjectMemoryResult
} from '../../../shared/types'

const EMPTY_FORM = { kind: 'note', title: '', body: '', reason: '' }

interface Props {
  sessionId: string
  onClose?: () => void
  initialForm?: Partial<typeof EMPTY_FORM>
}

/**
 * 项目记忆管理面板。
 * - readProjectMemory 拉取 confirmed 条目(entries)与待确认草稿(drafts)
 * - drafts: 采纳(acceptMemoryDraft)/ 删除(deleteMemoryEntry)
 * - confirmed: 删除(deleteMemoryEntry)
 * - 顶部表单:添加记忆(proposeMemoryDraft),提交后落入 drafts 待用户采纳
 *
 * 直接调用 window.agentDesk.*(与 SettingsModal 的迁移/健康检查同风格),
 * 无需经 store。所有 IPC 在 acting 期间禁用按钮避免并发竞态。
 */
export default function MemoryPanel({ sessionId, onClose, initialForm }: Props): React.JSX.Element {
  const [data, setData] = useState<ReadProjectMemoryResult | null>(null)
  const [layered, setLayered] = useState<LayeredMemoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [acting, setActing] = useState(false)
  const [editingLayeredId, setEditingLayeredId] = useState<string | null>(null)
  const [layeredDraft, setLayeredDraft] = useState({ title: '', body: '' })

  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ ...EMPTY_FORM })

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const [result, layeredEntries] = await Promise.all([
        window.agentDesk.readProjectMemory(sessionId),
        window.agentDesk.listLayeredMemories()
      ])
      setData(result)
      setLayered(layeredEntries)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!initialForm) return
    setForm({ ...EMPTY_FORM, ...initialForm })
    setShowForm(true)
  }, [initialForm])

  const propose = async (): Promise<void> => {
    if (!form.title.trim() || !form.body.trim()) {
      setError('标题与内容不能为空')
      return
    }
    setActing(true)
    setError('')
    try {
      await window.agentDesk.proposeMemoryDraft(sessionId, {
        kind: form.kind.trim() || 'note',
        title: form.title.trim(),
        body: form.body.trim(),
        source: 'user',
        reason: form.reason.trim()
      })
      setForm({ ...EMPTY_FORM })
      setShowForm(false)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setActing(false)
    }
  }

  const accept = async (draftId: string): Promise<void> => {
    setActing(true)
    setError('')
    try {
      await window.agentDesk.acceptMemoryDraft(sessionId, draftId)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setActing(false)
    }
  }

  const remove = async (entryId: string): Promise<void> => {
    setActing(true)
    setError('')
    try {
      await window.agentDesk.deleteMemoryEntry(sessionId, entryId)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setActing(false)
    }
  }

  const startLayeredEdit = (entry: LayeredMemoryEntry): void => {
    setEditingLayeredId(entry.id)
    setLayeredDraft({ title: entry.title, body: entry.body })
  }

  const saveLayered = async (entry: LayeredMemoryEntry): Promise<void> => {
    setActing(true)
    setError('')
    try {
      await window.agentDesk.updateLayeredMemory(entry.id, {
        title: layeredDraft.title.trim(),
        body: layeredDraft.body.trim()
      })
      setEditingLayeredId(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setActing(false)
    }
  }

  const removeLayered = async (entryId: string): Promise<void> => {
    setActing(true)
    setError('')
    try {
      await window.agentDesk.deleteLayeredMemory(entryId)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setActing(false)
    }
  }

  const drafts: ProjectMemoryDraft[] = data?.drafts ?? []
  const entries: ProjectMemoryEntry[] = data?.entries ?? []

  return (
    <div className="memory-panel" data-memory-panel="true">
      <div className="settings-section-head">
        <h3 className="settings-h3">项目记忆</h3>
        <div className="memory-panel-actions">
          <button
            className="btn btn-ghost btn-sm"
            disabled={acting}
            onClick={() => setShowForm((v) => !v)}
          >
            {showForm ? '取消' : '添加记忆'}
          </button>
          {onClose && (
            <button className="btn btn-ghost btn-sm" onClick={onClose}>
              关闭
            </button>
          )}
        </div>
      </div>
      <p className="settings-hint">
        记忆按项目隔离,采纳后写入项目记忆文件,供后续会话读取。草稿需确认后生效。
      </p>

      {showForm && (
        <div className="memory-form" data-memory-form="true">
          <label className="field-label">类型</label>
          <input
            className="input input-block"
            data-memory-form-field="kind"
            value={form.kind}
            placeholder="note / convention / gotcha …"
            onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}
          />
          <label className="field-label">标题</label>
          <input
            className="input input-block"
            data-memory-form-field="title"
            value={form.title}
            placeholder="一句话概括"
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
          />
          <label className="field-label">内容</label>
          <textarea
            className="input input-block textarea"
            data-memory-form-field="body"
            rows={3}
            value={form.body}
            placeholder="记忆正文"
            onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
          />
          <label className="field-label">
            理由 <span className="field-hint">可选</span>
          </label>
          <input
            className="input input-block"
            data-memory-form-field="reason"
            value={form.reason}
            placeholder="为什么值得记住"
            onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
          />
          <div className="modal-actions">
            <button
              className="btn btn-primary btn-sm"
              data-memory-form-action="propose"
              disabled={acting}
              onClick={() => void propose()}
            >
              {acting ? '提交中…' : '提交草稿'}
            </button>
          </div>
        </div>
      )}

      {error && <div className="notice notice-error">{error}</div>}
      {loading && <div className="provider-empty">加载中…</div>}

      {!loading && (
        <>
          <div className="memory-group">
            <h4 className="settings-h3">待确认草稿 · {drafts.length}</h4>
            {drafts.length === 0 ? (
              <div className="provider-empty">暂无草稿</div>
            ) : (
              <div className="provider-list">
                {drafts.map((d) => (
                  <div key={d.id} className="provider-row memory-row">
                    <div className="provider-row-body">
                      <div className="provider-row-name">
                        {d.title}
                        <span className="migrate-kind">{d.kind}</span>
                      </div>
                      <div className="provider-row-sub memory-body">{d.body}</div>
                      {d.reason && <div className="field-hint">理由:{d.reason}</div>}
                    </div>
                    <div className="provider-row-actions">
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={acting}
                        onClick={() => void accept(d.id)}
                      >
                        采纳
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={acting}
                        onClick={() => void remove(d.id)}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="memory-group">
            <h4 className="settings-h3">已确认记忆 · {entries.length}</h4>
            {entries.length === 0 ? (
              <div className="provider-empty">暂无记忆</div>
            ) : (
              <div className="provider-list">
                {entries.map((m) => (
                  <div key={m.id} className="provider-row memory-row">
                    <div className="provider-row-body">
                      <div className="provider-row-name">
                        {m.title}
                        <span className="migrate-kind">{m.kind}</span>
                      </div>
                      <div className="provider-row-sub memory-body">{m.body}</div>
                    </div>
                    <div className="provider-row-actions">
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={acting}
                        onClick={() => void remove(m.id)}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="memory-group">
            <h4 className="settings-h3">分层记忆 · {layered.length}</h4>
            {layered.length === 0 ? (
              <div className="provider-empty">暂无分层记忆</div>
            ) : (
              <div className="provider-list">
                {layered.map((entry) => {
                  const editing = editingLayeredId === entry.id
                  return (
                    <div key={entry.id} className="provider-row memory-row">
                      <div className="provider-row-body">
                        <div className="provider-row-name">
                          {entry.title}
                          <span className="migrate-kind">{entry.layer}</span>
                        </div>
                        {editing ? (
                          <div className="memory-form">
                            <input
                              className="input input-block"
                              value={layeredDraft.title}
                              onChange={(e) => setLayeredDraft((draft) => ({ ...draft, title: e.target.value }))}
                            />
                            <textarea
                              className="input input-block textarea"
                              rows={3}
                              value={layeredDraft.body}
                              onChange={(e) => setLayeredDraft((draft) => ({ ...draft, body: e.target.value }))}
                            />
                          </div>
                        ) : (
                          <div className="provider-row-sub memory-body">{entry.body}</div>
                        )}
                      </div>
                      <div className="provider-row-actions">
                        {editing ? (
                          <>
                            <button className="btn btn-ghost btn-sm" disabled={acting} onClick={() => void saveLayered(entry)}>
                              保存
                            </button>
                            <button className="btn btn-ghost btn-sm" disabled={acting} onClick={() => setEditingLayeredId(null)}>
                              取消
                            </button>
                          </>
                        ) : (
                          <>
                            <button className="btn btn-ghost btn-sm" disabled={acting} onClick={() => startLayeredEdit(entry)}>
                              编辑
                            </button>
                            <button className="btn btn-ghost btn-sm" disabled={acting} onClick={() => void removeLayered(entry.id)}>
                              删除
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
