import { useEffect, useRef } from 'react'
import type * as React from 'react'

export interface SessionMenuItem {
  key: string
  label: string
  danger?: boolean
  onClick: () => void
}

interface SessionContextMenuProps {
  x: number
  y: number
  items: SessionMenuItem[]
  onClose: () => void
}

export default function SessionContextMenu({
  x,
  y,
  items,
  onClose
}: SessionContextMenuProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      if (ref.current?.contains(event.target as Node)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const width = 196
  const height = items.length * 34 + 12
  const style: React.CSSProperties = {
    left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(y, window.innerHeight - height - 8))
  }

  return (
    <div ref={ref} className="ctx-menu" style={style} role="menu">
      {items.map((item) => (
        <button
          key={item.key}
          className={`ctx-menu-item ${item.danger ? 'ctx-menu-danger' : ''}`}
          role="menuitem"
          onClick={() => {
            item.onClick()
            onClose()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
