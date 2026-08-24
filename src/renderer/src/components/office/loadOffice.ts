type OfficeViewModule = typeof import('./OfficeView')

let officeViewPromise: Promise<OfficeViewModule> | null = null

export function loadOfficeView(): Promise<OfficeViewModule> {
  if (!officeViewPromise) {
    officeViewPromise = import('./OfficeView').catch((error: unknown) => {
      officeViewPromise = null
      throw error
    })
  }
  return officeViewPromise
}

export function preloadOfficeView(): Promise<boolean> {
  return Promise.all([loadOfficeView(), import('./graphicsPrewarm')])
    .then(([module, graphics]) => Promise.all([
      module.preloadOfficeRuntime(),
      new Promise<boolean>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (document.querySelector('.office, .office-loading')) {
            resolve(true)
            return
          }
          resolve(graphics.prewarmOfficeGraphics())
        }))
      })
    ]).then(([runtimeReady, graphicsReady]) => runtimeReady && graphicsReady))
    .catch(() => false)
}
