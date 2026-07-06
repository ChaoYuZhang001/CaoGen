import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { TranscriptWriter } from './transcript'
import { decryptToken, getProvider } from './providers'
import { getSettings } from './settings'
import {
  EDIT_TOOLS,
  OPENAI_CODING_TOOLS,
  READONLY_TOOLS,
  executeCodingTool
} from './openaiTools'
import { AUTO_MODEL } from '../shared/types'
import type { Engine, EngineEmit, EngineFactory } from './engine'
import type {
  AgentEvent,
  AssistantBlock,
  ImageAttachmentView,
  OpenAIProtocol,
  PermissionModeId,
  PermissionRequestInfo,
  SendMessagePayload,
  SessionMeta,
  TranscriptEntry,
  UsageTotals
} from '../shared/types'

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com'
const DEFAULT_OPENAI_MODEL = 'gpt-4.1'

/** Chat Completions 多轮历史消息(text 或 text+图片混合内容) */
type ChatContent = string | Array<Record<string, unknown>>
interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: ChatContent | null
  /** assistant 消息的工具调用(原样回传给模型维持上下文) */
  tool_calls?: Array<Record<string, unknown>>
  /** tool 消息必带:对应的调用 id */
  tool_call_id?: string
}

/** 流式累积中的一次工具调用 */
interface PendingToolCall {
  id: string
  name: string
  argsText: string
}

/** Agent 循环上限:防模型无限调工具烧穿 */
const MAX_TOOL_ITERATIONS = 40

/**
 * OpenAIEngine —— 原生 OpenAI 协议适配器,支持两种协议:
 * - 'responses':OpenAI 官方 Responses API(/v1/responses,默认)
 * - 'chat':通用 Chat Completions(/v1/chat/completions)——DeepSeek/Qwen/
 *   new-api 网关/自部署 vLLM·Ollama 等几乎所有 OpenAI 兼容端点都讲这个协议。
 * 协议按 Provider 的 openaiProtocol 字段选择。
 *
 * 多轮上下文:chat 协议在内存维护 user/assistant 历史并随每轮全量发送;
 * resume 时从转录重建。(responses 路径沿用单轮行为,历史桥接待补。)
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
  /** chat 协议的多轮历史(user/assistant/tool);responses 协议不使用 */
  private chatHistory: ChatMessage[] = []
  /** 挂起的权限审批(chat 协议工具调用) */
  private readonly pendingPerms = new Map<
    string,
    { resolve: (r: { allow: boolean; message?: string }) => void; info: PermissionRequestInfo }
  >()
  /** 本轮流式累积的工具调用(SSE delta 分片拼装) */
  private pendingToolCalls: PendingToolCall[] = []

  constructor(meta: SessionMeta, emit: EngineEmit, resumeSdkSessionId?: string) {
    this.meta = meta
    this.transcript = new TranscriptWriter(resumeSdkSessionId)
    this.emitRaw = (event) => emit(event, this.transcript.next(event))
    if (resumeSdkSessionId) {
      this.meta.sdkSessionId = resumeSdkSessionId
      this.rebuildChatHistory()
      this.emit({ kind: 'init', sdkSessionId: resumeSdkSessionId, model: this.effectiveModel() })
    }
  }

  /** resume 时从转录重建 chat 协议的多轮历史(仅文本;图片不回放) */
  private rebuildChatHistory(): void {
    try {
      for (const entry of this.transcript.read()) {
        const ev = entry.event
        if (ev.kind === 'user-message' && typeof ev.text === 'string' && ev.text) {
          this.chatHistory.push({ role: 'user', content: ev.text })
        } else if (ev.kind === 'assistant-message' && Array.isArray(ev.blocks)) {
          const text = ev.blocks
            .map((b) => (b.type === 'text' ? b.text : ''))
            .join('')
            .trim()
          if (text) this.chatHistory.push({ role: 'assistant', content: text })
        }
      }
    } catch {
      // 历史损坏时从空上下文开始,不阻塞会话
      this.chatHistory = []
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
    // 先拒掉挂起的审批,否则 Agent 循环会永远等在 gateTool 上
    this.rejectAllPendingPerms('已中断')
    if (!this.abort) return
    this.abort.abort()
  }

  /** 中断/销毁时统一拒绝所有挂起审批,防 Agent 循环悬挂 */
  private rejectAllPendingPerms(message: string): void {
    for (const [requestId, pending] of this.pendingPerms) {
      this.emit({ kind: 'permission-resolved', requestId, behavior: 'deny' })
      pending.resolve({ allow: false, message })
    }
    this.pendingPerms.clear()
  }

  respondPermission(requestId: string, allow: boolean, message?: string): void {
    const pending = this.pendingPerms.get(requestId)
    if (!pending) return
    this.pendingPerms.delete(requestId)
    this.emit({ kind: 'permission-resolved', requestId, behavior: allow ? 'allow' : 'deny' })
    pending.resolve({ allow, message })
  }

  pendingPermissions(): PermissionRequestInfo[] {
    return [...this.pendingPerms.values()].map((p) => p.info)
  }

  /** 按 permissionMode 决定工具是否需要人工审批;需要则挂起等 UI 决定 */
  private async gateTool(name: string, input: Record<string, unknown>, toolUseId: string): Promise<{ allow: boolean; message?: string }> {
    const mode = this.meta.permissionMode
    if (mode === 'bypassPermissions') return { allow: true }
    if (READONLY_TOOLS.has(name)) return { allow: true }
    if (mode === 'plan') {
      return { allow: false, message: '规划模式:只允许只读工具(read_file/list_dir),不执行写入或命令' }
    }
    if (mode === 'acceptEdits' && EDIT_TOOLS.has(name)) return { allow: true }
    // default 模式的写入/bash,以及 acceptEdits 模式的 bash → 人工审批
    const requestId = randomUUID()
    const info: PermissionRequestInfo = { requestId, toolName: name, input, toolUseId }
    this.emit({ kind: 'permission-request', request: info })
    return new Promise((resolve) => {
      this.pendingPerms.set(requestId, { resolve, info })
    })
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
    this.rejectAllPendingPerms('会话已关闭')
    this.abort?.abort()
    this.abort = null
    this.setStatus('closed')
  }

  private async runResponse(payload: SendMessagePayload, controller: AbortController): Promise<void> {
    try {
      const auth = this.authConfig()
      if (!auth.token) throw new Error('OpenAI 引擎缺少 API Key:请选择 OpenAI Provider 或设置 OPENAI_API_KEY。')

      if (this.protocol() === 'chat') {
        await this.runChatCompletion(payload, controller, auth)
      } else {
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
      }
      this.finishTurn(false)
    } catch (err) {
      const aborted = controller.signal.aborted
      this.finishTurn(true, aborted ? '已中断' : errText(err), aborted ? 'interrupted' : 'error')
    }
  }

  /**
   * Chat Completions(/v1/chat/completions)一轮 = 一个 Agent 循环:
   * user 消息入历史 → 模型流式回复;若回工具调用(bash/read/write/edit/list),
   * 按 permissionMode 审批后真实执行,结果作为 tool 消息回给模型,循环直到
   * 模型给出最终文本或达 MAX_TOOL_ITERATIONS。这让任何 Chat 协议模型
   * (DeepSeek/Qwen/Grok/网关/本地)在 CaoGen 里都是真编码 Agent。
   */
  private async runChatCompletion(
    payload: SendMessagePayload,
    controller: AbortController,
    auth: { baseUrl: string; token: string; headers: Record<string, string> }
  ): Promise<void> {
    const userMessage: ChatMessage = { role: 'user', content: buildChatContent(payload) }
    this.chatHistory.push(userMessage)

    try {
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        if (controller.signal.aborted) throw new Error('已中断')
        this.pendingToolCalls = []
        // 每次循环重置流式文本缓冲(assistantText 聚合本轮所有文本段)
        const textBefore = this.assistantText

        const body = {
          model: this.effectiveModel(),
          messages: [this.systemMessage(), ...this.chatHistory],
          tools: OPENAI_CODING_TOOLS,
          stream: true,
          stream_options: { include_usage: true }
        }
        const res = await fetch(`${auth.baseUrl}/v1/chat/completions`, {
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
        await this.consumeChatStream(res)

        const segmentText = this.assistantText.slice(textBefore.length).trim()
        // 部分端点省略 tool_call id / 空槽:补全 id、丢掉没有函数名的碎片
        const toolCalls = this.pendingToolCalls
          .filter((c) => c.name)
          .map((c) => ({ ...c, id: c.id || `call_${randomUUID().slice(0, 12)}` }))
        this.pendingToolCalls = []

        if (toolCalls.length === 0) {
          // 最终文本回复:入历史,循环结束
          if (segmentText) this.chatHistory.push({ role: 'assistant', content: segmentText })
          return
        }

        // assistant(含 tool_calls)入历史 —— 模型下一轮需要看到自己的调用
        this.chatHistory.push({
          role: 'assistant',
          content: segmentText || null,
          tool_calls: toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.argsText }
          }))
        })

        // 逐个执行(审批 → 执行 → 事件 → tool 消息回灌)
        for (const call of toolCalls) {
          if (controller.signal.aborted) throw new Error('已中断')
          let args: Record<string, unknown> = {}
          try {
            args = call.argsText ? (JSON.parse(call.argsText) as Record<string, unknown>) : {}
          } catch {
            // 参数不是合法 JSON:如实回给模型让它重试
          }
          this.emit({ kind: 'tool-start', toolUseId: call.id, name: call.name })
          this.emit({
            kind: 'assistant-message',
            blocks: [{ type: 'tool_use', id: call.id, name: call.name, input: args }]
          })

          const gate = await this.gateTool(call.name, args, call.id)
          let resultText: string
          let isError: boolean
          if (!gate.allow) {
            resultText = `用户拒绝了此操作${gate.message ? `:${gate.message}` : ''}`
            isError = true
          } else {
            const exec = await executeCodingTool(call.name, args, this.meta.cwd)
            resultText = exec.output
            isError = !exec.ok
          }
          this.emit({ kind: 'tool-result', toolUseId: call.id, content: resultText, isError })
          this.chatHistory.push({ role: 'tool', tool_call_id: call.id, content: resultText })
        }
      }
      // 达迭代上限:如实告知(极少发生;防御无限循环)
      this.appendText(`\n\n[已达单轮工具调用上限 ${MAX_TOOL_ITERATIONS} 次,任务可能未完成;请拆分任务后继续]`)
      this.chatHistory.push({
        role: 'assistant',
        content: `已达单轮工具调用上限 ${MAX_TOOL_ITERATIONS} 次`
      })
    } catch (err) {
      // 本轮失败:回滚到本轮 user 消息之前,避免下一轮重复发送半截上下文
      const idx = this.chatHistory.indexOf(userMessage)
      if (idx !== -1) this.chatHistory.length = idx
      throw err
    }
  }

  /** 编码 Agent 系统提示:工作目录 + 人设(每请求现算,设置变更即时生效) */
  private systemMessage(): ChatMessage {
    const persona = getSettings().persona.trim()
    const lines = [
      '你是 CaoGen 桌面工作室里的编码 Agent。',
      `当前工作目录: ${this.meta.cwd}`,
      '你可以使用工具(bash/read_file/write_file/edit_file/list_dir)读写项目文件、执行命令。',
      '修改文件前先读它;优先用 edit_file 做精确修改;完成后简要说明做了什么。',
      persona
    ].filter(Boolean)
    return { role: 'system', content: lines.join('\n') }
  }

  /** 消费 Chat Completions SSE 流(choices[].delta.content + 末尾 usage 块) */
  private async consumeChatStream(res: Response): Promise<void> {
    if (!res.body) {
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
      const choices = Array.isArray(json?.choices) ? (json?.choices as Array<Record<string, unknown>>) : []
      const msg = choices[0]?.message as Record<string, unknown> | undefined
      if (typeof msg?.content === 'string' && msg.content) this.appendText(msg.content)
      this.applyChatUsage(json)
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
      for (const part of parts) this.handleChatSseEvent(part)
    }
    if (buffer.trim()) this.handleChatSseEvent(buffer)
  }

  private handleChatSseEvent(raw: string): void {
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
      // 网关/端点即使在流里报错也走 error 字段
      if (record.error) throw new Error(extractErrorMessage(record.error) || 'Chat Completions 流式响应报错')
      const choices = Array.isArray(record.choices) ? (record.choices as Array<Record<string, unknown>>) : []
      const delta = choices[0]?.delta as Record<string, unknown> | undefined
      if (typeof delta?.content === 'string' && delta.content) this.appendText(delta.content)
      // 工具调用按 index 分片流式到达:逐片拼装 id/name/arguments
      if (Array.isArray(delta?.tool_calls)) {
        for (const raw of delta.tool_calls as Array<Record<string, unknown>>) {
          const index = typeof raw.index === 'number' ? raw.index : 0
          while (this.pendingToolCalls.length <= index) {
            this.pendingToolCalls.push({ id: '', name: '', argsText: '' })
          }
          const slot = this.pendingToolCalls[index]
          if (typeof raw.id === 'string' && raw.id) slot.id = raw.id
          const fn = raw.function as Record<string, unknown> | undefined
          if (typeof fn?.name === 'string' && fn.name) slot.name += fn.name
          if (typeof fn?.arguments === 'string') slot.argsText += fn.arguments
        }
      }
      // usage 通常出现在最后一个块(stream_options.include_usage)
      if (record.usage) this.applyChatUsage(record)
    }
  }

  /** Chat Completions 的 usage 命名(prompt/completion_tokens)转 CaoGen UsageTotals */
  private applyChatUsage(value: unknown): void {
    if (!value || typeof value !== 'object') return
    const usage = (value as Record<string, unknown>).usage as Record<string, unknown> | undefined
    if (!usage) return
    const input = numberField(usage.prompt_tokens)
    const output = numberField(usage.completion_tokens)
    const details = usage.prompt_tokens_details as Record<string, unknown> | undefined
    const cacheRead = numberField(details?.cached_tokens)
    if (input + output + cacheRead === 0) return
    const totals: UsageTotals = { input, output, cacheRead, cacheCreation: 0 }
    this.turnUsage = totals
    this.meta.usage = totals
    this.meta.contextTokens = input + cacheRead
    this.emit({ kind: 'meta', meta: { ...this.meta } })
  }

  /** 当前 Provider 选择的 OpenAI 协议;未配置默认 responses(官方 API) */
  private protocol(): OpenAIProtocol {
    const provider = this.meta.providerId ? getProvider(this.meta.providerId) : undefined
    return provider?.openaiProtocol === 'chat' ? 'chat' : 'responses'
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

/** Chat Completions 消息内容:纯文本直接用字符串;带图时用多模态数组 */
function buildChatContent(payload: SendMessagePayload): ChatContent {
  const images = payload.images ?? []
  if (images.length === 0) return payload.text
  const out: Array<Record<string, unknown>> = []
  if (payload.text) out.push({ type: 'text', text: payload.text })
  for (const image of images) {
    const dataUrl = imageToDataUrl(image)
    if (dataUrl) out.push({ type: 'image_url', image_url: { url: dataUrl } })
  }
  return out.length > 0 ? out : payload.text
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
  label: 'OpenAI 协议(Responses / Chat Completions)',
  available: () => true,
  create: (meta: SessionMeta, emit: EngineEmit, resumeSdkSessionId?: string): Engine =>
    new OpenAIEngine(meta, emit, resumeSdkSessionId)
}
