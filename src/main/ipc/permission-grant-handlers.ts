import { ipcMain } from 'electron'
import {
  listGuiAutomationGrants,
  listToolCapabilityGrants,
  revokeAllGuiAutomationGrants,
  revokeAllToolCapabilityGrants,
  revokeGuiAutomationGrant,
  revokeToolCapabilityGrant
} from '../permission/permission-manager'

type PermissionGrantKind = 'gui' | 'tool'

export function registerPermissionGrantIpc(): void {
  ipcMain.handle('permissions:grants:list', (_event, kind: unknown) => {
    return permissionGrantKind(kind) === 'gui' ? listGuiAutomationGrants() : listToolCapabilityGrants()
  })
  ipcMain.handle('permissions:grants:revoke', (_event, kind: unknown, grantId?: unknown) => {
    const normalizedKind = permissionGrantKind(kind)
    if (grantId === undefined) {
      return normalizedKind === 'gui' ? revokeAllGuiAutomationGrants() : revokeAllToolCapabilityGrants()
    }
    const normalizedId = typeof grantId === 'string' ? grantId : ''
    return normalizedKind === 'gui'
      ? revokeGuiAutomationGrant(normalizedId)
      : revokeToolCapabilityGrant(normalizedId)
  })
}

function permissionGrantKind(value: unknown): PermissionGrantKind {
  if (value === 'gui' || value === 'tool') return value
  throw new Error('权限授权类型无效')
}
