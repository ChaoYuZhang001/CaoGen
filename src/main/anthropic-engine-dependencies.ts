import { app } from 'electron'
import { imageAttachmentRefToContentBlock, sessionImageAttachmentsRoot } from './attachmentOps'
import {
  buildAnthropicMessagesWireBody,
  streamAnthropicMessage,
  type AnthropicMessagesContentBlock,
  type AnthropicMessagesRequest,
  type AnthropicMessagesResult
} from './anthropicMessagesAdapter'
import { anthropicRuntimeRequiresThinkingSignature, applyAnthropicRuntimeToRequest } from './anthropicMessagesRequest'
import { canRotateProviderKey } from './providerKeyRouting'
import { resolveAnthropicMessagesTarget, type AnthropicMessagesTarget } from './provider/anthropicMessagesTarget'
import { getSettings } from './settings'
import {
  acquireProviderRequest,
  classifyFailure,
  pickFailoverTarget,
  pickProviderModelFailoverTarget,
  recordFailure,
  recordSuccess,
  releaseProviderRequest
} from './scheduler'
import {
  listProviders,
  markProviderKeyUsed,
  recordProviderKeySuccess,
  rotateProviderKey
} from './providers'
import { AnthropicModelAttemptTracker, type AnthropicModelAttemptInput } from './task/anthropic-model-attempt-runtime'
import { taskRuntimeRegistry } from './task/task-runtime-registry'
import type {
  EngineKind,
  ProviderRuntimeConfig,
  SessionMeta,
  TaskRunRecord,
  UserMessageAttachmentView
} from '../shared/types'

interface AnthropicAttemptExecutor {
  startTurn(messageId: string): void
  execute(input: AnthropicModelAttemptInput): Promise<AnthropicMessagesResult>
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
  pickProviderModelFailoverTarget: typeof pickProviderModelFailoverTarget
  markProviderKeyUsed: typeof markProviderKeyUsed
  recordProviderKeySuccess: typeof recordProviderKeySuccess
  acquireProviderRequest: typeof acquireProviderRequest
  recordFailure: typeof recordFailure
  releaseProviderRequest: typeof releaseProviderRequest
  recordSuccess: typeof recordSuccess
  resolveImageAttachment(reference: UserMessageAttachmentView): AnthropicMessagesContentBlock
  sessionIdPrefix: string
  recoveryEngineKind: EngineKind
  requiresThinkingSignature(target: AnthropicMessagesTarget): boolean
  applyRuntimeToRequest(
    request: AnthropicMessagesRequest,
    runtime: ProviderRuntimeConfig | undefined
  ): AnthropicMessagesRequest
  buildWireBody(request: Parameters<typeof buildAnthropicMessagesWireBody>[0]): unknown
}

export function createAnthropicEngineDependencies(
  meta: SessionMeta,
  overrides: Partial<AnthropicEngineDependencies>
): AnthropicEngineDependencies {
  return {
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
    pickProviderModelFailoverTarget,
    markProviderKeyUsed,
    recordProviderKeySuccess,
    acquireProviderRequest,
    recordFailure,
    releaseProviderRequest,
    recordSuccess,
    sessionIdPrefix: 'anthropic',
    recoveryEngineKind: 'anthropic',
    requiresThinkingSignature: (target) =>
      anthropicRuntimeRequiresThinkingSignature(target.credentialProvider.advancedConfig?.runtime),
    applyRuntimeToRequest: applyAnthropicRuntimeToRequest,
    buildWireBody: buildAnthropicMessagesWireBody,
    resolveImageAttachment: (reference) => imageAttachmentRefToContentBlock(
      reference,
      sessionImageAttachmentsRoot(app.getPath('userData'), meta.id)
    ) as AnthropicMessagesContentBlock,
    ...overrides
  }
}
