import { useState } from 'react'
import type { DigitalWorker, DigitalWorkerAssignment, RoleTemplate } from '../../../../shared/types'
import type { DigitalWorkerStudioWorkItem } from './digital-worker-studio-model'
import {
  WORKER_STATUS_LABELS,
  acceptancePolicyLabels,
  assignmentsForWorker,
  budgetLabel,
  compactId,
  dataScopeLabels,
  escalationPolicyLabels,
  permissionsFor,
  roleForWorker,
  workerInitials,
  workItemTitle
} from './digital-worker-studio-model'

interface WorkerRosterProps {
  workers: readonly DigitalWorker[]
  roles: readonly RoleTemplate[]
  assignments: readonly DigitalWorkerAssignment[]
  workItems: readonly DigitalWorkerStudioWorkItem[]
  showProject: boolean
  busyKey: string | null
  onActivate: (worker: DigitalWorker) => void
  onPause: (worker: DigitalWorker) => void
  onResume: (worker: DigitalWorker) => void
  onRetire: (worker: DigitalWorker) => void
  onAssign: (workerId: string) => void
  onHire: () => void
}

export function WorkerRoster(props: WorkerRosterProps): React.JSX.Element {
  const { workers, onHire } = props
  if (workers.length === 0) {
    return (
      <div className="dws-empty" role="status">
        <strong>当前筛选下没有数字员工</strong>
        <button type="button" className="dws-button dws-button-primary" onClick={onHire}>招聘员工</button>
      </div>
    )
  }
  return (
    <div className="dws-worker-grid" role="list" aria-label="数字员工列表">
      {workers.map((worker) => <WorkerCard key={worker.id} worker={worker} {...props} />)}
    </div>
  )
}

function WorkerCard(props: WorkerRosterProps & { worker: DigitalWorker }): React.JSX.Element {
  const {
    worker,
    roles,
    assignments,
    workItems,
    showProject,
    busyKey,
    onActivate,
    onPause,
    onResume,
    onRetire,
    onAssign
  } = props
  const [confirmRetire, setConfirmRetire] = useState(false)
  const role = roleForWorker(worker, roles)
  const permissions = permissionsFor(worker)
  const activeAssignments = assignmentsForWorker(worker.id, assignments)
  const busy = busyKey !== null

  return (
    <article
      className="dws-worker-card"
      role="listitem"
      aria-labelledby={`dws-worker-${worker.id}`}
      data-digital-worker-id={worker.id}
      data-digital-worker-status={worker.status}
    >
      <header className="dws-worker-head">
        <div className="dws-avatar" aria-hidden="true">{workerInitials(worker.displayName)}</div>
        <div className="dws-worker-identity">
          <h3 id={`dws-worker-${worker.id}`}>{worker.displayName}</h3>
          <span>{role?.name || '岗位模板不可用'} · v{worker.roleTemplateVersion}</span>
        </div>
        <span className={`dws-status dws-status-${worker.status}`}>
          <span className="dws-status-dot" aria-hidden="true" />
          {WORKER_STATUS_LABELS[worker.status]}
        </span>
      </header>

      {showProject && <div className="dws-project-line"><span>项目</span><code>{compactId(worker.projectId)}</code></div>}

      <div className="dws-worker-metrics" aria-label="员工运行配置">
        <div><span>预算</span><strong>{budgetLabel(worker.budgetPolicy)}</strong></div>
        <div><span>并发</span><strong>{worker.concurrencyLimit}</strong></div>
        <div><span>任务</span><strong>{activeAssignments.length}</strong></div>
      </div>

      <section className="dws-worker-section" aria-label="职责">
        <h4>职责</h4>
        {worker.responsibilityScope.length > 0 ? (
          <ul>{worker.responsibilityScope.map((item) => <li key={item}>{item}</li>)}</ul>
        ) : <span className="dws-muted">沿用岗位职责</span>}
      </section>

      <section className="dws-worker-section" aria-label="工具权限">
        <h4>工具权限</h4>
        <div className="dws-chip-row">
          {(permissions.length > 0 ? permissions : ['未授予工具权限']).map((permission) => (
            <span key={permission} className="dws-chip">{permission}</span>
          ))}
        </div>
      </section>

      <section className="dws-worker-section" aria-label="数据范围">
        <h4>数据范围</h4>
        <div className="dws-chip-row">
          {dataScopeLabels(worker).map((label) => <span key={label} className="dws-chip">{label}</span>)}
        </div>
      </section>

      <section className="dws-worker-section" aria-label="验收与升级策略">
        <h4>验收与升级</h4>
        <div className="dws-chip-row">
          {acceptancePolicyLabels(worker).map((label) => <span key={`acceptance:${label}`} className="dws-chip">{label}</span>)}
          {escalationPolicyLabels(worker).map((label) => <span key={`escalation:${label}`} className="dws-chip">{label}</span>)}
        </div>
      </section>

      <section className="dws-worker-section" aria-label="已分配 WorkItem">
        <h4>WorkItem</h4>
        {activeAssignments.length > 0 ? (
          <ul className="dws-assignment-list">
            {activeAssignments.map((assignment) => (
              <li key={assignment.id}>{workItemTitle(assignment.workItemId, workItems)}</li>
            ))}
          </ul>
        ) : <span className="dws-muted">暂无分配</span>}
      </section>

      {confirmRetire && worker.status !== 'retired' ? (
        <div className="dws-retire-confirm" role="alert">
          <span>退休后不可重新启用。</span>
          <div>
            <button type="button" className="dws-button dws-button-danger" disabled={busy} onClick={() => onRetire(worker)} data-dws-action="confirm-retire">确认退休</button>
            <button type="button" className="dws-button dws-button-quiet" disabled={busy} onClick={() => setConfirmRetire(false)}>取消</button>
          </div>
        </div>
      ) : (
        <footer className="dws-worker-actions">
          {worker.status === 'proposed' && (
            <button type="button" className="dws-button dws-button-primary" disabled={busy} onClick={() => onActivate(worker)} aria-label={`启用 ${worker.displayName}`} data-dws-action="activate">启用</button>
          )}
          {worker.status === 'active' && (
            <>
              <button type="button" className="dws-button dws-button-primary" disabled={busy} onClick={() => onAssign(worker.id)} aria-label={`给 ${worker.displayName} 分配 WorkItem`} data-dws-action="assign">分配任务</button>
              <button type="button" className="dws-button" disabled={busy} onClick={() => onPause(worker)} aria-label={`暂停 ${worker.displayName}`} data-dws-action="pause">暂停</button>
            </>
          )}
          {worker.status === 'paused' && (
            <button type="button" className="dws-button dws-button-primary" disabled={busy} onClick={() => onResume(worker)} aria-label={`恢复 ${worker.displayName}`} data-dws-action="resume">恢复</button>
          )}
          {worker.status !== 'retired' && (
            <button type="button" className="dws-button dws-button-quiet" disabled={busy} onClick={() => setConfirmRetire(true)} aria-label={`退休 ${worker.displayName}`} data-dws-action="retire">退休</button>
          )}
        </footer>
      )}
    </article>
  )
}

interface RoleLibraryProps {
  roles: readonly RoleTemplate[]
  canHire: boolean
  onCreate: () => void
  onHire: (roleId: string) => void
}

export function RoleLibrary({ roles, canHire, onCreate, onHire }: RoleLibraryProps): React.JSX.Element {
  if (roles.length === 0) {
    return (
      <div className="dws-empty" role="status">
        <strong>岗位库为空</strong>
        <button type="button" className="dws-button dws-button-primary" onClick={onCreate}>新建岗位</button>
      </div>
    )
  }
  return (
    <div className="dws-role-grid" role="list" aria-label="岗位模板列表">
      {roles.map((role) => (
        <article key={role.id} className="dws-role-card" role="listitem" data-role-template-id={role.id}>
          <header>
            <div>
              <h3>{role.name}</h3>
              <span>版本 {role.version}</span>
            </div>
            <span className="dws-role-source">{role.source === 'builtin' ? '内置' : '自定义'}</span>
          </header>
          <p>{role.purpose}</p>
          {(role.capabilityRefs.length > 0 || role.skillRefs.length > 0) && (
            <div className="dws-chip-row" aria-label="岗位能力与技能">
              {[...new Set([...role.capabilityRefs, ...role.skillRefs])].map((item) => <span key={item} className="dws-chip">{item}</span>)}
            </div>
          )}
          <footer>
            <button
              type="button"
              className="dws-button dws-button-primary"
              onClick={() => onHire(role.id)}
              disabled={!canHire}
              title={canHire ? undefined : '请先选择项目'}
              data-dws-action="hire-from-role"
            >
              按此岗位招聘
            </button>
          </footer>
        </article>
      ))}
    </div>
  )
}
