import { useCallback, useEffect, useMemo, useState } from 'react'
import { BriefcaseBusiness, CalendarRange, Flag, Link2, Plus, RefreshCw, Trash2, Users } from 'lucide-react'
import type {
  ProjectDependency,
  ProjectMilestone,
  ProjectPortfolioSnapshot,
  ProjectPortfolioTimelineEntry,
  ProjectPortfolioDependencyHealth
} from '../../../../shared/types'
import { errorText } from './projectWorkspaceStudioModel'
import './project-portfolio.css'

type PortfolioTab = 'overview' | 'timeline' | 'resources'

interface Props {
  active: boolean
  refreshToken: string
  onSelectProject: (projectId: string) => void
}

const DAY_MS = 86_400_000

export function ProjectPortfolioView({ active, refreshToken, onSelectProject }: Props): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<ProjectPortfolioSnapshot | null>(null)
  const [tab, setTab] = useState<PortfolioTab>('overview')
  const [expanded, setExpanded] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    if (!active) return
    setLoading(true)
    setError('')
    try { setSnapshot(await window.agentDesk.getProjectPortfolio()) }
    catch (cause) { setError(errorText(cause)) }
    finally { setLoading(false) }
  }, [active])

  useEffect(() => { void refresh() }, [refresh, refreshToken])
  if (!active || (!loading && !error && snapshot?.projects.length === 0)) return null

  return (
    <section className="pws-portfolio" data-project-portfolio aria-busy={loading}>
      <header className="pws-portfolio-header">
        <button type="button" className="pws-portfolio-title" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
          <BriefcaseBusiness size={18} aria-hidden="true" />
          <span><strong>Portfolio</strong><small>{snapshot ? `${snapshot.projects.length} 个项目 · ${snapshot.dependencies.length} 条依赖 · ${snapshot.milestones.length} 个里程碑` : '跨项目计划'}</small></span>
        </button>
        <button type="button" className="btn btn-ghost btn-sm pws-icon-command" onClick={() => void refresh()} disabled={loading} title="刷新 Portfolio" aria-label="刷新 Portfolio">
          <RefreshCw size={15} className={loading ? 'pws-spin' : undefined} aria-hidden="true" />
        </button>
      </header>
      {error && <p className="notice notice-error pws-portfolio-error" role="alert">{error}</p>}
      {expanded && snapshot && (
        <>
          <div className="pws-portfolio-tabs" role="tablist" aria-label="Portfolio 视图">
            <PortfolioTabButton active={tab === 'overview'} icon={BriefcaseBusiness} label="项目" onClick={() => setTab('overview')} />
            <PortfolioTabButton active={tab === 'timeline'} icon={CalendarRange} label="Gantt" onClick={() => setTab('timeline')} />
            <PortfolioTabButton active={tab === 'resources'} icon={Users} label="负载" onClick={() => setTab('resources')} />
          </div>
          {tab === 'overview' && <PortfolioOverview snapshot={snapshot} onRefresh={refresh} onSelectProject={onSelectProject} />}
          {tab === 'timeline' && <PortfolioTimeline snapshot={snapshot} onRefresh={refresh} />}
          {tab === 'resources' && <PortfolioResources snapshot={snapshot} onSelectProject={onSelectProject} />}
          <footer className="pws-portfolio-revision">Workspace r{snapshot.workspaceRevision} · Portfolio r{snapshot.portfolioRevision} · {snapshot.snapshotDigest.slice(0, 16)}</footer>
        </>
      )}
    </section>
  )
}

function PortfolioTabButton({ active, icon: Icon, label, onClick }: { active: boolean; icon: typeof BriefcaseBusiness; label: string; onClick: () => void }): React.JSX.Element {
  return <button type="button" role="tab" aria-selected={active} className={active ? 'is-active' : undefined} onClick={onClick}><Icon size={15} aria-hidden="true" />{label}</button>
}

function PortfolioOverview({ snapshot, onRefresh, onSelectProject }: { snapshot: ProjectPortfolioSnapshot; onRefresh: () => Promise<void>; onSelectProject: (projectId: string) => void }): React.JSX.Element {
  const [form, setForm] = useState<'dependency' | 'milestone' | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const mutate = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(key); setError('')
    try { await action(); await onRefresh(); setForm(null) }
    catch (cause) { setError(errorText(cause)) }
    finally { setBusy('') }
  }
  return (
    <div className="pws-portfolio-overview" role="tabpanel">
      <div className="pws-portfolio-projects">
        {snapshot.projects.map((project) => (
          <button type="button" className="pws-portfolio-project" key={project.projectId} onClick={() => onSelectProject(project.projectId)} data-project-id={project.projectId}>
            <span className="pws-portfolio-project-head"><strong>{project.name}</strong><small>{project.kind} · {project.status}</small></span>
            <span className="pws-portfolio-progress"><i style={{ width: `${Math.round(project.progress * 100)}%` }} /><em>{Math.round(project.progress * 100)}%</em></span>
            <span className="pws-portfolio-metrics">
              <span><b>{project.goalCounts.active}</b> Goal</span><span><b>{project.workItemCounts.active}</b> 任务</span><span data-alert={project.workItemCounts.blocked > 0}><b>{project.workItemCounts.blocked}</b> 阻塞</span><span data-alert={project.workItemCounts.overdue > 0}><b>{project.workItemCounts.overdue}</b> 逾期</span><span data-alert={project.waitingDependencyCount > 0}><b>{project.waitingDependencyCount}</b> 等待前置</span><span data-alert={project.blockedDependencyCount > 0}><b>{project.blockedDependencyCount}</b> 前置失败</span>
            </span>
          </button>
        ))}
      </div>
      <div className="pws-portfolio-relations">
        <PortfolioRelationHeader icon={Link2} title="跨项目依赖" count={snapshot.dependencies.length} action="新建依赖" onAction={() => setForm(form === 'dependency' ? null : 'dependency')} />
        {form === 'dependency' && <DependencyForm snapshot={snapshot} busy={Boolean(busy)} onSubmit={(input) => mutate('dependency', () => window.agentDesk.createProjectDependency(input, { expectedStoreRevision: snapshot.portfolioRevision }))} />}
        <DependencyList dependencies={snapshot.dependencies} snapshot={snapshot} busy={busy} onRemove={(item) => mutate(item.id, () => window.agentDesk.removeProjectDependency(item.id, { expectedRevision: item.revision, expectedStoreRevision: snapshot.portfolioRevision }))} />
        <PortfolioRelationHeader icon={Flag} title="里程碑" count={snapshot.milestones.length} action="新建里程碑" onAction={() => setForm(form === 'milestone' ? null : 'milestone')} />
        {form === 'milestone' && <MilestoneForm snapshot={snapshot} busy={Boolean(busy)} onSubmit={(input) => mutate('milestone', () => window.agentDesk.createProjectMilestone(input, { expectedStoreRevision: snapshot.portfolioRevision }))} />}
        <MilestoneList milestones={snapshot.milestones} snapshot={snapshot} busy={busy} onChange={(item, status) => mutate(item.id, () => window.agentDesk.updateProjectMilestone(item.id, { status }, { expectedRevision: item.revision, expectedStoreRevision: snapshot.portfolioRevision }))} onDelete={(item) => mutate(item.id, () => window.agentDesk.deleteProjectMilestone(item.id, { expectedRevision: item.revision, expectedStoreRevision: snapshot.portfolioRevision }))} />
      </div>
      {error && <p className="notice notice-error pws-portfolio-error" role="alert">{error}</p>}
    </div>
  )
}

function PortfolioRelationHeader({ action, count, icon: Icon, onAction, title }: { action: string; count: number; icon: typeof Link2; onAction: () => void; title: string }): React.JSX.Element {
  return <div className="pws-portfolio-relation-head"><span><Icon size={15} aria-hidden="true" /><strong>{title}</strong><small>{count}</small></span><button type="button" className="btn btn-ghost btn-sm" onClick={onAction}><Plus size={14} aria-hidden="true" />{action}</button></div>
}

function DependencyForm({ snapshot, busy, onSubmit }: {
  snapshot: ProjectPortfolioSnapshot
  busy: boolean
  onSubmit: (input: {
    fromProjectId: string
    toProjectId: string
    fromWorkItemId?: string
    toWorkItemId?: string
    label?: string
  }) => Promise<void>
}): React.JSX.Element {
  const [fromProjectId, setFrom] = useState(snapshot.projects[0]?.projectId ?? '')
  const [toProjectId, setTo] = useState(snapshot.projects[1]?.projectId ?? '')
  const [fromWorkItemId, setFromWorkItemId] = useState('')
  const [toWorkItemId, setToWorkItemId] = useState('')
  const [label, setLabel] = useState('')
  const workItemsFor = (projectId: string) => snapshot.timeline.filter((entry) => entry.kind === 'work_item' && entry.projectId === projectId)
  const fromWorkItems = workItemsFor(fromProjectId)
  const toWorkItems = workItemsFor(toProjectId)
  const changeFromProject = (projectId: string): void => {
    setFrom(projectId)
    setFromWorkItemId('')
  }
  const changeToProject = (projectId: string): void => {
    setTo(projectId)
    setToWorkItemId('')
  }
  return <form className="pws-portfolio-inline-form pws-portfolio-dependency-form" onSubmit={(event) => {
    event.preventDefault()
    void onSubmit({
      fromProjectId,
      toProjectId,
      ...(fromWorkItemId ? { fromWorkItemId } : {}),
      ...(toWorkItemId ? { toWorkItemId } : {}),
      ...(label.trim() ? { label: label.trim() } : {})
    })
  }}>
    <select className="select" value={fromProjectId} onChange={(event) => changeFromProject(event.target.value)} aria-label="前置项目">{snapshot.projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}</select>
    <span aria-hidden="true">→</span>
    <select className="select" value={toProjectId} onChange={(event) => changeToProject(event.target.value)} aria-label="后续项目">{snapshot.projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}</select>
    <select className="select" value={fromWorkItemId} disabled={fromWorkItems.length === 0} onChange={(event) => setFromWorkItemId(event.target.value)} aria-label="前置任务">
      <option value="">整个前置项目</option>
      {fromWorkItems.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
    </select>
    <select className="select" value={toWorkItemId} disabled={toWorkItems.length === 0} onChange={(event) => setToWorkItemId(event.target.value)} aria-label="后续任务">
      <option value="">整个后续项目</option>
      {toWorkItems.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
    </select>
    <input className="input" value={label} maxLength={500} placeholder="依赖说明" onChange={(event) => setLabel(event.target.value)} />
    <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !fromProjectId || !toProjectId || fromProjectId === toProjectId}>保存</button>
  </form>
}

function MilestoneForm({ snapshot, busy, onSubmit }: { snapshot: ProjectPortfolioSnapshot; busy: boolean; onSubmit: (input: { projectId: string; title: string; dueAt: number }) => Promise<void> }): React.JSX.Element {
  const [projectId, setProjectId] = useState(snapshot.projects[0]?.projectId ?? '')
  const [title, setTitle] = useState('')
  const [due, setDue] = useState(dateInputValue(Date.now() + 7 * DAY_MS))
  return <form className="pws-portfolio-inline-form" onSubmit={(event) => { event.preventDefault(); void onSubmit({ projectId, title, dueAt: new Date(`${due}T12:00:00`).getTime() }) }}>
    <select className="select" value={projectId} onChange={(event) => setProjectId(event.target.value)} aria-label="里程碑项目">{snapshot.projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}</select>
    <input className="input" value={title} maxLength={500} required placeholder="里程碑名称" onChange={(event) => setTitle(event.target.value)} />
    <input className="input" type="date" value={due} required onChange={(event) => setDue(event.target.value)} aria-label="截止日期" />
    <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !projectId || !title.trim() || !due}>保存</button>
  </form>
}

function DependencyList({ busy, dependencies, onRemove, snapshot }: { busy: string; dependencies: ProjectDependency[]; onRemove: (item: ProjectDependency) => Promise<void>; snapshot: ProjectPortfolioSnapshot }): React.JSX.Element {
  const projectName = (id: string): string => snapshot.projects.find((project) => project.projectId === id)?.name ?? id
  const workItemName = (id: string | undefined): string | undefined => id
    ? snapshot.timeline.find((entry) => entry.kind === 'work_item' && entry.id === id)?.title ?? id
    : undefined
  const healthById = new Map(snapshot.dependencyHealth.map((item) => [item.dependencyId, item]))
  if (dependencies.length === 0) return <p className="pws-portfolio-empty">尚无跨项目依赖</p>
  return <div className="pws-portfolio-list">{dependencies.map((item) => {
    const health = healthById.get(item.id)
    return <div key={item.id} data-dependency-state={health?.state ?? 'waiting'}>
      <span>
        <strong>{projectName(item.fromProjectId)}</strong>{workItemName(item.fromWorkItemId) && <small>{workItemName(item.fromWorkItemId)}</small>}<i>→</i><strong>{projectName(item.toProjectId)}</strong>{workItemName(item.toWorkItemId) && <small>{workItemName(item.toWorkItemId)}</small>}
        {item.label && <small>{item.label}</small>}
        {health && <DependencyHealthBadge health={health} />}
      </span>
      <button type="button" className="pws-icon-command" disabled={Boolean(busy)} onClick={() => void onRemove(item)} title="移除依赖" aria-label="移除依赖"><Trash2 size={14} aria-hidden="true" /></button>
    </div>
  })}</div>
}

function DependencyHealthBadge({ health }: { health: ProjectPortfolioDependencyHealth }): React.JSX.Element {
  const text = health.state === 'satisfied'
    ? '已满足'
    : health.state === 'blocked' ? `前置${health.sourceStatus}` : `等待前置${health.sourceStatus}`
  return <em className="pws-dependency-health" data-state={health.state}>{text}</em>
}

function MilestoneList({ busy, milestones, onChange, onDelete, snapshot }: { busy: string; milestones: ProjectMilestone[]; onChange: (item: ProjectMilestone, status: ProjectMilestone['status']) => Promise<void>; onDelete: (item: ProjectMilestone) => Promise<void>; snapshot: ProjectPortfolioSnapshot }): React.JSX.Element {
  const projectName = (id: string): string => snapshot.projects.find((project) => project.projectId === id)?.name ?? id
  if (milestones.length === 0) return <p className="pws-portfolio-empty">尚无里程碑</p>
  return <div className="pws-portfolio-list">{[...milestones].sort((a, b) => a.dueAt - b.dueAt).map((item) => <div key={item.id}><span><strong>{item.title}</strong><small>{projectName(item.projectId)} · {formatDate(item.dueAt)}</small></span><select className="select pws-milestone-status" value={item.status} disabled={Boolean(busy)} aria-label={`${item.title} 状态`} onChange={(event) => void onChange(item, event.target.value as ProjectMilestone['status'])}><option value="planned">计划中</option><option value="reached">已达成</option><option value="missed">已错过</option><option value="cancelled">已取消</option></select><button type="button" className="pws-icon-command" disabled={Boolean(busy)} onClick={() => void onDelete(item)} title="删除里程碑" aria-label="删除里程碑"><Trash2 size={14} aria-hidden="true" /></button></div>)}</div>
}

function PortfolioTimeline({ snapshot, onRefresh }: { snapshot: ProjectPortfolioSnapshot; onRefresh: () => Promise<void> }): React.JSX.Element {
  const [filter, setFilter] = useState<'all' | ProjectPortfolioTimelineEntry['kind']>('all')
  const entries = snapshot.timeline.filter((entry) => filter === 'all' || entry.kind === filter)
  const safeRange = Math.max(DAY_MS, snapshot.rangeEnd - snapshot.rangeStart)
  const todayPosition = Math.max(0, Math.min(100, ((Date.now() - snapshot.rangeStart) / safeRange) * 100))
  return <div className="pws-gantt" role="tabpanel">
    <div className="pws-gantt-toolbar"><div className="pws-segmented" role="group" aria-label="时间线类型"><button type="button" data-active={filter === 'all'} onClick={() => setFilter('all')}>全部</button><button type="button" data-active={filter === 'goal'} onClick={() => setFilter('goal')}>Goal</button><button type="button" data-active={filter === 'work_item'} onClick={() => setFilter('work_item')}>任务</button><button type="button" data-active={filter === 'milestone'} onClick={() => setFilter('milestone')}>里程碑</button></div><span>{formatDate(snapshot.rangeStart)} - {formatDate(snapshot.rangeEnd)}</span></div>
    <div className="pws-gantt-grid"><div className="pws-gantt-today" style={{ left: `calc(220px + (100% - 220px) * ${todayPosition / 100})` }} title="今天" />{entries.map((entry) => <GanttRow key={`${entry.kind}:${entry.id}`} entry={entry} snapshot={snapshot} />)}</div>
    {entries.length === 0 && <p className="pws-portfolio-empty">当前筛选没有时间线项目</p>}
    <button type="button" className="pws-visually-hidden" onClick={() => void onRefresh()}>刷新时间线</button>
  </div>
}

function GanttRow({ entry, snapshot }: { entry: ProjectPortfolioTimelineEntry; snapshot: ProjectPortfolioSnapshot }): React.JSX.Element {
  const range = Math.max(DAY_MS, snapshot.rangeEnd - snapshot.rangeStart)
  const left = Math.max(0, Math.min(100, ((entry.startAt - snapshot.rangeStart) / range) * 100))
  const width = Math.max(entry.kind === 'milestone' ? 1.2 : 2, Math.min(100 - left, ((Math.max(entry.endAt, entry.startAt + DAY_MS) - entry.startAt) / range) * 100))
  const project = snapshot.projects.find((candidate) => candidate.projectId === entry.projectId)
  const dependencyState = entry.blockedByCrossProjectDependencyIds.length > 0
    ? 'blocked'
    : entry.waitingOnCrossProjectDependencyIds.length > 0 ? 'waiting' : 'satisfied'
  const dependencyLabel = dependencyState === 'blocked'
    ? `${entry.blockedByCrossProjectDependencyIds.length} 个跨项目前置失败`
    : dependencyState === 'waiting' ? `等待 ${entry.waitingOnCrossProjectDependencyIds.length} 个跨项目前置` : ''
  return <div className="pws-gantt-row" data-kind={entry.kind} data-overdue={entry.overdue} data-cross-project-dependency={dependencyState}>
    <span className="pws-gantt-label"><strong>{entry.title}</strong><small>{project?.name ?? entry.projectId} · {entry.status}{dependencyLabel ? ` · ${dependencyLabel}` : ''}</small></span>
    <span className="pws-gantt-track"><i style={{ left: `${left}%`, width: `${width}%` }} title={`${formatDate(entry.startAt)} - ${formatDate(entry.endAt)}${dependencyLabel ? ` · ${dependencyLabel}` : ''}`}><b style={{ width: `${entry.progress * 100}%` }} /></i></span>
  </div>
}

function PortfolioResources({ snapshot, onSelectProject }: { snapshot: ProjectPortfolioSnapshot; onSelectProject: (projectId: string) => void }): React.JSX.Element {
  const maximum = Math.max(1, ...snapshot.resourceLoad.map((item) => item.activeWorkItems))
  return <div className="pws-resource-load" role="tabpanel">{snapshot.resourceLoad.map((item) => <div key={`${item.ownerType}:${item.ownerId}`}><span><strong>{item.displayName ?? item.ownerId}</strong><small>{item.ownerType === 'digital_worker' ? '数字员工' : '成员'} · {item.projectIds.length} 个项目</small></span><span className="pws-load-bar"><i style={{ width: `${Math.max(4, item.activeWorkItems / maximum * 100)}%` }} /><em>{item.activeWorkItems} 项</em></span><span className="pws-load-alerts" data-alert={item.blockedWorkItems + item.overdueWorkItems > 0}>{item.blockedWorkItems} 阻塞 · {item.overdueWorkItems} 逾期</span><span className="pws-load-projects">{item.projectIds.map((id) => <button type="button" key={id} onClick={() => onSelectProject(id)}>{snapshot.projects.find((project) => project.projectId === id)?.name ?? id}</button>)}</span></div>)}{snapshot.resourceLoad.length === 0 && <p className="pws-portfolio-empty">为 WorkItem 分配负责人后，这里会显示跨项目负载。</p>}</div>
}

function dateInputValue(value: number): string { return new Date(value).toISOString().slice(0, 10) }
function formatDate(value: number): string { return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(value) }
