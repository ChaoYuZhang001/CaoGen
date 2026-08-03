import type * as React from 'react'
import { flushSync } from 'react-dom'
import type { ExperienceMode } from '../store/experience-mode'
import './app-mode-switcher.css'

interface Props {
  language: 'zh' | 'en'
  mode: ExperienceMode
  onChange: (mode: ExperienceMode) => void
}

export default function AppModeSwitcher({ language, mode, onChange }: Props): React.JSX.Element {
  const labels = language === 'zh'
    ? { navigation: '工作模式', assistant: '助手', studio: '工作台' }
    : { navigation: 'Work mode', assistant: 'Assistant', studio: 'Studio' }
  const selectMode = (next: ExperienceMode): void => {
    if (next === mode) return
    flushSync(() => onChange(next))
  }

  return (
    <nav className="app-mode-bar no-drag" role="group" aria-label={labels.navigation} data-experience-mode-switcher>
      <div className="app-mode-switcher">
        <button
          type="button"
          aria-pressed={mode === 'assistant'}
          data-experience-mode-option="assistant"
          className={mode === 'assistant' ? 'active' : ''}
          onClick={() => selectMode('assistant')}
        >
          {labels.assistant}
        </button>
        <button
          type="button"
          aria-pressed={mode === 'studio'}
          data-experience-mode-option="studio"
          className={mode === 'studio' ? 'active' : ''}
          onClick={() => selectMode('studio')}
        >
          {labels.studio}
        </button>
      </div>
    </nav>
  )
}
