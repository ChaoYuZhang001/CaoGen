import { useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import PreviewRenderer from './PreviewRenderer'
import type { OfficePreviewUnit } from './officePreviewUtils'
import { buildPreviewAgentPrompt, getPreviewAgentPromptSource, previewAnnotationLabel } from './previewPrompt'

export default function PreviewPanel(): React.JSX.Element {
  const t = useT()
  const activeId = useStore((s) => s.activeId)
  const {
    preview,
    previewAnnotations,
    previewError,
    previewLoading,
    previewPath,
    previewVisual,
    previewVisualError,
    previewVisualLoading
  } = useStore((s) => s.workbench)
  const refresh = useStore((s) => s.refreshPreviewPanel)
  const close = useStore((s) => s.closePreviewPanel)
  const sendMessage = useStore((s) => s.sendMessage)
  const saveAnnotation = useStore((s) => s.savePreviewAnnotation)
  const [note, setNote] = useState('')
  const [sendState, setSendState] = useState<'idle' | 'sent' | 'error'>('idle')
  const [sendError, setSendError] = useState('')
  const [sendScope, setSendScope] = useState<'document' | 'unit'>('document')
  const [officeUnit, setOfficeUnit] = useState<OfficePreviewUnit | null>(null)
  const promptSource = getPreviewAgentPromptSource(previewPath, preview, previewError)
  const canSendPreview = Boolean(activeId && promptSource)
  const canSendCurrentUnit = Boolean(canSendPreview && preview?.type === 'office' && officeUnit)

  useEffect(() => {
    if (activeId && previewPath) void refresh()
  }, [activeId, previewPath, refresh])

  useEffect(() => {
    setSendState('idle')
    setSendError('')
  }, [previewPath, preview, previewError])

  useEffect(() => {
    setOfficeUnit(null)
  }, [previewPath])

  const saveNote = async (): Promise<void> => {
    const locator =
      preview?.type === 'office' && officeUnit
        ? {
            page: officeUnit.position,
            quote: officeUnit.quote || undefined,
            selector: `office:${officeUnit.kind}:${officeUnit.position}:${officeUnit.title}`
          }
        : undefined
    await saveAnnotation(note, locator)
    setNote('')
  }

  const sendPreviewToAgent = async (
    annotations = previewAnnotations,
    currentUnit?: OfficePreviewUnit
  ): Promise<void> => {
    if (!promptSource || !activeId) return
    setSendState('idle')
    setSendError('')
    setSendScope(currentUnit ? 'unit' : 'document')
    try {
      await sendMessage(
        buildPreviewAgentPrompt(previewPath, promptSource, annotations, {
          currentUnit
        })
      )
      setSendState('sent')
    } catch (err) {
      setSendState('error')
      setSendError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div
      className="preview-panel"
      data-preview-agent-sendable={canSendPreview ? 1 : 0}
      data-preview-agent-source-type={promptSource?.type ?? ''}
      data-preview-agent-source-mode={promptSource?.mode ?? ''}
      data-preview-annotations={previewAnnotations.length}
      data-preview-current-unit={officeUnit?.position ?? ''}
      data-preview-current-unit-kind={officeUnit?.kind ?? ''}
      data-preview-current-unit-title={officeUnit?.title ?? ''}
      data-preview-current-unit-total={officeUnit?.total ?? ''}
      data-preview-send-scope={sendScope}
      data-preview-send-state={sendState}
    >
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
            disabled={!canSendPreview}
            onClick={() => void sendPreviewToAgent()}
          >
            {t('sendToAgent')}
          </button>
          {preview?.type === 'office' && (
            <button
              className="btn btn-ghost btn-sm"
              data-preview-send-current-unit="1"
              disabled={!canSendCurrentUnit}
              onClick={() => {
                if (!officeUnit) return
                const annotations = previewAnnotations.filter(
                  (item) => !item.locator?.page || item.locator.page === officeUnit.position
                )
                void sendPreviewToAgent(annotations, officeUnit)
              }}
            >
              {t('sendCurrentPreviewUnit')}
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={close}>
            {t('close')}
          </button>
        </div>
      </header>

      {previewError && <div className="notice notice-error workspace-diff-notice">{previewError}</div>}
      {sendState === 'sent' && <div className="notice notice-info workspace-diff-notice">{t('previewSentToAgent')}</div>}
      {sendState === 'error' && (
        <div className="notice notice-error workspace-diff-notice">
          {t('previewSendFailed')}
          {sendError ? `: ${sendError}` : ''}
        </div>
      )}
      {previewLoading && !preview ? (
        <div className="workspace-diff-empty">{t('previewLoading')}</div>
      ) : preview ? (
        <div className="preview-panel-body">
          <PreviewRenderer
            className="preview-panel-renderer"
            officeLabels={{
              fidelity: t('previewVisualFidelity'),
              loading: t('previewVisualLoading'),
              modeLabel: t('previewOfficeModeLabel'),
              nextUnit: t('previewNextUnit'),
              previousUnit: t('previewPreviousUnit'),
              structure: t('previewStructureMode'),
              thumbnailFidelity: t('previewThumbnailFidelity'),
              unitSelector: t('previewUnitSelector'),
              unavailable: t('previewVisualUnavailable'),
              visual: t('previewVisualMode')
            }}
            officeVisual={previewVisual}
            officeVisualError={previewVisualError}
            officeVisualLoading={previewVisualLoading}
            onOfficeUnitChange={setOfficeUnit}
            preview={{ ...preview }}
          />
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
                    <div className="browser-annotation-note">{previewAnnotationLabel(item.note)}</div>
                    <div className="browser-annotation-url">{item.path}</div>
                    <button
                      className="btn btn-ghost btn-sm browser-annotation-send"
                      disabled={!canSendPreview}
                      onClick={() => void sendPreviewToAgent([item])}
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
