import { randomUUID } from 'node:crypto'
import type { PluginInstallResult, PluginUninstallResult } from '../shared/types'
import {
  buildManagedPluginEffectTarget,
  executeManagedPluginInstallTarget,
  executeManagedPluginUninstallTarget,
  pluginInstallToolInput,
  pluginUninstallToolInput,
  preparePluginInstall,
  preparePluginUninstall
} from './plugin/plugin-directory-effect'

export type { PluginInstallResult, PluginUninstallResult } from '../shared/types'

/**
 * Low-level synchronous compatibility API used by focused filesystem tests.
 * Production Renderer IPC always calls the durable Effect wrapper instead.
 */
export function installLocalPlugin(
  sourceDir: string,
  pluginsRoot: string,
  opts: { overwrite?: boolean } = {}
): PluginInstallResult {
  const prepared = preparePluginInstall(
    sourceDir,
    pluginsRoot,
    opts.overwrite === true,
    transitionId()
  )
  if ('ok' in prepared) return prepared
  try {
    const target = buildManagedPluginEffectTarget(
      prepared.operationCwd,
      'managed_plugin_install',
      pluginInstallToolInput(prepared)
    )
    if (target.kind !== 'managed_plugin_install') return { ok: false, error: '插件安装目标类型不匹配' }
    return executeManagedPluginInstallTarget(target, prepared.sourcePath)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function uninstallPlugin(targetPath: string, pluginsRoot: string): PluginUninstallResult {
  const prepared = preparePluginUninstall(targetPath, pluginsRoot, transitionId())
  if ('ok' in prepared) return prepared
  try {
    const target = buildManagedPluginEffectTarget(
      prepared.operationCwd,
      'managed_plugin_uninstall',
      pluginUninstallToolInput(prepared)
    )
    if (target.kind !== 'managed_plugin_uninstall') return { ok: false, error: '插件卸载目标类型不匹配' }
    return executeManagedPluginUninstallTarget(target)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function transitionId(): string {
  return randomUUID().replace(/-/g, '')
}
