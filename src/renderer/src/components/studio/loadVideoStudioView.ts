type VideoStudioViewModule = typeof import('./VideoStudioView')

let videoStudioViewPromise: Promise<VideoStudioViewModule> | null = null

export function loadVideoStudioView(): Promise<VideoStudioViewModule> {
  if (!videoStudioViewPromise) {
    videoStudioViewPromise = import('./VideoStudioView').catch((error: unknown) => {
      videoStudioViewPromise = null
      throw error
    })
  }
  return videoStudioViewPromise
}

export function preloadVideoStudioView(): void {
  void loadVideoStudioView().catch(() => undefined)
}
