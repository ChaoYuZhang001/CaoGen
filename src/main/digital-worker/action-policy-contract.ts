import type { DigitalWorker, JsonObject, JsonValue } from '../../shared/digital-worker-types'
import { isReadOnlyToolCall, normalizeToolName } from '../task/tool-idempotency'

export type DigitalWorkerToolCapability =
  | 'workspaceRead'
  | 'workspaceWrite'
  | 'terminal'
  | 'browser'
  | 'network'

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

const TOOL_POLICY_FIELDS = new Set<DigitalWorkerToolCapability>([
  'workspaceRead',
  'workspaceWrite',
  'terminal',
  'browser',
  'network'
])

const COMPOSITE_TOOL_CAPABILITIES: DigitalWorkerToolCapability[] = [
  'workspaceRead',
  'workspaceWrite',
  'terminal',
  'browser',
  'network'
]

const INTERACTIVE_GUI_TOOLS = new Set([
  'gui_activate_window',
  'gui_click',
  'gui_type',
  'gui_scroll',
  'gui_hotkey'
])

const NETWORK_TOOLS = new Set([
  'web_fetch',
  'web_search',
  'mcp_discover',
  'mcp_builtin_servers',
  'mcp_import_claude_desktop',
  'china_notify',
  'gitee_prepare',
  'git_push',
  'git_create_pr'
])

const WORKSPACE_WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'memory_add',
  'optimize_skill',
  'git_stage',
  'git_stage_all',
  'git_commit',
  'git_merge',
  'code_forge_delivery',
  'task_dispatch_dag',
  'task_decompose_and_dispatch_dag',
  'genesis_orchestrate'
])

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
  const capabilities = toolCapabilities(normalized, toolInput)
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

function toolCapabilities(
  toolName: string,
  toolInput: Record<string, unknown>
): DigitalWorkerToolCapability[] {
  if (toolName === 'bash' || toolName === 'mcp_call_tool') return [...COMPOSITE_TOOL_CAPABILITIES]
  if (toolName.startsWith('browser_')) return ['browser', 'network']
  if (toolName === 'gui_list_windows') return ['browser']
  if (toolName === 'gui_screenshot') return ['browser', 'workspaceWrite']
  if (INTERACTIVE_GUI_TOOLS.has(toolName)) return [...COMPOSITE_TOOL_CAPABILITIES]
  if (toolName.startsWith('gui_')) return []
  if (NETWORK_TOOLS.has(toolName)) return ['network']
  if (toolName === 'search_replace') {
    return isReadOnlyToolCall(toolName, toolInput) ? ['workspaceRead'] : ['workspaceWrite']
  }
  if (WORKSPACE_WRITE_TOOLS.has(toolName)) return ['workspaceWrite']
  if (isReadOnlyToolCall(toolName, toolInput)) return ['workspaceRead']
  return []
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
