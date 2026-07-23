import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { imageAttachmentRefToContentBlock, sessionImageAttachmentsRoot } from './attachmentOps'
import {
  aggregateAnthropicUsage,
  appendMissingSuffix,
  anthropicErrorText,
  anthropicToolResultBlock,
  assistantEventBlocks,
  assistantHistoryContent,
  buildAnthropicUserContent,
  durableImageReferences,
  finalStopFailure,
  rebuildAnthropicHistory
} from './anthropic-history'
import {
  streamAnthropicMessage,
  type AnthropicMessagesContentBlock,
  type AnthropicMessagesMessage,
  type AnthropicMessagesRequest,
  type AnthropicMessagesResult,
  type AnthropicMessagesTool,
  type AnthropicMessagesToolInputSchema,
  type AnthropicMessagesToolUseBlock
} from './anthropicMessagesAdapter'
import { NativeToolRuntime, type NativeToolExecutionResult } from './native-tool-runtime'
import { OPENAI_CODING_TOOLS } from './openaiTools'
import {
  listProviders, markProviderKeyUsed, recordProviderKeySuccess, rotateProviderKey
} from './providers'
import { canRotateProviderKey } from './providerKeyRouting'
import { resolveAnthropicMessagesTarget, type AnthropicMessagesTarget } from './provider/anthropicMessagesTarget'
import { getSettings } from './settings'
import {
  classifyFailure, pickFailoverTarget, recordFailure, recordSuccess, type FailureClass
} from './scheduler'
import { normalizeStableMessagePayload, type StableMessagePayload } from './stable-message-payload'
import { AnthropicModelAttemptTracker, type AnthropicModelAttemptInput } from './task/anthropic-model-attempt-runtime'
import {
  isModelAttemptOperationError, isModelAttemptPersistenceError, unwrapModelAttemptOperationError
} from './task/model-attempt-runtime'
import { runHasUnresolvedEffects } from './task/effect-runtime'
import { taskRuntimeRegistry } from './task/task-runtime-registry'
import {
  assertDigitalWorkerProviderDispatchAllowed,
  isDigitalWorkerProviderDispatchDeniedError
} from './digital-worker/session-action-policy'
import { TranscriptWriter } from './transcript'
import { AUTO_MODEL } from '../shared/types'
import type { Engine, EngineEmit } from './engine'
import type {
  AgentEvent,
  PermissionModeId,
  PermissionRequestInfo,
  SendMessagePayload,
  SessionMeta,
  TaskRunRecord,
  TranscriptEntry,
  UserMessageAttachmentView,
  UsageTotals
} from '../shared/types'

const DEFAULT_MAX_TOKENS = 8192
const MAX_MESSAGES_REQUESTS_PER_TURN = 40
/** Anthropic tool declarations derive from the shared native coding-tool source. */
export const ANTHROPIC_CODING_TOOLS: AnthropicMessagesTool[] = OPENAI_CODING_TOOLS.map((tool) => ({
  name: tool.function.name,
  description: tool.function.description,
  input_schema: tool.function.parameters as AnthropicMessagesToolInputSchema
}))

interface AnthropicAttemptExecutor {
  startTurn(messageId: string): void
  execute(input: AnthropicModelAttemptInput): Promise<AnthropicMessagesResult>
}

interface AnthropicAttemptLineage {
  requestId: string
  failoverFromAttemptId: string
  routeReason: string
}

interface AnthropicMessageResponse {
  result: AnthropicMessagesResult
  target: AnthropicMessagesTarget
}

interface AnthropicRecoveryTarget {
  target: AnthropicMessagesTarget
  routeReason: string
}

export interface AnthropicEngineDependencies {
  resolveTarget(input: { providerId: string; model?: string }): AnthropicMessagesTarget
  streamMessage: typeof streamAnthropicMessage
  getRun(sessionId: string): TaskRunRecord | undefined
  modelAttempts: AnthropicAttemptExecutor
  listProviders: typeof listProviders
  getSettings: typeof getSettings
  classifyFailure: typeof classifyFailure
  canRotateProviderKey: typeof canRotateProviderKey
  rotateProviderKey: typeof rotateProviderKey
  pickFailoverTarget: typeof pickFailoverTarget
  markProviderKeyUsed: typeof markProviderKeyUsed
  recordProviderKeySuccess: typeof recordProviderKeySuccess
  recordFailure: typeof recordFailure
  recordSuccess: typeof recordSuccess
  resolveImageAttachment(reference: UserMessageAttachmentView): AnthropicMessagesContentBlock
}

/** Native Anthropic Messages engine registered under the distinct `anthropic` kind. */
export class AnthropicEngine implements Engine {
  readonly meta: SessionMeta
  private readonly transcript: TranscriptWriter
  private readonly emitRaw: (event: AgentEvent) => void
  private readonly dependencies: AnthropicEngineDependencies
  private readonly nativeToolRuntime: NativeToolRuntime
  private abort: AbortController | null = null
  private activeTurn: Promise<void> | null = null
  private disposePromise: Promise<void> | null = null
  private disposed = false
  private turnStartedAt = 0
  private assistantText = ''
  private thinkingText = ''
  private turnUsage: UsageTotals | undefined
  private history: AnthropicMessagesMessage[] = []
  private resolvedModel?: string
  private triedProviders = new Set<string>()
  private triedProviderKeys = new Map<string, Set<string>>()
  private turnCredentialTokens = new Set<string>()

  constructor(
    meta: SessionMeta,
    emit: EngineEmit,
    resumeSdkSessionId?: string,
    initialEventSeq = 0,
    dependencies: Partial<AnthropicEngineDependencies> = {}
  ) {
    this.meta = meta
    this.transcript = new TranscriptWriter(resumeSdkSessionId, initialEventSeq)
    this.emitRaw = (event) => {
      const entry = this.transcript.nextEntry(event)
      emit(event, entry.seq, entry)
    }
    this.dependencies = {
      resolveTarget: resolveAnthropicMessagesTarget,
      streamMessage: streamAnthropicMessage,
      getRun: (sessionId) => taskRuntimeRegistry.get(sessionId),
      modelAttempts: new AnthropicModelAttemptTracker(),
      listProviders,
      getSettings,
      classifyFailure,
      canRotateProviderKey,
      rotateProviderKey,
      pickFailoverTarget,
      markProviderKeyUsed,
      recordProviderKeySuccess,
      recordFailure,
      recordSuccess,
      resolveImageAttachment: (reference) => imageAttachmentRefToContentBlock(
        reference,
        sessionImageAttachmentsRoot(app.getPath('userData'), meta.id)
      ) as AnthropicMessagesContentBlock,
      ...dependencies
    }
    this.nativeToolRuntime = new NativeToolRuntime(this.meta, (event) => this.emit(event))
    this.history = rebuildAnthropicHistory(
      this.transcript.readAll(),
      this.dependencies.resolveImageAttachment
    )
    if (resumeSdkSessionId) {
      this.meta.sdkSessionId = resumeSdkSessionId
      this.emit({ kind: 'init', sdkSessionId: resumeSdkSessionId, model: this.effectiveModel() })
    }
  }

  async start(): Promise<void> {
    if (this.disposed) return
    this.setStatus('starting')
    try {
      const target = this.dependencies.resolveTarget({
        providerId: this.meta.providerId,
        model: this.meta.model
      })
      this.resolvedModel = target.model
      if (!this.meta.sdkSessionId) {
        this.meta.sdkSessionId = `anthropic-${randomUUID()}`
        this.emit({ kind: 'init', sdkSessionId: this.meta.sdkSessionId, model: target.model })
      }
      this.setStatus('idle')
    } catch (error) {
      this.setStatus('error', anthropicErrorText(error))
    }
  }

  send(input: string | SendMessagePayload): void {
    if (this.disposed) return
    if (this.abort) {
      this.rejectSend('上一轮仍在运行,请等待完成或中断后再发送。')
      return
    }
    const payload = normalizeStableMessagePayload(input)
    if (!payload.text && payload.images.length === 0) return
    const messageId = payload.messageId || randomUUID()
    this.dependencies.modelAttempts.startTurn(messageId)
    let attachments: UserMessageAttachmentView[]
    try {
      attachments = durableImageReferences(payload.images)
    } catch (error) {
      this.rejectSend(anthropicErrorText(error))
      return
    }
    this.emit({
      kind: 'user-message',
      text: payload.text,
      messageId,
      attachments
    })
    if (this.meta.title === '新会话' && payload.text) {
      this.meta.title = payload.text.replace(/\s+/g, ' ').slice(0, 40)
      this.emit({ kind: 'meta', meta: { ...this.meta } })
    }

    this.assistantText = ''
    this.thinkingText = ''
    this.turnUsage = undefined
    this.turnStartedAt = Date.now()
    this.triedProviders = new Set([this.meta.providerId])
    this.triedProviderKeys = new Map()
    this.turnCredentialTokens = new Set()
    const controller = new AbortController()
    this.abort = controller
    this.setStatus('running')
    const turn = this.runTurn(payload, controller)
    this.activeTurn = turn
    void turn.finally(() => {
      if (this.activeTurn === turn) this.activeTurn = null
    })
  }

  rejectSend(message: string): void {
    this.setStatus(this.abort ? 'running' : 'error', message)
  }

  async interrupt(): Promise<void> {
    this.nativeToolRuntime.rejectAllPending('已中断')
    const activeTurn = this.activeTurn
    if (!activeTurn) return
    this.abort?.abort()
    await activeTurn.catch(() => undefined)
  }

  respondPermission(requestId: string, allow: boolean, message?: string): void {
    this.nativeToolRuntime.respondPermission(requestId, allow, message)
  }

  pendingPermissions(): PermissionRequestInfo[] {
    return this.nativeToolRuntime.pendingPermissions()
  }

  getTranscript(): TranscriptEntry[] {
    return this.transcript.read()
  }

  emitSyntheticEvent(event: AgentEvent): void {
    if (!this.disposed) this.emit(event)
  }

  async setPermissionMode(mode: PermissionModeId): Promise<void> {
    this.meta.permissionMode = mode
    this.emit({ kind: 'meta', meta: { ...this.meta } })
  }

  async setModel(model: string): Promise<void> {
    this.meta.model = model
    this.resolvedModel = model && model !== AUTO_MODEL ? model : undefined
    this.emit({ kind: 'meta', meta: { ...this.meta } })
  }

  rename(title: string): void {
    const value = title.trim()
    if (!value) return
    this.meta.title = value.slice(0, 60)
    this.emit({ kind: 'meta', meta: { ...this.meta } })
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposePromise = this.disposeAndWait()
    return this.disposePromise
  }

  private async runTurn(payload: StableMessagePayload, controller: AbortController): Promise<void> {
    try {
      const target = this.dependencies.resolveTarget({
        providerId: this.meta.providerId,
        model: this.meta.model
      })
      this.rememberTarget(target)
      this.resolvedModel = target.model
      const userContent = buildAnthropicUserContent(payload, this.dependencies.resolveImageAttachment)
      await this.runMessagesLoop(target, userContent, controller)
    } catch (error) {
      this.finishTurnError(error, controller)
    } finally {
      if (this.abort === controller) this.abort = null
    }
  }

  private async runMessagesLoop(
    target: AnthropicMessagesTarget,
    userContent: AnthropicMessagesContentBlock[],
    controller: AbortController
  ): Promise<void> {
    const turnMessages: AnthropicMessagesMessage[] = [{ role: 'user', content: userContent }]
    let activeTarget = target
    for (let requestIndex = 0; requestIndex < MAX_MESSAGES_REQUESTS_PER_TURN; requestIndex += 1) {
      if (controller.signal.aborted) throw new Error('已中断')
      const response = await this.requestMessage(activeTarget, turnMessages, controller)
      activeTarget = response.target
      const finished = await this.handleMessageResult(
        response.result,
        requestIndex,
        turnMessages,
        controller
      )
      if (finished) return
    }
    this.finishTurn(true, 'Anthropic Messages 工具循环异常退出', 'tool-loop-limit')
  }

  private async requestMessage(
    target: AnthropicMessagesTarget,
    turnMessages: AnthropicMessagesMessage[],
    controller: AbortController
  ): Promise<AnthropicMessageResponse> {
    const textOffset = this.assistantText.length
    const thinkingOffset = this.thinkingText.length
    let activeTarget = target
    let lineage: AnthropicAttemptLineage | undefined
    while (true) {
      const attemptStartedAt = Date.now()
      try {
        const result = await this.executeMessageAttempt(
          activeTarget,
          turnMessages,
          controller,
          lineage
        )
        this.recordAttemptSuccess(activeTarget, Date.now() - attemptStartedAt)
        this.appendUnstreamedResult(result, textOffset, thinkingOffset)
        this.recordUsage(result)
        return { result, target: activeTarget }
      } catch (error) {
        if (!isModelAttemptOperationError(error)) throw error
        const operationError = error.operationError
        const failureText = anthropicErrorText(operationError)
        this.dependencies.recordFailure(
          activeTarget.providerId,
          this.redactTurnCredentials(failureText)
        )
        if (!this.logicalRequestCanReplay(controller, textOffset, thinkingOffset)) throw error
        const recovery = this.recoverTarget(activeTarget, failureText)
        if (!recovery) throw error
        lineage = {
          requestId: error.requestId,
          failoverFromAttemptId: error.attemptId,
          routeReason: recovery.routeReason
        }
        activeTarget = recovery.target
      }
    }
  }

  private executeMessageAttempt(
    target: AnthropicMessagesTarget,
    turnMessages: AnthropicMessagesMessage[],
    controller: AbortController,
    lineage?: AnthropicAttemptLineage
  ): Promise<AnthropicMessagesResult> {
    const request: AnthropicMessagesRequest = {
      model: target.model,
      maxTokens: DEFAULT_MAX_TOKENS,
      messages: [...this.history, ...turnMessages],
      tools: ANTHROPIC_CODING_TOOLS
    }
    this.rememberTarget(target)
    if (target.keyId) this.dependencies.markProviderKeyUsed(target.providerId, target.keyId)
    return this.dependencies.modelAttempts.execute({
      run: this.dependencies.getRun(this.meta.id),
      providerId: target.providerId,
      model: target.model,
      endpoint: target.endpoint,
      method: 'POST',
      body: request,
      signal: controller.signal,
      auth: { token: target.token, keyId: target.keyId, keyLabel: target.keyLabel },
      preflight: () => assertDigitalWorkerProviderDispatchAllowed(this.meta),
      ...(lineage ?? {}),
      operation: () => this.dependencies.streamMessage({
        endpoint: target.endpoint,
        headers: target.headers,
        request,
        signal: controller.signal,
        onText: (text) => this.appendText(text),
        onThinking: (text) => this.appendThinking(text)
      })
    })
  }

  private logicalRequestCanReplay(
    controller: AbortController,
    textOffset: number,
    thinkingOffset: number
  ): boolean {
    return !this.disposed &&
      !controller.signal.aborted &&
      this.assistantText.length === textOffset &&
      this.thinkingText.length === thinkingOffset &&
      !runHasUnresolvedEffects(this.dependencies.getRun(this.meta.id))
  }

  private recoverTarget(
    current: AnthropicMessagesTarget,
    failureText: string
  ): AnthropicRecoveryTarget | undefined {
    if (!this.dependencies.getSettings().failoverEnabled) return undefined
    const failure = this.dependencies.classifyFailure(failureText)
    const keyTarget = this.tryProviderKeyRecovery(current, failure)
    if (keyTarget) return keyTarget
    return this.tryProviderRecovery(current, failure)
  }

  private tryProviderKeyRecovery(
    current: AnthropicMessagesTarget,
    failure: FailureClass
  ): AnthropicRecoveryTarget | undefined {
    if (!current.keyId || !this.dependencies.canRotateProviderKey(failure)) return undefined
    const triedKeyIds = this.providerKeyIds(current.providerId)
    const rotation = this.dependencies.rotateProviderKey({
      providerId: current.providerId,
      failedKeyId: current.keyId,
      excludedKeyIds: triedKeyIds,
      reason: failure.label
    })
    if (!rotation || triedKeyIds.has(rotation.toKeyId)) return undefined
    let target: AnthropicMessagesTarget
    try {
      target = this.dependencies.resolveTarget({ providerId: current.providerId, model: current.model })
    } catch {
      triedKeyIds.add(rotation.toKeyId)
      return undefined
    }
    if (target.keyId !== rotation.toKeyId || !target.token) {
      triedKeyIds.add(rotation.toKeyId)
      return undefined
    }
    this.rememberTarget(target)
    const routeReason = `Provider key failover: ${failure.label}`
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
    return { target, routeReason }
  }

  private tryProviderRecovery(
    current: AnthropicMessagesTarget,
    failure: FailureClass
  ): AnthropicRecoveryTarget | undefined {
    if (!failure.switchable) return undefined
    const settings = this.dependencies.getSettings()
    const candidates = this.dependencies.listProviders()
      .filter((provider) => provider.engine === 'anthropic' && provider.hasToken)
      .map((provider) => ({ id: provider.id, name: provider.name, models: provider.models }))
    const selected = this.dependencies.pickFailoverTarget({
      candidates,
      exclude: this.triedProviders,
      desiredModel: current.model,
      fallbackProviderId: settings.fallbackProviderId,
      fallbackModel: settings.fallbackModel
    })
    if (!selected || this.triedProviders.has(selected.providerId)) return undefined
    this.triedProviders.add(selected.providerId)
    let target: AnthropicMessagesTarget
    try {
      target = this.dependencies.resolveTarget({
        providerId: selected.providerId,
        model: selected.model
      })
    } catch {
      return undefined
    }
    this.meta.providerId = target.providerId
    if (this.meta.model !== AUTO_MODEL) this.meta.model = target.model
    this.resolvedModel = target.model
    this.rememberTarget(target)
    const routeReason = [failure.label, selected.preference].filter(Boolean).join(' · ')
    this.emit({
      kind: 'failover',
      fromProviderId: current.providerId,
      toProviderId: target.providerId,
      fromName: current.providerName,
      toName: target.providerName,
      model: target.model,
      reason: routeReason
    })
    this.emit({ kind: 'meta', meta: { ...this.meta } })
    return { target, routeReason }
  }

  private recordAttemptSuccess(target: AnthropicMessagesTarget, latencyMs: number): void {
    if (target.keyId) this.dependencies.recordProviderKeySuccess(target.providerId, target.keyId)
    this.dependencies.recordSuccess(target.providerId, latencyMs)
  }

  private rememberTarget(target: AnthropicMessagesTarget): void {
    if (target.token) this.turnCredentialTokens.add(target.token)
    if (target.keyId) this.providerKeyIds(target.providerId).add(target.keyId)
  }

  private providerKeyIds(providerId: string): Set<string> {
    let ids = this.triedProviderKeys.get(providerId)
    if (!ids) {
      ids = new Set()
      this.triedProviderKeys.set(providerId, ids)
    }
    return ids
  }

  private async handleMessageResult(
    result: AnthropicMessagesResult,
    requestIndex: number,
    turnMessages: AnthropicMessagesMessage[],
    controller: AbortController
  ): Promise<boolean> {
    const assistantContent = assistantHistoryContent(result)
    const toolUses = assistantContent.filter(
      (block): block is AnthropicMessagesToolUseBlock => block.type === 'tool_use'
    )
    if (assistantContent.length > 0) turnMessages.push({ role: 'assistant', content: assistantContent })
    if (toolUses.length === 0) return this.completeFinalResponse(result, turnMessages)
    if (result.stopReason !== 'tool_use') return this.rejectInvalidToolResponse(result, toolUses)
    if (requestIndex === MAX_MESSAGES_REQUESTS_PER_TURN - 1) {
      return this.rejectToolLoopLimit(result, toolUses)
    }
    const toolResults = await this.executeToolBatch(result, toolUses, controller)
    if (!toolResults) return true
    turnMessages.push({ role: 'user', content: toolResults })
    return false
  }

  private completeFinalResponse(
    result: AnthropicMessagesResult,
    turnMessages: AnthropicMessagesMessage[]
  ): true {
    this.emitAssistantResult(result)
    const stopFailure = finalStopFailure(result.stopReason)
    if (stopFailure) {
      this.finishTurn(true, stopFailure.message, stopFailure.subtype)
      return true
    }
    this.history.push(...turnMessages)
    this.finishTurn(false, result.text || undefined, result.stopReason)
    return true
  }

  private rejectInvalidToolResponse(
    result: AnthropicMessagesResult,
    toolUses: AnthropicMessagesToolUseBlock[]
  ): true {
    this.emitAssistantResult(result)
    this.emitSkippedToolResults(toolUses, 0, `未执行:异常 stop_reason ${result.stopReason || 'missing'}`)
    this.finishTurn(true, 'Anthropic 工具响应的 stop_reason 无效', 'protocol-stop')
    return true
  }

  private rejectToolLoopLimit(
    result: AnthropicMessagesResult,
    toolUses: AnthropicMessagesToolUseBlock[]
  ): true {
    this.emitAssistantResult(result)
    this.emitSkippedToolResults(toolUses, 0, '未执行:单轮 Messages 请求已达上限')
    this.finishTurn(
      true,
      `已达单轮 Messages 请求上限 ${MAX_MESSAGES_REQUESTS_PER_TURN} 次,未执行无法回灌结果的工具调用`,
      'tool-loop-limit'
    )
    return true
  }

  private async executeToolBatch(
    result: AnthropicMessagesResult,
    toolUses: AnthropicMessagesToolUseBlock[],
    controller: AbortController
  ): Promise<AnthropicMessagesContentBlock[] | undefined> {
    const toolResults: AnthropicMessagesContentBlock[] = []
    let emittedAssistantResult = false
    for (let toolIndex = 0; toolIndex < toolUses.length; toolIndex += 1) {
      const toolUse = toolUses[toolIndex]
      if (controller.signal.aborted) {
        if (!emittedAssistantResult) this.emitAssistantResult(result)
        this.emitSkippedToolResults(toolUses, toolIndex, '未执行:本轮已中断')
        throw new Error('已中断')
      }
      this.emit({ kind: 'tool-start', toolUseId: toolUse.id, name: toolUse.name })
      if (!emittedAssistantResult) {
        this.emitAssistantResult(result)
        emittedAssistantResult = true
      }
      const execution = await this.executeNativeTool(toolUse, toolUses, toolIndex, controller)
      if (this.effectIsUnresolved(execution)) {
        this.emitSkippedToolResults(toolUses, toolIndex + 1, '未执行:前序工具效果状态未知')
        this.finishTurn(
          true,
          `工具效果状态未知,需先完成对账:${toolUse.name}(${toolUse.id})`,
          'effect-unknown'
        )
        return undefined
      }
      if (controller.signal.aborted) {
        this.emitSkippedToolResults(toolUses, toolIndex + 1, '未执行:本轮已中断')
        throw new Error('已中断')
      }
      toolResults.push(anthropicToolResultBlock(toolUse, execution))
    }
    return toolResults
  }

  private async executeNativeTool(
    toolUse: AnthropicMessagesToolUseBlock,
    toolUses: AnthropicMessagesToolUseBlock[],
    toolIndex: number,
    controller: AbortController
  ): Promise<NativeToolExecutionResult> {
    try {
      const execution = await this.nativeToolRuntime.executeToolWithPermission(
        toolUse.name,
        toolUse.input,
        toolUse.id,
        controller.signal
      )
      this.emitToolResult(toolUse.id, execution)
      return execution
    } catch (error) {
      this.emit({
        kind: 'tool-result',
        toolUseId: toolUse.id,
        content: `工具运行时异常:${anthropicErrorText(error)}`,
        isError: true
      })
      this.emitSkippedToolResults(toolUses, toolIndex + 1, '未执行:前序工具运行时异常')
      throw error
    }
  }
  private emitToolResult(toolUseId: string, execution: NativeToolExecutionResult): void {
    this.emit({
      kind: 'tool-result',
      toolUseId,
      content: execution.output,
      isError: !execution.ok,
      ...(execution.exitCode === undefined ? {} : { exitCode: execution.exitCode }),
      ...(execution.commandTermination ? { commandTermination: execution.commandTermination } : {}),
      effectStatus: execution.effectStatus
    })
  }
  private effectIsUnresolved(execution: NativeToolExecutionResult): boolean {
    return execution.effectStatus === 'waiting_reconciliation' ||
      runHasUnresolvedEffects(this.dependencies.getRun(this.meta.id))
  }

  private finishTurnError(error: unknown, controller: AbortController): void {
    if (isDigitalWorkerProviderDispatchDeniedError(error)) {
      this.finishTurn(true, error.message, 'policy-denied')
      return
    }
    if (isModelAttemptPersistenceError(error)) {
      const phase = error.phase === 'start' ? '启动' : '完成'
      this.finishTurn(
        true,
        this.redactTurnCredentials(`模型请求账本${phase}落盘失败:${error.message}`),
        'ledger-error'
      )
      return
    }
    if (controller.signal.aborted) {
      this.finishTurn(true, '已中断', 'interrupted')
      return
    }
    this.finishTurn(
      true,
      this.redactTurnCredentials(anthropicErrorText(unwrapModelAttemptOperationError(error))),
      'error'
    )
  }

  private redactTurnCredentials(value: string): string {
    let redacted = value
    for (const token of this.turnCredentialTokens) {
      if (token) redacted = redacted.split(token).join('[REDACTED]')
    }
    return redacted
  }

  private appendText(text: string): void {
    if (!text) return
    this.assistantText += text
    this.emit({ kind: 'text-delta', text })
  }

  private appendThinking(text: string): void {
    if (!text) return
    this.thinkingText += text
    this.emit({ kind: 'thinking-delta', text })
  }

  private appendUnstreamedResult(
    result: AnthropicMessagesResult,
    textOffset: number,
    thinkingOffset: number
  ): void {
    appendMissingSuffix(result.text, this.assistantText.slice(textOffset), (text) => this.appendText(text))
    appendMissingSuffix(
      result.thinking,
      this.thinkingText.slice(thinkingOffset),
      (text) => this.appendThinking(text)
    )
  }

  private recordUsage(result: AnthropicMessagesResult): void {
    this.turnUsage = aggregateAnthropicUsage(this.turnUsage, result)
    this.meta.usage = this.turnUsage
  }

  private emitSkippedToolResults(
    toolUses: AnthropicMessagesToolUseBlock[],
    startIndex: number,
    reason: string
  ): void {
    for (const toolUse of toolUses.slice(startIndex)) {
      this.emit({
        kind: 'tool-result',
        toolUseId: toolUse.id,
        content: reason,
        isError: true
      })
    }
  }

  private emitAssistantResult(result: AnthropicMessagesResult): void {
    const blocks = assistantEventBlocks(result)
    if (blocks.length > 0) this.emit({ kind: 'assistant-message', blocks })
  }

  private finishTurn(isError: boolean, resultText?: string, subtype = 'success'): void {
    if (this.disposed) return
    this.emit({
      kind: 'turn-result',
      subtype: isError ? subtype : 'success',
      isError,
      durationMs: this.turnStartedAt ? Date.now() - this.turnStartedAt : undefined,
      resultText: isError ? resultText : this.assistantText.trim() || resultText,
      usage: this.turnUsage
    })
    if (isError) this.setStatus('error', resultText)
    else this.setStatus('idle')
  }

  private effectiveModel(): string {
    return this.meta.model && this.meta.model !== AUTO_MODEL
      ? this.meta.model
      : this.resolvedModel || ''
  }

  private emit(event: AgentEvent): void {
    this.emitRaw(event)
  }

  private setStatus(status: SessionMeta['status'], error?: string): void {
    this.meta.status = status
    if (error) this.meta.lastError = error
    this.emit({ kind: 'status', status, error })
  }

  private async disposeAndWait(): Promise<void> {
    this.disposed = true
    this.nativeToolRuntime.rejectAllPending('会话已关闭')
    this.abort?.abort()
    const activeTurn = this.activeTurn
    if (activeTurn) await activeTurn.catch(() => undefined)
    this.abort = null
    this.setStatus('closed')
  }
}
