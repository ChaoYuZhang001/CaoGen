import { useEffect, useId, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type {
  DigitalWorker,
  DigitalWorkerAssignment,
  DigitalWorkerInput,
  JsonObject,
  RoleTemplate,
  RoleTemplateInput
} from '../../../../shared/types'
import type { DigitalWorkerStudioWorkItem } from './digital-worker-studio-model'
import {
  splitList,
  workerAllowedDataClasses,
  workerAllowedResourceIds,
  workerDeniedDataClasses,
  workItemTitle
} from './digital-worker-studio-model'

interface RoleTemplateFormProps {
  busy: boolean
  onCancel: () => void
  onSubmit: (input: RoleTemplateInput) => Promise<boolean>
}

export function RoleTemplateForm({ busy, onCancel, onSubmit }: RoleTemplateFormProps): React.JSX.Element {
  const titleId = useId()
  const nameRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [instructions, setInstructions] = useState('')
  const [capabilities, setCapabilities] = useState('')
  const [skills, setSkills] = useState('')

  useEffect(() => nameRef.current?.focus(), [])

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const ok = await onSubmit({
      name: name.trim(),
      purpose: purpose.trim(),
      instructions: instructions.trim(),
      capabilityRefs: splitList(capabilities),
      skillRefs: splitList(skills),
      source: 'user'
    })
    if (ok) onCancel()
  }

  return (
    <form
      className="dws-editor"
      aria-labelledby={titleId}
      data-dws-form="role-template"
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) onCancel()
      }}
    >
      <div className="dws-editor-heading">
        <h3 id={titleId}>新建岗位模板</h3>
        <button type="button" className="dws-button dws-button-quiet" onClick={onCancel} disabled={busy}>取消</button>
      </div>
      <div className="dws-form-grid">
        <label className="dws-field">
          <span>岗位名称</span>
          <input ref={nameRef} value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} />
        </label>
        <label className="dws-field">
          <span>岗位目标</span>
          <input value={purpose} onChange={(event) => setPurpose(event.target.value)} required maxLength={240} />
        </label>
        <label className="dws-field dws-field-wide">
          <span>岗位职责说明</span>
          <textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={3} maxLength={4000} />
        </label>
        <label className="dws-field">
          <span>能力标签</span>
          <input value={capabilities} onChange={(event) => setCapabilities(event.target.value)} placeholder="研究, 写作, 审核" />
        </label>
        <label className="dws-field">
          <span>技能标签</span>
          <input value={skills} onChange={(event) => setSkills(event.target.value)} placeholder="资料检索, 文档整理" />
        </label>
      </div>
      <div className="dws-editor-actions">
        <button type="submit" className="dws-button dws-button-primary" disabled={busy || !name.trim() || !purpose.trim()}>
          {busy ? '创建中...' : '创建岗位'}
        </button>
      </div>
    </form>
  )
}

interface HireWorkerFormProps {
  projectId: string
  roles: readonly RoleTemplate[]
  initialRoleId?: string
  busy: boolean
  onCancel: () => void
  onSubmit: (input: DigitalWorkerInput, activate: boolean) => Promise<boolean>
}

interface HireWorkerIdentityFieldsProps {
  roles: readonly RoleTemplate[]
  displayName: string
  roleId: string
  responsibilities: string
  setDisplayName: Dispatch<SetStateAction<string>>
  setRoleId: Dispatch<SetStateAction<string>>
  setResponsibilities: Dispatch<SetStateAction<string>>
}

function HireWorkerIdentityFields(props: HireWorkerIdentityFieldsProps): React.JSX.Element {
  const {
    roles,
    displayName,
    roleId,
    responsibilities,
    setDisplayName,
    setRoleId,
    setResponsibilities
  } = props
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => nameRef.current?.focus(), [])

  return (
    <>
      <label className="dws-field">
        <span>员工名称</span>
        <input
          ref={nameRef}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          required
          maxLength={80}
        />
      </label>
      <label className="dws-field">
        <span>岗位模板</span>
        <select value={roleId} onChange={(event) => setRoleId(event.target.value)} required>
          <option value="" disabled>选择岗位</option>
          {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
        </select>
      </label>
      <label className="dws-field dws-field-wide">
        <span>职责范围</span>
        <textarea
          value={responsibilities}
          onChange={(event) => setResponsibilities(event.target.value)}
          rows={3}
          placeholder="每行一项职责"
          maxLength={2000}
        />
      </label>
    </>
  )
}

interface HireWorkerDataScopeFieldsProps {
  allowedDataClasses: string
  deniedDataClasses: string
  allowedResourceIds: string
  requireExplicitScope: boolean
  setAllowedDataClasses: Dispatch<SetStateAction<string>>
  setDeniedDataClasses: Dispatch<SetStateAction<string>>
  setAllowedResourceIds: Dispatch<SetStateAction<string>>
  setRequireExplicitScope: Dispatch<SetStateAction<boolean>>
}

function HireWorkerDataScopeFields(props: HireWorkerDataScopeFieldsProps): React.JSX.Element {
  const {
    allowedDataClasses,
    deniedDataClasses,
    allowedResourceIds,
    requireExplicitScope,
    setAllowedDataClasses,
    setDeniedDataClasses,
    setAllowedResourceIds,
    setRequireExplicitScope
  } = props
  return (
    <fieldset className="dws-fieldset dws-field-wide">
      <legend>数据范围</legend>
      <div className="dws-form-grid dws-nested-grid">
        <label className="dws-field">
          <span>允许的数据类</span>
          <input
            value={allowedDataClasses}
            onChange={(event) => setAllowedDataClasses(event.target.value)}
            placeholder="project-internal, public"
          />
        </label>
        <label className="dws-field">
          <span>禁止的数据类</span>
          <input
            value={deniedDataClasses}
            onChange={(event) => setDeniedDataClasses(event.target.value)}
            placeholder="credential, restricted"
          />
        </label>
        <label className="dws-field dws-field-wide">
          <span>允许的 Resource ID</span>
          <input
            value={allowedResourceIds}
            onChange={(event) => setAllowedResourceIds(event.target.value)}
            placeholder="repo-main, docs-public"
          />
        </label>
        <label className="dws-check dws-field-wide">
          <input
            type="checkbox"
            checked={requireExplicitScope}
            onChange={(event) => setRequireExplicitScope(event.target.checked)}
          />
          <span>分配 WorkItem 时必须声明数据类</span>
        </label>
      </div>
    </fieldset>
  )
}

interface HireWorkerPolicyFieldsProps {
  monthlyBudget: string
  concurrency: string
  minimumEvidenceCount: string
  requireUserApproval: boolean
  escalationTarget: string
  escalateAfterFailures: string
  activate: boolean
  setMonthlyBudget: Dispatch<SetStateAction<string>>
  setConcurrency: Dispatch<SetStateAction<string>>
  setMinimumEvidenceCount: Dispatch<SetStateAction<string>>
  setRequireUserApproval: Dispatch<SetStateAction<boolean>>
  setEscalationTarget: Dispatch<SetStateAction<string>>
  setEscalateAfterFailures: Dispatch<SetStateAction<string>>
  setActivate: Dispatch<SetStateAction<boolean>>
}

function HireWorkerPolicyFields(props: HireWorkerPolicyFieldsProps): React.JSX.Element {
  const {
    monthlyBudget,
    concurrency,
    minimumEvidenceCount,
    requireUserApproval,
    escalationTarget,
    escalateAfterFailures,
    activate,
    setMonthlyBudget,
    setConcurrency,
    setMinimumEvidenceCount,
    setRequireUserApproval,
    setEscalationTarget,
    setEscalateAfterFailures,
    setActivate
  } = props
  return (
    <>
      <label className="dws-field">
        <span>月度预算 (USD)</span>
        <input
          type="number"
          min="0"
          step="0.01"
          value={monthlyBudget}
          onChange={(event) => setMonthlyBudget(event.target.value)}
          placeholder="不设限"
        />
      </label>
      <label className="dws-field">
        <span>最大并发</span>
        <input
          type="number"
          min="1"
          max="32"
          step="1"
          value={concurrency}
          onChange={(event) => setConcurrency(event.target.value)}
          required
        />
      </label>
      <label className="dws-field">
        <span>最少 Evidence 数</span>
        <input
          type="number"
          min="0"
          max="10000"
          step="1"
          value={minimumEvidenceCount}
          onChange={(event) => setMinimumEvidenceCount(event.target.value)}
          required
        />
      </label>
      <label className="dws-check">
        <input
          type="checkbox"
          checked={requireUserApproval}
          onChange={(event) => setRequireUserApproval(event.target.checked)}
        />
        <span>验收需用户确认</span>
      </label>
      <label className="dws-field">
        <span>升级目标</span>
        <input
          value={escalationTarget}
          onChange={(event) => setEscalationTarget(event.target.value)}
          required
          maxLength={120}
        />
      </label>
      <label className="dws-field">
        <span>连续失败后升级</span>
        <input
          type="number"
          min="1"
          max="10000"
          step="1"
          value={escalateAfterFailures}
          onChange={(event) => setEscalateAfterFailures(event.target.value)}
          required
        />
      </label>
      <label className="dws-check dws-field-wide">
        <input type="checkbox" checked={activate} onChange={(event) => setActivate(event.target.checked)} />
        <span>入职后立即启用</span>
      </label>
    </>
  )
}

interface HireWorkerInputValues {
  projectId: string
  roleId: string
  displayName: string
  responsibilities: string
  permissions: PermissionFieldsProps['permissions']
  allowedDataClasses: string
  deniedDataClasses: string
  allowedResourceIds: string
  requireExplicitScope: boolean
  monthlyBudget: string
  concurrency: string
  minimumEvidenceCount: string
  requireUserApproval: boolean
  escalationTarget: string
  escalateAfterFailures: string
}

function buildHireWorkerInput(values: HireWorkerInputValues): DigitalWorkerInput {
  const budget = values.monthlyBudget.trim() ? Number(values.monthlyBudget) : undefined
  return {
    projectId: values.projectId,
    roleTemplateId: values.roleId,
    displayName: values.displayName.trim(),
    responsibilityScope: splitList(values.responsibilities),
    toolPolicy: values.permissions,
    dataScope: {
      requireExplicitScope: values.requireExplicitScope,
      allowedDataClasses: splitList(values.allowedDataClasses),
      deniedDataClasses: splitList(values.deniedDataClasses),
      allowedResourceIds: splitList(values.allowedResourceIds)
    },
    budgetPolicy: budget === undefined ? {} : { monthlyUsd: budget },
    concurrencyLimit: Number(values.concurrency),
    acceptancePolicy: {
      minimumEvidenceCount: Number(values.minimumEvidenceCount),
      requireUserApproval: values.requireUserApproval
    },
    escalationPolicy: {
      target: values.escalationTarget.trim(),
      afterFailures: Number(values.escalateAfterFailures)
    }
  }
}

export function HireWorkerForm(props: HireWorkerFormProps): React.JSX.Element {
  const { projectId, roles, initialRoleId, busy, onCancel, onSubmit } = props
  const titleId = useId()
  const [displayName, setDisplayName] = useState('')
  const [roleId, setRoleId] = useState(initialRoleId || roles[0]?.id || '')
  const [responsibilities, setResponsibilities] = useState('')
  const [monthlyBudget, setMonthlyBudget] = useState('')
  const [concurrency, setConcurrency] = useState('1')
  const [allowedDataClasses, setAllowedDataClasses] = useState('')
  const [deniedDataClasses, setDeniedDataClasses] = useState('')
  const [allowedResourceIds, setAllowedResourceIds] = useState('')
  const [requireExplicitScope, setRequireExplicitScope] = useState(false)
  const [minimumEvidenceCount, setMinimumEvidenceCount] = useState('1')
  const [requireUserApproval, setRequireUserApproval] = useState(false)
  const [escalationTarget, setEscalationTarget] = useState('project-owner')
  const [escalateAfterFailures, setEscalateAfterFailures] = useState('2')
  const [activate, setActivate] = useState(true)
  const [permissions, setPermissions] = useState({
    workspaceRead: true,
    workspaceWrite: false,
    terminal: false,
    browser: false,
    network: false
  })

  useEffect(() => {
    if (initialRoleId && roles.some((role) => role.id === initialRoleId)) setRoleId(initialRoleId)
  }, [initialRoleId, roles])

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const input = buildHireWorkerInput({
      projectId,
      roleId,
      displayName,
      responsibilities,
      permissions,
      allowedDataClasses,
      deniedDataClasses,
      allowedResourceIds,
      requireExplicitScope,
      monthlyBudget,
      concurrency,
      minimumEvidenceCount,
      requireUserApproval,
      escalationTarget,
      escalateAfterFailures
    })
    if (await onSubmit(input, activate)) onCancel()
  }

  return (
    <form
      className="dws-editor"
      aria-labelledby={titleId}
      data-dws-form="hire-worker"
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) onCancel()
      }}
    >
      <div className="dws-editor-heading">
        <div>
          <h3 id={titleId}>招聘数字员工</h3>
          <span className="dws-code">{projectId}</span>
        </div>
        <button type="button" className="dws-button dws-button-quiet" onClick={onCancel} disabled={busy}>取消</button>
      </div>
      <div className="dws-form-grid">
        <HireWorkerIdentityFields
          roles={roles}
          displayName={displayName}
          roleId={roleId}
          responsibilities={responsibilities}
          setDisplayName={setDisplayName}
          setRoleId={setRoleId}
          setResponsibilities={setResponsibilities}
        />
        <PermissionFields permissions={permissions} setPermissions={setPermissions} />
        <HireWorkerDataScopeFields
          allowedDataClasses={allowedDataClasses}
          deniedDataClasses={deniedDataClasses}
          allowedResourceIds={allowedResourceIds}
          requireExplicitScope={requireExplicitScope}
          setAllowedDataClasses={setAllowedDataClasses}
          setDeniedDataClasses={setDeniedDataClasses}
          setAllowedResourceIds={setAllowedResourceIds}
          setRequireExplicitScope={setRequireExplicitScope}
        />
        <HireWorkerPolicyFields
          monthlyBudget={monthlyBudget}
          concurrency={concurrency}
          minimumEvidenceCount={minimumEvidenceCount}
          requireUserApproval={requireUserApproval}
          escalationTarget={escalationTarget}
          escalateAfterFailures={escalateAfterFailures}
          activate={activate}
          setMonthlyBudget={setMonthlyBudget}
          setConcurrency={setConcurrency}
          setMinimumEvidenceCount={setMinimumEvidenceCount}
          setRequireUserApproval={setRequireUserApproval}
          setEscalationTarget={setEscalationTarget}
          setEscalateAfterFailures={setEscalateAfterFailures}
          setActivate={setActivate}
        />
      </div>
      <div className="dws-editor-actions">
        <button
          type="submit"
          className="dws-button dws-button-primary"
          disabled={busy || !displayName.trim() || !roleId || !projectId}
        >
          {busy ? '招聘中...' : '确认招聘'}
        </button>
      </div>
    </form>
  )
}

interface PermissionFieldsProps {
  permissions: {
    workspaceRead: boolean
    workspaceWrite: boolean
    terminal: boolean
    browser: boolean
    network: boolean
  }
  setPermissions: Dispatch<SetStateAction<PermissionFieldsProps['permissions']>>
}

function PermissionFields({ permissions, setPermissions }: PermissionFieldsProps): React.JSX.Element {
  const options = [
    ['workspaceRead', '读取工作区'],
    ['workspaceWrite', '修改工作区'],
    ['terminal', '终端操作'],
    ['browser', '浏览器操作'],
    ['network', '网络访问']
  ] as const
  return (
    <fieldset className="dws-fieldset dws-field-wide">
      <legend>工具权限</legend>
      <div className="dws-check-grid">
        {options.map(([key, label]) => (
          <label key={key} className="dws-check">
            <input
              type="checkbox"
              checked={permissions[key]}
              onChange={() => setPermissions((current) => ({ ...current, [key]: !current[key] }))}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

interface AssignmentFormProps {
  projectId: string
  workItems: readonly DigitalWorkerStudioWorkItem[]
  workers: readonly DigitalWorker[]
  assignments: readonly DigitalWorkerAssignment[]
  initialWorkerId?: string
  busy: boolean
  onCancel: () => void
  onSubmit: (workItemId: string, workerId: string, scope: JsonObject, reason: string) => Promise<boolean>
}

function buildAssignmentScope(dataClass: string, resourceIds: string): JsonObject {
  const resources = splitList(resourceIds)
  return {
    ...(dataClass.trim() ? { dataClass: dataClass.trim() } : {}),
    ...(resources.length > 0 ? { resourceIds: resources } : {})
  }
}

interface AssignmentScopeFieldsProps {
  titleId: string
  worker?: DigitalWorker
  dataClass: string
  resourceIds: string
  setDataClass: Dispatch<SetStateAction<string>>
  setResourceIds: Dispatch<SetStateAction<string>>
}

function AssignmentScopeFields(props: AssignmentScopeFieldsProps): React.JSX.Element {
  const { titleId, worker, dataClass, resourceIds, setDataClass, setResourceIds } = props
  const allowedDataClasses = worker ? workerAllowedDataClasses(worker) : []
  const deniedDataClasses = worker ? workerDeniedDataClasses(worker) : []
  const allowedResources = worker ? workerAllowedResourceIds(worker) : []
  const scopeRequired = worker?.dataScope.requireExplicitScope === true ||
    allowedDataClasses.length > 0 || deniedDataClasses.length > 0

  return (
    <>
      <label className="dws-field dws-field-wide">
        <span>数据类</span>
        <input
          value={dataClass}
          onChange={(event) => setDataClass(event.target.value)}
          required={scopeRequired}
          list={`${titleId}-data-classes`}
          placeholder={scopeRequired ? '必须匹配员工策略' : '可选'}
        />
        <datalist id={`${titleId}-data-classes`}>
          {allowedDataClasses.map((entry) => <option key={entry} value={entry} />)}
        </datalist>
      </label>
      <label className="dws-field dws-field-wide">
        <span>Resource ID</span>
        <input
          value={resourceIds}
          onChange={(event) => setResourceIds(event.target.value)}
          required={allowedResources.length > 0}
          placeholder={allowedResources.length > 0 ? '必须匹配员工策略' : '多个值用逗号或换行分隔'}
        />
      </label>
    </>
  )
}

interface AssignmentFieldsProps {
  titleId: string
  workItems: readonly DigitalWorkerStudioWorkItem[]
  activeWorkers: readonly DigitalWorker[]
  currentAssignment?: DigitalWorkerAssignment
  workItemId: string
  workerId: string
  dataClass: string
  resourceIds: string
  reason: string
  setWorkItemId: Dispatch<SetStateAction<string>>
  setWorkerId: Dispatch<SetStateAction<string>>
  setDataClass: Dispatch<SetStateAction<string>>
  setResourceIds: Dispatch<SetStateAction<string>>
  setReason: Dispatch<SetStateAction<string>>
}

function AssignmentFields(props: AssignmentFieldsProps): React.JSX.Element {
  const {
    titleId,
    workItems,
    activeWorkers,
    currentAssignment,
    workItemId,
    workerId,
    dataClass,
    resourceIds,
    reason,
    setWorkItemId,
    setWorkerId,
    setDataClass,
    setResourceIds,
    setReason
  } = props
  const selectedWorker = activeWorkers.find((worker) => worker.id === workerId)

  return (
    <div className="dws-form-grid">
      <label className="dws-field">
        <span>WorkItem</span>
        <select value={workItemId} onChange={(event) => setWorkItemId(event.target.value)} data-dws-field="work-item">
          {workItems.map((item) => (
            <option key={item.id} value={item.id}>{item.title}{item.status ? ` · ${item.status}` : ''}</option>
          ))}
        </select>
      </label>
      <label className="dws-field">
        <span>数字员工</span>
        <select value={workerId} onChange={(event) => setWorkerId(event.target.value)} data-dws-field="worker">
          {activeWorkers.map((worker) => <option key={worker.id} value={worker.id}>{worker.displayName}</option>)}
        </select>
      </label>
      <AssignmentScopeFields
        titleId={titleId}
        worker={selectedWorker}
        dataClass={dataClass}
        resourceIds={resourceIds}
        setDataClass={setDataClass}
        setResourceIds={setResourceIds}
      />
      <label className="dws-field dws-field-wide">
        <span>分配原因</span>
        <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={240} />
      </label>
      {currentAssignment && (
        <div className="dws-current-assignment dws-field-wide" role="status">
          {workItemTitle(currentAssignment.workItemId, workItems)} 当前已有负责人，提交后将保留历史并完成改派。
        </div>
      )}
    </div>
  )
}

export function AssignmentForm(props: AssignmentFormProps): React.JSX.Element {
  const { projectId, workItems, workers, assignments, initialWorkerId, busy, onCancel, onSubmit } = props
  const titleId = useId()
  const activeWorkers = workers.filter((worker) => worker.status === 'active')
  const [workItemId, setWorkItemId] = useState(workItems[0]?.id || '')
  const [workerId, setWorkerId] = useState(initialWorkerId || activeWorkers[0]?.id || '')
  const [dataClass, setDataClass] = useState('')
  const [resourceIds, setResourceIds] = useState('')
  const [reason, setReason] = useState('')

  const currentAssignment = assignments.find(
    (item) => item.projectId === projectId && item.workItemId === workItemId && item.status === 'active'
  )
  const unchanged = currentAssignment?.assigneeKind === 'digital_worker' && currentAssignment.assigneeId === workerId

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const scope = buildAssignmentScope(dataClass, resourceIds)
    if (await onSubmit(workItemId, workerId, scope, reason)) onCancel()
  }

  return (
    <form
      className="dws-editor"
      aria-labelledby={titleId}
      data-dws-form="assignment"
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) onCancel()
      }}
    >
      <div className="dws-editor-heading">
        <h3 id={titleId}>分配 WorkItem</h3>
        <button type="button" className="dws-button dws-button-quiet" onClick={onCancel} disabled={busy}>取消</button>
      </div>
      {workItems.length === 0 || activeWorkers.length === 0 ? (
        <div className="dws-inline-empty" role="status">
          {workItems.length === 0 ? '当前项目暂无 WorkItem。' : '当前项目暂无工作中的数字员工。'}
        </div>
      ) : (
        <AssignmentFields
          titleId={titleId}
          workItems={workItems}
          activeWorkers={activeWorkers}
          currentAssignment={currentAssignment}
          workItemId={workItemId}
          workerId={workerId}
          dataClass={dataClass}
          resourceIds={resourceIds}
          reason={reason}
          setWorkItemId={setWorkItemId}
          setWorkerId={setWorkerId}
          setDataClass={setDataClass}
          setResourceIds={setResourceIds}
          setReason={setReason}
        />
      )}
      <div className="dws-editor-actions">
        <button
          type="submit"
          className="dws-button dws-button-primary"
          disabled={busy || !workItemId || !workerId || unchanged}
        >
          {busy ? '分配中...' : unchanged ? '已分配' : '确认分配'}
        </button>
      </div>
    </form>
  )
}
