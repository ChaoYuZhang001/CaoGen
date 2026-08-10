import { useEffect, useMemo, useState } from 'react'
import { CloudCog, Download, History, RefreshCw, Save, ShieldCheck, Trash2, Upload, X } from 'lucide-react'
import type {
  ProviderProfileImportAction,
  ProviderProfileImportDecision,
  ProviderProfileS3ConfigInput,
  ProviderProfileS3ConfigView,
  ProviderProfileS3Preview
} from '../../../../shared/types'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import ProviderProfileRemoteHistory from './ProviderProfileRemoteHistory'
import { useProviderProfileRemoteHistory } from './useProviderProfileRemoteHistory'

type BusyState = 'save' | 'test' | 'preview' | 'publish' | 'pull' | 'remove' | ''

interface S3Draft {
  endpoint: string
  region: string
  bucket: string
  prefix: string
  forcePathStyle: boolean
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
  clearSessionToken: boolean
  autoSyncEnabled: boolean
  autoPullEnabled: boolean
  autoSyncIntervalMinutes: number
}

export default function ProviderProfileS3Panel(): React.JSX.Element {
  const s3 = useProviderProfileS3Controller()
  return <section className="provider-webdav" aria-label={s3.t('providerS3Title')} data-provider-s3>
    <S3Header s3={s3} />
    <p className="provider-webdav-safety">{s3.t('providerS3Safety')}</p>
    {s3.editing && <S3ConfigForm s3={s3} />}
    <S3Status s3={s3} />
    <ProviderProfileRemoteHistory entries={s3.history.entries} preview={s3.history.preview} decisions={s3.history.decisions} setDecisions={s3.history.setDecisions} busy={s3.history.busy} selectedChanges={s3.history.selectedChanges} onPreview={(revisionId) => void s3.history.inspect(revisionId)} onApply={() => void s3.history.apply()} onClose={s3.history.close} />
    {s3.message && <div className="notice notice-info provider-webdav-notice">{s3.message}</div>}
    {s3.error && <div className="notice notice-error provider-webdav-notice">{s3.error}</div>}
    <S3Preview s3={s3} />
  </section>
}

function useProviderProfileS3Controller() {
  const t = useT()
  const refreshProviders = useStore((state) => state.refreshProviders)
  const [config, setConfig] = useState<ProviderProfileS3ConfigView | null>(null)
  const [draft, setDraft] = useState<S3Draft>(emptyDraft())
  const [editing, setEditing] = useState(false)
  const [preview, setPreview] = useState<ProviderProfileS3Preview | null>(null)
  const [decisions, setDecisions] = useState<Record<string, ProviderProfileImportAction>>({})
  const [busy, setBusy] = useState<BusyState>('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const selectedChanges = useMemo(() => preview?.importPreview?.items.reduce(
    (count, item) => count + Number((decisions[item.id] ?? item.defaultAction) !== 'skip'), 0
  ) ?? 0, [decisions, preview])
  const history = useProviderProfileRemoteHistory({
    api: {
      list: () => window.agentDesk.listProviderProfileS3History(),
      preview: (revisionId) => window.agentDesk.previewProviderProfileS3History(revisionId),
      apply: (previewId, selected) => window.agentDesk.applyProviderProfileS3History(previewId, selected)
    },
    refreshProviders,
    onMessage: setMessage,
    onError: setError,
    appliedMessage: (result) => t('providerSyncHistoryApplied', { created: result.created, updated: result.updated })
  })

  useEffect(() => {
    void window.agentDesk.getProviderProfileS3Config().then((next) => {
      setConfig(next)
      setDraft(draftFromConfig(next))
      setEditing(!next.configured)
    }).catch((caught) => setError(errorMessage(caught)))
  }, [])

  async function save(): Promise<void> {
    setBusy('save'); clearFeedback()
    try {
      const input: ProviderProfileS3ConfigInput = {
        endpoint: draft.endpoint,
        region: draft.region,
        bucket: draft.bucket,
        prefix: draft.prefix,
        forcePathStyle: draft.forcePathStyle,
        accessKeyId: draft.accessKeyId || undefined,
        secretAccessKey: draft.secretAccessKey || undefined,
        sessionToken: draft.clearSessionToken ? '' : draft.sessionToken || undefined,
        autoSyncEnabled: draft.autoSyncEnabled,
        autoPullEnabled: draft.autoPullEnabled,
        autoSyncIntervalMinutes: draft.autoSyncIntervalMinutes
      }
      const next = await window.agentDesk.saveProviderProfileS3Config(input)
      setConfig(next); setDraft(draftFromConfig(next)); setEditing(false); setPreview(null)
      setMessage(t('providerS3Saved', { endpoint: next.endpointLabel ?? '-' }))
    } catch (caught) { setError(errorMessage(caught)) } finally { setBusy('') }
  }

  async function testConnection(): Promise<void> {
    setBusy('test'); clearFeedback()
    try {
      const result = await window.agentDesk.testProviderProfileS3Connection()
      setMessage(t('providerS3Connected', { endpoint: result.endpointLabel }))
    } catch (caught) { setError(errorMessage(caught)) } finally { setBusy('') }
  }

  async function inspect(): Promise<void> {
    setBusy('preview'); clearFeedback()
    try {
      const next = await window.agentDesk.previewProviderProfileS3Sync()
      setPreview(next)
      setDecisions(Object.fromEntries((next.importPreview?.items ?? []).map((item) => [item.id, item.defaultAction])))
      if (next.status.relation === 'in_sync') setMessage(t('providerS3Current'))
    } catch (caught) { setError(errorMessage(caught)) } finally { setBusy('') }
  }

  async function publish(allowDiverged: boolean): Promise<void> {
    if (!preview) return
    setBusy('publish'); clearFeedback()
    try {
      const result = await window.agentDesk.publishProviderProfileS3Sync(preview.previewId, allowDiverged)
      setPreview(null); setDecisions({}); setMessage(t('providerS3Published', { n: result.providerCount }))
      setConfig(await window.agentDesk.getProviderProfileS3Config())
    } catch (caught) { setError(errorMessage(caught)) } finally { setBusy('') }
  }

  async function pull(): Promise<void> {
    if (!preview?.importPreview || selectedChanges === 0) return
    setBusy('pull'); clearFeedback()
    try {
      const selected: ProviderProfileImportDecision[] = preview.importPreview.items.map((item) => ({
        itemId: item.id,
        action: decisions[item.id] ?? item.defaultAction
      }))
      const result = await window.agentDesk.applyProviderProfileS3Sync(preview.previewId, selected)
      await refreshProviders()
      setPreview(null); setDecisions({})
      setMessage(t('providerS3Pulled', { created: result.created, updated: result.updated }))
      setConfig(await window.agentDesk.getProviderProfileS3Config())
    } catch (caught) { setError(errorMessage(caught)) } finally { setBusy('') }
  }

  async function remove(): Promise<void> {
    setBusy('remove'); clearFeedback()
    try {
      const next = await window.agentDesk.removeProviderProfileS3Config()
      setConfig(next); setDraft(emptyDraft()); setEditing(true); setPreview(null); history.close(); setDecisions({})
      setMessage(t('providerS3Removed'))
    } catch (caught) { setError(errorMessage(caught)) } finally { setBusy('') }
  }

  function clearFeedback(): void { setMessage(''); setError('') }
  return {
    t, config, draft, setDraft, editing, setEditing, preview, setPreview, decisions, setDecisions,
    busy, message, error, selectedChanges, history, save, testConnection, inspect, publish, pull, remove
  }
}

type S3Controller = ReturnType<typeof useProviderProfileS3Controller>

function S3Header({ s3 }: { s3: S3Controller }): React.JSX.Element {
  const { t, config, busy } = s3
  return <div className="provider-webdav-head">
    <div><h4><CloudCog size={15} aria-hidden="true" /> {t('providerS3Title')}</h4><span>{config?.endpointLabel ?? t('providerS3NotConfigured')}</span></div>
    <div className="provider-webdav-actions">
      <button className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => s3.setEditing(!s3.editing)}>{t(s3.editing ? 'cancel' : 'providerS3Edit')}</button>
      {config?.configured && <>
        <button className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void s3.testConnection()}><ShieldCheck size={14} aria-hidden="true" /> {t(busy === 'test' ? 'providerS3Testing' : 'providerS3Test')}</button>
        <button className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void s3.inspect()}><RefreshCw size={14} aria-hidden="true" /> {t(busy === 'preview' ? 'providerS3Checking' : 'providerS3Check')}</button>
        <button className="btn btn-ghost btn-sm" disabled={Boolean(busy) || s3.history.busy} onClick={() => void s3.history.toggle()}><History size={14} aria-hidden="true" /> {t('providerSyncHistoryTitle')}</button>
        <button className="btn btn-ghost btn-icon-sm" title={t('providerS3Remove')} aria-label={t('providerS3Remove')} disabled={Boolean(busy)} onClick={() => void s3.remove()}><Trash2 size={14} aria-hidden="true" /></button>
      </>}
    </div>
  </div>
}

function S3ConfigForm({ s3 }: { s3: S3Controller }): React.JSX.Element {
  const { t, draft, setDraft, config, busy } = s3
  const patch = (value: Partial<S3Draft>): void => setDraft((current) => ({ ...current, ...value }))
  return <div className="provider-webdav-form">
    <label><span>{t('providerS3Endpoint')}</span><input className="input" type="url" value={draft.endpoint} placeholder="https://s3.example.com" disabled={Boolean(busy)} onChange={(event) => patch({ endpoint: event.target.value })} /></label>
    <label><span>{t('providerS3Region')}</span><input className="input" value={draft.region} placeholder="us-east-1" disabled={Boolean(busy)} onChange={(event) => patch({ region: event.target.value })} /></label>
    <label><span>{t('providerS3Bucket')}</span><input className="input" value={draft.bucket} disabled={Boolean(busy)} onChange={(event) => patch({ bucket: event.target.value })} /></label>
    <label><span>{t('providerS3Prefix')}</span><input className="input" value={draft.prefix} disabled={Boolean(busy)} onChange={(event) => patch({ prefix: event.target.value })} /></label>
    <label><span>{t('providerS3AccessKey')}</span><input className="input" type="password" value={draft.accessKeyId} placeholder={config?.credentialsConfigured ? t('providerS3CredentialKeep') : ''} disabled={Boolean(busy)} onChange={(event) => patch({ accessKeyId: event.target.value })} /></label>
    <label><span>{t('providerS3SecretKey')}</span><input className="input" type="password" value={draft.secretAccessKey} placeholder={config?.credentialsConfigured ? t('providerS3CredentialKeep') : ''} disabled={Boolean(busy)} onChange={(event) => patch({ secretAccessKey: event.target.value })} /></label>
    <label><span>{t('providerS3SessionToken')}</span><input className="input" type="password" value={draft.sessionToken} placeholder={config?.sessionTokenConfigured ? t('providerS3CredentialKeep') : t('providerS3Optional')} disabled={Boolean(busy) || draft.clearSessionToken} onChange={(event) => patch({ sessionToken: event.target.value })} /></label>
    <label><span>{t('providerS3Interval')}</span><input className="input" type="number" min={5} max={1440} value={draft.autoSyncIntervalMinutes} disabled={Boolean(busy) || !draft.autoSyncEnabled} onChange={(event) => patch({ autoSyncIntervalMinutes: Number(event.target.value) })} /></label>
    <label className="provider-webdav-check"><input type="checkbox" checked={draft.forcePathStyle} disabled={Boolean(busy)} onChange={(event) => patch({ forcePathStyle: event.target.checked })} /><span>{t('providerS3PathStyle')}</span></label>
    <label className="provider-webdav-check"><input type="checkbox" checked={draft.autoSyncEnabled} disabled={Boolean(busy)} onChange={(event) => patch({ autoSyncEnabled: event.target.checked })} /><span>{t('providerS3AutoSync')}</span></label>
    <label className="provider-webdav-check"><input type="checkbox" checked={draft.autoPullEnabled} disabled={Boolean(busy) || !draft.autoSyncEnabled} onChange={(event) => patch({ autoPullEnabled: event.target.checked })} /><span>{t('providerS3AutoPull')}</span></label>
    {config?.sessionTokenConfigured && <label className="provider-webdav-check"><input type="checkbox" checked={draft.clearSessionToken} disabled={Boolean(busy)} onChange={(event) => patch({ clearSessionToken: event.target.checked, sessionToken: '' })} /><span>{t('providerS3ClearSessionToken')}</span></label>}
    <div className="provider-webdav-form-actions"><button className="btn btn-primary btn-sm" disabled={Boolean(busy)} onClick={() => void s3.save()}><Save size={14} aria-hidden="true" /> {t(busy === 'save' ? 'providerS3Saving' : 'save')}</button></div>
  </div>
}

function S3Status({ s3 }: { s3: S3Controller }): React.JSX.Element | null {
  const { t, config } = s3
  if (!config?.configured) return null
  return <div className="provider-webdav-meta">
    <span>{config.accessKeyLabel ?? t('providerS3CredentialsUnavailable')}</span>
    <span>{config.autoSyncEnabled ? t('providerS3AutoEnabled', { n: config.autoSyncIntervalMinutes }) : t('providerS3AutoDisabled')}</span>
    {config.lastSyncAt && <span>{t('providerS3LastSync', { time: new Date(config.lastSyncAt).toLocaleString() })}</span>}
    {config.lastError && <span className="provider-profile-warning">{config.lastError}</span>}
  </div>
}

function S3Preview({ s3 }: { s3: S3Controller }): React.JSX.Element | null {
  const { t, preview, decisions, busy, selectedChanges } = s3
  if (!preview || preview.status.relation === 'in_sync') return null
  const overwrite = preview.status.relation === 'diverged' || preview.status.relation === 'remote_ahead'
  return <div className="provider-webdav-preview">
    <div className="provider-webdav-preview-head"><div><strong>{t('providerS3Preview')}</strong><span>{t(`providerSyncRelation_${preview.status.relation}`)}</span></div><button className="btn btn-ghost btn-icon-sm" title={t('cancel')} aria-label={t('cancel')} disabled={Boolean(busy)} onClick={() => s3.setPreview(null)}><X size={14} aria-hidden="true" /></button></div>
    {preview.requiresConflictChoice && <p className="provider-profile-warning">{t('providerS3Conflict')}</p>}
    {preview.importPreview && <S3ImportItems preview={preview} decisions={decisions} setDecisions={s3.setDecisions} busy={Boolean(busy)} />}
    <div className="provider-webdav-preview-actions">
      {preview.canPull && <button className="btn btn-ghost btn-sm" disabled={Boolean(busy) || selectedChanges === 0} onClick={() => void s3.pull()}><Download size={14} aria-hidden="true" /> {t(busy === 'pull' ? 'providerS3Applying' : 'providerS3UseRemote')}</button>}
      {preview.canPublish && <button className="btn btn-primary btn-sm" disabled={Boolean(busy)} onClick={() => void s3.publish(overwrite)}><Upload size={14} aria-hidden="true" /> {t(busy === 'publish' ? 'providerS3Publishing' : 'providerS3UseLocal')}</button>}
    </div>
  </div>
}

function S3ImportItems({ preview, decisions, setDecisions, busy }: {
  preview: ProviderProfileS3Preview
  decisions: Record<string, ProviderProfileImportAction>
  setDecisions: React.Dispatch<React.SetStateAction<Record<string, ProviderProfileImportAction>>>
  busy: boolean
}): React.JSX.Element {
  const t = useT()
  return <div className="provider-webdav-import-list">{preview.importPreview?.items.map((item) => <div className="provider-webdav-import-row" key={item.id}>
    <div><strong>{item.name}</strong><span>{item.changedFields.length ? t('providerProfileChangedFields', { fields: item.changedFields.join(', ') }) : t('providerProfileConflictNone')}</span></div>
    <select className="select provider-profile-action-select" value={decisions[item.id] ?? item.defaultAction} disabled={busy} aria-label={t('providerProfileActionFor', { name: item.name })} onChange={(event) => setDecisions((current) => ({ ...current, [item.id]: event.target.value as ProviderProfileImportAction }))}>{item.allowedActions.map((action) => <option value={action} key={action}>{t(`providerProfileAction_${action}`)}</option>)}</select>
  </div>)}</div>
}

function draftFromConfig(config: ProviderProfileS3ConfigView): S3Draft {
  return {
    endpoint: config.endpoint ?? '',
    region: config.region ?? 'us-east-1',
    bucket: config.bucket ?? '',
    prefix: config.prefix ?? 'caogen-sync',
    forcePathStyle: config.forcePathStyle,
    accessKeyId: '',
    secretAccessKey: '',
    sessionToken: '',
    clearSessionToken: false,
    autoSyncEnabled: config.autoSyncEnabled,
    autoPullEnabled: config.autoPullEnabled,
    autoSyncIntervalMinutes: config.autoSyncIntervalMinutes
  }
}

function emptyDraft(): S3Draft {
  return {
    endpoint: '', region: 'us-east-1', bucket: '', prefix: 'caogen-sync', forcePathStyle: false,
    accessKeyId: '', secretAccessKey: '', sessionToken: '', clearSessionToken: false,
    autoSyncEnabled: false, autoPullEnabled: false, autoSyncIntervalMinutes: 15
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
