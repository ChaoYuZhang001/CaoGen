import type * as React from 'react'
import type { AppSettings } from '../../../shared/types'
import type { ExperienceMode } from '../store/experience-mode'
import type { ExperiencePreferenceRecommendation } from '../store/experience-recommendation'
import { useT } from '../i18n'
import AppModeSwitcher from './AppModeSwitcher'
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
  mode: ExperienceMode
  recommendation?: ExperiencePreferenceRecommendation
  settings: AppSettings
  onExperienceModeChange: (mode: ExperienceMode) => void
  onOpenControlRoom: () => void
  onOpenSettings: () => void
  onUpdateSettings: (patch: Partial<AppSettings>) => Promise<void>
}

export default function SidebarFooter({
  language,
  mode,
  recommendation,
  settings,
  onExperienceModeChange,
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
      <AppModeSwitcher language={language} mode={mode} onChange={onExperienceModeChange} />
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
