interface SessionCloseState<TSession, TView> {
  sessions: Record<string, TSession>
  order: string[]
  activeId: string | null
  showNewSession: boolean
  newSessionProjectId: string | null
  showTaskRecovery: boolean
  view: TView
}

export interface ClosingSessionSnapshot<TSession, TView> {
  session?: TSession
  index: number
  wasActive: boolean
  showNewSession: boolean
  newSessionProjectId: string | null
  showTaskRecovery: boolean
  view: TView
}

export function captureClosingSession<TSession, TView>(
  state: SessionCloseState<TSession, TView>,
  id: string
): ClosingSessionSnapshot<TSession, TView> {
  return {
    session: state.sessions[id],
    index: state.order.indexOf(id),
    wasActive: state.activeId === id,
    showNewSession: state.showNewSession,
    newSessionProjectId: state.newSessionProjectId,
    showTaskRecovery: state.showTaskRecovery,
    view: state.view
  }
}

export function removeClosingSession<TSession, TView>(
  state: SessionCloseState<TSession, TView>,
  id: string,
  wasActive: boolean
): Partial<SessionCloseState<TSession, TView>> {
  const sessions = { ...state.sessions }
  delete sessions[id]
  const order = state.order.filter((sessionId) => sessionId !== id)
  const requestedActiveId = state.activeId === id ? null : state.activeId
  const activeId = requestedActiveId && sessions[requestedActiveId]
    ? requestedActiveId
    : (order[order.length - 1] ?? null)
  return {
    sessions,
    order,
    activeId,
    showNewSession: wasActive ? activeId === null : state.showNewSession,
    newSessionProjectId: wasActive && activeId === null ? null : state.newSessionProjectId,
    showTaskRecovery: wasActive ? false : state.showTaskRecovery,
    view: wasActive && activeId === null ? ('list' as TView) : state.view
  }
}

export function restoreClosingSession<TSession, TView>(
  state: SessionCloseState<TSession, TView>,
  id: string,
  snapshot: ClosingSessionSnapshot<TSession, TView>,
  restore: (id: string, session: TSession) => TSession
): Partial<SessionCloseState<TSession, TView>> {
  if (!snapshot.session || state.sessions[id]) return {}
  const order = [...state.order]
  order.splice(Math.min(Math.max(snapshot.index, 0), order.length), 0, id)
  return {
    sessions: { ...state.sessions, [id]: restore(id, snapshot.session) },
    order,
    activeId: snapshot.wasActive ? id : state.activeId,
    ...(snapshot.wasActive
      ? {
          showNewSession: snapshot.showNewSession,
          newSessionProjectId: snapshot.newSessionProjectId,
          showTaskRecovery: snapshot.showTaskRecovery,
          view: snapshot.view
        }
      : {})
  }
}
