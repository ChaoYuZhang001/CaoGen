import type {
  TaskPlanApi,
  TaskPlanApprovalInput,
  TaskPlanDraftInput,
  TaskStrategy
} from '../shared/types'
import { invokeAppFeature } from './app-feature'

function invoke<T>(action: string, sessionId: string, payload?: unknown): Promise<T> {
  return invokeAppFeature('task-plan', action, sessionId, payload)
}

export const taskPlanApi: TaskPlanApi = {
  setTaskStrategy: (sessionId: string, strategy: TaskStrategy) =>
    invoke('strategy', sessionId, strategy),
  getTaskPlan: (sessionId: string) => invoke('get', sessionId),
  createTaskPlanVersion: (sessionId: string, draft: TaskPlanDraftInput) =>
    invoke('create-version', sessionId, draft),
  approveTaskPlan: (sessionId: string, input: TaskPlanApprovalInput) =>
    invoke('approve', sessionId, input),
  revokeTaskPlanApproval: (sessionId: string, input: TaskPlanApprovalInput) =>
    invoke('revoke', sessionId, input)
}
