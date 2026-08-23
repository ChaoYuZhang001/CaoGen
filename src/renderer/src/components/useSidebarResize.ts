import { useEffect, useState } from 'react'
import type * as React from 'react'
import type { LayoutSettings } from '../../../shared/types'

const SIDEBAR_MIN_WIDTH = 208
const SIDEBAR_MAX_WIDTH = 420

type UpdateSettings = (settings: { layout: LayoutSettings }) => Promise<unknown>

export function useSidebarResize(
  layout: LayoutSettings,
  updateSettings: UpdateSettings
): {
  sidebarWidth: number
  patchLayout: (patch: Partial<LayoutSettings>) => void
  startSidebarResize: (event: React.PointerEvent<HTMLDivElement>) => void
} {
  const [sidebarWidth, setSidebarWidth] = useState(layout.sidebarWidth)
  useEffect(() => setSidebarWidth(layout.sidebarWidth), [layout.sidebarWidth])

  const patchLayout = (patch: Partial<LayoutSettings>): void => {
    void updateSettings({ layout: { ...layout, ...patch } }).catch((error) => {
      console.error('[agent-desk] Failed to persist sidebar layout:', error)
    })
  }
  const startSidebarResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (layout.sidebarCollapsed) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sidebarWidth
    let nextWidth = startWidth
    const move = (moveEvent: PointerEvent): void => {
      nextWidth = clamp(startWidth + moveEvent.clientX - startX)
      setSidebarWidth(nextWidth)
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      document.body.classList.remove('is-resizing-layout')
      patchLayout({ sidebarWidth: nextWidth })
    }
    document.body.classList.add('is-resizing-layout')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop, { once: true })
  }
  return { sidebarWidth, patchLayout, startSidebarResize }
}

function clamp(value: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)))
}
