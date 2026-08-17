import { useLayoutEffect } from 'react'

interface AutosizeTextareaOptions {
  maxHeight?: number
  minHeight?: number
}

export function resizeAutosizeTextarea(
  element: HTMLTextAreaElement,
  options: AutosizeTextareaOptions = {}
): void {
  const minHeight = options.minHeight ?? 36
  const viewportLimit = Math.max(240, Math.min(460, window.innerHeight * 0.5))
  const maxHeight = Math.max(minHeight, options.maxHeight ?? viewportLimit)

  element.style.height = '0px'
  const contentHeight = Math.max(minHeight, Math.ceil(element.scrollHeight))
  const nextHeight = Math.min(contentHeight, maxHeight)
  element.style.height = `${nextHeight}px`
  element.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden'
}

export function useAutosizeTextarea(
  ref: React.RefObject<HTMLTextAreaElement | null>,
  value: string,
  options: AutosizeTextareaOptions = {}
): void {
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const resize = (): void => resizeAutosizeTextarea(element, options)
    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [options.maxHeight, options.minHeight, ref, value])
}
