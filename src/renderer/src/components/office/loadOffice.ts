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

export function preloadOfficeView(): void {
  void loadOfficeView().catch(() => undefined)
}
