import { useStore } from '../store'
import { useT } from '../i18n'

/** [标题 key, 描述 key];渲染时经 t() 取当前语言文案 */
const FEATURES: Array<[string, string]> = [
  ['featParallel', 'featParallelDesc'],
  ['featTools', 'featToolsDesc'],
  ['featDiff', 'featDiffDesc'],
  ['featPerm', 'featPermDesc'],
  ['featCost', 'featCostDesc'],
  ['featResume', 'featResumeDesc']
]

export default function WelcomeView(): React.JSX.Element {
  const t = useT()
  const setShowNewSession = useStore((s) => s.setShowNewSession)

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-mark">◆</div>
        <h1 className="welcome-title">CaoGen</h1>
        <p className="welcome-sub">{t('welcomeSub')}</p>
        <button className="btn btn-primary btn-lg" onClick={() => setShowNewSession(true)}>
          {t('welcomeCta')}
        </button>
        <div className="welcome-grid">
          {FEATURES.map(([titleKey, descKey]) => (
            <div key={titleKey} className="welcome-card">
              <div className="welcome-card-title">{t(titleKey)}</div>
              <div className="welcome-card-desc">{t(descKey)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
