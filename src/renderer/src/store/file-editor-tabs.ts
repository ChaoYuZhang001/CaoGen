export interface FileEditorTab {
  sessionId: string
  path: string
  content: string
  savedContent: string
  bytes?: number
  mtimeMs?: number
}

export interface FileEditorTabsState {
  fileTabs: FileEditorTab[]
  activeFileTabBySession: Record<string, string>
}

export function tabsForSession(
  state: FileEditorTabsState,
  sessionId: string
): FileEditorTab[] {
  return state.fileTabs.filter((tab) => tab.sessionId === sessionId)
}

export function activeFileTab(
  state: FileEditorTabsState,
  sessionId: string
): FileEditorTab | undefined {
  const path = state.activeFileTabBySession[sessionId]
  return path ? state.fileTabs.find((tab) => tab.sessionId === sessionId && tab.path === path) : undefined
}

export function upsertFileTab(
  state: FileEditorTabsState,
  tab: FileEditorTab
): FileEditorTabsState {
  const index = state.fileTabs.findIndex(
    (candidate) => candidate.sessionId === tab.sessionId && candidate.path === tab.path
  )
  const fileTabs = [...state.fileTabs]
  if (index >= 0) fileTabs[index] = tab
  else fileTabs.push(tab)
  return {
    fileTabs,
    activeFileTabBySession: { ...state.activeFileTabBySession, [tab.sessionId]: tab.path }
  }
}

export function selectFileTab(
  state: FileEditorTabsState,
  sessionId: string,
  path: string
): FileEditorTabsState {
  const exists = state.fileTabs.some((tab) => tab.sessionId === sessionId && tab.path === path)
  return exists
    ? {
        fileTabs: state.fileTabs,
        activeFileTabBySession: { ...state.activeFileTabBySession, [sessionId]: path }
      }
    : state
}

export function updateFileTabDraft(
  state: FileEditorTabsState,
  sessionId: string,
  path: string,
  content: string
): FileEditorTabsState {
  return {
    fileTabs: state.fileTabs.map((tab) =>
      tab.sessionId === sessionId && tab.path === path ? { ...tab, content } : tab
    ),
    activeFileTabBySession: state.activeFileTabBySession
  }
}

export function markFileTabSaved(
  state: FileEditorTabsState,
  sessionId: string,
  path: string,
  savedContent: string,
  bytes?: number,
  mtimeMs?: number
): FileEditorTabsState {
  return {
    fileTabs: state.fileTabs.map((tab) =>
      tab.sessionId === sessionId && tab.path === path
        ? { ...tab, savedContent, bytes, mtimeMs }
        : tab
    ),
    activeFileTabBySession: state.activeFileTabBySession
  }
}

export function closeFileTabState(
  state: FileEditorTabsState,
  sessionId: string,
  path: string
): FileEditorTabsState {
  const sessionTabs = tabsForSession(state, sessionId)
  const closedIndex = sessionTabs.findIndex((tab) => tab.path === path)
  if (closedIndex < 0) return state
  const fileTabs = state.fileTabs.filter((tab) => !(tab.sessionId === sessionId && tab.path === path))
  const activeFileTabBySession = { ...state.activeFileTabBySession }
  if (activeFileTabBySession[sessionId] === path) {
    const remaining = sessionTabs.filter((tab) => tab.path !== path)
    const next = remaining[Math.min(closedIndex, remaining.length - 1)]
    if (next) activeFileTabBySession[sessionId] = next.path
    else delete activeFileTabBySession[sessionId]
  }
  return { fileTabs, activeFileTabBySession }
}

export function cycleFileTabState(
  state: FileEditorTabsState,
  sessionId: string,
  direction: -1 | 1
): FileEditorTabsState {
  const tabs = tabsForSession(state, sessionId)
  if (tabs.length < 2) return state
  const currentPath = state.activeFileTabBySession[sessionId]
  const currentIndex = Math.max(0, tabs.findIndex((tab) => tab.path === currentPath))
  const nextIndex = (currentIndex + direction + tabs.length) % tabs.length
  return selectFileTab(state, sessionId, tabs[nextIndex].path)
}
