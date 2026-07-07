import { spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import { TranscriptWriter } from './transcript'
import { getProvider, decryptToken } from './providers'
import { AUTO_MODEL } from '../shared/types'
import type { Engine } from './engine'
import type {
  AgentEvent,
  AssistantBlock,
  PermissionModeId,
  PermissionRequestInfo,
  SendMessagePayload,
  SessionMeta,
  TranscriptEntry,
  UsageTotals
} from '../shared/types'

type CodexChildProcess = ChildProcessByStdio<null, Readable, Readable>

/**
 * M6 · CodexEngine —— Codex CLI 引擎适配器(实验性 / EXPERIMENTAL)。
 *
 * 用 child_process 逐轮 spawn `codex exec` 非交互子进程,把 CLI 的 stdout
 * 尽力翻译成项目的 AgentEvent(status / assistant-message / turn-result,
 * 以及可得时的 text-delta / tool-start / tool-result)。
 *
 * 设计取舍:
 * - Claude 引擎是"一个常驻 query 流式吃多轮";Codex CLI 的 `exec` 子命令是
 *   一次性非交互执行,故本适配器改为"每轮 send() 起一个子进程"模型。会话上
 *   下文延续依赖 Codex 自身(--continue / 会话文件),超出骨架范围,标注为实验性。
 * - stdout 优先按 JSONL(每行一个 JSON 事件)解析;无法解析的行退化为纯文本
 *   增量(text-delta),整轮文本在 turn-result 前汇成一条 assistant-message。
 * - 权限:Codex CLI 自带审批,本适配器不接入 CaoGen 的权限往返;
 *   pendingPermissions() 恒为空,respondPermission() 为 no-op。
 *
 * 未实现(占位返回安全值):检查点回退(rewindFiles / restoreCheckpoint 不提供)。
 */
export class CodexEngine implements Engine {
  readonly meta: SessionMeta
  private readonly transcript: TranscriptWriter
  private readonly emitRaw: (event: AgentEvent) => void
  private disposed = false
  /** 当前在跑的子进程(每轮一个);null 表示空闲 */
  private child: CodexChildProcess | null = null
  private turnStartedAt = 0
  /** 用户主动中断标记:中断导致的非零退出不算错误轮次 */
  private interrupting = false
  /** 本轮累积的助手文本(汇成一条 assistant-message 落盘) */
  private assistantText = ''
  /** turn.completed 上报的 token 用量(实测 schema) */
  private turnUsage?: UsageTotals
  /** stdout 行缓冲,跨 data chunk 拼接 */
  private stdoutBuf = ''
  private stderrBuf = ''

  constructor(
    meta: SessionMeta,
    emit: (event: AgentEvent, seq: number) => void,
    resumeSdkSessionId?: string
  ) {
    this.meta = meta
    this.transcript = new TranscriptWriter(resumeSdkSessionId)
    this.emitRaw = (event) => emit(event, this.transcript.next(event))
    if (resumeSdkSessionId) {
      this.meta.sdkSessionId = resumeSdkSessionId
      this.emit({ kind: 'init', sdkSessionId: resumeSdkSessionId })
    }
  }

  async start(): Promise<void> {
    if (this.disposed) return
    this.setStatus('starting')
    const ok = await probeCodex()
    if (!ok) {
      this.setStatus(
        'error',
        '未安装 codex:请先安装 Codex CLI 并确保它在 PATH 上(实验性引擎)。'
      )
      return
    }
    // 无常驻进程可起;Codex 每轮 exec 一次。生成一个本地会话 id 供转录归档。
    if (!this.meta.sdkSessionId) {
      this.meta.sdkSessionId = `codex-${randomUUID()}`
      this.emit({ kind: 'init', sdkSessionId: this.meta.sdkSessionId })
    }
    this.setStatus('idle')
  }

  send(input: string | SendMessagePayload): void {
    if (this.disposed) return
    const text = normalizeText(input)
    if (!text) return
    if (this.child) {
      // Codex exec 一次一轮;轮次进行中拒绝并发送
      this.setStatus('error', '上一轮尚未结束,Codex 引擎暂不支持并发轮次。')
      return
    }
    if (this.meta.status === 'closed') {
      this.setStatus('error', '会话已结束,无法发送消息。')
      return
    }

    const messageId = randomUUID()
    this.emit({ kind: 'user-message', text, messageId })
    if (this.meta.title === '新会话' && text.trim()) {
      this.meta.title = text.trim().replace(/\s+/g, ' ').slice(0, 40)
      this.emit({ kind: 'meta', meta: { ...this.meta } })
    }

    this.setStatus('running')
    this.turnStartedAt = Date.now()
    this.assistantText = ''
    this.stdoutBuf = ''
    this.stderrBuf = ''
    this.spawnTurn(text)
  }

  rejectSend(message: string): void {
    this.setStatus('error', message)
  }

  private spawnTurn(prompt: string): void {
    // --skip-git-repo-check:codex exec 默认拒绝在非 git 目录运行;
    // CaoGen 自己管权限与 worktree 隔离,不需要 CLI 这层限制(实测必需)。
    const args = ['exec', '--json', '--skip-git-repo-check']
    // 'auto' 是 CaoGen 调度哨兵,不透传给 CLI
    if (this.meta.model && this.meta.model !== AUTO_MODEL) {
      args.push('--model', this.meta.model)
    }
    args.push(prompt)

    let child: CodexChildProcess
    try {
      child = spawn('codex', args, {
        cwd: this.meta.cwd,
        env: this.buildEnv(),
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      this.finishTurn(true, errText(err))
      return
    }
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr.on('data', (chunk: string) => {
      this.stderrBuf += chunk
    })
    child.on('error', (err) => {
      if (this.disposed) return
      this.finishTurn(true, errText(err))
    })
    child.on('close', (code, signal) => {
      if (this.disposed) return
      // flush 残余未换行的 stdout
      if (this.stdoutBuf.trim()) {
        this.handleLine(this.stdoutBuf)
        this.stdoutBuf = ''
      }
      const interrupted = this.interrupting
      this.interrupting = false
      if (interrupted) {
        this.finishTurn(true, '已中断', 'interrupted')
        return
      }
      const isError = typeof code === 'number' ? code !== 0 : signal != null
      const errMsg = isError
        ? this.stderrBuf.trim() || `codex 退出码 ${code ?? signal}`
        : undefined
      this.finishTurn(isError, errMsg)
    })
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk
    let idx: number
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx)
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1)
      if (line.trim()) this.handleLine(line)
    }
  }

  /**
   * 尽力翻译一行 CLI 输出。优先解析 JSON 事件;识别常见形状后发对应 AgentEvent。
   * 无法解析的整行退化为文本增量,保证不丢内容。Codex 的确切 schema 可能演进,
   * 故对字段做防御式探测而非硬绑定。
   */
  private handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // 非 JSON:当作纯文本增量
      this.appendText(line + '\n')
      return
    }
    if (!parsed || typeof parsed !== 'object') {
      this.appendText(line + '\n')
      return
    }
    const evt = parsed as Record<string, unknown>
    const type = typeof evt.type === 'string' ? evt.type : ''

    // 实测 schema(codex-cli 0.142):{type:'item.completed', item:{type, text, id}}
    // item.type: agent_message=正文 / reasoning=思考 / command_execution 等=工具
    if (type === 'item.completed' && evt.item && typeof evt.item === 'object') {
      const item = evt.item as Record<string, unknown>
      const itemType = typeof item.type === 'string' ? item.type : ''
      const itemText = typeof item.text === 'string' ? item.text : ''
      if (itemType === 'agent_message' && itemText) {
        this.emit({ kind: 'text-delta', text: itemText })
        this.assistantText += itemText
        return
      }
      if (itemType === 'reasoning' && itemText) {
        this.emit({ kind: 'thinking-delta', text: itemText })
        return
      }
      if (/command|tool|exec|patch|file/i.test(itemType)) {
        const toolUseId = typeof item.id === 'string' ? item.id : randomUUID()
        const name =
          (typeof item.command === 'string' && item.command) ||
          (typeof item.name === 'string' && item.name) ||
          itemType
        this.emit({ kind: 'tool-start', toolUseId, name })
        const output =
          (typeof item.aggregated_output === 'string' && item.aggregated_output) ||
          (typeof item.output === 'string' && item.output) ||
          itemText
        if (output) {
          this.emit({
            kind: 'tool-result',
            toolUseId,
            content: output.slice(0, 20_000),
            isError: item.status === 'failed'
          })
        }
        return
      }
      return // 其余 item(如 todo_list)静默
    }

    // 实测 schema:{type:'turn.completed', usage:{input_tokens, cached_input_tokens, output_tokens}}
    if (type === 'turn.completed' && evt.usage && typeof evt.usage === 'object') {
      const u = evt.usage as Record<string, unknown>
      const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
      this.turnUsage = {
        input: n(u.input_tokens),
        output: n(u.output_tokens),
        cacheRead: n(u.cached_input_tokens),
        cacheCreation: 0
      }
      return
    }

    // 助手文本增量:兼容 {type:'message'|'assistant', text|delta|content}(旧 schema 防御)
    const textPiece = extractText(evt)
    if (textPiece) {
      this.emit({ kind: 'text-delta', text: textPiece })
      this.assistantText += textPiece
      return
    }

    // 工具/命令调用:兼容 {type:'tool_use'|'command'|'exec', name|command}
    if (/tool|command|exec|function/i.test(type)) {
      const toolUseId = typeof evt.id === 'string' ? evt.id : randomUUID()
      const name =
        (typeof evt.name === 'string' && evt.name) ||
        (typeof evt.command === 'string' && evt.command) ||
        (typeof evt.tool === 'string' && evt.tool) ||
        'command'
      this.emit({ kind: 'tool-start', toolUseId, name })
      const output = extractToolOutput(evt)
      if (output) {
        this.emit({ kind: 'tool-result', toolUseId, content: output, isError: false })
      }
      return
    }

    // 无从识别:JSON 里若有 message 字段就当文本,否则忽略(状态噪声)
    if (typeof evt.message === 'string' && evt.message) {
      this.appendText(evt.message + '\n')
    }
  }

  private appendText(text: string): void {
    this.emit({ kind: 'text-delta', text })
    this.assistantText += text
  }

  private finishTurn(isError: boolean, errorText?: string, subtype = 'success'): void {
    const child = this.child
    this.child = null
    if (child) {
      child.stdout.removeAllListeners()
      child.stderr.removeAllListeners()
      child.removeAllListeners()
    }

    const text = this.assistantText.trim()
    if (text) {
      const blocks: AssistantBlock[] = [{ type: 'text', text }]
      this.emit({ kind: 'assistant-message', blocks })
    }
    const durationMs = this.turnStartedAt ? Date.now() - this.turnStartedAt : undefined
    this.emit({
      kind: 'turn-result',
      subtype: isError ? (subtype === 'success' ? 'error' : subtype) : 'success',
      isError,
      durationMs,
      usage: this.turnUsage,
      resultText: isError ? errorText : text || undefined
    })
    this.turnUsage = undefined
    if (isError && errorText) {
      this.setStatus('error', errorText)
    } else {
      this.setStatus('idle')
    }
  }

  async interrupt(): Promise<void> {
    if (!this.child) return
    this.interrupting = true
    try {
      this.child.kill('SIGTERM')
    } catch (err) {
      console.error('[caogen] codex interrupt 失败:', err)
    }
  }

  // Codex CLI 自带审批,不接入 CaoGen 的权限往返。
  respondPermission(): void {
    // no-op:本引擎不产生权限请求
  }

  pendingPermissions(): PermissionRequestInfo[] {
    return []
  }

  getTranscript(): TranscriptEntry[] {
    return this.transcript.read()
  }

  emitSyntheticEvent(event: AgentEvent): void {
    if (this.disposed) return
    this.emit(event)
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

  /**
   * 组装子进程 env:以 process.env 为基,若绑定了 Provider,尽力注入常见的
   * OpenAI 兼容覆写(OPENAI_BASE_URL / OPENAI_API_KEY)。Codex 具体读哪些变量
   * 取决于其版本,这里做最大努力,不保证生效。
   */
  private buildEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    if (!this.meta.providerId) return env
    const provider = getProvider(this.meta.providerId)
    if (!provider) return env
    if (provider.baseUrl) env.OPENAI_BASE_URL = provider.baseUrl
    const token = decryptToken(provider.encryptedToken)
    if (token) env.OPENAI_API_KEY = token
    return env
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

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function normalizeText(input: string | SendMessagePayload): string {
  if (typeof input === 'string') return input.trim()
  return typeof input.text === 'string' ? input.text.trim() : ''
}

/** 从 CLI JSON 事件里尽力抽出助手文本(兼容多种字段命名) */
function extractText(evt: Record<string, unknown>): string {
  if (typeof evt.delta === 'string') return evt.delta
  if (typeof evt.text === 'string') return evt.text
  const content = evt.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const b = c as Record<string, unknown> | null
        return b && typeof b.text === 'string' ? b.text : ''
      })
      .join('')
  }
  return ''
}

/** 从工具/命令事件里尽力抽出输出文本 */
function extractToolOutput(evt: Record<string, unknown>): string {
  if (typeof evt.output === 'string') return evt.output
  if (typeof evt.result === 'string') return evt.result
  if (typeof evt.stdout === 'string') return evt.stdout
  return ''
}

/**
 * 探测 codex CLI 是否可用:spawn `codex --version`,退出码 0 视为可用。
 * 3s 超时;spawn 失败(ENOENT 等)视为未安装。
 */
function probeCodex(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    try {
      const child = spawn('codex', ['--version'], { stdio: 'ignore' })
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore
        }
        done(false)
      }, 3000)
      child.on('error', () => {
        clearTimeout(timer)
        done(false)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        done(code === 0)
      })
    } catch {
      done(false)
    }
  })
}
