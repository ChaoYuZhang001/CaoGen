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

export interface SettingsNavigationSlice {
  showSettings: boolean
  settingsTab: SettingsTab
  setShowSettings(value: boolean, tab?: SettingsTab): void
}

type SettingsNavigationState = Pick<SettingsNavigationSlice, 'settingsTab' | 'showSettings'>

export function createSettingsNavigationSlice(
  set: (update: SettingsNavigationState) => void
): SettingsNavigationSlice {
  return {
    showSettings: false,
    settingsTab: 'control',
    setShowSettings: (showSettings, settingsTab = 'control') => set({ showSettings, settingsTab })
  }
}
