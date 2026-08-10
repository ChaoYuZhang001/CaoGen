import { useEffect, useRef, useState } from 'react'
import type {
  ProjectDebugBreakpoint,
  ProjectDebugControlAction,
  ProjectDebugState,
  ProjectDebugTarget
} from '../../../../shared/types'
import { useStore } from '../../store'

export interface ProjectDebuggerController {
  activeId: string | null
  targets: ProjectDebugTarget[]
  state: ProjectDebugState
  breakpoints: ProjectDebugBreakpoint[]
  loading: boolean
  pending: boolean
  error: string
  refresh(): Promise<void>
  launch(target: ProjectDebugTarget): Promise<void>
  control(action: ProjectDebugControlAction): Promise<void>
  selectFrame(frameId: string): Promise<void>
  addBreakpoint(path: string, line: number): void
  removeBreakpoint(index: number): void
}

const IDLE_STATE: ProjectDebugState = {
  status: 'idle', targetId: '', targetLabel: '', pauseReason: '', frames: [], selectedFrameId: '', scopes: [],
  stdout: '', stderr: '', outputTruncated: false, startedAt: '', finishedAt: '', exitCode: null, error: ''
}

export function useProjectDebugger(): ProjectDebuggerController {
  const activeId = useStore((store) => store.activeId)
  const [targets, setTargets] = useState<ProjectDebugTarget[]>([])
  const [state, setState] = useState<ProjectDebugState>(IDLE_STATE)
  const [breakpoints, setBreakpoints] = useState<ProjectDebugBreakpoint[]>([])
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const requestSequence = useRef(0)
  const activeSessionId = useRef(activeId)
  activeSessionId.current = activeId

  const refreshSession = async (sessionId: string): Promise<void> => {
    const sequence = ++requestSequence.current
    setLoading(true); setError('')
    try {
      const [discovery, current] = await Promise.all([
        window.agentDesk.discoverProjectDebugTargets(sessionId),
        window.agentDesk.getProjectDebugState(sessionId)
      ])
      if (sequence !== requestSequence.current) return
      setTargets(discovery.targets)
      setState(current)
      if (!discovery.ok) setError(discovery.error ?? 'Debug target discovery failed')
    } catch (caught) {
      if (sequence === requestSequence.current) setError(errorMessage(caught))
    } finally {
      if (sequence === requestSequence.current) setLoading(false)
    }
  }

  useEffect(() => {
    requestSequence.current += 1
    setTargets([]); setState(IDLE_STATE); setBreakpoints([]); setError(''); setPending(false)
    if (activeId) void refreshSession(activeId)
  }, [activeId])

  useEffect(() => {
    if (!activeId || (state.status !== 'starting' && state.status !== 'running')) return
    const timer = window.setInterval(() => {
      void window.agentDesk.getProjectDebugState(activeId)
        .then((next) => { if (activeSessionId.current === activeId) setState(next) })
        .catch((caught) => { if (activeSessionId.current === activeId) setError(errorMessage(caught)) })
    }, 250)
    return () => window.clearInterval(timer)
  }, [activeId, state.status])

  const launch = async (target: ProjectDebugTarget): Promise<void> => {
    if (!activeId || pending || isActive(state.status)) return
    const sessionId = activeId
    setPending(true); setError('')
    try {
      const next = await window.agentDesk.launchProjectDebug(sessionId, target.id, breakpoints)
      if (activeSessionId.current === sessionId) setState(next)
    } catch (caught) {
      if (activeSessionId.current === sessionId) setError(errorMessage(caught))
    } finally {
      if (activeSessionId.current === sessionId) setPending(false)
    }
  }

  const control = async (action: ProjectDebugControlAction): Promise<void> => {
    if (!activeId || pending) return
    const sessionId = activeId
    setPending(true); setError('')
    try {
      const next = await window.agentDesk.controlProjectDebug(sessionId, action)
      if (activeSessionId.current === sessionId) setState(next)
    } catch (caught) {
      if (activeSessionId.current === sessionId) setError(errorMessage(caught))
    } finally {
      if (activeSessionId.current === sessionId) setPending(false)
    }
  }

  const selectFrame = async (frameId: string): Promise<void> => {
    if (!activeId || pending || frameId === state.selectedFrameId) return
    const sessionId = activeId
    setPending(true); setError('')
    try {
      const next = await window.agentDesk.selectProjectDebugFrame(sessionId, frameId)
      if (activeSessionId.current === sessionId) setState(next)
    } catch (caught) {
      if (activeSessionId.current === sessionId) setError(errorMessage(caught))
    } finally {
      if (activeSessionId.current === sessionId) setPending(false)
    }
  }

  const addBreakpoint = (path: string, line: number): void => {
    const normalized = path.trim().replace(/\\/g, '/')
    if (!normalized || !Number.isSafeInteger(line) || line < 1) return
    setBreakpoints((current) => current.some((item) => item.path.toLowerCase() === normalized.toLowerCase() && item.line === line)
      ? current
      : [...current, { path: normalized, line }].slice(0, 200))
  }

  return {
    activeId, targets, state, breakpoints, loading, pending, error,
    refresh: () => activeId ? refreshSession(activeId) : Promise.resolve(),
    launch, control, selectFrame, addBreakpoint,
    removeBreakpoint: (index) => setBreakpoints((current) => current.filter((_item, itemIndex) => itemIndex !== index))
  }
}

function isActive(status: ProjectDebugState['status']): boolean {
  return status === 'starting' || status === 'running' || status === 'paused'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
