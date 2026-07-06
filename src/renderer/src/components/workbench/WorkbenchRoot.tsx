import { useState } from 'react'
import ChatView from '../ChatView'
import MemoryPanel from '../MemoryPanel'
import RoutineEditor from '../RoutineEditor'
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
import type { Routine, SessionMeta } from '../../../../shared/types'

type RoutineEditorState = { mode: 'create' } | { mode: 'edit'; id: string }

export default function WorkbenchRoot(): React.JSX.Element {
  const [routineEditor, setRoutineEditor] = useState<RoutineEditorState | null>(null)
  const activeId = useStore((s) => s.activeId)
  const order = useStore((s) => s.order)
  const sessions = useStore((s) => s.sessions)
  const diffOpen = useStore((s) => s.workbench.diffOpen)
  const browserOpen = useStore((s) => s.workbench.browserOpen)
  const filesOpen = useStore((s) => s.workbench.filesOpen)
  const previewOpen = useStore((s) => s.workbench.previewOpen)
  const worktreeOpen = useStore((s) => s.workbench.worktreeOpen)
  const terminalOpen = useStore((s) => s.workbench.terminalOpen)
  const pluginRegistryOpen = useStore((s) => s.workbench.pluginRegistryOpen)
  const subagentOpen = useStore((s) => s.workbench.subagentOpen)
  const routineOpen = useStore((s) => s.workbench.routineOpen)
  const memoryOpen = useStore((s) => s.workbench.memoryOpen)
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
  const memoryInitialForm = useStore((s) => s.workbench.memoryInitialForm)
  const refreshPluginRegistryPanel = useStore((s) => s.refreshPluginRegistryPanel)
  const closePluginRegistryPanel = useStore((s) => s.closePluginRegistryPanel)
  const selectPluginRegistryItem = useStore((s) => s.selectPluginRegistryItem)
  const revealPluginRegistryItem = useStore((s) => s.revealPluginRegistryItem)
  const togglePluginRegistryItem = useStore((s) => s.togglePluginRegistryItem)
  const sendPluginRegistryItemToAgent = useStore((s) => s.sendPluginRegistryItemToAgent)
  const dispatchPluginAgent = useStore((s) => s.dispatchPluginAgent)
  const probeMcpRuntime = useStore((s) => s.probeMcpRuntime)
  const installPluginFromLocal = useStore((s) => s.installPluginFromLocal)
  const uninstallManagedPlugin = useStore((s) => s.uninstallManagedPlugin)
  const mcpProbeResults = useStore((s) => s.workbench.mcpProbeResults)
  const mcpProbing = useStore((s) => s.workbench.mcpProbing)
  const closeSubagentPanel = useStore((s) => s.closeSubagentPanel)
  const dispatchSubagentText = useStore((s) => s.dispatchSubagentText)
  const selectSession = useStore((s) => s.selectSession)
  const refreshRoutinePanel = useStore((s) => s.refreshRoutinePanel)
  const closeRoutinePanel = useStore((s) => s.closeRoutinePanel)
  const selectRoutine = useStore((s) => s.selectRoutine)
  const toggleRoutine = useStore((s) => s.toggleRoutine)
  const markRoutineRun = useStore((s) => s.markRoutineRun)
  const deleteRoutine = useStore((s) => s.deleteRoutine)
  const closeMemoryPanel = useStore((s) => s.closeMemoryPanel)
  const closeRoutineEditor = (): void => {
    setRoutineEditor(null)
    void refreshRoutinePanel()
  }
  const selectedRoutine =
    routineEditor?.mode === 'edit'
      ? (routines.find((routine) => routine.id === routineEditor.id) as Routine | undefined)
      : undefined
  const childSessions = activeId
    ? order
        .map((id) => sessions[id]?.meta)
        .filter((meta): meta is SessionMeta => Boolean(meta && meta.parentSessionId === activeId))
    : []
  const childResults = activeId ? sessions[activeId]?.childResults ?? {} : {}
  const sideOpen =
    diffOpen ||
    browserOpen ||
    filesOpen ||
    previewOpen ||
    worktreeOpen ||
    terminalOpen ||
    pluginRegistryOpen ||
    subagentOpen ||
    routineOpen ||
    memoryOpen

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
              onUseItem={(item) => void sendPluginRegistryItemToAgent(item)}
              onDispatchAgent={(item) => void dispatchPluginAgent(item)}
              onRevealItem={(item) => void revealPluginRegistryItem(item)}
              onToggleItem={(item, enabled) => void togglePluginRegistryItem(item, enabled)}
              onProbeMcp={(items) => void probeMcpRuntime(items)}
              onInstall={() => void installPluginFromLocal()}
              onUninstall={(item) => void uninstallManagedPlugin(item)}
              mcpProbeResults={mcpProbeResults}
              mcpProbing={mcpProbing}
            />
          ) : subagentOpen ? (
            <SubagentPanel
              childSessions={childSessions}
              childResults={childResults}
              busy={subagentBusy}
              error={subagentError}
              message={subagentMessage}
              lastResult={lastSubagentDispatch}
              onClose={closeSubagentPanel}
              onSelectChild={selectSession}
              onDispatch={dispatchSubagentText}
            />
          ) : routineOpen ? (
            <RoutinePanel
              routines={routines}
              loading={routineLoading}
              error={routineError}
              message={routineMessage}
              selectedRoutineId={selectedRoutineId}
              subtitle="本地持久化 · 定时执行已启用"
              cloudSchedulingNote="Routine 在本机定时执行；云端托管定时尚未接入。"
              onAddRoutine={() => setRoutineEditor({ mode: 'create' })}
              onRefresh={refreshRoutinePanel}
              onClose={closeRoutinePanel}
              onSelectRoutine={(routine) => selectRoutine(routine.id)}
              onEditRoutine={(routine) => setRoutineEditor({ mode: 'edit', id: routine.id })}
              onDeleteRoutine={(routine) => {
                if (window.confirm(`删除 Routine「${routine.name}」?`)) void deleteRoutine(routine.id)
              }}
              onToggleRoutine={(routine, enabled) => void toggleRoutine(routine.id, enabled)}
              onRunRoutine={(routine) => void markRoutineRun(routine.id)}
            />
          ) : memoryOpen && activeId ? (
            <MemoryPanel sessionId={activeId} initialForm={memoryInitialForm} onClose={closeMemoryPanel} />
          ) : worktreeOpen ? (
            <WorktreePanel />
          ) : (
            <DiffPanel />
          )}
        </section>
      )}
      {routineEditor && (routineEditor.mode === 'create' || selectedRoutine) && (
        <RoutineEditor
          routine={routineEditor.mode === 'edit' ? selectedRoutine : null}
          onClose={closeRoutineEditor}
        />
      )}
    </div>
  )
}
