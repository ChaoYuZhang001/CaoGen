import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SandboxMode, ToolRiskLevel } from '../../shared/types'

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

interface AuditLogRecord extends Omit<ToolAuditEvent, 'input'> {
  ts: string
  inputSummary?: string
}

export function writeAuditLog(cwd: string, event: ToolAuditEvent): void {
  try {
    const dir = join(cwd, '.caogen')
    mkdirSync(dir, { recursive: true })
    const record: AuditLogRecord = {
      ...event,
      ts: new Date().toISOString(),
      inputSummary: summarizeInput(event.input)
    }
    appendFileSync(join(dir, 'audit.log'), `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // 审计失败不能打断 Agent 工具执行。
  }
}

function summarizeInput(input: unknown): string | undefined {
  if (input === undefined) return undefined
  if (typeof input === 'string') return clip(input)
  if (!input || typeof input !== 'object') return clip(String(input))
  const record = input as Record<string, unknown>
  const primary = record.command ?? record.path ?? record.file_path ?? record.query ?? record.pattern
  if (typeof primary === 'string') return clip(primary)
  try {
    return clip(JSON.stringify(input))
  } catch {
    return '[unserializable]'
  }
}

function clip(text: string): string {
  return text.length > 500 ? `${text.slice(0, 500)}...[truncated]` : text
}
