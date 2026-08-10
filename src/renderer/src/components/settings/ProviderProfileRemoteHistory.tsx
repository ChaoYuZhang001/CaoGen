import { RotateCcw, Search, X } from 'lucide-react'
import type {
  ProviderProfileImportAction,
  ProviderProfileSyncHistoryEntry,
  ProviderProfileSyncHistoryPreview
} from '../../../../shared/types'
import { useT } from '../../i18n'

interface Props {
  entries: ProviderProfileSyncHistoryEntry[] | null
  preview: ProviderProfileSyncHistoryPreview | null
  decisions: Record<string, ProviderProfileImportAction>
  busy: boolean
  selectedChanges: number
  onPreview(revisionId: string): void
  onApply(): void
  onClose(): void
  setDecisions: React.Dispatch<React.SetStateAction<Record<string, ProviderProfileImportAction>>>
}

export default function ProviderProfileRemoteHistory(props: Props): React.JSX.Element | null {
  const t = useT()
  if (props.entries === null && !props.preview) return null
  return <div className="provider-webdav-preview" data-provider-sync-history>
    <div className="provider-webdav-preview-head">
      <div><strong>{t('providerSyncHistoryTitle')}</strong><span>{t('providerSyncHistoryBounded')}</span></div>
      <button className="btn btn-ghost btn-icon-sm" title={t('cancel')} aria-label={t('cancel')} disabled={props.busy} onClick={props.onClose}><X size={14} aria-hidden="true" /></button>
    </div>
    {!props.preview && <HistoryEntries {...props} />}
    {props.preview && <HistoryPreview {...props} />}
  </div>
}

function HistoryEntries(props: Props): React.JSX.Element {
  const t = useT()
  if (!props.entries?.length) return <p className="provider-webdav-safety">{t('providerSyncHistoryEmpty')}</p>
  return <div className="provider-webdav-import-list">{props.entries.map((entry) => <div className="provider-webdav-import-row" key={entry.revisionId}>
    <div>
      <strong>{new Date(entry.createdAt).toLocaleString()}</strong>
      <span>{t('providerSyncHistoryProviders', { n: entry.providerCount })}</span>
    </div>
    <button className="btn btn-ghost btn-sm" disabled={props.busy} onClick={() => props.onPreview(entry.revisionId)}><Search size={14} aria-hidden="true" /> {t('providerSyncHistoryPreview')}</button>
  </div>)}</div>
}

function HistoryPreview(props: Props): React.JSX.Element {
  const t = useT()
  const preview = props.preview as ProviderProfileSyncHistoryPreview
  return <>
    <div className="provider-webdav-import-list">{preview.importPreview.items.map((item) => <div className="provider-webdav-import-row" key={item.id}>
      <div><strong>{item.name}</strong><span>{item.changedFields.length ? t('providerProfileChangedFields', { fields: item.changedFields.join(', ') }) : t('providerProfileConflictNone')}</span></div>
      <select className="select provider-profile-action-select" value={props.decisions[item.id] ?? item.defaultAction} disabled={props.busy} aria-label={t('providerProfileActionFor', { name: item.name })} onChange={(event) => props.setDecisions((current) => ({ ...current, [item.id]: event.target.value as ProviderProfileImportAction }))}>{item.allowedActions.map((action) => <option value={action} key={action}>{t(`providerProfileAction_${action}`)}</option>)}</select>
    </div>)}</div>
    <div className="provider-webdav-preview-actions">
      <button className="btn btn-primary btn-sm" disabled={props.busy || props.selectedChanges === 0} onClick={props.onApply}><RotateCcw size={14} aria-hidden="true" /> {t('providerSyncHistoryApply')}</button>
    </div>
  </>
}
