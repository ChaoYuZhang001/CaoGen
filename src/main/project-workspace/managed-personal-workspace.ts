import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  MANAGED_PERSONAL_WORKSPACE_ID,
  type ProjectWorkspace
} from '../../shared/project-workspace-types'
import { openProjectWorkspaceStore } from './store'

export { MANAGED_PERSONAL_WORKSPACE_ID }

export async function ensureManagedPersonalWorkspace(rootDir: string): Promise<{
  cwd: string
  workspace: ProjectWorkspace
}> {
  const cwd = join(rootDir, 'personal-workspace')
  mkdirSync(cwd, { recursive: true, mode: 0o700 })
  chmodSync(cwd, 0o700)

  const store = await openProjectWorkspaceStore(rootDir)
  let workspace = await store.getWorkspace(MANAGED_PERSONAL_WORKSPACE_ID)
  if (!workspace) {
    try {
      workspace = await store.createWorkspace({
        id: MANAGED_PERSONAL_WORKSPACE_ID,
        name: 'Personal Workspace',
        kind: 'personal',
        ownerId: 'local-user',
        resources: [],
        permissionPolicy: {
          managed: true,
          executionRoot: 'app_owned',
          directoryMode: '0700'
        },
        retentionPolicy: {
          managed: true,
          deleteWithAppData: true
        }
      })
    } catch (error) {
      workspace = await store.getWorkspace(MANAGED_PERSONAL_WORKSPACE_ID)
      if (!workspace) throw error
    }
  }
  if (
    workspace.status !== 'active' ||
    workspace.kind !== 'personal' ||
    workspace.ownerId !== 'local-user' ||
    workspace.resources.length !== 0 ||
    workspace.permissionPolicy?.managed !== true ||
    workspace.permissionPolicy.executionRoot !== 'app_owned' ||
    workspace.permissionPolicy.directoryMode !== '0700' ||
    workspace.retentionPolicy?.managed !== true ||
    workspace.retentionPolicy.deleteWithAppData !== true
  ) {
    throw new Error(`managed personal Workspace identity conflict:${workspace.id}`)
  }
  return { cwd, workspace }
}
