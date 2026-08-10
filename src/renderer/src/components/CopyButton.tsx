import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { useT } from '../i18n'

export default function CopyButton({
  text,
  kind,
  className = ''
}: {
  text: string
  kind: 'message' | 'code'
  className?: string
}): React.JSX.Element | null {
  const t = useT()
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const resetTimer = useRef<number | null>(null)
  const idleLabel = t(kind === 'message' ? 'copyMessage' : 'copyCode')
  const label = state === 'copied' ? t('copied') : state === 'failed' ? t('copyFailed') : idleLabel

  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
  }, [])

  if (!text) return null
  const copy = async (): Promise<void> => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable')
      await navigator.clipboard.writeText(text)
      setState('copied')
    } catch {
      setState('failed')
    }
    resetTimer.current = window.setTimeout(() => setState('idle'), 1800)
  }

  return (
    <button
      type="button"
      className={`copy-button ${className}`.trim()}
      aria-label={label}
      title={label}
      data-copy-kind={kind}
      data-copy-state={state}
      onClick={() => void copy()}
    >
      {state === 'copied' ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
    </button>
  )
}
