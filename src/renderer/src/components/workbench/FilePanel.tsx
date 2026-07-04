import { useEffect, useMemo, useState } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import type { ProjectFileEntry } from '../../../../shared/types'

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function isLikelyTextFile(path: string): boolean {
  return /\.(cjs|css|csv|html?|js|json|jsx|md|mjs|scss|svg|toml|ts|tsx|txt|xml|ya?ml)$/i.test(path)
}

function FileRow({
  entry,
  active,
  onOpen,
  onPreview
}: {
  entry: ProjectFileEntry
  active: boolean
  onOpen: (path: string) => void
  onPreview: (path: string) => void
}): React.JSX.Element {
  const disabled = entry.kind !== 'file'
  return (
    <div className={`file-row-wrap ${active ? 'active' : ''}`}>
      <button
        className={`file-row ${active ? 'active' : ''} file-row-${entry.kind}`}
        disabled={disabled}
        title={entry.path}
        onClick={() => onOpen(entry.path)}
      >
        <span className="file-row-mark">{entry.kind === 'directory' ? '▸' : isLikelyTextFile(entry.path) ? 'T' : 'F'}</span>
        <span className="file-row-path">{entry.path}</span>
        {entry.kind === 'file' && <span className="file-row-size">{formatBytes(entry.size)}</span>}
      </button>
      {entry.kind === 'file' && (
        <button className="file-row-preview" title="Preview" onClick={() => onPreview(entry.path)}>
          ◉
        </button>
      )}
    </div>
  )
}

export default function FilePanel(): React.JSX.Element {
  const t = useT()
  const activeId = useStore((s) => s.activeId)
  const {
    fileEntries,
    fileError,
    fileLoading,
    fileMessage,
    fileSaving,
    filesError,
    filesLoading,
    filesRoot,
    filesTruncated,
    currentFileBytes,
    currentFileContent,
    currentFileMtimeMs,
    currentFilePath,
    savedFileContent
  } = useStore((s) => s.workbench)
  const refresh = useStore((s) => s.refreshFilesPanel)
  const close = useStore((s) => s.closeFilesPanel)
  const openFile = useStore((s) => s.openFile)
  const openPreview = useStore((s) => s.openPreviewPanel)
  const updateDraft = useStore((s) => s.updateFileDraft)
  const saveOpenFile = useStore((s) => s.saveOpenFile)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (activeId) void refresh()
  }, [activeId, refresh])

  const dirty = currentFileContent !== savedFileContent
  const visibleEntries = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return fileEntries
    return fileEntries.filter((entry) => entry.path.toLowerCase().includes(q))
  }, [fileEntries, query])

  return (
    <div className="file-panel">
      <header className="workspace-diff-top">
        <div>
          <div className="workspace-diff-title">{t('filePanelTitle')}</div>
          <div className="workspace-diff-sub">
            {filesRoot ?? ''}
            {filesTruncated ? ` · ${t('filesTruncated')}` : ''}
          </div>
        </div>
        <div className="workspace-diff-actions">
          <button className="btn btn-ghost btn-sm" disabled={filesLoading} onClick={() => void refresh()}>
            {filesLoading ? t('loadingDiff') : t('refresh')}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={close}>
            {t('close')}
          </button>
        </div>
      </header>

      {(filesError || fileError) && (
        <div className="notice notice-error workspace-diff-notice">{filesError || fileError}</div>
      )}
      {fileMessage && <div className="notice notice-info workspace-diff-notice">{fileMessage}</div>}

      <div className="file-panel-body">
        <aside className="file-list">
          <input
            className="input file-search"
            value={query}
            placeholder={t('fileSearchPlaceholder')}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="file-list-scroll">
            {filesLoading && fileEntries.length === 0 ? (
              <div className="workspace-diff-empty">{t('loadingDiff')}</div>
            ) : visibleEntries.length === 0 ? (
              <div className="workspace-diff-empty">{t('filesEmpty')}</div>
            ) : (
              visibleEntries.map((entry) => (
                <FileRow
                  key={entry.path}
                  entry={entry}
                  active={entry.path === currentFilePath}
                  onOpen={(path) => void openFile(path)}
                  onPreview={(path) => void openPreview(path)}
                />
              ))
            )}
          </div>
        </aside>

        <section className="file-editor">
          <div className="file-editor-head">
            <div className="file-editor-title" title={currentFilePath}>
              {currentFilePath ?? t('fileNoSelection')}
              {dirty ? ' *' : ''}
            </div>
            <div className="file-editor-meta">
              {currentFilePath
                ? `${formatBytes(currentFileBytes)}${currentFileMtimeMs ? ` · ${new Date(currentFileMtimeMs).toLocaleString()}` : ''}`
                : ''}
            </div>
            <button
              className="btn btn-ghost btn-sm"
              disabled={!currentFilePath}
              onClick={() => {
                if (currentFilePath) void openPreview(currentFilePath)
              }}
            >
              {t('preview')}
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={!currentFilePath || !dirty || fileSaving || fileLoading}
              onClick={() => void saveOpenFile()}
            >
              {fileSaving ? t('saving') : t('save')}
            </button>
          </div>
          {fileLoading ? (
            <div className="workspace-diff-empty">{t('fileLoading')}</div>
          ) : currentFilePath ? (
            <textarea
              className="file-editor-textarea"
              value={currentFileContent}
              spellCheck={false}
              onChange={(e) => updateDraft(e.target.value)}
            />
          ) : (
            <div className="workspace-diff-empty">{t('filePickHint')}</div>
          )}
        </section>
      </div>
    </div>
  )
}
