import type {
  DigitalWorker,
  DigitalWorkerAssignment,
  DigitalWorkerRoleRecommendation,
  DigitalWorkerStatus,
  JsonObject,
  JsonValue,
  RoleTemplate,
  RoleTemplateInput
} from '../../../../shared/types'
import {
  WATERCOLOR_CHARACTER_ROLES,
  resolveWatercolorRole,
  type WatercolorCharacterRole,
  type WatercolorRoleResolution
} from '../../../../shared/watercolor-character'

export interface DigitalWorkerStudioWorkItem {
  id: string
  title: string
  projectId?: string
  status?: string
}

export interface DigitalWorkerStudioProject {
  id: string
  name: string
}

export interface DigitalWorkerStudioProps {
  active?: boolean
  projectId?: string
  projects?: readonly DigitalWorkerStudioProject[]
  workItems?: readonly DigitalWorkerStudioWorkItem[]
  assignedBy?: string
  className?: string
  onProjectChange?: (projectId: string | undefined) => void
}

export type StudioTab = 'team' | 'roles'

export const WORKER_STATUS_LABELS: Record<DigitalWorkerStatus, string> = {
  proposed: '待启用',
  active: '工作中',
  paused: '已暂停',
  retired: '已退休'
}

export const WATERCOLOR_ROLE_LABELS: Record<WatercolorCharacterRole, string> = {
  researcher: '研究',
  planner: '策划',
  writer: '写作',
  designer: '设计',
  developer: '开发',
  'review-test': '审查/测试',
  operations: '运营'
}

export const WATERCOLOR_ROLE_OPTIONS = WATERCOLOR_CHARACTER_ROLES.map((value) => ({
  value,
  label: WATERCOLOR_ROLE_LABELS[value]
}))

export function splitList(value: string): string[] {
  return [...new Set(value.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean))]
}

export function workerInitials(name: string): string {
  return Array.from(name.trim()).slice(0, 2).join('').toUpperCase() || 'AI'
}

export function roleForWorker(worker: DigitalWorker, roles: readonly RoleTemplate[]): RoleTemplate | undefined {
  return roles.find((role) => role.id === worker.roleTemplateId)
}

export function watercolorRoleForWorker(
  worker: Pick<DigitalWorker, 'id' | 'avatarProfile'>,
  role?: Pick<RoleTemplate, 'name' | 'purpose'>
): WatercolorRoleResolution {
  return resolveWatercolorRole(worker, role)
}

export function suggestedWatercolorRole(
  roleId: string,
  roles: readonly RoleTemplate[]
): WatercolorCharacterRole {
  const role = roles.find((entry) => entry.id === roleId)
  return resolveWatercolorRole({ id: roleId || 'new-worker', avatarProfile: {} }, role).role
}

export function projectOptions(
  projects: readonly DigitalWorkerStudioProject[],
  projectId: string | undefined,
  workers: readonly DigitalWorker[],
  assignments: readonly DigitalWorkerAssignment[],
  workItems: readonly DigitalWorkerStudioWorkItem[]
): DigitalWorkerStudioProject[] {
  const labels = new Map(projects.map((project) => [project.id, project.name]))
  const ids = new Set<string>()
  if (projectId) ids.add(projectId)
  for (const worker of workers) ids.add(worker.projectId)
  for (const assignment of assignments) ids.add(assignment.projectId)
  for (const workItem of workItems) if (workItem.projectId) ids.add(workItem.projectId)
  for (const project of projects) ids.add(project.id)
  return [...ids]
    .map((id) => ({ id, name: labels.get(id) || compactId(id) }))
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
}

export function permissionsFor(worker: DigitalWorker): string[] {
  return toolPolicyLabels(worker.toolPolicy)
}

export function toolPolicyLabels(policy: JsonObject): string[] {
  const permissions: string[] = []
  appendPermission(permissions, policy.workspaceRead, '读取工作区')
  appendPermission(permissions, policy.workspaceWrite, '修改工作区')
  appendPermission(permissions, policy.terminal, '终端操作')
  appendPermission(permissions, policy.browser, '浏览器操作')
  appendPermission(permissions, policy.network, '网络访问')
  const workspace = objectValue(policy.workspace)
  appendPermission(permissions, workspace?.read, '读取工作区')
  appendPermission(permissions, workspace?.write, '修改工作区')
  const unique = [...new Set(permissions)]
  if (unique.length === 0 && Object.keys(policy).length > 0) return ['自定义权限策略']
  return unique
}

export function recommendationDataLabels(recommendation: DigitalWorkerRoleRecommendation): string[] {
  const allowed = stringArrayValue(recommendation.dataScope.allowedDataClasses)
  const resources = stringArrayValue(recommendation.dataScope.allowedResourceIds)
  const labels = [
    ...(recommendation.dataScope.requireExplicitScope === true ? ['需显式范围'] : []),
    ...(allowed.length > 0 ? [`数据 ${allowed.join(', ')}`] : []),
    ...(resources.length > 0 ? [`Resource ${resources.length}`] : [])
  ]
  return labels.length > 0 ? labels : ['项目范围']
}

export function recommendationBudgetLabel(recommendation: DigitalWorkerRoleRecommendation): string {
  const amount = numberValue(recommendation.budgetPolicy.maxAmount)
  const currency = stringValue(recommendation.budgetPolicy.currency) ?? 'USD'
  const runs = numberValue(recommendation.budgetPolicy.maxRuns)
  const tokens = numberValue(recommendation.budgetPolicy.maxTokens)
  if (amount !== undefined) return `${currency} ${formatNumber(amount)} / Goal`
  if (runs !== undefined) return `${formatNumber(runs)} Runs / Goal`
  if (tokens !== undefined) return `${formatNumber(tokens)} Tokens / Goal`
  return '继承 Goal 预算'
}

export function roleTemplateInputForRecommendation(
  recommendation: DigitalWorkerRoleRecommendation
): RoleTemplateInput {
  return {
    name: recommendation.name,
    purpose: recommendation.purpose,
    instructions: [
      '方法',
      ...recommendation.methods.map((item) => `- ${item}`),
      '',
      '职责',
      ...recommendation.responsibilities.map((item) => `- ${item}`),
      '',
      '产出',
      ...recommendation.outputs.map((item) => `- ${item}`)
    ].join('\n'),
    capabilityRefs: recommendation.capabilityRefs,
    skillRefs: recommendation.skillRefs,
    toolPolicy: recommendation.toolPolicy,
    memoryPolicy: { scope: 'project', learning: 'user-confirmed' },
    routingRequirements: { providerNeutral: true },
    verificationPolicy: {
      acceptance: recommendation.acceptance,
      requiredOutputs: recommendation.outputs
    },
    escalationPolicy: recommendation.escalationPolicy,
    source: 'system'
  }
}

export function workerAllowedDataClasses(worker: DigitalWorker): string[] {
  return stringArrayValue(worker.dataScope.allowedDataClasses)
}

export function workerDeniedDataClasses(worker: DigitalWorker): string[] {
  return stringArrayValue(worker.dataScope.deniedDataClasses)
}

export function workerAllowedResourceIds(worker: DigitalWorker): string[] {
  return stringArrayValue(worker.dataScope.allowedResourceIds)
}

export function dataScopeLabels(worker: DigitalWorker): string[] {
  const allowed = workerAllowedDataClasses(worker)
  const denied = workerDeniedDataClasses(worker)
  const resources = workerAllowedResourceIds(worker)
  const labels: string[] = []
  if (worker.dataScope.requireExplicitScope === true) labels.push('需显式声明')
  if (allowed.length > 0) labels.push(`允许: ${allowed.join(', ')}`)
  if (denied.length > 0) labels.push(`禁止: ${denied.join(', ')}`)
  if (resources.length > 0) labels.push(`Resource: ${resources.join(', ')}`)
  return labels.length > 0 ? labels : ['未限制']
}

export function acceptancePolicyLabels(worker: DigitalWorker): string[] {
  const minimumEvidence = numberValue(worker.acceptancePolicy.minimumEvidenceCount) ?? 1
  return [
    `Evidence >= ${minimumEvidence}`,
    worker.acceptancePolicy.requireUserApproval === true ? '需用户确认' : '按规则验收'
  ]
}

export function escalationPolicyLabels(worker: DigitalWorker): string[] {
  const target = stringValue(worker.escalationPolicy.target) ?? '未设置目标'
  const failures = numberValue(worker.escalationPolicy.afterFailures)
  return [target, failures === undefined ? '未设置阈值' : `${failures} 次失败后升级`]
}

export function budgetLabel(policy: JsonObject): string {
  const monthlyUsd = numberValue(policy.monthlyUsd)
  if (monthlyUsd !== undefined) return `$${formatNumber(monthlyUsd)} / 月`
  const dailyUsd = numberValue(policy.dailyUsd)
  if (dailyUsd !== undefined) return `$${formatNumber(dailyUsd)} / 日`
  const monthly = numberValue(policy.monthlyLimit)
  if (monthly !== undefined) return `${formatNumber(monthly)} / 月`
  const daily = numberValue(policy.dailyLimit)
  if (daily !== undefined) return `${formatNumber(daily)} / 日`
  return Object.keys(policy).length > 0 ? '自定义' : '未设置'
}

export function performanceProfileLabels(worker: DigitalWorker): string[] {
  const profile = worker.performanceProfile
  if (numberValue(profile.schemaVersion) !== 1) return ['暂无绩效样本']
  const totalRuns = numberValue(profile.totalRuns) ?? 0
  const acceptanceDecisions = numberValue(profile.acceptanceDecisions) ?? 0
  const acceptanceRate = numberValue(profile.acceptancePassRate) ?? 0
  const reliability = numberValue(profile.reliability) ?? 0
  const reworkRuns = numberValue(profile.reworkRuns) ?? 0
  const costUsd = numberValue(profile.costUsd) ?? 0
  const costCoverage = typeof profile.costCoverage === 'string' ? profile.costCoverage : 'complete'
  const unpricedAttempts = numberValue(profile.unpricedAttempts) ?? 0
  const averageDurationMs = numberValue(profile.averageDurationMs) ?? 0
  return [
    `Run ${formatNumber(totalRuns)}`,
    acceptanceDecisions > 0 ? `Acceptance ${Math.round(acceptanceRate * 100)}%` : 'Acceptance 暂无',
    `可靠性 ${Math.round(reliability * 100)}%`,
    `返工 ${formatNumber(reworkRuns)}`,
    costCoverage === 'complete'
      ? `成本 $${formatNumber(costUsd)}`
      : `成本待核验 ${formatNumber(unpricedAttempts)} 次`,
    `平均 ${durationLabel(averageDurationMs)}`
  ]
}

export function assignmentsForWorker(
  workerId: string,
  assignments: readonly DigitalWorkerAssignment[]
): DigitalWorkerAssignment[] {
  return assignments.filter(
    (assignment) =>
      assignment.status === 'active' &&
      assignment.assigneeKind === 'digital_worker' &&
      assignment.assigneeId === workerId
  )
}

export function workItemTitle(
  workItemId: string,
  workItems: readonly DigitalWorkerStudioWorkItem[]
): string {
  return workItems.find((item) => item.id === workItemId)?.title || compactId(workItemId)
}

export function compactId(id: string): string {
  if (id.length <= 24) return id
  return `${id.slice(0, 11)}...${id.slice(-8)}`
}

export function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message
  if (typeof cause === 'string' && cause.trim()) return cause
  return '操作失败，请重试。'
}

function appendPermission(target: string[], value: JsonValue | undefined, label: string): void {
  if (value === true) target.push(label)
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringArrayValue(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)
}

function durationLabel(value: number): string {
  if (value < 1_000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${formatNumber(value / 1_000)}s`
  return `${formatNumber(value / 60_000)}m`
}
