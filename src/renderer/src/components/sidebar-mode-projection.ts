import type { HistoryEntry } from '../../../shared/types'
import type { ExperienceMode } from '../store/experience-mode'
import type { SidebarEntry } from './sidebar-project-groups'

export function splitAssistantEntries(entries: SidebarEntry[]): {
  archived: HistoryEntry[]
  pinned: SidebarEntry[]
  sessions: SidebarEntry[]
} {
  const active = entries.filter((entry) => entry.kind === 'active' || !entry.history.archived)
  const pinned = active.filter((entry) => entry.kind === 'active' ? Boolean(entry.history?.pinned) : Boolean(entry.history.pinned))
  const pinnedIds = new Set(pinned.map((entry) => `${entry.kind}:${entry.id}`))
  return {
    archived: entries.flatMap((entry) => entry.kind === 'history' && entry.history.archived ? [entry.history] : []),
    pinned,
    sessions: active.filter((entry) => !pinnedIds.has(`${entry.kind}:${entry.id}`))
  }
}

export function sidebarSearchKey(mode: ExperienceMode): 'searchSessionsPlaceholder' | 'searchProjectsPlaceholder' | 'searchVideosPlaceholder' {
  if (mode === 'studio') return 'searchProjectsPlaceholder'
  if (mode === 'video') return 'searchVideosPlaceholder'
  return 'searchSessionsPlaceholder'
}

export function sidebarVisibleCount(
  mode: ExperienceMode,
  assistantCounts: number[],
  projectCounts: number[]
): number {
  return (mode === 'assistant' ? assistantCounts : projectCounts).reduce((total, count) => total + count, 0)
}
