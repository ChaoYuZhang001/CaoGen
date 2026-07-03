import { useStore } from '../store'
import type { PermissionRequestInfo } from '../../../shared/types'

function summarize(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  const cand =
    obj.command ?? obj.file_path ?? obj.path ?? obj.pattern ?? obj.url ?? obj.query ?? obj.prompt
  if (typeof cand === 'string') return cand.length > 120 ? `${cand.slice(0, 120)}…` : cand
  try {
    const json = JSON.stringify(obj)
    return json.length > 120 ? `${json.slice(0, 120)}…` : json
  } catch {
    return ''
  }
}

export default function PermissionBar({
  sessionId,
  requests
}: {
  sessionId: string
  requests: PermissionRequestInfo[]
}): React.JSX.Element | null {
  const respondPermission = useStore((s) => s.respondPermission)
  if (requests.length === 0) return null

  return (
    <div className="permission-bar">
      {requests.map((req) => (
        <div key={req.requestId} className="permission-card">
          <div className="permission-info">
            <div className="permission-title">
              请求使用工具 <code>{req.toolName}</code>
            </div>
            {summarize(req.input) && <div className="permission-detail">{summarize(req.input)}</div>}
            {req.decisionReason && <div className="permission-reason">{req.decisionReason}</div>}
          </div>
          <div className="permission-actions">
            <button
              className="btn btn-primary"
              onClick={() => void respondPermission(sessionId, req.requestId, true)}
            >
              允许
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => void respondPermission(sessionId, req.requestId, false)}
            >
              拒绝
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
