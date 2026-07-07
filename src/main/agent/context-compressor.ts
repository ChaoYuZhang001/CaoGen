import type { ContextPressureLevel } from '../../shared/types'

export interface ContextMessage {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: unknown
  tool_calls?: readonly unknown[]
}

export interface ContextUsageState {
  usedTokens: number
  windowTokens: number
  remainingTokens: number
  usageRatio: number
  warningThresholdTokens: number
  compressionThresholdTokens: number
  pressure: ContextPressureLevel
  shouldWarn: boolean
  shouldCompress: boolean
}

export interface CompressionBoundary {
  keepFrom: number
  olderCount: number
  recentCount: number
  canCompress: boolean
}

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 60_000
export const CONTEXT_WARNING_RATIO = 0.8
export const CONTEXT_AUTO_COMPRESS_RATIO = 0.9
export const DEFAULT_KEEP_RECENT_MESSAGES = 12

/** 粗估上下文 token:对中英混排取 3 字符/token 的保守口径,额外计入工具调用参数。 */
export function estimateContextTokens(messages: readonly ContextMessage[]): number {
  let chars = 0
  for (const message of messages) {
    chars += serializedLength(message.content)
    if (message.tool_calls) chars += serializedLength(message.tool_calls)
  }
  return Math.ceil(chars / 3)
}

export function inferContextWindowTokens(model: string, override?: string): number {
  const explicit = positiveInteger(override ?? process.env.CAOGEN_CONTEXT_WINDOW_TOKENS)
  if (explicit) return explicit

  const lower = model.toLowerCase()
  const hint = lower.match(/(?:^|[-_\s])(\d{1,4})(k|m)(?:$|[-_\s])/)
  if (hint) {
    const value = Number(hint[1])
    const unit = hint[2]
    if (Number.isFinite(value) && value > 0) return unit === 'm' ? value * 1_000_000 : value * 1_000
  }

  if (/\b(32k|32768)\b/.test(lower)) return 32_000
  if (/\b(16k|16384)\b/.test(lower)) return 16_000
  if (/\b(8k|8192)\b/.test(lower)) return 8_000
  return DEFAULT_CONTEXT_WINDOW_TOKENS
}

export function evaluateContextUsage(input: {
  usedTokens: number
  model: string
  contextWindowTokens?: number
}): ContextUsageState {
  const windowTokens = Math.max(1, Math.floor(input.contextWindowTokens ?? inferContextWindowTokens(input.model)))
  const usedTokens = Math.max(0, Math.ceil(input.usedTokens))
  const warningThresholdTokens = Math.floor(windowTokens * CONTEXT_WARNING_RATIO)
  const compressionThresholdTokens = Math.floor(windowTokens * CONTEXT_AUTO_COMPRESS_RATIO)
  const usageRatio = usedTokens / windowTokens
  const pressure: ContextPressureLevel =
    usedTokens >= compressionThresholdTokens ? 'critical' : usedTokens >= warningThresholdTokens ? 'warning' : 'normal'

  return {
    usedTokens,
    windowTokens,
    remainingTokens: Math.max(0, windowTokens - usedTokens),
    usageRatio,
    warningThresholdTokens,
    compressionThresholdTokens,
    pressure,
    shouldWarn: usedTokens >= warningThresholdTokens,
    shouldCompress: usedTokens >= compressionThresholdTokens
  }
}

export function planCompressionBoundary(
  messages: readonly ContextMessage[],
  keepRecentMessages = DEFAULT_KEEP_RECENT_MESSAGES
): CompressionBoundary {
  const protectedFrom = Math.max(0, messages.length - Math.max(1, Math.floor(keepRecentMessages)))
  const keepFrom = findUserBoundary(messages, protectedFrom)
  const canCompress = keepFrom !== null && keepFrom > 1 && messages[keepFrom]?.role === 'user'
  return {
    keepFrom: keepFrom ?? 0,
    olderCount: keepFrom ?? 0,
    recentCount: keepFrom === null ? messages.length : Math.max(0, messages.length - keepFrom),
    canCompress
  }
}

function findUserBoundary(messages: readonly ContextMessage[], from: number): number | null {
  for (let i = from; i < messages.length; i++) {
    if (messages[i]?.role === 'user') return i
  }
  for (let i = Math.min(from, messages.length - 1); i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return i
  }
  return null
}

function serializedLength(value: unknown): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'string') return value.length
  try {
    return JSON.stringify(value).length
  } catch {
    return String(value).length
  }
}

function positiveInteger(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null
}
