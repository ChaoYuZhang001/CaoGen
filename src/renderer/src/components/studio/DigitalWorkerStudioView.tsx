import { useId, useRef } from 'react'
import type { DigitalWorker, DigitalWorkerAssignment, DigitalWorkerStatus, RoleTemplate } from '../../../../shared/types'
import { RoleLibrary, WorkerRoster } from './DigitalWorkerCards'
import { AssignmentForm, HireWorkerForm, RoleTemplateForm } from './DigitalWorkerForms'
import type {
  DigitalWorkerStudioProject,
  DigitalWorkerStudioWorkItem,
  StudioTab
} from './digital-worker-studio-model'
import { WORKER_STATUS_LABELS } from './digital-worker-studio-model'
import type { DigitalWorkerStudioState } from './useDigitalWorkerStudio'

const STATUS_FILTERS: Array<{ value: '' | DigitalWorkerStatus; label: string }> = [
  { value: '', label: '全部状态' },
  ...Object.entries(WORKER_STATUS_LABELS).map(([value, label]) => ({ value: value as DigitalWorkerStatus, label }))
]

export interface DigitalWorkerStudioViewProps {
  studio: DigitalWorkerStudioState
  className: string
  assignedBy: string
  selectedProjectId: string
  statusFilter: '' | DigitalWorkerStatus
  activeTab: StudioTab
  hireOpen: boolean
  hireRoleId?: string
  roleEditorOpen: boolean
  assignmentOpen: boolean
  assignmentWorkerId?: string
  projects: readonly DigitalWorkerStudioProject[]
  filteredWorkers: readonly DigitalWorker[]
  projectWorkers: readonly DigitalWorker[]
  assignments: readonly DigitalWorkerAssignment[]
  workItems: readonly DigitalWorkerStudioWorkItem[]
  onSelectProject: (projectId: string) => void
  onStatusFilter: (status: '' | DigitalWorkerStatus) => void
  onTab: (tab: StudioTab) => void
  onOpenHire: (roleId?: string) => void
  onCloseHire: () => void
  onRoleEditor: (open: boolean) => void
  onOpenAssignment: (workerId: string) => void
  onCloseAssignment: () => void
}

export function DigitalWorkerStudioView(props: DigitalWorkerStudioViewProps): React.JSX.Element {
  return (
    <section
      className={`digital-worker-studio ${props.className}`.trim()}
      aria-labelledby="digital-worker-studio-title"
      data-studio-surface="digital-workers"
      data-project-id={props.selectedProjectId || undefined}
    >
      <StudioHeader {...props} />
      <StudioSummary {...props} />
      <StudioAlerts studio={props.studio} />
      <StudioEditors {...props} />
      <StudioTabbedContent {...props} />
    </section>
  )
}

function StudioHeader(props: DigitalWorkerStudioViewProps): React.JSX.Element {
  const { studio, projects, selectedProjectId, statusFilter } = props
  const hireDisabled = !selectedProjectId || studio.roles.length === 0 || studio.loading
  const hireTitle = !selectedProjectId
    ? '请先选择项目'
    : studio.roles.length === 0 ? '请先创建岗位模板' : undefined
  return (
    <header className="dws-header">
      <div>
        <span className="dws-eyebrow">STUDIO</span>
        <h2 id="digital-worker-studio-title">数字员工与团队</h2>
      </div>
      <div className="dws-toolbar">
        <label className="dws-filter">
          <span>项目</span>
          <select value={selectedProjectId} onChange={(event) => props.onSelectProject(event.target.value)} aria-label="按项目筛选数字员工">
            <option value="">全部项目</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <label className="dws-filter">
          <span>状态</span>
          <select value={statusFilter} onChange={(event) => props.onStatusFilter(event.target.value as '' | DigitalWorkerStatus)} aria-label="按状态筛选数字员工">
            {STATUS_FILTERS.map((status) => <option key={status.value || 'all'} value={status.value}>{status.label}</option>)}
          </select>
        </label>
        <button type="button" className="dws-button" onClick={() => void studio.refresh()} disabled={studio.loading || studio.busyKey !== null} data-dws-action="refresh">
          {studio.loading ? '刷新中...' : '刷新'}
        </button>
        <button type="button" className="dws-button dws-button-primary" onClick={() => props.onOpenHire()} disabled={hireDisabled} title={hireTitle} data-dws-action="hire">
          招聘员工
        </button>
      </div>
    </header>
  )
}

function StudioSummary(props: DigitalWorkerStudioViewProps): React.JSX.Element {
  const { projectWorkers, assignments, studio } = props
  const active = projectWorkers.filter((worker) => worker.status === 'active').length
  const paused = projectWorkers.filter((worker) => worker.status === 'paused').length
  const assigned = assignments.filter((item) => item.assigneeKind === 'digital_worker').length
  return (
    <div className="dws-summary" aria-live="polite" aria-busy={studio.loading}>
      <div><span>团队规模</span><strong>{projectWorkers.length}</strong></div>
      <div><span>工作中</span><strong>{active}</strong></div>
      <div><span>已暂停</span><strong>{paused}</strong></div>
      <div><span>任务分配</span><strong>{assigned}</strong></div>
    </div>
  )
}

function StudioAlerts({ studio }: { studio: DigitalWorkerStudioState }): React.JSX.Element {
  return (
    <>
      {studio.error && (
        <div className="dws-notice dws-notice-error" role="alert">
          <span>{studio.error}</span>
          <button type="button" className="dws-button dws-button-quiet" onClick={studio.clearError}>关闭</button>
        </div>
      )}
      <div className="dws-sr-only" role="status" aria-live="polite">{studio.notice}</div>
    </>
  )
}

function StudioEditors(props: DigitalWorkerStudioViewProps): React.JSX.Element {
  const { studio, selectedProjectId } = props
  return (
    <>
      {props.hireOpen && selectedProjectId && (
        <HireWorkerForm
          key={`${selectedProjectId}:${props.hireRoleId || ''}`}
          projectId={selectedProjectId}
          roles={studio.roles}
          initialRoleId={props.hireRoleId}
          busy={studio.busyKey === 'worker:create'}
          onCancel={props.onCloseHire}
          onSubmit={(input, activate) => studio.createWorker({ input, activate })}
        />
      )}
      {props.assignmentOpen && selectedProjectId && (
        <AssignmentForm
          key={`${selectedProjectId}:${props.assignmentWorkerId || ''}`}
          projectId={selectedProjectId}
          workItems={props.workItems}
          workers={props.projectWorkers}
          assignments={props.assignments}
          initialWorkerId={props.assignmentWorkerId}
          busy={studio.busyKey?.startsWith('assignment:') === true}
          onCancel={props.onCloseAssignment}
          onSubmit={(workItemId, workerId, scope, reason) => studio.assignWorker({
            projectId: selectedProjectId,
            workItemId,
            workerId,
            assignedBy: props.assignedBy.trim() || 'user',
            scope,
            reason
          })}
        />
      )}
    </>
  )
}

function StudioTabbedContent(props: DigitalWorkerStudioViewProps): React.JSX.Element {
  const baseId = useId()
  const teamRef = useRef<HTMLButtonElement>(null)
  const rolesRef = useRef<HTMLButtonElement>(null)
  const choose = (tab: StudioTab): void => {
    props.onTab(tab)
    if (tab === 'team') teamRef.current?.focus()
    else rolesRef.current?.focus()
  }
  const handleKey = (event: React.KeyboardEvent, current: StudioTab): void => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') choose(current === 'team' ? 'roles' : 'team')
    else if (event.key === 'Home') choose('team')
    else if (event.key === 'End') choose('roles')
    else return
    event.preventDefault()
  }
  const teamTabId = `${baseId}-team-tab`
  const rolesTabId = `${baseId}-roles-tab`
  return (
    <>
      <div className="dws-tabs" role="tablist" aria-label="数字员工 Studio 视图">
        <button ref={teamRef} type="button" role="tab" id={teamTabId} aria-selected={props.activeTab === 'team'} aria-controls={`${baseId}-team-panel`} tabIndex={props.activeTab === 'team' ? 0 : -1} onClick={() => props.onTab('team')} onKeyDown={(event) => handleKey(event, 'team')}>
          团队 <span>{props.projectWorkers.length}</span>
        </button>
        <button ref={rolesRef} type="button" role="tab" id={rolesTabId} aria-selected={props.activeTab === 'roles'} aria-controls={`${baseId}-roles-panel`} tabIndex={props.activeTab === 'roles' ? 0 : -1} onClick={() => props.onTab('roles')} onKeyDown={(event) => handleKey(event, 'roles')}>
          岗位库 <span>{props.studio.roles.length}</span>
        </button>
      </div>
      <StudioPanel {...props} baseId={baseId} teamTabId={teamTabId} rolesTabId={rolesTabId} />
    </>
  )
}

function StudioPanel(props: DigitalWorkerStudioViewProps & { baseId: string; teamTabId: string; rolesTabId: string }): React.JSX.Element {
  const { studio } = props
  if (studio.loading && studio.workers.length === 0 && studio.roles.length === 0) {
    return <div className="dws-loading" role="status"><span />正在加载团队...</div>
  }
  if (props.activeTab === 'team') {
    return (
      <div id={`${props.baseId}-team-panel`} role="tabpanel" aria-labelledby={props.teamTabId} tabIndex={0}>
        <WorkerRoster
          workers={props.filteredWorkers}
          roles={studio.roles}
          assignments={props.assignments}
          workItems={props.workItems}
          showProject={!props.selectedProjectId}
          busyKey={studio.busyKey}
          onActivate={(worker) => void studio.activateWorker(worker)}
          onPause={(worker) => void studio.pauseWorker(worker)}
          onResume={(worker) => void studio.resumeWorker(worker)}
          onRetire={(worker) => void studio.retireWorker(worker)}
          onAssign={props.onOpenAssignment}
          onHire={() => props.onOpenHire()}
        />
      </div>
    )
  }
  return (
    <div id={`${props.baseId}-roles-panel`} role="tabpanel" aria-labelledby={props.rolesTabId} tabIndex={0}>
      <div className="dws-panel-heading">
        <div><h3>岗位模板</h3><span>版本化的职责与能力基线</span></div>
        <button type="button" className="dws-button" onClick={() => props.onRoleEditor(true)} disabled={props.roleEditorOpen} data-dws-action="create-role">新建岗位</button>
      </div>
      {props.roleEditorOpen && (
        <RoleTemplateForm busy={studio.busyKey === 'role:create'} onCancel={() => props.onRoleEditor(false)} onSubmit={studio.createRole} />
      )}
      <RoleLibrary
        roles={studio.roles}
        canHire={Boolean(props.selectedProjectId)}
        onCreate={() => props.onRoleEditor(true)}
        onHire={props.onOpenHire}
      />
    </div>
  )
}
