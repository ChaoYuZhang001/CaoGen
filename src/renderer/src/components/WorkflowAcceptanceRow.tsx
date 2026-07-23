import { useState } from 'react'
import type {
  WorkflowAcceptanceRecord,
  WorkflowAcceptanceReviewDecision,
  WorkflowEvidenceKind,
  WorkflowEvidenceRecord
} from '../../../shared/types'
import { EVIDENCE_KINDS, errorMessage, newWorkflowId } from './workflow-ledger-ui'

interface ReviewState {
  addingEvidence: boolean
  setAddingEvidence: React.Dispatch<React.SetStateAction<boolean>>
  evidenceKind: WorkflowEvidenceKind
  setEvidenceKind: React.Dispatch<React.SetStateAction<WorkflowEvidenceKind>>
  evidenceTitle: string
  setEvidenceTitle: React.Dispatch<React.SetStateAction<string>>
  evidenceSummary: string
  setEvidenceSummary: React.Dispatch<React.SetStateAction<string>>
  selectedEvidence: Record<number, string[]>
  setSelectedEvidence: React.Dispatch<React.SetStateAction<Record<number, string[]>>>
  waiverReason: string
  setWaiverReason: React.Dispatch<React.SetStateAction<string>>
  busy: boolean
  setBusy: React.Dispatch<React.SetStateAction<boolean>>
  error: string
  setError: React.Dispatch<React.SetStateAction<string>>
  success: string
  setSuccess: React.Dispatch<React.SetStateAction<string>>
}

function useReviewState(acceptance: WorkflowAcceptanceRecord): ReviewState {
  const [addingEvidence, setAddingEvidence] = useState(false)
  const [evidenceKind, setEvidenceKind] = useState<WorkflowEvidenceKind>(
    acceptance.criterionPolicies?.[0]?.evidenceKind ?? 'test_result'
  )
  const [evidenceTitle, setEvidenceTitle] = useState('')
  const [evidenceSummary, setEvidenceSummary] = useState('')
  const [selectedEvidence, setSelectedEvidence] = useState<Record<number, string[]>>({})
  const [waiverReason, setWaiverReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  return {
    addingEvidence, setAddingEvidence, evidenceKind, setEvidenceKind,
    evidenceTitle, setEvidenceTitle, evidenceSummary, setEvidenceSummary,
    selectedEvidence, setSelectedEvidence, waiverReason, setWaiverReason,
    busy, setBusy, error, setError, success, setSuccess
  }
}

export function WorkflowAcceptanceRow({
  acceptance,
  evidence,
  onRefresh
}: {
  acceptance: WorkflowAcceptanceRecord
  evidence: WorkflowEvidenceRecord[]
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const state = useReviewState(acceptance)
  const reviewable = acceptance.status === 'pending' || acceptance.status === 'verifying'
  const onAddEvidence = (event: React.FormEvent<HTMLFormElement>): void => {
    void addEvidence(event, acceptance, state, onRefresh)
  }
  const onReview = (decision: WorkflowAcceptanceReviewDecision): void => {
    void reviewAcceptance(decision, acceptance, state, onRefresh)
  }

  return (
    <div className="workflow-acceptance-row" data-acceptance-review={acceptance.id}>
      <div className="workflow-ledger-row-main">
        <strong>{acceptance.status} · {acceptance.id}</strong>
        <span className="workflow-ledger-meta">{acceptance.criteria.length} criteria · revision {acceptance.revision}</span>
      </div>
      <AcceptancePolicyList acceptance={acceptance} />
      {reviewable && (
        <AcceptanceReviewPanel
          acceptance={acceptance}
          evidence={evidence}
          state={state}
          onAddEvidence={onAddEvidence}
          onReview={onReview}
        />
      )}
      {acceptance.status === 'failed' && (
        <FailedAcceptanceReview state={state} onReview={onReview} />
      )}
    </div>
  )
}

function AcceptancePolicyList({ acceptance }: { acceptance: WorkflowAcceptanceRecord }): React.JSX.Element {
  return (
    <div className="workflow-acceptance-policy-list">
      {acceptance.criterionPolicies?.map((policy) => (
        <span className="workflow-acceptance-policy" key={`${acceptance.id}:${policy.criterionId}`}>
          {policy.criterionIndex + 1}: {policy.evidenceKind} / {policy.allowedSources.join(', ')}
        </span>
      )) ?? <span className="workflow-ledger-meta">legacy policy</span>}
    </div>
  )
}

function AcceptanceReviewPanel({
  acceptance,
  evidence,
  state,
  onAddEvidence,
  onReview
}: {
  acceptance: WorkflowAcceptanceRecord
  evidence: WorkflowEvidenceRecord[]
  state: ReviewState
  onAddEvidence: (event: React.FormEvent<HTMLFormElement>) => void
  onReview: (decision: WorkflowAcceptanceReviewDecision) => void
}): React.JSX.Element {
  return (
    <div className="workflow-acceptance-review">
      <div className="workflow-acceptance-review-head">
        <strong>Review / Evidence</strong>
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          data-acceptance-add-evidence
          onClick={() => toggleEvidenceAuthoring(state)}
          disabled={state.busy}
        >
          {state.addingEvidence ? '取消 Evidence' : '添加 Evidence'}
        </button>
      </div>
      {state.addingEvidence && <EvidenceAuthoringForm state={state} onSubmit={onAddEvidence} />}
      <CriterionReviewList acceptance={acceptance} evidence={evidence} state={state} />
      <label className="field-label workflow-waiver-field">
        Waiver reason
        <input
          className="input"
          value={state.waiverReason}
          onChange={(event) => state.setWaiverReason(event.target.value)}
          disabled={state.busy}
          placeholder="仅在豁免时填写"
          data-acceptance-waiver-reason
        />
      </label>
      <ReviewActions busy={state.busy} onReview={onReview} />
      {state.error && <div className="notice notice-error">{state.error}</div>}
      {state.success && <div className="notice notice-success">{state.success}</div>}
    </div>
  )
}

function EvidenceAuthoringForm({
  state,
  onSubmit
}: {
  state: ReviewState
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}): React.JSX.Element {
  return (
    <form className="workflow-evidence-authoring" onSubmit={onSubmit}>
      <label className="field-label">
        Evidence kind
        <select
          className="select select-block"
          value={state.evidenceKind}
          onChange={(event) => state.setEvidenceKind(event.target.value as WorkflowEvidenceKind)}
          disabled={state.busy}
          data-acceptance-evidence-kind
        >
          {EVIDENCE_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
        </select>
      </label>
      <label className="field-label">
        标题
        <input
          className="input"
          value={state.evidenceTitle}
          onChange={(event) => state.setEvidenceTitle(event.target.value)}
          disabled={state.busy}
          required
          data-acceptance-evidence-title
        />
      </label>
      <label className="field-label">
        摘要
        <textarea
          className="input workflow-evidence-summary-input"
          value={state.evidenceSummary}
          onChange={(event) => state.setEvidenceSummary(event.target.value)}
          disabled={state.busy}
          rows={2}
          data-acceptance-evidence-summary
        />
      </label>
      <button type="submit" className="btn btn-primary btn-xs" disabled={state.busy} data-acceptance-save-evidence>
        {state.busy ? '保存中...' : '保存 Evidence'}
      </button>
    </form>
  )
}

function CriterionReviewList({
  acceptance,
  evidence,
  state
}: {
  acceptance: WorkflowAcceptanceRecord
  evidence: WorkflowEvidenceRecord[]
  state: ReviewState
}): React.JSX.Element {
  return (
    <div className="workflow-criterion-review-list">
      {acceptance.criteria.map((criterion, criterionIndex) => (
        <CriterionReview
          key={`${acceptance.id}:review:${criterionIndex}`}
          acceptance={acceptance}
          criterion={criterion}
          criterionIndex={criterionIndex}
          evidence={evidence}
          state={state}
        />
      ))}
    </div>
  )
}

function CriterionReview({
  acceptance,
  criterion,
  criterionIndex,
  evidence,
  state
}: {
  acceptance: WorkflowAcceptanceRecord
  criterion: string
  criterionIndex: number
  evidence: WorkflowEvidenceRecord[]
  state: ReviewState
}): React.JSX.Element {
  const policy = policyFor(acceptance, criterionIndex)
  const candidates = eligibleEvidence(evidence, policy)
  const selected = state.selectedEvidence[criterionIndex] ?? []
  return (
    <fieldset className="workflow-criterion-review">
      <legend>Criterion {criterionIndex + 1}: {criterion}</legend>
      {candidates.length === 0 ? (
        <span className="workflow-ledger-meta">暂无匹配 Evidence（要求 {policy?.evidenceKind ?? '任意 kind'} / {policy?.allowedSources.join(', ') ?? '任意 source'}）</span>
      ) : candidates.map((record) => (
        <label className="workflow-evidence-option" key={record.evidenceId}>
          <input
            type="checkbox"
            checked={selected.includes(record.evidenceId)}
            onChange={() => toggleSelectedEvidence(state, criterionIndex, record.evidenceId)}
            disabled={state.busy}
            data-acceptance-evidence-id={record.evidenceId}
          />
          <span>{record.title} · {record.kind} · {record.source}</span>
        </label>
      ))}
    </fieldset>
  )
}

function ReviewActions({
  busy,
  onReview
}: {
  busy: boolean
  onReview: (decision: WorkflowAcceptanceReviewDecision) => void
}): React.JSX.Element {
  return (
    <div className="workflow-acceptance-review-actions">
      <button type="button" className="btn btn-primary btn-xs" onClick={() => onReview('passed')} disabled={busy} data-acceptance-decision="passed">通过</button>
      <button type="button" className="btn btn-ghost btn-xs" onClick={() => onReview('failed')} disabled={busy} data-acceptance-decision="failed">标记失败</button>
      <button type="button" className="btn btn-ghost btn-xs" onClick={() => onReview('waived')} disabled={busy} data-acceptance-decision="waived">豁免</button>
    </div>
  )
}

function FailedAcceptanceReview({
  state,
  onReview
}: {
  state: ReviewState
  onReview: (decision: WorkflowAcceptanceReviewDecision) => void
}): React.JSX.Element {
  return (
    <div className="workflow-acceptance-review workflow-acceptance-retest">
      <button type="button" className="btn btn-ghost btn-xs" onClick={() => onReview('retest')} disabled={state.busy} data-acceptance-decision="retest">开始重测</button>
      {state.error && <div className="notice notice-error">{state.error}</div>}
      {state.success && <div className="notice notice-success">{state.success}</div>}
    </div>
  )
}

function toggleEvidenceAuthoring(state: ReviewState): void {
  state.setAddingEvidence((current) => !current)
  state.setError('')
}

function toggleSelectedEvidence(state: ReviewState, criterionIndex: number, evidenceId: string): void {
  state.setSelectedEvidence((current) => {
    const selected = current[criterionIndex] ?? []
    const next = selected.includes(evidenceId)
      ? selected.filter((id) => id !== evidenceId)
      : [...selected, evidenceId]
    return { ...current, [criterionIndex]: next }
  })
}

function policyFor(acceptance: WorkflowAcceptanceRecord, criterionIndex: number) {
  return acceptance.criterionPolicies?.find((policy) => policy.criterionIndex === criterionIndex)
}

function eligibleEvidence(
  evidence: WorkflowEvidenceRecord[],
  policy: ReturnType<typeof policyFor>
): WorkflowEvidenceRecord[] {
  return evidence.filter((record) =>
    (!policy || record.kind === policy.evidenceKind) &&
    (!policy || policy.allowedSources.includes(record.source))
  )
}

async function addEvidence(
  event: React.FormEvent<HTMLFormElement>,
  acceptance: WorkflowAcceptanceRecord,
  state: ReviewState,
  onRefresh: () => Promise<void>
): Promise<void> {
  event.preventDefault()
  state.setError('')
  state.setSuccess('')
  const title = state.evidenceTitle.trim()
  const summary = state.evidenceSummary.trim()
  if (!title || !acceptance.projectId) {
    state.setError('Evidence title 和 Project 归属不能为空')
    return
  }
  state.setBusy(true)
  try {
    await window.agentDesk.createWorkflowEvidence({
      evidenceId: newWorkflowId('evidence'),
      projectId: acceptance.projectId,
      ...(acceptance.goalId === undefined ? {} : { goalId: acceptance.goalId }),
      ...(acceptance.workItemId === undefined ? {} : { workItemId: acceptance.workItemId }),
      kind: state.evidenceKind,
      title,
      ...(summary ? { summary } : {}),
      contentDigest: await sha256(`${title}\n${summary}`)
    })
    state.setEvidenceTitle('')
    state.setEvidenceSummary('')
    state.setAddingEvidence(false)
    state.setSuccess('Evidence 已记录；请选择它覆盖对应 criterion')
    await onRefresh()
  } catch (cause) {
    state.setError(errorMessage(cause))
  } finally {
    state.setBusy(false)
  }
}

async function reviewAcceptance(
  decision: WorkflowAcceptanceReviewDecision,
  acceptance: WorkflowAcceptanceRecord,
  state: ReviewState,
  onRefresh: () => Promise<void>
): Promise<void> {
  state.setError('')
  state.setSuccess('')
  if (decision === 'waived' && !state.waiverReason.trim()) {
    state.setError('豁免必须填写理由')
    return
  }
  const criterionEvidence = acceptance.criteria.map((_, criterionIndex) => ({
    criterionIndex,
    evidenceRefs: [...new Set(state.selectedEvidence[criterionIndex] ?? [])]
  }))
  if (requiresEvidence(decision) && criterionEvidence.some((item) => item.evidenceRefs.length === 0)) {
    state.setError('通过或失败前必须为每个 criterion 选择 Evidence')
    return
  }
  state.setBusy(true)
  try {
    await window.agentDesk.reviewWorkflowAcceptance({
      acceptanceId: acceptance.id,
      criterionEvidence: decision === 'waived' || decision === 'retest' ? [] : criterionEvidence,
      decision,
      ...(decision === 'waived' ? { waiverReason: state.waiverReason.trim() } : {})
    })
    state.setSuccess(`Acceptance 已${reviewDecisionLabel(decision)}`)
    state.setSelectedEvidence({})
    state.setWaiverReason('')
    await onRefresh()
  } catch (cause) {
    state.setError(errorMessage(cause))
  } finally {
    state.setBusy(false)
  }
}

function requiresEvidence(decision: WorkflowAcceptanceReviewDecision): boolean {
  return decision === 'passed' || decision === 'failed'
}

function reviewDecisionLabel(decision: WorkflowAcceptanceReviewDecision): string {
  if (decision === 'passed') return '通过'
  if (decision === 'failed') return '标记失败'
  if (decision === 'retest') return '进入重测'
  return '豁免'
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const result = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
