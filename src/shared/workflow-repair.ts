export const WORKFLOW_ACCEPTANCE_REPAIR_WORK_ITEM_PREFIX = 'workflow-repair:' as const

export type WorkflowAcceptanceRepairWorkItemId =
  `${typeof WORKFLOW_ACCEPTANCE_REPAIR_WORK_ITEM_PREFIX}${string}`

export function isWorkflowAcceptanceRepairWorkItemId(
  value: unknown
): value is WorkflowAcceptanceRepairWorkItemId {
  if (typeof value !== 'string' || !value.startsWith(WORKFLOW_ACCEPTANCE_REPAIR_WORK_ITEM_PREFIX)) {
    return false
  }
  return /^[a-f0-9]{64}$/u.test(value.slice(WORKFLOW_ACCEPTANCE_REPAIR_WORK_ITEM_PREFIX.length))
}
