import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type {
  AssignmentInput,
  DigitalWorker,
  DigitalWorkerAssignment,
  DigitalWorkerInput,
  JsonObject,
  RoleTemplate,
  RoleTemplateInput
} from '../../../../shared/types'
import { errorMessage } from './digital-worker-studio-model'

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
  refresh: () => Promise<void>
  clearError: () => void
  createRole: (input: RoleTemplateInput) => Promise<boolean>
  createWorker: (request: WorkerCreateRequest) => Promise<boolean>
  activateWorker: (worker: DigitalWorker) => Promise<void>
  pauseWorker: (worker: DigitalWorker) => Promise<void>
  resumeWorker: (worker: DigitalWorker) => Promise<void>
  retireWorker: (worker: DigitalWorker) => Promise<void>
  assignWorker: (request: AssignmentRequest) => Promise<boolean>
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

function useStudioCollections(): StudioCollections {
  const [roles, setRoles] = useState<RoleTemplate[]>([])
  const [workers, setWorkers] = useState<DigitalWorker[]>([])
  const [assignments, setAssignments] = useState<DigitalWorkerAssignment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const requestRevision = useRef(0)

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
    } catch (cause) {
      if (revision === requestRevision.current) setError(errorMessage(cause))
    } finally {
      if (revision === requestRevision.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    return () => {
      requestRevision.current += 1
    }
  }, [refresh])

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
  createRole: DigitalWorkerStudioState['createRole']
  createWorker: DigitalWorkerStudioState['createWorker']
  activateWorker: DigitalWorkerStudioState['activateWorker']
  pauseWorker: DigitalWorkerStudioState['pauseWorker']
  resumeWorker: DigitalWorkerStudioState['resumeWorker']
  retireWorker: DigitalWorkerStudioState['retireWorker']
  assignWorker: DigitalWorkerStudioState['assignWorker']
}

function useStudioMutations(collections: StudioCollections): StudioMutationState {
  const { assignments, refresh, setAssignments, setError, setRoles, setWorkers } = collections
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [notice, setNotice] = useState('')

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
  }, [])

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
  }, [])

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
  }, [assignments, setAssignments, setError])

  return {
    busyKey,
    notice,
    createRole,
    createWorker,
    activateWorker: (worker) => runLifecycle(worker, 'activate'),
    pauseWorker: (worker) => runLifecycle(worker, 'pause'),
    resumeWorker: (worker) => runLifecycle(worker, 'resume'),
    retireWorker: (worker) => runLifecycle(worker, 'retire'),
    assignWorker
  }
}

export function useDigitalWorkerStudio(): DigitalWorkerStudioState {
  const collections = useStudioCollections()
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
