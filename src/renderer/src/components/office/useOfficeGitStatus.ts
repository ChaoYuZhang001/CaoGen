import { useEffect, useState } from 'react'
import type { GitStatus } from '../../../../shared/types'

const INITIAL_REFRESH_DELAY_MS = 650
const BATCH_SIZE = 2

function gitStatusError(id: string, err: unknown): GitStatus {
  return {
    ok: false,
    cwd: '',
    branch: '',
    files: [],
    staged: 0,
    unstaged: 0,
    untracked: 0,
    error: `office git status failed for ${id}: ${err instanceof Error ? err.message : String(err)}`
  }
}

export function useOfficeGitStatus(visibleIds: string[], visibleIdsKey: string): Record<string, GitStatus | undefined> {
  const [statusBySession, setStatusBySession] = useState<Record<string, GitStatus | undefined>>({})

  useEffect(() => {
    if (typeof window.agentDesk === 'undefined') return
    let cancelled = false
    const refresh = async (): Promise<void> => {
      if (visibleIds.length === 0) {
        if (!cancelled) setStatusBySession({})
        return
      }
      const entries: Array<readonly [string, GitStatus]> = []
      for (let offset = 0; offset < visibleIds.length; offset += BATCH_SIZE) {
        const batch = visibleIds.slice(offset, offset + BATCH_SIZE)
        const batchEntries = await Promise.all(
          batch.map(async (id) => {
            try {
              return [id, await window.agentDesk.gitStatus(id)] as const
            } catch (err) {
              return [id, gitStatusError(id, err)] as const
            }
          })
        )
        entries.push(...batchEntries)
        if (cancelled) return
      }
      if (cancelled) return
      const next: Record<string, GitStatus | undefined> = {}
      for (const [id, status] of entries) next[id] = status
      setStatusBySession(next)
    }
    let intervalTimer: number | null = null
    const initialTimer = window.setTimeout(() => {
      void refresh()
      intervalTimer = window.setInterval(() => void refresh(), 60_000)
    }, INITIAL_REFRESH_DELAY_MS)
    return () => {
      cancelled = true
      window.clearTimeout(initialTimer)
      if (intervalTimer !== null) window.clearInterval(intervalTimer)
    }
  }, [visibleIds, visibleIdsKey])

  return statusBySession
}
