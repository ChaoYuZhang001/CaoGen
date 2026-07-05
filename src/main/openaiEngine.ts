import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { TranscriptWriter } from './transcript'
import { decryptToken, getProvider } from './providers'
import { AUTO_MODEL } from '../shared/types'
import type { Engine, EngineEmit, EngineFactory } from './engine'
import type {
  AgentEvent,
  AssistantBlock,
  ImageAttachmentView,
  PermissionModeId,
  PermissionRequestInfo,
  SendMessagePayload,
  SessionMeta,
  TranscriptEntry,
  UsageTotals
} from '../shared/types'

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com'
const DEFAULT_OPENAI_MODEL = 'gpt-4.1'

/**
 * OpenAIEngine —— 原生 OpenAI Responses API 适配器。
 *
 * 这是 CaoGen 的 OpenAI 一等入口:不再要求把 OpenAI 放到 Anthropic 兼容
 * 网关后面。当前覆盖文本/图片输入、流式输出、中断、转录、模型切换。
 * OpenAI 的工具调用与本地文件编辑权限模型暂未桥接,因此权限请求如实为空。
 */
export class OpenAIEngine implements Engine {
  readonly meta: SessionMeta
  private readonly transcript: TranscriptWriter
  private readonly emitRaw: (event: AgentEvent) => void
  private abort: AbortController | null = null
  private disposed = false
  private assistantText = ''
  private turnUsage: UsageTotals | undefined
  private turnStartedAt = 0

  constructor(meta: SessionMeta, emit: EngineEmit, resumeSdkSessionId?: string) {
    this.meta = meta
    this.transcript = new TranscriptWriter(resumeSdkSessionId)
    this.emitRaw = (event) => emit(event, this.transcript.next(event))
    if (resumeSdkSessionId) {
      this.meta.sdkSessionId = resumeSdkSessionId
      this.emit({ kind: 'init', sdkSessionId: resumeSdkSessionId, model: this.effectiveModel() })
    }
  }

  async start(): Promise<void> {
    if (this.disposed) return
    this.setStatus('starting')
    const auth = this.authConfig()
    if (!auth.token) {
      this.setStatus('error', 'OpenAI 引擎缺少 API Key:请选择 OpenAI Provider 或设置 OPENAI_API_KEY。')
      return
    }
    if (!this.meta.sdkSessionId) {
      this.meta.sdkSessionId = `openai-${randomUUID()}`
      this.emit({ kind: 'init', sdkSessionId: this.meta.sdkSessionId, model: this.effectiveModel() })
    }
    this.setStatus('idle')
  }

  send(input: string | SendMessagePayload): void {
    if (this.disposed) return
    if (this.abort) {
      this.setStatus('error', '上一轮仍在运行,请等待完成或中断后再发送。')
      return
    }
    const payload = normalizePayload(input)
    if (!payload) return

    const messageId = randomUUID()
    this.emit({
      kind: 'user-message',
      text: payload.text,
      messageId,
      attachments: payload.images?.map((image) => ({ id: image.id, mime: image.mime, bytes: image.bytes }))
    })
    if (this.meta.title === '新会话' && payload.text.trim()) {
      this.meta.title = payload.text.trim().replace(/\s+/g, ' ').slice(0, 40)
      this.emit({ kind: 'meta', meta: { ...this.meta } })
    }

    this.turnStartedAt = Date.now()
    this.assistantText = ''
    this.turnUsage = undefined
    this.abort = new AbortController()
    this.setStatus('running')
    void this.runResponse(payload, this.abort)
  }

  rejectSend(message: string): void {
    this.setStatus('error', message)
  }

  async interrupt(): Promise<void> {
    if (!this.abort) return
    this.abort.abort()
  }

  respondPermission(): void {
    // OpenAI 原生引擎当前不产生 CaoGen 权限请求。
  }

  pendingPermissions(): PermissionRequestInfo[] {
    return []
  }

  getTranscript(): TranscriptEntry[] {
    return this.transcript.read()
  }

  async setPermissionMode(mode: PermissionModeId): Promise<void> {
    this.meta.permissionMode = mode
    this.emit({ kind: 'meta', meta: { ...this.meta } })
  }

  async setModel(model: string): Promise<void> {
    this.meta.model = model
    this.emit({ kind: 'meta', meta: { ...this.meta } })
  }

  rename(title: string): void {
    const t = title.trim()
    if (!t) return
    this.meta.title = t.slice(0, 60)
    this.emit({ kind: 'meta', meta: { ...this.meta } })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.abort?.abort()
    this.abort = null
    this.setStatus('closed')
  }

  private async runResponse(payload: SendMessagePayload, controller: AbortController): Promise<void> {
    try {
      const auth = this.authConfig()
      if (!auth.token) throw new Error('OpenAI 引擎缺少 API Key:请选择 OpenAI Provider 或设置 OPENAI_API_KEY。')

      const body = {
        model: this.effectiveModel(),
        input: [
          {
            role: 'user',
            content: buildInputContent(payload)
          }
        ],
        stream: true
      }

      const res = await fetch(`${auth.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${auth.token}`,
          'content-type': 'application/json',
          ...auth.headers
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })

      if (!res.ok) throw new Error(await formatOpenAIError(res))
      await this.consumeResponse(res)
      this.finishTurn(false)
    } catch (err) {
      const aborted = controller.signal.aborted
      this.finishTurn(true, aborted ? '已中断' : errText(err), aborted ? 'interrupted' : 'error')
    }
  }

  private async consumeResponse(res: Response): Promise<void> {
    if (!res.body) {
      const json = await res.json().catch(() => null)
      const text = extractResponseText(json)
      if (text) this.appendText(text)
      this.applyUsage(json)
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) this.handleSseEvent(part)
    }
    if (buffer.trim()) this.handleSseEvent(buffer)
  }

  private handleSseEvent(raw: string): void {
    const dataLines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
    for (const data of dataLines) {
      if (!data || data === '[DONE]') continue
      let event: unknown
      try {
        event = JSON.parse(data)
      } catch {
        continue
      }
      const record = event as Record<string, unknown>
      const type = typeof record.type === 'string' ? record.type : ''
      if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
        const delta = typeof record.delta === 'string' ? record.delta : ''
        if (delta) this.appendText(delta)
        continue
      }
      if (type === 'response.completed') {
        this.applyUsage(record.response)
        const text = extractResponseText(record.response)
        if (text && !this.assistantText.includes(text)) this.appendText(text)
      }
      if (type === 'response.failed') {
        const error = (record.response as Record<string, unknown> | undefined)?.error ?? record.error
        throw new Error(extractErrorMessage(error) || 'OpenAI response failed')
      }
    }
  }

  private appendText(text: string): void {
    this.assistantText += text
    this.emit({ kind: 'text-delta', text })
  }

  private finishTurn(isError: boolean, resultText?: string, subtype = 'success'): void {
    const active = this.abort
    this.abort = null
    if (active?.signal.aborted && !isError) return

    const text = this.assistantText.trim()
    if (text) {
      const blocks: AssistantBlock[] = [{ type: 'text', text }]
      this.emit({ kind: 'assistant-message', blocks })
    }
    const durationMs = this.turnStartedAt ? Date.now() - this.turnStartedAt : undefined
    this.emit({
      kind: 'turn-result',
      subtype: isError ? subtype : 'success',
      isError,
      durationMs,
      resultText: isError ? resultText : text || undefined,
      usage: this.turnUsage
    })
    if (isError && resultText) this.setStatus('error', resultText)
    else this.setStatus('idle')
  }

  private applyUsage(value: unknown): void {
    const usage = normalizeOpenAIUsage((value as Record<string, unknown> | null)?.usage)
    if (!usage) return
    this.turnUsage = usage
    this.meta.usage = usage
    this.meta.contextTokens = usage.input + usage.cacheRead + usage.cacheCreation
    this.emit({ kind: 'meta', meta: { ...this.meta } })
  }

  private authConfig(): { baseUrl: string; token: string; headers: Record<string, string> } {
    const provider = this.meta.providerId ? getProvider(this.meta.providerId) : undefined
    const baseUrl = (provider?.baseUrl || process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '')
    const token = provider ? decryptToken(provider.encryptedToken) : process.env.OPENAI_API_KEY || ''
    return { baseUrl, token, headers: parseHeaders(provider?.customHeaders) }
  }

  private effectiveModel(): string {
    if (this.meta.model && this.meta.model !== AUTO_MODEL) return this.meta.model
    const provider = this.meta.providerId ? getProvider(this.meta.providerId) : undefined
    return provider?.models?.[0] || process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL
  }

  private emit(event: AgentEvent): void {
    this.emitRaw(event)
  }

  private setStatus(status: SessionMeta['status'], error?: string): void {
    this.meta.status = status
    if (error) this.meta.lastError = error
    this.emit({ kind: 'status', status, error })
  }
}

function normalizePayload(input: string | SendMessagePayload): SendMessagePayload | null {
  const payload = typeof input === 'string' ? { text: input.trim() } : { text: input.text.trim(), images: input.images }
  if (!payload.text && (!payload.images || payload.images.length === 0)) return null
  return payload
}

function buildInputContent(payload: SendMessagePayload): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = []
  if (payload.text) out.push({ type: 'input_text', text: payload.text })
  for (const image of payload.images ?? []) {
    const dataUrl = imageToDataUrl(image)
    if (dataUrl) out.push({ type: 'input_image', image_url: dataUrl })
  }
  return out.length > 0 ? out : [{ type: 'input_text', text: '' }]
}

function imageToDataUrl(image: ImageAttachmentView): string | null {
  try {
    const data = readFileSync(image.path).toString('base64')
    return `data:${image.mime};base64,${data}`
  } catch {
    return null
  }
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of (raw ?? '').split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const name = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (name && value) headers[name] = value
  }
  return headers
}

function normalizeOpenAIUsage(value: unknown): UsageTotals | null {
  if (!value || typeof value !== 'object') return null
  const usage = value as Record<string, unknown>
  const input = numberField(usage.input_tokens)
  const output = numberField(usage.output_tokens)
  const details = usage.input_tokens_details as Record<string, unknown> | undefined
  const cacheRead = numberField(details?.cached_tokens)
  if (input + output + cacheRead === 0) return null
  return { input, output, cacheRead, cacheCreation: 0 }
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function extractResponseText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  if (typeof record.output_text === 'string') return record.output_text
  const output = Array.isArray(record.output) ? record.output : []
  return output
    .map((item) => {
      const content = (item as Record<string, unknown>)?.content
      if (!Array.isArray(content)) return ''
      return content
        .map((part) => {
          const block = part as Record<string, unknown>
          return typeof block.text === 'string' ? block.text : ''
        })
        .join('')
    })
    .join('')
}

async function formatOpenAIError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  try {
    const json = JSON.parse(text) as Record<string, unknown>
    return `OpenAI 返回 ${res.status}: ${extractErrorMessage(json.error) || text || res.statusText}`
  } catch {
    return `OpenAI 返回 ${res.status}: ${text || res.statusText}`
  }
}

function extractErrorMessage(error: unknown): string {
  if (!error) return ''
  if (typeof error === 'string') return error
  if (typeof error !== 'object') return String(error)
  const record = error as Record<string, unknown>
  return typeof record.message === 'string' ? record.message : JSON.stringify(record)
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export const openAIEngineFactory: EngineFactory = {
  kind: 'openai',
  label: 'OpenAI Responses API',
  available: () => true,
  create: (meta: SessionMeta, emit: EngineEmit, resumeSdkSessionId?: string): Engine =>
    new OpenAIEngine(meta, emit, resumeSdkSessionId)
}
