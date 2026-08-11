import type { ModelAttemptCostIdentity } from '../provider/modelAttemptCost'
import { canEstimateModelAttemptCost } from '../provider/modelAttemptCost'
import {
  preflightDigitalWorkerAction,
  type DigitalWorkerActionPolicyDecision,
  type DigitalWorkerActionPolicyInput
} from './action-policy'
import { resolveDigitalWorkerSessionScope } from './session-binding'
import { DigitalWorkerUsageLedgerError, readDigitalWorkerMonthlySpend } from './usage-ledger'

/** Production billable paths must await the verified ModelAttempt ledger. */
export async function preflightDigitalWorkerBillableAction(
  input: DigitalWorkerActionPolicyInput,
  attempt: ModelAttemptCostIdentity
): Promise<DigitalWorkerActionPolicyDecision> {
  const baseline = preflightDigitalWorkerAction({
    ...input,
    billableUsage: { trackable: true, monthlySpentUsd: 0 }
  })
  if (!baseline.allowed || !baseline.scoped || baseline.monthlyBudgetUsd === undefined) return baseline
  const rootDir = input.rootDir
  if (!rootDir?.trim()) {
    return denied(baseline, 'policy_store_unavailable', '数字员工用量账本根目录未配置')
  }
  try {
    if (!canEstimateModelAttemptCost(attempt)) {
      return preflightDigitalWorkerAction({
        ...input,
        billableUsage: { trackable: false, monthlySpentUsd: 0 }
      })
    }
    const scope = resolveDigitalWorkerSessionScope(input.meta, rootDir)
    if (!scope.scoped || scope.worker.id !== baseline.workerId) {
      return denied(baseline, 'assignment_conflict', '数字员工预算身份在账本读取前发生变化')
    }
    const monthlySpentUsd = await readDigitalWorkerMonthlySpend(rootDir, scope.worker.id, input.now)
    return preflightDigitalWorkerAction({
      ...input,
      billableUsage: { trackable: true, monthlySpentUsd }
    })
  } catch (error) {
    if (error instanceof DigitalWorkerUsageLedgerError) return denied(baseline, error.code, error.message)
    return denied(
      baseline,
      'policy_store_unavailable',
      `数字员工用量账本读取失败：${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function denied(
  scope: Extract<DigitalWorkerActionPolicyDecision, { allowed: true; scoped: true }>,
  code: Extract<DigitalWorkerActionPolicyDecision, { allowed: false }>['code'],
  message: string
): DigitalWorkerActionPolicyDecision {
  return {
    allowed: false,
    scoped: true,
    code,
    message,
    workerId: scope.workerId,
    assignmentId: scope.assignmentId
  }
}
