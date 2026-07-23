import { createHash, randomUUID } from 'node:crypto'
import type {
  AssistantBlock,
  ImageAttachmentView,
  UserMessageAttachmentView
} from '../shared/types'
import type { StableMessagePayload } from './stable-message-payload'

const TOOL_RESULT_MAX_CHARS = 20_000

export function normalizeClaudeToolName(toolName: string): string {
  if (toolName === 'Bash') return 'bash'
  if (toolName === 'Read') return 'read_file'
  if (toolName === 'LS') return 'list_dir'
  if (toolName === 'Grep') return 'search_code'
  if (toolName === 'Glob') return 'find_file'
  if (toolName === 'Write') return 'write_file'
  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') return 'edit_file'
  return toolName
}

export function normalizeClaudeToolInput(
  toolName: string,
  input: Record<string, unknown>
): Record<string, unknown> {
  const normalized = { ...input }
  const pathValue = normalized.path ?? normalized.file_path ?? normalized.notebook_path
  if (typeof pathValue === 'string' && pathValue.trim()) {
    normalized.path = pathValue
    normalized.file_path = pathValue
  }
  if (toolName === 'Glob' && typeof normalized.pattern === 'string') normalized.path = normalized.path ?? '.'
  return normalized
}

export function providerTokenFingerprint(token: string): string {
  return token ? createHash('sha256').update(token).digest('hex').slice(0, 16) : 'no-token'
}

/** Split a newline/comma-delimited Claude tool list. */
export function splitList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export function normalizeBlocks(content: unknown): AssistantBlock[] {
  if (!Array.isArray(content)) return []
  const out: AssistantBlock[] = []
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const block = raw as Record<string, unknown>
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      out.push({ type: 'text', text: block.text })
    } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0) {
      out.push({ type: 'thinking', text: block.thinking })
    } else if (block.type === 'tool_use') {
      out.push({
        type: 'tool_use',
        id: typeof block.id === 'string' ? block.id : randomUUID(),
        name: typeof block.name === 'string' ? block.name : 'unknown',
        input: block.input
      })
    }
  }
  return out
}

export function userMessageText(payload: StableMessagePayload): string {
  if (payload.text) return payload.text
  return payload.images.length > 0 ? `图片输入 (${payload.images.length} 张)` : ''
}

export function compactUserAttachments(
  images: ImageAttachmentView[]
): UserMessageAttachmentView[] | undefined {
  if (images.length === 0) return undefined
  return images.map((image) => ({ id: image.id, mime: image.mime, bytes: image.bytes }))
}

export function toolResultText(content: unknown): string {
  let text: string
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    text = content
      .map((item) => {
        const block = item as Record<string, unknown> | null
        if (block && block.type === 'text' && typeof block.text === 'string') return block.text
        return `[${(block && block.type) || 'block'}]`
      })
      .join('\n')
  } else if (content == null) {
    text = ''
  } else {
    try {
      text = JSON.stringify(content, null, 2)
    } catch {
      text = String(content)
    }
  }
  if (text.length > TOOL_RESULT_MAX_CHARS) {
    text = `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n… [截断,共 ${text.length} 字符]`
  }
  return text
}

export function asRecordInput(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
