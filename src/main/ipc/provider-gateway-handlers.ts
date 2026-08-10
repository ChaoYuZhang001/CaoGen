import { clipboard, ipcMain } from 'electron'
import type { ProviderGatewayUpdateInput } from '../../shared/provider-gateway-types'
import {
  listProviderGatewayModels,
  providerGatewayStatus,
  updateProviderGateway
} from '../provider/providerGatewayService'
import { resolveProviderGatewayToken } from '../provider/providerGatewayStore'

export function registerProviderGatewayIpc(): void {
  ipcMain.handle('providers:gateway:status', () => providerGatewayStatus())
  ipcMain.handle('providers:gateway:models', () => listProviderGatewayModels())
  ipcMain.handle('providers:gateway:update', (_event, input: ProviderGatewayUpdateInput) =>
    updateProviderGateway(normalizeUpdateInput(input)))
  ipcMain.handle('providers:gateway:copy-token', () => {
    clipboard.writeText(resolveProviderGatewayToken())
    return true
  })
}

function normalizeUpdateInput(value: unknown): ProviderGatewayUpdateInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Local gateway update is invalid')
  }
  const row = value as Record<string, unknown>
  const allowed = new Set(['enabled', 'port', 'regenerateToken'])
  if (Object.keys(row).some((key) => !allowed.has(key))) throw new Error('Local gateway update contains unsupported fields')
  if (row.enabled !== undefined && typeof row.enabled !== 'boolean') throw new Error('Local gateway enabled state is invalid')
  if (row.regenerateToken !== undefined && typeof row.regenerateToken !== 'boolean') {
    throw new Error('Local gateway token action is invalid')
  }
  if (row.port !== undefined && (!Number.isSafeInteger(row.port) || Number(row.port) < 1024 || Number(row.port) > 65535)) {
    throw new Error('Local gateway port must be between 1024 and 65535')
  }
  return {
    ...(row.enabled === undefined ? {} : { enabled: row.enabled as boolean }),
    ...(row.port === undefined ? {} : { port: row.port as number }),
    ...(row.regenerateToken === undefined ? {} : { regenerateToken: row.regenerateToken as boolean })
  }
}
