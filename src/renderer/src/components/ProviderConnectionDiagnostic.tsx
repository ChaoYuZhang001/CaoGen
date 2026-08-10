import type { ProviderModelFetchError } from '../../../shared/types'
import { useT } from '../i18n'

export default function ProviderConnectionDiagnostic({
  error,
  onAction
}: {
  error: ProviderModelFetchError
  onAction: () => void
}): React.JSX.Element {
  const t = useT()
  const credentialLabel = error.credentialStyle.authMode === 'none'
    ? t('providerDiagnosticNoCredential')
    : error.credentialStyle.headerNames.length > 0
      ? error.credentialStyle.headerNames.join(' / ')
      : t('providerDiagnosticUnspecifiedHeader')
  const context = error.diagnosticContext
  const credentialSource = context.credentialSource === 'none'
    ? t('providerDiagnosticCredentialSource_none')
    : context.credentialSource === 'stored-active'
      ? context.credentialLabel
        ? t('providerDiagnosticCredentialSource_storedLabel', { label: context.credentialLabel })
        : t('providerDiagnosticCredentialSource_stored-active')
      : t('providerDiagnosticCredentialSource_explicit')
  return (
    <section className="provider-connection-diagnostic" data-provider-connection-diagnostic>
      <div className="provider-diagnostic-heading">
        <strong>{t('providerDiagnosticTitle')}</strong>
        <span>{error.status ? `HTTP ${error.status}` : t('providerDiagnosticNoStatus')}</span>
      </div>
      <p>{error.message}</p>
      <div className="provider-diagnostic-facts">
        <DiagnosticFact label={t('providerDiagnosticProtocol')} value={t(`providerDiagnosticProtocol_${context.generationProtocol}`)} />
        <DiagnosticFact label={t('providerDiagnosticGenerationPath')} value={context.generationEndpointPath} code />
        <DiagnosticFact label={t('providerDiagnosticCredentialSource')} value={credentialSource} />
        <DiagnosticFact label={t('providerDiagnosticCredential')} value={credentialLabel} code />
      </div>
      <div className="provider-diagnostic-scope">{t('providerDiagnosticCatalogScope')}</div>
      {error.attempts.length > 0 && (
        <ol className="provider-diagnostic-attempts">
          {error.attempts.map((attempt, index) => (
            <li key={`${attempt.endpointPath}-${index}`}>
              <code>{attempt.endpointPath}</code>
              <span>{attempt.status ?? t('providerDiagnosticNoStatus')} / {t(`providerDiagnosticResult_${attempt.result}`)}</span>
            </li>
          ))}
        </ol>
      )}
      <button type="button" className="btn btn-ghost btn-sm" onClick={onAction}>
        {t(`providerDiagnosticAction_${error.suggestedAction}`)}
      </button>
    </section>
  )
}

function DiagnosticFact({
  label,
  value,
  code = false
}: {
  label: string
  value: string
  code?: boolean
}): React.JSX.Element {
  return (
    <div className="provider-diagnostic-fact">
      <span>{label}</span>
      {code ? <code>{value}</code> : <strong>{value}</strong>}
    </div>
  )
}
