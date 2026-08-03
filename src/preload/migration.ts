import { ipcRenderer } from 'electron'
import type { MigrationApi } from '../shared/types'

export const migrationApi: MigrationApi = {
  scanMigration: (cwd?: string) => ipcRenderer.invoke('migration:scan', cwd),
  applyMigration: (input) => ipcRenderer.invoke('migration:apply', input),
  rollbackMigration: (backupId: string) => ipcRenderer.invoke('migration:rollback', backupId)
}
