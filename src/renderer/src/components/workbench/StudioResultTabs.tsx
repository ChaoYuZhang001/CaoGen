import { rovingTabProps } from './roving-tabs'

export type StudioResultTab = 'summary' | 'artifacts' | 'evidence' | 'timeline'

export default function StudioResultTabs({
  ariaLabel,
  baseId,
  onChange,
  tabs,
  value
}: {
  ariaLabel: string
  baseId: string
  onChange: (tab: StudioResultTab) => void
  tabs: Array<{ id: StudioResultTab; label: string }>
  value: StudioResultTab
}): React.JSX.Element {
  return (
    <nav className="studio-result-tabs" role="tablist" aria-label={ariaLabel}>
      {tabs.map((item) => (
        <button
          id={`${baseId}-tab-${item.id}`}
          key={item.id}
          type="button"
          role="tab"
          {...rovingTabProps(value === item.id, `${baseId}-panel-${item.id}`)}
          className={value === item.id ? 'active' : ''}
          onClick={() => onChange(item.id)}
          data-studio-result-tab={item.id}
        >
          {item.label}
        </button>
      ))}
    </nav>
  )
}
