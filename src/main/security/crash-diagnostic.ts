import { redactSensitiveValue } from './secret-redaction'

export interface RendererCrashDiagnostic {
  schemaVersion: 1
  kind: 'renderer-process-gone'
  reason: string
  exitCode: number
  at: string
}

export function buildRendererCrashDiagnostic(
  details: { reason?: unknown; exitCode?: unknown },
  now = new Date()
): RendererCrashDiagnostic {
  const reason = typeof details.reason === 'string' && details.reason.trim()
    ? details.reason.trim().slice(0, 128)
    : 'unknown'
  const exitCode = typeof details.exitCode === 'number' && Number.isInteger(details.exitCode)
    ? details.exitCode
    : -1
  return redactSensitiveValue({
    schemaVersion: 1,
    kind: 'renderer-process-gone',
    reason,
    exitCode,
    at: now.toISOString()
  })
}
