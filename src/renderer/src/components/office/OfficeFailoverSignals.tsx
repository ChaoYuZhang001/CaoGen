import { useT } from '../../i18n'
import type { OfficeSessionSignal } from './model'

export default function OfficeFailoverSignals({ signal }: { signal: OfficeSessionSignal }): React.JSX.Element {
  const t = useT()
  return (
    <>
      {signal.failover && (
        <div>
          <span>{t('officeFailover')}</span>
          <strong>{signal.failover.fromName} → {signal.failover.toName}</strong>
        </div>
      )}
      {signal.keyFailover && (
        <div>
          <span>{t('officeKeyFailover')}</span>
          <strong title={signal.keyFailover.reason}>
            {signal.keyFailover.fromKeyLabel} → {signal.keyFailover.toKeyLabel}
          </strong>
        </div>
      )}
      {signal.modelFailover && (
        <div>
          <span>{t('officeModelFailover')}</span>
          <strong title={signal.modelFailover.reason}>
            {signal.modelFailover.fromModel} → {signal.modelFailover.toModel}
          </strong>
        </div>
      )}
    </>
  )
}
