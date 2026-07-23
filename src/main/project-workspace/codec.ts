import { createHash, randomUUID } from 'node:crypto'
import type {
  AcceptanceResult,
  AcceptanceSpec,
  Goal,
  GoalBudget,
  GoalContract,
  GoalContractInput,
  ProjectResource,
  ProjectResourceInput,
  WorkItemOwner
} from '../../shared/project-workspace-types'
import { isGoalRiskLevel } from '../../shared/project-workspace-types'
import { ProjectWorkspaceError } from './errors'

export function clone<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

export function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProjectWorkspaceError('invalid_input', `${label} is required`)
  }
  return value.trim()
}

export function optionalId(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return requiredId(value, label)
}

export function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProjectWorkspaceError('invalid_input', `${label} is required`)
  }
  return value.trim()
}

export function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ProjectWorkspaceError('invalid_input', `${label} must be text`)
  return value.trim()
}

export function timestamp(value: unknown, label: string, fallback = Date.now()): number {
  const candidate = value === undefined ? fallback : value
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0) {
    throw new ProjectWorkspaceError('invalid_input', `${label} must be a finite timestamp`)
  }
  return candidate
}

export function positiveInteger(value: unknown, label: string, fallback: number): number {
  const candidate = value === undefined ? fallback : value
  if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < 0) {
    throw new ProjectWorkspaceError('invalid_input', `${label} must be a non-negative integer`)
  }
  return candidate
}

export function finiteNumber(value: unknown, label: string, fallback: number): number {
  const candidate = value === undefined ? fallback : value
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
    throw new ProjectWorkspaceError('invalid_input', `${label} must be a finite number`)
  }
  return candidate
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)])
    )
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function redact(value: unknown, key = ''): unknown {
  if (/(?:secret|token|password|api[-_]?key|authorization|credential)/i.test(key)) {
    return '[REDACTED]'
  }
  if (Array.isArray(value)) return value.map((item) => redact(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, redact(item, name)])
    )
  }
  return value
}

function normalizeResource(input: ProjectResourceInput, index: number): ProjectResource {
  if (!input || typeof input !== 'object') {
    throw new ProjectWorkspaceError('invalid_input', `resource ${index} must be an object`)
  }
  const validKinds = new Set(['directory', 'file_set', 'repository', 'knowledge_base', 'connector', 'url', 'custom'])
  if (!validKinds.has(input.kind)) throw new ProjectWorkspaceError('invalid_input', `resource ${index} kind is invalid`)
  const path = optionalText(input.path, `resource ${index} path`)
  const uri = optionalText(input.uri, `resource ${index} uri`)
  if (!path && !uri && input.kind !== 'custom') {
    throw new ProjectWorkspaceError('invalid_input', `resource ${index} requires path or uri`)
  }
  return {
    id: optionalId(input.id, `resource ${index} id`) ?? randomUUID(),
    kind: input.kind,
    label: optionalText(input.label, `resource ${index} label`),
    path,
    uri,
    metadata: input.metadata ? redact(input.metadata) as Record<string, unknown> : undefined
  }
}

export function normalizeResources(inputs: ProjectResourceInput[] | undefined): ProjectResource[] {
  if (inputs === undefined) return []
  if (!Array.isArray(inputs)) throw new ProjectWorkspaceError('invalid_input', 'resources must be an array')
  const resources = inputs.map(normalizeResource)
  const ids = new Set<string>()
  for (const resource of resources) {
    if (ids.has(resource.id)) throw new ProjectWorkspaceError('invalid_input', `duplicate resource id ${resource.id}`)
    ids.add(resource.id)
  }
  return resources
}

function normalizeBudget(value: GoalBudget | undefined): GoalBudget | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') throw new ProjectWorkspaceError('invalid_input', 'goal budget must be an object')
  const budget: GoalBudget = {}
  if (value.amount !== undefined) {
    budget.amount = finiteNumber(value.amount, 'goal budget amount', 0)
    if (budget.amount < 0) throw new ProjectWorkspaceError('invalid_input', 'goal budget amount must be non-negative')
  }
  if (value.currency !== undefined) budget.currency = requiredText(value.currency, 'goal budget currency')
  if (value.maxTokens !== undefined) {
    budget.maxTokens = positiveInteger(value.maxTokens, 'goal budget maxTokens', 0)
    if (budget.maxTokens === 0) throw new ProjectWorkspaceError('invalid_input', 'goal budget maxTokens must be greater than zero')
  }
  if (value.maxRuns !== undefined) {
    budget.maxRuns = positiveInteger(value.maxRuns, 'goal budget maxRuns', 0)
    if (budget.maxRuns === 0) throw new ProjectWorkspaceError('invalid_input', 'goal budget maxRuns must be greater than zero')
  }
  return budget
}

export function normalizeAcceptanceSpecs(value: AcceptanceSpec[] | undefined, label: string): AcceptanceSpec[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ProjectWorkspaceError('invalid_input', `${label} must be an array`)
  const ids = new Set<string>()
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new ProjectWorkspaceError('invalid_input', `${label}[${index}] must be an object`)
    const id = requiredId(item.id, `${label}[${index}].id`)
    const criterion = requiredText(item.criterion, `${label}[${index}].criterion`)
    if (ids.has(id)) throw new ProjectWorkspaceError('invalid_input', `${label} contains duplicate id ${id}`)
    ids.add(id)
    return { id, criterion, required: item.required !== false }
  })
}

export function normalizeAcceptanceResult(value: AcceptanceResult | undefined): AcceptanceResult | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') throw new ProjectWorkspaceError('invalid_input', 'acceptance result must be an object')
  const status = value.status
  if (status !== 'pending' && status !== 'passed' && status !== 'failed' && status !== 'waived') {
    throw new ProjectWorkspaceError('invalid_input', 'acceptance result status is invalid')
  }
  if (!Array.isArray(value.evidenceRefs)) {
    throw new ProjectWorkspaceError('invalid_input', 'acceptance evidenceRefs must be an array')
  }
  const evidenceRefs = [...new Set(
    value.evidenceRefs.map((ref) => requiredId(ref, 'acceptance evidence ref'))
  )]
  if (status === 'passed' && evidenceRefs.length === 0) {
    throw new ProjectWorkspaceError('invalid_input', 'passed acceptance requires at least one evidence ref')
  }
  const waiverReason = optionalText(value.waiverReason, 'acceptance waiver reason')
  if (status === 'waived' && !waiverReason) {
    throw new ProjectWorkspaceError('invalid_input', 'waived acceptance requires a waiver reason')
  }
  return {
    status,
    evidenceRefs,
    verifiedBy: optionalText(value.verifiedBy, 'acceptance verifier'),
    verifiedAt: value.verifiedAt === undefined ? undefined : timestamp(value.verifiedAt, 'acceptance verifiedAt'),
    waiverReason
  }
}

function contractField<K extends keyof GoalContract>(
  source: GoalContractInput,
  fallback: Partial<GoalContract>,
  key: K,
  defaultValue: GoalContract[K]
): GoalContract[K] {
  const sourceValue = source[key]
  if (sourceValue !== undefined) return sourceValue as GoalContract[K]
  const fallbackValue = fallback[key]
  if (fallbackValue !== undefined) return fallbackValue as GoalContract[K]
  return defaultValue
}

function textList(value: string[], label: string): string[] {
  return value.map((item) => requiredText(item, label))
}

export function normalizeContract(input: GoalContractInput | undefined, fallback: Partial<GoalContract> = {}): GoalContract {
  const source = input ?? {}
  const objective = contractField(source, fallback, 'objective', '')
  const riskLevel = contractField(source, fallback, 'riskLevel', 'medium')
  if (!isGoalRiskLevel(riskLevel)) throw new ProjectWorkspaceError('invalid_input', 'goal riskLevel is invalid')
  const dueAt = contractField(source, fallback, 'dueAt', undefined)
  return {
    objective: requiredText(objective, 'goal objective'),
    background: optionalText(contractField(source, fallback, 'background', undefined), 'goal background'),
    constraints: textList(contractField(source, fallback, 'constraints', []), 'goal constraint'),
    successCriteria: textList(contractField(source, fallback, 'successCriteria', []), 'goal success criterion'),
    budget: normalizeBudget(contractField(source, fallback, 'budget', undefined)),
    dueAt: dueAt === undefined ? undefined : timestamp(dueAt, 'goal dueAt'),
    riskLevel,
    forbiddenActions: textList(contractField(source, fallback, 'forbiddenActions', []), 'goal forbidden action'),
    acceptance: normalizeAcceptanceSpecs(contractField(source, fallback, 'acceptance', []), 'goal acceptance')
  }
}

export function flattenContract(goal: Goal, contract: GoalContract): void {
  goal.objective = contract.objective
  goal.background = contract.background
  goal.constraints = clone(contract.constraints)
  goal.successCriteria = clone(contract.successCriteria)
  goal.budget = clone(contract.budget)
  goal.dueAt = contract.dueAt
  goal.riskLevel = contract.riskLevel
  goal.forbiddenActions = clone(contract.forbiddenActions)
  goal.acceptance = clone(contract.acceptance)
}

export function normalizeOwner(value: WorkItemOwner | string | null | undefined): WorkItemOwner | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return { type: 'digital_worker', id: requiredId(value, 'work item owner') }
  if (!value || typeof value !== 'object') throw new ProjectWorkspaceError('invalid_input', 'work item owner must be an object')
  if (value.type !== 'human' && value.type !== 'digital_worker') {
    throw new ProjectWorkspaceError('invalid_input', 'work item owner type is invalid')
  }
  return {
    type: value.type,
    id: requiredId(value.id, 'work item owner id'),
    displayName: optionalText(value.displayName, 'work item owner displayName')
  }
}
