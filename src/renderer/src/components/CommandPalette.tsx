import { useEffect, useMemo, useRef, useState } from 'react'
import { modelOptionsForProvider, useStore } from '../store'
import { useT } from '../i18n'
import {
  buildPaletteCommands,
  buildPluginCommands,
  filterCommandItems,
  type CommandDescriptor
} from '../commands'

type PaletteSection = 'command' | 'session' | 'history' | 'plugin'

interface PaletteItem extends CommandDescriptor {
  section: PaletteSection
}

export default function CommandPalette(): React.JSX.Element {
  const t = useT()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const order = useStore((s) => s.order)
  const activeId = useStore((s) => s.activeId)
  const sessions = useStore((s) => s.sessions)
  const history = useStore((s) => s.history)
  const providers = useStore((s) => s.providers)
  const theme = useStore((s) => s.settings.theme)
  const pluginRegistry = useStore((s) => s.workbench.pluginRegistry)
  const pluginRegistryLoading = useStore((s) => s.workbench.pluginRegistryLoading)
  const setShowCommandPalette = useStore((s) => s.setShowCommandPalette)
  const setShowNewSession = useStore((s) => s.setShowNewSession)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const selectSession = useStore((s) => s.selectSession)
  const resumeFromHistory = useStore((s) => s.resumeFromHistory)
  const setView = useStore((s) => s.setView)
  const openLatestRewindPanel = useStore((s) => s.openLatestRewindPanel)
  const openBrowserPanel = useStore((s) => s.openBrowserPanel)
  const openDiffPanel = useStore((s) => s.openDiffPanel)
  const openFilesPanel = useStore((s) => s.openFilesPanel)
  const openWorktreePanel = useStore((s) => s.openWorktreePanel)
  const openTerminalPanel = useStore((s) => s.openTerminalPanel)
  const openPluginRegistryPanel = useStore((s) => s.openPluginRegistryPanel)
  const openSubagentPanel = useStore((s) => s.openSubagentPanel)
  const openRoutinePanel = useStore((s) => s.openRoutinePanel)
  const openMemoryPanel = useStore((s) => s.openMemoryPanel)
  const loadPluginRegistryForSlash = useStore((s) => s.loadPluginRegistryForSlash)
  const sendPluginRegistryItemToAgent = useStore((s) => s.sendPluginRegistryItemToAgent)
  const dispatchPluginAgent = useStore((s) => s.dispatchPluginAgent)
  const updateSettings = useStore((s) => s.updateSettings)
  const setModel = useStore((s) => s.setModel)

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  useEffect(() => {
    if (!pluginRegistry && !pluginRegistryLoading) void loadPluginRegistryForSlash()
  }, [loadPluginRegistryForSlash, pluginRegistry, pluginRegistryLoading])

  const close = (): void => setShowCommandPalette(false)

  const focusSidebarSearch = (): void => {
    setView('list')
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>('.sidebar-search')
      if (!input) return
      input.focus()
      input.select()
    })
  }

  const items = useMemo<PaletteItem[]>(() => {
    const openSessionIds = new Set(order)
    const openSdkIds = new Set(
      order.map((id) => sessions[id]?.meta.sdkSessionId).filter((id): id is string => Boolean(id))
    )
    const activeMeta = activeId ? sessions[activeId]?.meta : undefined
    const commandItems: PaletteItem[] = buildPaletteCommands({
      t,
      modelOptions: modelOptionsForProvider(
        providers,
        activeMeta?.providerId ?? '',
        t('autoRoute'),
        activeMeta?.model
      ),
      theme,
      setShowNewSession,
      setShowSettings,
      focusSidebarSearch,
      openLatestRewindPanel,
      openDiffPanel,
      openBrowserPanel,
      openFilesPanel,
      openWorktreePanel,
      openTerminalPanel,
      openPluginRegistryPanel,
      openSubagentPanel,
      openRoutinePanel,
      openMemoryPanel,
      updateSettings,
      setModel
    }).map((item) => ({ ...item, section: 'command' }))

    const activeSessionItems: PaletteItem[] = order.flatMap((id, index) => {
      const session = sessions[id]
      if (!session) return []
      return [
        {
          id: `session:${id}`,
          title: session.meta.title,
          hint: session.meta.cwd,
          searchText: `${session.meta.title} ${session.meta.cwd} ${session.meta.sourceCwd ?? ''} ${index + 1}`,
          section: 'session' as const,
          run: () => selectSession(id)
        }
      ]
    })

    const historyItems: PaletteItem[] = history
      .filter((entry) => !openSessionIds.has(entry.id) && !openSdkIds.has(entry.sdkSessionId))
      .map((entry) => ({
        id: `history:${entry.id}`,
        title: entry.title,
        hint: entry.sourceCwd ?? entry.cwd,
        searchText: `${entry.title} ${entry.cwd} ${entry.sourceCwd ?? ''}`,
        section: 'history' as const,
        run: () => void resumeFromHistory(entry)
      }))

    const pluginItems: PaletteItem[] = buildPluginCommands(pluginRegistry?.items ?? [], {
      sendPluginRegistryItemToAgent,
      dispatchPluginAgent
    }).map((item) => ({ ...item, section: 'plugin' }))

    return [...commandItems, ...activeSessionItems, ...historyItems, ...pluginItems]
  }, [
    activeId,
    dispatchPluginAgent,
    history,
    openBrowserPanel,
    openDiffPanel,
    openFilesPanel,
    openLatestRewindPanel,
    openMemoryPanel,
    openPluginRegistryPanel,
    openRoutinePanel,
    openSubagentPanel,
    openTerminalPanel,
    openWorktreePanel,
    order,
    pluginRegistry,
    providers,
    resumeFromHistory,
    selectSession,
    sendPluginRegistryItemToAgent,
    sessions,
    setModel,
    setShowNewSession,
    setShowSettings,
    setView,
    t,
    theme,
    updateSettings
  ])

  const matches = useMemo(() => filterCommandItems(query, items).slice(0, 80), [items, query])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    if (activeIndex >= matches.length) setActiveIndex(Math.max(0, matches.length - 1))
  }, [activeIndex, matches.length])

  const runItem = (item: PaletteItem | undefined): void => {
    if (!item) return
    close()
    item.run?.()
  }

  const sectionLabel = (section: PaletteSection): string => {
    if (section === 'session') return t('commandSectionSession')
    if (section === 'history') return t('commandSectionHistory')
    if (section === 'plugin') return t('commandSectionPlugin')
    return t('commandSectionCommand')
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (matches.length === 0 ? 0 : (i + 1) % matches.length))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (matches.length === 0 ? 0 : (i - 1 + matches.length) % matches.length))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      runItem(matches[activeIndex] ?? matches[0])
    }
  }

  return (
    <div
      className="command-palette-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
      onKeyDown={onKeyDown}
    >
      <div className="command-palette" role="dialog" aria-modal="true" aria-label={t('commandPaletteTitle')}>
        <input
          ref={inputRef}
          className="input command-palette-input"
          value={query}
          placeholder={t('commandPalettePlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="command-palette-list">
          {matches.length === 0 ? (
            <div className="command-palette-empty">{t('commandNoResults')}</div>
          ) : (
            matches.map((item, index) => (
              <button
                key={item.id}
                className={`command-palette-item ${index === activeIndex ? 'active' : ''}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => runItem(item)}
              >
                <span className="command-palette-section">{sectionLabel(item.section)}</span>
                <span className="command-palette-main">
                  <span className="command-palette-item-title">{item.title}</span>
                  <span className="command-palette-item-hint">{item.hint}</span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
