import type {
  ProviderGeminiRuntimeConfig,
  ProviderGeminiThinkingLevel
} from '../../../shared/provider-gemini-runtime-types'
import { useT } from '../i18n'

interface Props {
  value: ProviderGeminiRuntimeConfig | undefined
  onChange: (value: ProviderGeminiRuntimeConfig | undefined) => void
}

export default function ProviderGeminiRuntimeSection({ value, onChange }: Props): React.JSX.Element {
  const t = useT()
  const thinking = value?.thinking
  const update = (patch: Partial<ProviderGeminiRuntimeConfig>): void => {
    const next = compact({ ...(value ?? {}), ...patch }) as ProviderGeminiRuntimeConfig
    onChange(Object.keys(next).length > 0 ? next : undefined)
  }
  const updateThinking = (patch: Partial<NonNullable<ProviderGeminiRuntimeConfig['thinking']>>): void => {
    const next = compact({ ...(thinking ?? {}), ...patch }) as NonNullable<ProviderGeminiRuntimeConfig['thinking']>
    update({ thinking: Object.keys(next).length > 0 ? next : undefined })
  }
  const control = thinking?.level ? 'level' : thinking?.budgetTokens !== undefined ? 'budget' : ''
  const setControl = (next: string): void => {
    if (next === 'level') return updateThinking({ budgetTokens: undefined, level: 'medium' })
    if (next === 'budget') return updateThinking({ level: undefined, budgetTokens: -1 })
    updateThinking({ level: undefined, budgetTokens: undefined })
  }

  return (
    <section className="provider-advanced-section provider-gemini-runtime-section" data-provider-gemini-runtime>
      <div className="provider-advanced-section-title">
        <div>
          <strong>{t('providerGeminiRuntimeTitle')}</strong>
          <div className="field-hint">{t('providerGeminiRuntimeHint')}</div>
        </div>
        {value && Object.keys(value).length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(undefined)}>
            {t('providerGeminiRuntimeReset')}
          </button>
        )}
      </div>
      <div className="provider-runtime-grid">
        <NumberField label={t('providerGeminiTopK')} value={value?.topK} min={1} max={1_000_000} onChange={(topK) => update({ topK })} />
        <BooleanField label={t('providerGeminiIncludeThoughts')} value={thinking?.includeThoughts} onChange={(includeThoughts) => updateThinking({ includeThoughts })} />
        <SelectField label={t('providerGeminiThinkingControl')} value={control} options={['budget', 'level']} onChange={setControl} />
        {control === 'budget' && (
          <NumberField label={t('providerGeminiThinkingBudget')} value={thinking?.budgetTokens} min={-1} max={1_000_000} onChange={(budgetTokens) => updateThinking({ budgetTokens })} />
        )}
        {control === 'level' && (
          <SelectField label={t('providerGeminiThinkingLevel')} value={thinking?.level ?? ''} options={['minimal', 'low', 'medium', 'high']} onChange={(level) => updateThinking({ level: level as ProviderGeminiThinkingLevel || undefined })} />
        )}
      </div>
      <div className="field-hint">{t('providerGeminiThinkingBudgetHint')}</div>
    </section>
  )
}

function SelectField({ label, value, options, onChange }: {
  label: string; value: string; options: string[]; onChange: (value: string) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <label className="provider-advanced-field">
      <span>{label}</span>
      <select className="select" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t('providerRuntimeInherit')}</option>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  )
}

function BooleanField({ label, value, onChange }: {
  label: string; value: boolean | undefined; onChange: (value: boolean | undefined) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <label className="provider-advanced-field">
      <span>{label}</span>
      <select className="select" value={value === undefined ? '' : String(value)} onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value === 'true')}>
        <option value="">{t('providerRuntimeInherit')}</option>
        <option value="true">{t('providerRuntimeEnabled')}</option>
        <option value="false">{t('providerRuntimeDisabled')}</option>
      </select>
    </label>
  )
}

function NumberField({ label, value, min, max, onChange }: {
  label: string; value: number | undefined; min: number; max: number; onChange: (value: number | undefined) => void
}): React.JSX.Element {
  return (
    <label className="provider-advanced-number">
      <span>{label}</span>
      <input className="input" type="number" min={min} max={max} step={1} value={value ?? ''} onChange={(event) => onChange(numberOrUndefined(event.target.value))} />
    </label>
  )
}

function numberOrUndefined(value: string): number | undefined {
  if (!value.trim()) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined))
}
