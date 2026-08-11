import { app } from 'electron'
import type { CreateSessionOptions } from '../../shared/types'
import { sessionManager } from '../sessionManager'
import { ensureManagedPersonalWorkspace } from '../project-workspace/managed-personal-workspace'

export async function createUnassignedSession(
  options: CreateSessionOptions
): ReturnType<typeof sessionManager.createManaged> {
  // Conversations keep their zero-configuration contract while gaining a
  // stable, app-owned personal Workspace container for retention and recovery.
  const managed = await ensureManagedPersonalWorkspace(app.getPath('userData'))
  return sessionManager.createManaged({
    ...options,
    cwd: managed.cwd,
    isolated: false,
    unassigned: true,
    personalWorkspaceId: managed.workspace.id
  })
}
