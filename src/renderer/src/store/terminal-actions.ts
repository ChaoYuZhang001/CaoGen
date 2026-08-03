import type { StoreApi } from 'zustand'
import type { AppStore } from '../store'

type SetState = StoreApi<AppStore>['setState']
type GetState = StoreApi<AppStore>['getState']
type CloseBrowserView = (sessionId: string | null | undefined) => void

type TerminalActions = Pick<
  AppStore,
  'openTerminalPanel' | 'closeTerminalPanel' | 'startTerminal' | 'sendTerminalInput' | 'closeTerminal'
>

export function createTerminalActions(
  set: SetState,
  get: GetState,
  closeBrowserView: CloseBrowserView
): TerminalActions {
  return {
    async openTerminalPanel() {
      closeBrowserView(get().activeId)
      set((state) => ({
        workbench: {
          ...state.workbench,
          activePanelId: 'terminal',
          mountedPanels: new Set(state.workbench.mountedPanels).add('terminal')
        }
      }))
      await get().startTerminal()
    },

    closeTerminalPanel() {
      set((state) => ({
        workbench: {
          ...state.workbench,
          activePanelId: state.workbench.activePanelId === 'terminal' ? null : state.workbench.activePanelId
        }
      }))
    },

    async startTerminal() {
      const sessionId = get().activeId
      if (!sessionId) return
      set((state) => ({
        workbench: { ...state.workbench, terminalLoading: true, terminalError: undefined }
      }))
      try {
        const result = await window.agentDesk.startTerminal(sessionId, { cols: 100, rows: 28, reuse: true })
        if (result.effectStatus === 'waiting_reconciliation') await get().refreshTaskSnapshots()
        if (!result.ok) throw new Error(result.error)
        set((state) => ({
          workbench: {
            ...state.workbench,
            terminal: result.terminal,
            terminalLoading: false,
            terminalBuffer:
              state.workbench.terminal?.id === result.terminal.id
                ? state.workbench.terminalBuffer
                : ''
          }
        }))
      } catch (error) {
        set((state) => ({
          workbench: {
            ...state.workbench,
            terminalLoading: false,
            terminalError: error instanceof Error ? error.message : String(error)
          }
        }))
      }
    },

    async sendTerminalInput(text) {
      const terminal = get().workbench.terminal
      if (!terminal || terminal.exit) return
      const result = await window.agentDesk.writeTerminal(terminal.id, text)
      if (result.effectStatus === 'waiting_reconciliation') await get().refreshTaskSnapshots()
      if (!result.ok) {
        set((state) => ({ workbench: { ...state.workbench, terminalError: result.error } }))
      }
    },

    async closeTerminal() {
      const terminal = get().workbench.terminal
      if (!terminal) return
      const result = await window.agentDesk.closeTerminal(terminal.id)
      if (result.effectStatus === 'waiting_reconciliation') await get().refreshTaskSnapshots()
      if (!result.ok) {
        set((state) => ({ workbench: { ...state.workbench, terminalError: result.error } }))
        return
      }
      set((state) => ({
        workbench: {
          ...state.workbench,
          terminal: undefined,
          terminalBuffer: '',
          terminalError: undefined
        }
      }))
    }
  }
}
