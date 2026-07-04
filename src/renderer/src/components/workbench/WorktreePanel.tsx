import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import { useT } from '../../i18n'

function shortSha(sha?: string): string {
  return sha ? sha.slice(0, 8) : ''
}

export default function WorktreePanel(): React.JSX.Element {
  const t = useT()
  const activeId = useStore((s) => s.activeId)
  const session = useStore((s) => (s.activeId ? s.sessions[s.activeId] : undefined))
  const { worktree, worktreeError, worktreeLoading, worktreeMessage } = useStore((s) => s.workbench)
  const refresh = useStore((s) => s.refreshWorktreePanel)
  const close = useStore((s) => s.closeWorktreePanel)
  const openDiff = useStore((s) => s.openDiffPanel)
  const exportPatch = useStore((s) => s.exportWorktreePatch)
  const removeWorktree = useStore((s) => s.removeWorktree)
  const [removing, setRemoving] = useState(false)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    if (activeId) void refresh()
  }, [activeId, refresh])

  const record = worktree?.record
  const isolated = Boolean(session?.meta.isolated || worktree?.isolated)

  const onExport = async (): Promise<void> => {
    setExporting(true)
    await exportPatch()
    setExporting(false)
  }

  const onRemove = async (): Promise<void> => {
    const ok = window.confirm(t('worktreeRemoveConfirm'))
    if (!ok) return
    setRemoving(true)
    await removeWorktree({ deleteBranch: true, force: true })
    await refresh()
    setRemoving(false)
  }

  return (
    <div className="worktree-panel">
      <header className="workspace-diff-top">
        <div>
          <div className="workspace-diff-title">{t('worktreePanelTitle')}</div>
          <div className="workspace-diff-sub">{record?.worktreePath ?? session?.meta.cwd ?? ''}</div>
        </div>
        <div className="workspace-diff-actions">
          <button className="btn btn-ghost btn-sm" disabled={worktreeLoading} onClick={() => void refresh()}>
            {worktreeLoading ? t('loadingDiff') : t('refresh')}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={close}>
            {t('close')}
          </button>
        </div>
      </header>

      <div className="worktree-panel-body">
        {worktreeError && <div className="notice notice-error">{worktreeError}</div>}
        {worktreeMessage && <div className="notice notice-info">{worktreeMessage}</div>}
        {worktreeLoading && !worktree && <div className="workspace-diff-empty">{t('loadingDiff')}</div>}

        {!isolated ? (
          <div className="workspace-diff-empty">{t('worktreeNotIsolated')}</div>
        ) : record ? (
          <>
            <div className="worktree-stats">
              <div className="worktree-stat">
                <span>{t('worktreeBranch')}</span>
                <b>{record.branch}</b>
              </div>
              <div className="worktree-stat">
                <span>{t('worktreeBase')}</span>
                <b>
                  {record.baseBranch ?? 'detached'} · {shortSha(record.baseSha)}
                </b>
              </div>
              <div className="worktree-stat">
                <span>{t('worktreeChangedFiles')}</span>
                <b>
                  {worktree?.changedFiles ?? 0}
                  {worktree?.insertions !== undefined &&
                    ` · +${worktree.insertions}/-${worktree.deletions ?? 0}`}
                </b>
              </div>
              <div className="worktree-stat">
                <span>{t('worktreeState')}</span>
                <b>{record.state}</b>
              </div>
            </div>

            <div className="worktree-paths">
              <div>
                <span>{t('worktreeSource')}</span>
                <code>{record.sourceCwd}</code>
              </div>
              <div>
                <span>{t('worktreePath')}</span>
                <code>{record.worktreePath}</code>
              </div>
            </div>

            <div className="worktree-actions">
              <button className="btn btn-ghost" onClick={() => void openDiff()}>
                {t('worktreeOpenDiff')}
              </button>
              <button className="btn btn-ghost" disabled={exporting} onClick={() => void onExport()}>
                {exporting ? t('exportingPatch') : t('worktreeExportPatch')}
              </button>
              <button className="btn btn-danger" disabled={removing} onClick={() => void onRemove()}>
                {removing ? t('removingWorktree') : t('worktreeRemove')}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
