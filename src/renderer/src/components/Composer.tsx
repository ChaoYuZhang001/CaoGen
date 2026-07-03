import { useRef, useState } from 'react'
import { useStore } from '../store'

export default function Composer({ running }: { running: boolean }): React.JSX.Element {
  const [text, setText] = useState('')
  const sendMessage = useStore((s) => s.sendMessage)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const submit = (): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    setText('')
    void sendMessage(trimmed)
    const el = textareaRef.current
    if (el) el.style.height = 'auto'
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
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
      <textarea
        ref={textareaRef}
        className="composer-input"
        placeholder={running ? '继续输入,消息将排队处理…' : '让 Agent 做点什么…(Enter 发送,Shift+Enter 换行)'}
        value={text}
        rows={1}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onInput={onInput}
      />
      <button className="btn btn-primary composer-send" onClick={submit} disabled={!text.trim()}>
        发送
      </button>
    </div>
  )
}
