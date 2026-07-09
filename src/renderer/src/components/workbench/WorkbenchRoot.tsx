import { useEffect, useState } from 'react'
import type * as React from 'react'
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
import { useT } from '../../i18n'
import type { LayoutSettings, Routine, SessionMeta } from '../../../../shared/types'

type RoutineEditorState = { mode: 'create' } | { mode: 'edit'; id: string }

const SIDE_MIN_WIDTH = 360
const SIDE_MAX_WIDTH = 900

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

export default function WorkbenchRoot(): React.JSX.Element {
  const t = useT()
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
  const layout = useStore((s) => s.settings.layout)
  const updateSettings = useStore((s) => s.updateSettings)
  const pluginRegistry = useStore((s) => s.workbench.pluginRegistry)
  const pluginRegistryLoading = useStore((s) => s.workbench.pluginRegistryLoading)
  const pluginRegistryError = useStore((s) => s.workbench.pluginRegistryError)
  const pluginRegistryMessage = useStore((s) => s.workbench.pluginRegistryMessage)
  const selectedPluginRegistryItemId = useStore((s) => s.workbench.selectedPluginRegistryItemId)
  const subagentBusy = useStore((s) => s.workbench.subagentBusy)
  const subagentError = useStore((s) => s.workbench.subagentError)
  const subagentMessage = useStore((s) => s.workbench.subagentMessage)
  const lastSubagentDispatch = useStore((s) => s.workbench.lastSubagentDispatch)
  const taskDagExecution = useStore((s) =>
    s.activeId ? s.sessions[s.activeId]?.taskDagExecution : undefined
  )
  const routines = useStore((s) => s.workbench.routines)
  const routineRuns = useStore((s) => s.workbench.routineRuns)
  const routineLoading = useStore((s) => s.workbench.routineLoading)
  const routineError = useStore((s) => s.workbench.routineError)
  const routineMessage = useStore((s) => s.workbench.routineMessage)
  const selectedRoutineId = useStore((s) => s.workbench.selectedRoutineId)
  const memoryInitialForm = useStore((s) => s.workbench.memoryInitialForm)
  const refreshPluginRegistryPanel = useStore((s) => s.refreshPluginRegistryPanel)
  const closeDiffPanel = useStore((s) => s.closeDiffPanel)
  const closeBrowserPanel = useStore((s) => s.closeBrowserPanel)
  const closeFilesPanel = useStore((s) => s.closeFilesPanel)
  const closePreviewPanel = useStore((s) => s.closePreviewPanel)
  const closeWorktreePanel = useStore((s) => s.closeWorktreePanel)
  const closeTerminalPanel = useStore((s) => s.closeTerminalPanel)
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
  const decomposeAndDispatchTaskDag = useStore((s) => s.decomposeAndDispatchTaskDag)
  const selectSession = useStore((s) => s.selectSession)
  const refreshRoutinePanel = useStore((s) => s.refreshRoutinePanel)
  const closeRoutinePanel = useStore((s) => s.closeRoutinePanel)
  const selectRoutine = useStore((s) => s.selectRoutine)
  const toggleRoutine = useStore((s) => s.toggleRoutine)
  const markRoutineRun = useStore((s) => s.markRoutineRun)
  const deleteRoutine = useStore((s) => s.deleteRoutine)
  const closeMemoryPanel = useStore((s) => s.closeMemoryPanel)
  const [sideWidth, setSideWidth] = useState(layout.workbenchSideWidth)

  useEffect(() => {
    setSideWidth(layout.workbenchSideWidth)
  }, [layout.workbenchSideWidth])

  const patchLayout = (patch: Partial<LayoutSettings>): void => {
    void updateSettings({ layout: { ...layout, ...patch } })
  }

  const startSideResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sideWidth
    let nextWidth = startWidth
    const move = (moveEvent: PointerEvent): void => {
      nextWidth = clamp(startWidth - (moveEvent.clientX - startX), SIDE_MIN_WIDTH, SIDE_MAX_WIDTH)
      setSideWidth(nextWidth)
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      document.body.classList.remove('is-resizing-layout')
      patchLayout({ workbenchSideWidth: nextWidth })
    }
    document.body.classList.add('is-resizing-layout')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop, { once: true })
  }

  const collapseSidePanel = (): void => {
    if (terminalOpen) {
      closeTerminalPanel()
    } else if (browserOpen) {
      void closeBrowserPanel()
    } else if (previewOpen) {
      closePreviewPanel()
    } else if (filesOpen) {
      closeFilesPanel()
    } else if (pluginRegistryOpen) {
      closePluginRegistryPanel()
    } else if (subagentOpen) {
      closeSubagentPanel()
    } else if (routineOpen) {
      closeRoutinePanel()
    } else if (memoryOpen) {
      closeMemoryPanel()
    } else if (worktreeOpen) {
      closeWorktreePanel()
    } else {
      closeDiffPanel()
    }
  }
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
    <div
      className={`workbench ${sideOpen ? 'workbench-split' : ''}`}
      style={{ '--workbench-side-width': `${sideWidth}px` } as React.CSSProperties}
    >
      <section className="workbench-pane workbench-chat">
        <ChatView />
      </section>
      {sideOpen && (
        <>
          <div
            className="workbench-side-gutter no-drag"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('resizeToolPanel')}
            title={t('resizeToolPanel')}
            onPointerDown={startSideResize}
          >
            <button
              type="button"
              className="workbench-side-collapse"
              aria-label={t('collapseToolPanel')}
              title={t('collapseToolPanel')}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={collapseSidePanel}
            >
              ›
            </button>
          </div>
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
                dagExecution={taskDagExecution}
                onClose={closeSubagentPanel}
                onSelectChild={selectSession}
                onDispatch={dispatchSubagentText}
                onDecomposeAndDispatch={decomposeAndDispatchTaskDag}
              />
            ) : routineOpen ? (
              <RoutinePanel
                routines={routines}
                runs={routineRuns}
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
        </>
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
