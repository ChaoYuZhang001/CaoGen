import { readFileSync } from 'node:fs'
import { ipcMain } from 'electron'
import type { PluginRegistryItem } from '../../shared/types'
import { executeMcpProbeEffect, type McpProbeEffectContext } from '../mcpProbeEffect'
import { probeMcpServers, type McpProbeInput } from '../mcpProbe'
import { executeInteractiveOperationEffect } from '../task/operation-effect-gateway'

export interface McpProbeIpcDependencies {
  findScannedItem(item: PluginRegistryItem, sessionId?: string): PluginRegistryItem | undefined
  operationContext(sessionId?: string): McpProbeEffectContext
}

export function registerMcpProbeIpc(dependencies: McpProbeIpcDependencies): void {
  ipcMain.handle('plugins:probeMcp', async (_event, items: unknown, sessionId?: string) => {
    if (!Array.isArray(items) || items.length === 0) return { ok: true, results: [] }
    const capped = items.filter(isPluginRegistryItem).filter((item) => item.kind === 'mcp').slice(0, 20)
    const inputs: McpProbeInput[] = []
    for (const item of capped) {
      const scanned = dependencies.findScannedItem(item, sessionId)
      if (!scanned) continue
      const config = readScannedMcpConfig(scanned)
      if (config) inputs.push({ id: scanned.id, config })
    }
    return executeMcpProbeEffect(
      dependencies.operationContext(sessionId),
      inputs,
      executeInteractiveOperationEffect,
      probeMcpServers
    )
  })
}

function readScannedMcpConfig(item: PluginRegistryItem): Record<string, unknown> | undefined {
  try {
    const raw = JSON.parse(readFileSync(item.path, 'utf8')) as Record<string, unknown>
    const servers = raw.mcpServers
    if (!servers || typeof servers !== 'object') return undefined
    const config = (servers as Record<string, unknown>)[item.name]
    return config && typeof config === 'object' ? config as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function isPluginRegistryItem(value: unknown): value is PluginRegistryItem {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    (record.kind === 'plugin' || record.kind === 'skill' || record.kind === 'agent' || record.kind === 'mcp') &&
    typeof record.name === 'string' &&
    typeof record.sourceRoot === 'string' &&
    typeof record.path === 'string'
  )
}
