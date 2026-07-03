import { randomUUID } from 'node:crypto'
import type { PermissionResult, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { Pushable } from './pushable'
import type {
  AgentEvent,
  AssistantBlock,
  PermissionModeId,
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
  private readonly emit: (event: AgentEvent) => void
  private readonly resumeSdkSessionId?: string
  private disposed = false

  constructor(meta: SessionMeta, emit: (event: AgentEvent) => void, resumeSdkSessionId?: string) {
    this.meta = meta
    this.emit = emit
    this.resumeSdkSessionId = resumeSdkSessionId
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
          // env 是整体替换而非合并,必须显式带上 process.env(PATH、登录凭据等)
          env: { ...process.env },
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
        this.meta.usage = usage
        this.meta.contextTokens = usage.input + usage.cacheRead + usage.cacheCreation
        const subtype = typeof msg.subtype === 'string' ? msg.subtype : 'unknown'
        this.emit({
          kind: 'turn-result',
          subtype,
          isError: msg.is_error === true || subtype !== 'success',
          costUsd,
          usage,
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
    this.emit({
      kind: 'permission-request',
      request: {
        requestId,
        toolName,
        input,
        toolUseId: opts?.toolUseID,
        decisionReason: opts?.decisionReason
      }
    })
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { resolve, input })
      opts?.signal?.addEventListener('abort', () => {
        if (this.pending.delete(requestId)) {
          this.emit({ kind: 'permission-resolved', requestId, behavior: 'deny' })
          resolve({ behavior: 'deny', message: '操作已被取消' })
        }
      })
    })
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
  permissionMode: PermissionModeId
  title?: string
}): SessionMeta {
  return {
    id: randomUUID(),
    title: opts.title || '新会话',
    cwd: opts.cwd,
    model: opts.model,
    permissionMode: opts.permissionMode,
    status: 'starting',
    costUsd: 0,
    usage: emptyUsage(),
    contextTokens: 0,
    createdAt: Date.now()
  }
}
