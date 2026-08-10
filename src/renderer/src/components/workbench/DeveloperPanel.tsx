import { Bug, FilePenLine, FileText, FlaskConical } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useT } from '../../i18n'
import FilePanel from './FilePanel'
import TestPanel from './TestPanel'
import DebugPanel from './DebugPanel'
import RefactorPanel from './RefactorPanel'
import { rovingTabProps, tabPanelProps } from './roving-tabs'

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
        <DeveloperTab id="developer-tab-files" panelId="developer-panel-files" active={view === 'files'} label={t('deskFiles')} onClick={() => setView('files')}>
          <FileText size={14} aria-hidden="true" />
        </DeveloperTab>
        <DeveloperTab id="developer-tab-tests" panelId="developer-panel-tests" active={view === 'tests'} label={t('deskTests')} onClick={() => { setTestsVisited(true); setView('tests') }}>
          <FlaskConical size={14} aria-hidden="true" />
        </DeveloperTab>
        <DeveloperTab id="developer-tab-debug" panelId="developer-panel-debug" active={view === 'debug'} label={t('deskDebug')} onClick={() => { setDebugVisited(true); setView('debug') }}>
          <Bug size={14} aria-hidden="true" />
        </DeveloperTab>
        <DeveloperTab id="developer-tab-refactor" panelId="developer-panel-refactor" active={view === 'refactor'} label={t('deskRefactor')} onClick={() => { setRefactorVisited(true); setView('refactor') }}>
          <FilePenLine size={14} aria-hidden="true" />
        </DeveloperTab>
      </div>
      <div {...tabPanelProps('developer-panel-files', 'developer-tab-files')} className="developer-panel-view" hidden={view !== 'files'} style={{ display: view === 'files' ? 'flex' : 'none' }}>
        <FilePanel />
      </div>
      <div {...tabPanelProps('developer-panel-tests', 'developer-tab-tests')} className="developer-panel-view" hidden={view !== 'tests'} style={{ display: view === 'tests' ? 'flex' : 'none' }}>
        {testsVisited && <TestPanel />}
      </div>
      <div {...tabPanelProps('developer-panel-debug', 'developer-tab-debug')} className="developer-panel-view" hidden={view !== 'debug'} style={{ display: view === 'debug' ? 'flex' : 'none' }}>
        {debugVisited && <DebugPanel />}
      </div>
      <div {...tabPanelProps('developer-panel-refactor', 'developer-tab-refactor')} className="developer-panel-view" hidden={view !== 'refactor'} style={{ display: view === 'refactor' ? 'flex' : 'none' }}>
        {refactorVisited && <RefactorPanel />}
      </div>
    </div>
  )
}

function DeveloperTab(props: {
  id: string
  panelId: string
  active: boolean
  label: string
  onClick(): void
  children: ReactNode
}): React.JSX.Element {
  return (
    <button id={props.id} type="button" role="tab" {...rovingTabProps(props.active, props.panelId)}
      data-developer-tab={props.id.replace('developer-tab-', '')} className={props.active ? 'developer-panel-tab-active' : ''} onClick={props.onClick}>
      {props.children}
      <span>{props.label}</span>
    </button>
  )
}
