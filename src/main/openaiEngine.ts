import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { app } from 'electron'
import { documentAttachmentsToPrompt, sessionImageAttachmentsRoot } from './attachmentOps'
import { TranscriptWriter } from './transcript'
import {
  getProvider,
  listProviders,
  markProviderKeyUsed,
  providerIsReady,
  recordProviderKeySuccess,
  issueDirectProviderCredentialLease,
  issueProviderCredentialLease,
  rotateProviderKey
} from './providers'
import {
  fetchWithProviderCredentialLease,
  providerCredentialScopeForSession
} from './providerRuntimeAuth'
import {
  ensureProviderAuthorizationFresh,
  issueProviderAuthorizationAccountLease,
  recordProviderAuthorizationAccountFailure,
} from './provider/providerAuthorizationService'
import { resolveOpenAiAuthConfig, type OpenAIAuthConfig } from './provider/openAiAuthorizationRouting'
import { listHistory } from './history'
import {
  acquireProviderRequest,
  classifyFailure,
  pickModelAcrossProviders,
  recordFailure,
  releaseProviderRequest,
  recordSuccess
} from './scheduler'
import { recordModelFailure, recordModelSuccess } from './modelStats'
import { getSettings } from './settings'
import { createLegacyRoutingDecisionView, resolveSessionModelRoute } from './model/session-routing'
import { settingsForCaoGenDrive } from './model/drive'
import { assertRoutingExpertTargetAllowed } from './model/routing-expert-policy'
import { calculateMonthlyBudgetSnapshot } from './model/monthly-budget'
import { canRotateProviderKey } from './providerKeyRouting'
import { OPENAI_CODING_TOOLS, RESPONSES_CODING_TOOLS } from './openaiTools'
import { NativeToolRuntime, type NativeToolExecutionResult } from './native-tool-runtime'
import { buildProjectContextSystemAppendSync } from './agent/context-loader'
import { buildEffectiveMemoryPrompt } from './memory/memory-retriever'
import { buildDigitalWorkerMemoryPrompt } from './digital-worker/worker-memory'
import { buildSkillInvocationPrompt } from './skill/skill-invocation'
import { buildIdeDocumentContextPrompt } from './ide/ide-document-context'
import {
  adaptChatCompletionRequest, buildChinaProviderPromptAppend, type ProviderAdapterContext
} from './model/llm-providers/china-provider-adapter'
import {
  DEFAULT_KEEP_RECENT_MESSAGES, estimateContextTokens, evaluateContextUsage,
  planCompressionBoundary, type ContextUsageState
} from './agent/context-compressor'
import { isGuiToolName } from './agent/tools/gui-tools'
import { taskRuntimeRegistry } from './task/task-runtime-registry'
import { effectReplayTargetDigest } from './task/effect-reconciler'
import { taskStrategySystemPrompt, updateTaskStrategyMeta } from './task/task-strategy'
import { buildWorkflowStageHandoffPrompt } from './task/workflow-stage-handoff'
import {
  assertOutboundContextAllowed,
  OutboundContextPolicyError,
  prepareOutboundContext
} from './project-workspace/outbound-context-policy'
import {
  openAiEndpoint,
  parseProviderHeaders,
  redactProviderBaseUrl,
  redactProviderErrorText
} from './provider/openai-provider-utils'
import { applyProviderRequestOverrides } from './provider/providerRequestOverrides'
import { estimateModelAttemptCostUsd } from './provider/modelAttemptCost'
import { resolveOpenAIProtocol, resolveProviderRuntimeTarget } from './provider/providerRuntimeTarget'
import {
  ProviderRequestDeadline,
  providerRequestIsStreaming,
  providerRequestTimeouts
} from './provider/providerRequestTimeout'
import {
  firstSuccessfulRecovery,
  OpenAiRecoveryState,
  planOpenAiProviderFailover,
  planOpenAiProviderModelRecovery,
  planOpenAiProtocolRecovery
} from './provider/openAiProviderModelRecovery'
import { normalizeStableMessagePayload } from './stable-message-payload'
import {
  providerChatCheckpointId,
  restoreProviderChatCheckpoint
} from './provider-chat-checkpoint'
import {
  buildConfirmedToolReplayIndex,
  buildPortableConversationReplay,
  findConfirmedToolReplay,
  portableConversationReplayDetail,
  recordConfirmedToolReplay,
  type ConfirmedToolReplayIndex
} from './conversation-ledger-replay'
import { isModelAttemptPersistenceError, unwrapModelAttemptOperationError } from './task/model-attempt-runtime'
import { addUsageTotals, OpenAIModelAttemptTracker } from './task/openai-model-attempt-runtime'
import type {
  ChatContent,
  ChatMessage,
  OpenAIErrorContext,
  PendingToolCall,
  TurnToolFailure
} from './openAiEngineTypes'
import { formatProviderErrorContext, isResponsesConversationContext } from './openAiEngineTypes'
import {
  assertDigitalWorkerProviderDispatchAllowed, isDigitalWorkerProviderDispatchDeniedError
} from './digital-worker/session-action-policy'
import { AUTO_MODEL } from '../shared/types'
import type { Engine, EngineEmit, EngineFactory } from './engine'
import type {
  AgentEvent,
  AssistantBlock,
  CheckpointRestoreMode,
  CheckpointRestoreResult,
  EffectStatus,
  ImageAttachmentView,
  OpenAIProtocol,
  OutboundContextItemView,
  OutboundContextManifest,
  PermissionModeId,
  PermissionRequestInfo,
  Provider,
  ResponsesConversationContext,
  SendMessagePayload,
  SessionMeta,
  TranscriptEntry,
  UsageTotals
} from '../shared/types'

const DEFAULT_OPENAI_MODEL = 'gpt-4.1'

/** Agent 循环上限:防模型无限调工具烧穿 */
const MAX_TOOL_ITERATIONS = 40

/**
 * OpenAIEngine —— 原生 OpenAI 协议适配器,支持两种协议:
 * - 'responses':OpenAI 原生 Responses API(/v1/responses,协议默认)
 * - 'chat':通用 Chat Completions(/v1/chat/completions)——DeepSeek/Qwen/
 *   new-api 网关/自部署 vLLM·Ollama 等几乎所有 OpenAI 兼容端点都讲这个协议。
 * 协议按 Provider 的 openaiProtocol 字段选择。
 *
 * 多轮上下文:chat 协议在内存维护 user/assistant 历史并随每轮全量发送;
 * resume 时从转录重建。responses 路径持久化受 Provider/模型/协议/Key 约束的
 * server response id；身份不匹配时丢弃该优化并回退本地转录。
 * OpenAI 的工具调用与本地文件编辑权限模型暂未桥接,因此权限请求如实为空。
 */
export class OpenAIEngine implements Engine {
  readonly meta: SessionMeta
  private readonly transcript: TranscriptWriter
  private readonly emitRaw: (event: AgentEvent) => void
  private abort: AbortController | null = null
  private disposed = false
  private activeTurn: Promise<void> | null = null
  private activeOutboundContext?: OutboundContextManifest
  private disposePromise: Promise<void> | null = null
  private assistantText = ''
  private turnUsage: UsageTotals | undefined
  private turnStartedAt = 0
  private activeMessageId?: string
  private activeConfirmedToolReplay: ConfirmedToolReplayIndex = new Map()
  private turnRevisionEligible = false
  private turnHadToolEvents = false
  private readonly modelAttempts = new OpenAIModelAttemptTracker()
  private readonly nativeToolRuntime: NativeToolRuntime
  /** chat 协议的多轮历史(user/assistant/tool);responses 协议不使用 */
  private chatHistory: ChatMessage[] = []
  /** 本轮流式累积的工具调用(SSE delta 分片拼装) */
  private pendingToolCalls: PendingToolCall[] = []
  /** 本轮 GUI 工具失败;最终文本不能掩盖真实桌面自动化失败 */
  private turnGuiToolFailures: TurnToolFailure[] = []
  private lastContextPressure: NonNullable<SessionMeta['contextPressure']> = 'normal'
  private forkBoundaryPending = false

  constructor(
    meta: SessionMeta,
    emit: EngineEmit,
    resumeSdkSessionId?: string,
    initialEventSeq = 0
  ) {
    this.meta = meta
    this.transcript = new TranscriptWriter(resumeSdkSessionId, initialEventSeq)
    if (!resumeSdkSessionId && meta.conversationForkSourceSdkSessionId) {
      this.transcript.seedFrom(meta.conversationForkSourceSdkSessionId, meta.conversationForkCheckpointId)
      this.forkBoundaryPending = true
    }
    this.emitRaw = (event) => {
      const entry = this.transcript.nextEntry(event)
      emit(event, entry.seq, entry)
    }
    this.nativeToolRuntime = new NativeToolRuntime(this.meta, (event) => this.emit(event))
    this.restoreResponsesContext()
    if (resumeSdkSessionId) {
      this.meta.sdkSessionId = resumeSdkSessionId
      this.rebuildChatHistory()
      this.emit({ kind: 'init', sdkSessionId: resumeSdkSessionId, model: this.effectiveModel() })
    }
  }

  /** resume 时从转录重建 chat 协议的多轮历史(仅文本;图片不回放) */
  private rebuildChatHistory(): void {
    this.chatHistory = []
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
    if (!auth.available && auth.authMode !== 'none') {
      this.setStatus('error', this.missingKeyMessage())
      return
    }
    if (!this.meta.sdkSessionId) {
      this.meta.sdkSessionId = `openai-${randomUUID()}`
      this.emit({ kind: 'init', sdkSessionId: this.meta.sdkSessionId, model: this.effectiveModel() })
    }
    if (this.forkBoundaryPending) {
      this.forkBoundaryPending = false
      this.emit({
        kind: 'hook-event',
        event: 'conversation-forked',
        detail: '已从本地会话账本创建独立会话；未复用来源 Provider 的服务端上下文。'
      })
    }
    this.setStatus('idle')
  }

  send(input: string | SendMessagePayload): void {
    if (this.disposed) return
    if (this.abort) {
      this.rejectSend('上一轮仍在运行,请等待完成或中断后再发送。')
      return
    }
    const normalizedPayload = normalizeStableMessagePayload(input)
    if (!normalizedPayload.text && normalizedPayload.images.length === 0 && normalizedPayload.documents.length === 0) return

    const messageId = normalizedPayload.messageId || randomUUID()
    const payload: SendMessagePayload = { ...normalizedPayload, messageId }
    this.activeMessageId = messageId
    this.activeConfirmedToolReplay = new Map()
    this.turnRevisionEligible = normalizedPayload.images.length === 0 && normalizedPayload.documents.length === 0
    this.turnHadToolEvents = false
    this.modelAttempts.startTurn(messageId)
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
    this.turnGuiToolFailures = []
    this.recoveryExhaustedEmitted = false
    // 新一轮:重置故障切换防打转记录
    // auto 模式:跨厂商路由(openai 引擎切 Provider 无需重建,authConfig 每请求现读)
    if (this.meta.model === AUTO_MODEL) this.autoRoute(payload)
    // Initialize after auto routing so failover cannot select the active Provider again.
    this.recoveryState = new OpenAiRecoveryState(this.meta.providerId)
    this.abort = new AbortController()
    this.setStatus('running')
    const turn = this.runResponse(payload, this.abort)
    this.activeTurn = turn
    void turn.then(
      () => {
        if (this.activeTurn === turn) this.activeTurn = null
      },
      () => {
        if (this.activeTurn === turn) this.activeTurn = null
      }
    )
  }

  /** 本轮路由选中的模型(meta.model 保持 auto 哨兵,下一轮重新路由) */
  private routedModel?: string

  /** 跨厂商智能路由:候选 = 所有有 baseUrl 的 Provider(空 Base URL 不适配本引擎) */
  private autoRoute(payload: SendMessagePayload): void {
    try {
      const settings = settingsForCaoGenDrive(getSettings(), this.meta.driveMode)
      const compatibleProviders = listProviders().filter((provider) => provider.engine === 'openai')
      const routingProviders = this.meta.routingScope === 'provider'
        ? compatibleProviders.filter((provider) => provider.id === this.meta.providerId)
        : compatibleProviders
      if (settings.smartModelRoutingEnabled || this.meta.routingScope === 'provider' || this.meta.routingScope === 'global') {
        const monthlyBudget = calculateMonthlyBudgetSnapshot({
          settings,
          history: listHistory(),
          currentSession: this.meta
        })
        const smart = resolveSessionModelRoute({
          enabled: true,
          currentModel: this.meta.model,
          providerId: this.meta.providerId,
          providers: routingProviders,
          engine: this.meta.engine,
          driveMode: this.meta.driveMode,
          payload,
          strategy: settings.schedulerStrategy,
          sessionCostUsd: this.meta.costUsd,
          sessionBudgetUsd: this.meta.budgetUsd,
          settingsBudgetUsd: settings.budgetUsdPerSession,
          monthlyBudgetRemainingUsd: monthlyBudget.remainingUsd,
          fallbackProviderId: settings.fallbackProviderId,
          fallbackModel: settings.fallbackModel,
          lowCostProviderId: settings.lowCostProviderId,
          lowCostModel: settings.lowCostModel,
          strongReasoningProviderId: settings.strongReasoningProviderId,
          strongReasoningModel: settings.strongReasoningModel,
          reviewProviderId: settings.reviewProviderId,
          reviewModel: settings.reviewModel,
          researchProviderId: settings.researchProviderId,
          researchModel: settings.researchModel,
          planningProviderId: settings.planningProviderId,
          planningModel: settings.planningModel,
          codingProviderId: settings.codingProviderId,
          codingModel: settings.codingModel,
          testingProviderId: settings.testingProviderId,
          testingModel: settings.testingModel,
          documentationProviderId: settings.documentationProviderId,
          documentationModel: settings.documentationModel,
          modelRoutingRules: settings.modelRoutingRules,
          routingExpertPolicy: settings.routingExpertPolicy,
          projectPath: this.meta.sourceCwd ?? this.meta.cwd
        })
        if (smart.kind === 'routed') {
          const routeChanged = smart.providerId !== this.meta.providerId || smart.model !== this.effectiveModel()
          if (routeChanged) {
            this.clearResponsesContext(this.protocol() === 'responses')
            this.protocolOverride = undefined
          }
          this.modelAttempts.setRouteReason(smart.reason)
          this.routedModel = smart.model
          if (smart.switchedProvider) this.meta.providerId = smart.providerId
          this.emit({
            kind: 'routing',
            model: smart.model,
            reason: smart.reason,
            providerId: smart.providerId,
            providerName: smart.providerName,
            decision: smart.decision,
            crossValidationPlan: smart.crossValidationPlan
          })
          this.emit({ kind: 'meta', meta: { ...this.meta } })
          return
        }
      }
      // 候选:有端点且已配 key 的厂商(没 key 的选中必失败,不进池)
      const candidates = routingProviders
        .filter((p) => p.baseUrl.trim().length > 0 && providerIsReady(p))
        .map((p) => ({ id: p.id, name: p.name, models: p.models }))
      const decision = pickModelAcrossProviders({
        candidates,
        text: payload.text,
        strategy: settings.schedulerStrategy,
        currentProviderId: this.meta.providerId
      })
      if (!decision) return
      const routeChanged = decision.providerId !== this.meta.providerId || decision.model !== this.effectiveModel()
      if (routeChanged) {
        this.clearResponsesContext(this.protocol() === 'responses')
        this.protocolOverride = undefined
      }
      this.modelAttempts.setRouteReason(decision.reason)
      this.routedModel = decision.model
      if (decision.switchedProvider) {
        this.meta.providerId = decision.providerId
      }
      this.emit({
        kind: 'routing',
        model: decision.model,
        reason: decision.reason,
        providerId: decision.providerId,
        providerName: decision.providerName,
        decision: createLegacyRoutingDecisionView({
          providerId: decision.providerId,
          providerName: decision.providerName,
          model: decision.model,
          strategy: settings.schedulerStrategy,
          complexity: decision.complexity,
          candidateCount: candidates.reduce((count, candidate) => count + candidate.models.filter(Boolean).length, 0),
          switchedProvider: decision.switchedProvider,
          reason: decision.reason
        })
      })
      this.emit({ kind: 'meta', meta: { ...this.meta } })
    } catch (err) {
      console.error('[caogen] openai 引擎自动路由失败,沿用当前配置:', err)
    }
  }

  rejectSend(message: string): void {
    this.setStatus(this.abort ? 'running' : 'error', message)
  }

  async interrupt(): Promise<void> {
    // 先拒掉挂起的审批,否则 Agent 循环会永远等在 gateTool 上
    this.rejectAllPendingPerms('已中断')
    const activeTurn = this.activeTurn
    if (!activeTurn) return
    this.abort?.abort()
    await activeTurn.catch(() => undefined)
  }

  /** 中断/销毁时统一拒绝所有挂起审批,防 Agent 循环悬挂 */
  private rejectAllPendingPerms(message: string): void {
    this.nativeToolRuntime.rejectAllPending(message)
  }

  respondPermission(requestId: string, allow: boolean, message?: string): void {
    this.nativeToolRuntime.respondPermission(requestId, allow, message)
  }

  pendingPermissions(): PermissionRequestInfo[] {
    return this.nativeToolRuntime.pendingPermissions()
  }

  private async executeToolWithPermission(
    name: string,
    input: Record<string, unknown>,
    toolUseId: string,
    signal?: AbortSignal
  ): Promise<NativeToolExecutionResult> {
    return this.nativeToolRuntime.executeToolWithPermission(name, input, toolUseId, signal)
  }

  private async confirmedFailoverToolOutput(
    index: ConfirmedToolReplayIndex,
    name: string,
    input: Record<string, unknown>,
    toolUseId: string
  ): Promise<string | undefined> {
    if (index.size === 0) return undefined
    const target = await this.nativeToolRuntime.describeSideEffectTarget(name, input).catch(() => null)
    if (!target) return undefined
    const confirmed = findConfirmedToolReplay(index, name, target.targetDigest)
    if (!confirmed) {
      const indexedTargets = [...index.values()]
        .filter((candidate) => candidate.toolName === name)
        .map((candidate) => candidate.targetDigest.slice(0, 12))
        .join(',')
      this.emit({
        kind: 'hook-event',
        event: 'confirmed-tool-replay-miss',
        toolName: name,
        detail: `Failover replay target ${target.targetDigest.slice(0, 12)} did not match indexed targets ${indexedTargets || 'none'}`
      })
      return undefined
    }
    this.emit({
      kind: 'hook-event',
      event: 'confirmed-tool-failover-replay',
      toolName: name,
      detail: `Reused confirmed target result ${confirmed.toolUseId} for failover call ${toolUseId}`
    })
    return [
      '[CaoGen confirmed side-effect replay]',
      `A ${name} operation for the same external target already completed successfully in this user turn.`,
      `Local result digest: sha256:${confirmed.resultDigest}`,
      'Do not execute this operation again. Continue from the confirmed success.'
    ].join('\n')
  }

  private confirmedEffectReplayTargets(): ReadonlyMap<string, string> {
    const targets = new Map<string, string>()
    for (const effect of taskRuntimeRegistry.get(this.meta.id)?.effects ?? []) {
      if (effect.status !== 'confirmed') continue
      targets.set(effect.toolUseId, effectReplayTargetDigest(effect.target))
    }
    return targets
  }

  private refreshConfirmedToolReplay(messageId?: string): void {
    const confirmed = buildConfirmedToolReplayIndex(
      this.transcript.read(),
      messageId,
      this.confirmedEffectReplayTargets()
    )
    if (confirmed.size === 0) return
    this.activeConfirmedToolReplay = new Map([
      ...this.activeConfirmedToolReplay,
      ...confirmed
    ])
  }

  private rememberConfirmedToolReplay(input: {
    toolUseId: string
    toolName: string
    targetDigest?: string
    resultContent: string
    isError: boolean
    effectStatus?: EffectStatus
  }): void {
    if (input.isError || input.effectStatus !== 'confirmed' || !input.targetDigest) return
    this.activeConfirmedToolReplay = recordConfirmedToolReplay(this.activeConfirmedToolReplay, {
      toolUseId: input.toolUseId,
      toolName: input.toolName,
      targetDigest: input.targetDigest,
      resultContent: input.resultContent
    })
    this.emit({
      kind: 'hook-event',
      event: 'confirmed-tool-replay-indexed',
      toolName: input.toolName,
      detail: `Indexed confirmed side effect ${input.toolUseId} target ${input.targetDigest.slice(0, 12)} for current-turn failover replay`
    })
  }

  getTranscript(): TranscriptEntry[] {
    return this.transcript.read()
  }

  async restoreCheckpoint(
    messageId: string,
    mode: CheckpointRestoreMode,
    dryRun: boolean
  ): Promise<CheckpointRestoreResult> {
    if (this.abort) {
      return { mode, checkpointId: messageId, canRewind: false, applied: false, error: '会话仍在运行' }
    }
    const result = restoreProviderChatCheckpoint(this.transcript, messageId, mode, dryRun, () => {
      this.rebuildChatHistory()
      this.clearResponsesContext(true)
    })
    if (result.applied) {
      this.emit({
        kind: 'checkpoint-restore',
        messageId,
        mode: 'chat',
        filesChanged: [],
        chatRemovedEntries: result.chatRemovedEntries,
        note: '已恢复到所选消息之前的聊天状态'
      })
    }
    return result
  }

  emitSyntheticEvent(event: AgentEvent): void {
    if (this.disposed) return
    this.emit(event)
  }

  async setPermissionMode(mode: PermissionModeId): Promise<void> {
    this.meta.permissionMode = mode
    this.emit({ kind: 'meta', meta: { ...this.meta } })
  }

  async setTaskStrategy(strategy: SessionMeta['taskStrategy']): Promise<void> {
    this.nativeToolRuntime.rejectAllPending('任务策略已切换，原审批已作废')
    updateTaskStrategyMeta(this.meta, strategy, (meta) => this.emit({ kind: 'meta', meta }))
  }

  async setModel(model: string): Promise<void> {
    if (this.meta.model !== model) this.clearResponsesContext(this.protocol() === 'responses')
    this.protocolOverride = undefined
    this.meta.model = model
    this.emit({ kind: 'meta', meta: { ...this.meta } })
  }

  rename(title: string): void {
    const t = title.trim()
    if (!t) return
    this.meta.title = t.slice(0, 60)
    this.emit({ kind: 'meta', meta: { ...this.meta } })
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposePromise = this.disposeAndWait()
    return this.disposePromise
  }

  private async disposeAndWait(): Promise<void> {
    this.disposed = true
    this.rejectAllPendingPerms('会话已关闭')
    this.abort?.abort()
    this.setStatus('closed')
    const activeTurn = this.activeTurn
    if (activeTurn) await activeTurn.catch(() => undefined)
    this.abort = null
  }

  private async runResponse(payload: SendMessagePayload, controller: AbortController): Promise<void> {
    let auth: OpenAIAuthConfig | undefined
    try {
      const prepared = await this.augmentPayloadWithLayeredMemory(payload)
      this.activeOutboundContext = prepared.manifest
      auth = this.authConfig()
      assertRoutingExpertTargetAllowed(auth.providerId, auth.baseUrl, getSettings().routingExpertPolicy)
      this.modelAttempts.setRouteReason(auth.authorizationRouteReason ?? 'Session uses the configured provider and model')
      this.recoveryState.models(this.meta.providerId).add(this.effectiveModel())
      if (!auth.available && auth.authMode !== 'none') throw new Error(this.missingKeyMessage())
      if (!acquireProviderRequest(this.meta.providerId)) {
        const circuitError = 'Provider circuit is open'
        if (await this.tryFailover(circuitError, payload)) return
        this.emitRecoveryExhausted(circuitError)
        this.finishTurn(true, this.withProviderErrorContext(circuitError), 'error')
        return
      }
      if (auth.keyId) {
        this.recoveryState.keys.add(auth.keyId)
        markProviderKeyUsed(this.meta.providerId, auth.keyId)
      }

      if (this.protocol() === 'chat') {
        await this.runChatCompletion(prepared.payload, controller, auth)
      } else {
        await this.runResponsesLoop(prepared.payload, controller, auth)
      }
      const latency = Date.now() - this.turnStartedAt
      if (auth.keyId) recordProviderKeySuccess(this.meta.providerId, auth.keyId)
      recordSuccess(this.meta.providerId, latency)
      recordModelSuccess(this.effectiveModel(), latency)
      this.finishTurn(false)
    } catch (err) {
      const aborted = controller.signal.aborted
      if (aborted) {
        releaseProviderRequest(this.meta.providerId)
        this.finishTurn(true, '已中断', 'interrupted')
        return
      }
      if (isDigitalWorkerProviderDispatchDeniedError(err)) {
        releaseProviderRequest(this.meta.providerId)
        this.finishTurn(true, err.message, 'policy-denied')
        return
      }
      if (err instanceof OutboundContextPolicyError) {
        releaseProviderRequest(this.meta.providerId)
        this.finishTurn(true, err.message, 'outbound-policy-denied')
        return
      }
      if (isModelAttemptPersistenceError(err)) {
        releaseProviderRequest(this.meta.providerId)
        const phase = err.phase === 'start' ? '启动' : '完成'
        this.finishTurn(true, `模型请求账本${phase}落盘失败，已阻止请求重放:${err.message}`, 'ledger-error')
        return
      }
      const text = errText(unwrapModelAttemptOperationError(err))
      releaseProviderRequest(this.meta.providerId)
      if (await this.tryProviderKeyFailover(text, payload, controller, auth)) return
      recordFailure(this.meta.providerId, text)
      recordModelFailure(this.effectiveModel())
      if (await firstSuccessfulRecovery(
        () => this.tryProviderModelFailover(text, payload, controller),
        () => this.tryFailover(text, payload),
        () => this.tryProtocolFailover(text, payload, controller)
      )) return
      this.emitRecoveryExhausted(text)
      this.finishTurn(true, this.withProviderErrorContext(text), 'error')
    }
  }

  private async augmentPayloadWithLayeredMemory(payload: SendMessagePayload): Promise<{
    payload: SendMessagePayload
    manifest: OutboundContextManifest
  }> {
    const skillPrompt = payload.text.trim()
      ? buildSkillInvocationPrompt({
        enabled: getSettings().autoSkillLearningEnabled,
        projectRoot: this.meta.sourceCwd ?? this.meta.cwd,
        query: payload.text,
        maxSkills: 2
      })
      : ''
    const memory = payload.text.trim()
      ? await buildEffectiveMemoryPrompt({
        rootDir: openAiMemoryRoot(),
        query: payload.text,
        projectRoot: this.meta.sourceCwd ?? this.meta.cwd,
        limit: 6
      }).catch((error) => {
        console.error('[caogen] layered memory retrieval failed:', error)
        return ''
      })
      : ''
    const workerMemory = payload.text.trim()
      ? await buildDigitalWorkerMemoryPrompt(app.getPath('userData'), this.meta)
      : ''
    const handoff = await buildWorkflowStageHandoffPrompt(this.meta, app.getPath('userData'))
      .catch((error) => {
        console.error('[caogen] workflow stage handoff retrieval failed:', error)
        return ''
      })
    const ideDocumentContext = buildIdeDocumentContextPrompt(this.meta.id)
    const additionalItems = openAiAdditionalContextItems({
      memory: [memory, workerMemory].filter(Boolean).join('\n\n'),
      ideDocumentContext,
      handoff,
      hasConversationContext: this.chatHistory.length > 0 || Boolean(this.lastResponseId)
    })
    const outbound = await prepareOutboundContext({
      meta: this.meta,
      rootDir: app.getPath('userData'),
      payload,
      providerId: this.meta.providerId,
      model: this.effectiveModel(),
      additionalItems
    })
    const projectResources = outbound.resourceContext.prompt
    const documentPrompt = documentAttachmentsToPrompt(
      payload.documents ?? [],
      sessionImageAttachmentsRoot(app.getPath('userData'), this.meta.id)
    )
    const enriched = memory.trim() || workerMemory.trim() || skillPrompt.trim() || ideDocumentContext.trim() ||
      handoff.trim() || projectResources.trim() || documentPrompt.trim()
      ? {
        ...payload,
        text: [
          projectResources,
          handoff,
          skillPrompt,
          ideDocumentContext,
          memory,
          workerMemory,
          documentPrompt,
          '## Current User Request',
          payload.text
        ]
          .filter((item) => item.trim().length > 0)
          .join('\n\n')
      }
      : payload
    return { payload: enriched, manifest: outbound.manifest }
  }

  /** 本轮已试过的厂商(防切换打转);send 时重置 */
  private recoveryState = new OpenAiRecoveryState()
  private protocolOverride?: { providerId: string; from: 'responses'; to: 'chat' }
  private recoveryExhaustedEmitted = false
  /** Responses 协议的上一轮 response id(服务端多轮上下文) */
  private lastResponseId?: string
  /** 服务端链不可复用时，从本地耐久事件重建可移植上下文。 */
  private responsesReplayRequired = false
  /** 端点不支持 REST 模式的 previous_response_id 时置 true，后续请求跳过该字段 */
  private previousResponseIdUnsupported = false
  /** 本轮流式累积的 Responses 函数调用(按 output_index 拼装) */
  private pendingResponseCalls: Array<{ callId: string; name: string; argsText: string }> = []
  private static readonly MAX_FAILOVERS_PER_TURN = 3

  /**
   * 恢复前一轮 Responses 链时做严格身份校验。
   * AUTO 模型会把已落盘的实际模型带回本轮，避免重启后错误地从 Provider 首模型续链。
   */
  private restoreResponsesContext(): void {
    const context = this.meta.responsesContext
    if (!context) {
      this.responsesReplayRequired = this.transcript.read().length > 0
      return
    }
    if (!isResponsesConversationContext(context)) {
      this.meta.responsesContext = undefined
      this.responsesReplayRequired = this.transcript.read().length > 0
      return
    }
    if (this.meta.model === AUTO_MODEL) this.routedModel = context.model
    const currentKeyId = this.authConfig().keyId
    const keyMatches = (context.keyId ?? '') === (currentKeyId ?? '')
    const matches = this.protocol() === 'responses' &&
      context.providerId === this.meta.providerId &&
      context.model === this.effectiveModel() &&
      keyMatches
    if (matches) {
      this.lastResponseId = context.responseId
      return
    }
    // 不匹配时 fail closed:保留本地 Transcript，丢弃不可安全复用的服务端链。
    this.meta.responsesContext = undefined
    this.lastResponseId = undefined
    this.responsesReplayRequired = this.transcript.read().length > 0
  }

  private clearResponsesContext(requireReplay = true): void {
    this.lastResponseId = undefined
    if (this.meta.responsesContext) this.meta.responsesContext = undefined
    if (requireReplay) this.responsesReplayRequired = true
  }

  private rememberResponsesContext(responseId: string): void {
    const normalized = responseId.trim()
    if (!normalized || this.protocol() !== 'responses') return
    const previous = this.meta.responsesContext
    const currentKeyId = this.authConfig().keyId
    const context: ResponsesConversationContext = {
      responseId: normalized,
      providerId: this.meta.providerId,
      model: this.effectiveModel(),
      protocol: 'responses',
      ...(currentKeyId ? { keyId: currentKeyId } : {}),
      generation: previous &&
        previous.providerId === this.meta.providerId &&
        previous.model === this.effectiveModel() &&
        previous.protocol === 'responses'
        ? previous.generation + 1
        : 1,
      updatedAt: Date.now()
    }
    this.lastResponseId = normalized
    this.meta.responsesContext = context
    this.responsesReplayRequired = false
    // meta 事件进入 SessionManager 的统一持久化路径，形成重启可恢复的 ledger 游标。
    this.emit({ kind: 'meta', meta: { ...this.meta } })
  }

  /**
   * Responses 协议的 Agent 循环:与 chat 对等地接编码工具。
   * 首轮 input=用户消息;若返回 function_call,执行后以 function_call_output
   * 作为下一轮 input 回灌,并用 previous_response_id 续服务端上下文,直到
   * 无函数调用或达上限。工具的审批/执行复用与 chat 相同的 gateTool/executeCodingTool。
   */
  private async runResponsesLoop(
    payload: SendMessagePayload,
    controller: AbortController,
    auth: OpenAIAuthConfig
  ): Promise<void> {
    const replay = this.responsesReplayRequired
      ? buildPortableConversationReplay(this.transcript.read(), payload.messageId)
      : null
    if (replay) this.refreshConfirmedToolReplay(payload.messageId)
    const confirmedToolReplay = this.activeConfirmedToolReplay
    let input: unknown[] = [
      ...(replay ? [{ role: 'user', content: [{ type: 'input_text', text: replay.text }] }] : []),
      { role: 'user', content: buildInputContent(payload) }
    ]
    if (replay) {
      this.emit({
        kind: 'hook-event',
        event: 'conversation-ledger-replay',
        detail: portableConversationReplayDetail(replay)
      })
    }

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      if (controller.signal.aborted) throw new Error('已中断')
      this.pendingResponseCalls = []
      const instructions = String(this.systemMessage().content ?? '')

      const body = {
        model: this.effectiveModel(),
        instructions,
        input,
        tools: RESPONSES_CODING_TOOLS,
        ...(this.lastResponseId && !this.previousResponseIdUnsupported
          ? { previous_response_id: this.lastResponseId }
          : {}),
        stream: true
      }
      const request = applyProviderRequestOverrides(
        auth.provider,
        openAiEndpoint(auth.baseUrl, 'responses'),
        body,
        openAIRequestHeaders(auth)
      )
      try {
        await this.fetchWithRetry(
          request.url,
          {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal: controller.signal
          },
          controller.signal,
          auth,
          async (res) => {
            if (!res.ok) {
              const errMsg = await formatOpenAIError(res, this.openAIErrorContext(auth))
              // previous_response_id unsupported by endpoint: disable and fall back to full replay
              if (!this.previousResponseIdUnsupported &&
                  errMsg.includes('previous_response_id') &&
                  (res.status === 400 || res.status === 500)) {
                console.warn('[caogen] endpoint does not support previous_response_id; falling back to full context replay')
                this.previousResponseIdUnsupported = true
                this.lastResponseId = undefined
                this.responsesReplayRequired = true
                throw new Error('__PREVIOUS_RESPONSE_ID_UNSUPPORTED__')
              }
              throw new Error(errMsg)
            }
            await this.consumeResponse(res)
          }
        )
      } catch (err) {
        // previous_response_id fallback: rebuild input with full context and retry once
        if (err instanceof Error && err.message === '__PREVIOUS_RESPONSE_ID_UNSUPPORTED__') {
          const replay = buildPortableConversationReplay(this.transcript.read(), payload.messageId)
          input = [
            ...(replay ? [{ role: 'user', content: [{ type: 'input_text', text: replay.text }] }] : []),
            ...input
          ]
          continue
        }
        throw err
      }

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
        const confirmedOutput = await this.confirmedFailoverToolOutput(
          confirmedToolReplay,
          call.name,
          args,
          call.callId
        )
        if (confirmedOutput) {
          outputs.push({
            type: 'function_call_output',
            call_id: call.callId,
            output: confirmedOutput
          })
          continue
        }
        const replayTarget = await this.nativeToolRuntime.describeSideEffectTarget(call.name, args).catch(() => null)
        this.emit({ kind: 'tool-start', toolUseId: call.callId, name: call.name })
        this.emit({
          kind: 'assistant-message',
          blocks: [{ type: 'tool_use', id: call.callId, name: call.name, input: args }]
        })
        const exec = await this.executeToolWithPermission(call.name, args, call.callId, controller.signal)
        const resultText = exec.output, isError = !exec.ok
        const effectStatus = exec.effectStatus
        this.recordGuiToolFailure(call.name, call.callId, resultText, isError)
        this.emit({
          kind: 'tool-result',
          toolUseId: call.callId,
          content: resultText,
          isError,
          ...(exec.exitCode === undefined ? {} : { exitCode: exec.exitCode }),
          ...(exec.commandTermination ? { commandTermination: exec.commandTermination } : {}),
          effectStatus
        })
        this.rememberConfirmedToolReplay({
          toolUseId: call.callId,
          toolName: call.name,
          targetDigest: replayTarget?.targetDigest,
          resultContent: resultText,
          isError,
          effectStatus
        })
        assertToolEffectSettled(effectStatus, call.name, call.callId)
        outputs.push({ type: 'function_call_output', call_id: call.callId, output: resultText })
      }
      input = outputs // 下一轮只发工具结果(previous_response_id 续上文)
    }
    this.appendText(`\n\n[已达单轮工具调用上限 ${MAX_TOOL_ITERATIONS} 次,任务可能未完成;请拆分任务后继续]`)
  }
  /** Recover the current logical request on another model before another Provider. */
  private async tryProviderModelFailover(
    errorText: string,
    payload: SendMessagePayload,
    controller: AbortController
  ): Promise<boolean> {
    const settings = getSettings()
    const providerId = this.meta.providerId?.trim()
    if (this.disposed || !providerId || !this.recoveryState.canRecover(providerId, settings.failoverEnabled)) return false
    const fromModel = this.effectiveModel()
    const failure = classifyFailure(errorText)
    const recovery = planOpenAiProviderModelRecovery({
      providerId,
      fromModel,
      exclude: this.recoveryState.models(providerId),
      fallbackModel: settings.fallbackModel,
      failure,
      outboundContext: this.activeOutboundContext,
      routingExpertPolicy: settings.routingExpertPolicy
    })
    if (!recovery) return false

    const previousProtocol = this.protocol()
    this.refreshConfirmedToolReplay(payload.messageId)
    this.recoveryState.models(providerId).add(recovery.toModel)
    this.recoveryState.recordRecovery()
    if (this.meta.model === AUTO_MODEL) this.routedModel = recovery.toModel
    else this.meta.model = recovery.toModel
    const nextProtocol = this.protocol()
    this.clearResponsesContext(
      previousProtocol === 'responses' || nextProtocol === 'responses' || Boolean(this.lastResponseId)
    )
    this.modelAttempts.setRouteReason(recovery.routeReason)
    this.emit({
      kind: 'provider-model-failover',
      providerId,
      providerName: recovery.providerName,
      fromModel,
      toModel: recovery.toModel,
      reason: recovery.routeReason
    })
    this.emit({ kind: 'meta', meta: { ...this.meta } })
    await this.runResponse(payload, controller)
    return true
  }

  private async tryFailover(errorText: string, payload: SendMessagePayload): Promise<boolean> {
    const settings = getSettings()
    if (this.disposed || !this.recoveryState.canRecover(this.meta.providerId, settings.failoverEnabled)) return false
    if (this.recoveryState.providers.size > OpenAIEngine.MAX_FAILOVERS_PER_TURN) return false
    const failure = classifyFailure(errorText)
    const fromId = this.meta.providerId
    const target = planOpenAiProviderFailover({
      currentProviderId: fromId,
      currentModel: this.effectiveModel(),
      exclude: this.recoveryState.providers,
      fallbackProviderId: settings.fallbackProviderId,
      fallbackModel: settings.fallbackModel,
      failure,
      currentProtocol: this.protocol(),
      outboundContext: this.activeOutboundContext,
      routingExpertPolicy: settings.routingExpertPolicy
    })
    if (!target) return false

    this.refreshConfirmedToolReplay(payload.messageId)
    const requiresPortableReplay = this.protocol() === 'responses' || Boolean(this.lastResponseId)
    this.recoveryState.providers.add(target.providerId)
    this.recoveryState.recordRecovery()
    this.meta.providerId = target.providerId
    this.protocolOverride = undefined
    if (target.model) {
      if (this.meta.model === AUTO_MODEL) this.routedModel = target.model
      else this.meta.model = target.model
    }
    // Responses 的 response id 不跨厂商;换家后重新开始服务端上下文链
    this.clearResponsesContext(requiresPortableReplay)
    this.modelAttempts.setRouteReason(target.routeReason)
    this.emit({
      kind: 'failover',
      fromProviderId: fromId,
      toProviderId: target.providerId,
      fromName: target.fromName,
      toName: target.name,
      model: target.model,
      reason: target.routeReason
    })
    this.emit({ kind: 'meta', meta: { ...this.meta } })

    const controller = new AbortController()
    this.abort = controller
    await this.runResponse(payload, controller)
    return true
  }

  private async tryProtocolFailover(
    errorText: string,
    payload: SendMessagePayload,
    controller: AbortController
  ): Promise<boolean> {
    const settings = getSettings()
    const providerId = this.meta.providerId?.trim()
    if (this.disposed || !providerId || !this.recoveryState.canRecover(providerId, settings.failoverEnabled)
      || this.protocol() !== 'responses') return false
    const recovery = planOpenAiProtocolRecovery({
      providerId,
      model: this.effectiveModel(),
      currentProtocol: this.protocol(),
      failure: classifyFailure(errorText)
    })
    if (!recovery) return false

    this.refreshConfirmedToolReplay(payload.messageId)
    this.clearResponsesContext(true)
    this.protocolOverride = { providerId, from: recovery.fromProtocol, to: recovery.toProtocol }
    this.recoveryState.recordRecovery()
    this.modelAttempts.setRouteReason(recovery.routeReason)
    this.emit({
      kind: 'provider-protocol-failover',
      providerId,
      providerName: recovery.providerName,
      model: recovery.model,
      fromProtocol: recovery.fromProtocol,
      toProtocol: recovery.toProtocol,
      reason: recovery.routeReason
    })
    await this.runResponse(payload, controller)
    return true
  }

  private emitRecoveryExhausted(errorText: string): void {
    const settings = getSettings()
    if (this.recoveryExhaustedEmitted
      || !this.recoveryState.isEnabled(this.meta.providerId, settings.failoverEnabled)) return
    const failure = classifyFailure(errorText)
    if (!failure.switchable) return
    const providerId = this.meta.providerId?.trim()
    if (!providerId) return
    this.recoveryExhaustedEmitted = true
    this.emit({
      kind: 'provider-recovery-exhausted',
      engine: 'openai',
      providerId,
      providerName: listProviders().find((provider) => provider.id === providerId)?.name ?? providerId,
      model: this.effectiveModel(),
      reason: failure.label
    })
  }

  private async tryProviderKeyFailover(
    errorText: string,
    payload: SendMessagePayload,
    controller: AbortController,
    auth: OpenAIAuthConfig | undefined
  ): Promise<boolean> {
    if (!auth) return false
    const settings = getSettings()
    if (this.disposed || !this.meta.providerId || !auth.keyId
      || !this.recoveryState.canRecover(this.meta.providerId, settings.failoverEnabled)) return false
    const failure = classifyFailure(errorText)
    if (!canRotateProviderKey(failure)) return false
    if (auth.authorizationAccountId) {
      if (auth.authorizationAccountExplicit) return false
      const next = recordProviderAuthorizationAccountFailure(this.meta.providerId, auth.authorizationAccountId)
      if (!next.account) return false
      this.refreshConfirmedToolReplay(payload.messageId)
      this.recoveryState.recordRecovery()
      this.clearResponsesContext(this.protocol() === 'responses')
      this.modelAttempts.setRouteReason(`OAuth account failover: ${failure.label}; ${next.reason}`)
      await this.runResponse(payload, controller)
      return true
    }
    const rotation = rotateProviderKey({
      providerId: this.meta.providerId,
      failedKeyId: auth.keyId,
      excludedKeyIds: this.recoveryState.keys,
      reason: failure.label
    })
    if (!rotation) return false

    this.refreshConfirmedToolReplay(payload.messageId)
    this.recoveryState.keys.add(rotation.toKeyId)
    this.recoveryState.recordRecovery()
    this.clearResponsesContext(this.protocol() === 'responses')
    this.modelAttempts.setRouteReason(`Provider key failover: ${failure.label}`)
    this.emit({
      kind: 'provider-key-failover',
      providerId: rotation.providerId,
      providerName: rotation.providerName,
      fromKeyId: rotation.fromKeyId,
      fromKeyLabel: rotation.fromKeyLabel,
      toKeyId: rotation.toKeyId,
      toKeyLabel: rotation.toKeyLabel,
      reason: failure.label
    })
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
    auth: OpenAIAuthConfig
  ): Promise<void> {
    const replayRequired = this.responsesReplayRequired
    const replayEntries = replayRequired ? this.transcript.read() : []
    if (replayRequired) this.refreshConfirmedToolReplay(payload.messageId)
    const confirmedToolReplay = this.activeConfirmedToolReplay
    if (replayRequired) {
      const replay = buildPortableConversationReplay(replayEntries, payload.messageId)
      if (replay) {
        this.chatHistory = [{ role: 'system', content: replay.text }]
        this.emit({
          kind: 'hook-event',
          event: 'conversation-ledger-replay',
          detail: portableConversationReplayDetail(replay)
        })
      }
      this.responsesReplayRequired = false
    }
    const userMessage: ChatMessage = { role: 'user', content: buildChatContent(payload) }
    this.chatHistory.push(userMessage)

    try {
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        if (controller.signal.aborted) throw new Error('已中断')
        this.pendingToolCalls = []
        // 每次循环重置流式文本缓冲(assistantText 聚合本轮所有文本段)
        const textBefore = this.assistantText
        const system = this.systemMessage()
        // 每次模型请求前评估上下文压力;压缩只落在 user 轮边界,不会切断 tool_call/tool_result 配对。
        await this.compressHistoryIfNeeded(auth, system)

        const baseBody = {
          model: this.effectiveModel(),
          messages: [system, ...this.chatHistory],
          tools: OPENAI_CODING_TOOLS,
          stream: true,
          stream_options: { include_usage: true }
        }
        const adaptation = adaptChatCompletionRequest(baseBody, this.providerAdapterContext())
        for (const warning of adaptation.warnings) {
          this.emit({ kind: 'hook-event', event: 'provider-adapter', detail: warning })
        }
        const request = applyProviderRequestOverrides(
          auth.provider,
          openAiEndpoint(auth.baseUrl, 'chat/completions'),
          adaptation.body as unknown as Record<string, unknown>,
          openAIRequestHeaders(auth)
        )
        await this.fetchWithRetry(
          request.url,
          {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal: controller.signal
          },
          controller.signal,
          auth,
          async (res) => {
            if (!res.ok) throw new Error(await formatOpenAIError(res, this.openAIErrorContext(auth)))
            await this.consumeChatStream(res)
          }
        )

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
          const confirmedOutput = await this.confirmedFailoverToolOutput(
            confirmedToolReplay,
            call.name,
            args,
            call.id
          )
          if (confirmedOutput) {
            this.chatHistory.push({ role: 'tool', tool_call_id: call.id, content: confirmedOutput })
            continue
          }
          const replayTarget = await this.nativeToolRuntime.describeSideEffectTarget(call.name, args).catch(() => null)
          this.emit({ kind: 'tool-start', toolUseId: call.id, name: call.name })
          this.emit({
            kind: 'assistant-message',
            blocks: [{ type: 'tool_use', id: call.id, name: call.name, input: args }]
          })
          const exec = await this.executeToolWithPermission(call.name, args, call.id, controller.signal)
          const resultText = exec.output, isError = !exec.ok
          const effectStatus = exec.effectStatus
          this.recordGuiToolFailure(call.name, call.id, resultText, isError)
          this.emit({
            kind: 'tool-result',
            toolUseId: call.id,
            content: resultText,
            isError,
            ...(exec.exitCode === undefined ? {} : { exitCode: exec.exitCode }),
            ...(exec.commandTermination ? { commandTermination: exec.commandTermination } : {}),
            effectStatus
          })
          this.rememberConfirmedToolReplay({
            toolUseId: call.id,
            toolName: call.name,
            targetDigest: replayTarget?.targetDigest,
            resultContent: resultText,
            isError,
            effectStatus
          })
          assertToolEffectSettled(effectStatus, call.name, call.id)
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
   * chat 历史压缩:上下文达到 90% 自动压缩阈值时,把"较旧的一段"摘要成一条 system 便签,
   * 保留最近若干轮原文。关键约束 —— 绝不切断 tool_call 配对:切点必须落在
   * 一条 user 消息之前(user 一定是干净的轮边界)。摘要失败则跳过压缩(不阻塞对话)。
   */
  private async compressHistoryIfNeeded(auth: OpenAIAuthConfig, systemMessage: ChatMessage): Promise<void> {
    const before = this.currentContextUsage(systemMessage)
    this.recordContextUsage(before)
    if (!before.shouldCompress) return

    // 找切点:保留末尾 DEFAULT_KEEP_RECENT_MESSAGES 条内、最靠前的一个 user 边界。
    // 切点之前的消息被摘要;之后(含该 user)保留原文。
    const boundary = planCompressionBoundary(this.chatHistory, DEFAULT_KEEP_RECENT_MESSAGES)
    if (!boundary.canCompress) return // 没有可压缩的旧段(全是近期轮次)

    const older = this.chatHistory.slice(0, boundary.keepFrom)
    const recent = this.chatHistory.slice(boundary.keepFrom)
    const summary = await this.summarize(older, auth).catch((error) => {
      if (isModelAttemptPersistenceError(error)) throw error
      this.modelAttempts.discardPendingFailover()
      return null
    })
    if (!summary) return // 摘要失败:保持原样,下轮再试

    this.chatHistory = [
      { role: 'system', content: `[早期对话摘要 · 由 CaoGen 自动压缩]\n${summary}` },
      ...recent
    ]
    const after = this.currentContextUsage(systemMessage)
    this.recordContextUsage(after)
    this.emit({
      kind: 'hook-event',
      event: 'context-compressed',
      detail: `上下文 ${Math.round(before.usageRatio * 100)}% 触发自动压缩:压缩 ${older.length} 条历史为摘要,保留最近 ${recent.length} 条;估算 token ${before.usedTokens} → ${after.usedTokens}`
    })
  }

  private currentContextUsage(systemMessage: ChatMessage): ContextUsageState {
    return evaluateContextUsage({
      usedTokens: estimateContextTokens([systemMessage, ...this.chatHistory]),
      model: this.effectiveModel()
    })
  }

  private recordContextUsage(state: ContextUsageState): void {
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

  private recordContextTokens(usedTokens: number): void {
    this.recordContextUsage(evaluateContextUsage({ usedTokens, model: this.effectiveModel() }))
  }

  /** 用当前模型把一段历史压成简洁中文摘要(非流式,低温度,不带工具) */
  private async summarize(
    messages: ChatMessage[],
    auth: OpenAIAuthConfig
  ): Promise<string | null> {
    const transcript = messages
      .map((m) => {
        const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : m.role === 'tool' ? '工具' : '系统'
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        return `${role}: ${text.slice(0, 2000)}`
      })
      .join('\n')
      .slice(0, 40_000)
    const body = {
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
    }
    const request = applyProviderRequestOverrides(
      auth.provider,
      openAiEndpoint(auth.baseUrl, 'chat/completions'),
      body,
      openAIRequestHeaders(auth)
    )
    return this.fetchWithRetry(
      request.url,
      {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body)
      },
      this.abort?.signal ?? new AbortController().signal,
      auth,
      async (res) => {
        if (!res.ok) throw new Error(await formatOpenAIError(res, this.openAIErrorContext(auth)))
        const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
        this.applyChatUsage(json)
        const choices = Array.isArray(json?.choices) ? (json.choices as Array<Record<string, unknown>>) : []
        const message = choices[0]?.message as Record<string, unknown> | undefined
        const text = typeof message?.content === 'string' ? message.content.trim() : ''
        if (!text) throw new Error('上下文摘要响应缺少 content')
        return text
      }
    )
  }

  /** 编码 Agent 系统提示:工作目录 + 人设(每请求现算,设置变更即时生效) */
  private systemMessage(): ChatMessage {
    const settings = getSettings()
    const persona = settings.persona.trim()
    const projectContext = buildProjectContextSystemAppendSync(this.meta.sourceCwd ?? this.meta.cwd)
    const providerPrompt = buildChinaProviderPromptAppend(this.providerAdapterContext())
    const lines = [
      projectContext,
      providerPrompt,
      taskStrategySystemPrompt(this.meta.taskStrategy),
      '你是 CaoGen 桌面工作室里的编码 Agent。',
      `当前工作目录: ${this.meta.cwd}`,
      '你可以使用工具(bash/view/read_file/write_file/search_replace/edit_file/create_document/create_spreadsheet/create_presentation/create_pdf/list_dir/search_symbol/search_code/find_file/get_dependencies/task_decompose/genesis_orchestrate/task_dispatch_dag/task_decompose_and_dispatch_dag/git_status/git_diff/git_stage/git_stage_all/git_commit/git_push/git_create_pr/git_create_issue/git_merge/code_forge_delivery/send_notification)读写项目文件、生成 Word/Excel/PowerPoint/PDF 办公成品、执行命令、规划编排、发送已配置通知并完成 Git 流程。',
      '开始任务时先用 search_symbol/search_code/find_file 定位相关文件和符号,不要盲猜路径;修改文件前用 get_dependencies 查看正向/反向依赖影响面。',
      '开始修改前再用 view 查看相关行号和上下文;已有文件编辑必须优先用 search_replace,old_str 至少包含前后 3 行上下文并保证唯一匹配。',
      'search_replace 失败时根据返回的相似片段修正 old_str 后重试;禁止因为匹配失败就改用 write_file 全量覆盖。write_file 仅用于新建文件或确需整体重写的文件。',
      '修改前可用 search_replace dry_run=true 预览 diff;完成后简要说明改动、测试和备份路径。',
      '涉及提交、推送、创建 PR/MR、创建 Issue 或合并分支时,先用 git_status/git_diff 核对改动;提交前优先用 git_stage 精确暂存文件,仅在确认当前范围全部改动都应纳入时使用 git_stage_all,禁止用 bash git add 绕过可对账的 Git index Effect;验证命令必须作为显式 bash 工具单独执行和审批,git_commit 不会隐式运行 caogen.md 命令或 Git hooks;code_forge_delivery 仅生成 report/patch,不会执行验证、暂存、提交、推送或创建 PR;git_stage_all/git_push/git_create_pr/git_create_issue/git_merge 属高风险操作,必须尊重权限审批和失败输出。',
      '复杂或跨模块任务先用 task_decompose 生成 DAG;用户明确要求 Genesis/多 Agent/隔离交付时,优先用 genesis_orchestrate 生成可审查的编排/验证/交付协议。genesis_orchestrate 第一版只规划,不会真实控制外部子 Agent、不会创建 worktree、不会提交或推送。',
      '只有在用户明确要求并通过权限审批后,才使用 task_dispatch_dag 或 task_decompose_and_dispatch_dag 启动子任务调度;Spark/Core/Forge 不应默认推动 Genesis 编排,Command/Genesis 才是编排类任务的目标档位。',
      settings.guiAutomationEnabled
        ? '如需操作真实桌面应用,可使用 gui_list_windows/gui_activate_window/gui_screenshot/gui_click/gui_type/gui_scroll/gui_hotkey;这些高风险工具必须由用户审批或临时授权。'
        : 'GUI 自动化工具默认关闭;除非用户在设置中启用并审批,不要尝试操作真实桌面应用。',
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
    this.recordTurnUsage(totals)
  }

  /**
   * 当前 Provider 的 OpenAI 协议。显式配置优先;未配置时按端点选择协议默认:
   * OpenAI 原生端点(或历史未配 Provider)→ responses;任何第三方端点 → chat
   * (Chat Completions 是通用协议,第三方几乎都不实现 Responses ——
   * 之前默认 responses 会让 DeepSeek/网关直接 404)。
   */
  private protocol(): OpenAIProtocol {
    const provider = this.meta.providerId ? getProvider(this.meta.providerId) : undefined
    const target = provider
      ? resolveProviderRuntimeTarget(provider, { appId: 'openai', model: this.requestedModel() })
      : undefined
    const configured = resolveOpenAIProtocol(target ?? { baseUrl: '', protocol: undefined })
    return this.protocolOverride?.providerId === this.meta.providerId &&
      this.protocolOverride.from === configured
      ? this.protocolOverride.to
      : configured
  }

  private async consumeResponse(res: Response): Promise<void> {
    if (!res.body) {
      const json = await res.json().catch(() => null)
      const text = extractResponseText(json)
      if (text) this.appendText(text)
      this.applyUsage(json)
      const responseId = json && typeof json === 'object' && !Array.isArray(json)
        ? (json as Record<string, unknown>).id
        : undefined
      if (typeof responseId === 'string') this.rememberResponsesContext(responseId)
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
        if (typeof responseId === 'string' && responseId) this.rememberResponsesContext(responseId)
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
  private async fetchWithRetry<T>(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    auth: OpenAIAuthConfig,
    consume: (response: Response) => Promise<T>
  ): Promise<T> {
    const streaming = providerRequestIsStreaming(init.body)
    const timeouts = providerRequestTimeouts(auth.provider)
    const providerId = this.meta.providerId || 'openai'
    const model = this.effectiveModel()
    const protocol = this.protocol() === 'chat' ? 'openai.chat-completions' : 'openai.responses'
    const deadlines = new WeakMap<Response, ProviderRequestDeadline>()
    return this.modelAttempts.fetch({
      run: taskRuntimeRegistry.get(this.meta.id),
      providerId,
      model,
      protocol,
      url,
      init: { ...init, signal },
      signal,
      auth: { keyId: auth.keyId, keyLabel: auth.keyLabel },
      estimateCost: (usage) => estimateModelAttemptCostUsd({ providerId, model, protocol }, usage),
      executeFetch: async (operationId) => {
        const deadline = new ProviderRequestDeadline(signal, timeouts, streaming)
        try {
          const response = await this.executeProviderFetch(url, { ...init, signal: deadline.signal }, auth, operationId)
          deadlines.set(response, deadline)
          return response
        } catch (error) {
          deadline.finish()
          throw deadline.errorOr(error)
        }
      },
      preflight: async () => {
        await assertDigitalWorkerProviderDispatchAllowed(this.meta, app.getPath('userData'), {
          providerId,
          model,
          protocol
        })
        const manifest = this.activeOutboundContext
        if (!manifest) {
          throw new OutboundContextPolicyError(
            'OUTBOUND_CONTEXT_STALE',
            '模型请求缺少外发上下文清单，已阻止发送'
          )
        }
        await assertOutboundContextAllowed({
          manifest,
          rootDir: app.getPath('userData'),
          providerId: this.meta.providerId || 'openai',
          model: this.effectiveModel(),
          engine: this.meta.engine
        })
      },
      readUsage: () => this.turnUsage,
      consume: async (response) => {
        const deadline = deadlines.get(response)
        if (!deadline) return consume(response)
        try {
          return await consume(deadline.wrapResponse(response))
        } catch (error) {
          throw deadline.errorOr(error)
        } finally {
          deadline.finish()
        }
      }
    })
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
    if (this.disposed) return
    if (active?.signal.aborted && !isError) return

    const guiFailureText = this.formatGuiToolFailures()
    if (!isError && guiFailureText) {
      isError = true
      subtype = 'tool-error'
      resultText = guiFailureText
    }

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
    if (this.activeMessageId && this.turnRevisionEligible && !this.turnHadToolEvents) {
      this.emit({
        kind: 'checkpoint',
        messageId: providerChatCheckpointId(this.activeMessageId),
        userMessageId: this.activeMessageId,
        scope: 'chat'
      })
    }
    this.activeMessageId = undefined
    this.activeConfirmedToolReplay = new Map()
    this.turnRevisionEligible = false
    this.turnHadToolEvents = false
    if (isError && resultText) this.setStatus('error', resultText)
    else this.setStatus('idle')
  }

  private recordGuiToolFailure(toolName: string, toolUseId: string, resultText: string, isError: boolean): void {
    if (!isError || !isGuiToolName(toolName)) return
    this.turnGuiToolFailures.push({
      toolName,
      toolUseId,
      detail: summarizeToolFailure(resultText)
    })
  }

  private formatGuiToolFailures(): string | undefined {
    if (this.turnGuiToolFailures.length === 0) return undefined
    const failures = this.turnGuiToolFailures
      .slice(0, 5)
      .map((failure) => `${failure.toolName}(${failure.toolUseId}): ${failure.detail}`)
      .join('；')
    const suffix = this.turnGuiToolFailures.length > 5 ? `；另有 ${this.turnGuiToolFailures.length - 5} 个 GUI 工具失败` : ''
    return `GUI 工具失败，任务未标记为成功: ${failures}${suffix}`
  }

  private applyUsage(value: unknown): void {
    const usage = normalizeOpenAIUsage((value as Record<string, unknown> | null)?.usage)
    if (!usage) return
    this.recordTurnUsage(usage)
  }
  private recordTurnUsage(usage: UsageTotals): void {
    this.turnUsage = addUsageTotals(this.turnUsage, usage)
    this.meta.usage = this.turnUsage
    this.recordContextTokens(usage.input + usage.cacheRead + usage.cacheCreation)
  }
  /** 缺 key 文案:用当前 Provider 名而非写死 'OpenAI'(DeepSeek 等场景不再误导) */
  private missingKeyMessage(): string {
    const provider = this.meta.providerId ? getProvider(this.meta.providerId) : undefined
    const name = provider?.name || 'OpenAI'
    return `${name} 缺少 API Key:请在设置里为该 Provider 填写密钥,或设置 OPENAI_API_KEY。`
  }

  private authConfig(): OpenAIAuthConfig {
    const provider = this.meta.providerId ? getProvider(this.meta.providerId) : undefined
    return resolveOpenAiAuthConfig({
      provider,
      providerId: this.meta.providerId,
      model: this.requestedModel(),
      protocol: this.protocol()
    })
  }

  private async executeProviderFetch(
    url: string,
    init: RequestInit,
    auth: OpenAIAuthConfig,
    operationId: string
  ): Promise<Response> {
    const scope = providerCredentialScopeForSession(this.meta, auth.providerId, operationId)
    const currentProvider = auth.provider ? getProvider(auth.providerId) : undefined
    if (currentProvider && auth.authorizationAccountId) {
      const account = await issueProviderAuthorizationAccountLease(
        { ...currentProvider, baseUrl: auth.baseUrl },
        auth.authorizationAccountId,
        scope
      )
      return fetchWithProviderCredentialLease({
        provider: account.credentialProvider,
        lease: account.lease,
        scope,
        url,
        init: {
          ...init,
          headers: {
            ...openAIRequestHeaders(auth),
            ...((init.headers ?? {}) as Record<string, string>),
            ...parseProviderHeaders(account.credentialProvider.customHeaders)
          }
        }
      })
    }
    await ensureProviderAuthorizationFresh(auth.providerId)
    const selection = currentProvider
      ? issueProviderCredentialLease(currentProvider, scope, {}, auth.keyId)
      : issueDirectProviderCredentialLease(
          auth.providerId,
          auth.keyId || 'environment:OPENAI_API_KEY',
          process.env.OPENAI_API_KEY || '',
          scope
        )
    if (auth.authMode !== 'none' && (!selection.available || !selection.lease)) {
      throw new Error('Provider credential lease is unavailable')
    }
    return fetchWithProviderCredentialLease({
      provider: currentProvider ?? auth.provider,
      lease: selection.lease,
      scope,
      url,
      init: {
        ...init,
        headers: {
          ...openAIRequestHeaders(auth),
          ...((init.headers ?? {}) as Record<string, string>)
        }
      }
    })
  }

  private requestedModel(): string {
    if (this.meta.model && this.meta.model !== AUTO_MODEL) return this.meta.model
    if (this.routedModel) return this.routedModel
    const provider = this.meta.providerId ? getProvider(this.meta.providerId) : undefined
    return provider?.models?.[0] || process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL
  }

  private effectiveModel(): string {
    const provider = this.meta.providerId ? getProvider(this.meta.providerId) : undefined
    if (this.meta.model && this.meta.model !== AUTO_MODEL) {
      return provider
        ? resolveProviderRuntimeTarget(provider, { appId: 'openai', model: this.meta.model }).model
        : this.meta.model
    }
    if (this.routedModel) return this.routedModel // auto 模式:本轮路由结果
    const fallback = provider?.models?.[0] || process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL
    return provider
      ? resolveProviderRuntimeTarget(provider, { appId: 'openai', model: fallback }).model
      : fallback
  }

  private emit(event: AgentEvent): void {
    if (event.kind === 'tool-start' || event.kind === 'tool-result' ||
        event.kind === 'permission-request' || event.kind === 'permission-resolved') {
      this.turnHadToolEvents = true
    }
    this.emitRaw(event)
  }

  private setStatus(status: SessionMeta['status'], error?: string): void {
    this.meta.status = status
    if (error) this.meta.lastError = error
    this.emit({ kind: 'status', status, error })
  }

  private providerAdapterContext(): ProviderAdapterContext {
    const provider = this.meta.providerId ? getProvider(this.meta.providerId) : undefined
    return { provider, model: this.effectiveModel() }
  }

  private openAIErrorContext(auth: { baseUrl: string }): OpenAIErrorContext {
    const provider = this.meta.providerId ? getProvider(this.meta.providerId) : undefined
    return {
      providerId: this.meta.providerId || 'none',
      providerName: provider?.name || this.meta.providerId || 'OpenAI',
      baseUrl: redactProviderBaseUrl(auth.baseUrl),
      model: this.effectiveModel(),
      protocol: this.protocol()
    }
  }

  private withProviderErrorContext(message: string): string {
    const auth = this.authConfig()
    return `${redactProviderErrorText(message)}\n${formatProviderErrorContext(this.openAIErrorContext(auth))}`
  }
}

function openAIRequestHeaders(auth: OpenAIAuthConfig): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...auth.headers
  }
}

function openAiAdditionalContextItems(input: {
  memory: string
  ideDocumentContext: string
  handoff: string
  hasConversationContext: boolean
}): OutboundContextItemView[] {
  const items: OutboundContextItemView[] = []
  const add = (
    present: boolean,
    id: string,
    kind: OutboundContextItemView['kind'],
    label: string,
    dataClass: OutboundContextItemView['dataClass']
  ): void => {
    if (!present) return
    items.push({ id, kind, label, dataClass, egressPolicy: 'allow', decision: 'included' })
  }
  add(Boolean(input.memory.trim()), 'context:memory', 'memory_context', 'Local memory matches', 'S2')
  add(Boolean(input.ideDocumentContext.trim()), 'context:ide', 'ide_context', 'IDE document context', 'S2')
  add(Boolean(input.handoff.trim()), 'context:workflow', 'workflow_context', 'Workflow handoff', 'S4')
  add(input.hasConversationContext, 'context:conversation', 'conversation_context', 'Conversation history', 'S2')
  return items
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

function openAiMemoryRoot(): string {
  return process.env.CAOGEN_MEMORY_DIR || resolve(homedir(), '.caogen', 'memory')
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

function summarizeToolFailure(resultText: string): string {
  const clipped = clipText(resultText.trim() || '工具返回错误')
  try {
    const parsed = JSON.parse(resultText) as Record<string, unknown>
    const parts: string[] = []
    if (typeof parsed.error === 'string' && parsed.error.trim()) parts.push(parsed.error.trim())
    if (typeof parsed.screenCapturePermission === 'string') parts.push(`screenCapturePermission=${parsed.screenCapturePermission}`)
    if (typeof parsed.sourceCount === 'number') parts.push(`sourceCount=${parsed.sourceCount}`)
    if (parts.length > 0) return clipText(parts.join('；'))
  } catch {
    // 非 JSON 工具输出直接截断展示。
  }
  return clipped
}

function clipText(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}...[truncated]` : text
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

async function formatOpenAIError(res: Response, context?: OpenAIErrorContext): Promise<string> {
  const text = await res.text().catch(() => '')
  const prefix = `OpenAI 返回 ${res.status}${statusHint(res.status)}`
  const suffix = context ? `\n${formatProviderErrorContext(context)}` : ''
  try {
    const json = JSON.parse(text) as Record<string, unknown>
    return `${prefix}: ${redactProviderErrorText(extractErrorMessage(json.error) || text || res.statusText)}${suffix}`
  } catch {
    return `${prefix}: ${redactProviderErrorText(text || res.statusText)}${suffix}`
  }
}

function statusHint(status: number): string {
  if (status === 401 || status === 403) return '(认证/权限错误)'
  if (status === 404) return '(模型名或端点不存在)'
  if (status === 429) return '(限流/余额不足)'
  if (status >= 500) return '(网关或上游服务错误)'
  return ''
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

function assertToolEffectSettled(
  status: EffectStatus | undefined,
  toolName: string,
  toolUseId: string
): void {
  if (status === 'waiting_reconciliation') {
    throw new Error(`工具效果状态未知,需先完成对账:${toolName}(${toolUseId})`)
  }
}

export const openAIEngineFactory: EngineFactory = {
  kind: 'openai',
  label: 'OpenAI 协议(Responses / Chat Completions)',
  available: () => true,
  create: (
    meta: SessionMeta,
    emit: EngineEmit,
    resumeSdkSessionId?: string,
    initialEventSeq?: number
  ): Engine => new OpenAIEngine(meta, emit, resumeSdkSessionId, initialEventSeq)
}
