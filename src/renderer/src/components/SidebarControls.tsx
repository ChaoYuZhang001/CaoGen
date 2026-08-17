import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'

export function restoreComposerFocus(): void {
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLTextAreaElement>('.composer-input, .welcome-composer-input')?.focus()
  })
}

export function SidebarPanelIcon({ collapsed }: { collapsed: boolean }): React.JSX.Element {
  return collapsed
    ? <PanelLeftOpen size={16} strokeWidth={1.8} aria-hidden="true" />
    : <PanelLeftClose size={16} strokeWidth={1.8} aria-hidden="true" />
}
