import type { StoreApi } from 'zustand'
import type { BrowserStateActionResult, BrowserViewState } from '../../../shared/types'
import type { AppStore } from '../store'

type SetState = StoreApi<AppStore>['setState']
type GetState = StoreApi<AppStore>['getState']

type BrowserActions = Pick<
  AppStore,
  | 'openBrowserPanel'
  | 'closeBrowserPanel'
  | 'navigateBrowser'
  | 'browserGoBack'
  | 'browserGoForward'
  | 'reloadBrowser'
  | 'setBrowserBounds'
>

export function createBrowserActions(set: SetState, get: GetState): BrowserActions {
  return {
    async openBrowserPanel(url) {
      const id = get().activeId
      if (!id) return
      set((state) => ({
        workbench: {
          ...state.workbench,
          diffOpen: false,
          worktreeOpen: false,
          terminalOpen: false,
          filesOpen: false,
          previewOpen: false,
          browserOpen: true,
          pluginRegistryOpen: false,
          subagentOpen: false,
          routineOpen: false,
          memoryOpen: false,
          browserLoading: true,
          browserError: undefined,
          browserMessage: undefined
        }
      }))
      try {
        const state = await requireBrowserState(await window.agentDesk.openBrowser(id, url), get)
        const annotations = await window.agentDesk.listBrowserAnnotations(id).catch(() => [])
        set((current) => ({
          workbench: {
            ...current.workbench,
            browserOpen: true,
            browserLoading: state.loading,
            browserState: state,
            browserUrlDraft: state.url,
            browserAnnotations: annotations,
            browserError: undefined
          }
        }))
      } catch (error) {
        setBrowserError(set, error, true)
      }
    },

    async closeBrowserPanel() {
      const id = get().activeId
      if (id) await window.agentDesk.closeBrowser(id).catch(() => undefined)
      set((state) => ({
        workbench: {
          ...state.workbench,
          browserOpen: false,
          browserLoading: false,
          browserError: undefined
        }
      }))
    },

    async navigateBrowser(url) {
      const id = get().activeId
      const target = url.trim()
      if (!id || !target) return
      set((state) => ({
        workbench: { ...state.workbench, browserLoading: true, browserError: undefined }
      }))
      try {
        const state = await requireBrowserState(await window.agentDesk.navigateBrowser(id, target), get)
        set((current) => ({
          workbench: {
            ...current.workbench,
            browserState: state,
            browserUrlDraft: state.url,
            browserLoading: state.loading
          }
        }))
      } catch (error) {
        setBrowserError(set, error, true)
      }
    },

    async browserGoBack() {
      const id = get().activeId
      if (!id) return
      try {
        const state = await requireBrowserState(await window.agentDesk.browserGoBack(id), get)
        setBrowserHistoryState(set, state)
      } catch (error) {
        setBrowserError(set, error)
      }
    },

    async browserGoForward() {
      const id = get().activeId
      if (!id) return
      try {
        const state = await requireBrowserState(await window.agentDesk.browserGoForward(id), get)
        setBrowserHistoryState(set, state)
      } catch (error) {
        setBrowserError(set, error)
      }
    },

    async reloadBrowser() {
      const id = get().activeId
      if (!id) return
      try {
        const state = await requireBrowserState(await window.agentDesk.reloadBrowser(id), get)
        set((current) => ({
          workbench: { ...current.workbench, browserState: state, browserLoading: state.loading }
        }))
      } catch (error) {
        setBrowserError(set, error, true)
      }
    },

    async setBrowserBounds(bounds) {
      const id = get().activeId
      if (!id || !get().workbench.browserOpen) return
      await window.agentDesk.setBrowserBounds(id, bounds)
    }
  }
}

async function requireBrowserState(
  result: BrowserStateActionResult<BrowserViewState>,
  get: GetState
): Promise<BrowserViewState> {
  if (result.effectStatus === 'waiting_reconciliation') await get().refreshTaskSnapshots()
  if (!result.ok) throw new Error(result.error)
  return result.state
}

function setBrowserHistoryState(set: SetState, state: BrowserViewState): void {
  set((current) => ({
    workbench: { ...current.workbench, browserState: state, browserUrlDraft: state.url }
  }))
}

function setBrowserError(set: SetState, error: unknown, stopLoading = false): void {
  set((state) => ({
    workbench: {
      ...state.workbench,
      ...(stopLoading ? { browserLoading: false } : {}),
      browserError: error instanceof Error ? error.message : String(error)
    }
  }))
}
