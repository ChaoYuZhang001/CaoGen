import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../store'

function annotationLabel(note: string): string {
  const clean = note.replace(/\s+/g, ' ').trim()
  return clean.length > 86 ? `${clean.slice(0, 85)}...` : clean
}

function annotationPrompt(item: {
  url: string
  title?: string
  note: string
  selector?: string
  boundingBox?: { x: number; y: number; width: number; height: number }
  consoleErrors?: string[]
}): string {
  return [
    '请基于这个 CaoGen 网页批注定位并修复问题。',
    '',
    `URL: ${item.url}`,
    item.title ? `标题: ${item.title}` : '',
    item.selector ? `选择器线索: ${item.selector}` : '',
    item.boundingBox
      ? `区域: x=${Math.round(item.boundingBox.x)}, y=${Math.round(item.boundingBox.y)}, w=${Math.round(item.boundingBox.width)}, h=${Math.round(item.boundingBox.height)}`
      : '',
    '',
    `用户批注: ${item.note}`,
    item.consoleErrors?.length ? `\n控制台错误:\n${item.consoleErrors.slice(-20).join('\n')}` : '',
    '',
    '请给出相关文件、修复方案，并在修改后说明如何复验。'
  ]
    .filter(Boolean)
    .join('\n')
}

export default function BrowserPanel(): React.JSX.Element {
  const t = useT()
  const activeId = useStore((s) => s.activeId)
  const {
    browserAnnotations,
    browserError,
    browserLoading,
    browserMessage,
    browserState,
    browserUrlDraft
  } = useStore((s) => s.workbench)
  const openBrowser = useStore((s) => s.openBrowserPanel)
  const closeBrowser = useStore((s) => s.closeBrowserPanel)
  const navigate = useStore((s) => s.navigateBrowser)
  const goBack = useStore((s) => s.browserGoBack)
  const goForward = useStore((s) => s.browserGoForward)
  const reload = useStore((s) => s.reloadBrowser)
  const setBounds = useStore((s) => s.setBrowserBounds)
  const capture = useStore((s) => s.captureBrowserAnnotation)
  const sendMessage = useStore((s) => s.sendMessage)
  const [urlDraft, setUrlDraft] = useState(browserUrlDraft || 'https://example.com')
  const [note, setNote] = useState('')
  const viewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (browserUrlDraft) setUrlDraft(browserUrlDraft)
  }, [browserUrlDraft])

  useEffect(() => {
    if (activeId && !browserState) void openBrowser()
  }, [activeId, browserState, openBrowser])

  useEffect(() => {
    const el = viewportRef.current
    if (!el || !activeId) return

    const update = (): void => {
      const rect = el.getBoundingClientRect()
      void setBounds({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [activeId, setBounds])

  const submitUrl = (): void => {
    void navigate(urlDraft)
  }

  const captureSelection = async (): Promise<void> => {
    await capture(note.trim())
    setNote('')
  }

  return (
    <div className="browser-panel">
      <header className="workspace-diff-top">
        <div>
          <div className="workspace-diff-title">{t('browserPanelTitle')}</div>
          <div className="workspace-diff-sub">{browserState?.title || browserState?.url || ''}</div>
        </div>
        <div className="workspace-diff-actions">
          <button className="btn btn-ghost btn-sm" disabled={!browserState?.canGoBack} onClick={() => void goBack()}>
            ←
          </button>
          <button className="btn btn-ghost btn-sm" disabled={!browserState?.canGoForward} onClick={() => void goForward()}>
            →
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => void reload()}>
            {t('refresh')}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => void closeBrowser()}>
            {t('close')}
          </button>
        </div>
      </header>

      <div className="browser-toolbar">
        <input
          className="input browser-url"
          value={urlDraft}
          placeholder={t('browserUrlPlaceholder')}
          onChange={(e) => setUrlDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submitUrl()
            }
          }}
        />
        <button className="btn btn-primary btn-sm" disabled={!urlDraft.trim()} onClick={submitUrl}>
          {browserLoading ? t('loadingDiff') : t('browserGo')}
        </button>
      </div>

      {(browserError || browserMessage) && (
        <div className={`notice ${browserError ? 'notice-error' : 'notice-info'} workspace-diff-notice`}>
          {browserError || browserMessage}
        </div>
      )}

      <div className="browser-body">
        <div className="browser-viewport" ref={viewportRef}>
          {!browserState && <div className="browser-placeholder">{t('browserStarting')}</div>}
        </div>
        <aside className="browser-annotations">
          <div className="browser-annotation-editor">
            <textarea
              className="input browser-note"
              value={note}
              placeholder={t('browserNotePlaceholder')}
              onChange={(e) => setNote(e.target.value)}
            />
            <button className="btn btn-primary btn-sm" onClick={() => void captureSelection()}>
              {t('browserCapture')}
            </button>
          </div>
          <div className="browser-annotation-list">
            {browserAnnotations.length === 0 ? (
              <div className="workspace-diff-empty">{t('browserNoAnnotations')}</div>
            ) : (
              browserAnnotations.map((item) => (
                <div key={item.id} className="browser-annotation-item" title={item.url}>
                  <div className="browser-annotation-note">{annotationLabel(item.note)}</div>
                  <div className="browser-annotation-url">{item.title || item.url}</div>
                  <button
                    className="btn btn-ghost btn-sm browser-annotation-send"
                    onClick={() => void sendMessage(annotationPrompt(item))}
                  >
                    {t('sendToAgent')}
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
