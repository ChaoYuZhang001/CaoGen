import { useEffect } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import PreviewRenderer from './PreviewRenderer'
import { truncate } from './previewUtils'

function previewPrompt(previewPath: string | undefined, preview: unknown): string {
  const p = preview as {
    path?: string
    type?: string
    mode?: string
    mime?: string
    bytes?: number
    content?: string
  }
  const content = typeof p.content === 'string' ? truncate(p.content, 20_000) : ''
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
    '',
    '请指出需要修改的文件、具体问题和下一步操作。'
  ]
    .filter(Boolean)
    .join('\n')
}

export default function PreviewPanel(): React.JSX.Element {
  const t = useT()
  const activeId = useStore((s) => s.activeId)
  const { preview, previewError, previewLoading, previewPath } = useStore((s) => s.workbench)
  const refresh = useStore((s) => s.refreshPreviewPanel)
  const close = useStore((s) => s.closePreviewPanel)
  const sendMessage = useStore((s) => s.sendMessage)

  useEffect(() => {
    if (activeId && previewPath) void refresh()
  }, [activeId, previewPath, refresh])

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
              if (preview) void sendMessage(previewPrompt(previewPath, preview))
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
        <PreviewRenderer className="preview-panel-renderer" preview={{ ...preview }} />
      ) : (
        <div className="workspace-diff-empty">{t('previewEmpty')}</div>
      )}
    </div>
  )
}
