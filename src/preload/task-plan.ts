import { ipcRenderer } from 'electron'
import type {
  TaskPlanApi,
  TaskPlanApprovalInput,
  TaskPlanDraftInput,
  TaskStrategy
} from '../shared/types'

function invoke<T>(action: string, sessionId: string, payload?: unknown): Promise<T> {
  return ipcRenderer.invoke('appFeatures:invoke', 'task-plan', action, sessionId, payload) as Promise<T>
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
