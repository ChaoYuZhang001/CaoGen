import { useCallback, useState } from 'react'
import type { Goal, ProjectWorkspace, WorkItem } from '../../../../shared/types'
import DigitalWorkerStudio from './DigitalWorkerStudio'
import ProjectWorkspaceStudio, { type ProjectWorkspaceStudioContext } from './ProjectWorkspaceStudio'
import './studio-view.css'

type StudioSection = 'work' | 'team'

const EMPTY_CONTEXT: ProjectWorkspaceStudioContext = {
  project: null,
  goals: [],
  workItems: []
}

export default function StudioView(): React.JSX.Element {
  const [section, setSection] = useState<StudioSection>('work')
  const [context, setContext] = useState<ProjectWorkspaceStudioContext>(EMPTY_CONTEXT)

  const updateContext = useCallback((next: ProjectWorkspaceStudioContext): void => {
    setContext((current) => sameContext(current, next) ? current : next)
  }, [])

  const project = context.project
  return (
    <div className="studio-view" data-studio-view>
      <nav className="studio-section-switcher" role="group" aria-label="工作台视图">
        <button
          type="button"
          aria-pressed={section === 'work'}
          className={section === 'work' ? 'active' : ''}
          onClick={() => setSection('work')}
        >
          项目与任务
        </button>
        <button
          type="button"
          aria-pressed={section === 'team'}
          className={section === 'team' ? 'active' : ''}
          onClick={() => setSection('team')}
        >
          数字团队
        </button>
      </nav>

      <div className="studio-section" hidden={section !== 'work'} aria-hidden={section !== 'work'}>
        <ProjectWorkspaceStudio onContextChange={updateContext} />
      </div>
      <div className="studio-section" hidden={section !== 'team'} aria-hidden={section !== 'team'}>
        <DigitalWorkerStudio
          projectId={project?.id}
          projects={project ? [{ id: project.id, name: project.name }] : []}
          workItems={context.workItems}
          assignedBy="user"
        />
      </div>
    </div>
  )
}

function sameContext(left: ProjectWorkspaceStudioContext, right: ProjectWorkspaceStudioContext): boolean {
  return sameRecord(left.project, right.project) &&
    sameRecordList(left.goals, right.goals) &&
    sameRecordList(left.workItems, right.workItems)
}

function sameRecord(
  left: ProjectWorkspace | null,
  right: ProjectWorkspace | null
): boolean {
  return left?.id === right?.id && left?.revision === right?.revision
}

function sameRecordList(
  left: Array<Goal | WorkItem>,
  right: Array<Goal | WorkItem>
): boolean {
  return left.length === right.length && left.every((item, index) => {
    const candidate = right[index]
    return candidate?.id === item.id && candidate.revision === item.revision
  })
}
