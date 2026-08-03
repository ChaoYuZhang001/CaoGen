import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import type { StudioResultSnapshot } from '../../../../shared/studio-result-types'
import type { SessionMeta, TaskStrategy } from '../../../../shared/types'
import type { WelcomeSessionDraft } from './welcome-session-projection'

export const FIRST_TASK_ONBOARDING_STORAGE_KEY = 'caogen.first-task-onboarding.v1'
export const FIRST_TASK_ONBOARDING_SCHEMA_VERSION = 1 as const
const FIRST_TASK_ONBOARDING_UPDATED_EVENT = 'caogen:first-task-onboarding-updated'
const PRESET_KEYS = new Set(['understand', 'review', 'report', 'plan', 'custom'])
const autoOpenInFlight = new Set<string>()

export type FirstTaskOnboardingStatus =
  | 'needs_compute'
  | 'activating_local'
  | 'ready_to_start'
  | 'running'
  | 'reviewing_result'
  | 'completed'

export type FirstTaskProgressStep = 'compute' | 'task' | 'result' | 'acceptance'
export type FirstTaskProgressState = 'pending' | 'active' | 'done'
export type FirstTaskProgress = Record<FirstTaskProgressStep, FirstTaskProgressState>

export interface FirstTaskSubmissionGate {
  isPending(): boolean
  run<T>(operation: () => Promise<T>): Promise<{ started: false } | { started: true; value: T }>
}

export interface FirstTaskOnboardingRecordV1 {
  schemaVersion: typeof FIRST_TASK_ONBOARDING_SCHEMA_VERSION
  candidateSessionId?: string
  presetKey?: string
  startedAt?: number
  resultOpenedAt?: number
  artifactLocationIds: string[]
  completedAt?: number
  autoOpenedResultSessionId?: string
}

export interface WelcomeDraft {
  text: string
  projectChoice: string
  draft: WelcomeSessionDraft
  taskStrategy: TaskStrategy
  forkSourceTitle?: string
}

const EMPTY_RECORD: FirstTaskOnboardingRecordV1 = {
  schemaVersion: FIRST_TASK_ONBOARDING_SCHEMA_VERSION,
  artifactLocationIds: []
}

function cloneEmptyRecord(): FirstTaskOnboardingRecordV1 {
  return { ...EMPTY_RECORD, artifactLocationIds: [] }
}

export function createFirstTaskSubmissionGate(): FirstTaskSubmissionGate {
  let pending = false
  return {
    isPending: () => pending,
    async run<T>(operation: () => Promise<T>) {
      if (pending) return { started: false }
      pending = true
      try {
        return { started: true, value: await operation() }
      } finally {
        pending = false
      }
    }
  }
}

const firstTaskSubmissionGate = createFirstTaskSubmissionGate()

export function runFirstTaskSubmissionExclusive<T>(
  operation: () => Promise<T>
): Promise<{ started: false } | { started: true; value: T }> {
  return firstTaskSubmissionGate.run(operation)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function decode(value: unknown): FirstTaskOnboardingRecordV1 {
  if (!isRecord(value) || value.schemaVersion !== FIRST_TASK_ONBOARDING_SCHEMA_VERSION) {
    return cloneEmptyRecord()
  }
  const record = cloneEmptyRecord()
  if (typeof value.candidateSessionId === 'string' && value.candidateSessionId) record.candidateSessionId = value.candidateSessionId
  if (typeof value.presetKey === 'string' && PRESET_KEYS.has(value.presetKey)) record.presetKey = value.presetKey
  if (validTimestamp(value.startedAt)) record.startedAt = value.startedAt
  if (validTimestamp(value.resultOpenedAt)) record.resultOpenedAt = value.resultOpenedAt
  if (validTimestamp(value.completedAt)) record.completedAt = value.completedAt
  if (typeof value.autoOpenedResultSessionId === 'string' && value.autoOpenedResultSessionId) record.autoOpenedResultSessionId = value.autoOpenedResultSessionId
  if (Array.isArray(value.artifactLocationIds)) {
    record.artifactLocationIds = [...new Set(value.artifactLocationIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
  }
  return record
}

export function readFirstTaskOnboardingRecord(): FirstTaskOnboardingRecordV1 {
  if (typeof window === 'undefined') return cloneEmptyRecord()
  try {
    return decode(JSON.parse(window.localStorage.getItem(FIRST_TASK_ONBOARDING_STORAGE_KEY) ?? 'null'))
  } catch {
    return cloneEmptyRecord()
  }
}

function mergeFirstTaskOnboardingRecord(
  current: FirstTaskOnboardingRecordV1,
  patch: Partial<FirstTaskOnboardingRecordV1>
): FirstTaskOnboardingRecordV1 {
  const next = { ...current }
  if (next.candidateSessionId === undefined && patch.candidateSessionId !== undefined) next.candidateSessionId = patch.candidateSessionId
  if (next.presetKey === undefined && patch.presetKey !== undefined) next.presetKey = patch.presetKey
  if (next.startedAt === undefined && patch.startedAt !== undefined) next.startedAt = patch.startedAt
  if (next.resultOpenedAt === undefined && patch.resultOpenedAt !== undefined) next.resultOpenedAt = patch.resultOpenedAt
  if (next.completedAt === undefined && patch.completedAt !== undefined) next.completedAt = patch.completedAt
  if (next.autoOpenedResultSessionId === undefined && patch.autoOpenedResultSessionId !== undefined) next.autoOpenedResultSessionId = patch.autoOpenedResultSessionId
  if (patch.artifactLocationIds) {
    next.artifactLocationIds = [...new Set([...current.artifactLocationIds, ...patch.artifactLocationIds])]
  }
  return next
}

function persistFirstTaskOnboardingRecord(record: FirstTaskOnboardingRecordV1): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(FIRST_TASK_ONBOARDING_STORAGE_KEY, JSON.stringify(record))
    window.dispatchEvent(new CustomEvent(FIRST_TASK_ONBOARDING_UPDATED_EVENT))
  } catch { /* storage is optional */ }
}

export function patchFirstTaskOnboardingRecord(
  patch: Partial<FirstTaskOnboardingRecordV1>
): FirstTaskOnboardingRecordV1 {
  const next = mergeFirstTaskOnboardingRecord(readFirstTaskOnboardingRecord(), patch)
  persistFirstTaskOnboardingRecord(next)
  return next
}

export function restartFirstTaskOnboardingCandidate(
  candidateSessionId: string
): FirstTaskOnboardingRecordV1 {
  const current = readFirstTaskOnboardingRecord()
  if (!isActiveFirstTaskCandidate(current, candidateSessionId)) return current
  const next = cloneEmptyRecord()
  persistFirstTaskOnboardingRecord(next)
  return next
}

export function isActiveFirstTaskCandidate(
  record: FirstTaskOnboardingRecordV1,
  sessionId: string | null | undefined
): boolean {
  return Boolean(sessionId && !record.completedAt && record.candidateSessionId === sessionId)
}

export function isFirstTaskComplete(snapshot: StudioResultSnapshot | undefined, record: FirstTaskOnboardingRecordV1): boolean {
  if (!snapshot || snapshot.state !== 'ready') return false
  const opened = new Set(record.artifactLocationIds)
  const hasOpenedArtifact = snapshot.artifacts.some((artifact) =>
    artifact.locations.some((location) => location.availability === 'available' && opened.has(location.id))
  )
  if (!hasOpenedArtifact || snapshot.acceptances.length === 0) return false
  return snapshot.acceptances.every((acceptance) =>
    acceptance.status === 'passed' ||
    (acceptance.status === 'waived' && Boolean(acceptance.waiverReason?.trim()) && Boolean(acceptance.waivedBy?.trim()))
  )
}

export function deriveFirstTaskOnboardingStatus(input: {
  record: FirstTaskOnboardingRecordV1
  providersHydrated: boolean
  computeAvailable: boolean
  activatingLocal: boolean
  sessionStatus?: 'starting' | 'running' | 'idle' | 'error' | 'closed'
  snapshot?: StudioResultSnapshot
}): FirstTaskOnboardingStatus {
  const { record, providersHydrated, computeAvailable, activatingLocal, sessionStatus, snapshot } = input
  if (isFirstTaskComplete(snapshot, record) || record.completedAt) return 'completed'
  if (sessionStatus === 'starting' || sessionStatus === 'running') return 'running'
  if (snapshot?.state === 'ready' || record.resultOpenedAt || sessionStatus === 'idle' || sessionStatus === 'closed') {
    return 'reviewing_result'
  }
  if (!providersHydrated || (!computeAvailable && activatingLocal)) return 'activating_local'
  if (!computeAvailable) return 'needs_compute'
  return 'ready_to_start'
}

export function deriveFirstTaskProgress(
  status: FirstTaskOnboardingStatus,
  record: FirstTaskOnboardingRecordV1
): FirstTaskProgress {
  if (status === 'completed') {
    return { compute: 'done', task: 'done', result: 'done', acceptance: 'done' }
  }
  if (status === 'reviewing_result') {
    const artifactOpened = record.artifactLocationIds.length > 0
    return {
      compute: 'done',
      task: 'done',
      result: artifactOpened ? 'done' : 'active',
      acceptance: artifactOpened ? 'active' : 'pending'
    }
  }
  if (status === 'running' || status === 'ready_to_start') {
    return { compute: 'done', task: 'active', result: 'pending', acceptance: 'pending' }
  }
  return { compute: 'active', task: 'pending', result: 'pending', acceptance: 'pending' }
}

export function useFirstTaskOnboardingRecord(): FirstTaskOnboardingRecordV1 {
  const [record, setRecord] = useState(readFirstTaskOnboardingRecord)
  useEffect(() => {
    const onStorage = (): void => setRecord(readFirstTaskOnboardingRecord())
    window.addEventListener('storage', onStorage)
    window.addEventListener(FIRST_TASK_ONBOARDING_UPDATED_EVENT, onStorage)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(FIRST_TASK_ONBOARDING_UPDATED_EVENT, onStorage)
    }
  }, [])
  return record
}

function isHistoricalFirstTaskComplete(snapshot: StudioResultSnapshot): boolean {
  if (snapshot.state !== 'ready') return false
  const hasAvailableArtifact = snapshot.artifacts.some((artifact) =>
    artifact.locations.some((location) => location.availability === 'available')
  )
  return hasAvailableArtifact && snapshot.acceptances.length > 0 && snapshot.acceptances.every((acceptance) =>
    acceptance.status === 'passed' ||
    (acceptance.status === 'waived' && Boolean(acceptance.waiverReason?.trim()) && Boolean(acceptance.waivedBy?.trim()))
  )
}

export function recentTopLevelSessionIds(
  order: readonly string[],
  sessions: Readonly<Record<string, { meta: SessionMeta }>>,
  limit = 20
): string[] {
  const orderIndex = new Map(order.map((id, index) => [id, index]))
  return order
    .filter((id) => sessions[id] && !sessions[id].meta.parentSessionId)
    .sort((leftId, rightId) => {
      const createdAtDifference = sessions[rightId].meta.createdAt - sessions[leftId].meta.createdAt
      return createdAtDifference || (orderIndex.get(leftId) ?? 0) - (orderIndex.get(rightId) ?? 0)
    })
    .slice(0, limit)
}

async function scanHistoricalFirstTask(sessionIds: string[]): Promise<boolean> {
  let cursor = 0
  let found = false
  const worker = async (): Promise<void> => {
    while (!found && cursor < sessionIds.length) {
      const sessionId = sessionIds[cursor++]
      try {
        if (isHistoricalFirstTaskComplete(await window.agentDesk.getStudioResultSnapshot(sessionId))) found = true
      } catch { /* historical sessions may no longer be readable */ }
    }
  }
  await Promise.all([worker(), worker()])
  return found
}

export function useFirstTaskOnboardingLifecycle(): void {
  const hydrated = useStore((state) => state.hydrated)
  const sessions = useStore((state) => state.sessions)
  const order = useStore((state) => state.order)
  const record = useFirstTaskOnboardingRecord()
  const candidateSessionId = record.candidateSessionId
  const candidateStatus = candidateSessionId ? sessions[candidateSessionId]?.meta.status : undefined
  const openPanel = useStore((state) => state.openPanel)
  useEffect(() => {
    const record = readFirstTaskOnboardingRecord()
    if (!hydrated || record.candidateSessionId || record.completedAt) return
    const topLevelSessionIds = recentTopLevelSessionIds(order, sessions)
    let cancelled = false
    void scanHistoricalFirstTask(topLevelSessionIds).then((completed) => {
      if (!cancelled && completed) patchFirstTaskOnboardingRecord({ completedAt: Date.now() })
    })
    return () => { cancelled = true }
  }, [hydrated, order, sessions])
  useEffect(() => {
    if (!candidateSessionId || !candidateStatus || !['idle', 'closed'].includes(candidateStatus)) return
    if (record.autoOpenedResultSessionId === candidateSessionId || autoOpenInFlight.has(candidateSessionId)) return
    autoOpenInFlight.add(candidateSessionId)
    let cancelled = false
    void window.agentDesk.getStudioResultSnapshot(candidateSessionId).then((snapshot) => {
      if (cancelled || snapshot.state !== 'ready') return
      const latest = readFirstTaskOnboardingRecord()
      if (!isActiveFirstTaskCandidate(latest, candidateSessionId)) return
      if (latest.autoOpenedResultSessionId !== candidateSessionId) {
        patchFirstTaskOnboardingRecord({
          autoOpenedResultSessionId: candidateSessionId,
          resultOpenedAt: Date.now()
        })
        if (useStore.getState().activeId !== candidateSessionId) useStore.getState().selectSession(candidateSessionId)
        openPanel('result')
      }
      if (isFirstTaskComplete(snapshot, readFirstTaskOnboardingRecord())) {
        patchFirstTaskOnboardingRecord({ completedAt: Date.now() })
      }
    }).catch(() => undefined).finally(() => autoOpenInFlight.delete(candidateSessionId))
    return () => { cancelled = true }
  }, [candidateSessionId, candidateStatus, openPanel, record])
}
