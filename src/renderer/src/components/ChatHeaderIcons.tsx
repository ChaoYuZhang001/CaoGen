import {
  Bookmark,
  Building2,
  Clock3,
  Film,
  FileSearch,
  Files,
  FolderKanban,
  GitBranch,
  Globe2,
  LayoutGrid,
  Lightbulb,
  ListTree,
  Network,
  PanelRight,
  Puzzle,
  RotateCcw,
  Settings,
  SlidersHorizontal,
  SquarePen,
  SquareTerminal,
  ZoomIn,
  ZoomOut,
  type LucideIcon
} from 'lucide-react'

export type HeaderIconName =
  | 'compose'
  | 'project'
  | 'video'
  | 'office'
  | 'recovery'
  | 'settings'
  | 'summary'
  | 'panel'
  | 'tools'
  | 'review'
  | 'worktree'
  | 'subagents'
  | 'files'
  | 'plugins'
  | 'routines'
  | 'suggestions'
  | 'memory'
  | 'browser'
  | 'terminal'
  | 'zoomOut'
  | 'zoomReset'
  | 'zoomIn'
  | 'density'

const ICONS: Record<HeaderIconName, LucideIcon> = {
  compose: SquarePen,
  project: FolderKanban,
  video: Film,
  office: Building2,
  recovery: RotateCcw,
  settings: Settings,
  summary: ListTree,
  panel: PanelRight,
  tools: LayoutGrid,
  review: FileSearch,
  worktree: GitBranch,
  subagents: Network,
  files: Files,
  plugins: Puzzle,
  routines: Clock3,
  suggestions: Lightbulb,
  memory: Bookmark,
  browser: Globe2,
  terminal: SquareTerminal,
  zoomOut: ZoomOut,
  zoomReset: RotateCcw,
  zoomIn: ZoomIn,
  density: SlidersHorizontal
}

export function HeaderIcon({ name }: { name: HeaderIconName }): React.JSX.Element {
  const Icon = ICONS[name]
  return <Icon className="header-icon-glyph" size={16} strokeWidth={1.8} aria-hidden="true" />
}
