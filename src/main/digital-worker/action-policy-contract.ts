import type { DigitalWorker, JsonObject, JsonValue } from '../../shared/digital-worker-types'
import type { ToolSemanticCapability } from '../../shared/types'
import { normalizeToolName } from '../task/tool-idempotency'
import { classifyToolCapabilities, TOOL_SEMANTIC_CAPABILITIES } from '../permission/tool-capabilities'

export type DigitalWorkerToolCapability = ToolSemanticCapability

export interface DigitalWorkerPolicyContract {
  monthlyBudgetUsd?: number
  concurrencyLimit: number
  escalation?: {
    target: string
    afterFailures: number
  }
}

export type DigitalWorkerToolPolicyDecision =
  | { allowed: true; capabilities: DigitalWorkerToolCapability[] }
  | { allowed: false; capabilities: DigitalWorkerToolCapability[]; reason: string }

const TOOL_POLICY_FIELDS = new Set<DigitalWorkerToolCapability>(TOOL_SEMANTIC_CAPABILITIES)

export function digitalWorkerPolicyContract(
  worker: Pick<DigitalWorker, 'toolPolicy' | 'budgetPolicy' | 'concurrencyLimit' | 'escalationPolicy'>
): DigitalWorkerPolicyContract {
  assertToolPolicy(worker.toolPolicy)
  const monthlyBudgetUsd = optionalNonNegativeNumber(worker.budgetPolicy.monthlyUsd, 'budgetPolicy.monthlyUsd')
  const concurrencyLimit = requiredInteger(worker.concurrencyLimit, 'concurrencyLimit', 1, 32)
  const escalation = escalationContract(worker.escalationPolicy)
  return {
    ...(monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd }),
    concurrencyLimit,
    ...(escalation === undefined ? {} : { escalation })
  }
}

export function digitalWorkerPolicyContractError(
  worker: Pick<DigitalWorker, 'toolPolicy' | 'budgetPolicy' | 'concurrencyLimit' | 'escalationPolicy'>
): string | null {
  try {
    digitalWorkerPolicyContract(worker)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export function evaluateDigitalWorkerToolPolicy(
  policy: JsonObject,
  toolName: string,
  toolInput: Record<string, unknown>
): DigitalWorkerToolPolicyDecision {
  const normalized = normalizeToolName(toolName)
  const capabilities = classifyToolCapabilities(normalized, toolInput)
  if (capabilities.length === 0) {
    return {
      allowed: false,
      capabilities,
      reason: `toolPolicy cannot classify tool ${normalized}`
    }
  }
  const denied = capabilities.find((capability) => policy[capability] !== true)
  if (denied) {
    return {
      allowed: false,
      capabilities,
      reason: `toolPolicy.${denied} does not allow ${normalized}`
    }
  }
  return { allowed: true, capabilities }
}

function assertToolPolicy(policy: JsonObject): void {
  for (const [field, value] of Object.entries(policy)) {
    if (!TOOL_POLICY_FIELDS.has(field as DigitalWorkerToolCapability)) continue
    if (typeof value !== 'boolean') throw new Error(`toolPolicy.${field} must be boolean`)
  }
}

function escalationContract(policy: JsonObject): DigitalWorkerPolicyContract['escalation'] {
  const target = optionalText(policy.target, 'escalationPolicy.target')
  const afterFailures = optionalInteger(policy.afterFailures, 'escalationPolicy.afterFailures', 1, 10_000)
  if (target === undefined && afterFailures === undefined) return undefined
  if (target === undefined || afterFailures === undefined) {
    throw new Error('escalationPolicy.target and escalationPolicy.afterFailures must be configured together')
  }
  return { target, afterFailures }
}

function optionalText(value: JsonValue | undefined, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`)
  return value.trim()
}

function optionalNonNegativeNumber(value: JsonValue | undefined, field: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number`)
  }
  return value
}

function optionalInteger(
  value: JsonValue | undefined,
  field: string,
  minimum: number,
  maximum: number
): number | undefined {
  if (value === undefined || value === null) return undefined
  return requiredInteger(value, field, minimum, maximum)
}

function requiredInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`)
  }
  return value as number
}
