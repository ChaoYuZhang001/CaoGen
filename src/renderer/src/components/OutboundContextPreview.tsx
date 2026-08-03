import { useCallback, useEffect, useState } from 'react'
import type { ImageAttachmentView, OutboundContextManifest } from '../../../shared/types'
import { useT } from '../i18n'
import { useExperienceProjection } from './experience/ExperienceProjection'

interface OutboundPreviewInput {
  sessionId: string | null
  receiverKey: string
  text: string
  images: ImageAttachmentView[]
}

export function useOutboundContextPreview(input: OutboundPreviewInput) {
  const [manifest, setManifest] = useState<OutboundContextManifest | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!input.sessionId) {
      setManifest(null)
      setError(null)
      return
    }
    const sessionId = input.sessionId
    let cancelled = false
    const timer = window.setTimeout(() => {
      void window.agentDesk.previewOutboundContext(sessionId, {
        text: input.text,
        images: input.images
      }).then((next) => {
        if (cancelled) return
        setManifest(next)
        setError(null)
      }, (cause) => {
        if (cancelled) return
        setManifest(null)
        setError(cause instanceof Error ? cause.message : String(cause))
      })
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [input.images, input.receiverKey, input.sessionId, input.text])

  const rejectBlockedSend = useCallback((): boolean => {
    if (!manifest?.blocked) return false
    setError(manifest.blockReasons.join('；'))
    return true
  }, [manifest])
  const sendDisabled = useCallback(
    (busy: boolean): boolean => busy || manifest?.blocked === true,
    [manifest]
  )

  return { error, manifest, rejectBlockedSend, sendDisabled }
}

function outboundPreviewLabels(
  manifest: OutboundContextManifest,
  t: (key: string, params?: Record<string, string | number>) => string
): string[] {
  const included = manifest.items.filter((item) => item.decision === 'included').length
  const excluded = manifest.items.filter((item) => item.decision === 'excluded').length
  const labels = [
    manifest.receiver.model,
    t(manifest.receiver.locality === 'local' ? 'outboundLocal' : 'outboundRemote'),
    manifest.dataClasses.join(' / ') || t('outboundNoContext'),
    t('outboundIdentifiedItems', { n: included })
  ]
  if (manifest.scopeCompleteness === 'partial') labels.push(t('outboundPartialScope'))
  if (excluded > 0) labels.push(t('outboundExcludedItems', { n: excluded }))
  if (manifest.routingMayChangeReceiver && !manifest.failoverAllowed) labels.push(t('outboundFailoverRestricted'))
  if (manifest.blocked) labels.push(manifest.blockReasons.join('；'))
  return labels
}

export function OutboundContextPreview({
  error,
  manifest
}: {
  error: string | null
  manifest: OutboundContextManifest | null
}): React.JSX.Element | null {
  const t = useT()
  const projection = useExperienceProjection()
  if (!manifest && !error) return null
  return (
    <>
      {manifest && (
        <div
          className={`outbound-context-preview ${manifest.blocked ? 'outbound-context-preview-blocked' : ''}`}
          role={manifest.blocked ? 'alert' : 'status'}
          data-outbound-context-preview
          data-outbound-provider-id={manifest.receiver.providerId}
          data-outbound-locality={manifest.receiver.locality}
          data-outbound-blocked={manifest.blocked ? 'true' : 'false'}
          data-outbound-failover-allowed={manifest.failoverAllowed ? 'true' : 'false'}
          data-outbound-scope-completeness={manifest.scopeCompleteness}
        >
          {projection === 'studio' && <strong>{manifest.receiver.providerName}</strong>}
          {outboundPreviewLabels(manifest, t).slice(projection === 'assistant' ? 1 : 0).map((label, index) => (
            <span key={`${index}:${label}`}>{label}</span>
          ))}
        </div>
      )}
      {error && <div className="composer-error" role="alert">{error}</div>}
    </>
  )
}
