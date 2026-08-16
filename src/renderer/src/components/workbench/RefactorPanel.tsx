import { Check, FilePenLine, RefreshCw, RotateCcw, Search, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { useProjectRefactor } from './useProjectRefactor'

export default function RefactorPanel(): React.JSX.Element {
  const t = useT()
  const refactor = useProjectRefactor()

  return (
    <div className="refactor-panel" data-project-refactor-panel>
      <header className="workspace-diff-top">
        <div>
          <div className="workspace-diff-title">{t('projectRefactorTitle')}</div>
          <div className="workspace-diff-sub">{t('projectRefactorSubtitle')}</div>
        </div>
        <button type="button" className="btn btn-ghost btn-icon-sm" title={t('projectRefactorClear')}
          aria-label={t('projectRefactorClear')} disabled={refactor.pending}
          onClick={refactor.clear}>
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </header>

      {refactor.error && <div className="notice notice-error refactor-panel-notice" role="alert">{refactor.error}</div>}
      <RefactorForm refactor={refactor} />
      <RefactorContent refactor={refactor} />
    </div>
  )
}

type ProjectRefactorView = ReturnType<typeof useProjectRefactor>

function RefactorForm({ refactor }: { refactor: ProjectRefactorView }): React.JSX.Element {
  const t = useT()
  const [path, setPath] = useState(refactor.defaultPath)
  const [line, setLine] = useState('1')
  const [column, setColumn] = useState('1')
  const [newName, setNewName] = useState('')

  useEffect(() => {
    if (refactor.defaultPath) setPath(refactor.defaultPath)
  }, [refactor.activeId, refactor.defaultPath])

  const submit = (): void => {
    const lineNumber = Number(line)
    const columnNumber = Number(column)
    if (!path.trim() || !newName.trim() || !Number.isSafeInteger(lineNumber) || !Number.isSafeInteger(columnNumber)) return
    void refactor.previewRename(path.trim(), lineNumber, columnNumber, newName.trim())
  }

  return (
    <form className="refactor-form" onSubmit={(event) => { event.preventDefault(); submit() }}>
      <label className="refactor-path-field">
        <span>{t('projectRefactorPath')}</span>
        <input value={path} placeholder="src/example.ts" disabled={!refactor.activeId || refactor.pending}
          onChange={(event) => setPath(event.target.value)} />
      </label>
      <label>
        <span>{t('projectRefactorLine')}</span>
        <input type="number" min="1" value={line} disabled={!refactor.activeId || refactor.pending}
          onChange={(event) => setLine(event.target.value)} />
      </label>
      <label>
        <span>{t('projectRefactorColumn')}</span>
        <input type="number" min="1" value={column} disabled={!refactor.activeId || refactor.pending}
          onChange={(event) => setColumn(event.target.value)} />
      </label>
      <label className="refactor-name-field">
        <span>{t('projectRefactorNewName')}</span>
        <input value={newName} placeholder="renamedSymbol" disabled={!refactor.activeId || refactor.pending}
          onChange={(event) => setNewName(event.target.value)} />
      </label>
      <button type="submit" className="btn btn-primary refactor-preview-button"
        disabled={!refactor.activeId || refactor.pending || !path.trim() || !newName.trim()}>
        <Search size={14} aria-hidden="true" />
        {refactor.pending ? t('projectRefactorWorking') : t('projectRefactorPreview')}
      </button>
    </form>
  )
}

function RefactorContent({ refactor }: { refactor: ProjectRefactorView }): React.JSX.Element {
  const t = useT()
  return (
    <div className="refactor-content">
      {!refactor.activeId && <RefactorEmpty text={t('projectRefactorNoSession')} />}
      {refactor.activeId && !refactor.preview && !refactor.applied && !refactor.rolledBack && (
        <RefactorEmpty icon text={t('projectRefactorIdle')} />
      )}
      {refactor.preview && (
        <div className="refactor-preview" data-project-refactor-preview>
          <div className="refactor-summary">
            <div>
              <strong>{t('projectRefactorPreviewReady')}</strong>
              <span>{t('projectRefactorSummary', { files: refactor.preview.files.length, edits: refactor.preview.totalEdits })}</span>
            </div>
            <button type="button" className="btn btn-primary btn-sm" disabled={refactor.pending}
              onClick={() => void refactor.apply()}>
              <Check size={14} aria-hidden="true" />
              {t('projectRefactorApply')}
            </button>
          </div>
          <div className="refactor-file-list">
            {refactor.preview.files.map((file, index) => (
              <details key={file.path} open={index < 3} className="refactor-file-change">
                <summary><span>{file.path}</span><em>{t('projectRefactorEditCount', { edits: file.editCount })}</em></summary>
                <pre className="refactor-diff">
                  {file.lines.map((item, lineIndex) => (
                    <span className={`refactor-line refactor-line-${item.kind}`} key={`${item.line}:${item.kind}:${lineIndex}`}>
                      <b>{item.kind === 'added' ? '+' : item.kind === 'removed' ? '-' : ' '}</b>
                      <i>{item.line}</i><code>{item.text || ' '}</code>
                    </span>
                  ))}
                </pre>
              </details>
            ))}
          </div>
        </div>
      )}
      {refactor.applied && (
        <div className="refactor-result" data-project-refactor-result="applied">
          <Check size={20} aria-hidden="true" /><strong>{t('projectRefactorApplied')}</strong>
          <span>{t('projectRefactorFilesChanged', { files: refactor.applied.files.length })}</span>
          <code>{refactor.applied.operationId}</code>
          <button type="button" className="btn btn-ghost btn-sm" disabled={refactor.pending} onClick={() => void refactor.rollback()}>
            <RotateCcw size={14} aria-hidden="true" />{t('projectRefactorRollback')}
          </button>
        </div>
      )}
      {refactor.rolledBack && (
        <div className="refactor-result" data-project-refactor-result="rolled-back">
          <RotateCcw size={20} aria-hidden="true" /><strong>{t('projectRefactorRolledBack')}</strong>
          <span>{t('projectRefactorFilesRestored', { files: refactor.rolledBack.files.length })}</span>
          <button type="button" className="btn btn-ghost btn-icon-sm" title={t('close')} aria-label={t('close')}
            onClick={refactor.clear}><X size={14} aria-hidden="true" /></button>
        </div>
      )}
    </div>
  )
}

function RefactorEmpty({ text, icon = false }: { text: string; icon?: boolean }): React.JSX.Element {
  return <div className="test-empty">{icon && <FilePenLine size={18} aria-hidden="true" />}<span>{text}</span></div>
}
