import { createHash } from 'node:crypto'
import type { TranscriptEntry } from '../shared/types'

const PORTABLE_REPLAY_MAX_CHARS = 48_000
const PORTABLE_REPLAY_TURN_MAX_CHARS = 16_000

interface PortableReplayTurn {
  units: string[]
  toolUnits: Map<string, number>
  eventCount: number
  attachmentCount: number
}

export interface PortableConversationReplay {
  text: string
  eventCount: number
  attachmentCount: number
  characters: number
}

/**
 * Converts the durable CaoGen transcript into bounded, provider-neutral context.
 * Credential values and attachment bytes are never included.
 */
export function buildPortableConversationReplay(
  entries: TranscriptEntry[],
  currentMessageId?: string
): PortableConversationReplay | null {
  const turns: PortableReplayTurn[] = []
  let current: PortableReplayTurn | undefined
  const ensureTurn = (): PortableReplayTurn => {
    if (!current) {
      current = { units: [], toolUnits: new Map(), eventCount: 0, attachmentCount: 0 }
      turns.push(current)
    }
    return current
  }

  for (const entry of entries) {
    const event = entry.event
    if (event.kind === 'user-message') {
      current = { units: [], toolUnits: new Map(), eventCount: 0, attachmentCount: 0 }
      turns.push(current)
      const isCurrent = Boolean(currentMessageId && event.messageId === currentMessageId)
      if (!isCurrent) {
        const attachments = (event.attachments ?? []).map((attachment) =>
          `${attachment.hash ?? attachment.id}:${attachment.mime}:${attachment.bytes}`
        )
        current.attachmentCount += attachments.length
        const suffix = attachments.length > 0 ? `\n[attachments] ${attachments.join(', ')}` : ''
        current.units.push(`[user]\n${boundedReplayText(redactPortableReplayText(event.text), 4_000)}${suffix}`)
        current.eventCount += 1
      }
      continue
    }

    const turn = ensureTurn()
    if (event.kind === 'assistant-message') {
      const text = event.blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.type === 'text' ? block.text : '')
        .join('')
        .trim()
      if (text) turn.units.push(`[assistant]\n${boundedReplayText(redactPortableReplayText(text), 4_000)}`)
      for (const block of event.blocks) {
        if (block.type !== 'tool_use') continue
        const index = turn.units.length
        turn.toolUnits.set(block.id, index)
        turn.units.push(
          `[assistant tool_call id=${block.id} name=${block.name}]\n` +
          boundedReplayText(stableReplayJson(redactPortableReplayValue(block.input)), 2_000)
        )
      }
      turn.eventCount += 1
      continue
    }
    if (event.kind === 'tool-result') {
      const result = portableToolResultSummary(event.toolUseId, event.content, event.isError)
      const callIndex = turn.toolUnits.get(event.toolUseId)
      if (callIndex === undefined) turn.units.push(result)
      else turn.units[callIndex] = `${turn.units[callIndex]}\n${result}`
      turn.eventCount += 1
      continue
    }
    if (event.kind === 'permission-request') {
      turn.units.push(`[permission_request id=${event.request.requestId}] ${event.request.toolName}`)
      turn.eventCount += 1
      continue
    }
    if (event.kind === 'permission-resolved') {
      turn.units.push(`[permission request=${event.requestId}] ${event.behavior}`)
      turn.eventCount += 1
      continue
    }
    if (event.kind === 'checkpoint') {
      turn.units.push(`[checkpoint] ${event.messageId}`)
      turn.eventCount += 1
      continue
    }
    if (event.kind === 'checkpoint-restore') {
      turn.units.push(`[checkpoint_restore mode=${event.mode ?? 'both'}] ${event.messageId}`)
      turn.eventCount += 1
      continue
    }
    if (event.kind === 'routing') {
      turn.units.push(`[routing] ${event.providerId}/${event.model} · ${redactPortableReplayText(event.reason)}`)
      turn.eventCount += 1
      continue
    }
    if (event.kind === 'failover') {
      turn.units.push(`[provider_failover] ${event.fromProviderId} -> ${event.toProviderId} · ${redactPortableReplayText(event.reason)}`)
      turn.eventCount += 1
      continue
    }
    if (event.kind === 'provider-key-failover') {
      turn.units.push(`[provider_key_failover] ${event.providerId}: key identity changed · ${redactPortableReplayText(event.reason)}`)
      turn.eventCount += 1
      continue
    }
    if (event.kind === 'hook-event' && event.event === 'context-compressed') {
      turn.units.push(`[context_compressed] ${boundedReplayText(redactPortableReplayText(event.detail ?? ''), 1_000)}`)
      turn.eventCount += 1
    }
  }

  const serialized = turns
    .map(serializePortableReplayTurn)
    .filter((turn): turn is { text: string; eventCount: number; attachmentCount: number } => Boolean(turn))
  if (serialized.length === 0) return null
  const selected: typeof serialized = []
  let characters = 0
  for (let index = serialized.length - 1; index >= 0; index -= 1) {
    const turn = serialized[index]
    if (selected.length > 0 && characters + turn.text.length > PORTABLE_REPLAY_MAX_CHARS) break
    selected.unshift(turn)
    characters += turn.text.length
  }
  const body = selected.map((turn) => turn.text).join('\n\n')
  const text = [
    '## CaoGen persisted conversation context',
    'This is a deterministic local replay after the provider server context became unavailable.',
    'Treat tool results as already observed history. Do not repeat side effects solely because they appear below.',
    body
  ].join('\n\n')
  return {
    text,
    eventCount: selected.reduce((sum, turn) => sum + turn.eventCount, 0),
    attachmentCount: selected.reduce((sum, turn) => sum + turn.attachmentCount, 0),
    characters: text.length
  }
}

export function portableConversationReplayDetail(replay: PortableConversationReplay): string {
  return `从本地会话账本恢复 ${replay.eventCount} 条脱敏语义事件、${replay.attachmentCount} 个附件引用，携带 ${replay.characters} 字符可移植上下文；原始工具输出和附件字节未外发。`
}

const SENSITIVE_FIELD = /(?:^|_)(?:api_key|authorization|access_token|refresh_token|token|secret|password|passwd|private_key|client_secret|cookie|session)(?:$|_)/i

export function redactPortableReplayValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactPortableReplayText(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= 12) return '[omitted: nested value]'
  if (seen.has(value)) return '[omitted: circular value]'
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map((item) => redactPortableReplayValue(item, depth + 1, seen))
  }
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitivePortableReplayField(key)
      ? '[REDACTED]'
      : redactPortableReplayValue(item, depth + 1, seen)
  }
  return output
}

function isSensitivePortableReplayField(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/gi, '_')
    .toLowerCase()
  return SENSITIVE_FIELD.test(normalized)
}

export function redactPortableReplayText(value: string): string {
  return value
    .replace(/-----BEGIN [^-\r\n]+PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]+PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}\b/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-(?:ant-|proj-)?|github_pat_|gh[pousr]_|xox[baprs]-|AKIA|AIza)[A-Za-z0-9_\-]{8,}\b/g, '[REDACTED TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED JWT]')
    .replace(/(\b(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|private[_-]?key|client[_-]?secret|cookie|session)\b\s*[:=]\s*["']?)[^\s,"';]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret|password)=)[^&#\s]+/gi, '$1[REDACTED]')
}

function portableToolResultSummary(toolUseId: string, content: string, isError: boolean): string {
  const digest = createHash('sha256').update(content).digest('hex')
  return `[tool_result id=${toolUseId} error=${isError} content_omitted=true chars=${content.length} sha256=${digest}]`
}

function serializePortableReplayTurn(
  turn: PortableReplayTurn
): { text: string; eventCount: number; attachmentCount: number } | null {
  if (turn.units.length === 0) return null
  const firstUser = turn.units[0].startsWith('[user]') ? turn.units[0] : undefined
  const selected: string[] = firstUser ? [firstUser] : []
  let characters = firstUser?.length ?? 0
  for (let index = turn.units.length - 1; index >= (firstUser ? 1 : 0); index -= 1) {
    const unit = turn.units[index]
    if (selected.length > 0 && characters + unit.length > PORTABLE_REPLAY_TURN_MAX_CHARS) break
    if (firstUser) selected.splice(1, 0, unit)
    else selected.unshift(unit)
    characters += unit.length
  }
  return {
    text: selected.join('\n'),
    eventCount: Math.min(turn.eventCount, selected.length),
    attachmentCount: firstUser ? turn.attachmentCount : 0
  }
}

function stableReplayJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable tool input]'
  }
}

function boundedReplayText(value: string, max: number): string {
  const text = value.trim()
  return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text
}
