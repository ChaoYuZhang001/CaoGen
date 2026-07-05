import { useEffect, useRef, useState } from 'react'
import { MODEL_OPTIONS, useStore } from '../store'
import { useT } from '../i18n'
import type { ImageAttachmentView } from '../../../shared/types'
import ImageAttachmentTray from './ImageAttachmentTray'
import {
  buildComposerSlashCommands,
  buildPluginCommands,
  filterCommandItems,
  shouldLoadPluginSlashRegistry,
  type CommandDescriptor
} from '../commands'

interface Mention {
  start: number
  query: string
}

interface ComposerImageAttachment extends ImageAttachmentView {
  name: string
  previewUrl?: string
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

function isSupportedImageFile(file: File): boolean {
  const type = file.type.toLowerCase()
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type)) return true
  return /\.(png|jpe?g|gif|webp)$/i.test(file.name)
}

function filePath(file: File): string | undefined {
  return (file as File & { path?: string }).path
}

export default function Composer({ running }: { running: boolean }): React.JSX.Element {
  const t = useT()
  const [text, setText] = useState('')
  const sendMessage = useStore((s) => s.sendMessage)
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
  const theme = useStore((s) => s.settings.theme)
  const activeId = useStore((s) => s.activeId)
  const pluginRegistry = useStore((s) => s.workbench.pluginRegistry)
  const pluginRegistryLoading = useStore((s) => s.workbench.pluginRegistryLoading)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const previewUrls = useRef(new Set<string>())
  const slashRegistryScanKey = useRef<string | null>(null)

  const [mention, setMention] = useState<Mention | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [slashIndex, setSlashIndex] = useState(0)
  const [attachments, setAttachments] = useState<ComposerImageAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [ocrBusyId, setOcrBusyId] = useState<string | null>(null)
  const [uploadingAttachment, setUploadingAttachment] = useState(false)
  const [dragActive, setDragActive] = useState(false)

  useEffect(() => {
    return () => {
      for (const url of previewUrls.current) URL.revokeObjectURL(url)
      previewUrls.current.clear()
    }
  }, [])

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

  const mentionOpen = mention !== null && suggestions.length > 0
  const slashQuery = text.startsWith('/') && !text.includes('\n') ? text.slice(1).trim().toLowerCase() : null
  const pluginSlashCommands: CommandDescriptor[] =
    slashQuery && slashQuery.length > 0
      ? buildPluginCommands(pluginRegistry?.items ?? [], {
          sendPluginRegistryItemToAgent,
          dispatchPluginAgent
        })
      : []
  const slashCommands: CommandDescriptor[] = [
    ...buildComposerSlashCommands({
      t,
      modelOptions: MODEL_OPTIONS,
      theme,
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
    }),
    ...pluginSlashCommands
  ]
  const slashMatches = slashQuery === null ? [] : filterCommandItems(slashQuery, slashCommands)
  const slashOpen = slashQuery !== null && slashMatches.length > 0

  useEffect(() => {
    if (!shouldLoadPluginSlashRegistry(slashQuery) || pluginRegistryLoading) return
    const key = activeId ?? '__no_session__'
    if (slashRegistryScanKey.current === key && pluginRegistry) return
    slashRegistryScanKey.current = key
    void loadPluginRegistryForSlash()
  }, [activeId, loadPluginRegistryForSlash, pluginRegistry, pluginRegistryLoading, slashQuery])

  useEffect(() => {
    setSlashIndex(0)
  }, [slashQuery])

  const syncMention = (el: HTMLTextAreaElement): void => {
    setMention(getMention(el.value, el.selectionStart ?? el.value.length))
  }

  const runSlashCommand = (cmd: CommandDescriptor): void => {
    setText('')
    setMention(null)
    setSuggestions([])
    cmd.run?.()
    if (cmd.insert) setText(cmd.insert)
  }

  const revokePreview = (url: string | undefined): void => {
    if (!url || !previewUrls.current.has(url)) return
    URL.revokeObjectURL(url)
    previewUrls.current.delete(url)
  }

  const clearAttachments = (): void => {
    for (const attachment of attachments) revokePreview(attachment.previewUrl)
    setAttachments([])
  }

  const addImageFiles = async (files: Iterable<File>): Promise<void> => {
    if (!activeId) {
      setAttachmentError('请先创建或选择一个会话')
      return
    }
    const selected = [...files].filter(isSupportedImageFile)
    if (selected.length === 0) {
      setAttachmentError('仅支持 PNG、JPG、GIF、WebP 图片')
      return
    }
    setAttachmentError(null)
    setUploadingAttachment(true)
    try {
      for (const file of selected) {
        const previewUrl = URL.createObjectURL(file)
        previewUrls.current.add(previewUrl)
        const localPath = filePath(file)
        const result = localPath
          ? await window.agentDesk.copyImageAttachment(activeId, localPath)
          : await window.agentDesk.saveImageAttachmentBytes(activeId, {
              data: await file.arrayBuffer(),
              mime: file.type || undefined
            })

        if (!result.ok) {
          revokePreview(previewUrl)
          setAttachmentError(result.error)
          continue
        }

        setAttachments((current) => {
          if (current.some((item) => item.id === result.id)) {
            revokePreview(previewUrl)
            return current
          }
          return [
            ...current,
            {
              ...result,
              name: file.name || `${result.id.slice(0, 8)}.${result.mime.split('/')[1] ?? 'image'}`,
              previewUrl
            }
          ]
        })
      }
    } finally {
      setUploadingAttachment(false)
    }
  }

  /** OCR:提取附件文字,插到输入框光标处;失败时如实提示(不伪造) */
  const runOcr = async (attachmentId: string): Promise<void> => {
    if (!activeId) return
    const target = attachments.find((item) => item.id === attachmentId)
    if (!target) return
    setOcrBusyId(attachmentId)
    setAttachmentError(null)
    try {
      const result = await window.agentDesk.ocrImageAttachment(activeId, target.path)
      if (!result.ok || !result.text) {
        setAttachmentError(result.error || 'OCR 未识别到文字')
        return
      }
      setText((current) =>
        current
          ? `${current}\n\n[图片 ${target.name} OCR]\n${result.text}`
          : `[图片 ${target.name} OCR]\n${result.text}`
      )
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : String(err))
    } finally {
      setOcrBusyId(null)
    }
  }

  const submit = (): void => {
    const trimmed = text.trim()
    if (!trimmed && attachments.length === 0) return
    const normalizedTrimmed = trimmed.toLowerCase()
    const exactSlash = slashCommands.find((cmd) => cmd.title.toLowerCase() === normalizedTrimmed)
    if (exactSlash && attachments.length === 0) {
      runSlashCommand(exactSlash)
      return
    }
    const images = attachments.map<ImageAttachmentView>(({ name: _name, previewUrl: _previewUrl, ...image }) => image)
    setText('')
    setMention(null)
    clearAttachments()
    void sendMessage({ text: trimmed, images })
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
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex((i) => (i + 1) % slashMatches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        runSlashCommand(slashMatches[slashIndex] ?? slashMatches[0])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setText('')
        return
      }
    }
    if (mentionOpen) {
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

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = [...e.clipboardData.files].filter(isSupportedImageFile)
    if (files.length === 0) return
    e.preventDefault()
    void addImageFiles(files)
  }

  const onDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setDragActive(false)
    void addImageFiles(e.dataTransfer.files)
  }

  return (
    <div
      className={`composer ${dragActive ? 'composer-drag-active' : ''}`}
      onDragEnter={(e) => {
        e.preventDefault()
        setDragActive(true)
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDragActive(false)
      }}
      onDrop={onDrop}
    >
      {slashOpen && (
        <div className="slash-popup">
          <div className="mention-hint">{t('slashHint')}</div>
          {slashMatches.map((cmd, i) => (
            <button
              key={cmd.id}
              className={`slash-item ${i === slashIndex ? 'active' : ''}`}
              onMouseEnter={() => setSlashIndex(i)}
              onClick={() => runSlashCommand(cmd)}
            >
              <span className="slash-title">{cmd.title}</span>
              <span className="slash-desc">{cmd.hint}</span>
            </button>
          ))}
        </div>
      )}
      {mentionOpen && (
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
      <ImageAttachmentTray
        attachments={attachments.map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          bytes: attachment.bytes,
          thumbnailUrl: attachment.previewUrl,
          mimeType: attachment.mime
        }))}
        disabled={uploadingAttachment}
        ocrBusyId={ocrBusyId}
        onOcr={(id) => void runOcr(id)}
        onRemove={(id) =>
          setAttachments((current) => {
            const target = current.find((item) => item.id === id)
            revokePreview(target?.previewUrl)
            return current.filter((item) => item.id !== id)
          })
        }
      />
      {attachmentError && <div className="composer-error">{attachmentError}</div>}
      <div className="composer-row">
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
          onPaste={onPaste}
        />
        <button
          className="btn btn-primary composer-send"
          onClick={submit}
          disabled={uploadingAttachment || (!text.trim() && attachments.length === 0)}
        >
          {uploadingAttachment ? '添加中' : t('send')}
        </button>
      </div>
    </div>
  )
}
