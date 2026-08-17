import { ChevronDown, ChevronRight, Eye, File, FileText, Folder, FolderOpen } from 'lucide-react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ProjectFileTreeNavigationKey, VisibleProjectFileNode } from './project-file-tree'
import { nextProjectFileTreePath } from './project-file-tree'

export type FileBrowserMode = 'tree' | 'search' | 'problems'

export interface FileTreeRowProps {
  item: VisibleProjectFileNode
  expanded: boolean
  active: boolean
  focused: boolean
  onToggle: (path: string) => void
  onOpen: (path: string) => void
  onPreview: (path: string) => void
  onFocus: (path: string) => void
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void
  previewLabel: string
}

export function FileTreeRow({
  item, expanded, active, focused, onToggle, onOpen, onPreview, onFocus, onKeyDown, previewLabel
}: FileTreeRowProps): React.JSX.Element {
  const { node, depth } = item
  const directory = node.kind === 'directory'
  const textFile = !directory && isLikelyTextFile(node.path)
  const style = { '--file-tree-depth': depth } as CSSProperties
  return (
    <div className={`file-row-wrap ${active ? 'active' : ''}`}>
      <button
        type="button"
        className={`file-row file-tree-row ${active ? 'active' : ''} file-row-${node.kind}`}
        style={style}
        title={node.path}
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={directory ? expanded : undefined}
        aria-selected={active}
        tabIndex={focused ? 0 : -1}
        data-file-tree-path={node.path}
        onFocus={() => onFocus(node.path)}
        onKeyDown={onKeyDown}
        onClick={() => directory ? onToggle(node.path) : onOpen(node.path)}
      >
        <span className="file-row-chevron" aria-hidden="true">
          {directory ? (expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : null}
        </span>
        <span className="file-row-mark" aria-hidden="true">
          {directory ? (expanded ? <FolderOpen size={14} /> : <Folder size={14} />) : textFile ? <FileText size={14} /> : <File size={14} />}
        </span>
        <span className="file-row-path">{node.name}</span>
        {!directory && <span className="file-row-size">{formatFileBytes(node.size)}</span>}
      </button>
      {!directory && (
        <button type="button" className="file-row-preview" title={previewLabel}
          aria-label={`${previewLabel}: ${node.path}`} onClick={() => onPreview(node.path)}>
          <Eye size={13} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

export function moveFileBrowserModeFocus(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  current: FileBrowserMode,
  selectMode: (mode: FileBrowserMode) => void
): void {
  const modes: FileBrowserMode[] = ['tree', 'search', 'problems']
  const next = nextMode(modes, current, event.key)
  if (!next) return
  event.preventDefault()
  selectMode(next)
  const tablist = event.currentTarget.parentElement
  requestAnimationFrame(() => tablist
    ?.querySelector<HTMLButtonElement>(`[data-file-browser-mode="${next}"]`)?.focus())
}

export function focusFileTreeEntry(path: string, setFocused: (path: string) => void): void {
  setFocused(path)
  requestAnimationFrame(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('[data-file-tree-path]')]
      .find((candidate) => candidate.dataset.fileTreePath === path)
    button?.focus()
  })
}

export function handleFileTreeKeyDown(options: {
  item: VisibleProjectFileNode
  event: ReactKeyboardEvent<HTMLButtonElement>
  expandedPaths: ReadonlySet<string>
  visibleEntries: VisibleProjectFileNode[]
  toggleDirectory: (path: string) => void
  openFile: (path: string) => void | Promise<void>
  focusTreeEntry: (path: string) => void
}): void {
  const { item, event, expandedPaths, visibleEntries, toggleDirectory, openFile, focusTreeEntry } = options
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    if (item.node.kind === 'directory') toggleDirectory(item.node.path)
    else void openFile(item.node.path)
    return
  }
  if (handleDirectoryToggle(item, event, expandedPaths, toggleDirectory)) return
  const key = toTreeNavigationKey(event.key)
  if (!key) return
  const next = nextProjectFileTreePath(visibleEntries, item.node.path, key, expandedPaths)
  if (!next) return
  event.preventDefault()
  focusTreeEntry(next)
}

function handleDirectoryToggle(
  item: VisibleProjectFileNode,
  event: ReactKeyboardEvent<HTMLButtonElement>,
  expandedPaths: ReadonlySet<string>,
  toggleDirectory: (path: string) => void
): boolean {
  if (item.node.kind !== 'directory') return false
  const expanded = expandedPaths.has(item.node.path)
  if ((event.key === 'ArrowRight' && !expanded) || (event.key === 'ArrowLeft' && expanded)) {
    event.preventDefault()
    toggleDirectory(item.node.path)
    return true
  }
  return false
}

function toTreeNavigationKey(key: string): ProjectFileTreeNavigationKey | null {
  return ['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'End', 'Home'].includes(key)
    ? key as ProjectFileTreeNavigationKey
    : null
}

function nextMode(modes: FileBrowserMode[], current: FileBrowserMode, key: string): FileBrowserMode | null {
  if (key === 'Home') return modes[0] ?? null
  if (key === 'End') return modes.at(-1) ?? null
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null
  const offset = key === 'ArrowRight' ? 1 : -1
  return modes[(modes.indexOf(current) + offset + modes.length) % modes.length] ?? null
}

export function formatFileBytes(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function isLikelyTextFile(path: string): boolean {
  return /\.(cjs|css|csv|html?|js|json|jsx|md|mjs|scss|svg|toml|ts|tsx|txt|xml|ya?ml)$/i.test(path)
}
