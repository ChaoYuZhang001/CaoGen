import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Braces, ChevronDown, ChevronRight, CircleAlert, Eye, File, FileText, Folder, FolderOpen, FolderTree, Info, Search, X } from 'lucide-react'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import type { ProjectDiagnostic, ProjectSymbolLocation, ProjectTextSearchMatch } from '../../../../shared/types'
import {
  buildProjectFileTree,
  filterProjectFileTree,
  visibleProjectFileNodes,
  type VisibleProjectFileNode
} from './project-file-tree'
import { editorLocationForOffset, editorOffsetForLocation, editorWordRange, replaceEditorWord } from './editor-language-actions'

interface LanguageSymbolResult extends ProjectSymbolLocation {
  insertText?: string
}

function supportsTypeScriptLanguageServer(path: string | null | undefined): boolean {
  return Boolean(path && /\.(?:cjs|js|jsx|mjs|ts|tsx)$/i.test(path))
}

function hoverDisplayText(markdown: string): string {
  return markdown
    .replace(/(?:^|\r?\n)```[^\r\n]*(?=\r?\n|$)/g, '')
    .trim()
}

function mergedDiagnostics(syntax: ProjectDiagnostic[], semantic: ProjectDiagnostic[]): ProjectDiagnostic[] {
  const seen = new Set<string>()
  return [...semantic, ...syntax].filter((diagnostic) => {
    const key = [
      diagnostic.path,
      diagnostic.line,
      diagnostic.column,
      diagnostic.endLine,
      diagnostic.endColumn,
      diagnostic.severity,
      diagnostic.message.trim().toLocaleLowerCase()
    ].join(':')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function isLikelyTextFile(path: string): boolean {
  return /\.(cjs|css|csv|html?|js|json|jsx|md|mjs|scss|svg|toml|ts|tsx|txt|xml|ya?ml)$/i.test(path)
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function FileTreeRow({
  item,
  expanded,
  active,
  onToggle,
  onOpen,
  onPreview
}: {
  item: VisibleProjectFileNode
  expanded: boolean
  active: boolean
  onToggle: (path: string) => void
  onOpen: (path: string) => void
  onPreview: (path: string) => void
}): React.JSX.Element {
  const { node, depth } = item
  const directory = node.kind === 'directory'
  const textFile = !directory && isLikelyTextFile(node.path)
  const style = { '--file-tree-depth': depth } as CSSProperties
  return (
    <div className={`file-row-wrap ${active ? 'active' : ''}`}>
      <button
        className={`file-row file-tree-row ${active ? 'active' : ''} file-row-${node.kind}`}
        style={style}
        title={node.path}
        aria-expanded={directory ? expanded : undefined}
        onClick={() => directory ? onToggle(node.path) : onOpen(node.path)}
      >
        <span className="file-row-chevron" aria-hidden="true">
          {directory ? (expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : null}
        </span>
        <span className="file-row-mark" aria-hidden="true">
          {directory ? (expanded ? <FolderOpen size={14} /> : <Folder size={14} />) : textFile ? <FileText size={14} /> : <File size={14} />}
        </span>
        <span className="file-row-path">{node.name}</span>
        {!directory && <span className="file-row-size">{formatBytes(node.size)}</span>}
      </button>
      {!directory && (
        <button className="file-row-preview" title="Preview" onClick={() => onPreview(node.path)}>
          <Eye size={13} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

function SearchResultRow({ match, active, onOpen }: {
  match: ProjectTextSearchMatch
  active: boolean
  onOpen: (path: string) => void
}): React.JSX.Element {
  const before = match.snippet.slice(0, match.matchStart)
  const hit = match.snippet.slice(match.matchStart, match.matchStart + match.matchLength)
  const after = match.snippet.slice(match.matchStart + match.matchLength)
  return (
    <button
      type="button"
      className={`file-search-result ${active ? 'active' : ''}`}
      title={`${match.path}:${match.line}:${match.column}`}
      onClick={() => onOpen(match.path)}
    >
      <span className="file-search-result-path">{match.path}</span>
      <span className="file-search-result-position">{match.line}:{match.column}</span>
      <span className="file-search-result-snippet">{before}<mark>{hit}</mark>{after}</span>
    </button>
  )
}

function DiagnosticRow({ diagnostic, active, onOpen }: {
  diagnostic: ProjectDiagnostic
  active: boolean
  onOpen: (diagnostic: ProjectDiagnostic) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`file-diagnostic-row ${active ? 'active' : ''}`}
      data-diagnostic-path={diagnostic.path}
      data-diagnostic-source={diagnostic.source}
      data-diagnostic-code={diagnostic.code}
      title={`${diagnostic.path}:${diagnostic.line}:${diagnostic.column}\n${diagnostic.message}`}
      onClick={() => onOpen(diagnostic)}
    >
      <CircleAlert size={14} aria-hidden="true" />
      <span className="file-diagnostic-message">{diagnostic.message}</span>
      <span className="file-diagnostic-path">{diagnostic.path}</span>
      <span className="file-diagnostic-position">{diagnostic.line}:{diagnostic.column}</span>
    </button>
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
    fileSearchLoading,
    fileSearchQuery,
    fileSearchMatches,
    fileSearchFilesScanned,
    fileSearchFilesMatched,
    fileSearchTruncated,
    fileSearchError,
    fileDiagnosticsLoading,
    fileDiagnostics,
    fileDiagnosticsAnalyzedFiles,
    fileDiagnosticsSupportedFiles,
    fileDiagnosticsTruncated,
    fileDiagnosticsError,
    currentFileBytes,
    currentFileContent,
    currentFileMtimeMs,
    currentFilePath,
    savedFileContent,
    fileTabs
  } = useStore((s) => s.workbench)
  const refresh = useStore((s) => s.refreshFilesPanel)
  const searchProjectFiles = useStore((s) => s.searchProjectFiles)
  const clearProjectFileSearch = useStore((s) => s.clearProjectFileSearch)
  const refreshProjectDiagnostics = useStore((s) => s.refreshProjectDiagnostics)
  const close = useStore((s) => s.closeFilesPanel)
  const openFile = useStore((s) => s.openFile)
  const openPreview = useStore((s) => s.openPreviewPanel)
  const updateDraft = useStore((s) => s.updateFileDraft)
  const saveOpenFile = useStore((s) => s.saveOpenFile)
  const activateFileTab = useStore((s) => s.activateFileTab)
  const closeFileTab = useStore((s) => s.closeFileTab)
  const cycleFileTab = useStore((s) => s.cycleFileTab)
  const activePanelId = useStore((s) => s.workbench.activePanelId)
  const [mode, setMode] = useState<'tree' | 'search' | 'problems'>('tree')
  const [nameQuery, setNameQuery] = useState('')
  const [searchDraft, setSearchDraft] = useState('')
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set())
  const [pendingLocation, setPendingLocation] = useState<{ path: string; line: number; column: number } | null>(null)
  const [pendingCaret, setPendingCaret] = useState<number | null>(null)
  const [symbolMode, setSymbolMode] = useState<'completion' | 'definition' | null>(null)
  const [symbolResults, setSymbolResults] = useState<LanguageSymbolResult[]>([])
  const [symbolLoading, setSymbolLoading] = useState(false)
  const [symbolError, setSymbolError] = useState('')
  const [symbolSource, setSymbolSource] = useState<'typescript-lsp' | 'project-index'>('project-index')
  const [hoverOpen, setHoverOpen] = useState(false)
  const [hoverLoading, setHoverLoading] = useState(false)
  const [hoverMarkdown, setHoverMarkdown] = useState('')
  const [hoverError, setHoverError] = useState('')
  const [semanticDiagnostics, setSemanticDiagnostics] = useState<ProjectDiagnostic[]>([])
  const [semanticDiagnosticsLoading, setSemanticDiagnosticsLoading] = useState(false)
  const [semanticDiagnosticsError, setSemanticDiagnosticsError] = useState('')
  const symbolRequestRef = useRef(0)
  const hoverRequestRef = useRef(0)
  const diagnosticsRequestRef = useRef(0)
  const editorRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setMode('tree')
    setNameQuery('')
    setSearchDraft('')
    setExpandedPaths(new Set())
    setHoverOpen(false)
    setSemanticDiagnostics([])
    setSemanticDiagnosticsError('')
    clearProjectFileSearch()
    if (activeId) void refresh()
  }, [activeId, clearProjectFileSearch, refresh])

  const dirty = currentFileContent !== savedFileContent
  const problemDiagnostics = useMemo(
    () => mergedDiagnostics(fileDiagnostics, semanticDiagnostics),
    [fileDiagnostics, semanticDiagnostics]
  )
  const sessionTabs = useMemo(
    () => fileTabs.filter((tab) => tab.sessionId === activeId),
    [activeId, fileTabs]
  )
  const requestCloseTab = useCallback((path: string): void => {
    const tab = sessionTabs.find((candidate) => candidate.path === path)
    if (!tab) return
    if (tab.content !== tab.savedContent && !window.confirm(t('closeDirtyFileConfirm', { name: fileName(path) }))) {
      return
    }
    closeFileTab(path)
  }, [closeFileTab, sessionTabs, t])

  useEffect(() => {
    if (activePanelId !== 'files') return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return
      if (event.key === 'Tab') {
        event.preventDefault()
        cycleFileTab(event.shiftKey ? -1 : 1)
      } else if (event.key.toLowerCase() === 's' && currentFilePath && dirty) {
        event.preventDefault()
        void saveOpenFile()
      } else if (event.key.toLowerCase() === 'w' && currentFilePath) {
        event.preventDefault()
        requestCloseTab(currentFilePath)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activePanelId, currentFilePath, cycleFileTab, dirty, requestCloseTab, saveOpenFile])
  const projectTree = useMemo(() => buildProjectFileTree(fileEntries), [fileEntries])
  const filteredTree = useMemo(() => filterProjectFileTree(projectTree, nameQuery), [nameQuery, projectTree])
  const visibleEntries = useMemo(
    () => visibleProjectFileNodes(filteredTree, expandedPaths, Boolean(nameQuery.trim())),
    [expandedPaths, filteredTree, nameQuery]
  )
  const toggleDirectory = useCallback((path: string): void => {
    setExpandedPaths((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])
  const submitSearch = useCallback((): void => {
    if (!searchDraft.trim()) {
      clearProjectFileSearch()
      return
    }
    void searchProjectFiles(searchDraft)
  }, [clearProjectFileSearch, searchDraft, searchProjectFiles])
  const selectMode = useCallback((next: 'tree' | 'search' | 'problems'): void => {
    setMode(next)
    if (next === 'problems') void refreshProjectDiagnostics()
  }, [refreshProjectDiagnostics])
  const openDiagnostic = useCallback((diagnostic: ProjectDiagnostic): void => {
    setPendingLocation(diagnostic)
    void openFile(diagnostic.path)
  }, [openFile])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !pendingLocation || currentFilePath !== pendingLocation.path || fileLoading) return
    const position = editorOffsetForLocation(currentFileContent, pendingLocation.line, pendingLocation.column)
    editor.focus()
    editor.setSelectionRange(position, position)
    const lineHeight = Number.parseFloat(getComputedStyle(editor).lineHeight) || 18
    editor.scrollTop = Math.max(0, (pendingLocation.line - 2) * lineHeight)
    setPendingLocation(null)
  }, [currentFileContent, currentFilePath, fileLoading, pendingLocation])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || pendingCaret === null) return
    editor.focus()
    editor.setSelectionRange(pendingCaret, pendingCaret)
    setPendingCaret(null)
  }, [currentFileContent, pendingCaret])

  const languageInput = useCallback(() => {
    const editor = editorRef.current
    if (!editor || !currentFilePath) return null
    const location = editorLocationForOffset(currentFileContent, editor.selectionStart)
    return { path: currentFilePath, content: currentFileContent, ...location }
  }, [currentFileContent, currentFilePath])

  const requestHover = useCallback(async (): Promise<void> => {
    if (!activeId || !supportsTypeScriptLanguageServer(currentFilePath)) return
    const input = languageInput()
    if (!input) return
    const requestId = ++hoverRequestRef.current
    setSymbolMode(null)
    setHoverOpen(true)
    setHoverLoading(true)
    setHoverMarkdown('')
    setHoverError('')
    try {
      const result = await window.agentDesk.getTypeScriptHover(activeId, input)
      if (requestId !== hoverRequestRef.current) return
      if (!result.ok) setHoverError(result.error ?? t('fileSemanticFailed'))
      else setHoverMarkdown(result.markdown)
    } catch (error) {
      if (requestId === hoverRequestRef.current) setHoverError(error instanceof Error ? error.message : String(error))
    } finally {
      if (requestId === hoverRequestRef.current) setHoverLoading(false)
    }
  }, [activeId, currentFilePath, languageInput, t])

  useEffect(() => {
    hoverRequestRef.current += 1
    setHoverOpen(false)
    setHoverMarkdown('')
    setHoverError('')
  }, [currentFilePath])

  useEffect(() => {
    if (mode !== 'problems' || !activeId || !currentFilePath || !supportsTypeScriptLanguageServer(currentFilePath)) {
      diagnosticsRequestRef.current += 1
      setSemanticDiagnostics([])
      setSemanticDiagnosticsError('')
      setSemanticDiagnosticsLoading(false)
      return
    }
    const requestId = ++diagnosticsRequestRef.current
    setSemanticDiagnosticsLoading(true)
    setSemanticDiagnosticsError('')
    const timer = window.setTimeout(() => {
      const input = { path: currentFilePath, content: currentFileContent, line: 1, column: 1 }
      void window.agentDesk.getTypeScriptDiagnostics(activeId, input)
        .then((result) => {
          if (requestId !== diagnosticsRequestRef.current) return
          if (!result.ok) {
            setSemanticDiagnostics([])
            setSemanticDiagnosticsError(result.error ?? t('fileSemanticFailed'))
          } else {
            setSemanticDiagnostics(result.diagnostics)
          }
        })
        .catch((error) => {
          if (requestId === diagnosticsRequestRef.current) setSemanticDiagnosticsError(error instanceof Error ? error.message : String(error))
        })
        .finally(() => {
          if (requestId === diagnosticsRequestRef.current) setSemanticDiagnosticsLoading(false)
        })
    }, 250)
    return () => window.clearTimeout(timer)
  }, [activeId, currentFileContent, currentFilePath, mode, t])

  const requestSymbols = useCallback(async (modeValue: 'completion' | 'definition'): Promise<void> => {
    const editor = editorRef.current
    if (!editor || !activeId || !currentFilePath) return
    const range = editorWordRange(currentFileContent, editor.selectionStart)
    const requestId = ++symbolRequestRef.current
    setHoverOpen(false)
    setSymbolLoading(true)
    setSymbolError('')
    setSymbolMode(modeValue)
    try {
      const input = languageInput()
      if (input && supportsTypeScriptLanguageServer(currentFilePath)) {
        if (modeValue === 'definition') {
          const semantic = await window.agentDesk.getTypeScriptDefinitions(activeId, input)
          if (requestId !== symbolRequestRef.current) return
          if (semantic.ok && semantic.locations.length > 0) {
            const locations: LanguageSymbolResult[] = semantic.locations.map((location) => ({
              name: fileName(location.path),
              kind: 'definition',
              path: location.path,
              line: location.line,
              column: location.column,
              endLine: location.endLine,
              signature: `${location.path}:${location.line}:${location.column}`,
              exported: false
            }))
            setSymbolSource('typescript-lsp')
            if (locations.length === 1) {
              setSymbolMode(null)
              setPendingLocation(locations[0])
              void openFile(locations[0].path)
            } else {
              setSymbolResults(locations)
            }
            return
          }
        } else {
          const semantic = await window.agentDesk.getTypeScriptCompletions(activeId, input)
          if (requestId !== symbolRequestRef.current) return
          if (semantic.ok && semantic.items.length > 0) {
            setSymbolSource('typescript-lsp')
            setSymbolResults(semantic.items.map((item) => ({
              name: item.label,
              kind: item.kind,
              path: currentFilePath,
              line: input.line,
              column: input.column,
              endLine: input.line,
              signature: item.detail,
              exported: false,
              insertText: item.insertText
            })))
            return
          }
        }
      }
      if (!range) {
        setSymbolResults([])
        return
      }
      const result = modeValue === 'definition'
        ? await window.agentDesk.resolveProjectDefinition(activeId, currentFilePath, range.word)
        : await window.agentDesk.searchProjectSymbols(activeId, range.word, 30)
      if (requestId !== symbolRequestRef.current) return
      setSymbolSource('project-index')
      if (!result.ok) {
        setSymbolResults([])
        setSymbolError(result.error ?? t('fileSymbolsFailed'))
      } else if (modeValue === 'definition' && result.symbols.length === 1) {
        const target = result.symbols[0]
        setSymbolMode(null)
        setPendingLocation(target)
        void openFile(target.path)
      } else {
        setSymbolResults(result.symbols)
      }
    } catch (error) {
      if (requestId === symbolRequestRef.current) setSymbolError(error instanceof Error ? error.message : String(error))
    } finally {
      if (requestId === symbolRequestRef.current) setSymbolLoading(false)
    }
  }, [activeId, currentFileContent, currentFilePath, languageInput, openFile, t])

  const selectSymbol = useCallback((symbol: LanguageSymbolResult): void => {
    if (symbolMode === 'definition') {
      setSymbolMode(null)
      setPendingLocation(symbol)
      void openFile(symbol.path)
      return
    }
    const editor = editorRef.current
    if (!editor) return
    const range = editorWordRange(currentFileContent, editor.selectionStart) ?? {
      start: editor.selectionStart,
      end: editor.selectionEnd,
      word: ''
    }
    const replacement = replaceEditorWord(currentFileContent, range, symbol.insertText ?? symbol.name)
    setSymbolMode(null)
    updateDraft(replacement.content)
    setPendingCaret(replacement.caret)
  }, [currentFileContent, openFile, symbolMode, updateDraft])

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

      {(filesError || fileError || fileSearchError || fileDiagnosticsError || (mode === 'problems' && semanticDiagnosticsError)) && (
        <div className="notice notice-error workspace-diff-notice">{filesError || fileError || fileSearchError || fileDiagnosticsError || semanticDiagnosticsError}</div>
      )}
      {fileMessage && <div className="notice notice-info workspace-diff-notice">{fileMessage}</div>}

      <div className="file-panel-body">
        <aside className="file-list">
          <div className="file-browser-toolbar">
            <div className="file-browser-modes" role="tablist" aria-label={t('fileBrowserMode')}>
              <button type="button" role="tab" title={t('fileTreeMode')} aria-label={t('fileTreeMode')} aria-selected={mode === 'tree'} className={mode === 'tree' ? 'active' : ''} onClick={() => selectMode('tree')}>
                <FolderTree size={14} aria-hidden="true" />
              </button>
              <button type="button" role="tab" title={t('fileContentSearchMode')} aria-label={t('fileContentSearchMode')} aria-selected={mode === 'search'} className={mode === 'search' ? 'active' : ''} onClick={() => selectMode('search')}>
                <Search size={14} aria-hidden="true" />
              </button>
              <button type="button" role="tab" title={t('fileProblemsMode')} aria-label={t('fileProblemsMode')} aria-selected={mode === 'problems'} className={mode === 'problems' ? 'active' : ''} onClick={() => selectMode('problems')}>
                <CircleAlert size={14} aria-hidden="true" />{problemDiagnostics.length > 0 ? <span className="file-problem-count">{problemDiagnostics.length}</span> : null}
              </button>
            </div>
            {mode === 'tree' ? (
              <input
                className="input file-search"
                value={nameQuery}
                placeholder={t('fileSearchPlaceholder')}
                onChange={(event) => setNameQuery(event.target.value)}
              />
            ) : mode === 'search' ? (
              <div className="file-content-search">
                <input
                  className="input"
                  value={searchDraft}
                  placeholder={t('fileContentSearchPlaceholder')}
                  onChange={(event) => setSearchDraft(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') submitSearch() }}
                />
                <button type="button" className="btn btn-ghost btn-icon-sm" title={t('fileContentSearchAction')} aria-label={t('fileContentSearchAction')} disabled={fileSearchLoading || !searchDraft.trim()} onClick={submitSearch}>
                  <Search size={14} aria-hidden="true" />
                </button>
              </div>
            ) : null}
          </div>
          {mode === 'search' && fileSearchQuery && (
            <div className="file-search-summary" aria-live="polite">
              {fileSearchLoading
                ? t('fileContentSearchLoading')
                : t('fileContentSearchSummary', { matches: fileSearchMatches.length, files: fileSearchFilesMatched ?? 0, scanned: fileSearchFilesScanned ?? 0 })}
              {fileSearchTruncated ? ` · ${t('fileContentSearchTruncated')}` : ''}
            </div>
          )}
          {mode === 'problems' && (
            <div className="file-search-summary" aria-live="polite">
              {fileDiagnosticsLoading || semanticDiagnosticsLoading
                ? t('fileProblemsLoading')
                : t('fileProblemsSummary', { problems: problemDiagnostics.length, analyzed: fileDiagnosticsAnalyzedFiles ?? 0, supported: fileDiagnosticsSupportedFiles ?? 0 })}
              {fileDiagnosticsTruncated ? ` · ${t('fileContentSearchTruncated')}` : ''}
              {supportsTypeScriptLanguageServer(currentFilePath) ? <span className="file-semantic-source">{t('fileSemanticSource')}</span> : null}
            </div>
          )}
          <div className="file-list-scroll">
            {mode === 'problems' ? (
              (fileDiagnosticsLoading || semanticDiagnosticsLoading) && problemDiagnostics.length === 0 ? (
                <div className="workspace-diff-empty">{t('fileProblemsLoading')}</div>
              ) : problemDiagnostics.length === 0 ? (
                <div className="workspace-diff-empty">{t('fileProblemsEmpty')}</div>
              ) : (
                problemDiagnostics.map((diagnostic, index) => (
                  <DiagnosticRow key={`${diagnostic.path}:${diagnostic.line}:${diagnostic.column}:${index}`} diagnostic={diagnostic} active={diagnostic.path === currentFilePath} onOpen={openDiagnostic} />
                ))
              )
            ) : mode === 'search' ? (
              fileSearchLoading && fileSearchMatches.length === 0 ? (
                <div className="workspace-diff-empty">{t('fileContentSearchLoading')}</div>
              ) : fileSearchQuery && fileSearchMatches.length === 0 ? (
                <div className="workspace-diff-empty">{t('filesEmpty')}</div>
              ) : (
                fileSearchMatches.map((match, index) => (
                  <SearchResultRow key={`${match.path}:${match.line}:${match.column}:${index}`} match={match} active={match.path === currentFilePath} onOpen={(path) => void openFile(path)} />
                ))
              )
            ) : filesLoading && fileEntries.length === 0 ? (
              <div className="workspace-diff-empty">{t('loadingDiff')}</div>
            ) : visibleEntries.length === 0 ? (
              <div className="workspace-diff-empty">{t('filesEmpty')}</div>
            ) : (
              visibleEntries.map((item) => (
                <FileTreeRow
                  key={item.node.path}
                  item={item}
                  expanded={expandedPaths.has(item.node.path) || Boolean(nameQuery.trim())}
                  active={item.node.path === currentFilePath}
                  onToggle={toggleDirectory}
                  onOpen={(path) => void openFile(path)}
                  onPreview={(path) => void openPreview(path)}
                />
              ))
            )}
          </div>
        </aside>

        <section className="file-editor">
          {sessionTabs.length > 0 && (
            <div className="file-editor-tabs" role="tablist" aria-label={t('fileOpenTabs')}>
              {sessionTabs.map((tab) => {
                const active = tab.path === currentFilePath
                const tabDirty = tab.content !== tab.savedContent
                return (
                  <div
                    key={tab.path}
                    className={`file-editor-tab ${active ? 'active' : ''}`}
                    data-file-tab={tab.path}
                    data-file-tab-active={active || undefined}
                    data-file-tab-dirty={tabDirty || undefined}
                  >
                    <button
                      type="button"
                      className="file-editor-tab-select"
                      role="tab"
                      aria-selected={active}
                      title={tab.path}
                      onClick={() => activateFileTab(tab.path)}
                    >
                      <span className="file-editor-tab-name">{fileName(tab.path)}</span>
                      {tabDirty && <span className="file-editor-tab-dirty" aria-label={t('fileUnsaved')} />}
                    </button>
                    <button
                      type="button"
                      className="file-editor-tab-close"
                      data-file-tab-close={tab.path}
                      aria-label={t('closeFileTab', { name: fileName(tab.path) })}
                      title={t('close')}
                      disabled={fileSaving && active}
                      onClick={() => requestCloseTab(tab.path)}
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
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
              type="button"
              className="btn btn-ghost btn-icon-sm file-editor-hover"
              title={t('fileSemanticHover')}
              aria-label={t('fileSemanticHover')}
              disabled={!supportsTypeScriptLanguageServer(currentFilePath) || hoverLoading}
              onClick={() => void requestHover()}
            >
              <Info size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-icon-sm file-editor-symbols"
              title={t('fileWorkspaceSymbols')}
              aria-label={t('fileWorkspaceSymbols')}
              disabled={!currentFilePath || symbolLoading}
              onClick={() => void requestSymbols('completion')}
            >
              <Braces size={14} aria-hidden="true" />
            </button>
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
          {hoverOpen && (
            <div className="file-hover-popover" data-file-hover-popover aria-busy={hoverLoading || undefined}>
              <div className="file-symbol-menu-head">
                <div className="file-symbol-heading">
                  <strong>{t('fileSemanticHover')}</strong>
                  <span>{t('fileSemanticSource')}</span>
                </div>
                <button type="button" className="btn btn-ghost btn-icon-sm" title={t('close')} aria-label={t('close')} onClick={() => setHoverOpen(false)}><X size={13} aria-hidden="true" /></button>
              </div>
              {hoverLoading ? (
                <div className="file-symbol-empty">{t('fileSemanticLoading')}</div>
              ) : hoverError ? (
                <div className="file-symbol-empty">{hoverError}</div>
              ) : hoverMarkdown ? (
                <pre className="file-hover-content">{hoverDisplayText(hoverMarkdown)}</pre>
              ) : (
                <div className="file-symbol-empty">{t('fileSemanticEmpty')}</div>
              )}
            </div>
          )}
          {symbolMode && (
            <div className="file-symbol-menu" data-file-symbol-menu aria-busy={symbolLoading || undefined}>
              <div className="file-symbol-menu-head">
                <div className="file-symbol-heading">
                  <strong>{symbolMode === 'definition' ? t('fileDefinitions') : t('fileCompletions')}</strong>
                  <span data-file-symbol-source={symbolSource}>{symbolSource === 'typescript-lsp' ? t('fileSemanticSource') : t('fileIndexSource')}</span>
                </div>
                <button type="button" className="btn btn-ghost btn-icon-sm" title={t('close')} aria-label={t('close')} onClick={() => setSymbolMode(null)}><X size={13} aria-hidden="true" /></button>
              </div>
              {symbolLoading ? (
                <div className="workspace-diff-empty">{t('fileSymbolsLoading')}</div>
              ) : symbolError ? (
                <div className="file-symbol-empty">{symbolError}</div>
              ) : symbolResults.length === 0 ? (
                <div className="file-symbol-empty">{t('fileSymbolsEmpty')}</div>
              ) : (
                <div className="file-symbol-results">
                  {symbolResults.map((symbol, index) => (
                    <button type="button" key={`${symbol.path}:${symbol.line}:${symbol.name}:${index}`} className="file-symbol-result" onClick={() => selectSymbol(symbol)}>
                      <span className="file-symbol-kind">{symbol.kind}</span>
                      <strong>{symbol.name}</strong>
                      <span className="file-symbol-signature">{symbol.signature}</span>
                      <span className="file-symbol-location">{symbol.path}:{symbol.line}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {fileLoading ? (
            <div className="workspace-diff-empty">{t('fileLoading')}</div>
          ) : currentFilePath ? (
            <textarea
              ref={editorRef}
              className="file-editor-textarea"
              data-file-editor-path={currentFilePath}
              value={currentFileContent}
              spellCheck={false}
              onChange={(e) => updateDraft(e.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'F12') {
                  event.preventDefault()
                  void requestSymbols('definition')
                } else if ((event.ctrlKey || event.metaKey) && (event.code === 'Space' || event.key === ' ')) {
                  event.preventDefault()
                  void requestSymbols('completion')
                } else if (event.key === 'Escape' && (symbolMode || hoverOpen)) {
                  event.preventDefault()
                  setSymbolMode(null)
                  setHoverOpen(false)
                }
              }}
            />
          ) : (
            <div className="workspace-diff-empty">{t('filePickHint')}</div>
          )}
        </section>
      </div>
    </div>
  )
}
