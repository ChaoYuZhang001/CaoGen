import { Check, Lightbulb, X } from 'lucide-react'
import type * as React from 'react'
import type { AppSettings } from '../../../shared/types'
import type { ExperiencePreferenceRecommendation } from '../store/experience-recommendation'

export function ExperiencePreferenceSuggestion({
  language,
  recommendation,
  settings,
  onUpdate
}: {
  language: 'zh' | 'en'
  recommendation: ExperiencePreferenceRecommendation
  settings: AppSettings
  onUpdate: (patch: Partial<AppSettings>) => Promise<void>
}): React.JSX.Element {
  const zh = language === 'zh'
  const title = recommendationTitle(recommendation, zh)
  const reason = recommendationReason(recommendation, zh)
  const apply = (): void => {
    void onUpdate({
      ...(recommendation.mode ? { experienceMode: recommendation.mode } : {}),
      ...(recommendation.layout ? { layout: { ...settings.layout, ...recommendation.layout } } : {}),
      experienceRecommendationDismissedId: recommendation.id
    })
  }
  const dismiss = (): void => {
    void onUpdate({ experienceRecommendationDismissedId: recommendation.id })
  }

  return (
    <aside className="experience-preference-suggestion" aria-label={zh ? '体验偏好建议' : 'Experience preference suggestion'}>
      <div className="experience-preference-copy">
        <Lightbulb size={14} aria-hidden="true" />
        <span><strong>{title}</strong><small>{reason}</small></span>
        <button type="button" className="experience-preference-dismiss" onClick={dismiss} aria-label={zh ? '忽略建议' : 'Dismiss suggestion'} title={zh ? '忽略建议' : 'Dismiss suggestion'}>
          <X size={13} aria-hidden="true" />
        </button>
      </div>
      <button type="button" className="experience-preference-apply" onClick={apply}>
        <Check size={13} aria-hidden="true" />
        {zh ? '用于以后任务' : 'Use for future tasks'}
      </button>
    </aside>
  )
}

function recommendationTitle(recommendation: ExperiencePreferenceRecommendation, zh: boolean): string {
  if (recommendation.mode === 'studio') return zh ? '建议默认使用工作台' : 'Make Studio the default'
  if (recommendation.mode === 'assistant') return zh ? '建议默认使用助手' : 'Make Assistant the default'
  return zh ? '建议使用紧凑布局' : 'Use a compact layout'
}

function recommendationReason(recommendation: ExperiencePreferenceRecommendation, zh: boolean): string {
  if (recommendation.mode === 'studio') {
    return zh
      ? `最近任务中 ${recommendation.projectTaskCount} 个属于项目工作流`
      : `${recommendation.projectTaskCount} recent tasks use project workflows`
  }
  if (recommendation.mode === 'assistant') {
    return zh
      ? `最近任务中 ${recommendation.conversationTaskCount} 个是独立对话`
      : `${recommendation.conversationTaskCount} recent tasks are standalone conversations`
  }
  return zh
    ? `${recommendation.projectCount} 个项目与较多任务更适合紧凑显示`
    : `${recommendation.projectCount} projects and recent tasks benefit from compact display`
}
