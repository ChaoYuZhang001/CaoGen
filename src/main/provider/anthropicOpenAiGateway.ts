import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { ServerResponse } from 'node:http'
import type { ModelAttemptUsage } from '../../shared/model-attempt-types'

const MAX_TRANSLATED_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_STREAM_BYTES = 16 * 1024 * 1024

export class AnthropicOpenAiGatewayError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

export interface AnthropicOpenAiRequest {
  upstreamBody: Record<string, unknown>
  requestedModel: string
  stream: boolean
}

export function translateAnthropicMessagesRequest(body: Record<string, unknown>): AnthropicOpenAiRequest {
  try {
    return translateAnthropicMessagesRequestUnsafe(body)
  } catch (error) {
    if (error instanceof AnthropicOpenAiGatewayError && error.status === 502) {
      throw new AnthropicOpenAiGatewayError(400, 'invalid_request', error.message)
    }
    throw error
  }
}

function translateAnthropicMessagesRequestUnsafe(body: Record<string, unknown>): AnthropicOpenAiRequest {
  rejectUnsupportedRequestFeatures(body)
  const requestedModel = requiredText(body.model, 'model', 512)
  const maxTokens = positiveInteger(body.max_tokens, 'max_tokens')
  const stream = optionalBoolean(body.stream, 'stream') ?? false
  const messages = translateMessages(requiredArray(body.messages, 'messages'))
  const system = translateSystem(body.system)
  if (system) messages.unshift({ role: 'system', content: system })
  const upstreamBody: Record<string, unknown> = {
    model: requestedModel,
    messages,
    max_tokens: maxTokens,
    stream
  }
  copyFiniteNumber(body, upstreamBody, 'temperature', 0, 1)
  copyFiniteNumber(body, upstreamBody, 'top_p', 0, 1)
  if (body.stop_sequences !== undefined) {
    const stops = requiredArray(body.stop_sequences, 'stop_sequences')
      .map((value, index) => requiredText(value, `stop_sequences[${index}]`, 1024))
    if (stops.length > 4) invalid('stop_sequences supports at most 4 values')
    if (stops.length > 0) upstreamBody.stop = stops
  }
  if (body.tools !== undefined) upstreamBody.tools = translateTools(requiredArray(body.tools, 'tools'))
  if (body.tool_choice !== undefined) upstreamBody.tool_choice = translateToolChoice(body.tool_choice)
  const metadata = optionalRecord(body.metadata, 'metadata')
  if (metadata?.user_id !== undefined) upstreamBody.user = requiredText(metadata.user_id, 'metadata.user_id', 256)
  if (stream) upstreamBody.stream_options = { include_usage: true }
  return { upstreamBody, requestedModel, stream }
}

export function translateOpenAiChatResponse(value: unknown, requestedModel: string): {
  body: Record<string, unknown>
  usage?: ModelAttemptUsage
} {
  const response = requiredRecord(value, 'OpenAI response')
  const choice = requiredRecord(requiredArray(response.choices, 'OpenAI choices')[0], 'OpenAI choice')
  const message = requiredRecord(choice.message, 'OpenAI assistant message')
  const content: Record<string, unknown>[] = []
  const text = openAiMessageText(message.content)
  if (text) content.push({ type: 'text', text })
  if (message.tool_calls !== undefined) {
    for (const [index, rawCall] of requiredArray(message.tool_calls, 'OpenAI tool_calls').entries()) {
      const call = requiredRecord(rawCall, `OpenAI tool_calls[${index}]`)
      const fn = requiredRecord(call.function, `OpenAI tool_calls[${index}].function`)
      content.push({
        type: 'tool_use',
        id: requiredText(call.id, `OpenAI tool_calls[${index}].id`, 512),
        name: requiredText(fn.name, `OpenAI tool_calls[${index}].function.name`, 256),
        input: parseToolArguments(fn.arguments, `OpenAI tool_calls[${index}].function.arguments`)
      })
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' })
  const usage = normalizeOpenAiUsage(response.usage)
  return {
    body: {
      id: optionalText(response.id, 512) ?? `msg_${randomUUID().replace(/-/g, '')}`,
      type: 'message',
      role: 'assistant',
      content,
      model: requestedModel,
      stop_reason: anthropicStopReason(choice.finish_reason, content.some((block) => block.type === 'tool_use')),
      stop_sequence: null,
      usage: anthropicUsage(usage)
    },
    usage
  }
}

export async function forwardAnthropicMessagesResponse(
  upstream: Response,
  response: ServerResponse,
  signal: AbortSignal,
  requestedModel: string,
  stream: boolean
): Promise<ModelAttemptUsage | undefined> {
  if (!upstream.ok) {
    await forwardAnthropicError(upstream, response, signal)
    return undefined
  }
  if (!stream) {
    const value = await readBoundedJson(upstream, signal)
    const translated = translateOpenAiChatResponse(value, requestedModel)
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.end(JSON.stringify(translated.body))
    return translated.usage
  }
  response.setHeader('content-type', 'text/event-stream; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  const translator = new OpenAiToAnthropicStream(requestedModel)
  await consumeOpenAiSse(upstream, signal, async (value) => {
    const output = translator.push(value)
    if (output) await writeWithBackpressure(response, output)
  })
  const tail = translator.finish()
  if (tail) await writeWithBackpressure(response, tail)
  response.end()
  return translator.normalizedUsage()
}

class OpenAiToAnthropicStream {
  private started = false
  private finished = false
  private textIndex: number | undefined
  private textOpen = false
  private nextIndex = 0
  private finishReason: unknown
  private usage: ModelAttemptUsage | undefined
  private messageId = `msg_${randomUUID().replace(/-/g, '')}`
  private readonly tools = new Map<number, StreamingToolCall>()

  constructor(private readonly requestedModel: string) {}

  push(value: unknown): string {
    if (this.finished) return ''
    const chunk = requiredRecord(value, 'OpenAI stream chunk')
    if (!this.started) {
      this.messageId = optionalText(chunk.id, 512) ?? this.messageId
    }
    const output: string[] = []
    if (chunk.usage !== undefined) this.usage = normalizeOpenAiUsage(chunk.usage) ?? this.usage
    for (const [choiceIndex, rawChoice] of optionalArray(chunk.choices, 'OpenAI stream choices').entries()) {
      const choice = requiredRecord(rawChoice, `OpenAI stream choices[${choiceIndex}]`)
      const delta = optionalRecord(choice.delta, `OpenAI stream choices[${choiceIndex}].delta`) ?? {}
      const text = openAiMessageText(delta.content)
      if (text) {
        if (this.tools.size > 0) protocol('OpenAI stream interleaved text after tool calls')
        output.push(...this.ensureStart())
        if (!this.textOpen) {
          this.textIndex = this.nextIndex++
          this.textOpen = true
          output.push(sse('content_block_start', {
            type: 'content_block_start', index: this.textIndex, content_block: { type: 'text', text: '' }
          }))
        }
        output.push(sse('content_block_delta', {
          type: 'content_block_delta', index: this.textIndex, delta: { type: 'text_delta', text }
        }))
      }
      if (delta.tool_calls !== undefined) this.collectToolCalls(requiredArray(delta.tool_calls, 'OpenAI stream tool_calls'))
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) this.finishReason = choice.finish_reason
    }
    return output.join('')
  }

  finish(): string {
    if (this.finished) return ''
    this.finished = true
    const output = this.ensureStart()
    if (this.textOpen) {
      output.push(sse('content_block_stop', { type: 'content_block_stop', index: this.textIndex }))
      this.textOpen = false
    }
    for (const tool of [...this.tools.values()].sort((left, right) => left.openAiIndex - right.openAiIndex)) {
      const id = requiredText(tool.id, `OpenAI stream tool_calls[${tool.openAiIndex}].id`, 512)
      const name = requiredText(tool.name, `OpenAI stream tool_calls[${tool.openAiIndex}].function.name`, 256)
      parseToolArguments(tool.arguments, `OpenAI stream tool_calls[${tool.openAiIndex}].function.arguments`)
      const index = this.nextIndex++
      output.push(sse('content_block_start', {
        type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} }
      }))
      output.push(sse('content_block_delta', {
        type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: tool.arguments || '{}' }
      }))
      output.push(sse('content_block_stop', { type: 'content_block_stop', index }))
    }
    output.push(sse('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: anthropicStopReason(this.finishReason, this.tools.size > 0),
        stop_sequence: null
      },
      usage: anthropicUsage(this.usage)
    }))
    output.push(sse('message_stop', { type: 'message_stop' }))
    return output.join('')
  }

  normalizedUsage(): ModelAttemptUsage | undefined {
    return this.usage
  }

  private ensureStart(): string[] {
    if (this.started) return []
    this.started = true
    return [sse('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: this.requestedModel,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    })]
  }

  private collectToolCalls(calls: unknown[]): void {
    for (const [position, rawCall] of calls.entries()) {
      const call = requiredRecord(rawCall, `OpenAI stream tool_calls[${position}]`)
      const openAiIndex = nonNegativeInteger(call.index, `OpenAI stream tool_calls[${position}].index`)
      const current = this.tools.get(openAiIndex) ?? { openAiIndex, id: '', name: '', arguments: '' }
      if (call.id !== undefined) current.id += requiredText(call.id, `OpenAI stream tool_calls[${position}].id`, 512)
      const fn = optionalRecord(call.function, `OpenAI stream tool_calls[${position}].function`)
      if (fn?.name !== undefined) current.name += requiredText(fn.name, `OpenAI stream tool_calls[${position}].function.name`, 256)
      if (fn?.arguments !== undefined) current.arguments += requiredText(fn.arguments, `OpenAI stream tool_calls[${position}].function.arguments`, MAX_TRANSLATED_RESPONSE_BYTES)
      if (Buffer.byteLength(current.arguments) > MAX_TRANSLATED_RESPONSE_BYTES) protocol('OpenAI streamed tool arguments exceed 4 MiB')
      this.tools.set(openAiIndex, current)
    }
  }
}

interface StreamingToolCall {
  openAiIndex: number
  id: string
  name: string
  arguments: string
}

function translateMessages(values: unknown[]): Record<string, unknown>[] {
  if (values.length === 0) invalid('messages must not be empty')
  const result: Record<string, unknown>[] = []
  for (const [index, rawMessage] of values.entries()) {
    const message = requiredRecord(rawMessage, `messages[${index}]`)
    const role = requiredText(message.role, `messages[${index}].role`, 32)
    if (role !== 'user' && role !== 'assistant') invalid(`messages[${index}].role must be user or assistant`)
    const blocks = normalizeContent(message.content, `messages[${index}].content`)
    if (role === 'assistant') result.push(translateAssistantMessage(blocks, index))
    else result.push(...translateUserMessage(blocks, index))
  }
  return result
}

function translateAssistantMessage(blocks: Record<string, unknown>[], messageIndex: number): Record<string, unknown> {
  const text: string[] = []
  const toolCalls: Record<string, unknown>[] = []
  for (const [index, block] of blocks.entries()) {
    const type = requiredText(block.type, `messages[${messageIndex}].content[${index}].type`, 64)
    if (type === 'text') text.push(requiredText(block.text, `messages[${messageIndex}].content[${index}].text`, MAX_TRANSLATED_RESPONSE_BYTES, true))
    else if (type === 'tool_use') {
      toolCalls.push({
        id: requiredText(block.id, `messages[${messageIndex}].content[${index}].id`, 512),
        type: 'function',
        function: {
          name: requiredText(block.name, `messages[${messageIndex}].content[${index}].name`, 256),
          arguments: JSON.stringify(requiredRecord(block.input, `messages[${messageIndex}].content[${index}].input`))
        }
      })
    } else invalid(`assistant content type ${type} cannot be translated to OpenAI Chat Completions`)
  }
  return { role: 'assistant', content: text.join(''), ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) }
}

function translateUserMessage(blocks: Record<string, unknown>[], messageIndex: number): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []
  const content: Record<string, unknown>[] = []
  for (const [index, block] of blocks.entries()) {
    const label = `messages[${messageIndex}].content[${index}]`
    const type = requiredText(block.type, `${label}.type`, 64)
    if (type === 'text') content.push({ type: 'text', text: requiredText(block.text, `${label}.text`, MAX_TRANSLATED_RESPONSE_BYTES, true) })
    else if (type === 'image') content.push(translateImage(block, label))
    else if (type === 'tool_result') {
      result.push({
        role: 'tool',
        tool_call_id: requiredText(block.tool_use_id, `${label}.tool_use_id`, 512),
        content: toolResultText(block.content, `${label}.content`)
      })
    } else invalid(`user content type ${type} cannot be translated to OpenAI Chat Completions`)
  }
  if (content.length > 0) result.push({ role: 'user', content })
  if (result.length === 0) result.push({ role: 'user', content: '' })
  return result
}

function translateImage(block: Record<string, unknown>, label: string): Record<string, unknown> {
  const source = requiredRecord(block.source, `${label}.source`)
  const type = requiredText(source.type, `${label}.source.type`, 32)
  let url: string
  if (type === 'base64') {
    const mediaType = requiredText(source.media_type, `${label}.source.media_type`, 128)
    if (!/^image\/(?:png|jpeg|gif|webp)$/i.test(mediaType)) invalid(`${label}.source.media_type is unsupported`)
    const data = requiredText(source.data, `${label}.source.data`, MAX_TRANSLATED_RESPONSE_BYTES)
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) invalid(`${label}.source.data must be base64`)
    url = `data:${mediaType};base64,${data}`
  } else if (type === 'url') {
    url = requiredText(source.url, `${label}.source.url`, 8192)
    let parsed: URL
    try { parsed = new URL(url) } catch { return invalid(`${label}.source.url is invalid`) }
    if (parsed.protocol !== 'https:') invalid(`${label}.source.url must use HTTPS`)
  } else return invalid(`${label}.source.type is unsupported`)
  return { type: 'image_url', image_url: { url } }
}

function translateTools(values: unknown[]): Record<string, unknown>[] {
  return values.map((rawTool, index) => {
    const tool = requiredRecord(rawTool, `tools[${index}]`)
    return {
      type: 'function',
      function: {
        name: requiredText(tool.name, `tools[${index}].name`, 256),
        ...(tool.description === undefined ? {} : { description: requiredText(tool.description, `tools[${index}].description`, 8192, true) }),
        parameters: requiredRecord(tool.input_schema, `tools[${index}].input_schema`)
      }
    }
  })
}

function translateToolChoice(value: unknown): unknown {
  const choice = requiredRecord(value, 'tool_choice')
  const type = requiredText(choice.type, 'tool_choice.type', 32)
  if (type === 'auto') return 'auto'
  if (type === 'any') return 'required'
  if (type === 'none') return 'none'
  if (type === 'tool') return {
    type: 'function',
    function: { name: requiredText(choice.name, 'tool_choice.name', 256) }
  }
  return invalid('tool_choice.type is unsupported')
}

function translateSystem(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  const blocks = requiredArray(value, 'system')
  return blocks.map((raw, index) => {
    const block = requiredRecord(raw, `system[${index}]`)
    if (requiredText(block.type, `system[${index}].type`, 64) !== 'text') invalid(`system[${index}] must be a text block`)
    return requiredText(block.text, `system[${index}].text`, MAX_TRANSLATED_RESPONSE_BYTES, true)
  }).join('\n')
}

function normalizeContent(value: unknown, label: string): Record<string, unknown>[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  return requiredArray(value, label).map((block, index) => requiredRecord(block, `${label}[${index}]`))
}

function toolResultText(value: unknown, label: string): string {
  if (typeof value === 'string') return value
  return requiredArray(value, label).map((raw, index) => {
    const block = requiredRecord(raw, `${label}[${index}]`)
    if (requiredText(block.type, `${label}[${index}].type`, 64) !== 'text') invalid(`${label}[${index}] must be text`)
    return requiredText(block.text, `${label}[${index}].text`, MAX_TRANSLATED_RESPONSE_BYTES, true)
  }).join('\n')
}

async function consumeOpenAiSse(
  upstream: Response,
  signal: AbortSignal,
  onData: (value: unknown) => Promise<void>
): Promise<void> {
  if (!upstream.body) protocol('OpenAI streaming response has no body')
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let bytes = 0
  try {
    while (true) {
      if (signal.aborted) throw signal.reason
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_STREAM_BYTES) protocol('OpenAI streaming response exceeds 16 MiB')
      buffer += decoder.decode(value, { stream: true })
      if (Buffer.byteLength(buffer) > MAX_TRANSLATED_RESPONSE_BYTES) protocol('OpenAI SSE event exceeds 4 MiB')
      const parts = buffer.split(/\r?\n\r?\n/)
      buffer = parts.pop() ?? ''
      for (const part of parts) await consumeSseEvent(part, onData)
    }
    buffer += decoder.decode()
    if (buffer.trim()) await consumeSseEvent(buffer, onData)
  } finally {
    if (signal.aborted) await reader.cancel(signal.reason).catch(() => undefined)
  }
}

async function consumeSseEvent(event: string, onData: (value: unknown) => Promise<void>): Promise<void> {
  const raw = event.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (!raw || raw === '[DONE]') return
  let value: unknown
  try { value = JSON.parse(raw) as unknown } catch { return protocol('OpenAI stream contains invalid JSON') }
  await onData(value)
}

async function readBoundedJson(upstream: Response, signal: AbortSignal): Promise<unknown> {
  if (!upstream.body) protocol('OpenAI response has no body')
  const reader = upstream.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      if (signal.aborted) throw signal.reason
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_TRANSLATED_RESPONSE_BYTES) protocol('OpenAI response exceeds 4 MiB')
      chunks.push(value)
    }
  } finally {
    if (signal.aborted) await reader.cancel(signal.reason).catch(() => undefined)
  }
  try { return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')) as unknown } catch {
    return protocol('OpenAI response contains invalid JSON')
  }
}

async function forwardAnthropicError(upstream: Response, response: ServerResponse, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason
  const type = upstream.status === 401 ? 'authentication_error'
    : upstream.status === 403 ? 'permission_error'
      : upstream.status === 429 ? 'rate_limit_error'
        : upstream.status >= 500 ? 'api_error' : 'invalid_request_error'
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify({ type: 'error', error: { type, message: `Upstream Provider returned HTTP ${upstream.status}` } }))
  await upstream.body?.cancel().catch(() => undefined)
}

function normalizeOpenAiUsage(value: unknown): ModelAttemptUsage | undefined {
  if (value === undefined) return undefined
  const usage = requiredRecord(value, 'OpenAI usage')
  const inputDetails = optionalRecord(usage.prompt_tokens_details ?? usage.input_tokens_details, 'OpenAI usage token details')
  const inputTokens = tokenCount(usage.prompt_tokens ?? usage.input_tokens)
  const outputTokens = tokenCount(usage.completion_tokens ?? usage.output_tokens)
  const cacheReadTokens = tokenCount(inputDetails?.cached_tokens)
  if (inputTokens + outputTokens + cacheReadTokens === 0) return undefined
  return { inputTokens, outputTokens, ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}) }
}

function anthropicUsage(usage: ModelAttemptUsage | undefined): Record<string, number> {
  return {
    input_tokens: usage?.inputTokens ?? 0,
    output_tokens: usage?.outputTokens ?? 0,
    ...(usage?.cacheReadTokens ? { cache_read_input_tokens: usage.cacheReadTokens } : {})
  }
}

function anthropicStopReason(value: unknown, hasTools: boolean): string {
  if (hasTools || value === 'tool_calls' || value === 'function_call') return 'tool_use'
  if (value === 'length') return 'max_tokens'
  if (value === 'content_filter') return 'refusal'
  return 'end_turn'
}

function openAiMessageText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  return requiredArray(value, 'OpenAI message content').map((raw, index) => {
    const block = requiredRecord(raw, `OpenAI message content[${index}]`)
    const type = optionalText(block.type, 64)
    if (type !== 'text' && type !== 'output_text') protocol(`OpenAI response content type ${type ?? 'missing'} is unsupported`)
    return requiredText(block.text, `OpenAI message content[${index}].text`, MAX_TRANSLATED_RESPONSE_BYTES, true)
  }).join('')
}

function parseToolArguments(value: unknown, label: string): Record<string, unknown> {
  const raw = value === undefined || value === '' ? '{}' : requiredText(value, label, MAX_TRANSLATED_RESPONSE_BYTES)
  let parsed: unknown
  try { parsed = JSON.parse(raw) as unknown } catch { return protocol(`${label} is not valid JSON`) }
  return requiredRecord(parsed, label)
}

function rejectUnsupportedRequestFeatures(body: Record<string, unknown>): void {
  const unsupported = ['thinking', 'top_k', 'mcp_servers', 'container', 'context_management']
    .filter((key) => body[key] !== undefined)
  if (unsupported.length > 0) invalid(`Unsupported Anthropic request fields: ${unsupported.join(', ')}`)
}

async function writeWithBackpressure(response: ServerResponse, value: string): Promise<void> {
  if (!response.write(value)) await once(response, 'drain')
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return protocol(`${label} must be an object`)
  return value as Record<string, unknown>
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined
  return requiredRecord(value, label)
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) return invalid(`${label} must be an array`)
  return value
}

function optionalArray(value: unknown, label: string): unknown[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return protocol(`${label} must be an array`)
  return value
}

function requiredText(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || Buffer.byteLength(value) > max) {
    return invalid(`${label} must be ${allowEmpty ? '' : 'non-empty '}text no longer than ${max} bytes`)
  }
  return value
}

function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || Buffer.byteLength(value) > max) return protocol('OpenAI response text field is invalid')
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) return invalid(`${label} must be a positive integer`)
  return Number(value)
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return protocol(`${label} must be a non-negative integer`)
  return Number(value)
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') return invalid(`${label} must be boolean`)
  return value
}

function copyFiniteNumber(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number
): void {
  if (source[key] === undefined) return
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalid(`${key} must be between ${minimum} and ${maximum}`)
  }
  target[key] = value
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function invalid(message: string): never {
  throw new AnthropicOpenAiGatewayError(400, 'invalid_request', message)
}

function protocol(message: string): never {
  throw new AnthropicOpenAiGatewayError(502, 'protocol_error', message)
}
