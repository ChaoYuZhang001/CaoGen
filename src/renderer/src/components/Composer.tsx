import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { useT } from '../i18n'

interface Mention {
  start: number
  query: string
}

/** 定位光标处正在输入的 @提及(@ 在行首或空白后,且其后无空白) */
function getMention(text: string, caret: number): Mention | null {
  let i = caret - 1
  while (i >= 0) {
    const ch = text[i]
    if (ch === '@') {
      if (i === 0 || /\s/.test(text[i - 1])) {
        const query = text.slice(i + 1, caret)
        if (/\s/.test(query)) return null
        return { start: i, query }
      }
      return null
    }
    if (/\s/.test(ch)) return null
    i--
  }
  return null
}

export default function Composer({ running }: { running: boolean }): React.JSX.Element {
  const t = useT()
  const [text, setText] = useState('')
  const sendMessage = useStore((s) => s.sendMessage)
  const activeId = useStore((s) => s.activeId)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const [mention, setMention] = useState<Mention | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [activeIndex, setActiveIndex] = useState(0)

  // 拉取文件建议(mention 变化时)
  useEffect(() => {
    if (!mention || !activeId) {
      setSuggestions([])
      return
    }
    let cancelled = false
    void window.agentDesk.suggestFiles(activeId, mention.query).then((files) => {
      if (!cancelled) {
        setSuggestions(files)
        setActiveIndex(0)
      }
    })
    return () => {
      cancelled = true
    }
  }, [mention?.query, activeId]) // eslint-disable-line react-hooks/exhaustive-deps

  const open = mention !== null && suggestions.length > 0

  const syncMention = (el: HTMLTextAreaElement): void => {
    setMention(getMention(el.value, el.selectionStart ?? el.value.length))
  }

  const submit = (): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    setText('')
    setMention(null)
    void sendMessage(trimmed)
    const el = textareaRef.current
    if (el) el.style.height = 'auto'
  }

  const applySuggestion = (path: string): void => {
    if (!mention) return
    const el = textareaRef.current
    const caret = el?.selectionStart ?? text.length
    const before = text.slice(0, mention.start)
    const after = text.slice(caret)
    const inserted = `@${path} `
    const next = before + inserted + after
    setText(next)
    setMention(null)
    setSuggestions([])
    // 光标移到插入内容之后
    requestAnimationFrame(() => {
      if (el) {
        const pos = before.length + inserted.length
        el.focus()
        el.setSelectionRange(pos, pos)
      }
    })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % suggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        applySuggestion(suggestions[activeIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMention(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  const onInput = (e: React.FormEvent<HTMLTextAreaElement>): void => {
    const el = e.currentTarget
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  return (
    <div className="composer">
      {open && (
        <div className="mention-popup">
          <div className="mention-hint">@ 引用文件 · ↑↓ 选择 · Enter 插入</div>
          {suggestions.map((path, i) => (
            <button
              key={path}
              className={`mention-item ${i === activeIndex ? 'active' : ''}`}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => applySuggestion(path)}
            >
              {path}
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        className="composer-input"
        placeholder={running ? t('composerQueuedPlaceholder') : t('composerPlaceholder')}
        value={text}
        rows={1}
        onChange={(e) => {
          setText(e.target.value)
          syncMention(e.target)
        }}
        onKeyUp={(e) => syncMention(e.currentTarget)}
        onClick={(e) => syncMention(e.currentTarget)}
        onKeyDown={onKeyDown}
        onInput={onInput}
      />
      <button className="btn btn-primary composer-send" onClick={submit} disabled={!text.trim()}>
        {t('send')}
      </button>
    </div>
  )
}
