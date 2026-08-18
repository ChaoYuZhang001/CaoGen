type StudioViewModule = typeof import('./StudioView')

let studioViewPromise: Promise<StudioViewModule> | null = null

export function loadStudioView(): Promise<StudioViewModule> {
  if (!studioViewPromise) {
    studioViewPromise = import('./StudioView').catch((error: unknown) => {
      studioViewPromise = null
      throw error
    })
  }
  return studioViewPromise
}
