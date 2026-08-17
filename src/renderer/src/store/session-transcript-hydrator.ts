import type { PermissionRequestInfo, SessionMeta, TranscriptEntry } from '../../../shared/types'

export interface EagerTranscriptHydrationDependencies {
  listPendingPermissions(sessionId: string): Promise<PermissionRequestInfo[]>
  apply(meta: SessionMeta, permissions: PermissionRequestInfo[], transcript: TranscriptEntry[]): void
}

export function mergeHydratedSessionPermissions<
  T extends { pendingPermissions: PermissionRequestInfo[] }
>(session: T, permissions: readonly PermissionRequestInfo[]): T {
  if (permissions.length === 0) return session
  const known = new Set(session.pendingPermissions.map((request) => request.requestId))
  return {
    ...session,
    pendingPermissions: [
      ...session.pendingPermissions,
      ...permissions.filter((request) => !known.has(request.requestId))
    ]
  }
}

export class SessionTranscriptHydrator {
  private readonly requests = new Map<string, Promise<TranscriptEntry[]>>()

  load(sessionId: string): Promise<TranscriptEntry[]> {
    const existing = this.requests.get(sessionId)
    if (existing) return existing
    const request = window.agentDesk.getTranscript(sessionId)
    this.requests.set(sessionId, request)
    void request.then(
      () => { if (this.requests.get(sessionId) === request) this.requests.delete(sessionId) },
      () => { if (this.requests.get(sessionId) === request) this.requests.delete(sessionId) }
    )
    return request
  }

  hydrateEager(
    metas: readonly SessionMeta[],
    initialActiveId: string | null,
    dependencies: EagerTranscriptHydrationDependencies
  ): Promise<void> {
    const eagerMetas = metas.filter((meta) =>
      meta.id === initialActiveId || meta.status === 'running' || meta.status === 'starting'
    )
    return Promise.all(eagerMetas.map(async (meta) => {
      const [permissionsResult, transcriptResult] = await Promise.allSettled([
        dependencies.listPendingPermissions(meta.id),
        this.load(meta.id)
      ])
      if (permissionsResult.status === 'rejected') {
        console.warn(`Failed to restore pending permissions for ${meta.id}`, permissionsResult.reason)
      }
      if (transcriptResult.status === 'rejected') {
        console.warn(`Failed to restore transcript for ${meta.id}`, transcriptResult.reason)
      }
      dependencies.apply(
        meta,
        permissionsResult.status === 'fulfilled' ? permissionsResult.value : [],
        transcriptResult.status === 'fulfilled' ? transcriptResult.value : []
      )
    })).then(() => undefined)
  }
}
