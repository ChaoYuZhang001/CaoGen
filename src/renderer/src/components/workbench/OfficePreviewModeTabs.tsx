import type { OfficePreviewLabels } from './PreviewRenderer'
import { rovingTabProps } from './roving-tabs'

export type OfficePreviewMode = 'structure' | 'visual'

export default function OfficePreviewModeTabs({
  activeMode,
  baseId,
  labels,
  onSelect,
  visualReady
}: {
  activeMode: OfficePreviewMode
  baseId: string
  labels: OfficePreviewLabels
  onSelect: (mode: OfficePreviewMode) => void
  visualReady: boolean
}): React.JSX.Element {
  const panelId = `${baseId}-panel`
  return (
    <div aria-label={labels.modeLabel} role="tablist" style={styles.control}>
      <button id={`${baseId}-visual-tab`} className="btn btn-ghost btn-sm" data-office-preview-mode-option="visual" disabled={!visualReady} {...rovingTabProps(activeMode === 'visual', panelId)} onClick={() => onSelect('visual')} role="tab" style={activeMode === 'visual' ? styles.active : undefined} type="button">
        {labels.visual}
      </button>
      <button id={`${baseId}-structure-tab`} className="btn btn-ghost btn-sm" data-office-preview-mode-option="structure" {...rovingTabProps(activeMode === 'structure', panelId)} onClick={() => onSelect('structure')} role="tab" style={activeMode === 'structure' ? styles.active : undefined} type="button">
        {labels.structure}
      </button>
    </div>
  )
}

const styles = {
  control: {
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    padding: 2,
    border: '1px solid var(--border)',
    borderRadius: 7,
    background: 'var(--bg-input)'
  },
  active: {
    borderColor: 'var(--border-strong)',
    background: 'var(--bg-card)',
    color: 'var(--text)'
  }
} as const
