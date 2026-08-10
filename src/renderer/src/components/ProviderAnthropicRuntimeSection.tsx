import type {
  ProviderAnthropicPromptCacheStrategy,
  ProviderAnthropicPromptCacheTtl,
  ProviderAnthropicRuntimeConfig,
  ProviderAnthropicThinkingDisplay,
  ProviderAnthropicThinkingMode
} from '../../../shared/provider-anthropic-runtime-types'
import { useT } from '../i18n'

interface Props {
  value: ProviderAnthropicRuntimeConfig | undefined
  onChange: (value: ProviderAnthropicRuntimeConfig | undefined) => void
}

export default function ProviderAnthropicRuntimeSection({ value, onChange }: Props): React.JSX.Element {
  const t = useT()
  const thinking = value?.thinking
  const promptCaching = value?.promptCaching
  const update = (patch: Partial<ProviderAnthropicRuntimeConfig>): void => {
    const next = compact({ ...(value ?? {}), ...patch }) as ProviderAnthropicRuntimeConfig
    onChange(Object.keys(next).length > 0 ? next : undefined)
  }
  const setThinkingMode = (mode: string): void => {
    if (!mode) return update({ thinking: undefined })
    if (mode === 'disabled') return update({ thinking: { mode } })
    if (mode === 'adaptive') return update({ thinking: { mode, display: thinking?.display } })
    update({
      thinking: { mode: 'enabled', budgetTokens: thinking?.budgetTokens ?? 4096, display: thinking?.display }
    })
  }
  const updateThinking = (patch: Partial<NonNullable<ProviderAnthropicRuntimeConfig['thinking']>>): void => {
    if (thinking) update({ thinking: { ...thinking, ...patch } })
  }
  const setPromptCaching = (enabled: boolean | undefined): void => {
    if (enabled === undefined) return update({ promptCaching: undefined })
    update({
      promptCaching: enabled
        ? { enabled: true, ttl: '5m', strategy: 'automatic' }
        : { enabled: false }
    })
  }
  const updatePromptCaching = (
    patch: Partial<NonNullable<ProviderAnthropicRuntimeConfig['promptCaching']>>
  ): void => {
    if (promptCaching?.enabled) update({ promptCaching: { ...promptCaching, ...patch } })
  }

  return (
    <section className="provider-advanced-section provider-anthropic-runtime-section" data-provider-anthropic-runtime>
      <div className="provider-advanced-section-title">
        <div>
          <strong>{t('providerAnthropicRuntimeTitle')}</strong>
          <div className="field-hint">{t('providerAnthropicRuntimeHint')}</div>
        </div>
        {value && Object.keys(value).length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(undefined)}>
            {t('providerAnthropicRuntimeReset')}
          </button>
        )}
      </div>
      <div className="provider-runtime-grid">
        <SelectField
          label={t('providerAnthropicThinkingMode')}
          value={thinking?.mode ?? ''}
          options={['adaptive', 'enabled', 'disabled']}
          onChange={(mode) => setThinkingMode(mode as ProviderAnthropicThinkingMode)}
        />
        {thinking?.mode === 'enabled' && (
          <NumberField
            label={t('providerAnthropicThinkingBudget')}
            value={thinking.budgetTokens}
            min={1024}
            max={1_000_000}
            onChange={(budgetTokens) => updateThinking({ budgetTokens })}
          />
        )}
        {(thinking?.mode === 'enabled' || thinking?.mode === 'adaptive') && (
          <SelectField
            label={t('providerAnthropicThinkingDisplay')}
            value={thinking.display ?? ''}
            options={['summarized', 'omitted']}
            onChange={(display) => updateThinking({
              display: display as ProviderAnthropicThinkingDisplay || undefined
            })}
          />
        )}
        <BooleanField
          label={t('providerAnthropicPromptCache')}
          value={promptCaching?.enabled}
          onChange={setPromptCaching}
        />
        {promptCaching?.enabled && (
          <SelectField
            label={t('providerAnthropicPromptCacheTtl')}
            value={promptCaching.ttl ?? '5m'}
            options={['5m', '1h']}
            onChange={(ttl) => updatePromptCaching({ ttl: ttl as ProviderAnthropicPromptCacheTtl })}
          />
        )}
        {promptCaching?.enabled && (
          <SelectField
            label={t('providerAnthropicPromptCacheStrategy')}
            value={promptCaching.strategy ?? 'automatic'}
            options={['automatic', 'system', 'tools', 'last-user']}
            onChange={(strategy) => updatePromptCaching({
              strategy: strategy as ProviderAnthropicPromptCacheStrategy
            })}
          />
        )}
        <NumberField
          label={t('providerAnthropicTopK')}
          value={value?.topK}
          min={1}
          max={1_000_000}
          onChange={(topK) => update({ topK })}
        />
      </div>
      <div className="field-hint field-hint-warning">{t('providerAnthropicSamplingDeprecated')}</div>
    </section>
  )
}

function SelectField({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: string
  options: string[]
  onChange: (value: string) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <label className="provider-advanced-field">
      <span>{label}</span>
      <select className="select" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t('providerRuntimeInherit')}</option>
        {options.map((option) => <option key={option} value={option}>{optionLabel(option, t)}</option>)}
      </select>
    </label>
  )
}

function BooleanField({
  label,
  value,
  onChange
}: {
  label: string
  value: boolean | undefined
  onChange: (value: boolean | undefined) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <label className="provider-advanced-field">
      <span>{label}</span>
      <select
        className="select"
        value={value === undefined ? '' : String(value)}
        onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value === 'true')}
      >
        <option value="">{t('providerRuntimeInherit')}</option>
        <option value="true">{t('providerRuntimeEnabled')}</option>
        <option value="false">{t('providerRuntimeDisabled')}</option>
      </select>
    </label>
  )
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange
}: {
  label: string
  value: number | undefined
  min: number
  max: number
  onChange: (value: number | undefined) => void
}): React.JSX.Element {
  return (
    <label className="provider-advanced-number">
      <span>{label}</span>
      <input
        className="input"
        type="number"
        min={min}
        max={max}
        step={1}
        value={value ?? ''}
        onChange={(event) => onChange(numberOrUndefined(event.target.value))}
      />
    </label>
  )
}

function optionLabel(option: string, t: ReturnType<typeof useT>): string {
  if (option === 'adaptive') return t('providerAnthropicThinkingAdaptive')
  if (option === 'enabled') return t('providerRuntimeEnabled')
  if (option === 'disabled') return t('providerRuntimeDisabled')
  return option
}

function numberOrUndefined(value: string): number | undefined {
  if (!value.trim()) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined))
}
