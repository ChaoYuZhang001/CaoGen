import type { AgentEvent, UsageTotals } from '../../shared/types'
import { recordModelFailure, recordModelSuccess } from '../modelStats'
import { recordProviderKeySuccess } from '../providers'
import { recordFailure, recordSuccess } from '../scheduler'
import type { ClaudeAgentSessionTurnRuntime } from './claude-agent-session-runtime'

export type ClaudeTurnResultEvent = Extract<AgentEvent, { kind: 'turn-result' }>

interface ParsedClaudeResult {
  usage: UsageTotals
  costUsd?: number
  hasUsage: boolean
  subtype: string
  isError: boolean
  errorText: string
  event: ClaudeTurnResultEvent
}

export interface ClaudeResultRuntimeInput {
  msg: Record<string, unknown>
  generation: number
  turns: ClaudeAgentSessionTurnRuntime
  providerId: string
  providerKeyId?: string
  activeModel: string
  latencyMs?: number
  isCurrent: () => boolean
  applyAccounting: (usage: UsageTotals | undefined, costUsd: number | undefined) => void
  finish: (event: ClaudeTurnResultEvent, continueQueuedTurns: boolean) => void
  cancelled: (event: ClaudeTurnResultEvent) => void
  tryProviderKeyFailover: (errorText: string) => Promise<boolean>
  tryFailover: (errorText: string) => Promise<boolean>
}

export async function handleClaudeResult(input: ClaudeResultRuntimeInput): Promise<void> {
  const parsed = parseClaudeResult(input.msg)
  const completion = {
    generation: input.generation,
    usage: parsed.hasUsage ? parsed.usage : undefined,
    totalCostUsd: parsed.costUsd
  }
  const settled = parsed.isError
    ? await input.turns.failTurn({ ...completion, error: parsed.errorText })
    : await input.turns.completeTurn(completion)
  if (!settled || !input.isCurrent()) return
  input.applyAccounting(completion.usage, parsed.costUsd)
  if (settled.status === 'cancelled') {
    input.cancelled({ ...parsed.event, subtype: 'cancelled', isError: true })
    return
  }
  if (parsed.isError) {
    await handleFailedResult(input, parsed)
    return
  }
  handleSuccessfulResult(input, parsed)
}

function parseClaudeResult(msg: Record<string, unknown>): ParsedClaudeResult {
  const usage = normalizeUsage(msg.usage)
  const costUsd = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined
  const hasUsage = Object.values(usage).some((value) => value > 0)
  const subtype = typeof msg.subtype === 'string' ? msg.subtype : 'unknown'
  const isError = msg.is_error === true || subtype !== 'success'
  const errorText = typeof msg.result === 'string' ? msg.result : subtype
  return {
    usage,
    costUsd,
    hasUsage,
    subtype,
    isError,
    errorText,
    event: {
      kind: 'turn-result',
      subtype,
      isError,
      costUsd,
      usage: hasUsage ? usage : undefined,
      durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : undefined,
      numTurns: typeof msg.num_turns === 'number' ? msg.num_turns : undefined,
      resultText: typeof msg.result === 'string' ? msg.result : undefined
    }
  }
}

async function handleFailedResult(
  input: ClaudeResultRuntimeInput,
  parsed: ParsedClaudeResult
): Promise<void> {
  try {
    if (await input.tryProviderKeyFailover(parsed.errorText)) return
    recordFailure(input.providerId, parsed.errorText)
    if (input.activeModel) recordModelFailure(input.activeModel)
    if (!(await input.tryFailover(parsed.errorText))) input.finish(parsed.event, true)
  } catch (error) {
    console.error('[caogen] 故障接管失败:', error)
    input.finish(parsed.event, true)
  }
}

function handleSuccessfulResult(
  input: ClaudeResultRuntimeInput,
  parsed: ParsedClaudeResult
): void {
  if (input.providerKeyId) recordProviderKeySuccess(input.providerId, input.providerKeyId)
  recordSuccess(input.providerId, input.latencyMs)
  if (input.activeModel) recordModelSuccess(input.activeModel, input.latencyMs)
  input.finish(parsed.event, true)
}

function normalizeUsage(raw: unknown): UsageTotals {
  const usage = (raw ?? {}) as Record<string, unknown>
  const number = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0
  return {
    input: number(usage.input_tokens),
    output: number(usage.output_tokens),
    cacheRead: number(usage.cache_read_input_tokens),
    cacheCreation: number(usage.cache_creation_input_tokens)
  }
}
