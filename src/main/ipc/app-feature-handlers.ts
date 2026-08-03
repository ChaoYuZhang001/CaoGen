import { ipcMain } from 'electron'
import { handleProviderProfileIpc } from './provider-profile-handlers'
import { handleStudioResultIpc } from './studio-result-handlers'
import { handleTaskPlanIpc } from './task-plan-handlers'

type AppFeature = 'task-plan' | 'studio-result' | 'provider-profile'

export function registerAppFeatureIpc(): void {
  ipcMain.handle('appFeatures:invoke', (event, rawFeature: unknown, action: unknown, ...args: unknown[]) => {
    const feature = requiredFeature(rawFeature)
    if (feature === 'task-plan') return handleTaskPlanIpc(action, args[0], args[1])
    if (feature === 'studio-result') return handleStudioResultIpc(event, action, args[0], args[1])
    return handleProviderProfileIpc(event, action, ...args)
  })
}

function requiredFeature(value: unknown): AppFeature {
  if (value === 'task-plan' || value === 'studio-result' || value === 'provider-profile') return value
  throw new Error('App feature is invalid')
}
