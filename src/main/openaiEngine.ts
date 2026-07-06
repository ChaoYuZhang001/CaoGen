import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { TranscriptWriter } from './transcript'
import { decryptToken, getProvider, listProviders } from './providers'
import {
  classifyFailure,
  pickFailoverTarget,
  pickModelAcrossProviders,
  recordFailure,
  recordSuccess
} from './scheduler'
import { recordModelFailure, recordModelSuccess } from './modelStats'
import { getSettings } from './settings'
import {
  EDIT_TOOLS,
  OPENAI_CODING_TOOLS,
  READONLY_TOOLS,
  RESPONSES_CODING_TOOLS,
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
 * 全局并发闸门:限制"同一时刻在途的模型请求数",防 32+ 子代理突发把
 * Node 的连接/socket 层打爆(实测 32 并发出现大量 fetch failed)。
 * 模块级共享 —— 所有 OpenAIEngine 实例(含子代理)排队通过同一个信号量。
 * 上限可由 env CAOGEN_MAX_INFLIGHT 覆盖(默认 8,兼顾吞吐与稳定)。
 */
const MAX_INFLIGHT = Math.max(1, Number(process.env.CAOGEN_MAX_INFLIGHT) || 8)
let inflight = 0
const waitQueue: Array<() => void> = []

function acquireSlot(): Promise<void> {
  if (inflight < MAX_INFLIGHT) {
    inflight++
    return Promise.resolve()
  }
  return new Promise((resolve) => waitQueue.push(resolve))
}

function releaseSlot(): void {
  const next = waitQueue.shift()
  if (next) {
    next() // 队首直接接棒占用,inflight 不变
  } else {
    inflight = Math.max(0, inflight - 1)
  }
}

/** 历史压缩触发阈值(估算 token);超过则把旧段摘要 */
const COMPRESS_TRIGGER_TOKENS = 48_000
/** 压缩时至少保留的最近消息条数(在此范围内找 user 边界) */
const KEEP_RECENT_MSGS = 12

/** 粗估消息 token 数:中英混排按 ~3 字符/token 保守估计 */
function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0
  for (const m of messages) {
    chars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length
  }
  return Math.ceil(chars / 3)
}

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
    // 新一轮:重置故障切换防打转记录
    this.triedProviders = new Set([this.meta.providerId])
    // auto 模式:跨厂商路由(openai 引擎切 Provider 无需重建,authConfig 每请求现读)
    if (this.meta.model === AUTO_MODEL) this.autoRoute(payload.text)
    this.abort = new AbortController()
    this.setStatus('running')
    void this.runResponse(payload, this.abort)
  }

  /** 本轮路由选中的模型(meta.model 保持 auto 哨兵,下一轮重新路由) */
  private routedModel?: string

  /** 跨厂商智能路由:候选 = 所有有 baseUrl 的 Provider(官方 Anthropic 空址不适配本引擎) */
  private autoRoute(text: string): void {
    try {
      // 候选:有端点且已配 key 的厂商(没 key 的选中必失败,不进池)
      const candidates = listProviders()
        .filter((p) => p.baseUrl.trim().length > 0 && p.hasToken)
        .map((p) => ({ id: p.id, name: p.name, models: p.models }))
      const decision = pickModelAcrossProviders({
        candidates,
        text,
        strategy: getSettings().schedulerStrategy,
        currentProviderId: this.meta.providerId
      })
      if (!decision) return
      this.routedModel = decision.model
      if (decision.switchedProvider) {
        this.meta.providerId = decision.providerId
      }
      this.emit({ kind: 'routing', model: decision.model, reason: decision.reason, providerId: decision.providerId })
      this.emit({ kind: 'meta', meta: { ...this.meta } })
    } catch (err) {
      console.error('[caogen] openai 引擎自动路由失败,沿用当前配置:', err)
    }
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
        await this.runResponsesLoop(payload, controller, auth)
      }
      const latency = Date.now() - this.turnStartedAt
      recordSuccess(this.meta.providerId, latency)
      recordModelSuccess(this.effectiveModel(), latency)
      this.finishTurn(false)
    } catch (err) {
      const aborted = controller.signal.aborted
      if (aborted) {
        this.finishTurn(true, '已中断', 'interrupted')
        return
      }
      const text = errText(err)
      recordFailure(this.meta.providerId, text)
      recordModelFailure(this.effectiveModel())
      // 跨厂商故障切换:厂商侧故障(限流/余额/5xx/网络)自动换健康厂商重试本轮
      if (await this.tryFailover(text, payload)) return
      this.finishTurn(true, text, 'error')
    }
  }

  /** 本轮已试过的厂商(防切换打转);send 时重置 */
  private triedProviders = new Set<string>()
  /** Responses 协议的上一轮 response id(服务端多轮上下文) */
  private lastResponseId?: string
  /** 本轮流式累积的 Responses 函数调用(按 output_index 拼装) */
  private pendingResponseCalls: Array<{ callId: string; name: string; argsText: string }> = []
  private static readonly MAX_FAILOVERS_PER_TURN = 3

  /**
   * Responses 协议的 Agent 循环:与 chat 对等地接编码工具。
   * 首轮 input=用户消息;若返回 function_call,执行后以 function_call_output
   * 作为下一轮 input 回灌,并用 previous_response_id 续服务端上下文,直到
   * 无函数调用或达上限。工具的审批/执行复用与 chat 相同的 gateTool/executeCodingTool。
   */
  private async runResponsesLoop(
    payload: SendMessagePayload,
    controller: AbortController,
    auth: { baseUrl: string; token: string; headers: Record<string, string> }
  ): Promise<void> {
    let input: unknown[] = [{ role: 'user', content: buildInputContent(payload) }]

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      if (controller.signal.aborted) throw new Error('已中断')
      this.pendingResponseCalls = []

      const body = {
        model: this.effectiveModel(),
        input,
        tools: RESPONSES_CODING_TOOLS,
        ...(this.lastResponseId ? { previous_response_id: this.lastResponseId } : {}),
        stream: true
      }
      const res = await this.fetchWithRetry(
        `${auth.baseUrl}/v1/responses`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json', ...auth.headers },
          body: JSON.stringify(body),
          signal: controller.signal
        },
        controller.signal
      )
      if (!res.ok) throw new Error(await formatOpenAIError(res))
      await this.consumeResponse(res)

      const calls = this.pendingResponseCalls.filter((c) => c.name && c.callId)
      this.pendingResponseCalls = []
      if (calls.length === 0) return // 最终文本回复,循环结束

      // 执行工具,结果作为下一轮 input(function_call_output);服务端已存住调用本身
      const outputs: unknown[] = []
      for (const call of calls) {
        if (controller.signal.aborted) throw new Error('已中断')
        let args: Record<string, unknown> = {}
        try {
          args = call.argsText ? (JSON.parse(call.argsText) as Record<string, unknown>) : {}
        } catch {
          // 参数非法 JSON:如实回给模型重试
        }
        this.emit({ kind: 'tool-start', toolUseId: call.callId, name: call.name })
        this.emit({
          kind: 'assistant-message',
          blocks: [{ type: 'tool_use', id: call.callId, name: call.name, input: args }]
        })
        const gate = await this.gateTool(call.name, args, call.callId)
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
        this.emit({ kind: 'tool-result', toolUseId: call.callId, content: resultText, isError })
        outputs.push({ type: 'function_call_output', call_id: call.callId, output: resultText })
      }
      input = outputs // 下一轮只发工具结果(previous_response_id 续上文)
    }
    this.appendText(`\n\n[已达单轮工具调用上限 ${MAX_TOOL_ITERATIONS} 次,任务可能未完成;请拆分任务后继续]`)
  }

  /**
   * OpenAI 引擎跨厂商故障切换:错误可切换时挑健康厂商换家重试。
   * 比 Claude 引擎轻得多 —— 无需重建进程,authConfig 每请求现读,
   * 换 providerId + 模型即可;chat 历史在内存里原样带走。
   */
  private async tryFailover(errorText: string, payload: SendMessagePayload): Promise<boolean> {
    if (this.disposed || !getSettings().failoverEnabled) return false
    if (this.triedProviders.size > OpenAIEngine.MAX_FAILOVERS_PER_TURN) return false
    const failure = classifyFailure(errorText)
    if (!failure.switchable) return false

    const candidates = listProviders()
      .filter((p) => p.baseUrl.trim().length > 0 && p.hasToken)
      .map((p) => ({ id: p.id, name: p.name, models: p.models }))
    const target = pickFailoverTarget({
      candidates,
      exclude: this.triedProviders,
      desiredModel: this.effectiveModel()
    })
    if (!target) return false

    const fromId = this.meta.providerId
    const fromName = listProviders().find((p) => p.id === fromId)?.name ?? fromId ?? '当前厂商'
    this.triedProviders.add(target.providerId)
    this.meta.providerId = target.providerId
    if (target.model) this.routedModel = target.model
    // Responses 的 response id 不跨厂商;换家后重新开始服务端上下文链
    this.lastResponseId = undefined
    this.emit({
      kind: 'failover',
      fromProviderId: fromId,
      toProviderId: target.providerId,
      fromName,
      toName: target.name,
      model: target.model,
      reason: failure.label
    })
    this.emit({ kind: 'meta', meta: { ...this.meta } })

    const controller = new AbortController()
    this.abort = controller
    await this.runResponse(payload, controller)
    return true
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
      // 轮次开始前压缩过长历史(仅在轮边界压,不打断进行中的 tool_call 配对)
      await this.compressHistoryIfNeeded(auth)
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
        const res = await this.fetchWithRetry(
          `${auth.baseUrl}/v1/chat/completions`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${auth.token}`,
              'content-type': 'application/json',
              ...auth.headers
            },
            body: JSON.stringify(body),
            signal: controller.signal
          },
          controller.signal
        )
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

  /**
   * chat 历史压缩:估算 token 超阈值时,把"较旧的一段"摘要成一条 system 便签,
   * 保留最近若干轮原文。关键约束 —— 绝不切断 tool_call 配对:切点必须落在
   * 一条 user 消息之前(user 一定是干净的轮边界)。摘要失败则跳过压缩(不阻塞对话)。
   */
  private async compressHistoryIfNeeded(auth: {
    baseUrl: string
    token: string
    headers: Record<string, string>
  }): Promise<void> {
    const estimate = estimateTokens(this.chatHistory)
    if (estimate < COMPRESS_TRIGGER_TOKENS) return

    // 找切点:保留末尾 KEEP_RECENT_MSGS 条内、最靠前的一个 user 边界。
    // 切点之前的消息被摘要;之后(含该 user)保留原文。
    const keepFrom = this.findUserBoundary(Math.max(0, this.chatHistory.length - KEEP_RECENT_MSGS))
    if (keepFrom <= 1) return // 没有可压缩的旧段(全是近期轮次)

    const older = this.chatHistory.slice(0, keepFrom)
    const recent = this.chatHistory.slice(keepFrom)
    const summary = await this.summarize(older, auth).catch(() => null)
    if (!summary) return // 摘要失败:保持原样,下轮再试

    this.chatHistory = [
      { role: 'system', content: `[早期对话摘要 · 由 CaoGen 自动压缩]\n${summary}` },
      ...recent
    ]
    this.emit({
      kind: 'hook-event',
      event: 'context-compressed',
      detail: `压缩 ${older.length} 条历史为摘要,保留最近 ${recent.length} 条`
    })
  }

  /** 从 index 起向后找第一条 user 消息的下标(轮边界);找不到返回原 index */
  private findUserBoundary(from: number): number {
    for (let i = from; i < this.chatHistory.length; i++) {
      if (this.chatHistory[i].role === 'user') return i
    }
    return from
  }

  /** 用当前模型把一段历史压成简洁中文摘要(非流式,低温度,不带工具) */
  private async summarize(
    messages: ChatMessage[],
    auth: { baseUrl: string; token: string; headers: Record<string, string> }
  ): Promise<string | null> {
    const transcript = messages
      .map((m) => {
        const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : m.role === 'tool' ? '工具' : '系统'
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        return `${role}: ${text.slice(0, 2000)}`
      })
      .join('\n')
      .slice(0, 40_000)
    const res = await fetch(`${auth.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json', ...auth.headers },
      body: JSON.stringify({
        model: this.effectiveModel(),
        messages: [
          {
            role: 'system',
            content:
              '把下面的编码会话历史压成要点摘要:保留关键决策、已完成的改动、待办、重要文件路径与结论,丢弃寒暄与冗余。用简洁中文,不超过 400 字。'
          },
          { role: 'user', content: transcript }
        ],
        stream: false,
        max_tokens: 800
      })
    })
    if (!res.ok) return null
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    const choices = Array.isArray(json?.choices) ? (json?.choices as Array<Record<string, unknown>>) : []
    const msg = choices[0]?.message as Record<string, unknown> | undefined
    const text = typeof msg?.content === 'string' ? msg.content.trim() : ''
    return text || null
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

  /**
   * 当前 Provider 的 OpenAI 协议。显式配置优先;未配置时按端点智能默认:
   * OpenAI 官方(或未配 Provider)→ responses;任何第三方端点 → chat
   * (Chat Completions 是通用协议,第三方几乎都不实现 Responses ——
   * 之前默认 responses 会让 DeepSeek/网关直接 404)。
   */
  private protocol(): OpenAIProtocol {
    const provider = this.meta.providerId ? getProvider(this.meta.providerId) : undefined
    if (provider?.openaiProtocol === 'chat') return 'chat'
    if (provider?.openaiProtocol === 'responses') return 'responses'
    const baseUrl = (provider?.baseUrl ?? '').trim()
    if (!baseUrl) return 'responses'
    try {
      const host = new URL(baseUrl).host
      return host === 'api.openai.com' ? 'responses' : 'chat'
    } catch {
      return 'chat'
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
      // 函数调用参数流式分片:response.function_call_arguments.delta
      if (type === 'response.function_call_arguments.delta') {
        const idx = typeof record.output_index === 'number' ? record.output_index : 0
        const slot = this.ensureResponseCall(idx)
        if (typeof record.delta === 'string') slot.argsText += record.delta
        continue
      }
      // 函数调用条目登场:response.output_item.added,item={type:'function_call',call_id,name}
      if (type === 'response.output_item.added' && record.item && typeof record.item === 'object') {
        const item = record.item as Record<string, unknown>
        if (item.type === 'function_call') {
          const idx = typeof record.output_index === 'number' ? record.output_index : 0
          const slot = this.ensureResponseCall(idx)
          if (typeof item.call_id === 'string') slot.callId = item.call_id
          if (typeof item.name === 'string') slot.name = item.name
          if (typeof item.arguments === 'string') slot.argsText += item.arguments
        }
        continue
      }
      // 函数调用条目完成:补全终值(部分实现只在 done 给全量 arguments)
      if (type === 'response.output_item.done' && record.item && typeof record.item === 'object') {
        const item = record.item as Record<string, unknown>
        if (item.type === 'function_call') {
          const idx = typeof record.output_index === 'number' ? record.output_index : 0
          const slot = this.ensureResponseCall(idx)
          if (typeof item.call_id === 'string') slot.callId = item.call_id
          if (typeof item.name === 'string') slot.name = item.name
          if (typeof item.arguments === 'string' && item.arguments) slot.argsText = item.arguments
        }
        continue
      }
      if (type === 'response.completed') {
        this.applyUsage(record.response)
        // 记录 response id 供下一轮 previous_response_id 续上下文
        const responseId = (record.response as Record<string, unknown> | undefined)?.id
        if (typeof responseId === 'string' && responseId) this.lastResponseId = responseId
        const text = extractResponseText(record.response)
        if (text && !this.assistantText.includes(text)) this.appendText(text)
      }
      if (type === 'response.failed') {
        const error = (record.response as Record<string, unknown> | undefined)?.error ?? record.error
        throw new Error(extractErrorMessage(error) || 'OpenAI response failed')
      }
    }
  }

  /**
   * 带退避重试的 fetch:瞬时网络错误(fetch failed / ECONNRESET / socket 等,
   * 高并发下常见)重试最多 2 次(0.5s、1.5s 退避)。用户中断与 HTTP 错误不重试
   * (HTTP 错误交给上层 failover/如实报错)。解决 32 并发突发下的偶发 fetch failed。
   */
  private async fetchWithRetry(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    // 先过并发闸门:限制同时在途请求数,防突发打爆 socket 层
    await acquireSlot()
    try {
      const delays = [500, 1500]
      let lastErr: unknown
      for (let attempt = 0; attempt <= delays.length; attempt++) {
        if (signal.aborted) throw new Error('已中断')
        try {
          return await fetch(url, init)
        } catch (err) {
          // AbortError(用户中断)不重试
          if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) throw err
          lastErr = err
          if (attempt < delays.length) {
            await new Promise((r) => setTimeout(r, delays[attempt]))
          }
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
    } finally {
      releaseSlot()
    }
  }

  /** 按 output_index 取/建一个 Responses 函数调用累积槽 */
  private ensureResponseCall(index: number): { callId: string; name: string; argsText: string } {
    while (this.pendingResponseCalls.length <= index) {
      this.pendingResponseCalls.push({ callId: '', name: '', argsText: '' })
    }
    return this.pendingResponseCalls[index]
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
    let baseUrl = (provider?.baseUrl || process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '')
    // 用户把为 Claude 引擎准备的 Anthropic 兼容 Provider(…/anthropic)用在
    // OpenAI 引擎上时,剥掉子路径回到裸域 —— DeepSeek 等厂商在裸域同时提供
    // /v1/chat/completions,直接可用而非 404。
    if (this.protocol() === 'chat') baseUrl = baseUrl.replace(/\/anthropic$/, '')
    const token = provider ? decryptToken(provider.encryptedToken) : process.env.OPENAI_API_KEY || ''
    return { baseUrl, token, headers: parseHeaders(provider?.customHeaders) }
  }

  private effectiveModel(): string {
    if (this.meta.model && this.meta.model !== AUTO_MODEL) return this.meta.model
    if (this.routedModel) return this.routedModel // auto 模式:本轮路由结果
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
