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
  return loadOfficeView()
    .then((module) => new Promise<boolean>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (document.querySelector('.office, .office-loading')) {
          resolve(true)
          return
        }
        resolve(module.prewarmOfficeGraphics())
      }))
    }))
    .catch(() => false)
}
