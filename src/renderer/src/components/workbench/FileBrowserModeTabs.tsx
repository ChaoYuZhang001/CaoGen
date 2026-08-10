import { CircleAlert, FolderTree, Search } from 'lucide-react'
import { rovingTabProps } from './roving-tabs'

export type FileBrowserMode = 'tree' | 'search' | 'problems'

export const FILE_MODE_TAB_IDS: Record<FileBrowserMode, string> = {
  tree: 'file-browser-tab-tree',
  search: 'file-browser-tab-search',
  problems: 'file-browser-tab-problems'
}
export const FILE_MODE_PANEL_ID = 'file-browser-mode-panel'

export default function FileBrowserModeTabs({
  label,
  labels,
  mode,
  onSelect,
  problemCount
}: {
  label: string
  labels: Record<FileBrowserMode, string>
  mode: FileBrowserMode
  onSelect: (mode: FileBrowserMode) => void
  problemCount: number
}): React.JSX.Element {
  return (
    <div className="file-browser-modes" role="tablist" aria-label={label}>
      <button id={FILE_MODE_TAB_IDS.tree} type="button" role="tab" title={labels.tree} aria-label={labels.tree} {...rovingTabProps(mode === 'tree', FILE_MODE_PANEL_ID)} className={mode === 'tree' ? 'active' : ''} onClick={() => onSelect('tree')}>
        <FolderTree size={14} aria-hidden="true" />
      </button>
      <button id={FILE_MODE_TAB_IDS.search} type="button" role="tab" title={labels.search} aria-label={labels.search} {...rovingTabProps(mode === 'search', FILE_MODE_PANEL_ID)} className={mode === 'search' ? 'active' : ''} onClick={() => onSelect('search')}>
        <Search size={14} aria-hidden="true" />
      </button>
      <button id={FILE_MODE_TAB_IDS.problems} type="button" role="tab" title={labels.problems} aria-label={labels.problems} {...rovingTabProps(mode === 'problems', FILE_MODE_PANEL_ID)} className={mode === 'problems' ? 'active' : ''} onClick={() => onSelect('problems')}>
        <CircleAlert size={14} aria-hidden="true" />{problemCount > 0 ? <span className="file-problem-count">{problemCount}</span> : null}
      </button>
    </div>
  )
}
