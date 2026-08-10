import type {
  AgentDeskApi,
  ProjectRefactorApplyResult,
  ProjectRefactorInput,
  ProjectRefactorPreview,
  ProjectRefactorRollbackResult,
  ProjectRefactorRecovery
} from '../shared/types'
import { invokeAppFeature } from './app-feature'

const invokeProjectRefactor = <T>(action: string, sessionId: string, value?: unknown): Promise<T> =>
  invokeAppFeature<T>('project-refactor', action, sessionId, value)

export const projectRefactorApi: Pick<AgentDeskApi,
  'previewTypeScriptRename' | 'applyProjectRefactor' | 'rollbackProjectRefactor' |
  'getProjectRefactorRecovery' | 'dismissProjectRefactorRecovery'
> = {
  previewTypeScriptRename: (sessionId, input: ProjectRefactorInput) =>
    invokeProjectRefactor<ProjectRefactorPreview>('preview-rename', sessionId, input),
  applyProjectRefactor: (sessionId, previewId) =>
    invokeProjectRefactor<ProjectRefactorApplyResult>('apply', sessionId, previewId),
  rollbackProjectRefactor: (sessionId, operationId) =>
    invokeProjectRefactor<ProjectRefactorRollbackResult>('rollback', sessionId, operationId),
  getProjectRefactorRecovery: (sessionId) =>
    invokeProjectRefactor<ProjectRefactorRecovery>('recovery', sessionId),
  dismissProjectRefactorRecovery: (sessionId, operationId) =>
    invokeProjectRefactor<void>('dismiss-recovery', sessionId, operationId)
}
