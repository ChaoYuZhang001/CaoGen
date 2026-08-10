import { useEffect, useMemo, useState } from 'react'
import { Cloud, Download, History, RefreshCw, Save, ShieldCheck, Trash2, Upload, X } from 'lucide-react'
import type {
  ProviderProfileImportAction,
  ProviderProfileImportDecision,
  ProviderProfileWebDavConfigInput,
  ProviderProfileWebDavConfigView,
  ProviderProfileWebDavPreview
} from '../../../../shared/types'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import ProviderProfileRemoteHistory from './ProviderProfileRemoteHistory'
import { useProviderProfileRemoteHistory } from './useProviderProfileRemoteHistory'

type BusyState = 'save' | 'test' | 'preview' | 'publish' | 'pull' | 'remove' | ''

interface WebDavDraft {
  baseUrl: string
  username: string
  password: string
  remotePath: string
  autoSyncEnabled: boolean
  autoPullEnabled: boolean
  autoSyncIntervalMinutes: number
  clearPassword: boolean
}

export default function ProviderProfileWebDavPanel(): React.JSX.Element {
  const webdav = useProviderProfileWebDavController()
  return <section className="provider-webdav" aria-label={webdav.t('providerWebDavTitle')} data-provider-webdav>
    <WebDavHeader webdav={webdav} />
    <p className="provider-webdav-safety">{webdav.t('providerWebDavSafety')}</p>
    {webdav.editing && <WebDavConfigForm webdav={webdav} />}
    <WebDavStatus webdav={webdav} />
    <ProviderProfileRemoteHistory entries={webdav.history.entries} preview={webdav.history.preview} decisions={webdav.history.decisions} setDecisions={webdav.history.setDecisions} busy={webdav.history.busy} selectedChanges={webdav.history.selectedChanges} onPreview={(revisionId) => void webdav.history.inspect(revisionId)} onApply={() => void webdav.history.apply()} onClose={webdav.history.close} />
    {webdav.message && <div className="notice notice-info provider-webdav-notice">{webdav.message}</div>}
    {webdav.error && <div className="notice notice-error provider-webdav-notice">{webdav.error}</div>}
    <WebDavPreview webdav={webdav} />
  </section>
}

function useProviderProfileWebDavController() {
  const t = useT()
  const refreshProviders = useStore((state) => state.refreshProviders)
  const [config, setConfig] = useState<ProviderProfileWebDavConfigView | null>(null)
  const [draft, setDraft] = useState<WebDavDraft>(emptyDraft())
  const [editing, setEditing] = useState(false)
  const [preview, setPreview] = useState<ProviderProfileWebDavPreview | null>(null)
  const [decisions, setDecisions] = useState<Record<string, ProviderProfileImportAction>>({})
  const [busy, setBusy] = useState<BusyState>('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const selectedChanges = useMemo(() => preview?.importPreview?.items.reduce(
    (count, item) => count + Number((decisions[item.id] ?? item.defaultAction) !== 'skip'), 0
  ) ?? 0, [decisions, preview])
  const history = useProviderProfileRemoteHistory({
    api: {
      list: () => window.agentDesk.listProviderProfileWebDavHistory(),
      preview: (revisionId) => window.agentDesk.previewProviderProfileWebDavHistory(revisionId),
      apply: (previewId, selected) => window.agentDesk.applyProviderProfileWebDavHistory(previewId, selected)
    },
    refreshProviders,
    onMessage: setMessage,
    onError: setError,
    appliedMessage: (result) => t('providerSyncHistoryApplied', { created: result.created, updated: result.updated })
  })

  useEffect(() => {
    void window.agentDesk.getProviderProfileWebDavConfig().then((next) => {
      setConfig(next)
      setDraft(draftFromConfig(next))
      setEditing(!next.configured)
    }).catch((caught) => setError(errorMessage(caught)))
  }, [])

  async function save(): Promise<void> {
    setBusy('save'); clearFeedback()
    try {
      const input: ProviderProfileWebDavConfigInput = {
        baseUrl: draft.baseUrl,
        username: draft.username,
        password: draft.clearPassword ? '' : draft.password || undefined,
        remotePath: draft.remotePath,
        autoSyncEnabled: draft.autoSyncEnabled,
        autoPullEnabled: draft.autoPullEnabled,
        autoSyncIntervalMinutes: draft.autoSyncIntervalMinutes
      }
      const next = await window.agentDesk.saveProviderProfileWebDavConfig(input)
      setConfig(next); setDraft(draftFromConfig(next)); setEditing(false); setPreview(null)
      setMessage(t('providerWebDavSaved', { endpoint: next.endpointLabel ?? '-' }))
    } catch (caught) { setError(errorMessage(caught)) } finally { setBusy('') }
  }

  async function testConnection(): Promise<void> {
    setBusy('test'); clearFeedback()
    try {
      const result = await window.agentDesk.testProviderProfileWebDavConnection()
      setMessage(t('providerWebDavConnected', { endpoint: result.endpointLabel }))
    } catch (caught) { setError(errorMessage(caught)) } finally { setBusy('') }
  }

  async function inspect(): Promise<void> {
    setBusy('preview'); clearFeedback()
    try {
      const next = await window.agentDesk.previewProviderProfileWebDavSync()
      setPreview(next)
      setDecisions(Object.fromEntries((next.importPreview?.items ?? []).map((item) => [item.id, item.defaultAction])))
      if (next.status.relation === 'in_sync') setMessage(t('providerWebDavCurrent'))
    } catch (caught) { setError(errorMessage(caught)) } finally { setBusy('') }
  }

  async function publish(allowDiverged: boolean): Promise<void> {
    if (!preview) return
    setBusy('publish'); clearFeedback()
    try {
      const result = await window.agentDesk.publishProviderProfileWebDavSync(preview.previewId, allowDiverged)
      setPreview(null); setDecisions({}); setMessage(t('providerWebDavPublished', { n: result.providerCount }))
      setConfig(await window.agentDesk.getProviderProfileWebDavConfig())
    } catch (caught) { setError(errorMessage(caught)) } finally { setBusy('') }
  }

  async function pull(): Promise<void> {
    if (!preview?.importPreview || selectedChanges === 0) return
    setBusy('pull'); clearFeedback()
    try {
      const selected: ProviderProfileImportDecision[] = preview.importPreview.items.map((item) => ({
        itemId: item.id, action: decisions[item.id] ?? item.defaultAction
      }))
      const result = await window.agentDesk.applyProviderProfileWebDavSync(preview.previewId, selected)
      await refreshProviders()
      setPreview(null); setDecisions({}); setMessage(t('providerWebDavPulled', { created: result.created, updated: result.updated }))
      setConfig(await window.agentDesk.getProviderProfileWebDavConfig())
    } catch (caught) { setError(errorMessage(caught)) } finally { setBusy('') }
  }

  async function remove(): Promise<void> {
    setBusy('remove'); clearFeedback()
    try {
      const next = await window.agentDesk.removeProviderProfileWebDavConfig()
      setConfig(next); setDraft(emptyDraft()); setEditing(true); setPreview(null); history.close(); setDecisions({})
      setMessage(t('providerWebDavRemoved'))
    } catch (caught) { setError(errorMessage(caught)) } finally { setBusy('') }
  }

  function clearFeedback(): void { setMessage(''); setError('') }
  return {
    t, config, draft, setDraft, editing, setEditing, preview, setPreview, decisions, setDecisions,
    busy, message, error, selectedChanges, history, save, testConnection, inspect, publish, pull, remove
  }
}

type WebDavController = ReturnType<typeof useProviderProfileWebDavController>

function WebDavHeader({ webdav }: { webdav: WebDavController }): React.JSX.Element {
  const { t, config, busy } = webdav
  return <div className="provider-webdav-head">
    <div><h4><Cloud size={15} aria-hidden="true" /> {t('providerWebDavTitle')}</h4><span>{config?.endpointLabel ?? t('providerWebDavNotConfigured')}</span></div>
    <div className="provider-webdav-actions">
      <button className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => webdav.setEditing(!webdav.editing)}>{t(webdav.editing ? 'cancel' : 'providerWebDavEdit')}</button>
      {config?.configured && <>
        <button className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void webdav.testConnection()}><ShieldCheck size={14} aria-hidden="true" /> {busy === 'test' ? t('providerWebDavTesting') : t('providerWebDavTest')}</button>
        <button className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void webdav.inspect()}><RefreshCw size={14} aria-hidden="true" /> {busy === 'preview' ? t('providerWebDavChecking') : t('providerWebDavCheck')}</button>
        <button className="btn btn-ghost btn-sm" disabled={Boolean(busy) || webdav.history.busy} onClick={() => void webdav.history.toggle()}><History size={14} aria-hidden="true" /> {t('providerSyncHistoryTitle')}</button>
        <button className="btn btn-ghost btn-icon-sm" title={t('providerWebDavRemove')} aria-label={t('providerWebDavRemove')} disabled={Boolean(busy)} onClick={() => void webdav.remove()}><Trash2 size={14} aria-hidden="true" /></button>
      </>}
    </div>
  </div>
}

function WebDavConfigForm({ webdav }: { webdav: WebDavController }): React.JSX.Element {
  const { t, draft, setDraft, config, busy } = webdav
  const patch = (value: Partial<WebDavDraft>): void => setDraft((current) => ({ ...current, ...value }))
  return <div className="provider-webdav-form">
    <label><span>{t('providerWebDavUrl')}</span><input className="input" type="url" value={draft.baseUrl} placeholder="https://dav.example.com/remote.php/dav/files/name" disabled={Boolean(busy)} onChange={(event) => patch({ baseUrl: event.target.value })} /></label>
    <label><span>{t('providerWebDavUsername')}</span><input className="input" value={draft.username} disabled={Boolean(busy)} onChange={(event) => patch({ username: event.target.value })} /></label>
    <label><span>{t('providerWebDavPassword')}</span><input className="input" type="password" value={draft.password} placeholder={config?.passwordConfigured ? t('providerWebDavPasswordKeep') : ''} disabled={Boolean(busy) || draft.clearPassword} onChange={(event) => patch({ password: event.target.value })} /></label>
    <label><span>{t('providerWebDavRemotePath')}</span><input className="input" value={draft.remotePath} disabled={Boolean(busy)} onChange={(event) => patch({ remotePath: event.target.value })} /></label>
    <label className="provider-webdav-check"><input type="checkbox" checked={draft.autoSyncEnabled} disabled={Boolean(busy)} onChange={(event) => patch({ autoSyncEnabled: event.target.checked })} /><span>{t('providerWebDavAutoSync')}</span></label>
    <label className="provider-webdav-check"><input type="checkbox" checked={draft.autoPullEnabled} disabled={Boolean(busy) || !draft.autoSyncEnabled} onChange={(event) => patch({ autoPullEnabled: event.target.checked })} /><span>{t('providerWebDavAutoPull')}</span></label>
    <label><span>{t('providerWebDavInterval')}</span><input className="input" type="number" min={5} max={1440} value={draft.autoSyncIntervalMinutes} disabled={Boolean(busy) || !draft.autoSyncEnabled} onChange={(event) => patch({ autoSyncIntervalMinutes: Number(event.target.value) })} /></label>
    {config?.passwordConfigured && <label className="provider-webdav-check"><input type="checkbox" checked={draft.clearPassword} disabled={Boolean(busy)} onChange={(event) => patch({ clearPassword: event.target.checked, password: '' })} /><span>{t('providerWebDavClearPassword')}</span></label>}
    <div className="provider-webdav-form-actions"><button className="btn btn-primary btn-sm" disabled={Boolean(busy)} onClick={() => void webdav.save()}><Save size={14} aria-hidden="true" /> {busy === 'save' ? t('providerWebDavSaving') : t('save')}</button></div>
  </div>
}

function WebDavStatus({ webdav }: { webdav: WebDavController }): React.JSX.Element | null {
  const { t, config } = webdav
  if (!config?.configured) return null
  return <div className="provider-webdav-meta">
    <span>{config.autoSyncEnabled ? t('providerWebDavAutoEnabled', { n: config.autoSyncIntervalMinutes }) : t('providerWebDavAutoDisabled')}</span>
    {config.lastSyncAt && <span>{t('providerWebDavLastSync', { time: new Date(config.lastSyncAt).toLocaleString() })}</span>}
    {config.lastError && <span className="provider-profile-warning">{config.lastError}</span>}
  </div>
}

function WebDavPreview({ webdav }: { webdav: WebDavController }): React.JSX.Element | null {
  const { t, preview, decisions, busy, selectedChanges } = webdav
  if (!preview || preview.status.relation === 'in_sync') return null
  const overwrite = preview.status.relation === 'diverged' || preview.status.relation === 'remote_ahead'
  return <div className="provider-webdav-preview">
    <div className="provider-webdav-preview-head"><div><strong>{t('providerWebDavPreview')}</strong><span>{t(`providerSyncRelation_${preview.status.relation}`)}</span></div><button className="btn btn-ghost btn-icon-sm" title={t('cancel')} aria-label={t('cancel')} disabled={Boolean(busy)} onClick={() => webdav.setPreview(null)}><X size={14} aria-hidden="true" /></button></div>
    {preview.requiresConflictChoice && <p className="provider-profile-warning">{t('providerWebDavConflict')}</p>}
    {preview.importPreview && <WebDavImportItems preview={preview} decisions={decisions} setDecisions={webdav.setDecisions} busy={Boolean(busy)} />}
    <div className="provider-webdav-preview-actions">
      {preview.canPull && <button className="btn btn-ghost btn-sm" disabled={Boolean(busy) || selectedChanges === 0} onClick={() => void webdav.pull()}><Download size={14} aria-hidden="true" /> {t(busy === 'pull' ? 'providerWebDavApplying' : 'providerWebDavUseRemote')}</button>}
      {preview.canPublish && <button className="btn btn-primary btn-sm" disabled={Boolean(busy)} onClick={() => void webdav.publish(overwrite)}><Upload size={14} aria-hidden="true" /> {t(busy === 'publish' ? 'providerWebDavPublishing' : 'providerWebDavUseLocal')}</button>}
    </div>
  </div>
}

function WebDavImportItems({ preview, decisions, setDecisions, busy }: {
  preview: ProviderProfileWebDavPreview
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

function draftFromConfig(config: ProviderProfileWebDavConfigView): WebDavDraft {
  return {
    baseUrl: config.baseUrl ?? '', username: config.username ?? '', password: '',
    remotePath: config.remotePath ?? 'caogen-sync', autoSyncEnabled: config.autoSyncEnabled,
    autoPullEnabled: config.autoPullEnabled,
    autoSyncIntervalMinutes: config.autoSyncIntervalMinutes, clearPassword: false
  }
}

function emptyDraft(): WebDavDraft {
  return { baseUrl: '', username: '', password: '', remotePath: 'caogen-sync', autoSyncEnabled: false, autoPullEnabled: false, autoSyncIntervalMinutes: 15, clearPassword: false }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
