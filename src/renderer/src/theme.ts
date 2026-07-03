import { useEffect } from 'react'
import { useStore } from './store'

/**
 * 把 settings.theme 解析为实际主题并写到 <html data-theme>。
 * system 时跟随 prefers-color-scheme 并监听切换。
 */
export function useThemeEffect(): void {
  const theme = useStore((s) => s.settings.theme)

  useEffect(() => {
    const root = document.documentElement
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const apply = (): void => {
      const resolved = theme === 'system' ? (mq.matches ? 'light' : 'dark') : theme
      root.setAttribute('data-theme', resolved)
    }
    apply()
    if (theme === 'system') {
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
    return undefined
  }, [theme])
}
