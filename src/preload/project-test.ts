import type { AgentDeskApi, ProjectTestDiscoveryResult, ProjectTestRunResult } from '../shared/types'
import { invokeAppFeature } from './app-feature'

const invokeProjectTest = <T>(action: string, sessionId: string, commandId?: string): Promise<T> =>
  invokeAppFeature<T>('project-test', action, sessionId, commandId)

export const projectTestApi: Pick<AgentDeskApi,
  'discoverProjectTests' | 'runProjectTest' | 'cancelProjectTest'
> = {
  discoverProjectTests: (sessionId) => invokeProjectTest<ProjectTestDiscoveryResult>('discover', sessionId),
  runProjectTest: (sessionId, commandId) => invokeProjectTest<ProjectTestRunResult>('run', sessionId, commandId),
  cancelProjectTest: (sessionId) => invokeProjectTest<boolean>('cancel', sessionId)
}
