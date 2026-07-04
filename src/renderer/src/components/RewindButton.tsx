import { useState } from 'react'
import { useStore } from '../store'
import type { RewindResult } from '../../../shared/types'

/**
 * 用户消息旁的"回退"入口:点开先 dryRun 预览将改动的文件与增删行数,
 * 确认后真正回退代码到这条消息之前的状态。
 */
export default function RewindButton({ messageId }: { messageId: string }): React.JSX.Element {
  const activeId = useStore((s) => s.activeId)
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<RewindResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState('')

  const openPreview = async (): Promise<void> => {
    if (!activeId) return
    setOpen(true)
    setBusy(true)
    setDone('')
    const res = await window.agentDesk.rewindFiles(activeId, messageId, true)
    setPreview(res)
    setBusy(false)
  }

  const apply = async (): Promise<void> => {
    if (!activeId) return
    setBusy(true)
    const res = await window.agentDesk.rewindFiles(activeId, messageId, false)
    setBusy(false)
    if (res.error) {
      setDone(`回退失败:${res.error}`)
    } else {
      const n = res.filesChanged?.length ?? 0
      setDone(n > 0 ? `已回退 ${n} 个文件 (+${res.insertions ?? 0}/-${res.deletions ?? 0})` : '无需回退')
      setTimeout(() => setOpen(false), 1600)
    }
  }

  return (
    <span className="rewind">
      <button className="rewind-trigger" title="回退代码到此轮之前" onClick={() => void openPreview()}>
        ⟲ 回退
      </button>
      {open && (
        <div className="rewind-pop" onClick={(e) => e.stopPropagation()}>
          {busy && !preview && <div className="rewind-line">正在预览…</div>}
          {done ? (
            <div className="rewind-line">{done}</div>
          ) : preview ? (
            preview.error ? (
              <div className="rewind-line rewind-err">{preview.error}</div>
            ) : !preview.canRewind ? (
              <div className="rewind-line">此处无可回退的文件改动</div>
            ) : (
              <>
                <div className="rewind-line">
                  将回退 {preview.filesChanged?.length ?? 0} 个文件 · +{preview.insertions ?? 0}/-
                  {preview.deletions ?? 0} 行
                </div>
                {preview.filesChanged && preview.filesChanged.length > 0 && (
                  <div className="rewind-files">
                    {preview.filesChanged.slice(0, 6).map((f) => (
                      <div key={f} className="rewind-file">
                        {f}
                      </div>
                    ))}
                    {preview.filesChanged.length > 6 && (
                      <div className="rewind-file">…共 {preview.filesChanged.length} 个</div>
                    )}
                  </div>
                )}
                <div className="rewind-actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
                    取消
                  </button>
                  <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => void apply()}>
                    {busy ? '回退中…' : '回退代码'}
                  </button>
                </div>
              </>
            )
          ) : null}
        </div>
      )}
    </span>
  )
}
