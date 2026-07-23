import type { ModelAttemptRecord } from '../../shared/model-attempt-types'
import { recordFailure } from '../scheduler'
import type { ClaudeAgentSessionTurnRuntime } from './claude-agent-session-runtime'
import { isModelAttemptPersistenceError } from './model-attempt-runtime'

export interface ClaudeStreamFailureInput {
  error: unknown
  generation: number
  stderrTail: string
  providerId: string
  turns: ClaudeAgentSessionTurnRuntime
  isCurrent: () => boolean
  turnInFlight: () => boolean
  persistenceFailure: (message: string) => void
  cancelled: (settled: ModelAttemptRecord | undefined) => void
  missingAttempt: () => void
  blockFailoverForUnresolvedEffects: () => boolean
  tryProviderKeyFailover: (message: string) => Promise<boolean>
  tryFailover: (message: string) => Promise<boolean>
  terminalError: (message: string) => void
  setError: (message: string) => void
}

export async function handleClaudeStreamFailure(input: ClaudeStreamFailureInput): Promise<void> {
  if (!input.isCurrent()) return
  if (isModelAttemptPersistenceError(input.error)) {
    input.persistenceFailure(errorText(input.error))
    return
  }
  const message = streamErrorText(input.error, input.stderrTail)
  const settled = await settleStreamFailure(input, message)
  if (settled === 'persistence-error' || !input.isCurrent()) return
  if (settled?.status === 'cancelled' || input.turns.isInterrupted(input.generation)) {
    input.cancelled(settled || undefined)
    return
  }
  if (!settled && input.turnInFlight()) {
    input.missingAttempt()
    return
  }
  await handleStreamFailover(input, message)
}

async function settleStreamFailure(
  input: ClaudeStreamFailureInput,
  message: string
): Promise<ModelAttemptRecord | undefined | 'persistence-error'> {
  try {
    return await input.turns.failTurn({ generation: input.generation, error: message })
  } catch (error) {
    input.persistenceFailure(errorText(error))
    return 'persistence-error'
  }
}

async function handleStreamFailover(
  input: ClaudeStreamFailureInput,
  message: string
): Promise<void> {
  if (input.blockFailoverForUnresolvedEffects()) {
    recordFailure(input.providerId, message)
    input.setError(message)
    return
  }
  if (input.turnInFlight() && (await input.tryProviderKeyFailover(message))) return
  recordFailure(input.providerId, message)
  if (input.turnInFlight() && (await input.tryFailover(message))) return
  if (input.isCurrent()) input.terminalError(message)
}

function streamErrorText(error: unknown, stderrTail: string): string {
  const tail = stderrTail.trim()
  const message = errorText(error)
  return tail ? `${message}\n[SDK stderr]\n${tail.slice(-1200)}` : message
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
