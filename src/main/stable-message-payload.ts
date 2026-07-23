import type { ImageAttachmentView, SendMessagePayload } from '../shared/types'

export interface StableMessagePayload {
  text: string
  images: ImageAttachmentView[]
  messageId?: string
}

export function normalizeStableMessagePayload(input: string | SendMessagePayload): StableMessagePayload {
  if (typeof input === 'string') return { text: input.trim(), images: [] }
  const messageId = typeof input.messageId === 'string' ? input.messageId.trim() : ''
  return {
    text: typeof input.text === 'string' ? input.text.trim() : '',
    images: Array.isArray(input.images) ? input.images.filter(isImageAttachmentView) : [],
    ...(messageId ? { messageId } : {})
  }
}

function isImageAttachmentView(value: unknown): value is ImageAttachmentView {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.hash === 'string' &&
    typeof record.path === 'string' &&
    typeof record.mime === 'string' &&
    typeof record.bytes === 'number' &&
    Number.isFinite(record.bytes) &&
    typeof record.createdAt === 'string'
  )
}
