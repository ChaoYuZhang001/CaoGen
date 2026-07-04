import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { Pushable } from './pushable'
import { TranscriptWriter } from './transcript'
import { getProvider, decryptToken } from './providers'
import { AUTO_MODEL } from '../shared/types'
import type { Engine, EngineEmit, EngineFactory } from './engine'
import type {
  AgentEvent,
  PermissionModeId,
  PermissionRequestInfo,
  SendMessagePayload,
  SessionMeta,
  TranscriptEntry
} from '../shared/types'

/**
 * M6 · GeminiEngine(实验性)——Google Gemini CLI 适配器骨架。
 *
 * 设计与 CodexEngine 对齐:把外部 CLI 的每一轮调用翻译成 CaoGen 的
 * AgentEvent 事件流。Gemini CLI 无 CaoGen 需要的权限协议 / 文件检查点,
 * 故此适配器只覆盖"发消息 → 流式文本 → 一轮结束"的核心闭环,
 * 权限、检查点等能力如实缺省(pendingPermissions 恒空、不实现 rewind)。
 *
 * 调用模型:每轮 send() spawn 一次 `gemini -p <prompt>`(非交互),
 * 边读 stdout 边发 text-delta,进程退出时汇总为 assistant-message + turn-result。
 * 这是"尽力翻译"的最小实现;Gemini CLI 若无稳定的流式 JSON 协议,
 * 逐 token 流式可能退化为分块输出,但事件契约保持一致。
 *
 * 未注册:engines.ts 暂不注册本引擎(可用性 false)。接线方式见文件末尾说明,
 * 或由主控在确认 CLI 行为后启用。
 */

/** 单次 CLI 探测结果缓存,避免每轮重复 spawn `which`。 */
let cachedAvailable: boolean | undefined

/** 探测 `gemini` 是否在 PATH 上(结果缓存)。 */
export function geminiCliAvailable(): boolean {
  if (cachedAvailable !== undefined) return cachedAvailable
  try {
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['gemini'], {
      stdio: 'ignore',
      timeout: 3000
    })
    cachedAvailable = probe.status === 0
  } catch {
    cachedAvailable = false
  }
  return cachedAvailable
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function normalizeText(input: string | SendMessagePayload): string {
  if (typeof input === 'string') return input.trim()
  return typeof input.text === 'string' ? input.text.trim() : ''
}

/** 最长单轮运行(防 CLI 挂起拖死会话)。 */
const TURN_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 一个桌面会话 = 一个 GeminiEngine。与 AgentSession(常驻 query)不同,
 * Gemini CLI 以非交互单发模式驱动:每轮 send() 起一个短命子进程,
 * 进程生命周期即一轮对话。多轮上下文由 CLI 侧 --resume(若支持)或
 * 简单拼接维持;此骨架先保证单轮闭环,resume 语义待 CLI 协议确认后补。
 */
export class GeminiEngine implements Engine {
  readonly meta: SessionMeta
  private readonly emitRaw: (event: AgentEvent) => void
  private readonly transcript: TranscriptWriter
  private child: ChildProcessWithoutNullStreams | null = null
  private disposed = false
  private turnStartedAt = 0
  /** 本轮累积的 stdout 文本,用于收尾时补 assistant-message。 */
  private turnBuffer = ''
  private turnStderr = ''
  private turnTimer: NodeJS.Timeout | null = null
  /** 引擎代数:每轮 +1,超时/退出回调据此判断是否已过期。 */
  private generation = 0

  constructor(meta: SessionMeta, emit: EngineEmit, resumeSdkSessionId?: string) {
    this.meta = meta
    this.transcript = new TranscriptWriter(resumeSdkSessionId)
    this.emitRaw = (event) => emit(event, this.transcript.next(event))
    if (resumeSdkSessionId) {
      this.meta.sdkSessionId = resumeSdkSessionId
      this.emit({ kind: 'init', sdkSessionId: resumeSdkSessionId })
    }
  }

  /**
   * 组装 CLI 子进程 env:以 process.env 为基,叠加所选 Provider 覆写。
   * Gemini CLI 读 GEMINI_API_KEY / GOOGLE_API_KEY;自定义网关可用 baseUrl。
   * env 整体替换而非合并,必须显式带上 process.env(PATH、登录凭据等)。
   */
  private buildEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    if (!this.meta.providerId) return env
    const provider = getProvider(this.meta.providerId)
    if (!provider) {
      console.warn('[caogen] Provider 不存在,回退默认:', this.meta.providerId)
      return env
    }
    const token = decryptToken(provider.encryptedToken)
    if (token) {
      env.GEMINI_API_KEY = token
      env.GOOGLE_API_KEY = token
    }
    if (provider.baseUrl) {
      // Gemini CLI 的自定义端点变量名随版本而异;两者一并覆写,尽力兼容。
      env.GOOGLE_GEMINI_BASE_URL = provider.baseUrl
      env.GEMINI_BASE_URL = provider.baseUrl
    }
    return env
  }

  async start(): Promise<void> {
    if (this.disposed) return
    // 单发模式:start 只做就绪校验,真正的进程在 send() 时按轮起。
    if (!geminiCliAvailable()) {
      this.setStatus('error', 'Gemini CLI 未安装或不在 PATH 上')
      return
    }
    // 尚无 sdkSessionId 时自铸一个,供转录落盘与历史持久化对齐 Claude 引擎。
    if (!this.meta.sdkSessionId) {
      const id = `gemini-${randomUUID()}`
      this.meta.sdkSessionId = id
      this.emit({ kind: 'init', sdkSessionId: id, model: this.effectiveModel() })
    }
    this.setStatus('idle')
  }

  /** 'auto' 哨兵不是真实模型名,不传给 CLI;返回 undefined 走 CLI 默认。 */
  private effectiveModel(): string | undefined {
    if (!this.meta.model || this.meta.model === AUTO_MODEL) return undefined
    return this.meta.model
  }

  send(input: string | SendMessagePayload): void {
    if (this.disposed) return
    const text = normalizeText(input)
    if (!text) return
    if (this.child) {
      // 上一轮尚未结束:Gemini 单发模式不支持并发,提示用户等待或中断。
      this.emitUserMessage(text)
      this.setStatus('error', '上一轮仍在运行,请等待完成或中断后再发送')
      return
    }
    this.emitUserMessage(text)
    if (this.meta.title === '新会话' && text) {
      this.meta.title = text.replace(/\s+/g, ' ').slice(0, 40)
      this.emit({ kind: 'meta', meta: { ...this.meta } })
    }
    this.runTurn(text)
  }

  /** 起一个非交互 CLI 子进程跑一轮,流式翻译 stdout → AgentEvent。 */
  private runTurn(prompt: string): void {
    const gen = ++this.generation
    this.turnBuffer = ''
    this.turnStderr = ''
    this.turnStartedAt = Date.now()
    this.setStatus('running')

    const model = this.effectiveModel()
    const args = ['-p', prompt]
    if (model) args.push('-m', model)

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn('gemini', args, {
        cwd: this.meta.cwd,
        env: this.buildEnv()
      }) as ChildProcessWithoutNullStreams
    } catch (err) {
      this.setStatus('error', `启动 Gemini CLI 失败: ${errText(err)}`)
      return
    }
    this.child = child

    this.turnTimer = setTimeout(() => {
      if (gen !== this.generation) return
      console.warn('[caogen] Gemini 轮次超时,终止子进程')
      try {
        child.kill('SIGTERM')
      } catch {
        // 进程可能已退出
      }
    }, TURN_TIMEOUT_MS)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (gen !== this.generation || this.disposed) return
      this.turnBuffer += chunk
      this.emit({ kind: 'text-delta', text: chunk })
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (gen !== this.generation) return
      this.turnStderr += chunk
    })
    child.on('error', (err) => {
      if (gen !== this.generation || this.disposed) return
      this.finishTurn(gen, null, errText(err))
    })
    child.on('close', (code) => {
      if (gen !== this.generation || this.disposed) return
      this.finishTurn(gen, code, undefined)
    })
  }

  /** 收尾一轮:补 assistant-message,发 turn-result,复位状态。 */
  private finishTurn(gen: number, code: number | null, spawnError: string | undefined): void {
    if (gen !== this.generation) return
    if (this.turnTimer) {
      clearTimeout(this.turnTimer)
      this.turnTimer = null
    }
    this.child = null
    const text = this.turnBuffer.trim()
    const stderr = this.turnStderr.trim()
    const isError = spawnError !== undefined || (code !== null && code !== 0)
    if (text) {
      this.emit({ kind: 'assistant-message', blocks: [{ type: 'text', text }] })
    }
    const errorMessage = spawnError ?? (isError ? stderr || `Gemini CLI 退出码 ${code}` : undefined)
    this.emit({
      kind: 'turn-result',
      subtype: isError ? 'error' : 'success',
      isError,
      durationMs: this.turnStartedAt ? Date.now() - this.turnStartedAt : undefined,
      resultText: isError ? errorMessage : text || undefined
    })
    if (isError) {
      this.setStatus('error', errorMessage)
    } else {
      this.setStatus('idle')
    }
  }

  async interrupt(): Promise<void> {
    const child = this.child
    if (!child) return
    // 令本轮代数作废:后续 stdout/close 回调被忽略,不再误发事件。
    this.generation++
    if (this.turnTimer) {
      clearTimeout(this.turnTimer)
      this.turnTimer = null
    }
    this.child = null
    try {
      child.kill('SIGTERM')
    } catch (err) {
      console.error('[caogen] Gemini interrupt 失败:', err)
    }
    this.emit({
      kind: 'turn-result',
      subtype: 'interrupted',
      isError: false,
      durationMs: this.turnStartedAt ? Date.now() - this.turnStartedAt : undefined
    })
    this.setStatus('idle')
  }

  // Gemini CLI(非交互单发)无 CaoGen 的逐工具权限协议:无待决权限,
  // respondPermission 为 no-op,pendingPermissions 恒空。
  respondPermission(_requestId: string, _allow: boolean, _message?: string): void {
    // 无权限队列,忽略。
  }

  pendingPermissions(): PermissionRequestInfo[] {
    return []
  }

  getTranscript(): TranscriptEntry[] {
    return this.transcript.read()
  }

  /** Gemini CLI 无等价权限模式;仅记录到 meta 以对齐 UI。 */
  async setPermissionMode(mode: PermissionModeId): Promise<void> {
    this.meta.permissionMode = mode
    this.emit({ kind: 'meta', meta: { ...this.meta } })
  }

  /** 模型在下一轮 runTurn 的 -m 参数生效;当前轮不热切换。 */
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
    this.generation++
    if (this.turnTimer) {
      clearTimeout(this.turnTimer)
      this.turnTimer = null
    }
    if (this.child) {
      try {
        this.child.kill('SIGTERM')
      } catch {
        // 进程可能已退出
      }
      this.child = null
    }
    this.setStatus('closed')
  }

  private emitUserMessage(text: string): string {
    const messageId = randomUUID()
    this.emit({ kind: 'user-message', text, messageId })
    return messageId
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

/**
 * GeminiEngine 工厂。available() 探测本机 CLI 是否安装。
 * 注意:engines.ts 目前用占位工厂(available 恒 false)。要启用本实现,
 * 见文件顶部说明与 wiringSpec:把占位替换为此工厂即可。
 */
export const geminiEngineFactory: EngineFactory = {
  kind: 'gemini',
  label: `Gemini CLI${geminiCliAvailable() ? '(实验性)' : '(未安装)'}`,
  available: () => geminiCliAvailable(),
  create: (meta: SessionMeta, emit: EngineEmit, resumeSdkSessionId?: string): Engine =>
    new GeminiEngine(meta, emit, resumeSdkSessionId)
}



