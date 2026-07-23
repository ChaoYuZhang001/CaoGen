import type {
  DigitalWorker,
  DigitalWorkerAssignment,
  DigitalWorkerStatus,
  JsonObject,
  JsonValue,
  RoleTemplate
} from '../../../../shared/types'

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

export function splitList(value: string): string[] {
  return [...new Set(value.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean))]
}

export function workerInitials(name: string): string {
  return Array.from(name.trim()).slice(0, 2).join('').toUpperCase() || 'AI'
}

export function roleForWorker(worker: DigitalWorker, roles: readonly RoleTemplate[]): RoleTemplate | undefined {
  return roles.find((role) => role.id === worker.roleTemplateId)
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
  const policy = worker.toolPolicy
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
