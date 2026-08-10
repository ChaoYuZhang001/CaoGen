import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, FileCode2, RefreshCw, RotateCcw, Save, Search, X } from 'lucide-react'
import { useT } from '../../i18n'
import type {
  CodexNativeConfigBackupView,
  CodexNativeConfigPreview
} from '../../../../shared/types'

type BusyState = 'open' | 'save' | 'rollback' | ''

export default function CodexNativeConfigWorkspace(): React.JSX.Element {
  const t = useT()
  const [preview, setPreview] = useState<CodexNativeConfigPreview | null>(null)
  const [text, setText] = useState('')
  const [backups, setBackups] = useState<CodexNativeConfigBackupView[]>([])
  const [busy, setBusy] = useState<BusyState>('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [selectedMatch, setSelectedMatch] = useState(0)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLPreElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const dirty = useMemo(() => Boolean(preview && text !== preview.text), [preview, text])
  const lineCount = useMemo(() => text.split('\n').length, [text])
  const lineNumbers = useMemo(() => Array.from({ length: lineCount }, (_, index) => index + 1).join('\n'), [lineCount])
  const matchCount = useMemo(() => countMatches(text, search), [search, text])

  useEffect(() => { void refreshBackups() }, [])
  useEffect(() => setSelectedMatch(0), [search, text])

  async function refreshBackups(): Promise<void> {
    setBackups(await window.agentDesk.listCodexNativeConfigBackups().catch(() => []))
  }

  async function open(): Promise<void> {
    if (dirty && !window.confirm(t('codexNativeConfigDiscardConfirm'))) return
    setBusy('open'); setError(''); setMessage('')
    try {
      const next = await window.agentDesk.previewCodexNativeConfig()
      setPreview(next)
      setText(next.text)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy('')
    }
  }

  async function save(): Promise<void> {
    if (!preview || !dirty) return
    setBusy('save'); setError(''); setMessage('')
    try {
      const result = await window.agentDesk.applyCodexNativeConfig(preview.previewId, text)
      setPreview(result.preview)
      setText(result.preview.text)
      setMessage(t('codexNativeConfigSaved'))
      await refreshBackups()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy('')
    }
  }

  async function rollback(backup: CodexNativeConfigBackupView): Promise<void> {
    if (!window.confirm(t('codexNativeConfigRollbackConfirm', { time: formattedTime(backup.createdAt) }))) return
    setBusy('rollback'); setError(''); setMessage('')
    try {
      await window.agentDesk.rollbackCodexNativeConfigBackup(backup.id)
      const next = await window.agentDesk.previewCodexNativeConfig()
      setPreview(next)
      setText(next.text)
      setMessage(t('codexNativeConfigRolledBack'))
      await refreshBackups()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy('')
    }
  }

  function close(): void {
    if (dirty && !window.confirm(t('codexNativeConfigDiscardConfirm'))) return
    setPreview(null)
    setText('')
    setError('')
    setMessage('')
  }

  function selectSearchMatch(direction: 1 | -1): void {
    const editor = editorRef.current
    const needle = search.trim().toLocaleLowerCase()
    if (!editor || !needle || matchCount === 0) return
    const haystack = text.toLocaleLowerCase()
    const start = direction > 0 ? editor.selectionEnd : Math.max(0, editor.selectionStart - 1)
    let index = direction > 0 ? haystack.indexOf(needle, start) : haystack.lastIndexOf(needle, start)
    if (index < 0) index = direction > 0 ? haystack.indexOf(needle) : haystack.lastIndexOf(needle)
    if (index < 0) return
    editor.focus()
    editor.setSelectionRange(index, index + needle.length)
    setSelectedMatch(matchOrdinal(haystack, needle, index))
  }

  return (
    <section className={`codex-native-config-workspace${preview ? ' open' : ''}`} data-codex-native-config-workspace>
      <div className="codex-native-config-head">
        <div>
          <h4>{t('codexNativeConfigTitle')}</h4>
          <span>{t('codexNativeConfigFile')} · auth.json: {t('codexNativeConfigAuthManaged')}</span>
        </div>
        {!preview ? (
          <button className="btn btn-ghost btn-sm" data-codex-native-config-open disabled={Boolean(busy)} onClick={() => void open()}>
            <FileCode2 size={14} aria-hidden="true" /> {busy === 'open' ? t('codexNativeConfigOpening') : t('codexNativeConfigOpen')}
          </button>
        ) : (
          <button className="btn btn-ghost btn-icon-sm" title={t('close')} aria-label={t('close')} onClick={close}>
            <X size={15} aria-hidden="true" />
          </button>
        )}
      </div>

      {message && <div className="notice notice-info codex-native-config-notice">{message}</div>}
      {error && <div className="notice notice-error codex-native-config-notice">{error}</div>}

      {preview && (
        <>
          <div className="codex-native-config-meta">
            <ConfigMetric label={t('codexNativeConfigSource')} value={preview.source === 'CODEX_HOME' ? 'CODEX_HOME' : t('providerNativeCodexUserProfile')} />
            <ConfigMetric label={t('codexNativeConfigProviders')} value={preview.summary.modelProviders} />
            <ConfigMetric label="MCP" value={preview.summary.mcpServers} />
            <ConfigMetric label={t('codexNativeConfigProjects')} value={preview.summary.projects} />
            <ConfigMetric label={t('codexNativeConfigFeatures')} value={preview.summary.features} />
            <ConfigMetric label={t('codexNativeConfigPlugins')} value={preview.summary.plugins} />
          </div>

          {preview.protectedValueCount > 0 && (
            <div className="provider-profile-warning codex-native-config-protected">
              {t('codexNativeConfigProtected', { n: preview.protectedValueCount })}
              {preview.formattingNormalized ? ` ${t('codexNativeConfigNormalized')}` : ''}
            </div>
          )}

          <div className="codex-native-config-editor">
            <div className="codex-native-config-editor-head">
              <strong>config.toml</strong>
              <div className="codex-native-config-search" role="search" aria-label={t('codexNativeConfigFind')}>
                <Search size={13} aria-hidden="true" />
                <input
                  ref={searchRef}
                  value={search}
                  aria-label={t('codexNativeConfigFind')}
                  placeholder={t('codexNativeConfigFindPlaceholder')}
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') { event.preventDefault(); selectSearchMatch(event.shiftKey ? -1 : 1) }
                    if (event.key === 'Escape') { setSearch(''); editorRef.current?.focus() }
                  }}
                />
                <span aria-live="polite">{search ? (matchCount ? t('codexNativeConfigMatchCount', { current: selectedMatch || 1, total: matchCount }) : t('codexNativeConfigNoMatches')) : ''}</span>
                <button type="button" title={t('codexNativeConfigPreviousMatch')} aria-label={t('codexNativeConfigPreviousMatch')} disabled={!matchCount} onClick={() => selectSearchMatch(-1)}><ChevronUp size={13} aria-hidden="true" /></button>
                <button type="button" title={t('codexNativeConfigNextMatch')} aria-label={t('codexNativeConfigNextMatch')} disabled={!matchCount} onClick={() => selectSearchMatch(1)}><ChevronDown size={13} aria-hidden="true" /></button>
              </div>
            </div>
            <div className="codex-native-config-code">
              <pre ref={gutterRef} className="codex-native-config-gutter" aria-hidden="true">{lineNumbers}</pre>
              <textarea
                ref={editorRef}
                className="input input-block textarea"
                data-codex-native-config-editor
                value={text}
                onChange={(event) => setText(event.target.value)}
                onScroll={(event) => { if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop }}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'f') {
                    event.preventDefault()
                    searchRef.current?.focus()
                    searchRef.current?.select()
                  }
                }}
                rows={20}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </div>
          </div>

          <div className="codex-native-config-actions">
            <span>{dirty ? t('codexNativeConfigUnsaved') : t('codexNativeConfigCurrent')} · {t('codexNativeConfigLineStatus', { lines: lineCount })}</span>
            <div>
              <button className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void open()}>
                <RefreshCw size={14} aria-hidden="true" /> {t('codexNativeConfigReload')}
              </button>
              <button className="btn btn-primary btn-sm" data-codex-native-config-save disabled={Boolean(busy) || !dirty} onClick={() => void save()}>
                <Save size={14} aria-hidden="true" /> {busy === 'save' ? t('codexNativeConfigSaving') : t('save')}
              </button>
            </div>
          </div>
        </>
      )}

      {backups.length > 0 && (
        <div className="codex-native-config-backups">
          <strong>{t('codexNativeConfigBackups')}</strong>
          {backups.slice(0, 3).map((backup) => (
            <div className="codex-native-config-backup" key={backup.id}>
              <span>{formattedTime(backup.createdAt)}</span>
              <button className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void rollback(backup)}>
                <RotateCcw size={14} aria-hidden="true" /> {t('providerProfileRollback')}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function ConfigMetric({ label, value }: { label: string; value: string | number }): React.JSX.Element {
  return <div><span>{label}</span><strong>{value}</strong></div>
}

function formattedTime(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function countMatches(haystack: string, needleValue: string): number {
  const needle = needleValue.trim().toLocaleLowerCase()
  if (!needle) return 0
  const text = haystack.toLocaleLowerCase()
  let count = 0
  let index = 0
  while ((index = text.indexOf(needle, index)) >= 0) {
    count += 1
    index += Math.max(needle.length, 1)
  }
  return count
}

function matchOrdinal(haystack: string, needle: string, matchIndex: number): number {
  let ordinal = 0
  let index = 0
  while ((index = haystack.indexOf(needle, index)) >= 0 && index <= matchIndex) {
    ordinal += 1
    index += Math.max(needle.length, 1)
  }
  return ordinal
}
