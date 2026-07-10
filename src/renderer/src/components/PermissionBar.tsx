import { useStore } from '../store'
import { useT } from '../i18n'
import type { PermissionRequestInfo } from '../../../shared/types'

const GUI_TEMPORARY_GRANT_MESSAGE = 'gui-temporary-grant:5m'
const SENSITIVE_INPUT_KEY = /(authorization|cookie|password|secret|token|api[-_]?key|credential)/i

export function formatPermissionInput(input: unknown): string {
  if (input === undefined) return ''
  if (!input || typeof input !== 'object') return String(input)
  try {
    return JSON.stringify(redactSensitiveInput(input, new WeakSet<object>()), null, 2)
  } catch {
    return '[unserializable input]'
  }
}

function redactSensitiveInput(value: unknown, seen: WeakSet<object>, key = ''): unknown {
  if (SENSITIVE_INPUT_KEY.test(key)) return '[REDACTED]'
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redactSensitiveInput(item, seen))
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
      childKey,
      redactSensitiveInput(childValue, seen, childKey)
    ])
  )
}

export default function PermissionBar({
  sessionId,
  requests
}: {
  sessionId: string
  requests: PermissionRequestInfo[]
}): React.JSX.Element | null {
  const t = useT()
  const respondPermission = useStore((s) => s.respondPermission)
  if (requests.length === 0) return null

  return (
    <div className="permission-bar">
      {requests.map((req) => {
        const inputText = formatPermissionInput(req.input)
        return <div key={req.requestId} className="permission-card">
          <div className="permission-info">
            <div className="permission-title">
              {t('permissionRequest')} <code>{req.toolName}</code>
            </div>
            {inputText && (
              <pre className="permission-detail" aria-label={`${req.toolName} permission input`}>
                {inputText}
              </pre>
            )}
            {req.decisionReason && <div className="permission-reason">{req.decisionReason}</div>}
          </div>
          <div className="permission-actions">
            <button
              className="btn btn-primary"
              onClick={() => void respondPermission(sessionId, req.requestId, true)}
            >
              {t('allow')}
            </button>
            {req.toolName.startsWith('gui_') && (
              <button
                className="btn btn-ghost"
                onClick={() =>
                  void respondPermission(sessionId, req.requestId, true, GUI_TEMPORARY_GRANT_MESSAGE)
                }
              >
                {t('allowTemporary')}
              </button>
            )}
            <button
              className="btn btn-ghost"
              onClick={() => void respondPermission(sessionId, req.requestId, false)}
            >
              {t('deny')}
            </button>
          </div>
        </div>
      })}
    </div>
  )
}
