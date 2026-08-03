import type { DeliveryVerdictDetail } from '../../store/delivery-verdict'

const COUNT_TONE: Record<string, string> = {
  pending: '#b45309',
  verifying: '#b45309',
  passed: '#0f7a3d',
  failed: '#b42318',
  waived: '#6b7280'
}

const I18N = {
  zh: {
    title: '本 Goal 验收',
    pending: '待验收',
    verifying: '验收中',
    passed: '已通过',
    failed: '失败',
    waived: '已豁免'
  },
  en: {
    title: 'Goal acceptance',
    pending: 'pending',
    verifying: 'verifying',
    passed: 'passed',
    failed: 'failed',
    waived: 'waived'
  }
}

/** Acceptance 状态聚合条:展示 pending/verifying/passed/failed/waived 计数(AC-5)。 */
export function AcceptanceSummary({
  detail,
  language = 'zh'
}: {
  detail: DeliveryVerdictDetail
  language?: 'zh' | 'en'
}): React.JSX.Element {
  const t = I18N[language]
  const counts: Array<[keyof typeof t, number]> = [
    ['pending', detail.pending],
    ['verifying', detail.verifying],
    ['passed', detail.passed],
    ['failed', detail.failed],
    ['waived', detail.waived]
  ]
  return (
    <div
      className="studio-result-acceptance-summary"
      data-studio-result-acceptance-summary
      style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', margin: '0 0 8px', fontSize: 13 }}
    >
      <span style={{ fontWeight: 600 }}>{t.title}</span>
      {counts.map(([key, value]) => (
        <span
          key={key}
          data-acceptance-count={key}
          style={{ color: COUNT_TONE[key], fontWeight: value > 0 ? 600 : 400 }}
        >
          {t[key]} {value}
        </span>
      ))}
    </div>
  )
}
