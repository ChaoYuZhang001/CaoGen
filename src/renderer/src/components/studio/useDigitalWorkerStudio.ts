import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type {
  AssignmentInput,
  DigitalWorker,
  DigitalWorkerAssignment,
  DigitalWorkerInput,
  DigitalWorkerHistorySnapshot,
  DigitalWorkerHistoryExport,
  DigitalWorkerMemoryDraftInput,
  DigitalWorkerMemorySnapshot,
  DigitalWorkerRoleRecommendation,
  DigitalWorkerTeamRecommendation,
  JsonObject,
  RoleTemplate,
  RoleTemplateInput
} from '../../../../shared/types'
import { errorMessage, roleTemplateInputForRecommendation } from './digital-worker-studio-model'
import type { TeamTemplatePack } from './team-template-market'

interface WorkerCreateRequest {
  input: DigitalWorkerInput
  activate: boolean
}

interface AssignmentRequest {
  projectId: string
  workItemId: string
  workerId: string
  assignedBy: string
  scope: JsonObject
  reason?: string
}

export interface DigitalWorkerStudioState {
  roles: RoleTemplate[]
  workers: DigitalWorker[]
  assignments: DigitalWorkerAssignment[]
  loading: boolean
  busyKey: string | null
  error: string
  notice: string
  recommendation: DigitalWorkerTeamRecommendation | null
  workerMemory: DigitalWorkerMemorySnapshot | null
  workerHistory: DigitalWorkerHistorySnapshot | null
  refresh: () => Promise<void>
  clearError: () => void
  createRole: (input: RoleTemplateInput) => Promise<boolean>
  installTeamTemplatePack: (pack: TeamTemplatePack) => Promise<void>
  recommendTeam: (projectId: string) => Promise<void>
  clearRecommendation: () => void
  adoptRecommendedRole: (recommendation: DigitalWorkerRoleRecommendation) => Promise<RoleTemplate | null>
  openWorkerMemory: (workerId: string) => Promise<void>
  closeWorkerMemory: () => void
  openWorkerHistory: (workerId: string) => Promise<void>
  closeWorkerHistory: () => void
  exportWorkerHistory: (workerId: string) => Promise<void>
  proposeWorkerMemory: (workerId: string, input: DigitalWorkerMemoryDraftInput) => Promise<boolean>
  decideWorkerMemory: (workerId: string, recordId: string, action: 'approve' | 'reject' | 'revoke' | 'delete') => Promise<void>
  createWorker: (request: WorkerCreateRequest) => Promise<boolean>
  activateWorker: (worker: DigitalWorker) => Promise<void>
  pauseWorker: (worker: DigitalWorker) => Promise<void>
  resumeWorker: (worker: DigitalWorker) => Promise<void>
  retireWorker: (worker: DigitalWorker) => Promise<void>
  refreshWorkerPerformance: (worker: DigitalWorker) => Promise<void>
  assignWorker: (request: AssignmentRequest) => Promise<boolean>
  releaseAssignment: (assignment: DigitalWorkerAssignment) => Promise<void>
}

interface StudioCollections {
  roles: RoleTemplate[]
  workers: DigitalWorker[]
  assignments: DigitalWorkerAssignment[]
  loading: boolean
  error: string
  setRoles: Dispatch<SetStateAction<RoleTemplate[]>>
  setWorkers: Dispatch<SetStateAction<DigitalWorker[]>>
  setAssignments: Dispatch<SetStateAction<DigitalWorkerAssignment[]>>
  setError: Dispatch<SetStateAction<string>>
  refresh: () => Promise<void>
}

function useStudioCollections(enabled: boolean): StudioCollections {
  const [roles, setRoles] = useState<RoleTemplate[]>([])
  const [workers, setWorkers] = useState<DigitalWorker[]>([])
  const [assignments, setAssignments] = useState<DigitalWorkerAssignment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const requestRevision = useRef(0)
  const loaded = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    const revision = ++requestRevision.current
    setLoading(true)
    setError('')
    try {
      if (typeof window.agentDesk === 'undefined') throw new Error('数字员工服务当前不可用。')
      const [nextRoles, nextWorkers, nextAssignments] = await Promise.all([
        window.agentDesk.listDigitalWorkerRoleTemplates(),
        window.agentDesk.listDigitalWorkers({ includeRetired: true }),
        window.agentDesk.listDigitalWorkerAssignments({ status: 'active' })
      ])
      if (revision !== requestRevision.current) return
      setRoles(nextRoles)
      setWorkers(nextWorkers)
      setAssignments(nextAssignments)
      loaded.current = true
    } catch (cause) {
      if (revision === requestRevision.current) setError(errorMessage(cause))
    } finally {
      if (revision === requestRevision.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      requestRevision.current += 1
      setLoading(false)
      return
    }
    if (!loaded.current) void refresh()
    return () => {
      requestRevision.current += 1
    }
  }, [enabled, refresh])

  return {
    roles,
    workers,
    assignments,
    loading,
    error,
    setRoles,
    setWorkers,
    setAssignments,
    setError,
    refresh
  }
}

interface StudioMutationState {
  busyKey: string | null
  notice: string
  recommendation: DigitalWorkerTeamRecommendation | null
  workerMemory: DigitalWorkerMemorySnapshot | null
  workerHistory: DigitalWorkerHistorySnapshot | null
  createRole: DigitalWorkerStudioState['createRole']
  installTeamTemplatePack: DigitalWorkerStudioState['installTeamTemplatePack']
  recommendTeam: DigitalWorkerStudioState['recommendTeam']
  clearRecommendation: DigitalWorkerStudioState['clearRecommendation']
  adoptRecommendedRole: DigitalWorkerStudioState['adoptRecommendedRole']
  openWorkerMemory: DigitalWorkerStudioState['openWorkerMemory']
  closeWorkerMemory: DigitalWorkerStudioState['closeWorkerMemory']
  openWorkerHistory: DigitalWorkerStudioState['openWorkerHistory']
  closeWorkerHistory: DigitalWorkerStudioState['closeWorkerHistory']
  exportWorkerHistory: DigitalWorkerStudioState['exportWorkerHistory']
  proposeWorkerMemory: DigitalWorkerStudioState['proposeWorkerMemory']
  decideWorkerMemory: DigitalWorkerStudioState['decideWorkerMemory']
  createWorker: DigitalWorkerStudioState['createWorker']
  activateWorker: DigitalWorkerStudioState['activateWorker']
  pauseWorker: DigitalWorkerStudioState['pauseWorker']
  resumeWorker: DigitalWorkerStudioState['resumeWorker']
  retireWorker: DigitalWorkerStudioState['retireWorker']
  refreshWorkerPerformance: DigitalWorkerStudioState['refreshWorkerPerformance']
  assignWorker: DigitalWorkerStudioState['assignWorker']
  releaseAssignment: DigitalWorkerStudioState['releaseAssignment']
}

function useStudioMutations(collections: StudioCollections): StudioMutationState {
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const feedback = { setBusyKey, setNotice }
  const records = useWorkerRecordMutations(collections, feedback)
  const roles = useRoleMutations(collections, feedback)
  const workers = useWorkerMutations(collections, feedback)
  const assignment = useAssignmentMutation(collections, feedback)
  return { busyKey, notice, ...records, ...roles, ...workers, ...assignment }
}

interface MutationFeedback {
  setBusyKey: Dispatch<SetStateAction<string | null>>
  setNotice: Dispatch<SetStateAction<string>>
}

function useWorkerRecordMutations(
  collections: StudioCollections,
  feedback: MutationFeedback
): Pick<StudioMutationState,
  | 'workerMemory' | 'workerHistory' | 'openWorkerMemory' | 'closeWorkerMemory'
  | 'openWorkerHistory' | 'closeWorkerHistory' | 'exportWorkerHistory'
  | 'proposeWorkerMemory' | 'decideWorkerMemory'> {
  const { setError } = collections
  const { setBusyKey, setNotice } = feedback
  const [workerMemory, setWorkerMemory] = useState<DigitalWorkerMemorySnapshot | null>(null)
  const [workerHistory, setWorkerHistory] = useState<DigitalWorkerHistorySnapshot | null>(null)
  const openWorkerHistory = useCallback(async (workerId: string): Promise<void> => {
    setBusyKey(`history:${workerId}:list`)
    setError('')
    try {
      setWorkerMemory(null)
      setWorkerHistory(await window.agentDesk.getDigitalWorkerHistory(workerId))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusyKey(null)
    }
  }, [setError])

  const exportWorkerHistory = useCallback(async (workerId: string): Promise<void> => {
    setBusyKey(`history:${workerId}:export`)
    setError('')
    try {
      const exported = await window.agentDesk.exportDigitalWorkerHistory(workerId)
      downloadWorkerHistory(exported)
      setNotice('员工交付历史已导出。')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusyKey(null)
    }
  }, [setError])

  const openWorkerMemory = useCallback(async (workerId: string): Promise<void> => {
    setBusyKey(`memory:${workerId}:list`)
    setError('')
    try {
      setWorkerHistory(null)
      setWorkerMemory(await window.agentDesk.listDigitalWorkerMemory(workerId))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusyKey(null)
    }
  }, [setError])

  const proposeWorkerMemory = useCallback(async (
    workerId: string,
    input: DigitalWorkerMemoryDraftInput
  ): Promise<boolean> => {
    setBusyKey(`memory:${workerId}:propose`)
    setError('')
    try {
      setWorkerMemory(await window.agentDesk.proposeDigitalWorkerMemory(workerId, input))
      setNotice('员工记忆草稿已提交审核。')
      return true
    } catch (cause) {
      setError(errorMessage(cause))
      return false
    } finally {
      setBusyKey(null)
    }
  }, [setError])

  const decideWorkerMemory = useCallback(async (
    workerId: string,
    recordId: string,
    action: 'approve' | 'reject' | 'revoke' | 'delete'
  ): Promise<void> => {
    setBusyKey(`memory:${recordId}:${action}`)
    setError('')
    try {
      const next = action === 'approve'
        ? await window.agentDesk.approveDigitalWorkerMemory(workerId, recordId)
        : action === 'reject'
          ? await window.agentDesk.rejectDigitalWorkerMemory(workerId, recordId)
          : action === 'revoke'
            ? await window.agentDesk.revokeDigitalWorkerMemory(workerId, recordId)
            : await window.agentDesk.deleteDigitalWorkerMemory(workerId, recordId)
      setWorkerMemory(next)
      setNotice('员工记忆状态已更新。')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusyKey(null)
    }
  }, [setError])
  return {
    workerMemory,
    workerHistory,
    openWorkerMemory,
    closeWorkerMemory: () => setWorkerMemory(null),
    openWorkerHistory,
    closeWorkerHistory: () => setWorkerHistory(null),
    exportWorkerHistory,
    proposeWorkerMemory,
    decideWorkerMemory
  }
}

function useRoleMutations(
  collections: StudioCollections,
  feedback: MutationFeedback
): Pick<StudioMutationState, 'recommendation' | 'recommendTeam' | 'clearRecommendation' | 'adoptRecommendedRole' | 'createRole' | 'installTeamTemplatePack'> {
  const { roles: currentRoles, setError, setRoles } = collections
  const { setBusyKey, setNotice } = feedback
  const [recommendation, setRecommendation] = useState<DigitalWorkerTeamRecommendation | null>(null)
  const recommendTeam = useCallback(async (projectId: string): Promise<void> => {
    setBusyKey('team:recommend')
    setError('')
    try {
      const result = await window.agentDesk.recommendDigitalWorkerTeam({ projectId })
      setRecommendation(result)
      setNotice(`已根据 Goal 推荐 ${result.roles.length} 个必要岗位。`)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusyKey(null)
    }
  }, [setError])

  const adoptRecommendedRole = useCallback(async (
    recommendation: DigitalWorkerRoleRecommendation
  ): Promise<RoleTemplate | null> => {
    setBusyKey(`recommendation:${recommendation.id}`)
    setError('')
    try {
      const created = await window.agentDesk.createDigitalWorkerRoleTemplate(
        roleTemplateInputForRecommendation(recommendation)
      )
      setRoles((current) => [...current, created].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')))
      setNotice(`岗位“${created.name}”已采纳，请确认员工策略。`)
      return created
    } catch (cause) {
      setError(errorMessage(cause))
      return null
    } finally {
      setBusyKey(null)
    }
  }, [setError, setRoles])

  const createRole = useCallback(async (input: RoleTemplateInput): Promise<boolean> => {
    setBusyKey('role:create')
    setError('')
    try {
      const created = await window.agentDesk.createDigitalWorkerRoleTemplate(input)
      setRoles((current) => [...current, created].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')))
      setNotice(`岗位“${created.name}”已创建。`)
      return true
    } catch (cause) {
      setError(errorMessage(cause))
      return false
    } finally {
      setBusyKey(null)
    }
  }, [setBusyKey, setError, setNotice, setRoles])
  const installTeamTemplatePack = useCallback(async (pack: TeamTemplatePack): Promise<void> => {
    setBusyKey(`team-template:${pack.id}`)
    setError('')
    try {
      const knownIds = new Set(currentRoles.map((role) => role.id))
      const created: RoleTemplate[] = []
      for (const input of pack.roles) {
        if (input.id && knownIds.has(input.id)) continue
        const role = await window.agentDesk.createDigitalWorkerRoleTemplate(input)
        created.push(role)
        knownIds.add(role.id)
      }
      if (created.length > 0) {
        setRoles((current) => [...current, ...created].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')))
      }
      setNotice(created.length > 0
        ? `团队模板“${pack.name}”已安装 ${created.length} 个版本化岗位。`
        : `团队模板“${pack.name}”已经是最新版本。`)
    } catch (cause) {
      setError(errorMessage(cause))
      await collections.refresh()
    } finally {
      setBusyKey(null)
    }
  }, [collections, currentRoles, setBusyKey, setError, setNotice, setRoles])
  return {
    recommendation,
    recommendTeam,
    clearRecommendation: () => setRecommendation(null),
    adoptRecommendedRole,
    createRole,
    installTeamTemplatePack
  }
}

function useWorkerMutations(
  collections: StudioCollections,
  feedback: MutationFeedback
): Pick<StudioMutationState,
  | 'createWorker' | 'activateWorker' | 'pauseWorker' | 'resumeWorker'
  | 'retireWorker' | 'refreshWorkerPerformance'> {
  const { refresh, setError, setWorkers } = collections
  const { setBusyKey, setNotice } = feedback
  const createWorker = useCallback(async (request: WorkerCreateRequest): Promise<boolean> => {
    setBusyKey('worker:create')
    setError('')
    try {
      const proposed = await window.agentDesk.createDigitalWorker(request.input)
      const created = request.activate
        ? await window.agentDesk.activateDigitalWorker(proposed.id, { expectedRevision: proposed.revision })
        : proposed
      setWorkers((current) => [...current, created])
      setNotice(`数字员工“${created.displayName}”已加入团队。`)
      return true
    } catch (cause) {
      setError(errorMessage(cause))
      await refresh()
      return false
    } finally {
      setBusyKey(null)
    }
  }, [refresh])

  const runLifecycle = useCallback(async (
    worker: DigitalWorker,
    action: 'activate' | 'pause' | 'resume' | 'retire'
  ): Promise<void> => {
    setBusyKey(`worker:${worker.id}:${action}`)
    setError('')
    try {
      const options = { expectedRevision: worker.revision }
      const updated = action === 'activate'
        ? await window.agentDesk.activateDigitalWorker(worker.id, options)
        : action === 'pause'
          ? await window.agentDesk.pauseDigitalWorker(worker.id, options)
          : action === 'resume'
            ? await window.agentDesk.resumeDigitalWorker(worker.id, options)
            : await window.agentDesk.retireDigitalWorker(worker.id, options)
      setWorkers((current) => current.map((item) => item.id === updated.id ? updated : item))
      const labels = { activate: '已启用', pause: '已暂停', resume: '已恢复', retire: '已退休' }
      setNotice(`${updated.displayName}${labels[action]}。`)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusyKey(null)
    }
  }, [setBusyKey, setError, setNotice, setWorkers])
  const refreshWorkerPerformance = useCallback(async (worker: DigitalWorker): Promise<void> => {
    setBusyKey(`worker:${worker.id}:performance`)
    setError('')
    try {
      const updated = await window.agentDesk.refreshDigitalWorkerPerformance(worker.id)
      setWorkers((current) => current.map((item) => item.id === updated.id ? updated : item))
      setNotice(`${updated.displayName} 的绩效已按当前交付记录更新。`)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusyKey(null)
    }
  }, [setBusyKey, setError, setNotice, setWorkers])
  return {
    createWorker,
    activateWorker: (worker) => runLifecycle(worker, 'activate'),
    pauseWorker: (worker) => runLifecycle(worker, 'pause'),
    resumeWorker: (worker) => runLifecycle(worker, 'resume'),
    retireWorker: (worker) => runLifecycle(worker, 'retire'),
    refreshWorkerPerformance
  }
}

function useAssignmentMutation(
  collections: StudioCollections,
  feedback: MutationFeedback
): Pick<StudioMutationState, 'assignWorker' | 'releaseAssignment'> {
  const { assignments, refresh, setAssignments, setError } = collections
  const { setBusyKey, setNotice } = feedback
  const assignWorker = useCallback(async (request: AssignmentRequest): Promise<boolean> => {
    setBusyKey(`assignment:${request.workItemId}`)
    setError('')
    const nextInput: AssignmentInput = {
      projectId: request.projectId,
      workItemId: request.workItemId,
      assigneeKind: 'digital_worker',
      assigneeId: request.workerId,
      scope: request.scope,
      assignedBy: request.assignedBy,
      reason: request.reason || undefined
    }
    try {
      const current = assignments.find(
        (item) => item.workItemId === request.workItemId && item.projectId === request.projectId && item.status === 'active'
      )
      if (current?.assigneeKind === 'digital_worker' && current.assigneeId === request.workerId) {
        setNotice('该 WorkItem 已分配给所选员工。')
        return true
      }
      const assigned = current
        ? (await window.agentDesk.reassignDigitalWorkerAssignment({
            currentAssignmentId: current.id,
            nextInput,
            expectedRevision: current.revision,
            reason: request.reason || '用户重新分配'
          })).assigned
        : await window.agentDesk.createDigitalWorkerAssignment(nextInput)
      setAssignments((items) => [...items.filter((item) => item.id !== current?.id), assigned])
      setNotice('WorkItem 分配已更新。')
      return true
    } catch (cause) {
      setError(errorMessage(cause))
      return false
    } finally {
      setBusyKey(null)
    }
  }, [assignments, setAssignments, setBusyKey, setError, setNotice])
  const releaseAssignment = useCallback(async (assignment: DigitalWorkerAssignment): Promise<void> => {
    setBusyKey(`assignment:${assignment.id}:release`)
    setError('')
    try {
      await window.agentDesk.releaseDigitalWorkerAssignment(
        assignment.id,
        { expectedRevision: assignment.revision },
        { reason: '用户在数字团队中解除 WorkItem 分配' }
      )
      setAssignments((items) => items.filter((item) => item.id !== assignment.id))
      setNotice('WorkItem 分配已解除，历史记录已保留。')
    } catch (cause) {
      setError(errorMessage(cause))
      await refresh()
    } finally {
      setBusyKey(null)
    }
  }, [refresh, setAssignments, setBusyKey, setError, setNotice])
  return { assignWorker, releaseAssignment }
}

function downloadWorkerHistory(exported: DigitalWorkerHistoryExport): void {
  const url = URL.createObjectURL(new Blob([exported.json], { type: 'application/json;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `caogen-worker-${safeFileStem(exported.workerId)}-history.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

function safeFileStem(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'worker'
}

export function useDigitalWorkerStudio(enabled = true): DigitalWorkerStudioState {
  const collections = useStudioCollections(enabled)
  const mutations = useStudioMutations(collections)
  return {
    roles: collections.roles,
    workers: collections.workers,
    assignments: collections.assignments,
    loading: collections.loading,
    error: collections.error,
    refresh: collections.refresh,
    clearError: () => collections.setError(''),
    ...mutations
  }
}
