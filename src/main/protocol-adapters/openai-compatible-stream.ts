import type { UsageTotals } from '../../shared/types'
import { OPENAI_COMPATIBLE_PROTOCOL_ADAPTER } from './openai-compatible'

export interface OpenAIChatToolCall {
  id: string
  name: string
  argsText: string
}

export interface OpenAIResponsesToolCall {
  callId: string
  name: string
  argsText: string
}

interface OpenAIStreamCallbacks {
  appendText(text: string): void
  recordUsage(usage: UsageTotals): void
}

interface OpenAIResponsesStreamCallbacks extends OpenAIStreamCallbacks {
  hasAssistantText(text: string): boolean
  rememberResponse(responseId: string): void
}

export async function consumeOpenAIChatResponse(
  response: Response,
  toolCalls: OpenAIChatToolCall[],
  callbacks: OpenAIStreamCallbacks
): Promise<void> {
  if (!response.body) {
    const json = await response.json().catch(() => null)
    const record = asRecord(json)
    const choices = Array.isArray(record?.choices) ? record.choices : []
    const message = asRecord(asRecord(choices[0])?.message)
    if (typeof message?.content === 'string' && message.content) callbacks.appendText(message.content)
    recordUsage(record?.usage, callbacks)
    return
  }
  await consumeSseBody(response.body, (record) => applyChatEvent(record, toolCalls, callbacks))
}

export async function consumeOpenAIResponsesResponse(
  response: Response,
  toolCalls: OpenAIResponsesToolCall[],
  callbacks: OpenAIResponsesStreamCallbacks
): Promise<void> {
  if (!response.body) {
    const json = await response.json().catch(() => null)
    applyCompletedResponse(json, callbacks)
    return
  }
  await consumeSseBody(response.body, (record) => applyResponsesEvent(record, toolCalls, callbacks))
}

function applyChatEvent(
  record: Record<string, unknown>,
  toolCalls: OpenAIChatToolCall[],
  callbacks: OpenAIStreamCallbacks
): void {
  if (record.error) throw new Error(openAIErrorMessage(record.error) || 'Chat Completions 流式响应报错')
  const choices = Array.isArray(record.choices) ? record.choices : []
  const delta = asRecord(asRecord(choices[0])?.delta)
  if (typeof delta?.content === 'string' && delta.content) callbacks.appendText(delta.content)
  if (Array.isArray(delta?.tool_calls)) {
    for (const raw of delta.tool_calls) appendChatToolFragment(asRecord(raw), toolCalls)
  }
  recordUsage(record.usage, callbacks)
}

function appendChatToolFragment(
  raw: Record<string, unknown> | null,
  toolCalls: OpenAIChatToolCall[]
): void {
  if (!raw) return
  const index = typeof raw.index === 'number' ? raw.index : 0
  const slot = ensureSlot(toolCalls, index, () => ({ id: '', name: '', argsText: '' }))
  if (typeof raw.id === 'string' && raw.id) slot.id = raw.id
  const fn = asRecord(raw.function)
  if (typeof fn?.name === 'string' && fn.name) slot.name += fn.name
  if (typeof fn?.arguments === 'string') slot.argsText += fn.arguments
}

function applyResponsesEvent(
  record: Record<string, unknown>,
  toolCalls: OpenAIResponsesToolCall[],
  callbacks: OpenAIResponsesStreamCallbacks
): void {
  const type = typeof record.type === 'string' ? record.type : ''
  if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
    if (typeof record.delta === 'string' && record.delta) callbacks.appendText(record.delta)
    return
  }
  if (type === 'response.function_call_arguments.delta') {
    const slot = responseToolSlot(record, toolCalls)
    if (typeof record.delta === 'string') slot.argsText += record.delta
    return
  }
  if (type === 'response.output_item.added' || type === 'response.output_item.done') {
    applyResponseToolItem(record, toolCalls, type === 'response.output_item.done')
    return
  }
  if (type === 'response.completed') {
    applyCompletedResponse(record.response, callbacks)
    return
  }
  if (type === 'response.failed') {
    const error = asRecord(record.response)?.error ?? record.error
    throw new Error(openAIErrorMessage(error) || 'OpenAI response failed')
  }
}

function applyResponseToolItem(
  record: Record<string, unknown>,
  toolCalls: OpenAIResponsesToolCall[],
  replaceArguments: boolean
): void {
  const item = asRecord(record.item)
  if (item?.type !== 'function_call') return
  const slot = responseToolSlot(record, toolCalls)
  if (typeof item.call_id === 'string') slot.callId = item.call_id
  if (typeof item.name === 'string') slot.name = item.name
  if (typeof item.arguments !== 'string' || !item.arguments) return
  if (replaceArguments) slot.argsText = item.arguments
  else slot.argsText += item.arguments
}

function responseToolSlot(
  record: Record<string, unknown>,
  toolCalls: OpenAIResponsesToolCall[]
): OpenAIResponsesToolCall {
  const index = typeof record.output_index === 'number' ? record.output_index : 0
  return ensureSlot(toolCalls, index, () => ({ callId: '', name: '', argsText: '' }))
}

function applyCompletedResponse(value: unknown, callbacks: OpenAIResponsesStreamCallbacks): void {
  const record = asRecord(value)
  recordUsage(record?.usage, callbacks)
  if (typeof record?.id === 'string' && record.id) callbacks.rememberResponse(record.id)
  const text = extractOpenAIResponseText(record)
  if (text && !callbacks.hasAssistantText(text)) callbacks.appendText(text)
}

function recordUsage(value: unknown, callbacks: OpenAIStreamCallbacks): void {
  const usage = OPENAI_COMPATIBLE_PROTOCOL_ADAPTER.normalizeUsage(value)
  if (!usage || usage.input + usage.output + usage.cacheRead + usage.cacheCreation === 0) return
  callbacks.recordUsage(usage)
}

async function consumeSseBody(
  body: ReadableStream<Uint8Array>,
  consume: (record: Record<string, unknown>) => void
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split(/\r?\n\r?\n/)
    buffer = parts.pop() ?? ''
    for (const part of parts) consumeSseEvent(part, consume)
  }
  buffer += decoder.decode()
  if (buffer.trim()) consumeSseEvent(buffer, consume)
}

function consumeSseEvent(raw: string, consume: (record: Record<string, unknown>) => void): void {
  const dataLines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
  for (const data of dataLines) {
    if (!data || data === '[DONE]') continue
    let value: unknown
    try {
      value = JSON.parse(data)
    } catch {
      continue
    }
    const record = asRecord(value)
    if (record) consume(record)
  }
}

function ensureSlot<T>(values: T[], index: number, create: () => T): T {
  while (values.length <= index) values.push(create())
  return values[index]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function openAIErrorMessage(error: unknown): string {
  if (!error) return ''
  if (typeof error === 'string') return error
  if (typeof error !== 'object') return String(error)
  const record = error as Record<string, unknown>
  return typeof record.message === 'string' ? record.message : JSON.stringify(record)
}

function extractOpenAIResponseText(value: unknown): string {
  const record = asRecord(value)
  if (!record) return ''
  if (typeof record.output_text === 'string') return record.output_text
  const output = Array.isArray(record.output) ? record.output : []
  return output.map((item) => {
    const content = asRecord(item)?.content
    if (!Array.isArray(content)) return ''
    return content.map((part) => {
      const block = asRecord(part)
      return typeof block?.text === 'string' ? block.text : ''
    }).join('')
  }).join('')
}
