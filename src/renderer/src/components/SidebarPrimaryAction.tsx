import type * as React from 'react'
import type { ExperienceMode } from '../store/experience-mode'
import { useT } from '../i18n'
import { HeaderIcon } from './ChatHeaderIcons'

interface Props {
  mode: ExperienceMode
  newSessionActive: boolean
  onNewProject: () => void
  onNewSession: () => void
  onNewVideo: () => void
}

export default function SidebarPrimaryAction(props: Props): React.JSX.Element {
  const t = useT()
  if (props.mode === 'assistant') {
    return <button type="button" className={`sidebar-nav-item sidebar-new ${props.newSessionActive ? 'is-active' : ''}`}
      aria-current={props.newSessionActive ? 'page' : undefined} onClick={props.onNewSession}>
      <HeaderIcon name="compose" /><span>{t('newSession')}</span>
    </button>
  }
  if (props.mode === 'studio') {
    return <button type="button" className="sidebar-nav-item sidebar-new-project" onClick={props.onNewProject}>
      <HeaderIcon name="project" /><span>{t('newProject')}</span>
    </button>
  }
  return <button type="button" className="sidebar-nav-item sidebar-new-video" onClick={props.onNewVideo}>
    <HeaderIcon name="video" /><span>{t('newVideo')}</span>
  </button>
}
