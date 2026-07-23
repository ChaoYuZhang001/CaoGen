import { useCallback, useMemo, useState } from 'react'
import type {
  WorkflowEvidenceSource,
  WorkflowWorkItemRecord
} from '../../../shared/types'
import {
  EVIDENCE_KINDS,
  EVIDENCE_SOURCES,
  errorMessage,
  newCriterion,
  newWorkflowId
} from './workflow-ledger-ui'
import type { CriterionDraft } from './workflow-ledger-ui'

interface AuthoringOptions {
  workItems: WorkflowWorkItemRecord[]
  selectedWorkItemId: string
  setSelectedWorkItemId: React.Dispatch<React.SetStateAction<string>>
  onRefresh: () => Promise<void>
}

export interface WorkflowAcceptanceAuthoringController {
  authoring: boolean
  selectedWorkItemId: string
  selectedWorkItem: WorkflowWorkItemRecord | undefined
  criteria: CriterionDraft[]
  saving: boolean
  error: string
  success: string
  toggleAuthoring: () => void
  setSelectedWorkItemId: React.Dispatch<React.SetStateAction<string>>
  reset: () => void
  updateCriterion: (index: number, patch: Partial<CriterionDraft>) => void
  toggleSource: (index: number, source: WorkflowEvidenceSource) => void
  removeCriterion: (index: number) => void
  addCriterion: () => void
  submit: (event: React.FormEvent<HTMLFormElement>) => Promise<void>
}

export function useWorkflowAcceptanceAuthoring({
  workItems,
  selectedWorkItemId,
  setSelectedWorkItemId,
  onRefresh
}: AuthoringOptions): WorkflowAcceptanceAuthoringController {
  const [authoring, setAuthoring] = useState(false)
  const [criteria, setCriteria] = useState<CriterionDraft[]>([newCriterion()])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const selectedWorkItem = useMemo(
    () => workItems.find((item) => item.id === selectedWorkItemId),
    [selectedWorkItemId, workItems]
  )

  const resetMessages = useCallback((): void => {
    setError('')
    setSuccess('')
  }, [])
  const toggleAuthoring = useCallback((): void => {
    setAuthoring((current) => !current)
    resetMessages()
  }, [resetMessages])
  const reset = useCallback((): void => {
    setCriteria([newCriterion()])
    resetMessages()
  }, [resetMessages])
  const updateCriterion = useCallback((index: number, patch: Partial<CriterionDraft>): void => {
    setCriteria((current) => current.map((criterion, criterionIndex) =>
      criterionIndex === index ? { ...criterion, ...patch } : criterion
    ))
  }, [])
  const toggleSource = useCallback((index: number, source: WorkflowEvidenceSource): void => {
    setCriteria((current) => current.map((criterion, criterionIndex) =>
      criterionIndex === index ? toggleCriterionSource(criterion, source) : criterion
    ))
  }, [])
  const removeCriterion = useCallback((index: number): void => {
    setCriteria((current) => current.filter((_, criterionIndex) => criterionIndex !== index))
  }, [])
  const addCriterion = useCallback((): void => {
    setCriteria((current) => [...current, newCriterion()])
  }, [])
  const submit = useCallback(async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    resetMessages()
    const normalizedCriteria = normalizeCriteria(criteria)
    const validationError = validateAcceptance(selectedWorkItem, normalizedCriteria)
    if (validationError) {
      setError(validationError)
      return
    }
    setSaving(true)
    try {
      const saved = await saveAcceptance(selectedWorkItem!, normalizedCriteria)
      setSuccess(`已创建 pending Acceptance ${saved.id}`)
      setCriteria([newCriterion()])
      await onRefresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }, [criteria, onRefresh, resetMessages, selectedWorkItem])

  return {
    authoring, selectedWorkItemId, selectedWorkItem, criteria, saving, error, success,
    toggleAuthoring, setSelectedWorkItemId, reset, updateCriterion, toggleSource,
    removeCriterion, addCriterion, submit
  }
}

function toggleCriterionSource(
  criterion: CriterionDraft,
  source: WorkflowEvidenceSource
): CriterionDraft {
  const allowedSources = criterion.allowedSources.includes(source)
    ? criterion.allowedSources.filter((candidate) => candidate !== source)
    : [...criterion.allowedSources, source]
  return { ...criterion, allowedSources }
}

function normalizeCriteria(criteria: CriterionDraft[]): CriterionDraft[] {
  return criteria.map((criterion) => ({
    ...criterion,
    criterion: criterion.criterion.trim(),
    allowedSources: [...new Set(criterion.allowedSources)]
  }))
}

function validateAcceptance(
  selectedWorkItem: WorkflowWorkItemRecord | undefined,
  criteria: CriterionDraft[]
): string {
  if (!selectedWorkItem?.projectId) return '所选 WorkItem 缺少 Project 归属，已拒绝保存'
  if (criteria.some((criterion) => !criterion.criterion)) return '每个 criterion 都必须填写内容'
  if (criteria.some((criterion) => criterion.allowedSources.length === 0)) {
    return '每个 criterion 至少需要一个允许的 Evidence source'
  }
  return ''
}

async function saveAcceptance(
  workItem: WorkflowWorkItemRecord,
  criteria: CriterionDraft[]
): Promise<{ id: string }> {
  return window.agentDesk.saveWorkflowAcceptance({
    id: newWorkflowId('acceptance'),
    projectId: workItem.projectId!,
    ...(workItem.goalId === undefined ? {} : { goalId: workItem.goalId }),
    workItemId: workItem.id,
    criteria: criteria.map((criterion) => criterion.criterion),
    criterionPolicies: criteria.map((criterion, criterionIndex) => ({
      criterionId: criterion.id,
      criterionIndex,
      evidenceKind: criterion.evidenceKind,
      allowedSources: criterion.allowedSources
    })),
    status: 'pending'
  })
}

export function WorkflowAcceptanceAuthoring({
  workItems,
  controller
}: {
  workItems: WorkflowWorkItemRecord[]
  controller: WorkflowAcceptanceAuthoringController
}): React.JSX.Element {
  return (
    <form className="workflow-acceptance-authoring" onSubmit={(event) => void controller.submit(event)}>
      <div className="workflow-acceptance-authoring-head">
        <div>
          <h4>Acceptance policy authoring</h4>
          <p className="settings-hint">策略在创建时冻结；保存后只能通过新的 revision/retest 流程改变状态。</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={controller.reset} disabled={controller.saving}>
          清空
        </button>
      </div>
      <label className="field-label" htmlFor="workflow-acceptance-work-item">WorkItem</label>
      <select
        id="workflow-acceptance-work-item"
        className="select select-block"
        value={controller.selectedWorkItemId}
        onChange={(event) => controller.setSelectedWorkItemId(event.target.value)}
        disabled={controller.saving}
      >
        {workItems.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.id}</option>)}
      </select>
      <div className="workflow-criterion-list">
        {controller.criteria.map((criterion, index) => (
          <CriterionEditor
            key={criterion.id}
            criterion={criterion}
            index={index}
            canRemove={controller.criteria.length > 1}
            disabled={controller.saving}
            onChange={controller.updateCriterion}
            onToggleSource={controller.toggleSource}
            onRemove={() => controller.removeCriterion(index)}
          />
        ))}
      </div>
      <div className="workflow-acceptance-authoring-actions">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={controller.addCriterion}
          disabled={controller.saving || controller.criteria.length >= 32}
        >
          添加 criterion
        </button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={controller.saving || !controller.selectedWorkItem}>
          {controller.saving ? '保存中...' : '保存 pending Acceptance'}
        </button>
      </div>
      {controller.error && <div className="notice notice-error">{controller.error}</div>}
      {controller.success && <div className="notice notice-success">{controller.success}</div>}
    </form>
  )
}

function CriterionEditor({
  criterion,
  index,
  canRemove,
  disabled,
  onChange,
  onToggleSource,
  onRemove
}: {
  criterion: CriterionDraft
  index: number
  canRemove: boolean
  disabled: boolean
  onChange: (index: number, patch: Partial<CriterionDraft>) => void
  onToggleSource: (index: number, source: WorkflowEvidenceSource) => void
  onRemove: () => void
}): React.JSX.Element {
  return (
    <fieldset className="workflow-criterion-editor">
      <div className="workflow-criterion-editor-head">
        <legend>Criterion {index + 1}</legend>
        <button type="button" className="btn btn-ghost btn-xs" onClick={onRemove} disabled={!canRemove || disabled}>
          移除
        </button>
      </div>
      <label className="field-label" htmlFor={`workflow-criterion-${criterion.id}`}>内容</label>
      <textarea
        id={`workflow-criterion-${criterion.id}`}
        className="input workflow-criterion-input"
        value={criterion.criterion}
        onChange={(event) => onChange(index, { criterion: event.target.value })}
        rows={2}
        maxLength={2000}
        disabled={disabled}
        required
      />
      <div className="workflow-criterion-policy-grid">
        <label>
          <span className="field-label">Evidence kind</span>
          <select
            className="select select-block"
            value={criterion.evidenceKind}
            onChange={(event) => onChange(index, { evidenceKind: event.target.value as CriterionDraft['evidenceKind'] })}
            disabled={disabled}
          >
            {EVIDENCE_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
          </select>
        </label>
        <div>
          <span className="field-label">Allowed sources</span>
          <div className="workflow-policy-sources">
            {EVIDENCE_SOURCES.map((source) => (
              <label className="workflow-policy-source" key={source}>
                <input
                  type="checkbox"
                  checked={criterion.allowedSources.includes(source)}
                  onChange={() => onToggleSource(index, source)}
                  disabled={disabled}
                />
                <span>{source}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
    </fieldset>
  )
}
