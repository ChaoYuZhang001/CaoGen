import type { SessionMeta } from '../../../../shared/types'

type SessionStatus = SessionMeta['status'] | undefined

export function isSessionBusy(status: SessionStatus): boolean {
  return status === 'starting' || status === 'running'
}

export function canSendToSession(activeId: string | null, status: SessionStatus, hasPayload: boolean): boolean {
  return Boolean(activeId && hasPayload && (status === 'idle' || status === 'error'))
}
