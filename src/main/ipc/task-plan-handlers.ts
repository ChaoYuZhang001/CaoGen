import type { TaskPlanApprovalInput, TaskPlanDraftInput } from '../../shared/types'
import { sessionManager } from '../sessionManager'

type TaskPlanAction = 'strategy' | 'get' | 'create-version' | 'approve' | 'revoke'

export function handleTaskPlanIpc(action: unknown, rawSessionId: unknown, payload: unknown) {
  if (!isTaskPlanAction(action)) throw new Error('任务计划操作无效')
  const sessionId = typeof rawSessionId === 'string' ? rawSessionId : ''
  if (action === 'strategy') return sessionManager.setTaskStrategy(sessionId, payload)
  if (action === 'get') return sessionManager.getTaskPlan(sessionId)
  if (action === 'create-version') {
    return sessionManager.createTaskPlanVersion(sessionId, payload as TaskPlanDraftInput)
  }
  if (action === 'approve') {
    return sessionManager.approveTaskPlan(sessionId, payload as TaskPlanApprovalInput)
  }
  return sessionManager.revokeTaskPlanApproval(sessionId, payload as TaskPlanApprovalInput)
}

function isTaskPlanAction(value: unknown): value is TaskPlanAction {
  return value === 'strategy' || value === 'get' || value === 'create-version' ||
    value === 'approve' || value === 'revoke'
}
