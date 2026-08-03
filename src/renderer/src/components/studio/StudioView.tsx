import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import type { Goal, ProjectSquad, ProjectWorkspace, WorkItem, WorkItemComment } from '../../../../shared/types'
import DigitalWorkerStudio from './DigitalWorkerStudio'
import ProjectWorkspaceStudio, { type ProjectWorkspaceStudioContext } from './ProjectWorkspaceStudio'
import { useStore } from '../../store'
import './studio-view.css'

type StudioSection = 'work' | 'team'

const EMPTY_CONTEXT: ProjectWorkspaceStudioContext = {
  project: null,
  goals: [],
  workItems: [],
  squads: [],
  comments: []
}

function StudioView({ active = true }: { active?: boolean }): React.JSX.Element {
  const initialProjectId = useStore((state) => state.preferredProjectWorkspaceId) ?? undefined
  const newProjectRequest = useStore((state) => state.studioNewProjectNonce)
  const [section, setSection] = useState<StudioSection>('work')
  const [context, setContext] = useState<ProjectWorkspaceStudioContext>(EMPTY_CONTEXT)
  const [workspaceActivated, setWorkspaceActivated] = useState(false)

  const updateContext = useCallback((next: ProjectWorkspaceStudioContext): void => {
    setContext((current) => sameContext(current, next) ? current : next)
  }, [])
  useEffect(() => {
    if (!active || section !== 'work' || workspaceActivated) return
    const frameIds: number[] = []
    const activateAfterPaint = (framesRemaining: number): void => {
      frameIds.push(window.requestAnimationFrame(() => {
        if (framesRemaining === 1) setWorkspaceActivated(true)
        else activateAfterPaint(framesRemaining - 1)
      }))
    }
    // Keep project hydration out of the shell's first interactive paint.
    activateAfterPaint(3)
    return () => frameIds.forEach((frameId) => window.cancelAnimationFrame(frameId))
  }, [active, section, workspaceActivated])

  const project = context.project
  const projects = useMemo(() => project ? [{ id: project.id, name: project.name }] : [], [project])
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
        <ProjectWorkspaceStudio
          active={workspaceActivated}
          initialProjectId={initialProjectId}
          newProjectRequest={newProjectRequest}
          onContextChange={updateContext}
        />
      </div>
      <div className="studio-section" hidden={section !== 'team'} aria-hidden={section !== 'team'}>
        <DigitalWorkerStudio
          active={active && section === 'team'}
          projectId={project?.id}
          projects={projects}
          workItems={context.workItems}
          assignedBy="user"
        />
      </div>
    </div>
  )
}

export default memo(StudioView)

function sameContext(left: ProjectWorkspaceStudioContext, right: ProjectWorkspaceStudioContext): boolean {
  return sameRecord(left.project, right.project) &&
    sameRecordList(left.goals, right.goals) &&
    sameRecordList(left.workItems, right.workItems) &&
    sameRecordList(left.squads, right.squads) &&
    sameRecordList(left.comments, right.comments)
}

function sameRecord(
  left: ProjectWorkspace | null,
  right: ProjectWorkspace | null
): boolean {
  return left?.id === right?.id && left?.revision === right?.revision
}

function sameRecordList(
  left: Array<Goal | WorkItem | ProjectSquad | WorkItemComment>,
  right: Array<Goal | WorkItem | ProjectSquad | WorkItemComment>
): boolean {
  return left.length === right.length && left.every((item, index) => {
    const candidate = right[index]
    return candidate?.id === item.id && candidate.revision === item.revision
  })
}
