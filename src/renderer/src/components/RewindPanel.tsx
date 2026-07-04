import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { useT } from '../i18n'
import type { RewindResult } from '../../../shared/types'

function previewLabel(preview: RewindResult): string {
  const files = preview.filesChanged?.length ?? 0
  return `将恢复 ${files} 个文件 · +${preview.insertions ?? 0}/-${preview.deletions ?? 0} 行`
}

export default function RewindPanel(): React.JSX.Element | null {
  const t = useT()
  const activeId = useStore((s) => s.activeId)
  const { open, messageId, sourceText } = useStore((s) => s.rewindPanel)
  const close = useStore((s) => s.closeRewindPanel)
  const [preview, setPreview] = useState<RewindResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')

  useEffect(() => {
    if (!open || !activeId || !messageId) return
    let cancelled = false
    setPreview(null)
    setStatus('')
    setBusy(true)
    void window.agentDesk.rewindFiles(activeId, messageId, true).then((res) => {
      if (cancelled) return
      setPreview(res)
      setBusy(false)
    })
    return () => {
      cancelled = true
    }
  }, [open, activeId, messageId])

  const files = useMemo(() => preview?.filesChanged ?? [], [preview])

  if (!open) return null

  const apply = async (): Promise<void> => {
    if (!activeId || !messageId) return
    setBusy(true)
    const res = await window.agentDesk.rewindFiles(activeId, messageId, false)
    setBusy(false)
    if (res.error) {
      setStatus(res.error)
      return
    }
    const n = res.filesChanged?.length ?? 0
    setStatus(n > 0 ? `已回退 ${n} 个文件 (+${res.insertions ?? 0}/-${res.deletions ?? 0})` : '无需回退')
    window.setTimeout(close, 1200)
  }

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <section className="modal rewind-panel no-drag" onMouseDown={(e) => e.stopPropagation()}>
        <header className="rewind-panel-head">
          <div>
            <h2 className="modal-title">{t('rewindPanelTitle')}</h2>
            <p className="rewind-panel-sub">{t('rewindPanelSub')}</p>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={close}>
            {t('close')}
          </button>
        </header>

        <div className="rewind-mode-row" aria-label={t('rewindMode')}>
          <button className="rewind-mode active">{t('rewindCode')}</button>
          <button className="rewind-mode" disabled title={t('rewindComingSoon')}>
            {t('rewindChat')}
          </button>
          <button className="rewind-mode" disabled title={t('rewindComingSoon')}>
            {t('rewindBoth')}
          </button>
        </div>

        {sourceText && <div className="rewind-source">{sourceText}</div>}

        {!messageId ? (
          <div className="notice notice-info">{t('noCheckpointAvailable')}</div>
        ) : busy && !preview ? (
          <div className="rewind-panel-loading">
            <span className="spinner" />
            {t('rewindPreviewing')}
          </div>
        ) : preview?.error ? (
          <div className="notice notice-error">{preview.error}</div>
        ) : preview && !preview.canRewind ? (
          <div className="notice notice-info">{t('nothingToRewind')}</div>
        ) : preview ? (
          <>
            <div className="rewind-summary">{previewLabel(preview)}</div>
            <div className="rewind-file-list">
              {files.slice(0, 24).map((file) => (
                <div key={file} className="rewind-file-row">
                  {file}
                </div>
              ))}
              {files.length > 24 && (
                <div className="rewind-file-row muted">{t('moreFiles', { n: files.length - 24 })}</div>
              )}
            </div>
          </>
        ) : null}

        {status && (
          <div className={`notice ${status.includes('失败') ? 'notice-error' : 'notice-info'}`}>{status}</div>
        )}

        <footer className="modal-actions">
          <button className="btn btn-ghost" onClick={close}>
            {t('cancel')}
          </button>
          <button
            className="btn btn-danger"
            disabled={busy || !preview?.canRewind || Boolean(preview.error)}
            onClick={() => void apply()}
          >
            {busy ? t('rewindApplying') : t('rewindApplyCode')}
          </button>
        </footer>
      </section>
    </div>
  )
}
