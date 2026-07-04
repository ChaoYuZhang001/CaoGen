import ChatView from '../ChatView'
import BrowserPanel from './BrowserPanel'
import DiffPanel from './DiffPanel'
import FilePanel from './FilePanel'
import PreviewPanel from './PreviewPanel'
import WorktreePanel from './WorktreePanel'
import TerminalPanel from './TerminalPanel'
import { useStore } from '../../store'

export default function WorkbenchRoot(): React.JSX.Element {
  const diffOpen = useStore((s) => s.workbench.diffOpen)
  const browserOpen = useStore((s) => s.workbench.browserOpen)
  const filesOpen = useStore((s) => s.workbench.filesOpen)
  const previewOpen = useStore((s) => s.workbench.previewOpen)
  const worktreeOpen = useStore((s) => s.workbench.worktreeOpen)
  const terminalOpen = useStore((s) => s.workbench.terminalOpen)
  const sideOpen = diffOpen || browserOpen || filesOpen || previewOpen || worktreeOpen || terminalOpen

  return (
    <div className={`workbench ${sideOpen ? 'workbench-split' : ''}`}>
      <section className="workbench-pane workbench-chat">
        <ChatView />
      </section>
      {sideOpen && (
        <section className="workbench-pane workbench-side">
          {terminalOpen ? (
            <TerminalPanel />
          ) : browserOpen ? (
            <BrowserPanel />
          ) : previewOpen ? (
            <PreviewPanel />
          ) : filesOpen ? (
            <FilePanel />
          ) : worktreeOpen ? (
            <WorktreePanel />
          ) : (
            <DiffPanel />
          )}
        </section>
      )}
    </div>
  )
}
