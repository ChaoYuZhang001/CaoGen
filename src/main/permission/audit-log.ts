import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SandboxMode, ToolRiskLevel } from '../../shared/types'
import { resolveWritableProjectPathSync } from '../utils/safe-project-path'

export type AuditAction = 'allow' | 'deny' | 'ask' | 'execute'
export type AuditSource = 'policy' | 'permission-mode' | 'idempotency' | 'user' | 'sandbox'

export interface ToolAuditEvent {
  action: AuditAction
  source: AuditSource
  toolName: string
  riskLevel?: ToolRiskLevel
  riskReasons?: string[]
  input?: unknown
  message?: string
  ok?: boolean
  sandboxMode?: SandboxMode
  modeUsed?: SandboxMode
  sandboxed?: boolean
  fallbackReason?: string
}

interface AuditLogRecord extends Omit<ToolAuditEvent, 'input' | 'message' | 'fallbackReason'> {
  ts: string
  inputSummary?: string
  inputDigest?: string
  message?: string
  fallbackReason?: string
}

export function writeAuditLog(cwd: string, event: ToolAuditEvent): void {
  try {
    const initialPath = resolveWritableProjectPathSync(cwd, '.caogen/audit.log')
    mkdirSync(dirname(initialPath.fullPath), { recursive: true })
    const logPath = resolveWritableProjectPathSync(cwd, '.caogen/audit.log').fullPath
    const { input, message, fallbackReason, ...safeEvent } = event
    const record: AuditLogRecord = {
      ...safeEvent,
      ts: new Date().toISOString(),
      inputSummary: summarizeInput(event.toolName, input),
      inputDigest: input === undefined ? undefined : digest(input),
      message: redactSensitiveText(message),
      fallbackReason: redactSensitiveText(fallbackReason)
    }
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(logPath, 0o600)
  } catch {
    // 审计失败不能打断 Agent 工具执行。
  }
}

function summarizeInput(toolName: string, input: unknown): string | undefined {
  if (input === undefined) return undefined
  if (!input || typeof input !== 'object') return `${typeof input} sha256:${digest(input)}`
  const record = input as Record<string, unknown>
  const normalized = toolName.trim().toLowerCase()
  const rawPath = record.path ?? record.file_path
  const path = typeof rawPath === 'string' ? clip(rawPath) : undefined
  if (normalized === 'bash' || typeof record.command === 'string') {
    const command = String(record.command ?? '')
    return `command bytes=${Buffer.byteLength(command)} sha256:${digest(command)}`
  }
  if (normalized === 'write_file' || typeof record.content === 'string') {
    const content = String(record.content ?? '')
    return `${path ? `path=${path} ` : ''}content bytes=${Buffer.byteLength(content)} sha256:${digest(content)}`
  }
  if (typeof record.url === 'string') return `urlOrigin=${safeUrlOrigin(record.url)} sha256:${digest(record.url)}`
  const server = typeof record.server === 'string' ? record.server : undefined
  const tool = typeof record.tool === 'string' ? record.tool : undefined
  if (server || tool) return `server=${server ?? '(none)'} tool=${tool ?? '(none)'} inputSha256:${digest(input)}`
  if (path) return `path=${path} inputSha256:${digest(input)}`
  const keys = Object.keys(record).filter((key) => !isSensitiveKey(key)).sort()
  return `keys=${keys.join(',') || '(none)'} inputSha256:${digest(input)}`
}

function clip(text: string): string {
  return text.length > 500 ? `${text.slice(0, 500)}...[truncated]` : text
}

function digest(value: unknown): string {
  let serialized: string
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    serialized = '[unserializable]'
  }
  return createHash('sha256').update(serialized ?? 'undefined').digest('hex')
}

function safeUrlOrigin(value: string): string {
  try {
    const url = new URL(value)
    return url.origin
  } catch {
    return '[invalid-url]'
  }
}

function isSensitiveKey(value: string): boolean {
  return /(authorization|cookie|password|secret|token|api[-_]?key|credential)/i.test(value)
}

function redactSensitiveText(value: string | undefined): string | undefined {
  if (!value) return value
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b(api[-_]?key|token|password|secret|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\b(https?:\/\/)([^\s/@]+):([^\s/@]+)@/gi, '$1[REDACTED]@')
}
