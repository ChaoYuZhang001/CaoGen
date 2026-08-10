import type {
  AgentDeskApi,
  ProjectDebugBreakpoint,
  ProjectDebugControlAction,
  ProjectDebugDiscoveryResult,
  ProjectDebugState,
  ProjectDebugVariable
} from '../shared/types'
import { invokeAppFeature } from './app-feature'

const invokeProjectDebug = <T>(action: string, sessionId: string, ...args: unknown[]): Promise<T> =>
  invokeAppFeature<T>('project-debug', action, sessionId, ...args)

export const projectDebugApi: Pick<AgentDeskApi,
  'discoverProjectDebugTargets' | 'getProjectDebugState' | 'launchProjectDebug' |
  'controlProjectDebug' | 'selectProjectDebugFrame' | 'expandProjectDebugVariable'
> = {
  discoverProjectDebugTargets: (sessionId) => invokeProjectDebug<ProjectDebugDiscoveryResult>('discover', sessionId),
  getProjectDebugState: (sessionId) => invokeProjectDebug<ProjectDebugState>('get-state', sessionId),
  launchProjectDebug: (sessionId, targetId, breakpoints: ProjectDebugBreakpoint[]) =>
    invokeProjectDebug<ProjectDebugState>('launch', sessionId, targetId, breakpoints),
  controlProjectDebug: (sessionId, action: ProjectDebugControlAction) =>
    invokeProjectDebug<ProjectDebugState>('control', sessionId, action),
  selectProjectDebugFrame: (sessionId, frameId) =>
    invokeProjectDebug<ProjectDebugState>('select-frame', sessionId, frameId),
  expandProjectDebugVariable: (sessionId, variableId) =>
    invokeProjectDebug<ProjectDebugVariable[]>('expand-variable', sessionId, variableId)
}
