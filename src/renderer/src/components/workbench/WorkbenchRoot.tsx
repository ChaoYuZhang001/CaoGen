import ChatView from '../ChatView'
import BrowserPanel from './BrowserPanel'
import DiffPanel from './DiffPanel'
import FilePanel from './FilePanel'
import PreviewPanel from './PreviewPanel'
import WorktreePanel from './WorktreePanel'
import TerminalPanel from './TerminalPanel'
import PluginRegistryPanel from './PluginRegistryPanel'
import SubagentPanel from './SubagentPanel'
import RoutinePanel from './RoutinePanel'
import { useStore } from '../../store'

export default function WorkbenchRoot(): React.JSX.Element {
  const diffOpen = useStore((s) => s.workbench.diffOpen)
  const browserOpen = useStore((s) => s.workbench.browserOpen)
  const filesOpen = useStore((s) => s.workbench.filesOpen)
  const previewOpen = useStore((s) => s.workbench.previewOpen)
  const worktreeOpen = useStore((s) => s.workbench.worktreeOpen)
  const terminalOpen = useStore((s) => s.workbench.terminalOpen)
  const pluginRegistryOpen = useStore((s) => s.workbench.pluginRegistryOpen)
  const subagentOpen = useStore((s) => s.workbench.subagentOpen)
  const routineOpen = useStore((s) => s.workbench.routineOpen)
  const pluginRegistry = useStore((s) => s.workbench.pluginRegistry)
  const pluginRegistryLoading = useStore((s) => s.workbench.pluginRegistryLoading)
  const pluginRegistryError = useStore((s) => s.workbench.pluginRegistryError)
  const pluginRegistryMessage = useStore((s) => s.workbench.pluginRegistryMessage)
  const selectedPluginRegistryItemId = useStore((s) => s.workbench.selectedPluginRegistryItemId)
  const subagentBusy = useStore((s) => s.workbench.subagentBusy)
  const subagentError = useStore((s) => s.workbench.subagentError)
  const subagentMessage = useStore((s) => s.workbench.subagentMessage)
  const lastSubagentDispatch = useStore((s) => s.workbench.lastSubagentDispatch)
  const routines = useStore((s) => s.workbench.routines)
  const routineLoading = useStore((s) => s.workbench.routineLoading)
  const routineError = useStore((s) => s.workbench.routineError)
  const routineMessage = useStore((s) => s.workbench.routineMessage)
  const selectedRoutineId = useStore((s) => s.workbench.selectedRoutineId)
  const refreshPluginRegistryPanel = useStore((s) => s.refreshPluginRegistryPanel)
  const closePluginRegistryPanel = useStore((s) => s.closePluginRegistryPanel)
  const selectPluginRegistryItem = useStore((s) => s.selectPluginRegistryItem)
  const revealPluginRegistryItem = useStore((s) => s.revealPluginRegistryItem)
  const closeSubagentPanel = useStore((s) => s.closeSubagentPanel)
  const dispatchSubagentText = useStore((s) => s.dispatchSubagentText)
  const refreshRoutinePanel = useStore((s) => s.refreshRoutinePanel)
  const closeRoutinePanel = useStore((s) => s.closeRoutinePanel)
  const selectRoutine = useStore((s) => s.selectRoutine)
  const toggleRoutine = useStore((s) => s.toggleRoutine)
  const markRoutineRun = useStore((s) => s.markRoutineRun)
  const sideOpen =
    diffOpen ||
    browserOpen ||
    filesOpen ||
    previewOpen ||
    worktreeOpen ||
    terminalOpen ||
    pluginRegistryOpen ||
    subagentOpen ||
    routineOpen

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
          ) : pluginRegistryOpen ? (
            <PluginRegistryPanel
              items={pluginRegistry?.items ?? []}
              roots={pluginRegistry?.roots}
              diagnostics={pluginRegistry?.diagnostics}
              scannedAt={pluginRegistry?.scannedAt}
              truncated={pluginRegistry?.truncated}
              loading={pluginRegistryLoading}
              error={pluginRegistryError}
              message={pluginRegistryMessage}
              selectedItemId={selectedPluginRegistryItemId}
              onRefresh={refreshPluginRegistryPanel}
              onClose={closePluginRegistryPanel}
              onSelectItem={(item) => selectPluginRegistryItem(item.id)}
              onRevealItem={(item) => void revealPluginRegistryItem(item)}
            />
          ) : subagentOpen ? (
            <SubagentPanel
              busy={subagentBusy}
              error={subagentError}
              message={subagentMessage}
              lastResult={lastSubagentDispatch}
              onClose={closeSubagentPanel}
              onDispatch={dispatchSubagentText}
            />
          ) : routineOpen ? (
            <RoutinePanel
              routines={routines}
              loading={routineLoading}
              error={routineError}
              message={routineMessage}
              selectedRoutineId={selectedRoutineId}
              subtitle="本地持久化 · 执行器未接入"
              cloudSchedulingNote="云端定时与真实执行器未接入；当前可管理本地启停并标记运行时间。"
              onRefresh={refreshRoutinePanel}
              onClose={closeRoutinePanel}
              onSelectRoutine={(routine) => selectRoutine(routine.id)}
              onToggleRoutine={(routine, enabled) => void toggleRoutine(routine.id, enabled)}
              onRunRoutine={(routine) => void markRoutineRun(routine.id)}
            />
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
