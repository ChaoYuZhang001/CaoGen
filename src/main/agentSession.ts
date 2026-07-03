import { randomUUID } from 'node:crypto'
import type { PermissionResult, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { Pushable } from './pushable'
import { TranscriptWriter } from './transcript'
import { getProvider, decryptToken } from './providers'
import type {
  AgentEvent,
  AssistantBlock,
  PermissionModeId,
  PermissionRequestInfo,
  SessionMeta,
  UsageTotals
} from '../shared/types'

type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')

let sdkPromise: Promise<SdkModule> | undefined

/** SDK 为 ESM-only,主进程按 CJS 构建,故用动态 import 惰性加载。 */
function loadSdk(): Promise<SdkModule> {
  sdkPromise ??= import('@anthropic-ai/claude-agent-sdk')
  return sdkPromise
}

const TOOL_RESULT_MAX_CHARS = 20_000

interface PendingPermission {
  resolve: (result: PermissionResult) => void
  input: Record<string, unknown>
  info: PermissionRequestInfo
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
}

function normalizeUsage(raw: unknown): UsageTotals {
  const u = (raw ?? {}) as Record<string, unknown>
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheCreation: n(u.cache_creation_input_tokens)
  }
}

function normalizeBlocks(content: unknown): AssistantBlock[] {
  if (!Array.isArray(content)) return []
  const out: AssistantBlock[] = []
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const b = raw as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
      out.push({ type: 'text', text: b.text })
    } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.length > 0) {
      out.push({ type: 'thinking', text: b.thinking })
    } else if (b.type === 'tool_use') {
      out.push({
        type: 'tool_use',
        id: typeof b.id === 'string' ? b.id : randomUUID(),
        name: typeof b.name === 'string' ? b.name : 'unknown',
        input: b.input
      })
    }
  }
  return out
}

function toolResultText(content: unknown): string {
  let text: string
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    text = content
      .map((c) => {
        const block = c as Record<string, unknown> | null
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

/**
 * 一个桌面会话 = 一个持续存活的 Agent SDK query(流式输入模式)。
 * 通过 Pushable 推送用户消息,通过回调把 SDK 消息翻译成 AgentEvent 发往渲染进程。
 */
export class AgentSession {
  readonly meta: SessionMeta
  private readonly input = new Pushable<SDKUserMessage>()
  private query: Query | null = null
  private readonly pending = new Map<string, PendingPermission>()
  private readonly emitRaw: (event: AgentEvent) => void
  private readonly transcript: TranscriptWriter
  private readonly resumeSdkSessionId?: string
  private disposed = false

  constructor(meta: SessionMeta, emit: (event: AgentEvent, seq: number) => void, resumeSdkSessionId?: string) {
    this.meta = meta
    this.transcript = new TranscriptWriter(resumeSdkSessionId)
    this.emitRaw = (event) => emit(event, this.transcript.next(event))
    this.resumeSdkSessionId = resumeSdkSessionId
    // resume 模式下 SDK 不会再发 system/init,手动设置并通知渲染进程
    if (resumeSdkSessionId) {
      this.meta.sdkSessionId = resumeSdkSessionId
      this.emit({ kind: 'init', sdkSessionId: resumeSdkSessionId })
    }
  }

  /**
   * 组装 SDK 子进程 env:以 process.env 为基,叠加所选 Provider 的
   * ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 覆写,实现按会话切换厂商。
   * env 是整体替换而非合并,必须显式带上 process.env(PATH、登录凭据等)。
   */
  private buildEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    if (!this.meta.providerId) return env
    const provider = getProvider(this.meta.providerId)
    if (!provider) {
      console.warn('[agent-desk] Provider 不存在,回退默认:', this.meta.providerId)
      return env
    }
    // 用户显式选了 Provider 时,剥离 host 托管鉴权,否则宿主(如 Claude 桌面)
    // 的 host-creds 文件会盖过我们注入的凭据,导致 Provider 形同虚设。
    delete env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
    delete env.CLAUDE_CODE_HOST_CREDS_FILE
    delete env.CLAUDE_CODE_HOST_AUTH_ENV_VAR
    delete env.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH
    delete env.CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH
    if (provider.baseUrl) env.ANTHROPIC_BASE_URL = provider.baseUrl
    const token = decryptToken(provider.encryptedToken)
    if (token) {
      env.ANTHROPIC_AUTH_TOKEN = token
      // 兼容以 API key 方式鉴权的网关;两者择一即可,一并覆写避免旧值干扰
      env.ANTHROPIC_API_KEY = token
    }
    return env
  }

  async start(): Promise<void> {
    this.setStatus('starting')
    try {
      const sdk = await loadSdk()
      this.query = sdk.query({
        prompt: this.input,
        options: {
          cwd: this.meta.cwd,
          permissionMode: this.meta.permissionMode,
          includePartialMessages: true,
          env: this.buildEnv(),
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          ...(this.meta.model ? { model: this.meta.model } : {}),
          ...(this.resumeSdkSessionId ? { resume: this.resumeSdkSessionId } : {}),
          canUseTool: (toolName, input, opts) => this.requestPermission(toolName, input, opts)
        }
      })
    } catch (err) {
      this.setStatus('error', errText(err))
      return
    }
    void this.consume()
  }

  send(text: string): void {
    if (this.disposed) return
    // 流已死(启动失败 / 进程退出)时静默排队只会让 UI 永远停在"运行中"
    if (!this.query || this.meta.status === 'error' || this.meta.status === 'closed') {
      this.setStatus('error', '会话已结束,无法发送消息。请新建会话或从历史恢复。')
      return
    }
    this.emit({ kind: 'user-message', text })
    if (this.meta.title === '新会话' && text.trim()) {
      this.meta.title = text.trim().replace(/\s+/g, ' ').slice(0, 40)
      this.emit({ kind: 'meta', meta: { ...this.meta } })
    }
    this.setStatus('running')
    const message = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: this.meta.sdkSessionId ?? ''
    }
    this.input.push(message as unknown as SDKUserMessage)
  }

  async interrupt(): Promise<void> {
    try {
      await this.query?.interrupt()
    } catch (err) {
      console.error('[agent-desk] interrupt 失败:', err)
    }
  }

  respondPermission(requestId: string, allow: boolean, message?: string): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    this.emit({ kind: 'permission-resolved', requestId, behavior: allow ? 'allow' : 'deny' })
    if (allow) {
      pending.resolve({ behavior: 'allow', updatedInput: pending.input })
    } else {
      pending.resolve({ behavior: 'deny', message: message || '用户拒绝了此操作' })
    }
  }

  pendingPermissions(): PermissionRequestInfo[] {
    return [...this.pending.values()].map((p) => p.info)
  }

  /** 已持久化 + 缓冲的耐久事件(user/assistant/tool-result/turn-result),供恢复时回填 */
  getTranscript() {
    return this.transcript.read()
  }

  async setPermissionMode(mode: PermissionModeId): Promise<void> {
    await this.query?.setPermissionMode(mode)
    this.meta.permissionMode = mode
    this.emit({ kind: 'meta', meta: { ...this.meta } })
  }

  async setModel(model: string): Promise<void> {
    await this.query?.setModel(model || undefined)
    this.meta.model = model
    this.emit({ kind: 'meta', meta: { ...this.meta } })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.input.end()
    for (const [requestId, pending] of this.pending) {
      pending.resolve({ behavior: 'deny', message: '会话已关闭' })
      this.emit({ kind: 'permission-resolved', requestId, behavior: 'deny' })
    }
    this.pending.clear()
    try {
      this.query?.close()
    } catch {
      // 进程可能已退出
    }
    this.setStatus('closed')
  }

  private async consume(): Promise<void> {
    const q = this.query
    if (!q) return
    try {
      for await (const message of q) {
        this.handleMessage(message as unknown as Record<string, unknown>)
      }
      if (!this.disposed) this.setStatus('closed')
    } catch (err) {
      if (!this.disposed) this.setStatus('error', errText(err))
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          const sdkSessionId = typeof msg.session_id === 'string' ? msg.session_id : ''
          this.meta.sdkSessionId = sdkSessionId
          this.emit({
            kind: 'init',
            sdkSessionId,
            model: typeof msg.model === 'string' ? msg.model : undefined,
            tools: Array.isArray(msg.tools) ? (msg.tools as string[]) : undefined,
            permissionMode: typeof msg.permissionMode === 'string' ? msg.permissionMode : undefined
          })
        }
        break
      }
      case 'stream_event': {
        this.handleStreamEvent(msg.event as Record<string, unknown> | undefined)
        break
      }
      case 'assistant': {
        const message = msg.message as Record<string, unknown> | undefined
        const blocks = normalizeBlocks(message?.content)
        if (blocks.length > 0) this.emit({ kind: 'assistant-message', blocks })
        break
      }
      case 'user': {
        const message = msg.message as Record<string, unknown> | undefined
        const content = message?.content
        if (!Array.isArray(content)) break
        for (const raw of content) {
          const block = raw as Record<string, unknown> | null
          if (block && block.type === 'tool_result') {
            this.emit({
              kind: 'tool-result',
              toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
              content: toolResultText(block.content),
              isError: block.is_error === true
            })
          }
        }
        break
      }
      case 'result': {
        const usage = normalizeUsage(msg.usage)
        const costUsd = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined
        if (costUsd !== undefined) this.meta.costUsd = costUsd
        // 中断/异常的 result 可能带全零 usage,不能覆盖已知的上下文规模
        const hasUsage = usage.input + usage.output + usage.cacheRead + usage.cacheCreation > 0
        if (hasUsage) {
          this.meta.usage = usage
          this.meta.contextTokens = usage.input + usage.cacheRead + usage.cacheCreation
        }
        const subtype = typeof msg.subtype === 'string' ? msg.subtype : 'unknown'
        this.emit({
          kind: 'turn-result',
          subtype,
          isError: msg.is_error === true || subtype !== 'success',
          costUsd,
          usage: hasUsage ? usage : undefined,
          durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : undefined,
          numTurns: typeof msg.num_turns === 'number' ? msg.num_turns : undefined,
          resultText: typeof msg.result === 'string' ? msg.result : undefined
        })
        this.setStatus('idle')
        break
      }
      default:
        break
    }
  }

  private handleStreamEvent(event: Record<string, unknown> | undefined): void {
    if (!event) return
    if (event.type === 'content_block_start') {
      const cb = event.content_block as Record<string, unknown> | undefined
      if (cb?.type === 'tool_use' && typeof cb.id === 'string' && typeof cb.name === 'string') {
        this.emit({ kind: 'tool-start', toolUseId: cb.id, name: cb.name })
      }
      return
    }
    if (event.type === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown> | undefined
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        this.emit({ kind: 'text-delta', text: delta.text })
      } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        this.emit({ kind: 'thinking-delta', text: delta.thinking })
      }
    }
  }

  private requestPermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal?: AbortSignal; toolUseID?: string; decisionReason?: string } | undefined
  ): Promise<PermissionResult> {
    const requestId = randomUUID()
    const info: PermissionRequestInfo = {
      requestId,
      toolName,
      input,
      toolUseId: opts?.toolUseID,
      decisionReason: opts?.decisionReason
    }
    this.emit({ kind: 'permission-request', request: info })
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { resolve, input, info })
      opts?.signal?.addEventListener('abort', () => {
        if (this.pending.delete(requestId)) {
          this.emit({ kind: 'permission-resolved', requestId, behavior: 'deny' })
          resolve({ behavior: 'deny', message: '操作已被取消' })
        }
      })
    })
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

export function newSessionMeta(opts: {
  cwd: string
  model: string
  providerId: string
  permissionMode: PermissionModeId
  title?: string
}): SessionMeta {
  return {
    id: randomUUID(),
    title: opts.title || '新会话',
    cwd: opts.cwd,
    model: opts.model,
    providerId: opts.providerId,
    permissionMode: opts.permissionMode,
    status: 'starting',
    costUsd: 0,
    usage: emptyUsage(),
    contextTokens: 0,
    createdAt: Date.now()
  }
}
