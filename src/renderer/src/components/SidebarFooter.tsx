import type * as React from 'react'
import type { AppSettings } from '../../../shared/types'
import type { ExperiencePreferenceRecommendation } from '../store/experience-recommendation'
import { useT } from '../i18n'
import { HeaderIcon } from './ChatHeaderIcons'
import { ExperiencePreferenceSuggestion } from './ExperiencePreferenceSuggestion'
import { preloadOfficeView } from './office/loadOffice'

function preloadControlRoom(event: React.SyntheticEvent<HTMLButtonElement>): void {
  const button = event.currentTarget
  if (button.dataset.officePreloadState === 'loading' || button.dataset.officePreloadState === 'ready') return
  button.dataset.officePreloadState = 'loading'
  void preloadOfficeView().then((ready) => {
    button.dataset.officePreloadState = ready ? 'ready' : 'failed'
  })
}

interface SidebarFooterProps {
  language: 'zh' | 'en'
  recommendation?: ExperiencePreferenceRecommendation
  settings: AppSettings
  onOpenControlRoom: () => void
  onOpenSettings: () => void
  onUpdateSettings: (patch: Partial<AppSettings>) => Promise<void>
}

export default function SidebarFooter({
  language,
  recommendation,
  settings,
  onOpenControlRoom,
  onOpenSettings,
  onUpdateSettings
}: SidebarFooterProps): React.JSX.Element {
  const t = useT()

  return (
    <div className="sidebar-footer">
      {recommendation && (
        <ExperiencePreferenceSuggestion
          language={language}
          recommendation={recommendation}
          settings={settings}
          onUpdate={onUpdateSettings}
        />
      )}
      <button
        type="button"
        className="sidebar-nav-item"
        data-sidebar-action="control-room"
        data-control-room-role="global-overview"
        aria-label={t('office3d')}
        title={t('office3d')}
        onFocus={preloadControlRoom}
        onPointerEnter={preloadControlRoom}
        onClick={onOpenControlRoom}
      >
        <HeaderIcon name="office" />
        <span>{t('office3d')}</span>
      </button>
      <button
        type="button"
        className="sidebar-nav-item"
        data-sidebar-action="settings"
        aria-label={t('settings')}
        title={t('settings')}
        onClick={onOpenSettings}
      >
        <HeaderIcon name="settings" />
        <span>{t('settings')}</span>
      </button>
    </div>
  )
}
