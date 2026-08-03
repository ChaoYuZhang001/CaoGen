import { useState } from 'react'
import type * as React from 'react'
import { useT } from '../i18n'
import SessionContextMenu, { type SessionMenuItem } from './SessionContextMenu'

export type SidebarProjectSort = 'recent' | 'name'

interface SidebarProjectSectionsProps {
  conversationCollapsed: boolean
  conversationContent: React.ReactNode
  conversationCount: number
  conversationEmpty: boolean
  conversationLabel: string
  forceProjectsExpanded: boolean
  onCollapseAll: () => void
  onExpandAll: () => void
  onNewProject: () => void
  onProjectSortChange: (sort: SidebarProjectSort) => void
  onToggleConversation: () => void
  projectContent: React.ReactNode
  projectCount: number
  projectSort: SidebarProjectSort
  showConversation: boolean
}

export default function SidebarProjectSections(props: SidebarProjectSectionsProps): React.JSX.Element {
  const t = useT()
  const [projectsOpen, setProjectsOpen] = useState(true)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const projectsExpanded = projectsOpen || props.forceProjectsExpanded

  const showMenu = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({ x: rect.right - 4, y: rect.bottom + 4 })
  }

  const menuItems: SessionMenuItem[] = [
    {
      key: 'sort-projects-recent',
      label: `${props.projectSort === 'recent' ? '✓ ' : ''}${t('sortProjectsRecent')}`,
      onClick: () => props.onProjectSortChange('recent')
    },
    {
      key: 'sort-projects-name',
      label: `${props.projectSort === 'name' ? '✓ ' : ''}${t('sortProjectsName')}`,
      onClick: () => props.onProjectSortChange('name')
    },
    {
      key: 'expand-all-projects',
      label: t('expandAllProjects'),
      onClick: () => {
        setProjectsOpen(true)
        props.onExpandAll()
      }
    },
    { key: 'collapse-all-projects', label: t('collapseAllProjects'), onClick: props.onCollapseAll }
  ]

  return (
    <>
      <section className="sidebar-section sidebar-projects-section">
        <div className="sidebar-projects-toolbar">
          <button
            type="button"
            className="sidebar-projects-toggle"
            aria-expanded={projectsExpanded}
            onClick={() => setProjectsOpen((value) => !value)}
          >
            <span className={`sidebar-projects-caret ${projectsExpanded ? 'is-expanded' : ''}`}>›</span>
            <span className="sidebar-projects-title">{t('projects')}</span>
            <span className="sidebar-projects-count">{props.projectCount}</span>
          </button>
          <div className="sidebar-projects-actions">
            <button
              type="button"
              className="sidebar-projects-action"
              aria-label={t('projectListActions')}
              title={t('moreActions')}
              aria-haspopup="menu"
              onClick={showMenu}
            >
              ⋯
            </button>
            <button
              type="button"
              className="sidebar-projects-action"
              aria-label={t('newProject')}
              title={t('newProject')}
              onClick={props.onNewProject}
            >
              +
            </button>
          </div>
        </div>
        {projectsExpanded && props.projectContent}
      </section>

      {props.showConversation && (
        <section className="sidebar-section sidebar-conversations-section">
          <div className="sidebar-project-group sidebar-unassigned-group" data-project-id="unassigned">
            <button className="sidebar-group-head" onClick={props.onToggleConversation}>
              <span className="sidebar-group-caret">{props.conversationCollapsed ? '▸' : '▾'}</span>
              <span className="sidebar-group-title">{props.conversationLabel}</span>
              <span className="sidebar-group-count">{props.conversationCount}</span>
            </button>
            {!props.conversationCollapsed && props.conversationContent}
            {!props.conversationCollapsed && props.conversationEmpty && (
              <div className="sidebar-empty sidebar-group-empty">{t('noSessions')}</div>
            )}
          </div>
        </section>
      )}

      {menu && (
        <SessionContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </>
  )
}
