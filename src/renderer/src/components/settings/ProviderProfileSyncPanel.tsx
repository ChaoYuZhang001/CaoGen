import { useEffect, useMemo, useState } from 'react'
import { Download, FolderSync, RefreshCw, Unplug, Upload, X } from 'lucide-react'
import type {
  ProviderProfileImportAction,
  ProviderProfileImportDecision,
  ProviderProfileSyncPreview,
  ProviderProfileSyncStatus
} from '../../../../shared/types'
import { useT } from '../../i18n'
import { useStore } from '../../store'

type BusyState = 'configure' | 'preview' | 'publish' | 'pull' | 'disconnect' | ''

function useProviderProfileSyncController() {
  const t = useT()
  const refreshProviders = useStore((state) => state.refreshProviders)
  const [status, setStatus] = useState<ProviderProfileSyncStatus | null>(null)
  const [preview, setPreview] = useState<ProviderProfileSyncPreview | null>(null)
  const [decisions, setDecisions] = useState<Record<string, ProviderProfileImportAction>>({})
  const [busy, setBusy] = useState<BusyState>('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const selectedChanges = useMemo(() => preview?.importPreview?.items.reduce(
    (count, item) => count + Number((decisions[item.id] ?? item.defaultAction) !== 'skip'),
    0
  ) ?? 0, [decisions, preview])

  useEffect(() => {
    void window.agentDesk.getProviderProfileSyncStatus()
      .then(setStatus)
      .catch((caught) => setError(errorMessage(caught)))
  }, [])

  async function configure(): Promise<void> {
    setBusy('configure'); clearFeedback()
    try {
      const next = await window.agentDesk.chooseProviderProfileSyncDirectory()
      if (next) {
        setStatus(next)
        setPreview(null)
        setMessage(t('providerSyncConfigured', { name: next.directoryName ?? '-' }))
      }
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy('')
    }
  }

  async function inspect(): Promise<void> {
    setBusy('preview'); clearFeedback()
    try {
      const next = await window.agentDesk.previewProviderProfileSync()
      setStatus(next.status)
      setPreview(next)
      setDecisions(Object.fromEntries(
        (next.importPreview?.items ?? []).map((item) => [item.id, item.defaultAction])
      ))
      if (next.status.relation === 'in_sync') setMessage(t('providerSyncAlreadyCurrent'))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy('')
    }
  }

  async function publish(allowDiverged: boolean): Promise<void> {
    if (!preview) return
    setBusy('publish'); clearFeedback()
    try {
      const result = await window.agentDesk.publishProviderProfileSync(preview.previewId, allowDiverged)
      setStatus(result.status)
      setPreview(null)
      setDecisions({})
      setMessage(t('providerSyncPublished', { n: result.providerCount }))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy('')
    }
  }

  async function pull(): Promise<void> {
    if (!preview?.importPreview || selectedChanges === 0) return
    setBusy('pull'); clearFeedback()
    try {
      const selected: ProviderProfileImportDecision[] = preview.importPreview.items.map((item) => ({
        itemId: item.id,
        action: decisions[item.id] ?? item.defaultAction
      }))
      const result = await window.agentDesk.applyProviderProfileSync(preview.previewId, selected)
      await refreshProviders()
      setStatus(result.status)
      setPreview(null)
      setDecisions({})
      setMessage(t('providerSyncPulled', { created: result.created, updated: result.updated }))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy('')
    }
  }

  async function disconnect(): Promise<void> {
    setBusy('disconnect'); clearFeedback()
    try {
      setStatus(await window.agentDesk.disconnectProviderProfileSync())
      setPreview(null)
      setDecisions({})
      setMessage(t('providerSyncDisconnected'))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy('')
    }
  }

  function clearFeedback(): void {
    setMessage('')
    setError('')
  }

  return {
    t, status, preview, decisions, busy, message, error, selectedChanges,
    setDecisions, setPreview, configure, inspect, publish, pull, disconnect
  }
}

export default function ProviderProfileSyncPanel(): React.JSX.Element {
  const sync = useProviderProfileSyncController()
  const { t, message, error } = sync
  return (
    <section className="provider-sync" aria-label={t('providerSyncTitle')} data-provider-sync>
      <SyncHeader sync={sync} />
      <p className="provider-sync-safety">{t('providerSyncSafety')}</p>
      <SyncStateView sync={sync} />
      {message && <div className="notice notice-info provider-sync-notice">{message}</div>}
      {error && <div className="notice notice-error provider-sync-notice">{error}</div>}
      <SyncPreview sync={sync} />
    </section>
  )
}

type SyncController = ReturnType<typeof useProviderProfileSyncController>

function SyncHeader({ sync }: { sync: SyncController }): React.JSX.Element {
  const { t, status, busy } = sync
  return <div className="provider-sync-head">
    <div>
      <h4><FolderSync size={15} aria-hidden="true" /> {t('providerSyncTitle')}</h4>
      <span>{status?.configured ? status.directoryName : t('providerSyncNotConfigured')}</span>
    </div>
    <div className="provider-sync-actions">
      <button className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void sync.configure()}>
        <FolderSync size={14} aria-hidden="true" /> {status?.configured ? t('providerSyncChangeFolder') : t('providerSyncChooseFolder')}
      </button>
      {status?.configured && <>
        <button className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void sync.inspect()}>
          <RefreshCw size={14} aria-hidden="true" /> {busy === 'preview' ? t('providerSyncChecking') : t('providerSyncCheck')}
        </button>
        <button className="btn btn-ghost btn-icon-sm" title={t('providerSyncDisconnect')} aria-label={t('providerSyncDisconnect')} disabled={Boolean(busy)} onClick={() => void sync.disconnect()}>
          <Unplug size={14} aria-hidden="true" />
        </button>
      </>}
    </div>
  </div>
}

function SyncStateView({ sync }: { sync: SyncController }): React.JSX.Element | null {
  const { t, status } = sync
  if (!status?.configured) return null
  return <div className={`provider-sync-state provider-sync-state-${status.relation}`}>
    <strong>{t(`providerSyncRelation_${status.relation}`)}</strong>
    <span>{syncCounts(status, t)}</span>
  </div>
}

function SyncPreview({ sync }: { sync: SyncController }): React.JSX.Element | null {
  const { t, preview, decisions, busy, selectedChanges } = sync
  if (!preview || preview.status.relation === 'in_sync') return null
  const overwriteRemote = preview.status.relation === 'diverged' || preview.status.relation === 'remote_ahead'
  return <div className="provider-sync-preview">
    <div className="provider-sync-preview-head">
      <strong>{t('providerSyncPreviewTitle')}</strong>
      <button className="btn btn-ghost btn-icon-sm" title={t('cancel')} aria-label={t('cancel')} disabled={Boolean(busy)} onClick={() => sync.setPreview(null)}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
    {preview.requiresConflictChoice && <p className="provider-profile-warning">{t('providerSyncConflictWarning')}</p>}
    {preview.importPreview && <SyncImportItems preview={preview} decisions={decisions} setDecisions={sync.setDecisions} busy={Boolean(busy)} />}
    <div className="provider-sync-preview-actions">
      {preview.canPull && <button className="btn btn-ghost btn-sm" disabled={Boolean(busy) || selectedChanges === 0} onClick={() => void sync.pull()}>
        <Download size={14} aria-hidden="true" /> {busy === 'pull' ? t('providerSyncApplying') : t('providerSyncUseRemote')}
      </button>}
      {preview.canPublish && <button className="btn btn-primary btn-sm" disabled={Boolean(busy)} onClick={() => void sync.publish(overwriteRemote)}>
        <Upload size={14} aria-hidden="true" /> {busy === 'publish' ? t('providerSyncPublishing') : t('providerSyncUseLocal')}
      </button>}
    </div>
  </div>
}

function SyncImportItems({
  preview,
  decisions,
  setDecisions,
  busy
}: {
  preview: ProviderProfileSyncPreview
  decisions: Record<string, ProviderProfileImportAction>
  setDecisions: React.Dispatch<React.SetStateAction<Record<string, ProviderProfileImportAction>>>
  busy: boolean
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="provider-sync-import-list">
      {preview.importPreview?.items.map((item) => (
        <div className="provider-sync-import-row" key={item.id}>
          <div>
            <strong>{item.name}</strong>
            <span>{item.changedFields.length > 0 ? t('providerProfileChangedFields', { fields: item.changedFields.join(', ') }) : t('providerProfileConflictNone')}</span>
          </div>
          <select
            className="select provider-profile-action-select"
            aria-label={t('providerProfileActionFor', { name: item.name })}
            value={decisions[item.id] ?? item.defaultAction}
            disabled={busy}
            onChange={(event) => setDecisions((current) => ({ ...current, [item.id]: event.target.value as ProviderProfileImportAction }))}
          >
            {item.allowedActions.map((action) => <option value={action} key={action}>{t(`providerProfileAction_${action}`)}</option>)}
          </select>
        </div>
      ))}
    </div>
  )
}

function syncCounts(status: ProviderProfileSyncStatus, t: ReturnType<typeof useT>): string {
  return status.remoteProviderCount === undefined
    ? t('providerSyncLocalCount', { n: status.localProviderCount })
    : t('providerSyncCounts', { local: status.localProviderCount, remote: status.remoteProviderCount })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
