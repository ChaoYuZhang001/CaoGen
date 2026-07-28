import type { EffectStatus } from './effect-types'

interface PluginEffectMetadata {
  effectStatus?: EffectStatus
  operationId?: string
  snapshotId?: string
}

export interface PluginInstallResult extends PluginEffectMetadata {
  ok: boolean
  installedPath?: string
  name?: string
  error?: string
}

export interface PluginUninstallResult extends PluginEffectMetadata {
  ok: boolean
  trashedTo?: string
  error?: string
}
