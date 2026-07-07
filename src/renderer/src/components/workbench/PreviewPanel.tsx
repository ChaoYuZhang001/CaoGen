import { useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import PreviewRenderer from './PreviewRenderer'
import { truncate } from './previewUtils'

function annotationLabel(note: string): string {
  const clean = note.replace(/\s+/g, ' ').trim()
  return clean.length > 86 ? `${clean.slice(0, 85)}...` : clean
}

function previewPrompt(
  previewPath: string | undefined,
  preview: unknown,
  annotations: Array<{ note: string; createdAt: string }>
): string {
  const p = preview as {
    path?: string
    type?: string
    mode?: string
    mime?: string
    bytes?: number
    content?: string
  }
  const content = typeof p.content === 'string' ? truncate(p.content, 20_000) : ''
  const notes = annotations
    .slice(0, 20)
    .map((item, index) => `${index + 1}. [${item.createdAt}] ${item.note}`)
    .join('\n')
  return [
    '请基于这个 CaoGen 产物预览继续工作。',
    '',
    `文件: ${p.path ?? previewPath ?? '(unknown)'}`,
    `类型: ${p.type ?? '(unknown)'}`,
    `MIME: ${p.mime ?? '(unknown)'}`,
    typeof p.bytes === 'number' ? `大小: ${p.bytes} bytes` : '',
    content ? '\n预览内容:\n```' : '',
    content,
    content ? '```' : '',
    notes ? '\n结构化批注:\n' : '',
    notes,
    '',
    '请指出需要修改的文件、具体问题和下一步操作。'
  ]
    .filter(Boolean)
    .join('\n')
}

export default function PreviewPanel(): React.JSX.Element {
  const t = useT()
  const activeId = useStore((s) => s.activeId)
  const { preview, previewAnnotations, previewError, previewLoading, previewPath } = useStore((s) => s.workbench)
  const refresh = useStore((s) => s.refreshPreviewPanel)
  const close = useStore((s) => s.closePreviewPanel)
  const sendMessage = useStore((s) => s.sendMessage)
  const saveAnnotation = useStore((s) => s.savePreviewAnnotation)
  const [note, setNote] = useState('')

  useEffect(() => {
    if (activeId && previewPath) void refresh()
  }, [activeId, previewPath, refresh])

  const saveNote = async (): Promise<void> => {
    await saveAnnotation(note)
    setNote('')
  }

  return (
    <div className="preview-panel">
      <header className="workspace-diff-top">
        <div>
          <div className="workspace-diff-title">{t('previewPanelTitle')}</div>
          <div className="workspace-diff-sub">{previewPath ?? ''}</div>
        </div>
        <div className="workspace-diff-actions">
          <button className="btn btn-ghost btn-sm" disabled={previewLoading || !previewPath} onClick={() => void refresh()}>
            {previewLoading ? t('loadingDiff') : t('refresh')}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            disabled={!preview || preview.ok === false}
            onClick={() => {
              if (preview) void sendMessage(previewPrompt(previewPath, preview, previewAnnotations))
            }}
          >
            {t('sendToAgent')}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={close}>
            {t('close')}
          </button>
        </div>
      </header>

      {previewError && <div className="notice notice-error workspace-diff-notice">{previewError}</div>}
      {previewLoading && !preview ? (
        <div className="workspace-diff-empty">{t('previewLoading')}</div>
      ) : preview ? (
        <div className="preview-panel-body">
          <PreviewRenderer className="preview-panel-renderer" preview={{ ...preview }} />
          <aside className="browser-annotations preview-annotations">
            <div className="browser-annotation-editor">
              <textarea
                className="input browser-note"
                value={note}
                placeholder={t('previewAnnotationPlaceholder')}
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="browser-annotation-actions">
                <button className="btn btn-primary btn-sm" disabled={!note.trim()} onClick={() => void saveNote()}>
                  {t('browserCapture')}
                </button>
              </div>
            </div>
            <div className="browser-annotation-list">
              {previewAnnotations.length === 0 ? (
                <div className="workspace-diff-empty">{t('previewNoAnnotations')}</div>
              ) : (
                previewAnnotations.map((item) => (
                  <div key={item.id} className="browser-annotation-item" title={item.path}>
                    <div className="browser-annotation-note">{annotationLabel(item.note)}</div>
                    <div className="browser-annotation-url">{item.path}</div>
                    <button
                      className="btn btn-ghost btn-sm browser-annotation-send"
                      onClick={() => void sendMessage(previewPrompt(previewPath, preview, [item]))}
                    >
                      {t('sendToAgent')}
                    </button>
                  </div>
                ))
              )}
            </div>
          </aside>
        </div>
      ) : (
        <div className="workspace-diff-empty">{t('previewEmpty')}</div>
      )}
    </div>
  )
}
