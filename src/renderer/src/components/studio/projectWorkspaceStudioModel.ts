import type {
  AcceptanceResult,
  AcceptanceResultStatus,
  AcceptanceSpec,
  Goal,
  GoalInput,
  GoalPatch,
  GoalRiskLevel,
  GoalStatus,
  ProjectResource,
  ProjectResourceInput,
  ProjectWorkspaceKind,
  ProjectWorkspaceStatus,
  WorkItemInput,
  WorkItem,
  WorkItemReorderPlacement,
  WorkItemStatus,
  WorkItemType
} from '../../../../shared/types'

export type StudioView = 'list' | 'board'
export type StudioCreateForm = 'project' | 'goal' | 'workItem' | null
export type StudioMutationKind = Exclude<StudioCreateForm, null>
export type ProjectLifecyclePanel = 'edit' | 'resource' | null
export type ProjectLifecycleMutation = 'update' | 'resource' | 'archive' | 'restore' | 'export' | 'delete' | 'purge'
export type ResourceDraftKind = 'directory' | 'file_set' | 'repository' | 'connector'

export type WorkItemControlAction =
  | { kind: 'transition'; status: WorkItemStatus }
  | { kind: 'lease'; operation: 'acquire' | 'renew' | 'release' }

export type GoalControlAction =
  | { kind: 'transition'; status: GoalStatus }
  | { kind: 'archive' }
  | { kind: 'restore' }

export type WorkItemOwnerFilter = 'all' | 'unassigned' | 'human' | 'digital_worker'

export interface WorkItemFilters {
  query: string
  status: 'all' | WorkItemStatus
  goalId: 'all' | 'none' | string
  owner: WorkItemOwnerFilter
}

export interface WorkItemReorderAction {
  targetId: string
  placement: WorkItemReorderPlacement
}

export interface ProjectEditDraft {
  name: string
  kind: ProjectWorkspaceKind
  ownerId: string
  rulesRef: string
}

export interface ProjectResourceDraft {
  kind: ResourceDraftKind
  label: string
  location: string
}

export interface GoalDraft {
  title: string
  objective: string
  background: string
  constraints: string
  successCriteria: string
  acceptance: string
  forbiddenActions: string
  riskLevel: GoalRiskLevel
  dueDate: string
  budgetAmount: string
  budgetCurrency: string
  budgetRuns: string
  budgetTokens: string
}

export interface WorkItemDraft {
  title: string
  description: string
  goalId: string
  type: WorkItemType
  priority: string
  ownerType: 'human' | 'digital_worker'
  ownerId: string
  ownerName: string
  dueDate: string
  parentId: string
  dependencyIds: string[]
  acceptance: string
}

export interface AcceptancePresentation {
  status: AcceptanceResultStatus | 'unset'
  label: string
}

export const TEXT = {
  title: '项目工作台',
  project: '项目',
  projects: '项目',
  selectProject: '选择项目',
  createProject: '新建项目',
  createGoal: '新建目标',
  createWorkItem: '新建工作项',
  refresh: '刷新',
  refreshing: '刷新中...',
  creating: '创建中...',
  cancel: '取消',
  closeForm: '关闭创建表单',
  projectName: '项目名称',
  projectKind: '项目类型',
  projectCreated: '项目已创建',
  goalCreated: '目标已创建',
  goalUpdated: '目标契约已更新',
  workItemCreated: '工作项已创建',
  createProjectSubmit: '创建项目',
  createGoalSubmit: '创建目标',
  editGoal: '编辑目标',
  editGoalTitle: '编辑目标契约',
  saveGoal: '保存目标',
  archiveGoal: '归档目标',
  restoreGoal: '恢复目标',
  goalControls: '目标控制',
  goalControlFailed: '目标操作失败',
  createWorkItemSubmit: '创建工作项',
  noProjects: '还没有项目',
  noGoals: '还没有目标',
  noWorkItems: '还没有工作项',
  noMatchingWorkItems: '没有符合筛选条件的工作项',
  loadingProjects: '正在载入项目...',
  loadingContents: '正在载入项目内容...',
  retry: '重试',
  goals: '目标契约',
  workItems: '工作项',
  list: '列表',
  board: '看板',
  switchWorkItemView: '切换工作项视图',
  filterWorkItems: '筛选工作项',
  searchWorkItems: '搜索名称、说明、负责人或 ID',
  allStatuses: '全部状态',
  allGoals: '全部目标',
  allOwners: '全部负责人',
  unassignedOwner: '未分配',
  humanOwner: '人员负责人',
  digitalWorkerOwner: '数字员工负责人',
  clearFilters: '清除筛选',
  filteredItemCount: (visible: number, total: number) => `${visible} / ${total} 项`,
  moveWorkItemUp: '上移工作项',
  moveWorkItemDown: '下移工作项',
  reorderFailed: '重排失败',
  goalTitle: '目标名称',
  objective: '目标',
  background: '背景',
  constraints: '限制（每行一项）',
  successCriteria: '成功标准（每行一项）',
  acceptanceCriteria: '验收标准（每行一项）',
  forbiddenActions: '禁止事项（每行一项）',
  risk: '风险等级',
  dueDate: '截止日期',
  budgetAmount: '预算金额',
  budgetCurrency: '币种',
  budgetRuns: '最多执行次数',
  budgetTokens: '最多 Token 数',
  workItemTitle: '工作项名称',
  description: '说明',
  linkedGoal: '所属目标',
  noLinkedGoal: '不关联目标',
  workItemType: '类型',
  priority: '优先级',
  ownerType: '负责人类型',
  ownerHuman: '人员',
  ownerDigitalWorker: '数字员工',
  ownerId: '负责人标识',
  ownerName: '负责人名称',
  parentWorkItem: '上级工作项',
  noParent: '无上级工作项',
  dependencies: '前置工作项',
  noDependencies: '暂无可选工作项',
  status: '状态',
  acceptance: '验收',
  owner: '负责人',
  goal: '目标',
  type: '类型',
  due: '截止',
  updated: '更新',
  untitledOwner: '未分配',
  noDueDate: '未设置',
  goalDetails: '查看目标契约',
  acceptanceUnset: '未设验收',
  acceptancePending: '待验收',
  acceptancePassed: '已通过',
  acceptanceFailed: '未通过',
  acceptanceWaived: '已豁免',
  workItemControls: '工作项控制',
  transitionTo: (status: string) => `转为${status}`,
  acquireLease: '获取执行租约',
  renewLease: '续租',
  releaseLease: '释放租约',
  leaseActive: '租约有效',
  leaseMissing: '未持有租约',
  controlFailed: '控制操作失败',
  acceptanceItems: (count: number) => `${count} 项`,
  itemCount: (count: number) => `${count} 项`,
  projectSummary: (goals: number, workItems: number) => `${goals} 个目标 · ${workItems} 个工作项`,
  projectKindSummary: (kind: string) => `${kind}项目`,
  projectSettings: '项目设置',
  projectStatus: '项目状态',
  editProject: '编辑项目',
  saveProject: '保存项目',
  ownerIdOptional: '项目负责人标识（可选）',
  rulesRefOptional: '规则引用（可选）',
  resources: '关联资源',
  addResource: '关联资源',
  addResourceSubmit: '添加资源',
  resourceKind: '资源类型',
  resourceLabel: '资源名称（可选）',
  resourceLocation: '路径或地址',
  resourceDirectory: '本地目录',
  resourceFileSet: '文件集合',
  resourceRepository: '本地仓库',
  resourceConnector: '连接器',
  noResources: '暂未关联资源',
  removeResource: (label: string) => `移除资源：${label}`,
  projectUpdated: '项目信息已更新',
  resourceAdded: '资源已关联',
  resourceRemoved: '资源已移除',
  archiveProject: '归档',
  restoreProject: '恢复',
  exportManifest: '导出清单',
  manifestTitle: '项目导出清单',
  manifestDigest: 'SHA-256 摘要',
  copyManifest: '复制 JSON',
  downloadManifest: '下载 JSON',
  closeManifest: '关闭清单',
  manifestCopied: '清单 JSON 已复制',
  projectArchived: '项目已归档',
  projectRestored: '项目已恢复',
  deleteProject: '删除项目',
  purgeProject: '永久删除',
  deleteProjectTitle: '确认删除项目',
  purgeProjectTitle: '确认永久删除项目',
  deleteProjectHint: '项目将进入已删除状态，可稍后恢复。关联的本地目录、仓库和外部数据不会被删除。',
  purgeProjectHint: '项目及其 CaoGen 下属记录将被永久移除，且无法恢复。关联的本地目录、仓库和外部数据不会被删除。',
  confirmProjectName: (name: string) => `输入“${name}”以确认`,
  confirmDelete: '确认删除',
  confirmPurge: '确认永久删除',
  archivedProjectNotice: '此项目已归档。恢复后才能继续创建或编辑项目内容。',
  deletedProjectNotice: '此项目已软删除。可恢复项目，或永久删除 CaoGen 中的项目记录。',
  unknownError: '操作未完成，请重试'
} as const

export const PROJECT_KIND_OPTIONS: ReadonlyArray<{ value: ProjectWorkspaceKind; label: string }> = [
  { value: 'personal', label: '个人' },
  { value: 'office', label: '办公' },
  { value: 'education', label: '教育' },
  { value: 'research', label: '研究' },
  { value: 'software', label: '软件' },
  { value: 'opc', label: '一人公司' },
  { value: 'custom', label: '自定义' }
]

export const PROJECT_STATUS_LABELS: Record<ProjectWorkspaceStatus, string> = {
  active: '进行中',
  archived: '已归档',
  deleted: '已删除'
}

export const PROJECT_RESOURCE_OPTIONS: ReadonlyArray<{ value: ResourceDraftKind; label: string }> = [
  { value: 'directory', label: TEXT.resourceDirectory },
  { value: 'file_set', label: TEXT.resourceFileSet },
  { value: 'repository', label: TEXT.resourceRepository },
  { value: 'connector', label: TEXT.resourceConnector }
]

export const GOAL_RISK_OPTIONS: ReadonlyArray<{ value: GoalRiskLevel; label: string }> = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'critical', label: '严重' }
]

export const WORK_ITEM_TYPE_OPTIONS: ReadonlyArray<{ value: WorkItemType; label: string }> = [
  { value: 'research', label: '调研' },
  { value: 'analysis', label: '分析' },
  { value: 'planning', label: '规划' },
  { value: 'writing', label: '写作' },
  { value: 'design', label: '设计' },
  { value: 'coding', label: '开发' },
  { value: 'review', label: '审查' },
  { value: 'testing', label: '测试' },
  { value: 'documentation', label: '文档' },
  { value: 'operations', label: '运营' },
  { value: 'delivery', label: '交付' },
  { value: 'custom', label: '其他' }
]

export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  draft: '草稿',
  planned: '已规划',
  running: '进行中',
  waiting_approval: '待批准',
  blocked: '受阻',
  verifying: '验收中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  archived: '已归档'
}

export const WORK_ITEM_STATUS_LABELS: Record<WorkItemStatus, string> = {
  backlog: '待安排',
  ready: '已就绪',
  running: '进行中',
  waiting_approval: '待批准',
  blocked: '受阻',
  verifying: '验收中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消'
}

export const WORK_ITEM_STATUSES = Object.keys(WORK_ITEM_STATUS_LABELS) as WorkItemStatus[]

export const GOAL_TRANSITIONS: Record<GoalStatus, readonly GoalStatus[]> = {
  draft: ['planned', 'cancelled'],
  planned: ['running', 'cancelled'],
  running: ['waiting_approval', 'blocked', 'verifying', 'cancelled'],
  waiting_approval: ['running', 'blocked'],
  blocked: ['running', 'failed', 'cancelled'],
  verifying: ['completed', 'running', 'blocked', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
  archived: []
}

export const DEFAULT_WORK_ITEM_FILTERS: WorkItemFilters = {
  query: '',
  status: 'all',
  goalId: 'all',
  owner: 'all'
}

/** Keep the renderer action surface aligned with the main-process state machine. */
export const WORK_ITEM_TRANSITIONS: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
  backlog: ['ready', 'cancelled'],
  ready: ['running', 'cancelled'],
  running: ['waiting_approval', 'blocked', 'verifying', 'cancelled'],
  waiting_approval: ['running', 'blocked'],
  blocked: ['ready', 'failed', 'cancelled'],
  verifying: ['done', 'failed', 'ready'],
  done: [],
  failed: [],
  cancelled: []
}

export const EMPTY_GOAL_DRAFT: GoalDraft = {
  title: '', objective: '', background: '', constraints: '', successCriteria: '', acceptance: '',
  forbiddenActions: '', riskLevel: 'medium', dueDate: '', budgetAmount: '', budgetCurrency: 'CNY', budgetRuns: '', budgetTokens: ''
}

export const EMPTY_WORK_ITEM_DRAFT: WorkItemDraft = {
  title: '', description: '', goalId: '', type: 'custom', priority: '0', ownerType: 'human',
  ownerId: '', ownerName: '', dueDate: '', parentId: '', dependencyIds: [], acceptance: ''
}

export function goalInputFromDraft(projectId: string, draft: GoalDraft): GoalInput {
  return {
    projectId,
    title: draft.title.trim(),
    contract: goalContractFromDraft(draft)
  }
}

export function goalDraftFromGoal(goal: Goal): GoalDraft {
  return {
    title: goal.title,
    objective: goal.objective,
    background: goal.background ?? '',
    constraints: goal.constraints.join('\n'),
    successCriteria: goal.successCriteria.join('\n'),
    acceptance: goal.acceptance.map((item) => item.criterion).join('\n'),
    forbiddenActions: goal.forbiddenActions.join('\n'),
    riskLevel: goal.riskLevel,
    dueDate: dateInputValue(goal.dueAt),
    budgetAmount: goal.budget?.amount === undefined ? '' : String(goal.budget.amount),
    budgetCurrency: goal.budget?.currency ?? 'CNY',
    budgetRuns: goal.budget?.maxRuns === undefined ? '' : String(goal.budget.maxRuns),
    budgetTokens: goal.budget?.maxTokens === undefined ? '' : String(goal.budget.maxTokens)
  }
}

export function goalPatchFromDraft(goal: Goal, draft: GoalDraft): GoalPatch {
  return {
    title: draft.title.trim(),
    contract: goalContractFromDraft(draft, goal.acceptance)
  }
}

function goalContractFromDraft(draft: GoalDraft, existingAcceptance: Goal['acceptance'] = []): NonNullable<GoalInput['contract']> {
  const budgetAmount = optionalNumber(draft.budgetAmount)
  const maxRuns = optionalNumber(draft.budgetRuns)
  const maxTokens = optionalNumber(draft.budgetTokens)
  const budget = budgetAmount === undefined && maxRuns === undefined && maxTokens === undefined
    ? undefined
    : { amount: budgetAmount, currency: draft.budgetCurrency.trim() || undefined, maxRuns, maxTokens }
  return {
    objective: draft.objective.trim(),
    background: optionalText(draft.background),
    constraints: splitLines(draft.constraints),
    successCriteria: splitLines(draft.successCriteria),
    acceptance: acceptanceSpecs(draft.acceptance, 'goal', existingAcceptance),
    forbiddenActions: splitLines(draft.forbiddenActions),
    riskLevel: draft.riskLevel,
    dueAt: dateToTimestamp(draft.dueDate),
    budget
  }
}

export function workItemInputFromDraft(projectId: string, draft: WorkItemDraft): WorkItemInput {
  const ownerId = draft.ownerId.trim()
  return {
    projectId,
    title: draft.title.trim(),
    description: optionalText(draft.description),
    goalId: optionalText(draft.goalId),
    type: draft.type,
    priority: Number(draft.priority) || 0,
    owner: ownerId ? { type: draft.ownerType, id: ownerId, displayName: optionalText(draft.ownerName) } : undefined,
    dueAt: dateToTimestamp(draft.dueDate),
    parentId: optionalText(draft.parentId),
    dependencyIds: draft.dependencyIds,
    acceptanceSpec: splitLines(draft.acceptance).length > 0
      ? acceptanceSpecs(draft.acceptance, 'work-item')
      : undefined
  }
}

export function acceptancePresentation(
  specificationCount: number,
  result?: AcceptanceResult
): AcceptancePresentation {
  if (result?.status === 'passed') return { status: 'passed', label: TEXT.acceptancePassed }
  if (result?.status === 'failed') return { status: 'failed', label: TEXT.acceptanceFailed }
  if (result?.status === 'waived') return { status: 'waived', label: TEXT.acceptanceWaived }
  if (result?.status === 'pending' || specificationCount > 0) {
    return { status: 'pending', label: `${TEXT.acceptancePending} · ${TEXT.acceptanceItems(specificationCount)}` }
  }
  return { status: 'unset', label: TEXT.acceptanceUnset }
}

export function projectKindLabel(kind: ProjectWorkspaceKind): string {
  return PROJECT_KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind
}

export function projectEditDraft(project: {
  name: string
  kind: ProjectWorkspaceKind
  ownerId?: string
  rulesRef?: string
}): ProjectEditDraft {
  return {
    name: project.name,
    kind: project.kind,
    ownerId: project.ownerId ?? '',
    rulesRef: project.rulesRef ?? ''
  }
}

export function resourceInputFromDraft(draft: ProjectResourceDraft): ProjectResourceInput {
  const label = optionalText(draft.label)
  const location = draft.location.trim()
  if (draft.kind === 'connector') return { kind: 'connector', label, uri: location }
  return { kind: draft.kind, label, path: location }
}

export function resourceKindLabel(resource: ProjectResource): string {
  if (resource.kind === 'directory' && resource.metadata?.resourceType === 'repository') {
    return TEXT.resourceRepository
  }
  if (resource.kind === 'repository') return TEXT.resourceRepository
  if (resource.kind === 'directory') return TEXT.resourceDirectory
  if (resource.kind === 'file_set') return TEXT.resourceFileSet
  if (resource.kind === 'connector') return TEXT.resourceConnector
  if (resource.kind === 'knowledge_base') return '知识库'
  if (resource.kind === 'url') return '网址'
  return '其他'
}

export function resourceLocation(resource: ProjectResource): string {
  return resource.path ?? resource.uri ?? ''
}

export function workItemTypeLabel(type: WorkItemType): string {
  return WORK_ITEM_TYPE_OPTIONS.find((option) => option.value === type)?.label ?? type
}

export function compareWorkItemsByBoardOrder(left: WorkItem, right: WorkItem): number {
  const leftOrder = Number.isFinite(left.boardOrder) ? left.boardOrder! : left.createdAt
  const rightOrder = Number.isFinite(right.boardOrder) ? right.boardOrder! : right.createdAt
  if (leftOrder !== rightOrder) return leftOrder - rightOrder
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
  return left.id.localeCompare(right.id)
}

export function projectWorkItems(items: readonly WorkItem[], filters: WorkItemFilters): WorkItem[] {
  const query = filters.query.trim().toLocaleLowerCase()
  return items
    .filter((item) => filters.status === 'all' || item.status === filters.status)
    .filter((item) => filters.goalId === 'all' || (filters.goalId === 'none' ? !item.goalId : item.goalId === filters.goalId))
    .filter((item) => filters.owner === 'all' || (filters.owner === 'unassigned' ? !item.owner : item.owner?.type === filters.owner))
    .filter((item) => {
      if (!query) return true
      return [item.id, item.title, item.description, item.owner?.id, item.owner?.displayName]
        .some((value) => value?.toLocaleLowerCase().includes(query))
    })
    .sort(compareWorkItemsByBoardOrder)
}

export function formatDate(timestamp?: number): string {
  if (timestamp === undefined) return TEXT.noDueDate
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(timestamp)
}

export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : typeof error === 'string' ? error.trim() : ''
  const normalized = message.toLowerCase()
  if (normalized.includes('stale_revision')) return '内容已被更新，请刷新后再试'
  if (normalized.includes('cross_project')) return '所选内容不属于当前项目'
  if (normalized.includes('contract_violation')) return '工作项与目标约定不一致'
  if (normalized.includes('not_found')) return '没有找到所选内容，请刷新后再试'
  if (normalized.includes('invalid_input')) return '请检查填写内容后再试'
  if (normalized.includes('already_exists')) return '已经存在相同内容'
  if (message) return message
  return TEXT.unknownError
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
}

function acceptanceSpecs(value: string, prefix: string, existing: AcceptanceSpec[] = []): AcceptanceSpec[] {
  const seed = globalThis.crypto.randomUUID()
  return splitLines(value).map((criterion, index) => ({
    id: existing[index]?.id ?? `${prefix}-${seed}-${index + 1}`,
    criterion,
    required: existing[index]?.required !== false
  }))
}

function optionalText(value: string): string | undefined {
  const normalized = value.trim()
  return normalized || undefined
}

function optionalNumber(value: string): number | undefined {
  if (!value.trim()) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function dateToTimestamp(value: string): number | undefined {
  if (!value) return undefined
  const parsed = new Date(`${value}T23:59:59`)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.getTime()
}

function dateInputValue(timestamp?: number): string {
  if (timestamp === undefined) return ''
  const date = new Date(timestamp)
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
