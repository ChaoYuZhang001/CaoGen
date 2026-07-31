export type SettingsTab =
  | 'control'
  | 'general'
  | 'permissions'
  | 'project'
  | 'persona'
  | 'office'
  | 'providers'
  | 'plugins'
  | 'migrate'

export type SettingsContext = 'welcome-provider-recovery'

export interface SettingsNavigationSlice {
  showSettings: boolean
  settingsTab: SettingsTab
  settingsContext: SettingsContext | null
  setShowSettings(value: boolean, tab?: SettingsTab, context?: SettingsContext): void
}

type SettingsNavigationState = Pick<
  SettingsNavigationSlice,
  'settingsContext' | 'settingsTab' | 'showSettings'
>

export function createSettingsNavigationSlice(
  set: (update: SettingsNavigationState) => void
): SettingsNavigationSlice {
  return {
    showSettings: false,
    settingsTab: 'control',
    settingsContext: null,
    setShowSettings: (showSettings, settingsTab = 'control', settingsContext) =>
      set({
        showSettings,
        settingsTab,
        settingsContext: showSettings ? settingsContext ?? null : null
      })
  }
}
