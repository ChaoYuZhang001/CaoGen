import { DEFAULT_MAX_IMAGE_BYTES } from './attachmentOps'
import type {
  AnthropicMessagesContentBlock,
  AnthropicMessagesMessage,
  AnthropicMessagesResult
} from './anthropicMessagesAdapter'
import type { StableMessagePayload } from './stable-message-payload'
import type { NativeToolExecutionResult } from './native-tool-runtime'
import type {
  AgentEvent,
  AssistantBlock,
  TranscriptEntry,
  UserMessageAttachmentView,
  UsageTotals
} from '../shared/types'

const MAX_IMAGES_PER_MESSAGE = 32
const MAX_IMAGE_BYTES_PER_MESSAGE = 20 * 1024 * 1024
const MAX_HISTORY_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_HISTORY_IMAGES = 32

type AnthropicToolResultEvent = Extract<AgentEvent, { kind: 'tool-result' }>
type AnthropicUserMessageEvent = Extract<AgentEvent, { kind: 'user-message' }>

interface AnthropicHistoryRebuildState {
  pendingTurn: AnthropicMessagesMessage[]
  activeTurn: boolean
  validTurn: boolean
  pendingToolUses: Set<string>
  pendingToolResults: AnthropicMessagesContentBlock[]
  recoveredImageBytes: number
  recoveredImageCount: number
}

export type AnthropicImageResolver = (
  reference: UserMessageAttachmentView
) => AnthropicMessagesContentBlock

export function durableImageReferences(
  images: ReadonlyArray<{ hash?: string; mime: string; bytes: number }>
): UserMessageAttachmentView[] {
  if (images.length > MAX_IMAGES_PER_MESSAGE) {
    throw new Error(`单条消息最多支持 ${MAX_IMAGES_PER_MESSAGE} 张图片`)
  }
  const references = images.map(durableImageReference)
  const totalBytes = references.reduce((sum, image) => sum + image.bytes, 0)
  if (totalBytes > MAX_IMAGE_BYTES_PER_MESSAGE) {
    throw new Error(`单条消息图片总大小超过上限 ${MAX_IMAGE_BYTES_PER_MESSAGE} bytes`)
  }
  return references
}

export function buildAnthropicUserContent(
  payload: StableMessagePayload,
  resolveImageAttachment: AnthropicImageResolver
): AnthropicMessagesContentBlock[] {
  const content: AnthropicMessagesContentBlock[] = []
  if (payload.text) content.push({ type: 'text', text: payload.text })
  for (const reference of durableImageReferences(payload.images)) {
    content.push(resolveImageAttachment(reference))
  }
  return content
}

export function rebuildAnthropicHistory(
  entries: TranscriptEntry[],
  resolveImageAttachment: AnthropicImageResolver
): AnthropicMessagesMessage[] {
  const history: AnthropicMessagesMessage[] = []
  const state = createHistoryRebuildState()
  try {
    for (const entry of entries) applyHistoryEvent(state, entry.event, history, resolveImageAttachment)
    return history
  } catch {
    return []
  }
}

function applyHistoryEvent(
  state: AnthropicHistoryRebuildState,
  event: AgentEvent,
  history: AnthropicMessagesMessage[],
  resolveImageAttachment: AnthropicImageResolver
): void {
  if (event.kind === 'user-message') {
    startHistoryTurn(state, event.text, event.attachments, resolveImageAttachment)
  } else if (event.kind === 'assistant-message') {
    appendAssistantHistory(state, event.blocks)
  } else if (event.kind === 'tool-result') {
    appendToolResultHistory(state, event)
  } else if (event.kind === 'turn-result') {
    commitHistoryTurn(state, event.isError, history)
  }
}

function createHistoryRebuildState(): AnthropicHistoryRebuildState {
  return {
    pendingTurn: [],
    activeTurn: false,
    validTurn: true,
    pendingToolUses: new Set(),
    pendingToolResults: [],
    recoveredImageBytes: 0,
    recoveredImageCount: 0
  }
}

function resetHistoryTurn(state: AnthropicHistoryRebuildState): void {
  state.pendingTurn = []
  state.activeTurn = false
  state.validTurn = true
  state.pendingToolUses = new Set()
  state.pendingToolResults = []
}

function startHistoryTurn(
  state: AnthropicHistoryRebuildState,
  text: string,
  attachments: AnthropicUserMessageEvent['attachments'],
  resolveImageAttachment: AnthropicImageResolver
): void {
  resetHistoryTurn(state)
  state.activeTurn = true
  const content: AnthropicMessagesContentBlock[] = []
  if (text) content.push({ type: 'text', text })
  try {
    const references = durableImageReferences(attachments ?? [])
    const nextBudget = historyImageBudget(state, references)
    const resolved = references.map(resolveImageAttachment)
    state.recoveredImageBytes = nextBudget.bytes
    state.recoveredImageCount = nextBudget.count
    content.push(...resolved)
  } catch {
    state.validTurn = false
    return
  }
  if (content.length === 0) {
    state.validTurn = false
    return
  }
  state.pendingTurn = content.length > 0 ? [{ role: 'user', content }] : []
}

function historyImageBudget(
  state: AnthropicHistoryRebuildState,
  references: UserMessageAttachmentView[]
): { bytes: number; count: number } {
  const bytes = references.reduce((sum, item) => sum + item.bytes, 0)
  const nextImageBytes = state.recoveredImageBytes + bytes
  const nextImageCount = state.recoveredImageCount + references.length
  if (nextImageBytes > MAX_HISTORY_IMAGE_BYTES || nextImageCount > MAX_HISTORY_IMAGES) {
    throw new Error('恢复图片历史超过会话预算')
  }
  return { bytes: nextImageBytes, count: nextImageCount }
}

function durableImageReference(image: {
  hash?: string
  mime: string
  bytes: number
}): UserMessageAttachmentView {
  const hash = image.hash?.trim() ?? ''
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('图片附件缺少有效 SHA-256 摘要')
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mime)) {
    throw new Error('图片附件 MIME 不受支持')
  }
  if (!Number.isSafeInteger(image.bytes) || image.bytes <= 0 || image.bytes > DEFAULT_MAX_IMAGE_BYTES) {
    throw new Error(`图片附件大小无效或超过上限 ${DEFAULT_MAX_IMAGE_BYTES} bytes`)
  }
  return { id: hash, hash, mime: image.mime, bytes: image.bytes }
}

function appendAssistantHistory(
  state: AnthropicHistoryRebuildState,
  blocks: AssistantBlock[]
): void {
  if (!state.activeTurn) return
  if (state.pendingToolUses.size > 0 || state.pendingToolResults.length > 0) state.validTurn = false
  const content: AnthropicMessagesContentBlock[] = []
  for (const block of blocks) {
    const converted = assistantBlockToHistory(state, block)
    if (converted) content.push(converted)
  }
  if (content.length > 0) state.pendingTurn.push({ role: 'assistant', content })
}

function assistantBlockToHistory(
  state: AnthropicHistoryRebuildState,
  block: AssistantBlock
): AnthropicMessagesContentBlock | undefined {
  if (block.type === 'thinking' && block.text && block.signature) {
    return { type: 'thinking', thinking: block.text, signature: block.signature }
  }
  if (block.type === 'redacted_thinking' && block.data) return { type: 'redacted_thinking', data: block.data }
  if (block.type === 'text' && block.text) return { type: 'text', text: block.text }
  if (block.type !== 'tool_use') return undefined
  if (!block.id || state.pendingToolUses.has(block.id) || !isRecord(block.input)) {
    state.validTurn = false
    return undefined
  }
  state.pendingToolUses.add(block.id)
  return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
}

function appendToolResultHistory(
  state: AnthropicHistoryRebuildState,
  event: AnthropicToolResultEvent
): void {
  if (!state.activeTurn) return
  if (!state.pendingToolUses.delete(event.toolUseId)) {
    state.validTurn = false
    return
  }
  state.pendingToolResults.push({
    type: 'tool_result',
    tool_use_id: event.toolUseId,
    content: event.content,
    is_error: event.isError
  })
  if (state.pendingToolUses.size === 0) {
    state.pendingTurn.push({ role: 'user', content: state.pendingToolResults })
    state.pendingToolResults = []
  }
}

function commitHistoryTurn(
  state: AnthropicHistoryRebuildState,
  isError: boolean,
  history: AnthropicMessagesMessage[]
): void {
  if (
    state.activeTurn &&
    !isError &&
    state.validTurn &&
    state.pendingToolUses.size === 0 &&
    state.pendingToolResults.length === 0 &&
    state.pendingTurn.length > 0
  ) {
    history.push(...state.pendingTurn)
  }
  resetHistoryTurn(state)
}

export function assistantHistoryContent(result: AnthropicMessagesResult): AnthropicMessagesContentBlock[] {
  const blocks = (Array.isArray(result.contentBlocks) ? result.contentBlocks : [])
    .map(assistantResultBlockToHistory)
    .filter((block): block is AnthropicMessagesContentBlock => Boolean(block))
  if (blocks.length > 0) return blocks
  if (result.text) blocks.push({ type: 'text', text: result.text })
  for (const toolUse of Array.isArray(result.toolUses) ? result.toolUses : []) {
    blocks.push({ ...toolUse, input: isRecord(toolUse.input) ? toolUse.input : {} })
  }
  return blocks
}

function assistantResultBlockToHistory(
  block: AnthropicMessagesContentBlock
): AnthropicMessagesContentBlock | undefined {
  if (block.type === 'thinking' && block.signature) return { ...block }
  if (block.type === 'redacted_thinking' || block.type === 'text') return { ...block }
  if (block.type === 'tool_use') return { ...block, input: isRecord(block.input) ? block.input : {} }
  return undefined
}

export function assistantEventBlocks(result: AnthropicMessagesResult): AssistantBlock[] {
  const blocks = (Array.isArray(result.contentBlocks) ? result.contentBlocks : [])
    .map(assistantResultBlockToEvent)
    .filter((block): block is AssistantBlock => Boolean(block))
  if (blocks.length > 0) return blocks
  if (result.thinking) blocks.push({ type: 'thinking', text: result.thinking })
  if (result.text) blocks.push({ type: 'text', text: result.text })
  for (const toolUse of Array.isArray(result.toolUses) ? result.toolUses : []) {
    blocks.push({ type: 'tool_use', id: toolUse.id, name: toolUse.name, input: toolUse.input })
  }
  return blocks
}

function assistantResultBlockToEvent(block: AnthropicMessagesContentBlock): AssistantBlock | undefined {
  if (block.type === 'thinking' && block.thinking) {
    return {
      type: 'thinking',
      text: block.thinking,
      ...(block.signature ? { signature: block.signature } : {})
    }
  }
  if (block.type === 'redacted_thinking' && block.data) return { type: 'redacted_thinking', data: block.data }
  if (block.type === 'text' && block.text) return { type: 'text', text: block.text }
  if (block.type === 'tool_use') return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
  return undefined
}

export function appendMissingSuffix(
  value: string,
  streamed: string,
  append: (text: string) => void
): void {
  if (!value || streamed === value) return
  if (!streamed) {
    append(value)
    return
  }
  if (value.startsWith(streamed)) append(value.slice(streamed.length))
}

export function anthropicToolResultBlock(
  toolUse: { id: string },
  execution: NativeToolExecutionResult
): AnthropicMessagesContentBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUse.id,
    content: execution.output,
    is_error: !execution.ok
  }
}

export function aggregateAnthropicUsage(
  current: UsageTotals | undefined,
  result: AnthropicMessagesResult
): UsageTotals {
  const next = {
    input: result.usage.input,
    output: result.usage.output,
    cacheRead: result.usage.cacheRead,
    cacheCreation: result.usage.cacheCreation
  }
  if (!current) return next
  return {
    input: current.input + next.input,
    output: current.output + next.output,
    cacheRead: current.cacheRead + next.cacheRead,
    cacheCreation: current.cacheCreation + next.cacheCreation
  }
}

export function anthropicErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const STOP_FAILURES: Record<string, { subtype: string; message: string }> = {
  max_tokens: { subtype: 'max-tokens', message: 'Anthropic 响应达到输出 token 上限,本轮未完成' },
  refusal: { subtype: 'refusal', message: 'Anthropic 模型拒绝完成本轮请求' },
  model_context_window_exceeded: {
    subtype: 'context-window',
    message: 'Anthropic 上下文窗口已超限,本轮未完成'
  },
  pause_turn: { subtype: 'pause-turn', message: 'Anthropic 暂停了本轮,当前引擎无法安全续接' },
  stop_sequence: { subtype: 'stop-sequence', message: 'Anthropic 命中 stop sequence,本轮未标记完成' },
  tool_use: { subtype: 'protocol-stop', message: 'Anthropic 返回 tool_use stop reason 但没有工具块' }
}

export function finalStopFailure(
  stopReason: string | undefined
): { subtype: string; message: string } | undefined {
  if (stopReason === 'end_turn') return undefined
  return STOP_FAILURES[stopReason ?? ''] ?? {
    subtype: 'protocol-stop',
    message: `Anthropic 返回无效 stop reason:${stopReason || 'missing'}`
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
