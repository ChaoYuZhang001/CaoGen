import { ipcMain } from 'electron'
import { handleProviderProfileIpc } from './provider-profile-handlers'
import { handleProviderProfileSyncIpc } from './provider-profile-sync-handlers'
import { handleProjectTestIpc } from './project-test-handlers'
import { handleProjectDebugIpc } from './project-debug-handlers'
import { handleProjectRefactorIpc } from './project-refactor-handlers'
import { handleStudioResultIpc } from './studio-result-handlers'
import { handleTaskPlanIpc } from './task-plan-handlers'

type AppFeature = 'task-plan' | 'studio-result' | 'provider-profile' | 'provider-profile-sync' | 'project-test' | 'project-debug' | 'project-refactor'

export function registerAppFeatureIpc(): void {
  ipcMain.handle('appFeatures:invoke', (event, rawFeature: unknown, action: unknown, ...args: unknown[]) => {
    const feature = requiredFeature(rawFeature)
    if (feature === 'task-plan') return handleTaskPlanIpc(action, args[0], args[1])
    if (feature === 'studio-result') return handleStudioResultIpc(event, action, args[0], args[1])
    if (feature === 'project-test') return handleProjectTestIpc(event, action, args[0], args[1])
    if (feature === 'project-debug') return handleProjectDebugIpc(event, action, args[0], ...args.slice(1))
    if (feature === 'project-refactor') return handleProjectRefactorIpc(event, action, args[0], args[1])
    if (feature === 'provider-profile-sync') return handleProviderProfileSyncIpc(event, action, ...args)
    return handleProviderProfileIpc(event, action, ...args)
  })
}

function requiredFeature(value: unknown): AppFeature {
  if (value === 'task-plan' || value === 'studio-result' || value === 'provider-profile' || value === 'provider-profile-sync' || value === 'project-test' || value === 'project-debug' || value === 'project-refactor') return value
  throw new Error('App feature is invalid')
}
