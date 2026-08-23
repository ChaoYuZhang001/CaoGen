import type * as React from 'react'
import { flushSync } from 'react-dom'
import { Film, FolderKanban, MessageSquare } from 'lucide-react'
import type { ExperienceMode } from '../store/experience-mode'
import './app-mode-switcher.css'

interface Props {
  language: 'zh' | 'en'
  mode: ExperienceMode
  onChange: (mode: ExperienceMode) => void
}

export default function AppModeSwitcher({ language, mode, onChange }: Props): React.JSX.Element {
  const labels = language === 'zh'
    ? { navigation: '工作空间', assistant: '助手', studio: '项目', video: '视频' }
    : { navigation: 'Workspace', assistant: 'Assistant', studio: 'Projects', video: 'Video' }
  const selectMode = (next: ExperienceMode): void => {
    if (next === mode) return
    flushSync(() => onChange(next))
  }

  const options: Array<{ mode: ExperienceMode; label: string; icon: React.JSX.Element }> = [
    { mode: 'assistant', label: labels.assistant, icon: <MessageSquare size={14} strokeWidth={1.8} aria-hidden="true" /> },
    { mode: 'studio', label: labels.studio, icon: <FolderKanban size={14} strokeWidth={1.8} aria-hidden="true" /> },
    { mode: 'video', label: labels.video, icon: <Film size={14} strokeWidth={1.8} aria-hidden="true" /> }
  ]

  return (
    <nav className="app-mode-bar no-drag" aria-label={labels.navigation} data-experience-mode-switcher>
      <div className="app-mode-switcher">
        {options.map((option) => (
          <button
            key={option.mode}
            type="button"
            aria-label={option.label}
            aria-pressed={mode === option.mode}
            data-experience-mode-option={option.mode}
            className={mode === option.mode ? 'active' : ''}
            title={option.label}
            onClick={() => selectMode(option.mode)}
          >
            <span className="app-mode-icon">{option.icon}</span>
            <span className="app-mode-label">{option.label}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}
