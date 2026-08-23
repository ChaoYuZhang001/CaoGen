import { useEffect, useRef, useState } from 'react'
import type { MediaStudioSnapshot } from '../../../../shared/media-types'
import type { ProjectWorkspace, WorkItem } from '../../../../shared/project-workspace-types'

const INITIAL_REFRESH_DELAY_MS = 500
const REFRESH_INTERVAL_MS = 5_000

export const EMPTY_MEDIA_SNAPSHOT: MediaStudioSnapshot = {
  schemaVersion: 12,
  revision: 0,
  productions: [],
  jobs: [],
  providers: [],
  projectStorage: [],
  snapshotDigest: ''
}

export function useOfficeOperationalData(): {
  mediaSnapshot: MediaStudioSnapshot
  projectSnapshot: { projects: ProjectWorkspace[]; workItems: WorkItem[] }
  operationalDataReady: boolean
} {
  const [mediaSnapshot, setMediaSnapshot] = useState<MediaStudioSnapshot>(EMPTY_MEDIA_SNAPSHOT)
  const [projectSnapshot, setProjectSnapshot] = useState<{ projects: ProjectWorkspace[]; workItems: WorkItem[] }>({ projects: [], workItems: [] })
  const [operationalDataReady, setOperationalDataReady] = useState(false)
  const refreshSequence = useRef(0)

  useEffect(() => {
    if (typeof window.agentDesk === 'undefined') return
    let cancelled = false
    const refresh = async (): Promise<void> => {
      const sequence = ++refreshSequence.current
      try {
        const [media, projects, workItems] = await Promise.all([
          window.agentDesk.getMediaStudio(),
          window.agentDesk.listProjectWorkspaces({ includeArchived: true }),
          window.agentDesk.listProjectWorkItems()
        ])
        if (!cancelled && sequence === refreshSequence.current) {
          setMediaSnapshot(media)
          setProjectSnapshot({ projects, workItems })
        }
      } catch (error) {
        if (!cancelled) console.error('[agent-desk] Failed to load CaoGen Control Room operations', error)
      } finally {
        if (!cancelled && sequence === refreshSequence.current) setOperationalDataReady(true)
      }
    }
    let intervalTimer: number | null = null
    const initialTimer = window.setTimeout(() => {
      void refresh()
      intervalTimer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS)
    }, INITIAL_REFRESH_DELAY_MS)
    const refreshOnFocus = (): void => { void refresh() }
    window.addEventListener('focus', refreshOnFocus)
    return () => {
      cancelled = true
      window.clearTimeout(initialTimer)
      if (intervalTimer !== null) window.clearInterval(intervalTimer)
      window.removeEventListener('focus', refreshOnFocus)
    }
  }, [])

  return { mediaSnapshot, projectSnapshot, operationalDataReady }
}
