import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../../store'
import { useT } from '../../i18n'
import type { GitFileStatus, WorkspaceDiffFile, WorkspaceDiffLine } from '../../../../shared/types'

function fileLabel(file: WorkspaceDiffFile): string {
  if (file.status === 'renamed') return `${file.oldPath} -> ${file.newPath}`
  return file.newPath || file.oldPath
}

function Line({ line }: { line: WorkspaceDiffLine }): React.JSX.Element {
  const cls =
    line.type === 'add'
      ? 'workspace-diff-line-add'
      : line.type === 'delete'
        ? 'workspace-diff-line-del'
        : 'workspace-diff-line-context'
  const prefix = line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' '
  return (
    <div className={`workspace-diff-line ${cls}`}>
      <span className="workspace-diff-num">{line.oldLine ?? ''}</span>
      <span className="workspace-diff-num">{line.newLine ?? ''}</span>
      <span className="workspace-diff-code">
        {prefix}
        {line.text}
      </span>
    </div>
  )
}

function statusLabel(file: GitFileStatus): string {
  if (file.untracked) return 'untracked'
  const flags = []
  if (file.staged) flags.push('staged')
  if (file.unstaged) flags.push('unstaged')
  return flags.join(' + ') || file.kind
}

function GitCommitBox(): React.JSX.Element {
  const {
    gitBusy,
    gitError,
    gitLoading,
    gitMessage,
    gitStatus
  } = useStore((s) => s.workbench)
  const refreshGitStatus = useStore((s) => s.refreshGitStatus)
  const stageGitFiles = useStore((s) => s.stageGitFiles)
  const stageAllGitFiles = useStore((s) => s.stageAllGitFiles)
  const unstageGitFiles = useStore((s) => s.unstageGitFiles)
  const commitGit = useStore((s) => s.commitGit)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState('')

  const files = gitStatus?.files ?? []
  const selectedPaths = useMemo(
    () => files.map((file) => file.path).filter((path) => selected.has(path)),
    [files, selected]
  )
  const allSelected = files.length > 0 && selectedPaths.length === files.length
  const canCommit = Boolean(message.trim()) && Boolean(gitStatus?.staged) && !gitBusy

  useEffect(() => {
    setSelected((current) => {
      const available = new Set(files.map((file) => file.path))
      const next = new Set([...current].filter((path) => available.has(path)))
      if (next.size === current.size) return current
      return next
    })
  }, [files])

  const togglePath = (path: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const toggleAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(files.map((file) => file.path)))
  }

  const selectedCount = selectedPaths.length

  return (
    <section className="git-commit-box">
      <div className="git-commit-head">
        <div>
          <div className="git-commit-title">Git</div>
          <div className="git-commit-sub">
            {gitStatus?.branch || 'detached'} · {gitStatus?.staged ?? 0} staged · {gitStatus?.unstaged ?? 0} unstaged · {gitStatus?.untracked ?? 0} untracked
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" disabled={gitLoading || gitBusy} onClick={() => void refreshGitStatus()}>
          {gitLoading ? 'Loading' : 'Refresh Git'}
        </button>
      </div>

      {gitError && <div className="notice notice-error git-commit-notice">{gitError}</div>}
      {gitMessage && <div className="notice notice-info git-commit-notice">{gitMessage}</div>}

      {files.length > 0 ? (
        <div className="git-file-list">
          <label className="git-file-row git-file-row-all">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} />
            <span>选择全部文件</span>
            <b>{files.length}</b>
          </label>
          {files.map((file) => (
            <label key={`${file.path}-${file.indexStatus}-${file.worktreeStatus}`} className="git-file-row">
              <input type="checkbox" checked={selected.has(file.path)} onChange={() => togglePath(file.path)} />
              <span className="git-file-path" title={file.path}>{file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path}</span>
              <span className="git-file-state">{statusLabel(file)}</span>
            </label>
          ))}
        </div>
      ) : (
        <div className="git-file-empty">No Git changes</div>
      )}

      <div className="git-commit-actions">
        <button className="btn btn-ghost btn-sm" disabled={gitBusy || selectedCount === 0} onClick={() => void stageGitFiles(selectedPaths)}>
          Stage selected
        </button>
        <button className="btn btn-ghost btn-sm" disabled={gitBusy || files.length === 0} onClick={() => void stageAllGitFiles()}>
          Stage all
        </button>
        <button className="btn btn-ghost btn-sm" disabled={gitBusy || selectedCount === 0} onClick={() => void unstageGitFiles(selectedPaths)}>
          Unstage selected
        </button>
      </div>

      <div className="git-commit-form">
        <input
          className="git-commit-input"
          value={message}
          placeholder="Commit message"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && canCommit) {
              event.preventDefault()
              void commitGit(message).then((result) => {
                if (result?.ok) setMessage('')
              })
            }
          }}
        />
        <button
          className="btn btn-primary btn-sm"
          disabled={!canCommit}
          onClick={() => void commitGit(message).then((result) => {
            if (result?.ok) setMessage('')
          })}
        >
          Commit
        </button>
      </div>
    </section>
  )
}

function FileDiff({ file }: { file: WorkspaceDiffFile }): React.JSX.Element {
  return (
    <article className="workspace-diff-file">
      <header className="workspace-diff-file-head">
        <span className={`workspace-diff-status workspace-diff-status-${file.status}`}>
          {file.status}
        </span>
        <span className="workspace-diff-path">{fileLabel(file)}</span>
      </header>
      {file.binary ? (
        <div className="workspace-diff-empty">Binary file changed</div>
      ) : file.hunks.length === 0 ? (
        <div className="workspace-diff-empty">No textual hunks</div>
      ) : (
        file.hunks.map((hunk, idx) => (
          <div key={`${fileLabel(file)}-${idx}`} className="workspace-diff-hunk">
            <div className="workspace-diff-hunk-head">{hunk.header}</div>
            {hunk.lines.map((line, lineIdx) => (
              <Line key={lineIdx} line={line} />
            ))}
          </div>
        ))
      )}
    </article>
  )
}

export default function DiffPanel(): React.JSX.Element {
  const t = useT()
  const activeId = useStore((s) => s.activeId)
  const { diff, diffError, diffLoading } = useStore((s) => s.workbench)
  const refresh = useStore((s) => s.refreshDiffPanel)
  const refreshGitStatus = useStore((s) => s.refreshGitStatus)
  const close = useStore((s) => s.closeDiffPanel)

  useEffect(() => {
    if (activeId) void Promise.all([refresh(), refreshGitStatus()])
  }, [activeId, refresh, refreshGitStatus])

  const files = diff?.files ?? []

  return (
    <div className="workspace-diff">
      <header className="workspace-diff-top">
        <div>
          <div className="workspace-diff-title">{t('workspaceDiff')}</div>
          <div className="workspace-diff-sub">
            {diff?.cwd ?? ''}
            {diff?.truncated ? ` · ${t('diffTruncated')}` : ''}
          </div>
        </div>
        <div className="workspace-diff-actions">
          <button className="btn btn-ghost btn-sm" disabled={diffLoading} onClick={() => void Promise.all([refresh(), refreshGitStatus()])}>
            {diffLoading ? t('loadingDiff') : t('refresh')}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={close}>
            {t('close')}
          </button>
        </div>
      </header>

      <GitCommitBox />

      {diffError && <div className="notice notice-error workspace-diff-notice">{diffError}</div>}
      {diffLoading && !diff && <div className="workspace-diff-empty">{t('loadingDiff')}</div>}
      {!diffLoading && diff && diff.ok && files.length === 0 && (
        <div className="workspace-diff-empty">{t('noWorkspaceChanges')}</div>
      )}
      {files.length > 0 && (
        <div className="workspace-diff-scroll">
          {files.map((file) => (
            <FileDiff key={`${file.oldPath}->${file.newPath}`} file={file} />
          ))}
        </div>
      )}
    </div>
  )
}
