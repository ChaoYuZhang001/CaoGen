import { Bug, FilePenLine, FileText, FlaskConical } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useT } from '../../i18n'
import FilePanel from './FilePanel'
import TestPanel from './TestPanel'
import DebugPanel from './DebugPanel'
import RefactorPanel from './RefactorPanel'

type DeveloperView = 'files' | 'tests' | 'debug' | 'refactor'

export default function DeveloperPanel(): React.JSX.Element {
  const t = useT()
  const [view, setView] = useState<DeveloperView>('files')
  const [testsVisited, setTestsVisited] = useState(false)
  const [debugVisited, setDebugVisited] = useState(false)
  const [refactorVisited, setRefactorVisited] = useState(false)
  return (
    <div className="developer-panel">
      <div className="developer-panel-tabs" role="tablist" aria-label={t('deskFiles')}>
        <DeveloperTab active={view === 'files'} label={t('deskFiles')} onClick={() => setView('files')}>
          <FileText size={14} aria-hidden="true" />
        </DeveloperTab>
        <DeveloperTab active={view === 'tests'} label={t('deskTests')} onClick={() => { setTestsVisited(true); setView('tests') }}>
          <FlaskConical size={14} aria-hidden="true" />
        </DeveloperTab>
        <DeveloperTab active={view === 'debug'} label={t('deskDebug')} onClick={() => { setDebugVisited(true); setView('debug') }}>
          <Bug size={14} aria-hidden="true" />
        </DeveloperTab>
        <DeveloperTab active={view === 'refactor'} label={t('deskRefactor')} onClick={() => { setRefactorVisited(true); setView('refactor') }}>
          <FilePenLine size={14} aria-hidden="true" />
        </DeveloperTab>
      </div>
      <div className="developer-panel-view" style={{ display: view === 'files' ? 'flex' : 'none' }} aria-hidden={view !== 'files'}>
        <FilePanel />
      </div>
      {testsVisited && (
        <div className="developer-panel-view" style={{ display: view === 'tests' ? 'flex' : 'none' }} aria-hidden={view !== 'tests'}>
          <TestPanel />
        </div>
      )}
      {debugVisited && (
        <div className="developer-panel-view" style={{ display: view === 'debug' ? 'flex' : 'none' }} aria-hidden={view !== 'debug'}>
          <DebugPanel />
        </div>
      )}
      {refactorVisited && (
        <div className="developer-panel-view" style={{ display: view === 'refactor' ? 'flex' : 'none' }} aria-hidden={view !== 'refactor'}>
          <RefactorPanel />
        </div>
      )}
    </div>
  )
}

function DeveloperTab(props: {
  active: boolean
  label: string
  onClick(): void
  children: ReactNode
}): React.JSX.Element {
  return (
    <button type="button" role="tab" aria-selected={props.active}
      className={props.active ? 'developer-panel-tab-active' : ''} onClick={props.onClick}>
      {props.children}
      <span>{props.label}</span>
    </button>
  )
}
