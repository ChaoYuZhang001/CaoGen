import type { PluginRegistryItem } from '../../../../shared/types'
import {
  buildComposerSlashCommands,
  buildPluginCommands,
  shouldLoadPluginSlashRegistry,
  type CommandDescriptor,
  type ComposerCommandContext,
  type PluginCommandHandlers
} from '../../commands'
import type { ExperienceMode } from '../../store/experience-mode'

const ASSISTANT_COMMAND_IDS = new Set([
  'rewind',
  'browser',
  'files',
  'routine',
  'memory',
  'theme'
])

export function projectedComposerCommands({
  commandContext,
  pluginHandlers,
  pluginItems,
  projection,
  slashQuery
}: {
  commandContext: ComposerCommandContext
  pluginHandlers: PluginCommandHandlers
  pluginItems: PluginRegistryItem[]
  projection: ExperienceMode
  slashQuery: string | null
}): CommandDescriptor[] {
  const base = buildComposerSlashCommands(commandContext)
  if (projection === 'assistant') return base.filter((command) => ASSISTANT_COMMAND_IDS.has(command.id))
  const plugins = slashQuery && slashQuery.length > 0
    ? buildPluginCommands(pluginItems, pluginHandlers)
    : []
  return [...base, ...plugins]
}

export function shouldLoadProjectedPluginRegistry(
  projection: ExperienceMode,
  slashQuery: string | null
): boolean {
  return projection === 'studio' && shouldLoadPluginSlashRegistry(slashQuery)
}

export function projectedPaletteItems<T extends { id: string; section: string }>(
  projection: ExperienceMode,
  items: T[]
): T[] {
  if (projection === 'studio') return items
  return items.filter((item) => {
    if (item.section === 'plugin') return false
    if (!item.id.startsWith('slash:')) return true
    return ASSISTANT_COMMAND_IDS.has(item.id.slice('slash:'.length))
  })
}
