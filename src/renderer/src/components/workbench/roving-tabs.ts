import type { KeyboardEvent } from 'react'

type TabElement = HTMLButtonElement

export function rovingTabProps(active: boolean, panelId: string) {
  return {
    'aria-controls': panelId,
    'aria-selected': active,
    tabIndex: active ? 0 : -1,
    onKeyDown: handleRovingTabKeyDown
  }
}

export function tabPanelProps(panelId: string, tabId: string | undefined) {
  return {
    id: panelId,
    role: 'tabpanel' as const,
    'aria-labelledby': tabId
  }
}

export function handleRovingTabKeyDown(event: KeyboardEvent<TabElement>): void {
  const tablist = event.currentTarget.closest<HTMLElement>('[role="tablist"]')
  if (!tablist) return

  const orientation = tablist.getAttribute('aria-orientation') ?? 'horizontal'
  const direction = tabDirection(event.key, orientation)
  if (direction === null) return

  const tabs = [...tablist.querySelectorAll<TabElement>('[role="tab"]')].filter((tab) => (
    tab.closest('[role="tablist"]') === tablist
    && !tab.disabled
    && !tab.hidden
    && tab.getAttribute('aria-disabled') !== 'true'
  ))
  if (tabs.length === 0) return

  const currentIndex = tabs.indexOf(event.currentTarget)
  if (currentIndex < 0) return

  event.preventDefault()
  const next = direction === 'first'
    ? tabs[0]
    : direction === 'last'
      ? tabs[tabs.length - 1]
      : tabs[(currentIndex + direction + tabs.length) % tabs.length]
  next.click()
  next.focus({ preventScroll: true })
}

function tabDirection(
  key: string,
  orientation: string
): -1 | 1 | 'first' | 'last' | null {
  if (key === 'Home') return 'first'
  if (key === 'End') return 'last'
  if (orientation === 'vertical') {
    if (key === 'ArrowUp') return -1
    if (key === 'ArrowDown') return 1
    return null
  }
  if (key === 'ArrowLeft') return -1
  if (key === 'ArrowRight') return 1
  return null
}
