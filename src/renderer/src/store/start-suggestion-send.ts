import type { StoreApi } from 'zustand'
import type { StartSuggestion } from '../../../shared/types'
import type { AppStore } from '../store'

type StoreAccess = Pick<StoreApi<AppStore>, 'getState' | 'setState'>

export async function sendStartSuggestionMessage(
  store: StoreAccess,
  suggestion: StartSuggestion
): Promise<void> {
  const sessionId = store.getState().activeId
  if (!sessionId) return
  store.setState((state) => ({
    workbench: { ...state.workbench, startSuggestionsError: undefined }
  }))
  try {
    await store.getState().sendMessage(suggestion.prompt)
    const key = `${sessionId}:${suggestion.id}`
    store.setState((state) => ({
      workbench: {
        ...state.workbench,
        ignoredStartSuggestions: { ...state.workbench.ignoredStartSuggestions, [key]: true }
      }
    }))
  } catch (error) {
    if (store.getState().activeId !== sessionId) return
    store.setState((state) => ({
      workbench: {
        ...state.workbench,
        startSuggestionsError: error instanceof Error ? error.message : String(error)
      }
    }))
  }
}
