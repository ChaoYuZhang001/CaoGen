import { useEffect, useMemo, useState } from 'react'
import { Database, RotateCcw, X } from 'lucide-react'
import type {
  ProviderProfileImportAction,
  ProviderProfileImportDecision
} from '../../../../shared/types'
import type {
  CcSwitchProviderImportBackupView,
  CcSwitchProviderImportItem,
  CcSwitchProviderImportPreview
} from '../../../../shared/cc-switch-import-types'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import './cc-switch-import.css'

type BusyState = 'scan' | 'apply' | 'rollback' | ''

export default function CcSwitchImportPanel(): React.JSX.Element {
  const t = useT()
  const controller = useCcSwitchImportController()
  return (
    <section className="cc-switch-import" aria-label={t('ccSwitchImportTitle')}>
      <div className="cc-switch-import-head">
        <h4>{t('ccSwitchImportTitle')}</h4>
        <button className="btn btn-ghost btn-sm" data-cc-switch-scan disabled={Boolean(controller.busy)} onClick={() => void controller.scan()}>
          <Database size={14} aria-hidden="true" />
          {controller.busy === 'scan' ? t('ccSwitchImportScanning') : t('ccSwitchImportScan')}
        </button>
      </div>
      {controller.message && <div className="notice notice-info">{controller.message}</div>}
      {controller.error && <div className="notice notice-error">{controller.error}</div>}
      {controller.preview && <CcSwitchImportPreviewPanel controller={controller} />}
      {controller.backups.length > 0 && <CcSwitchImportBackups controller={controller} />}
    </section>
  )
}

function useCcSwitchImportController() {
  const t = useT()
  const refreshProviders = useStore((state) => state.refreshProviders)
  const [preview, setPreview] = useState<CcSwitchProviderImportPreview | null>(null)
  const [decisions, setDecisions] = useState<Record<string, ProviderProfileImportAction>>({})
  const [backups, setBackups] = useState<CcSwitchProviderImportBackupView[]>([])
  const [busy, setBusy] = useState<BusyState>('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const selectedCount = useMemo(() => preview?.items.filter((item) =>
    (decisions[item.id] ?? item.defaultAction) !== 'skip').length ?? 0, [decisions, preview])

  useEffect(() => { void refreshBackups() }, [])

  async function refreshBackups(): Promise<void> {
    setBackups(await window.agentDesk.listCcSwitchProviderImportBackups().catch(() => []))
  }

  async function scan(): Promise<void> {
    setBusy('scan'); setError(''); setMessage('')
    try {
      const next = await window.agentDesk.previewCcSwitchProviderImport()
      setPreview(next)
      setDecisions(Object.fromEntries(next.items.map((item) => [item.id, item.defaultAction])))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy('')
    }
  }

  async function apply(): Promise<void> {
    if (!preview || selectedCount === 0) return
    setBusy('apply'); setError(''); setMessage('')
    try {
      const selected: ProviderProfileImportDecision[] = preview.items.map((item) => ({
        itemId: item.id,
        action: decisions[item.id] ?? item.defaultAction
      }))
      const result = await window.agentDesk.applyCcSwitchProviderImport(preview.previewId, selected)
      setPreview(null); setDecisions({})
      await refreshProviders(); await refreshBackups()
      setMessage(t('ccSwitchImportApplied', {
        created: result.created,
        updated: result.updated,
        skipped: result.skipped
      }))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy('')
    }
  }

  async function rollback(backup: CcSwitchProviderImportBackupView): Promise<void> {
    if (!window.confirm(t('ccSwitchImportRollbackConfirm'))) return
    setBusy('rollback'); setError(''); setMessage('')
    try {
      await window.agentDesk.rollbackCcSwitchProviderImportBackup(backup.id)
      await refreshProviders(); await refreshBackups()
      setMessage(t('ccSwitchImportRolledBack'))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy('')
    }
  }

  return {
    preview, decisions, backups, busy, message, error, selectedCount,
    scan, apply, rollback, setPreview, setDecisions
  }
}

type CcSwitchImportController = ReturnType<typeof useCcSwitchImportController>

function CcSwitchImportPreviewPanel({ controller }: { controller: CcSwitchImportController }): React.JSX.Element {
  const t = useT()
  const preview = controller.preview
  if (!preview) throw new Error('CC Switch import preview is required')
  return (
    <div className="cc-switch-import-preview" data-cc-switch-preview>
      <div className="cc-switch-import-preview-head">
        <strong>{t('ccSwitchImportSummary', {
          providers: preview.providerCount,
          importable: preview.importableCount,
          credentials: preview.credentialCount,
          pricing: preview.pricedModelCount
        })}</strong>
        <button className="btn btn-ghost btn-icon-sm" title={t('cancel')} aria-label={t('cancel')} onClick={() => controller.setPreview(null)}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="cc-switch-import-list">
        {preview.items.map((item) => (
          <CcSwitchImportRow
            key={item.id}
            item={item}
            action={controller.decisions[item.id] ?? item.defaultAction}
            disabled={controller.busy === 'apply'}
            onAction={(action) => controller.setDecisions((current) => ({ ...current, [item.id]: action }))}
          />
        ))}
      </div>
      <div className="cc-switch-import-footer">
        <button className="btn btn-primary btn-sm" disabled={controller.busy === 'apply' || controller.selectedCount === 0} onClick={() => void controller.apply()}>
          {controller.busy === 'apply' ? t('ccSwitchImportApplying') : t('ccSwitchImportApply')}
        </button>
      </div>
    </div>
  )
}

function CcSwitchImportBackups({ controller }: { controller: CcSwitchImportController }): React.JSX.Element {
  const t = useT()
  return (
    <div className="cc-switch-import-backups">
      <strong>{t('ccSwitchImportBackups')}</strong>
      {controller.backups.slice(0, 3).map((backup) => (
        <div key={backup.id}>
          <span>{formattedTime(backup.createdAt)} {'\u00b7'} {t('ccSwitchImportBackupSummary', {
            providers: backup.providerCount,
            credentials: backup.importedCredentialCount
          })}</span>
          <button className="btn btn-ghost btn-sm" disabled={Boolean(controller.busy)} onClick={() => void controller.rollback(backup)}>
            <RotateCcw size={13} aria-hidden="true" /> {t('providerProfileRollback')}
          </button>
        </div>
      ))}
    </div>
  )
}

function CcSwitchImportRow({ item, action, disabled, onAction }: {
  item: CcSwitchProviderImportItem
  action: ProviderProfileImportAction
  disabled: boolean
  onAction: (action: ProviderProfileImportAction) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="cc-switch-import-row" data-source-app={item.sourceApp}>
      <div className="cc-switch-import-identity">
        <strong>{item.name}</strong>
        <span>{t('ccSwitchImportSource', { app: item.sourceApp === 'codex' ? 'Codex' : 'Claude' })}</span>
      </div>
      <div className="cc-switch-import-facts">
        <Fact label={t('ccSwitchImportProtocol')} value={protocolLabel(item)} />
        <Fact label={t('ccSwitchImportModels')} value={String(item.models.length)} />
        <Fact label={t('ccSwitchImportPricing')} value={String(item.pricedModelCount)} />
        <Fact label={t('ccSwitchImportBudget')} value={item.monthlyBudgetUsd ? `$${item.monthlyBudgetUsd}` : '-'} />
        <Fact label={t('ccSwitchImportCredential')} value={credentialLabel(item, t)} />
      </div>
      {item.changedFields.length > 0 && <span className="cc-switch-import-changed">{t('ccSwitchImportChanged', { fields: item.changedFields.join(', ') })}</span>}
      {item.warnings.map((warning) => <span key={warning} className="provider-profile-warning">{t(`ccSwitchWarning_${warning}`)}</span>)}
      <select className="select" value={action} disabled={disabled} onChange={(event) => onAction(event.target.value as ProviderProfileImportAction)}>
        {item.allowedActions.map((allowed) => <option key={allowed} value={allowed}>{t(`providerProfileAction_${allowed}`)}</option>)}
      </select>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div><span>{label}</span><strong>{value}</strong></div>
}

function protocolLabel(item: CcSwitchProviderImportItem): string {
  if (item.engine === 'anthropic') return 'Anthropic Messages'
  if (item.engine === 'gemini') return 'Google Generative Language'
  return item.openaiProtocol === 'chat' ? 'OpenAI Chat Completions' : 'OpenAI Responses'
}

function credentialLabel(item: CcSwitchProviderImportItem, t: ReturnType<typeof useT>): string {
  if (item.credentialImportable) return t('ccSwitchImportCredentialReady')
  if (item.credentialPresent) return t('ccSwitchImportCredentialPreserved')
  return t('ccSwitchImportCredentialMissing')
}

function formattedTime(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
