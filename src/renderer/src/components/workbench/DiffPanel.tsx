import { useEffect } from 'react'
import { useStore } from '../../store'
import { useT } from '../../i18n'
import type { WorkspaceDiffFile, WorkspaceDiffLine } from '../../../../shared/types'

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
  const close = useStore((s) => s.closeDiffPanel)

  useEffect(() => {
    if (activeId) void refresh()
  }, [activeId, refresh])

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
          <button className="btn btn-ghost btn-sm" disabled={diffLoading} onClick={() => void refresh()}>
            {diffLoading ? t('loadingDiff') : t('refresh')}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={close}>
            {t('close')}
          </button>
        </div>
      </header>

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
