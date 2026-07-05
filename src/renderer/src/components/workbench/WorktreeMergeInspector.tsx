import type { ReactNode } from 'react'

const PATCH_PREVIEW_LIMIT = 12_000

export type WorktreeMergeConflictRisk = 'low' | 'medium' | 'unknown'

export interface WorktreeMergeFailure {
  ok: false
  error: string
}

export interface WorktreeMergeSummarySuccess {
  ok: true
  repoRoot: string
  worktreePath: string
  baseSha: string
  headSha: string
  changedFiles: number
  insertions: number
  deletions: number
  conflictRisk: WorktreeMergeConflictRisk
}

export type WorktreeMergeSummaryResult = WorktreeMergeSummarySuccess | WorktreeMergeFailure

export interface WorktreeMergePatchSuccess {
  ok: true
  repoRoot?: string
  worktreePath?: string
  baseSha?: string
  headSha?: string
  path?: string
  patchText?: string
  bytes?: number
}

export type WorktreeMergePatchResult = WorktreeMergePatchSuccess | WorktreeMergeFailure

export type WorktreeMergeApplyCheckResult =
  | { ok: true; canApply: true }
  | { ok: true; canApply: false; error: string }
  | WorktreeMergeFailure

export type WorktreeMergePullRequestResult =
  | {
      ok: true
      created: true
      tool: 'gh' | 'glab'
      branch: string
      url: string
      pushed: boolean
    }
  | { ok: true; created: false; message: string }
  | WorktreeMergeFailure

export interface WorktreeMergeInspectorLabels {
  title?: string
  subtitle?: string
  inspect?: string
  inspecting?: string
  apply?: string
  applying?: string
  createPr?: string
  creatingPr?: string
  summary?: string
  patch?: string
  applyCheck?: string
  emptySummary?: string
  emptyPatch?: string
  emptyApplyCheck?: string
}

export interface WorktreeMergeInspectorProps {
  summary?: WorktreeMergeSummaryResult
  patch?: WorktreeMergePatchResult
  applyCheck?: WorktreeMergeApplyCheckResult
  prResult?: WorktreeMergePullRequestResult
  isInspecting?: boolean
  isApplying?: boolean
  isCreatingPr?: boolean
  inspectDisabled?: boolean
  applyDisabled?: boolean
  createPrDisabled?: boolean
  labels?: WorktreeMergeInspectorLabels
  className?: string
  onInspect?: () => void | Promise<void>
  onApply?: () => void | Promise<void>
  onCreatePr?: () => void | Promise<void>
}

function cx(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

function shortSha(sha?: string): string {
  return sha ? sha.slice(0, 8) : ''
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function riskLabel(risk: WorktreeMergeConflictRisk): string {
  if (risk === 'low') return 'Low risk'
  if (risk === 'medium') return 'Conflict risk'
  return 'Unknown risk'
}

function riskWarning(
  summary: WorktreeMergeSummaryResult | undefined,
  applyCheck: WorktreeMergeApplyCheckResult | undefined
): { tone: 'safe' | 'medium' | 'unknown'; message: string } | undefined {
  // 优先看 apply --check 的硬结论:无法干净应用 = 明确冲突。
  if (applyCheck?.ok && applyCheck.canApply === false) {
    return { tone: 'medium', message: `Conflicts likely — git apply --check failed: ${applyCheck.error}` }
  }
  if (applyCheck && !applyCheck.ok) {
    return { tone: 'unknown', message: `Cannot auto-apply — ${applyCheck.error}` }
  }
  if (!summary || !summary.ok) return undefined
  if (summary.conflictRisk === 'medium') {
    return { tone: 'medium', message: 'Conflicts likely — review the patch before applying to the main workspace.' }
  }
  if (summary.conflictRisk === 'unknown') {
    return { tone: 'unknown', message: 'Cannot auto-apply — conflict risk could not be determined.' }
  }
  return { tone: 'safe', message: 'Safe — the patch applies cleanly to the main workspace.' }
}

function patchPreview(patchText: string | undefined): { text: string; truncated: boolean } | undefined {
  if (patchText === undefined) return undefined
  if (patchText.length <= PATCH_PREVIEW_LIMIT) return { text: patchText, truncated: false }
  return { text: patchText.slice(0, PATCH_PREVIEW_LIMIT), truncated: true }
}

function KeyValue({
  label,
  value,
  mono = false
}: {
  label: string
  value: ReactNode
  mono?: boolean
}): React.JSX.Element {
  const displayValue = value === undefined || value === null || value === '' ? '-' : value
  return (
    <div className="worktree-merge-stat">
      <span className="worktree-merge-label">{label}</span>
      <b className={cx('worktree-merge-value', mono && 'worktree-merge-code')}>{displayValue}</b>
    </div>
  )
}

function Section({
  title,
  tone,
  status,
  children
}: {
  title: string
  tone: string
  status: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className="worktree-merge-section">
      <header className="worktree-merge-section-head">
        <h3 className="worktree-merge-section-title">{title}</h3>
        <span className={cx('worktree-merge-pill', `worktree-merge-pill-${tone}`)}>{status}</span>
      </header>
      {children}
    </section>
  )
}

function ErrorBlock({ error }: { error: string }): React.JSX.Element {
  return <div className="worktree-merge-error">{error}</div>
}

function EmptyBlock({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="worktree-merge-empty">{children}</div>
}

function SummarySection({
  result,
  title,
  emptyLabel
}: {
  result?: WorktreeMergeSummaryResult
  title: string
  emptyLabel: string
}): React.JSX.Element {
  if (!result) {
    return (
      <Section title={title} tone="idle" status="Pending">
        <EmptyBlock>{emptyLabel}</EmptyBlock>
      </Section>
    )
  }

  if (!result.ok) {
    return (
      <Section title={title} tone="error" status="Failed">
        <ErrorBlock error={result.error} />
      </Section>
    )
  }

  return (
    <Section title={title} tone={result.conflictRisk} status={riskLabel(result.conflictRisk)}>
      <div className="worktree-merge-grid">
        <KeyValue label="Files" value={result.changedFiles} />
        <KeyValue label="Insertions" value={`+${result.insertions}`} />
        <KeyValue label="Deletions" value={`-${result.deletions}`} />
        <KeyValue label="Head" value={shortSha(result.headSha)} mono />
        <KeyValue label="Base" value={shortSha(result.baseSha)} mono />
        <KeyValue label="Risk" value={riskLabel(result.conflictRisk)} />
      </div>
      <div className="worktree-merge-paths">
        <div className="worktree-merge-path-row">
          <span className="worktree-merge-label">Repo</span>
          <code className="worktree-merge-code">{result.repoRoot}</code>
        </div>
        <div className="worktree-merge-path-row">
          <span className="worktree-merge-label">Worktree</span>
          <code className="worktree-merge-code">{result.worktreePath}</code>
        </div>
      </div>
    </Section>
  )
}

function PatchSection({
  result,
  title,
  emptyLabel
}: {
  result?: WorktreeMergePatchResult
  title: string
  emptyLabel: string
}): React.JSX.Element {
  if (!result) {
    return (
      <Section title={title} tone="idle" status="Pending">
        <EmptyBlock>{emptyLabel}</EmptyBlock>
      </Section>
    )
  }

  if (!result.ok) {
    return (
      <Section title={title} tone="error" status="Failed">
        <ErrorBlock error={result.error} />
      </Section>
    )
  }

  const preview = patchPreview(result.patchText)
  const previewText = preview?.text.trim() ? preview.text : ''

  return (
    <Section title={title} tone="ready" status={formatBytes(result.bytes) || 'Ready'}>
      <div className="worktree-merge-grid">
        <KeyValue label="Bytes" value={formatBytes(result.bytes)} />
        <KeyValue label="Head" value={shortSha(result.headSha)} mono />
        <KeyValue label="Base" value={shortSha(result.baseSha)} mono />
      </div>
      {result.path && (
        <div className="worktree-merge-paths">
          <div className="worktree-merge-path-row">
            <span className="worktree-merge-label">Patch</span>
            <code className="worktree-merge-code">{result.path}</code>
          </div>
        </div>
      )}
      {preview ? (
        previewText ? (
          <pre className="worktree-merge-pre">
            {preview.text}
            {preview.truncated ? '\n... truncated' : ''}
          </pre>
        ) : (
          <EmptyBlock>Empty patch</EmptyBlock>
        )
      ) : null}
    </Section>
  )
}

function ApplyCheckSection({
  result,
  title,
  emptyLabel
}: {
  result?: WorktreeMergeApplyCheckResult
  title: string
  emptyLabel: string
}): React.JSX.Element {
  if (!result) {
    return (
      <Section title={title} tone="idle" status="Pending">
        <EmptyBlock>{emptyLabel}</EmptyBlock>
      </Section>
    )
  }

  if (!result.ok) {
    return (
      <Section title={title} tone="error" status="Failed">
        <ErrorBlock error={result.error} />
      </Section>
    )
  }

  if (!result.canApply) {
    return (
      <Section title={title} tone="blocked" status="Blocked">
        <ErrorBlock error={result.error} />
      </Section>
    )
  }

  return (
    <Section title={title} tone="clean" status="Clean">
      <div className="worktree-merge-check-message">git apply --check passed.</div>
    </Section>
  )
}

function PrResultBlock({ result }: { result: WorktreeMergePullRequestResult }): React.JSX.Element {
  if (!result.ok) {
    return <div className="notice notice-error worktree-merge-pr-result">{result.error}</div>
  }
  if (!result.created) {
    return <div className="notice notice-info worktree-merge-pr-result">{result.message}</div>
  }
  return (
    <div className="notice notice-info worktree-merge-pr-result">
      {result.tool.toUpperCase()} · {result.branch} → <code className="worktree-merge-code">{result.url}</code>
    </div>
  )
}

export default function WorktreeMergeInspector({
  summary,
  patch,
  applyCheck,
  prResult,
  isInspecting = false,
  isApplying = false,
  isCreatingPr = false,
  inspectDisabled = false,
  applyDisabled = false,
  createPrDisabled = false,
  labels,
  className,
  onInspect,
  onApply,
  onCreatePr
}: WorktreeMergeInspectorProps): React.JSX.Element {
  const applyBlockedByCheck = applyCheck !== undefined && (!applyCheck.ok || !applyCheck.canApply)
  const inspectLabel = isInspecting ? (labels?.inspecting ?? 'Inspecting...') : (labels?.inspect ?? 'Inspect')
  const applyLabel = isApplying ? (labels?.applying ?? 'Applying...') : (labels?.apply ?? 'Apply')
  const createPrLabel = isCreatingPr
    ? (labels?.creatingPr ?? 'Creating PR...')
    : (labels?.createPr ?? 'Create PR')
  const warning = riskWarning(summary, applyCheck)

  return (
    <div className={cx('worktree-merge-inspector', className)}>
      <header className="worktree-merge-header">
        <div className="worktree-merge-heading">
          <h2 className="worktree-merge-title">{labels?.title ?? 'Worktree merge'}</h2>
          {labels?.subtitle && <div className="worktree-merge-subtitle">{labels.subtitle}</div>}
        </div>
        <div className="worktree-merge-actions">
          <button
            className="btn btn-ghost btn-sm worktree-merge-action"
            disabled={!onInspect || inspectDisabled || isInspecting}
            onClick={() => void onInspect?.()}
          >
            {inspectLabel}
          </button>
          <button
            className="btn btn-primary btn-sm worktree-merge-action"
            disabled={!onApply || applyDisabled || isApplying || applyBlockedByCheck}
            onClick={() => void onApply?.()}
          >
            {applyLabel}
          </button>
          <button
            className="btn btn-ghost btn-sm worktree-merge-action"
            disabled={!onCreatePr || createPrDisabled || isCreatingPr}
            onClick={() => void onCreatePr?.()}
          >
            {createPrLabel}
          </button>
        </div>
      </header>

      {warning && (
        <div
          className={cx(
            'worktree-merge-risk',
            `worktree-merge-pill-${warning.tone}`,
            'notice',
            warning.tone === 'safe' ? 'notice-info' : 'notice-error'
          )}
          role={warning.tone === 'safe' ? undefined : 'alert'}
        >
          {warning.message}
        </div>
      )}

      {prResult && <PrResultBlock result={prResult} />}

      <div className="worktree-merge-content">
        <SummarySection
          result={summary}
          title={labels?.summary ?? 'Summary'}
          emptyLabel={labels?.emptySummary ?? 'No summary result.'}
        />
        <PatchSection
          result={patch}
          title={labels?.patch ?? 'Patch'}
          emptyLabel={labels?.emptyPatch ?? 'No patch result.'}
        />
        <ApplyCheckSection
          result={applyCheck}
          title={labels?.applyCheck ?? 'Apply check'}
          emptyLabel={labels?.emptyApplyCheck ?? 'No apply check result.'}
        />
      </div>
    </div>
  )
}
