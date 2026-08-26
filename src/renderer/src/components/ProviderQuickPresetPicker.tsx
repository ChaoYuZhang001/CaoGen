import type { ProviderPreset } from '../store'
import { useT } from '../i18n'
import ProviderPresetCatalog from './ProviderPresetCatalog'

export default function ProviderQuickPresetPicker({
  preset,
  presets,
  onSelect
}: {
  preset?: ProviderPreset
  presets: ProviderPreset[]
  onSelect: (key: string) => void
}): React.JSX.Element {
  const t = useT()
  return <>
    <div className="provider-quick-selected-service">
      <span>{t('providerQuickSelectedPreset')}</span>
      <strong>{preset?.label ?? t('providerQuickUnavailable')}</strong>
    </div>
    <details className="provider-quick-preset-picker" data-provider-quick-preset-picker>
      <summary>{t('providerQuickBrowsePresets')}</summary>
      <ProviderPresetCatalog compact presets={presets} onSelect={(next) => onSelect(next.key)} />
    </details>
  </>
}
