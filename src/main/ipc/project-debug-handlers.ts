import { app, type IpcMainInvokeEvent } from 'electron'
import {
  controlProjectDebug,
  discoverProjectDebugTargets,
  expandProjectDebugVariable,
  getProjectDebugState,
  launchProjectDebug,
  selectProjectDebugFrame
} from '../projectDebugger'
import { sessionManager } from '../sessionManager'
import type { ProjectDebugBreakpoint, ProjectDebugControlAction } from '../../shared/types'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { registerProjectDebugReport } from '../task/workbench-report-artifacts'

type ProjectDebugAction = 'discover' | 'get-state' | 'launch' | 'control' | 'select-frame' | 'expand-variable'

export async function handleProjectDebugIpc(
  event: IpcMainInvokeEvent,
  rawAction: unknown,
  rawSessionId: unknown,
  ...args: unknown[]
) {
  assertTrustedWorkflowLedgerSender(event)
  const action = requiredAction(rawAction)
  const sessionId = requiredIdentifier(rawSessionId, 'Session ID')
  const session = sessionManager.get(sessionId)
  if (!session) throw new Error('Session was not found')
  if (action === 'discover') return discoverProjectDebugTargets(session.meta.cwd)
  if (action === 'get-state') return finalizeDebugReport(sessionId, getProjectDebugState(sessionId))
  if (action === 'launch') {
    const state = await launchProjectDebug(
      session.meta.cwd,
      sessionId,
      requiredIdentifier(args[0], 'Debug target ID'),
      requiredBreakpoints(args[1])
    )
    return finalizeDebugReport(sessionId, state)
  }
  if (action === 'control') {
    return finalizeDebugReport(sessionId, await controlProjectDebug(sessionId, requiredControl(args[0])))
  }
  if (action === 'select-frame') {
    return selectProjectDebugFrame(sessionId, requiredIdentifier(args[0], 'Stack frame ID'))
  }
  return expandProjectDebugVariable(sessionId, requiredIdentifier(args[0], 'Variable ID'))
}

async function finalizeDebugReport(sessionId: string, state: ReturnType<typeof getProjectDebugState>) {
  if (state.status !== 'stopped' && state.status !== 'failed') return state
  const session = sessionManager.get(sessionId)
  const projectId = session?.meta.workspaceId ?? session?.meta.projectId
  const creatingRun = sessionManager.getTaskRun(sessionId)
  if (!projectId || !creatingRun) {
    state.evidenceError = 'Canonical debug report requires a Project-owned current TaskRun'
    return state
  }
  try {
    const binding = await registerProjectDebugReport({
      sessionId,
      projectId,
      creatingRunId: creatingRun.id,
      rootInput: { workflowRoot: app.getPath('userData'), workspaceRoot: app.getPath('userData') }
    }, state)
    state.workflowArtifactId = binding.artifactId
    state.workflowEvidenceId = binding.evidenceId
    state.workflowAcceptanceId = binding.acceptanceId
  } catch (error) {
    state.evidenceError = `Canonical debug report finalization failed: ${error instanceof Error ? error.message : String(error)}`
  }
  return state
}

function requiredAction(value: unknown): ProjectDebugAction {
  if (value === 'discover' || value === 'get-state' || value === 'launch' || value === 'control' || value === 'select-frame' || value === 'expand-variable') return value
  throw new Error('Project debug action is invalid')
}

function requiredControl(value: unknown): ProjectDebugControlAction {
  if (value === 'continue' || value === 'pause' || value === 'step-over' || value === 'step-into' || value === 'step-out' || value === 'stop') return value
  throw new Error('Project debug control is invalid')
}

function requiredIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > 512) {
    throw new Error(`${label} is invalid`)
  }
  return value.trim()
}

function requiredBreakpoints(value: unknown): ProjectDebugBreakpoint[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error('Debug breakpoints are invalid')
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Debug breakpoint is invalid')
    const breakpoint = item as Record<string, unknown>
    if (typeof breakpoint.path !== 'string' || breakpoint.path.length > 4_096 || !Number.isSafeInteger(breakpoint.line)) {
      throw new Error('Debug breakpoint is invalid')
    }
    return { path: breakpoint.path, line: breakpoint.line as number }
  })
}
