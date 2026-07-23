import type { TaskRunRecord } from '../../shared/types'
import type { AnthropicMessagesResult } from '../anthropicMessagesAdapter'
import {
  beginPersistedModelAttempt,
  classifyRuntimeModelFailure,
  executePersistedModelAttempt,
  modelAttemptUsage,
  ModelAttemptPersistenceError,
  type PersistedModelAttemptHandle,
  type RuntimeModelAttemptDependencies
} from './model-attempt-runtime'

export const ANTHROPIC_MESSAGES_PROTOCOL = 'anthropic.messages'
export const ANTHROPIC_MESSAGES_ADAPTER_VERSION = 'anthropic-messages-v1'

export interface AnthropicModelAttemptAuth {
  token: string
  keyId?: string
  keyLabel?: string
}

export interface AnthropicModelAttemptInput {
  run?: TaskRunRecord
  providerId: string
  model: string
  endpoint: string
  method?: string
  body: unknown
  signal: AbortSignal
  auth: AnthropicModelAttemptAuth
  requestId?: string
  failoverFromAttemptId?: string
  routeReason?: string
  preflight?: () => void
  operation: () => Promise<AnthropicMessagesResult>
}

export class AnthropicModelAttemptTracker {
  private messageId = ''
  private sequence = 0

  constructor(
    private readonly dependencies?: Partial<RuntimeModelAttemptDependencies>
  ) {}

  startTurn(messageId: string): void {
    this.messageId = messageId
    this.sequence = 0
  }

  execute(input: AnthropicModelAttemptInput): Promise<AnthropicMessagesResult> {
    // Policy denial must happen before the durable Attempt is opened.
    input.preflight?.()
    const attempt = this.attemptInput(input)
    return executePersistedModelAttempt(attempt, input.operation, {
      dependencies: this.dependencies,
      success: (result) => ({
        usage: modelAttemptUsage({
          input: result.usage.input,
          output: result.usage.output,
          cacheRead: result.usage.cacheRead,
          cacheWrite: result.usage.cacheCreation
        })
      }),
      failure: (error) => classifyRuntimeModelFailure(error, { aborted: input.signal.aborted })
    })
  }

  begin(input: Omit<AnthropicModelAttemptInput, 'operation'>): Promise<PersistedModelAttemptHandle> {
    input.preflight?.()
    return beginPersistedModelAttempt(this.attemptInput(input), {
      dependencies: this.dependencies
    })
  }

  private attemptInput(input: Omit<AnthropicModelAttemptInput, 'operation'>) {
    const run = input.run
    if (!run) {
      throw new ModelAttemptPersistenceError(
        'start',
        false,
        undefined,
        new Error('active TaskRun is missing for Anthropic Messages request')
      )
    }
    const steps = run.steps ?? []
    const stepId = [...steps].reverse().find((step) => step.messageId === this.messageId)?.id
      ?? steps.find((step) => !step.finishedAt)?.id
    const explicitRequestId = input.requestId?.trim()
    const predecessorAttemptId = input.failoverFromAttemptId?.trim()
    if (Boolean(explicitRequestId) !== Boolean(predecessorAttemptId)) {
      throw new ModelAttemptPersistenceError(
        'start',
        false,
        undefined,
        new Error('Anthropic failover successor requires both requestId and failoverFromAttemptId')
      )
    }
    const requestId = explicitRequestId ??
      `model-request:${run.id}:${this.messageId || 'system'}:${++this.sequence}`
    return {
      runId: run.id,
      requestId,
      stepId,
      providerId: input.providerId,
      model: input.model,
      protocol: ANTHROPIC_MESSAGES_PROTOCOL,
      adapterVersion: ANTHROPIC_MESSAGES_ADAPTER_VERSION,
      context: {
        endpoint: input.endpoint,
        method: input.method ?? 'POST',
        body: input.body
      },
      routeReason: input.routeReason?.trim() ||
        'Session uses the saved Provider target with the native Anthropic Messages adapter',
      keyIdentity: { providerId: input.providerId, ...input.auth },
      ...(predecessorAttemptId ? { failoverFromAttemptId: predecessorAttemptId } : {})
    }
  }
}
