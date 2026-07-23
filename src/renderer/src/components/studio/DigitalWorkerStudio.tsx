import { useEffect, useMemo, useState } from 'react'
import type { DigitalWorkerStatus } from '../../../../shared/types'
import type { DigitalWorkerStudioProps, StudioTab } from './digital-worker-studio-model'
import { projectOptions } from './digital-worker-studio-model'
import { useDigitalWorkerStudio } from './useDigitalWorkerStudio'
import { DigitalWorkerStudioView } from './DigitalWorkerStudioView'
import './digital-worker-studio.css'

export type {
  DigitalWorkerStudioProject,
  DigitalWorkerStudioProps,
  DigitalWorkerStudioWorkItem
} from './digital-worker-studio-model'

export default function DigitalWorkerStudio(props: DigitalWorkerStudioProps): React.JSX.Element {
  const {
    projectId,
    projects = [],
    workItems = [],
    assignedBy = 'user',
    className = '',
    onProjectChange
  } = props
  const studio = useDigitalWorkerStudio()
  const [selectedProjectId, setSelectedProjectId] = useState(projectId || '')
  const [statusFilter, setStatusFilter] = useState<'' | DigitalWorkerStatus>('')
  const [activeTab, setActiveTab] = useState<StudioTab>('team')
  const [hireRoleId, setHireRoleId] = useState<string | undefined>()
  const [hireOpen, setHireOpen] = useState(false)
  const [roleEditorOpen, setRoleEditorOpen] = useState(false)
  const [assignmentWorkerId, setAssignmentWorkerId] = useState<string | undefined>()
  const [assignmentOpen, setAssignmentOpen] = useState(false)

  useEffect(() => setSelectedProjectId(projectId || ''), [projectId])

  const availableProjects = useMemo(
    () => projectOptions(projects, projectId, studio.workers, studio.assignments, workItems),
    [projects, projectId, studio.workers, studio.assignments, workItems]
  )
  const projectWorkers = studio.workers.filter((worker) => !selectedProjectId || worker.projectId === selectedProjectId)
  const filteredWorkers = projectWorkers.filter((worker) => !statusFilter || worker.status === statusFilter)
  const assignments = studio.assignments.filter(
    (assignment) => !selectedProjectId || assignment.projectId === selectedProjectId
  )
  const projectWorkItems = workItems.filter(
    (item) => !selectedProjectId || !item.projectId || item.projectId === selectedProjectId
  )

  const selectProject = (nextProjectId: string): void => {
    setSelectedProjectId(nextProjectId)
    setHireOpen(false)
    setAssignmentOpen(false)
    onProjectChange?.(nextProjectId || undefined)
  }
  const openHire = (roleId?: string): void => {
    if (!selectedProjectId) return
    studio.clearError()
    setHireRoleId(roleId)
    setHireOpen(true)
    setAssignmentOpen(false)
    setRoleEditorOpen(false)
    setActiveTab('team')
  }

  return (
    <DigitalWorkerStudioView
      studio={studio}
      className={className}
      assignedBy={assignedBy}
      selectedProjectId={selectedProjectId}
      statusFilter={statusFilter}
      activeTab={activeTab}
      hireOpen={hireOpen}
      hireRoleId={hireRoleId}
      roleEditorOpen={roleEditorOpen}
      assignmentOpen={assignmentOpen}
      assignmentWorkerId={assignmentWorkerId}
      projects={availableProjects}
      filteredWorkers={filteredWorkers}
      projectWorkers={projectWorkers}
      assignments={assignments}
      workItems={projectWorkItems}
      onSelectProject={selectProject}
      onStatusFilter={setStatusFilter}
      onTab={setActiveTab}
      onOpenHire={openHire}
      onCloseHire={() => setHireOpen(false)}
      onRoleEditor={setRoleEditorOpen}
      onOpenAssignment={(workerId) => {
        setAssignmentWorkerId(workerId)
        setAssignmentOpen(true)
        setHireOpen(false)
      }}
      onCloseAssignment={() => setAssignmentOpen(false)}
    />
  )
}
