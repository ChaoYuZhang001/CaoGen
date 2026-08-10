import type { ProviderGenerationProbeResult, ProviderModelSuggestedAction } from '../../../shared/types'
import { useT } from '../i18n'

export default function ProviderGenerationProbe({
  result,
  onAction
}: {
  result: ProviderGenerationProbeResult
  onAction?: (action: ProviderModelSuggestedAction) => void
}): React.JSX.Element {
  const t = useT()
  const credential = result.credentialSource === 'stored-active' && result.credentialLabel
    ? t('providerDiagnosticCredentialSource_storedLabel', { label: result.credentialLabel })
    : t(`providerDiagnosticCredentialSource_${result.credentialSource}`)
  return (
    <section className={`provider-generation-probe is-${result.ok ? 'success' : 'failure'}`} data-provider-generation-probe>
      <div className="provider-generation-probe-heading">
        <strong>{t('providerGenerationProbeTitle')}</strong>
        <span>{t(`providerGenerationProbeOutcome_${result.outcome}`)}</span>
      </div>
      <div className="provider-diagnostic-facts">
        <ProbeFact label={t('providerDiagnosticProtocol')} value={t(`providerDiagnosticProtocol_${result.protocol}`)} />
        <ProbeFact label={t('providerDiagnosticGenerationPath')} value={result.endpointPath} code />
        <ProbeFact label={t('providerDiagnosticCredentialSource')} value={credential} />
        <ProbeFact
          label={t('providerDiagnosticCredential')}
          value={result.credentialHeaderNames.length > 0 ? result.credentialHeaderNames.join(' / ') : t('providerDiagnosticNoCredential')}
          code
        />
      </div>
      <p>{t('providerGenerationProbeSummary', {
        status: result.status ?? t('providerDiagnosticNoStatus'),
        latencyMs: result.latencyMs
      })}</p>
      {!result.ok && <p data-provider-generation-diagnosis>{t(`providerGenerationProbeReason_${result.reasonCode}`)}</p>}
      {!result.ok && onAction && result.suggestedActions.length > 0 && (
        <div className="provider-model-probe-actions" data-provider-generation-actions>
          {result.suggestedActions.map((action) => (
            <button
              key={action}
              type="button"
              className="btn btn-ghost btn-sm"
              data-provider-generation-action={action}
              onClick={() => onAction(action)}
            >
              {t(`providerDiagnosticAction_${action}`)}
            </button>
          ))}
        </div>
      )}
      <p className="provider-generation-probe-billing">{t('providerGenerationProbeBillingNotice')}</p>
    </section>
  )
}

function ProbeFact({ label, value, code = false }: { label: string; value: string; code?: boolean }): React.JSX.Element {
  return (
    <div className="provider-diagnostic-fact">
      <span>{label}</span>
      {code ? <code>{value}</code> : <strong>{value}</strong>}
    </div>
  )
}
