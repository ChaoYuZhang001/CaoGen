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
  if (!isRecord(value)) throw new Error('Local gateway update is invalid')
  const row = value as Record<string, unknown>
  assertAllowedFields(row)
  assertOptionalBoolean(row.enabled, 'Local gateway enabled state is invalid')
  assertOptionalBoolean(row.regenerateToken, 'Local gateway token action is invalid')
  assertOptionalPort(row.port)
  return compactUpdate(row)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertAllowedFields(row: Record<string, unknown>): void {
  const allowed = new Set(['enabled', 'port', 'regenerateToken'])
  if (Object.keys(row).some((key) => !allowed.has(key))) {
    throw new Error('Local gateway update contains unsupported fields')
  }
}

function assertOptionalBoolean(value: unknown, message: string): void {
  if (value !== undefined && typeof value !== 'boolean') throw new Error(message)
}

function assertOptionalPort(value: unknown): void {
  if (value === undefined) return
  const port = Number(value)
  if (!Number.isSafeInteger(value) || port < 1024 || port > 65535) {
    throw new Error('Local gateway port must be between 1024 and 65535')
  }
}

function compactUpdate(row: Record<string, unknown>): ProviderGatewayUpdateInput {
  return {
    ...(row.enabled === undefined ? {} : { enabled: row.enabled as boolean }),
    ...(row.port === undefined ? {} : { port: row.port as number }),
    ...(row.regenerateToken === undefined ? {} : { regenerateToken: row.regenerateToken as boolean })
  }
}
