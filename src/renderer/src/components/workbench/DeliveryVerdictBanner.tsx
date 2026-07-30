import type { DeliveryVerdictDetail } from '../../store/delivery-verdict'

const TONE_COLOR: Record<'good' | 'bad', { fg: string; bg: string; border: string; dot: string }> = {
  good: { fg: '#0f7a3d', bg: 'rgba(15,122,61,0.10)', border: 'rgba(15,122,61,0.35)', dot: '#16a34a' },
  bad: { fg: '#b42318', bg: 'rgba(180,35,24,0.10)', border: 'rgba(180,35,24,0.35)', dot: '#dc2626' }
}

const I18N = {
  zh: {
    title: '交付判定',
    verifiable: '可验收（verifiable）',
    notDone: (d: DeliveryVerdictDetail) => `未通过 / 未验收（not done）— 待验收 ${d.pending} · 验收中 ${d.verifying} · 失败 ${d.failed}`,
    hint: '模型运行已结束，但验收未通过，Goal 未完成'
  },
  en: {
    title: 'Delivery verdict',
    verifiable: 'Verifiable',
    notDone: (d: DeliveryVerdictDetail) => `Not done — pending ${d.pending} · verifying ${d.verifying} · failed ${d.failed}`,
    hint: 'Model run finished, but acceptance not passed; Goal not complete'
  }
}

/**
 * 顶部「交付判定」横幅:取值仅由 acceptances 派生(deriveDeliveryVerdict)。
 * 沿用 statusTone 语义(verifiable→good / not_done→bad),配色以内联样式落地,
 * 避免触碰既有 styles.css 的无关 WIP。
 */
export function DeliveryVerdictBanner({
  detail,
  language = 'zh'
}: {
  detail: DeliveryVerdictDetail
  language?: 'zh' | 'en'
}): React.JSX.Element {
  const tone: 'good' | 'bad' = detail.verdict === 'verifiable' ? 'good' : 'bad'
  const t = I18N[language]
  const color = TONE_COLOR[tone]
  const label = detail.verdict === 'verifiable' ? t.verifiable : t.notDone(detail)
  const hint = detail.verdict === 'not_done' && detail.modelReportedDone ? t.hint : ''
  return (
    <div
      className={`studio-result-verdict status-${tone}`}
      role="status"
      data-studio-result-verdict={detail.verdict}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        borderRadius: 6,
        margin: '0 0 8px',
        color: color.fg,
        background: color.bg,
        border: `1px solid ${color.border}`,
        fontSize: 13
      }}
    >
      <span
        aria-hidden="true"
        style={{ width: 8, height: 8, borderRadius: '50%', background: color.dot, flex: '0 0 auto' }}
      />
      <strong style={{ fontWeight: 600 }}>{t.title}</strong>
      <span>{label}</span>
      {hint && (
        <span className="studio-result-verdict-hint" style={{ opacity: 0.85 }}>
          —— {hint}
        </span>
      )}
    </div>
  )
}
