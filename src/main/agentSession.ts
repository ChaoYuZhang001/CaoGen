import { randomUUID } from 'node:crypto'
import { app, powerSaveBlocker } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import type { PermissionResult, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources'
import { Pushable } from './pushable'
import { TranscriptWriter } from './transcript'
import { getProvider, decryptToken, listProviders } from './providers'
import { listHistory } from './history'
import { readReferencedFiles } from './fileSuggest'
import { buildMemorySystemAppend } from './memoryInject'
import { buildLayeredMemoryPrompt } from './memory/memory-retriever'
import { buildSkillInvocationPrompt } from './skill/skill-invocation'
import { buildIdeDocumentContextPrompt } from './ide/ide-document-context'
import {
  buildProjectContextSystemAppend,
  buildProjectContextSystemAppendSync
} from './agent/context-loader'
import { evaluateContextUsage } from './agent/context-compressor'
import { loadSdkAgentDefinitions } from './sdkAgents'
import { imageToContentBlock } from './attachmentOps'
import { latestUserTextUuid } from './checkpoints'
import { recordModelFailure, recordModelSuccess } from './modelStats'
import { resolveSessionModelRoute } from './model/session-routing'
import { calculateMonthlyBudgetSnapshot } from './model/monthly-budget'
import { writeAuditLog } from './permission/audit-log'
import { evaluateToolPermission } from './permission/tool-permission'
import {
  decideGuiPermission,
  GUI_TEMPORARY_GRANT_MESSAGE,
  grantTemporaryGuiAutomation
} from './permission/permission-manager'
import {
  pickModelAcrossProviders,
  recordSuccess,
  recordFailure,
  classifyFailure,
  pickFailoverTarget,
  DEFAULT_AUTO_CANDIDATES
} from './scheduler'
import type { FailoverCandidate } from './scheduler'
import { getSettings } from './settings'
import { AUTO_MODEL } from '../shared/types'
import type { Engine } from './engine'
import type {
  AgentEvent,
  AssistantBlock,
  CheckpointRestoreMode,
  CheckpointRestoreResult,
  EngineKind,
  ImageAttachmentView,
  PermissionModeId,
  PermissionRequestInfo,
  RewindResult,
  SdkAgentInfo,
  SendMessagePayload,
  SessionMeta,
  UserMessageAttachmentView,
  UsageTotals
} from '../shared/types'

type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')

let sdkPromise: Promise<SdkModule> | undefined

/** SDK 为 ESM-only,主进程按 CJS 构建,故用动态 import 惰性加载。 */
function loadSdk(): Promise<SdkModule> {
  sdkPromise ??= import('@anthropic-ai/claude-agent-sdk')
  return sdkPromise
}

/**
 * 打包(asar)后 SDK 自动算出的 CLI 二进制路径会穿过 app.asar(文件非目录),
 * spawn 报 ENOTDIR。显式指向解包后的原生二进制修复。dev 下返回 undefined 走默认。
 */
let cachedExecPath: string | null | undefined
function claudeExecutablePath(): string | undefined {
  if (cachedExecPath !== undefined) return cachedExecPath ?? undefined
  if (!app.isPackaged) {
    cachedExecPath = null
    return undefined
  }
  const pkg = `claude-agent-sdk-${process.platform}-${process.arch}`
  const bin = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const p = join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai',
    pkg,
    bin
  )
  cachedExecPath = existsSync(p) ? p : null
  if (!cachedExecPath) console.error('[caogen] 未找到打包后的 claude 二进制:', p)
  return cachedExecPath ?? undefined
}

const TOOL_RESULT_MAX_CHARS = 20_000

interface NormalizedSendPayload {
  text: string
  images: ImageAttachmentView[]
}

interface PendingPermission {
  resolve: (result: PermissionResult) => void
  input: Record<string, unknown>
  info: PermissionRequestInfo
}

const CLAUDE_READ_TOOLS = new Set(['Read', 'LS', 'Glob', 'Grep', 'WebFetch'])
const CLAUDE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const CLAUDE_HOST_MUTATION_TOOLS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

function normalizeClaudeToolName(toolName: string): string {
  if (toolName === 'Bash') return 'bash'
  if (toolName === 'Read') return 'read_file'
  if (toolName === 'LS') return 'list_dir'
  if (toolName === 'Grep') return 'search_code'
  if (toolName === 'Glob') return 'find_file'
  if (toolName === 'Write') return 'write_file'
  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') return 'edit_file'
  return toolName
}

function normalizeClaudeToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...input }
  const pathValue = normalized.path ?? normalized.file_path ?? normalized.notebook_path
  if (typeof pathValue === 'string' && pathValue.trim()) {
    normalized.path = pathValue
    normalized.file_path = pathValue
  }
  if (toolName === 'Glob' && typeof normalized.pattern === 'string') normalized.path = normalized.path ?? '.'
  return normalized
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 是否存在"真实" Claude 登录凭据。只认三者之一:
 * ANTHROPIC_API_KEY 环境变量 / 存在的 host-creds 文件 / ~/.claude/.credentials.json。
 * 注意:~/.claude.json 是配置文件(人人都有,不含 token),绝不能当凭据。
 */
function hasRealClaudeAuth(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true
  const hostCreds = process.env.CLAUDE_CODE_HOST_CREDS_FILE
  if (hostCreds && existsSync(hostCreds)) return true
  try {
    return existsSync(join(homedir(), '.claude', '.credentials.json'))
  } catch {
    return false
  }
}

function normalizeBudget(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 把多行/逗号分隔的工具清单拆成数组 */
function splitList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 从消息文本提取 @文件引用(路径:字母数字 / . _ - 及分隔符) */
function extractMentions(text: string): string[] {
  const out: string[] = []
  const re = /@([A-Za-z0-9._\-/\\]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const p = m[1].replace(/[.,;:)]+$/, '') // 去掉尾随标点
    if (p) out.push(p)
  }
  return out
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

function normalizeSendPayload(input: string | SendMessagePayload): NormalizedSendPayload {
  if (typeof input === 'string') return { text: input.trim(), images: [] }
  return {
    text: typeof input.text === 'string' ? input.text.trim() : '',
    images: Array.isArray(input.images) ? input.images.filter(isImageAttachmentView) : []
  }
}

function isImageAttachmentView(value: unknown): value is ImageAttachmentView {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.hash === 'string' &&
    typeof record.path === 'string' &&
    typeof record.mime === 'string' &&
    typeof record.bytes === 'number' &&
    Number.isFinite(record.bytes) &&
    typeof record.createdAt === 'string'
  )
}

function userMessageText(payload: NormalizedSendPayload): string {
  if (payload.text) return payload.text
  return payload.images.length > 0 ? `图片输入 (${payload.images.length} 张)` : ''
}

function compactUserAttachments(images: ImageAttachmentView[]): UserMessageAttachmentView[] | undefined {
  if (images.length === 0) return undefined
  return images.map((image) => ({ id: image.id, mime: image.mime, bytes: image.bytes }))
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
 * M6 起实现 Engine 接口(即"ClaudeEngine"),经 engines.ts 注册为默认引擎。
 */
export class AgentSession implements Engine {
  readonly meta: SessionMeta
  private input = new Pushable<SDKUserMessage>()
  private query: Query | null = null
  private readonly pending = new Map<string, PendingPermission>()
  private readonly emitRaw: (event: AgentEvent) => void
  private readonly transcript: TranscriptWriter
  /** 下次 start() 要恢复的 SDK 会话;故障切换重启时指向当前 sdkSessionId */
  private resumeId?: string
  /** chat/both 回退后的 SDK resume 截断点;与 resumeId 一起传给 SDK。 */
  private resumeAtId?: string
  /** start() 时的 Provider 环境指纹;send 时若已变(如后填 key)则重建引擎 */
  private envFingerprint = ''
  /** SDK 子进程 stderr 尾部(诊断用:超时/崩溃时附到错误信息) */
  private stderrTail = ''
  /** auto 模式本轮路由选中的真实模型名(供结束时记模型实测统计) */
  private lastRoutedModel = ''
  /** 最近注入到 Claude SDK 的项目上下文;保存 caogen.md 后下一轮消息会补充差异快照。 */
  private lastProjectContextAppend = ''
  private disposed = false
  private turnStartedAt = 0
  /** 引擎代数:每次(重)启动 +1,旧 consume 循环据此失效,避免误报状态 */
  private generation = 0
  /** 本轮用户消息原文,故障切换后重发 */
  /** 本轮完整用户 payload,故障切换后重发(含图片)。 */
  private lastUserPayload: NormalizedSendPayload | null = null
  /** 上次发过检查点的用户消息 uuid,去重避免同轮重复发 */
  private lastCheckpointUuid = ''
  /** 等待绑定 SDK checkpoint uuid 的本地用户消息 id 队列。 */
  private pendingCheckpointUserMessageIds: string[] = []
  /** 本轮已尝试过的 Provider(含起始),切换时排除,防止打转 */
  private triedProviders = new Set<string>()
  private failoverBusy = false
  /** 故障切换窗口期(旧引擎已死、新引擎未起)收到的消息,切换完成后补推 */
  private queuedDuringFailover: NormalizedSendPayload[] = []
  /** 用户主动中断标记:中断产生的错误 result 不触发故障切换 */
  private interrupting = false
  /** 本会话在轮次运行中持有的系统防休眠句柄。 */
  private powerBlockerId: number | null = null
  private lastContextPressure: NonNullable<SessionMeta['contextPressure']> = 'normal'

  constructor(meta: SessionMeta, emit: (event: AgentEvent, seq: number) => void, resumeSdkSessionId?: string) {
    this.meta = meta
    this.transcript = new TranscriptWriter(resumeSdkSessionId)
    this.emitRaw = (event) => emit(event, this.transcript.next(event))
    this.resumeId = resumeSdkSessionId
    this.resumeAtId = meta.resumeSessionAt
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
    const token = decryptToken(provider.encryptedToken)
    // 只有在我们真能注入替代凭据时,才剥离 host 托管鉴权 —— 否则(选了 Provider
    // 但没配 key)既没了 host 登录、又没有自己的 token,SDK 子进程零凭据挂起。
    // 这是"Claude 引擎默认挂 DeepSeek 但没填 key → 真对话超时"的根因。
    if (token || provider.baseUrl) {
      delete env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
      delete env.CLAUDE_CODE_HOST_CREDS_FILE
      delete env.CLAUDE_CODE_HOST_AUTH_ENV_VAR
      delete env.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH
      delete env.CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH
    }
    if (provider.baseUrl) env.ANTHROPIC_BASE_URL = provider.baseUrl
    if (token) {
      env.ANTHROPIC_AUTH_TOKEN = token
      // 兼容以 API key 方式鉴权的网关;两者择一即可,一并覆写避免旧值干扰
      env.ANTHROPIC_API_KEY = token
    }
    // 网关专用请求头(每行 "Name: value"),SDK 读 ANTHROPIC_CUSTOM_HEADERS
    if (provider.customHeaders && provider.customHeaders.trim()) {
      env.ANTHROPIC_CUSTOM_HEADERS = provider.customHeaders
    }
    return env
  }

  /**
   * SDK Hooks 桥(M12/P4.15):
   * - PostToolUse(Edit/Write/MultiEdit 成功后):发 hook-event 到时间线;
   *   若用户配置了 hookPostEditCommand,在会话 cwd 执行并回报输出。
   * - Stop(每轮结束):同上,对应 hookTurnEndCommand。
   * 设计取舍:钩子失败绝不打断会话(catch-all);shell 输出截断 2000 字;
   * 60s 超时防挂起。钩子仅在 Claude 引擎生效(SDK 能力)。
   */
  private buildHooks(settings: ReturnType<typeof getSettings>): Record<string, Array<{ matcher?: string; hooks: Array<(input: unknown) => Promise<Record<string, unknown>>> }>> {
    const postEditCmd = (settings.hookPostEditCommand ?? '').trim()
    const turnEndCmd = (settings.hookTurnEndCommand ?? '').trim()

    const runShellHook = async (command: string, eventLabel: string, toolName?: string): Promise<void> => {
      if (!command) return
      try {
        const { execFile } = await import('node:child_process')
        const output = await new Promise<{ ok: boolean; out: string }>((resolve) => {
          execFile(
            process.platform === 'win32' ? 'cmd' : '/bin/sh',
            process.platform === 'win32' ? ['/c', command] : ['-c', command],
            { cwd: this.meta.cwd, timeout: 60_000, maxBuffer: 512 * 1024 },
            (err, stdout, stderr) => {
              const out = `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`.trim().slice(0, 2000)
              resolve({ ok: !err, out })
            }
          )
        })
        this.emit({
          kind: 'hook-event',
          event: eventLabel,
          toolName,
          shellCommand: command,
          shellOk: output.ok,
          shellOutput: output.out
        })
      } catch (err) {
        this.emit({
          kind: 'hook-event',
          event: eventLabel,
          toolName,
          shellCommand: command,
          shellOk: false,
          shellOutput: errText(err)
        })
      }
    }

    return {
      PostToolUse: [
        {
          matcher: 'Edit|Write|MultiEdit|NotebookEdit',
          hooks: [
            async (input: unknown): Promise<Record<string, unknown>> => {
              const record = (input ?? {}) as Record<string, unknown>
              const toolName = typeof record.tool_name === 'string' ? record.tool_name : undefined
              if (postEditCmd) {
                void runShellHook(postEditCmd, 'post-edit', toolName)
              } else {
                this.emit({ kind: 'hook-event', event: 'post-edit', toolName })
              }
              return { continue: true }
            }
          ]
        }
      ],
      Stop: [
        {
          hooks: [
            async (): Promise<Record<string, unknown>> => {
              if (turnEndCmd) void runShellHook(turnEndCmd, 'turn-end')
              return { continue: true }
            }
          ]
        }
      ]
    }
  }

  async start(): Promise<void> {
    if (this.disposed) return
    const gen = ++this.generation
    this.setStatus('starting')
    this.envFingerprint = this.providerEnvFingerprint()
    try {
      const sdk = await loadSdk()
      const settings = getSettings()
      const persona = settings.persona.trim()
      const allowed = splitList(settings.allowedTools)
      const disallowed = splitList(settings.disallowedTools)
      const execPath = claudeExecutablePath()
      let projectContextAppend = ''
      try {
        projectContextAppend = await buildProjectContextSystemAppend(this.meta.sourceCwd ?? this.meta.cwd)
        this.lastProjectContextAppend = projectContextAppend
      } catch (err) {
        console.error('[caogen] 读取 caogen.md 项目上下文失败:', err)
      }
      // 项目记忆:把已确认条目注入 systemPrompt(与人设合并为统一 append)
      let memoryAppend = ''
      try {
        memoryAppend = await buildMemorySystemAppend(
          this.meta.sourceCwd ?? this.meta.cwd,
          join(app.getPath('userData'), 'memory')
        )
      } catch (err) {
        console.error('[caogen] 读取项目记忆失败:', err)
      }
      const append = [projectContextAppend, persona, memoryAppend].filter((s) => s && s.trim()).join('\n\n')
      const sdkAgents = settings.sdkAgentsEnabled
        ? loadSdkAgentDefinitions(this.meta.sourceCwd ?? this.meta.cwd)
        : undefined
      if (sdkAgents?.diagnostics.length) {
        console.error('[caogen] SDK agents 加载诊断:', sdkAgents.diagnostics.join('\n'))
      }
      this.query = sdk.query({
        prompt: this.input,
        options: {
          cwd: this.meta.cwd,
          permissionMode: this.meta.permissionMode,
          includePartialMessages: true,
          enableFileCheckpointing: true,
          env: this.buildEnv(),
          ...(execPath ? { pathToClaudeCodeExecutable: execPath } : {}),
          // 人设 + 项目记忆:preset 之上追加
          systemPrompt: append
            ? { type: 'preset', preset: 'claude_code', append }
            : { type: 'preset', preset: 'claude_code' },
          // 权限:工具白/黑名单
          ...(allowed.length > 0 ? { allowedTools: allowed } : {}),
          ...(disallowed.length > 0 ? { disallowedTools: disallowed } : {}),
          // 'auto' 是调度哨兵而非真实模型名,不传给 SDK;每轮再 setModel
          ...(this.meta.model && this.meta.model !== AUTO_MODEL ? { model: this.meta.model } : {}),
          ...(this.resumeId ? { resume: this.resumeId } : {}),
          ...(this.resumeId && this.resumeAtId ? { resumeSessionAt: this.resumeAtId } : {}),
          ...(sdkAgents && Object.keys(sdkAgents.agents).length > 0 ? { agents: sdkAgents.agents } : {}),
          // Hooks 桥:PostToolUse(文件写入后)+ Stop(轮结束),转发到时间线并可执行用户 shell 钩子
          hooks: this.buildHooks(settings),
          // 诊断:捕获 SDK 子进程 stderr 尾部,超时/崩溃时附到错误信息(否则用户只见"无响应")
          stderr: (data: string) => {
            this.stderrTail = `${this.stderrTail}${data}`.slice(-4000)
            if (data.trim()) console.error('[caogen][claude-sdk stderr]', data.trim().slice(0, 500))
          },
          canUseTool: (toolName, input, opts) => this.requestPermission(toolName, input, opts)
        }
      })
    } catch (err) {
      this.setStatus('error', errText(err))
      return
    }
    void this.consume(gen)
  }

  send(input: string | SendMessagePayload): void {
    if (this.disposed) return
    const payload = normalizeSendPayload(input)
    const displayText = userMessageText(payload)
    if (!displayText && payload.images.length === 0) return
    const authError = this.providerAuthError()
    if (authError) {
      this.setStatus('error', authError)
      return
    }
    // 故障切换窗口期(旧引擎已死、新引擎未起):先入队,切换完成后补推
    if (this.failoverBusy) {
      this.emitUserMessage(displayText, payload.images)
      this.queuedDuringFailover.push(payload)
      return
    }
    // query 创建前 Pushable 已可排队;仅已失败/已关闭时拒绝,避免初始任务竞态丢失。
    if (this.meta.status === 'closed') {
      this.setStatus('error', '会话已结束,无法发送消息。请新建会话或从历史恢复。')
      return
    }
    this.emitUserMessage(displayText, payload.images)
    if (this.meta.title === '新会话' && displayText.trim()) {
      this.meta.title = displayText.trim().replace(/\s+/g, ' ').slice(0, 40)
      this.emit({ kind: 'meta', meta: { ...this.meta } })
    }
    this.setStatus('running')
    this.turnStartedAt = Date.now()
    // 新一轮:重置故障切换尝试记录(仅在本轮内防打转)
    this.lastUserPayload = payload
    this.triedProviders = new Set([this.meta.providerId])
    // Provider 凭据在会话启动后变了(典型:先建会话后填 key)→ 旧 query 的
    // env 已过期,SDK 会一直报 "Not logged in"。重建引擎再推,填 key 即生效。
    if (this.query && !this.failoverBusy && this.envFingerprint !== this.providerEnvFingerprint()) {
      void this.rebuildEngineThenPush(payload)
      return
    }
    // 自动调度:挑模型 → setModel → 透明事件,完成后再推消息保证顺序
    if (this.meta.model === AUTO_MODEL) {
      void this.autoRouteThenPush(payload)
    } else {
      void this.pushUserMessage(payload)
    }
  }

  /** Provider 环境指纹:providerId + 是否有 token + baseUrl + 自定义头 */
  private providerEnvFingerprint(): string {
    const provider = this.meta.providerId ? getProvider(this.meta.providerId) : undefined
    if (!provider) return `none:${this.meta.providerId ?? ''}`
    return [
      provider.id,
      decryptToken(provider.encryptedToken) ? 'token' : 'no-token',
      provider.baseUrl,
      provider.customHeaders ?? ''
    ].join('|')
  }

  /** 引擎重建核心:作废旧代 → 关旧 query → 以 resume 延续上下文重启 */
  private async rebuildEngine(): Promise<void> {
    this.generation++
    for (const [requestId, pending] of this.pending) {
      pending.resolve({ behavior: 'deny', message: '引擎重建,操作作废' })
      this.emit({ kind: 'permission-resolved', requestId, behavior: 'deny' })
    }
    this.pending.clear()
    this.input.end()
    try {
      this.query?.close()
    } catch {
      // 进程可能已退出
    }
    this.query = null
    this.input = new Pushable<SDKUserMessage>()
    this.resumeId = this.meta.sdkSessionId || this.resumeId
    await this.start()
  }

  /** 凭据变更后的引擎重建:重建 → 推本轮消息(auto 模式先路由) */
  private async rebuildEngineThenPush(payload: NormalizedSendPayload): Promise<void> {
    this.failoverBusy = true
    try {
      await this.rebuildEngine()
      if (!this.query) return // start 失败已置 error
      this.setStatus('running')
      if (this.meta.model === AUTO_MODEL) {
        void this.autoRouteThenPush(payload)
      } else {
        void this.pushUserMessage(payload)
      }
    } catch (err) {
      this.setStatus('error', errText(err))
    } finally {
      this.failoverBusy = false
    }
  }

  private providerAuthError(): string | null {
    if (!this.meta.providerId) return null
    const provider = getProvider(this.meta.providerId)
    if (!provider) return `Provider 不存在:${this.meta.providerId}`
    if (decryptToken(provider.encryptedToken)) return null
    // 空 baseUrl 且无 token = 官方 Anthropic 预设:需要真实宿主登录态才放行。
    // 只认"真实凭据":API key / 存在的 host-creds 文件 / .credentials.json。
    // ~/.claude.json 是配置文件不算凭据(外部验收踩坑:误判致中途 Not logged in)。
    if (!provider.baseUrl.trim()) {
      if (this.meta.engine !== 'claude') return null // 非 Claude 引擎不走 Anthropic 登录
      if (hasRealClaudeAuth()) return null
      return '未检测到 Claude 登录态:请运行 claude 登录、设置 ANTHROPIC_API_KEY,或改用已配 key 的 Provider'
    }
    return `请在设置里填写 ${provider.name} API key 后再开始对话`
  }

  rejectSend(message: string): void {
    this.setStatus('error', message)
  }

  /**
   * 跨厂商智能路由(auto 模式):在所有健康厂商 × 各自模型全集里挑最优,
   * 不局限于会话当前厂商。选中别家时切 providerId 并重建引擎
   * (resume 延续上下文),路由决策以 routing 事件透明呈现。
   */
  private async autoRouteThenPush(payload: NormalizedSendPayload): Promise<void> {
    try {
      const strategy = getSettings().schedulerStrategy
      const settings = getSettings()
      if (settings.smartModelRoutingEnabled) {
        const monthlyBudget = calculateMonthlyBudgetSnapshot({
          settings,
          history: listHistory(),
          currentSession: this.meta
        })
        const smart = resolveSessionModelRoute({
          enabled: true,
          currentModel: this.meta.model,
          providerId: this.meta.providerId,
          providers: listProviders(),
          engine: this.meta.engine,
          payload,
          strategy: settings.schedulerStrategy,
          sessionCostUsd: this.meta.costUsd,
          sessionBudgetUsd: this.meta.budgetUsd,
          settingsBudgetUsd: settings.budgetUsdPerSession,
          monthlyBudgetRemainingUsd: monthlyBudget.remainingUsd
        })
        if (smart.kind === 'routed') {
          this.lastRoutedModel = smart.model
          this.emit({
            kind: 'routing',
            model: smart.model,
            reason: smart.reason,
            providerId: smart.providerId,
            crossValidationPlan: smart.crossValidationPlan
          })
          if (smart.switchedProvider) {
            this.meta.providerId = smart.providerId
            this.emit({ kind: 'meta', meta: { ...this.meta } })
            await this.rebuildEngine()
            if (!this.query) return
            this.setStatus('running')
            await this.query.setModel(smart.model)
            await this.pushUserMessage(payload)
            return
          }
          await this.query?.setModel(smart.model)
          await this.pushUserMessage(payload)
          return
        }
      }
      const decision = pickModelAcrossProviders({
        candidates: this.failoverCandidates(),
        text: userMessageText(payload),
        strategy,
        currentProviderId: this.meta.providerId
      })
      if (decision) {
        this.lastRoutedModel = decision.model // 供本轮结束记模型实测统计
        this.emit({
          kind: 'routing',
          model: decision.model,
          reason: decision.reason,
          providerId: decision.providerId
        })
        if (decision.switchedProvider) {
          // 跨厂商:换身份 → 重建引擎(env 换新家)→ 定模型 → 推消息
          this.meta.providerId = decision.providerId
          this.emit({ kind: 'meta', meta: { ...this.meta } })
          await this.rebuildEngine()
          if (!this.query) return // start 失败已置 error
          this.setStatus('running')
          await this.query.setModel(decision.model)
          await this.pushUserMessage(payload)
          return
        }
        await this.query?.setModel(decision.model)
      }
    } catch (err) {
      console.error('[agent-desk] 自动路由失败,回退默认模型:', err)
    }
    await this.pushUserMessage(payload)
  }

  private async pushUserMessage(payload: NormalizedSendPayload): Promise<void> {
    if (this.disposed) return
    try {
      // 展开 @文件引用:把被引文件内容追加到发给模型的 prompt(UI 仍显示原文)
      const mentions = extractMentions(payload.text)
      const injected = mentions.length > 0 ? readReferencedFiles(this.meta.cwd, mentions) : ''
      let promptText = injected ? payload.text + injected : payload.text
      const layeredMemory = promptText
        ? await buildLayeredMemoryPrompt({
            rootDir: join(app.getPath('userData'), 'memory'),
            query: promptText,
            projectRoot: this.meta.sourceCwd ?? this.meta.cwd,
            limit: 6
          }).catch((error) => {
            console.error('[caogen] layered memory retrieval failed:', error)
            return ''
          })
        : ''
      if (layeredMemory.trim()) {
        promptText = [layeredMemory, '## Current User Request', promptText].join('\n\n')
      }
      const skillPrompt = buildSkillInvocationPrompt({
        enabled: getSettings().autoSkillLearningEnabled,
        projectRoot: this.meta.sourceCwd ?? this.meta.cwd,
        query: payload.text,
        maxSkills: 2
      })
      if (skillPrompt.trim()) {
        promptText = promptText.includes('## Current User Request')
          ? [skillPrompt, promptText].join('\n\n')
          : [skillPrompt, '## Current User Request', promptText].join('\n\n')
      }
      const ideDocumentContext = buildIdeDocumentContextPrompt(this.meta.id)
      if (ideDocumentContext.trim()) {
        promptText = promptText.includes('## Current User Request')
          ? [ideDocumentContext, promptText].join('\n\n')
          : [ideDocumentContext, '## Current User Request', promptText].join('\n\n')
      }
      const liveProjectContext = buildProjectContextSystemAppendSync(this.meta.sourceCwd ?? this.meta.cwd)
      if (liveProjectContext && liveProjectContext !== this.lastProjectContextAppend) {
        this.lastProjectContextAppend = liveProjectContext
        promptText = ['# 项目上下文已更新', liveProjectContext, promptText].filter(Boolean).join('\n\n')
      }
      const content: ContentBlockParam[] = []
      if (promptText) content.push({ type: 'text', text: promptText })
      for (const image of payload.images) {
        content.push((await imageToContentBlock(image.path)) as unknown as ContentBlockParam)
      }
      const message = {
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
        session_id: this.meta.sdkSessionId ?? ''
      }
      this.input.push(message as unknown as SDKUserMessage)
    } catch (err) {
      this.setStatus('error', `图片输入失败: ${errText(err)}`)
    }
  }

  async interrupt(): Promise<void> {
    this.interrupting = true
    try {
      await this.query?.interrupt()
    } catch (err) {
      console.error('[agent-desk] interrupt 失败:', err)
    } finally {
      this.stopPowerBlocker()
      // result 消息在 interrupt() resolve 后到达,稍留窗口再复位
      setTimeout(() => {
        this.interrupting = false
      }, 3000)
    }
  }

  respondPermission(requestId: string, allow: boolean, message?: string): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    if (allow && message === GUI_TEMPORARY_GRANT_MESSAGE && normalizeClaudeToolName(pending.info.toolName).startsWith('gui_')) {
      grantTemporaryGuiAutomation()
    }
    writeAuditLog(this.meta.cwd, {
      action: allow ? 'allow' : 'deny',
      source: 'user',
      toolName: normalizeClaudeToolName(pending.info.toolName),
      input: pending.input,
      message
    })
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

  emitSyntheticEvent(event: AgentEvent): void {
    if (this.disposed) return
    this.emit(event)
  }

  /** 回退文件到某条用户消息时的状态;dryRun 只预览不改动 */
  async rewindFiles(messageId: string, dryRun: boolean): Promise<RewindResult> {
    return this.runFileRewind(messageId, dryRun, true)
  }

  async restoreCheckpoint(
    messageId: string,
    mode: CheckpointRestoreMode,
    dryRun: boolean
  ): Promise<CheckpointRestoreResult> {
    const wantsCode = mode === 'code' || mode === 'both'
    const wantsChat = mode === 'chat' || mode === 'both'
    const chat = wantsChat ? this.transcript.planRestore(messageId) : undefined
    if (wantsChat && !chat?.ok) {
      return {
        mode,
        checkpointId: messageId,
        canRewind: false,
        chat,
        error: chat?.reason ?? '无法恢复对话转录'
      }
    }

    const code = wantsCode ? await this.runFileRewind(messageId, dryRun, false) : undefined
    if (code?.error) {
      return { mode, checkpointId: messageId, canRewind: false, code, chat, error: code.error }
    }

    const canRewind = Boolean((wantsCode && code?.canRewind) || (wantsChat && chat?.ok))
    if (dryRun || !canRewind) {
      return {
        mode,
        checkpointId: messageId,
        canRewind,
        applied: false,
        code,
        chat,
        filesChanged: code?.filesChanged,
        insertions: code?.insertions,
        deletions: code?.deletions,
        chatRemovedEntries: chat?.removedEntries,
        note: wantsChat
          ? '对话回溯会恢复 CaoGen 聊天转录;若会话空闲将即时重建引擎截断 SDK 上下文,否则在下次 resume 时截断到该检查点。'
          : undefined
      }
    }

    const restoreEvent = (chatPlan?: { removedEntries?: number }): AgentEvent => ({
      kind: 'checkpoint-restore',
      messageId,
      mode,
      filesChanged: code?.filesChanged ?? [],
      insertions: code?.insertions,
      deletions: code?.deletions,
      chatRemovedEntries: chatPlan?.removedEntries ?? chat?.removedEntries,
      note: wantsChat
        ? '已恢复 CaoGen 聊天转录;底层 Claude SDK 上下文将在下次 resume 时截断到该检查点。'
        : undefined
    })
    const restored = wantsChat ? this.transcript.restore(messageId, restoreEvent) : undefined
    if (wantsChat && !restored?.plan.ok) {
      return {
        mode,
        checkpointId: messageId,
        canRewind: false,
        applied: false,
        code,
        chat: restored?.plan ?? chat,
        error: restored?.plan.reason ?? '无法恢复对话转录'
      }
    }
    if (!wantsChat) this.emit(restoreEvent())
    let contextRewoundLive = false
    if (wantsChat) {
      this.resumeAtId = messageId
      this.meta.resumeSessionAt = messageId
      this.emit({ kind: 'meta', meta: { ...this.meta } })
      // 立刻重建引擎让 SDK 上下文即时截断;失败/条件不满足则下次 resume 兜底
      contextRewoundLive = await this.restartForContextRewind()
    }

    const chatNote = wantsChat
      ? contextRewoundLive
        ? '已恢复 CaoGen 聊天转录,并已重建引擎——底层 Claude SDK 上下文已即时截断到该检查点。'
        : '已恢复 CaoGen 聊天转录;底层 Claude SDK 上下文将在下次 resume 时截断到该检查点。'
      : undefined

    return {
      mode,
      checkpointId: messageId,
      canRewind: true,
      applied: true,
      code,
      chat: restored?.plan ?? chat,
      transcript: restored?.entries,
      filesChanged: code?.filesChanged,
      insertions: code?.insertions,
      deletions: code?.deletions,
      chatRemovedEntries: restored?.plan.removedEntries ?? chat?.removedEntries,
      note: chatNote
    }
  }

  /**
   * chat/both 回退后,立刻让底层 SDK 上下文生效(而非拖到下次 resume)。
   * 复用故障切换的引擎重建机制:作废旧代 → 关旧 query → 新建输入流 →
   * 以 resume + resumeSessionAt 重启,新引擎从检查点截断处延续上下文。
   * 仅在 query 存活且无在途轮次时执行;否则依赖 start() 时的 resumeSessionAt 兜底。
   * 返回 true 表示已即时重建。
   */
  private async restartForContextRewind(): Promise<boolean> {
    if (this.disposed) return false
    if (this.failoverBusy || this.interrupting) return false
    if (this.turnInFlight) return false // 有轮次在途,不打断;下次 resume 兜底
    if (!this.query) return false // 引擎未起,start() 时 resumeSessionAt 自会生效
    if (!this.resumeId || !this.resumeAtId) return false // 无 SDK 会话可截断

    this.failoverBusy = true
    try {
      // 作废旧代:旧 consume 循环的残余消息/异常一律丢弃
      this.generation++
      // 旧引擎未决权限全部拒绝(其进程即将终止)
      for (const [requestId, pending] of this.pending) {
        pending.resolve({ behavior: 'deny', message: '会话已回退,操作作废' })
        this.emit({ kind: 'permission-resolved', requestId, behavior: 'deny' })
      }
      this.pending.clear()
      this.input.end()
      try {
        this.query?.close()
      } catch {
        // 进程可能已退出
      }
      this.query = null
      this.input = new Pushable<SDKUserMessage>()

      // resumeId + resumeAtId 已在 restoreCheckpoint 设好;start() 会带上二者,
      // 令新引擎从检查点截断处恢复上下文(丢弃其后的对话记忆)。
      await this.start()
      if (!this.query) return false // start 失败已置 error
      // 回退后进入待命,不自动重发任何消息(与故障切换不同:这是用户主动回退)
      if (this.meta.status === 'starting') this.setStatus('idle')
      return true
    } catch (err) {
      console.error('[caogen] 回退重建引擎失败:', err)
      return false
    } finally {
      this.failoverBusy = false
    }
  }

  private async runFileRewind(
    messageId: string,
    dryRun: boolean,
    emitRestoreEvent: boolean
  ): Promise<RewindResult> {
    if (!this.query) return { canRewind: false, error: '会话未运行' }
    try {
      const q = this.query as unknown as {
        rewindFiles?: (id: string, opts?: { dryRun?: boolean }) => Promise<RewindResult>
      }
      if (!q.rewindFiles) return { canRewind: false, error: 'SDK 不支持文件检查点' }
      const result = await q.rewindFiles(messageId, { dryRun })
      if (emitRestoreEvent && !dryRun && result.canRewind && !result.error) {
        this.emit({
          kind: 'checkpoint-restore',
          messageId,
          mode: 'code',
          filesChanged: result.filesChanged ?? [],
          insertions: result.insertions,
          deletions: result.deletions
        })
      }
      return result
    } catch (err) {
      return { canRewind: false, error: errText(err) }
    }
  }

  /** 只发布真实用户消息 uuid 作为 rewindFiles 锚点,并做会话内去重。 */
  private emitCheckpoint(uuid: string): void {
    if (!uuid || uuid === this.lastCheckpointUuid) return
    this.lastCheckpointUuid = uuid
    const userMessageId = this.pendingCheckpointUserMessageIds.shift()
    this.emit({ kind: 'checkpoint', messageId: uuid, userMessageId })
  }

  /** 用户消息入聊天流时先分配本地 id,之后 SDK checkpoint uuid 按该 id 精确回填。 */
  private emitUserMessage(text: string, images: ImageAttachmentView[] = []): string {
    const messageId = randomUUID()
    this.pendingCheckpointUserMessageIds.push(messageId)
    this.emit({ kind: 'user-message', text, messageId, attachments: compactUserAttachments(images) })
    return messageId
  }

  /** 每轮最多自动切换厂商次数,防止在大量厂商间雪崩式重试 */
  private static readonly MAX_FAILOVERS_PER_TURN = 3

  /** 有用户消息在途(值得为它切换厂商重试) */
  private get turnInFlight(): boolean {
    return (
      this.lastUserPayload !== null &&
      (this.meta.status === 'running' || this.meta.status === 'starting')
    )
  }

  private providerName(id: string): string {
    if (!id) return '官方 Anthropic'
    return getProvider(id)?.name ?? '未知厂商'
  }

  /** 故障切换候选:官方 Anthropic + 全部已配置 Provider */
  private failoverCandidates(): FailoverCandidate[] {
    const out: FailoverCandidate[] = [
      { id: '', name: '官方 Anthropic', models: [...DEFAULT_AUTO_CANDIDATES] }
    ]
    // 只纳入已配 key 的厂商:没 key 的选中必失败(官方 Anthropic 走环境登录例外)
    for (const p of listProviders()) {
      if (p.hasToken) out.push({ id: p.id, name: p.name, models: p.models })
    }
    return out
  }

  /**
   * 跨厂商故障切换(M4.1)。当前厂商故障时:挑一个健康的替代厂商,
   * 结束旧引擎 → 以 resume 延续上下文重建引擎 → 重发本轮消息,任务不中断。
   * 返回 true 表示已切换接管,调用方不应再把本轮按失败收尾。
   */
  private async tryFailover(errorText: string): Promise<boolean> {
    if (this.disposed || this.failoverBusy || this.interrupting) return false
    if (!getSettings().failoverEnabled) return false
    if (!this.lastUserPayload) return false // 无在途轮次,无从重试
    if (this.triedProviders.size > AgentSession.MAX_FAILOVERS_PER_TURN) return false
    const failure = classifyFailure(errorText)
    if (!failure.switchable) return false

    const target = pickFailoverTarget({
      candidates: this.failoverCandidates(),
      exclude: this.triedProviders,
      desiredModel: this.meta.model !== AUTO_MODEL ? this.meta.model : ''
    })
    if (!target) return false

    this.failoverBusy = true
    try {
      // 先令旧引擎代数作废:此后旧 consume 循环的任何消息/异常都被丢弃,
      // 不会在切换过程中把会话误标为 error/closed
      this.generation++
      const fromId = this.meta.providerId
      const fromName = this.providerName(fromId)
      console.warn(
        `[caogen] 厂商故障切换:${fromName} → ${target.name}(${failure.label})`
      )
      // 旧引擎的未决权限全部拒绝(其进程即将终止)
      for (const [requestId, pending] of this.pending) {
        pending.resolve({ behavior: 'deny', message: '厂商已切换,操作作废' })
        this.emit({ kind: 'permission-resolved', requestId, behavior: 'deny' })
      }
      this.pending.clear()
      this.input.end()
      try {
        this.query?.close()
      } catch {
        // 进程可能已退出
      }
      this.query = null
      this.input = new Pushable<SDKUserMessage>()

      // 切换身份:providerId 必换;固定模型就近映射到目标厂商的同档模型
      this.meta.providerId = target.providerId
      if (this.meta.model !== AUTO_MODEL && target.model) this.meta.model = target.model
      this.triedProviders.add(target.providerId)
      // 延续对话上下文:从当前 SDK 会话 resume(首轮尚无 id 时全新开始)
      this.resumeId = this.meta.sdkSessionId || this.resumeId

      this.emit({
        kind: 'failover',
        fromProviderId: fromId,
        toProviderId: target.providerId,
        fromName,
        toName: target.name,
        model: this.meta.model === AUTO_MODEL ? undefined : this.meta.model,
        reason: failure.label
      })
      this.emit({ kind: 'meta', meta: { ...this.meta } })

      await this.start()
      // 已提交切换(旧引擎已终止),即使新引擎启动失败也返回 true:
      // start() 失败路径已把会话置为 error,调用方不得再按正常轮次收尾
      if (!this.query) return true

      // 重发本轮消息(user-message 已在转录中,不重复 emit)
      this.setStatus('running')
      this.turnStartedAt = Date.now()
      if (this.lastUserPayload) {
        if (this.meta.model === AUTO_MODEL) {
          void this.autoRouteThenPush(this.lastUserPayload)
        } else {
          void this.pushUserMessage(this.lastUserPayload)
        }
      }
      // 补推切换窗口期用户发的消息
      for (const queued of this.queuedDuringFailover.splice(0)) {
        void this.pushUserMessage(queued)
      }
      return true
    } finally {
      this.failoverBusy = false
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

  async supportedAgents(): Promise<SdkAgentInfo[]> {
    if (!this.query) return []
    const query = this.query as unknown as {
      supportedAgents?: () => Promise<unknown>
    }
    if (typeof query.supportedAgents !== 'function') return []
    const agents = await query.supportedAgents()
    if (!Array.isArray(agents)) return []
    return agents
      .map((agent): SdkAgentInfo | null => {
        if (!agent || typeof agent !== 'object') return null
        const record = agent as Record<string, unknown>
        const name = typeof record.name === 'string' ? record.name : ''
        const description = typeof record.description === 'string' ? record.description : ''
        const model = typeof record.model === 'string' ? record.model : undefined
        return name ? { name, description, model } : null
      })
      .filter((agent): agent is SdkAgentInfo => agent !== null)
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
    this.input.end()
    this.stopPowerBlocker()
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

  private async consume(gen: number): Promise<void> {
    const q = this.query
    if (!q) return
    try {
      for await (const message of q) {
        // 故障切换会重建引擎;旧引擎的残余消息一律丢弃
        if (this.disposed || gen !== this.generation) return
        this.handleMessage(message as unknown as Record<string, unknown>)
      }
      if (!this.disposed && gen === this.generation) this.setStatus('closed')
    } catch (err) {
      if (this.disposed || gen !== this.generation) return
      // 附上 SDK stderr 尾部:否则子进程认证失败/崩溃时用户只见空洞错误
      const tail = this.stderrTail.trim()
      const text = tail ? `${errText(err)}\n[SDK stderr]\n${tail.slice(-1200)}` : errText(err)
      recordFailure(this.meta.providerId, text)
      // 流层崩溃(进程退出/网络断):仅当有轮次在途时值得切厂商重试
      if (this.turnInFlight && (await this.tryFailover(text))) return
      // await 期间可能有并行的故障切换已接管(代数已推进),此时不再报错
      if (this.disposed || gen !== this.generation) return
      this.setStatus('error', text)
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
        // rewindFiles 接受 SDK 用户消息 uuid;tool_result 回放也属于 user 消息,
        // 但不是可回退锚点,所以只记录含文本块的人类 prompt。
        const uuid = typeof msg.uuid === 'string' ? msg.uuid : ''
        const hasText = content.some(
          (r) => (r as Record<string, unknown> | null)?.type === 'text'
        )
        if (uuid && hasText) {
          this.emitCheckpoint(uuid)
        }
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
          this.recordContextTokens(usage.input + usage.cacheRead + usage.cacheCreation)
        }
        const subtype = typeof msg.subtype === 'string' ? msg.subtype : 'unknown'
        const isError = msg.is_error === true || subtype !== 'success'
        const latency = this.turnStartedAt ? Date.now() - this.turnStartedAt : undefined
        const finish = (): void => {
          // 检查点:本轮结束后从 CLI transcript 取本轮用户消息 uuid 作回退锚点
          // (用户 prompt 不在 SDK 事件流里,但会落到 CLI transcript;文件检查点挂在它上)
          if (!isError && this.meta.sdkSessionId) {
            const uuid = latestUserTextUuid(this.meta.sdkSessionId)
            if (uuid) this.emitCheckpoint(uuid)
          }
          if (!isError && this.resumeAtId) {
            this.resumeAtId = undefined
            this.meta.resumeSessionAt = undefined
            this.emit({ kind: 'meta', meta: { ...this.meta } })
          }
          this.emit({
            kind: 'turn-result',
            subtype,
            isError,
            costUsd,
            usage: hasUsage ? usage : undefined,
            durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : undefined,
            numTurns: typeof msg.num_turns === 'number' ? msg.num_turns : undefined,
            resultText: typeof msg.result === 'string' ? msg.result : undefined
          })
          this.setStatus('idle')
        }
        // Provider 健康度 + 模型实测统计:成功记成功+延迟,异常记失败
        // auto 模式记本轮路由选中的真实模型名,固定模式记 meta.model
        const activeModel =
          this.meta.model && this.meta.model !== AUTO_MODEL ? this.meta.model : this.lastRoutedModel
        if (isError) {
          const errorText = typeof msg.result === 'string' ? msg.result : subtype
          recordFailure(this.meta.providerId, errorText)
          if (activeModel) recordModelFailure(activeModel)
          // 厂商侧故障:先尝试切换厂商续跑;不可切换或无处可切时按原样收尾
          void this.tryFailover(errorText).then((switched) => {
            if (!switched) finish()
          })
        } else {
          recordSuccess(this.meta.providerId, latency)
          if (activeModel) recordModelSuccess(activeModel, latency)
          this.lastUserPayload = null // 本轮成功,清除重试凭据
          finish()
        }
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
    const settings = getSettings()
    const policyToolName = normalizeClaudeToolName(toolName)
    const policyInput = normalizeClaudeToolInput(toolName, input)
    const policy = evaluateToolPermission(settings, { toolName: policyToolName, input: policyInput, cwd: this.meta.cwd })
    const audit = (action: 'allow' | 'deny' | 'ask', source: 'policy' | 'permission-mode', message: string): void => {
      writeAuditLog(this.meta.cwd, {
        action,
        source,
        toolName: policyToolName,
        input: policyInput,
        message,
        riskLevel: policy.risk.level,
        riskReasons: policy.risk.reasons
      })
    }

    if (policy.kind === 'deny') {
      audit('deny', 'policy', policy.reason)
      return Promise.resolve({ behavior: 'deny', message: policy.reason })
    }
    if (settings.sandboxMode === 'strictDocker' && CLAUDE_HOST_MUTATION_TOOLS.has(toolName)) {
      const message = '严格 Docker 模式下 Claude SDK 本地工具无法由 CaoGen Docker 沙箱接管,已按 fail-closed 阻止;请改用 OpenAI 本地工具链或切换沙箱模式。'
      audit('deny', 'policy', message)
      return Promise.resolve({ behavior: 'deny', message })
    }
    const guiDecision = decideGuiPermission(policyToolName, settings)
    if (guiDecision.kind === 'deny') {
      audit('deny', 'policy', guiDecision.reason)
      return Promise.resolve({ behavior: 'deny', message: guiDecision.reason })
    }
    if (guiDecision.kind === 'allow') {
      audit('allow', 'policy', guiDecision.reason)
      return Promise.resolve({ behavior: 'allow', updatedInput: policyInput })
    }
    if (guiDecision.kind === 'ask') {
      const requestId = randomUUID()
      const info: PermissionRequestInfo = {
        requestId,
        toolName,
        input: policyInput,
        toolUseId: opts?.toolUseID,
        decisionReason: guiDecision.reason
      }
      audit('ask', 'permission-mode', guiDecision.reason)
      this.emit({ kind: 'permission-request', request: info })
      return new Promise<PermissionResult>((resolve) => {
        this.pending.set(requestId, { resolve, input: policyInput, info })
        opts?.signal?.addEventListener('abort', () => {
          if (this.pending.delete(requestId)) {
            writeAuditLog(this.meta.cwd, {
              action: 'deny',
              source: 'user',
              toolName: policyToolName,
              input: policyInput,
              message: '操作已被取消',
              riskLevel: policy.risk.level,
              riskReasons: policy.risk.reasons
            })
            this.emit({ kind: 'permission-resolved', requestId, behavior: 'deny' })
            resolve({ behavior: 'deny', message: '操作已被取消' })
          }
        })
      })
    }
    if (policy.kind === 'allow') {
      audit('allow', 'policy', policy.reason)
      return Promise.resolve({ behavior: 'allow', updatedInput: policyInput })
    }

    if (this.meta.permissionMode === 'bypassPermissions') {
      audit('allow', 'permission-mode', policy.reason)
      return Promise.resolve({ behavior: 'allow', updatedInput: policyInput })
    }
    if (CLAUDE_READ_TOOLS.has(toolName)) {
      audit('allow', 'permission-mode', policy.reason)
      return Promise.resolve({ behavior: 'allow', updatedInput: policyInput })
    }
    if (this.meta.permissionMode === 'plan') {
      const message = '规划模式:只允许只读工具,不执行写入或命令。'
      audit('deny', 'permission-mode', message)
      return Promise.resolve({ behavior: 'deny', message })
    }
    if (this.meta.permissionMode === 'acceptEdits' && CLAUDE_EDIT_TOOLS.has(toolName)) {
      audit('allow', 'permission-mode', policy.reason)
      return Promise.resolve({ behavior: 'allow', updatedInput: policyInput })
    }

    const requestId = randomUUID()
    const info: PermissionRequestInfo = {
      requestId,
      toolName,
      input: policyInput,
      toolUseId: opts?.toolUseID,
      decisionReason: opts?.decisionReason ?? policy.reason
    }
    audit('ask', 'permission-mode', info.decisionReason ?? policy.reason)
    this.emit({ kind: 'permission-request', request: info })
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { resolve, input: policyInput, info })
      opts?.signal?.addEventListener('abort', () => {
        if (this.pending.delete(requestId)) {
          writeAuditLog(this.meta.cwd, {
            action: 'deny',
            source: 'user',
            toolName: policyToolName,
            input: policyInput,
            message: '操作已被取消',
            riskLevel: policy.risk.level,
            riskReasons: policy.risk.reasons
          })
          this.emit({ kind: 'permission-resolved', requestId, behavior: 'deny' })
          resolve({ behavior: 'deny', message: '操作已被取消' })
        }
      })
    })
  }

  private recordContextTokens(usedTokens: number): void {
    const model = this.meta.model !== AUTO_MODEL ? this.meta.model : this.lastRoutedModel || this.meta.model
    const state = evaluateContextUsage({ usedTokens, model })
    this.meta.contextTokens = state.usedTokens
    this.meta.contextWindowTokens = state.windowTokens
    this.meta.contextRemainingTokens = state.remainingTokens
    this.meta.contextUsageRatio = state.usageRatio
    this.meta.contextPressure = state.pressure
    this.emit({ kind: 'meta', meta: { ...this.meta } })

    if (state.shouldWarn && this.lastContextPressure === 'normal') {
      this.emit({
        kind: 'hook-event',
        event: 'context-warning',
        detail: `上下文已使用 ${Math.round(state.usageRatio * 100)}%,剩余约 ${state.remainingTokens} tokens`
      })
    }
    this.lastContextPressure = state.pressure
  }

  private emit(event: AgentEvent): void {
    this.emitRaw(event)
  }

  private setStatus(status: SessionMeta['status'], error?: string): void {
    if (status === 'running') {
      this.startPowerBlocker()
    } else if (status === 'idle' || status === 'error' || status === 'closed') {
      this.stopPowerBlocker()
    }
    this.meta.status = status
    if (error) this.meta.lastError = error
    this.emit({ kind: 'status', status, error })
  }

  private startPowerBlocker(): void {
    if (this.powerBlockerId !== null) return
    // 读取当前设置(而非缓存),用户可关闭"运行时防休眠"
    if (!getSettings().preventDisplaySleep) return
    try {
      this.powerBlockerId = powerSaveBlocker.start('prevent-display-sleep')
    } catch (err) {
      console.error('[agent-desk] 启动防休眠失败:', err)
    }
  }

  private stopPowerBlocker(): void {
    if (this.powerBlockerId === null) return
    const id = this.powerBlockerId
    this.powerBlockerId = null
    try {
      if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id)
    } catch (err) {
      console.error('[agent-desk] 释放防休眠失败:', err)
    }
  }
}

export function newSessionMeta(opts: {
  cwd: string
  parentSessionId?: string
  orchestrationId?: string
  childTaskId?: string
  childRole?: string
  isolated?: boolean
  sourceCwd?: string
  repoRoot?: string
  worktreePath?: string
  branch?: string
  baseBranch?: string | null
  baseSha?: string
  worktreeState?: 'active' | 'removed'
  model: string
  providerId: string
  budgetUsd?: number
  resumeSessionAt?: string
  engine?: EngineKind
  permissionMode: PermissionModeId
  title?: string
}): SessionMeta {
  return {
    id: randomUUID(),
    title: opts.title || '新会话',
    cwd: opts.cwd,
    parentSessionId: opts.parentSessionId,
    orchestrationId: opts.orchestrationId,
    childTaskId: opts.childTaskId,
    childRole: opts.childRole,
    isolated: opts.isolated,
    sourceCwd: opts.sourceCwd,
    repoRoot: opts.repoRoot,
    worktreePath: opts.worktreePath,
    branch: opts.branch,
    baseBranch: opts.baseBranch,
    baseSha: opts.baseSha,
    worktreeState: opts.worktreeState,
    model: opts.model,
    providerId: opts.providerId,
    budgetUsd: normalizeBudget(opts.budgetUsd),
    resumeSessionAt: opts.resumeSessionAt,
    engine: opts.engine ?? 'claude',
    permissionMode: opts.permissionMode,
    status: 'starting',
    costUsd: 0,
    usage: emptyUsage(),
    contextTokens: 0,
    contextPressure: 'normal',
    createdAt: Date.now()
  }
}
