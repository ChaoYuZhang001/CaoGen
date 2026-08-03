import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import type {
  ProviderProfileBackupView,
  ProviderProfileImportAction,
  ProviderProfileImportDecision,
  ProviderProfileImportPreview,
  ProviderView
} from '../../../../shared/types'

type ProfileBusyState = 'import' | 'export' | 'apply' | 'rollback' | ''

interface Props {
  providers: ProviderView[]
  onAdd: () => void
  children: ReactNode
}

export default function ProviderProfileManager({ providers, onAdd, children }: Props): React.JSX.Element {
  const t = useT()
  const profile = useProviderProfileManager()
  return (
    <>
      <div className="settings-section-head">
        <h3 className="settings-h3">{t('tabProviders')}</h3>
        <div className="provider-profile-actions">
          <button className="btn btn-ghost btn-sm" disabled={Boolean(profile.busy)} onClick={() => void profile.chooseImport()}>
            {t('providerProfileImport')}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            disabled={Boolean(profile.busy) || providers.length === 0}
            onClick={() => void profile.exportProfile()}
          >
            {t('providerProfileExport')}
          </button>
          <button className="btn btn-ghost btn-sm" disabled={Boolean(profile.busy)} onClick={onAdd}>
            {t('addProvider')}
          </button>
        </div>
      </div>
      <p className="settings-hint provider-profile-hint">{t('providerProfileSafetyHint')}</p>
      {profile.message && <div className="notice notice-info provider-profile-notice">{profile.message}</div>}
      {profile.error && <div className="notice notice-error provider-profile-notice">{profile.error}</div>}
      {profile.preview && <ProviderProfilePreviewPanel profile={profile} />}
      {children}
      {profile.backups.length > 0 && <ProviderProfileBackups profile={profile} />}
    </>
  )
}

function useProviderProfileManager() {
  const t = useT()
  const applyProviderProfileImport = useStore((state) => state.applyProviderProfileImport)
  const rollbackProviderProfileBackup = useStore((state) => state.rollbackProviderProfileBackup)
  const [preview, setPreview] = useState<ProviderProfileImportPreview | null>(null)
  const [decisions, setDecisions] = useState<Record<string, ProviderProfileImportAction>>({})
  const [backups, setBackups] = useState<ProviderProfileBackupView[]>([])
  const [busy, setBusy] = useState<ProfileBusyState>('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const selectedCounts = useMemo(() => importActionCounts(preview, decisions), [preview, decisions])

  useEffect(() => { void refreshBackups() }, [])

  async function refreshBackups(): Promise<void> {
    setBackups(await window.agentDesk.listProviderProfileBackups().catch(() => []))
  }

  async function exportProfile(): Promise<void> {
    setBusy('export'); setError(''); setMessage('')
    try {
      const result = await window.agentDesk.exportProviderProfile()
      if (!result.canceled) setMessage(t('providerProfileExported', { n: result.providerCount }))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy('')
    }
  }

  async function chooseImport(): Promise<void> {
    setBusy('import'); setError(''); setMessage('')
    try {
      const next = await window.agentDesk.previewProviderProfileImport()
      if (!next) return
      setPreview(next)
      setDecisions(Object.fromEntries(next.items.map((item) => [item.id, item.defaultAction])))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy('')
    }
  }

  async function applyImport(): Promise<void> {
    if (!preview || selectedCounts.create + selectedCounts.update === 0) return
    setBusy('apply'); setError(''); setMessage('')
    try {
      const selected: ProviderProfileImportDecision[] = preview.items.map((item) => ({
        itemId: item.id,
        action: decisions[item.id] ?? item.defaultAction
      }))
      const result = await applyProviderProfileImport(preview.previewId, selected)
      setPreview(null); setDecisions({})
      setMessage(t('providerProfileApplied', {
        created: result.created,
        updated: result.updated,
        skipped: result.skipped
      }))
      await refreshBackups()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy('')
    }
  }

  async function rollback(backup: ProviderProfileBackupView): Promise<void> {
    if (!window.confirm(t('providerProfileRollbackConfirm', { time: formattedTime(backup.createdAt) }))) return
    setBusy('rollback'); setError(''); setMessage('')
    try {
      const result = await rollbackProviderProfileBackup(backup.id)
      setPreview(null); setDecisions({})
      setMessage(t('providerProfileRolledBack', { n: result.providers.length }))
      await refreshBackups()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy('')
    }
  }

  function closePreview(): void {
    setPreview(null)
    setDecisions({})
  }

  return {
    preview, decisions, backups, busy, message, error, selectedCounts,
    setDecisions, exportProfile, chooseImport, applyImport, rollback, closePreview
  }
}

type ProfileController = ReturnType<typeof useProviderProfileManager>

function ProviderProfilePreviewPanel({ profile }: { profile: ProfileController }): React.JSX.Element {
  const t = useT()
  const { preview } = profile
  if (!preview) throw new Error('Provider Profile preview is required')
  return (
    <section className="provider-profile-preview" aria-label={t('providerProfilePreviewTitle')}>
      <div className="provider-profile-preview-head">
        <div>
          <h4>{t('providerProfilePreviewTitle')}</h4>
          <p>{preview.fileName} · {t('providerProfilePreviewCounts', profile.selectedCounts)}</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" disabled={profile.busy === 'apply'} onClick={profile.closePreview}>
          {t('cancel')}
        </button>
      </div>
      {preview.warnings.map((warning) => (
        <div key={warning} className="provider-profile-warning">{warning}</div>
      ))}
      <div className="provider-profile-import-list">
        {preview.items.map((item) => (
          <div key={item.id} className="provider-profile-import-row">
            <div className="provider-profile-import-copy">
              <strong>{item.name}</strong>
              <span>{t('providerProfileProtocol', { protocol: providerProtocolLabel(item) })}</span>
              <span>
                {t('providerAuthModeLabel')}: {t(item.authMode === 'none' ? 'providerAuthModeNone' : 'providerAuthModeApiKey')}
              </span>
              <span>{item.baseUrl || t('officialEndpoint')}</span>
              <span>{profileConflictLabel(item.conflict, item.targetProviderName, t)}</span>
              <ProviderCredentialImpact
                item={item}
                action={profile.decisions[item.id] ?? item.defaultAction}
              />
              {item.changedFields.length > 0 && (
                <span>{t('providerProfileChangedFields', { fields: item.changedFields.join(', ') })}</span>
              )}
            </div>
            <select
              className="select provider-profile-action-select"
              aria-label={t('providerProfileActionFor', { name: item.name })}
              value={profile.decisions[item.id] ?? item.defaultAction}
              disabled={profile.busy === 'apply'}
              onChange={(event) => profile.setDecisions((current) => ({
                ...current,
                [item.id]: event.target.value as ProviderProfileImportAction
              }))}
            >
              {item.allowedActions.map((action) => (
                <option key={action} value={action}>{t(`providerProfileAction_${action}`)}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <div className="provider-profile-preview-footer">
        <span>{t('providerProfileBackupBeforeApply')}</span>
        <button
          className="btn btn-primary btn-sm"
          disabled={profile.busy === 'apply' || profile.selectedCounts.create + profile.selectedCounts.update === 0}
          onClick={() => void profile.applyImport()}
        >
          {profile.busy === 'apply' ? t('providerProfileApplying') : t('providerProfileApply')}
        </button>
      </div>
    </section>
  )
}

function ProviderCredentialImpact({
  item,
  action
}: {
  item: ProviderProfileImportPreview['items'][number]
  action: ProviderProfileImportAction
}): React.JSX.Element {
  const t = useT()
  const impact = providerCredentialImpact(item, action, t)
  return (
    <span className={impact.warning ? 'provider-profile-credential-warning' : undefined}>
      {impact.text}
    </span>
  )
}

function providerCredentialImpact(
  item: ProviderProfileImportPreview['items'][number],
  action: ProviderProfileImportAction,
  t: ReturnType<typeof useT>
): { text: string; warning: boolean } {
  if (action === 'skip') return { text: t('providerProfileCredentialSkipped'), warning: false }
  if (action === 'create') {
    return item.authMode === 'none'
      ? { text: t('providerProfileCredentialNone'), warning: false }
      : { text: t('providerProfileCredentialMissing'), warning: true }
  }
  const keyCount = item.targetKeyCount ?? 0
  const keyLabel = item.targetActiveKeyLabel || t('providerProfileCredentialUnnamed')
  if (item.authMode === 'none') {
    return keyCount > 0
      ? { text: t('providerProfileCredentialRemoved', { label: keyLabel, n: keyCount }), warning: true }
      : { text: t('providerProfileCredentialNone'), warning: false }
  }
  if (keyCount === 0) return { text: t('providerProfileCredentialMissing'), warning: true }
  if (item.targetCredentialBindingChanged || item.targetCredentialMigrationRequired) {
    return { text: t('providerProfileCredentialReentry', { label: keyLabel, n: keyCount }), warning: true }
  }
  return { text: t('providerProfileCredentialPreserved', { label: keyLabel, n: keyCount }), warning: false }
}

function ProviderProfileBackups({ profile }: { profile: ProfileController }): React.JSX.Element {
  const t = useT()
  return (
    <section className="provider-profile-backups" aria-label={t('providerProfileBackupsTitle')}>
      <h4>{t('providerProfileBackupsTitle')}</h4>
      {profile.backups.slice(0, 3).map((backup) => (
        <div key={backup.id} className="provider-profile-backup-row">
          <div>
            <strong>{formattedTime(backup.createdAt)}</strong>
            <span>{t('providerProfileBackupSummary', { n: backup.providerCount })}</span>
            {backup.nonPersistentCredentialCount > 0 && (
              <span className="provider-profile-warning">
                {t('providerProfileSessionKeyWarning', { n: backup.nonPersistentCredentialCount })}
              </span>
            )}
            {backup.excludedCredentialCount > 0 && (
              <span className="provider-profile-warning">
                {t('providerProfileCredentialReentryWarning', { n: backup.excludedCredentialCount })}
              </span>
            )}
          </div>
          <button className="btn btn-ghost btn-sm" disabled={Boolean(profile.busy)} onClick={() => void profile.rollback(backup)}>
            {t('providerProfileRollback')}
          </button>
        </div>
      ))}
    </section>
  )
}

function importActionCounts(
  preview: ProviderProfileImportPreview | null,
  decisions: Record<string, ProviderProfileImportAction>
): Record<ProviderProfileImportAction, number> {
  const counts = { create: 0, update: 0, skip: 0 }
  for (const item of preview?.items ?? []) counts[decisions[item.id] ?? item.defaultAction] += 1
  return counts
}

function profileConflictLabel(
  conflict: ProviderProfileImportPreview['items'][number]['conflict'],
  targetName: string | undefined,
  t: ReturnType<typeof useT>
): string {
  if (conflict === 'none') return t('providerProfileConflictNone')
  if (conflict === 'ambiguous') return t('providerProfileConflictAmbiguous')
  return t(`providerProfileConflict_${conflict}`, { target: targetName ?? '-' })
}

function providerProtocolLabel(item: ProviderProfileImportPreview['items'][number]): string {
  if (item.engine === 'anthropic') return 'Anthropic Messages'
  return item.openaiProtocol === 'responses' ? 'OpenAI Responses' : 'OpenAI Chat Completions'
}

function formattedTime(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
