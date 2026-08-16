import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Download, FileCheck2, FileJson, GitCompareArrows, KeyRound, RotateCw, Save, ShieldCheck, ShieldOff, Upload, UserCheck, X } from 'lucide-react'
import type {
  WorkflowAcceptanceRecord,
  WorkflowEvidenceKind,
  WorkflowArtifactCompareResult,
  WorkflowArtifactIntegrityReport,
  WorkflowProjectDeliveryIntegrityReport,
  WorkflowProjectDeliveryPackageVerificationResult,
  WorkflowDeliveryIdentityTrustSnapshot,
  WorkflowProjectDeliveryArtifact,
  WorkflowProjectDeliveryWorkbench
} from '../../../../shared/types'
import { WorkflowAcceptanceRow } from '../WorkflowAcceptanceRow'
import { EVIDENCE_KINDS, errorMessage, newWorkflowId } from '../workflow-ledger-ui'
import { useStore } from '../../store'

interface ProjectDeliveryWorkbenchProps {
  active: boolean
  projectId: string
  refreshToken?: string
}

export function ProjectDeliveryWorkbench({
  active,
  projectId,
  refreshToken = ''
}: ProjectDeliveryWorkbenchProps): React.JSX.Element {
  const openFile = useStore((state) => state.openFile)
  const openPreviewPanel = useStore((state) => state.openPreviewPanel)
  const openBrowserPanel = useStore((state) => state.openBrowserPanel)
  const [projection, setProjection] = useState<WorkflowProjectDeliveryWorkbench | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [repairByAcceptanceId, setRepairByAcceptanceId] = useState<Record<string, string>>({})
  const [exporting, setExporting] = useState(false)
  const [deliveryAudit, setDeliveryAudit] = useState<WorkflowProjectDeliveryIntegrityReport>()
  const [packageVerification, setPackageVerification] = useState<Exclude<WorkflowProjectDeliveryPackageVerificationResult, { canceled: true }>>()
  const [identityTrust, setIdentityTrust] = useState<WorkflowDeliveryIdentityTrustSnapshot>()
  const [auditing, setAuditing] = useState<'verify' | 'manifest' | 'package' | 'verify-package' | ''>('')

  const refresh = useCallback(async (): Promise<void> => {
    if (!projectId) return
    setLoading(true)
    setError('')
    try {
      setProjection(await window.agentDesk.getProjectDeliveryWorkbench(projectId))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    if (active) void refresh()
  }, [active, refresh, refreshToken])

  const refreshIdentityTrust = useCallback(async (): Promise<void> => {
    try {
      setIdentityTrust(await window.agentDesk.listWorkflowDeliveryTrustedIdentities())
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [])

  useEffect(() => {
    if (active) void refreshIdentityTrust()
  }, [active, refreshIdentityTrust])

  const evidenceById = useMemo(
    () => new Map((projection?.evidence ?? []).map((record) => [record.evidenceId, record])),
    [projection?.evidence]
  )
  const artifactByAcceptanceId = useMemo(() => {
    const records = new Map<string, WorkflowProjectDeliveryArtifact['artifact']>()
    for (const item of projection?.artifacts ?? []) {
      for (const acceptanceId of item.acceptanceIds) records.set(acceptanceId, item.artifact)
    }
    return records
  }, [projection?.artifacts])
  const onRepairReported = useCallback((repair: { acceptanceId: string; workItemId: string }): void => {
    setRepairByAcceptanceId((current) => ({ ...current, [repair.acceptanceId]: repair.workItemId }))
  }, [])
  const startRepair = useCallback(async (acceptance: WorkflowAcceptanceRecord): Promise<void> => {
    setMessage('')
    try {
      const result = await window.agentDesk.startWorkflowAcceptanceRepair(acceptance.id)
      setRepairByAcceptanceId((current) => ({ ...current, [acceptance.id]: result.workItemId }))
      setMessage(`返工任务 ${result.workItemId} 已${result.disposition === 'blocked' ? '阻塞' : '启动'}`)
      await refresh()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [refresh])
  const exportDelivery = useCallback(async (): Promise<void> => {
    setExporting(true)
    setError('')
    setMessage('')
    try {
      const exported = await window.agentDesk.exportProjectWorkspaceData(projectId)
      downloadDeliveryExport(projectId, exported.json)
      setMessage(`交付包已导出 · ${exported.exportDigest.slice(0, 16)}`)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setExporting(false)
    }
  }, [projectId])
  const verifyProjectDelivery = useCallback(async (): Promise<void> => {
    setAuditing('verify')
    setError('')
    setMessage('')
    try {
      setDeliveryAudit(await window.agentDesk.verifyWorkflowProjectDelivery({ projectId }))
    } catch (cause) {
      setDeliveryAudit(undefined)
      setError(errorMessage(cause))
    } finally {
      setAuditing('')
    }
  }, [projectId])
  const exportProjectManifest = useCallback(async (): Promise<void> => {
    setAuditing('manifest')
    setError('')
    setMessage('')
    try {
      const result = await window.agentDesk.exportWorkflowProjectDeliveryManifest({ projectId })
      if (!result.canceled) {
        setMessage(`${result.fileName} · ${result.readyArtifactCount} 可交付 / ${result.blockedArtifactCount} 阻塞 · ${shortDigest(result.manifestDigest)}`)
        setDeliveryAudit(await window.agentDesk.verifyWorkflowProjectDelivery({ projectId }))
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setAuditing('')
    }
  }, [projectId])
  const exportVerifiedPackage = useCallback(async (): Promise<void> => {
    setAuditing('package')
    setError('')
    setMessage('')
    try {
      const result = await window.agentDesk.exportWorkflowProjectDeliveryPackage({ projectId })
      if (!result.canceled) {
        setMessage(`${result.fileName} · Ed25519 已签名 · ${result.includedArtifactCount} 个已验收文件 · ${result.blockedArtifactCount} 个阻塞 · ${shortDigest(result.packageDigest)}`)
        setDeliveryAudit(await window.agentDesk.verifyWorkflowProjectDelivery({ projectId }))
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setAuditing('')
    }
  }, [projectId])
  const verifyDeliveryPackage = useCallback(async (): Promise<void> => {
    setAuditing('verify-package')
    setError('')
    setMessage('')
    try {
      const result = await window.agentDesk.verifyWorkflowProjectDeliveryPackage()
      if (!result.canceled) setPackageVerification(result)
    } catch (cause) {
      setPackageVerification(undefined)
      setError(errorMessage(cause))
    } finally {
      setAuditing('')
    }
  }, [])

  return (
    <section className="pws-section pws-delivery-workbench" aria-labelledby={`delivery-${projectId}`} data-project-delivery-workbench>
      <div className="pws-section-header">
        <div className="pws-section-title">
          <h2 id={`delivery-${projectId}`}>交付与验收</h2>
          {projection && <span>{projection.summary.currentArtifactCount}/{projection.summary.artifactCount}</span>}
        </div>
        <div className="pws-section-actions">
          <span className="pws-delivery-state">{loading ? '同步中...' : projection ? '已同步' : '尚无交付数据'}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void verifyDeliveryPackage()} disabled={Boolean(auditing)}>
            <FileCheck2 size={13} aria-hidden="true" />
            {auditing === 'verify-package' ? '验证中...' : '验证交付包'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void verifyProjectDelivery()} disabled={loading || Boolean(auditing)}>
            <ShieldCheck size={13} aria-hidden="true" />
            {auditing === 'verify' ? '审计中...' : '全项目审计'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void exportProjectManifest()} disabled={loading || Boolean(auditing)}>
            <FileJson size={13} aria-hidden="true" />
            {auditing === 'manifest' ? '导出中...' : '项目清单'}
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void exportVerifiedPackage()} disabled={loading || Boolean(auditing)}>
            <Download size={13} aria-hidden="true" />
            {auditing === 'package' ? '打包中...' : '可验证交付包'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void exportDelivery()} disabled={loading || exporting}>
            {exporting ? '导出中...' : '导出项目数据'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void refresh()} disabled={loading}>刷新</button>
        </div>
      </div>
      {error && <div className="pws-error" role="alert">{error}</div>}
      {message && <div className="pws-announcer" role="status">{message}</div>}
      {packageVerification && (
        <DeliveryPackageVerification
          report={packageVerification}
          trustSnapshot={identityTrust}
          onVerificationChange={setPackageVerification}
          onTrustChange={setIdentityTrust}
          onSaved={(saved) => setMessage(`${saved.fileName} · ${shortDigest(saved.receiptDigest)}`)}
          onError={setError}
        />
      )}
      {identityTrust && (
        <DeliveryIdentityTrustList
          snapshot={identityTrust}
          onChange={setIdentityTrust}
          onPolicyChange={() => setPackageVerification(undefined)}
          onMessage={setMessage}
          onError={setError}
        />
      )}
      {projection && (
        <>
          <DeliverySummary projection={projection} />
          {deliveryAudit && <ProjectDeliveryAudit report={deliveryAudit} />}
          <div className="pws-delivery-grid">
            <ArtifactDeliveryList
              artifacts={projection.artifacts}
              evidence={projection.evidence}
              evidenceById={evidenceById}
              projectId={projectId}
              onOpenFile={openFile}
              onOpenPreview={openPreviewPanel}
              onOpenBrowser={openBrowserPanel}
              onRefresh={refresh}
            />
            <div className="pws-delivery-column">
              <section className="pws-delivery-subsection" aria-labelledby={`acceptance-${projectId}`}>
                <h3 id={`acceptance-${projectId}`}>验收清单</h3>
                {projection.acceptances.length === 0 ? <p className="pws-delivery-empty">暂无 Acceptance</p> : projection.acceptances.map((acceptance) => (
                  <div className="pws-delivery-acceptance" key={acceptance.id}>
                    <WorkflowAcceptanceRow
                      acceptance={acceptance}
                      evidence={projection.evidence}
                      artifact={artifactByAcceptanceId.get(acceptance.id)}
                      onRefresh={refresh}
                      repairWorkItemId={repairByAcceptanceId[acceptance.id]}
                      onRepairReported={onRepairReported}
                    />
                    {acceptance.status === 'failed' && (
                      <button type="button" className="btn btn-ghost btn-xs" onClick={() => void startRepair(acceptance)}>
                        启动返工
                      </button>
                    )}
                  </div>
                ))}
              </section>
              <section className="pws-delivery-subsection" aria-labelledby={`evidence-${projectId}`}>
                <h3 id={`evidence-${projectId}`}>Evidence ({projection.evidence.length})</h3>
                {projection.evidence.length === 0 ? <p className="pws-delivery-empty">暂无 Evidence</p> : projection.evidence.slice(0, 12).map((record) => (
                  <div className="pws-delivery-evidence" key={record.evidenceId}>
                    <strong>{record.title}</strong>
                    <span>{record.kind} · {record.source}{record.artifactId ? ` · ${record.artifactId}` : ' · 未绑定产物'}</span>
                    {record.summary && <p>{record.summary}</p>}
                  </div>
                ))}
              </section>
            </div>
          </div>
        </>
      )}
    </section>
  )
}

function DeliveryPackageVerification({
  report,
  trustSnapshot,
  onVerificationChange,
  onTrustChange,
  onSaved,
  onError
}: {
  report: Exclude<WorkflowProjectDeliveryPackageVerificationResult, { canceled: true }>
  trustSnapshot?: WorkflowDeliveryIdentityTrustSnapshot
  onVerificationChange: (report: Exclude<WorkflowProjectDeliveryPackageVerificationResult, { canceled: true }>) => void
  onTrustChange: (snapshot: WorkflowDeliveryIdentityTrustSnapshot) => void
  onSaved: (saved: { fileName: string; receiptDigest: string }) => void
  onError: (message: string) => void
}): React.JSX.Element {
  const [saving, setSaving] = useState(false)
  const [trusting, setTrusting] = useState(false)
  const [identityLabel, setIdentityLabel] = useState('')
  const saveReceipt = useCallback(async (): Promise<void> => {
    setSaving(true)
    onError('')
    try {
      const saved = await window.agentDesk.saveWorkflowProjectDeliveryPackageVerificationReceipt({
        verificationId: report.verificationId
      })
      if (!saved.canceled) onSaved(saved)
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }, [onError, onSaved, report.verificationId])
  const trustIdentity = useCallback(async (): Promise<void> => {
    if (!trustSnapshot || !identityLabel.trim()) return
    setTrusting(true)
    onError('')
    try {
      const result = await window.agentDesk.trustWorkflowDeliveryIdentity({
        verificationId: report.verificationId,
        label: identityLabel,
        expectedRevision: trustSnapshot.revision
      })
      onTrustChange(result.snapshot)
      if (result.verification) onVerificationChange(result.verification)
      setIdentityLabel('')
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setTrusting(false)
    }
  }, [identityLabel, onError, onTrustChange, onVerificationChange, report.verificationId, trustSnapshot])
  return (
    <div className={`pws-package-verification is-${report.verdict}`} role="status" aria-live="polite">
      <div className="pws-package-verification-head">
        <div>
          <strong>{report.verdict === 'verified' ? '交付包验证通过' : '交付包验证未通过'}</strong>
          <span>{report.fileName}{report.projectId ? ` · ${report.projectId}` : ''}</span>
        </div>
        <span>
          {report.verifiedArtifactCount ?? 0}/{report.declaredArtifactCount ?? 0} 文件 · {formatBytes(report.verifiedArtifactBytes ?? 0)}
          {report.manifestVerdict ? ` · 清单 ${report.manifestVerdict}` : ''}
        </span>
      </div>
      <div className="pws-package-verification-signals" aria-label="交付包验证状态">
        <span data-state={report.byteIntegrity === 'verified' ? 'ok' : 'blocked'}>
          字节 {report.byteIntegrity === 'verified' ? '完整' : '异常'}
        </span>
        <span data-state={report.signatureStatus === 'valid' ? 'ok' : report.signatureStatus === 'unsigned' ? 'neutral' : 'blocked'}>
          签名 {report.signatureStatus === 'valid' ? '有效' : report.signatureStatus === 'unsigned' ? '未签名' : '无效'}
        </span>
        <span data-state={report.identityTrust === 'local_identity' || report.identityTrust === 'trusted_identity' ? 'ok' : report.identityTrust === 'revoked_identity' ? 'blocked' : 'neutral'}>
          身份 {deliveryIdentityTrustLabel(report)}
        </span>
        <span data-state={report.trustPolicyVerdict === 'passed' ? 'ok' : 'blocked'}>
          策略 {report.trustPolicyVerdict === 'passed' ? '通过' : '阻断'} · {deliveryTrustPolicyLabel(report.trustPolicyMode)}
        </span>
      </div>
      {report.packageDigest && (
        <div className="pws-package-verification-digests">
          <code>{shortDigest(report.packageDigest)}</code>
          {report.manifestDigest && <code>{shortDigest(report.manifestDigest)}</code>}
          {report.signingIdentityFingerprint && <code title="Ed25519 公钥 SHA-256 指纹">{shortDigest(report.signingIdentityFingerprint)}</code>}
        </div>
      )}
      {(report.identityTrust === 'unknown_identity' || report.identityTrust === 'revoked_identity') && report.signatureStatus === 'valid' && trustSnapshot && (
        <div className="pws-package-verification-trust">
          <input
            value={identityLabel}
            onChange={(event) => setIdentityLabel(event.target.value)}
            maxLength={100}
            placeholder={report.identityTrust === 'revoked_identity' ? report.signingIdentityLabel || '重新信任名称' : '合作方身份名称'}
            aria-label="合作方身份名称"
          />
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => void trustIdentity()}
            disabled={trusting || !identityLabel.trim()}
          >
            <UserCheck size={12} aria-hidden="true" />
            {trusting ? '保存中...' : report.identityTrust === 'revoked_identity' ? '重新信任' : '信任此身份'}
          </button>
        </div>
      )}
      {report.blockers.length > 0 && (
        <ul className="pws-package-verification-blockers">
          {report.blockers.map((blocker, index) => (
            <li key={`${blocker.code}-${blocker.entry ?? ''}-${index}`}>
              {blocker.message}{blocker.entry ? ` · ${blocker.entry}` : ''}
            </li>
          ))}
        </ul>
      )}
      <div className="pws-package-verification-actions">
        <button type="button" className="btn btn-ghost btn-xs" onClick={() => void saveReceipt()} disabled={saving}>
          <Save size={12} aria-hidden="true" />
          {saving ? '保存中...' : '保存验证凭证'}
        </button>
      </div>
    </div>
  )
}

function DeliveryIdentityTrustList({
  snapshot,
  onChange,
  onPolicyChange,
  onMessage,
  onError
}: {
  snapshot: WorkflowDeliveryIdentityTrustSnapshot
  onChange: (snapshot: WorkflowDeliveryIdentityTrustSnapshot) => void
  onPolicyChange: () => void
  onMessage: (message: string) => void
  onError: (message: string) => void
}): React.JSX.Element {
  const [revoking, setRevoking] = useState('')
  const [busy, setBusy] = useState<'policy' | 'trust-export' | 'trust-import' | 'backup' | 'restore' | 'rotate' | ''>('')
  const [passphrase, setPassphrase] = useState('')
  const [confirmingRotation, setConfirmingRotation] = useState(false)
  const updatePolicy = useCallback(async (
    mode: WorkflowDeliveryIdentityTrustSnapshot['policy']['mode']
  ): Promise<void> => {
    if (mode === snapshot.policy.mode) return
    setBusy('policy')
    onError('')
    try {
      const result = await window.agentDesk.updateWorkflowDeliveryTrustPolicy({
        mode,
        expectedRevision: snapshot.revision
      })
      onChange(result.snapshot)
      onPolicyChange()
      onMessage(`交付信任策略已切换为 ${deliveryTrustPolicyLabel(mode)}，请重新验证交付包`)
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }, [onChange, onError, onMessage, onPolicyChange, snapshot.policy.mode, snapshot.revision])
  const revoke = useCallback(async (fingerprint: string): Promise<void> => {
    setRevoking(fingerprint)
    onError('')
    try {
      const result = await window.agentDesk.revokeWorkflowDeliveryIdentity({
        fingerprint,
        expectedRevision: snapshot.revision
      })
      onChange(result.snapshot)
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setRevoking('')
    }
  }, [onChange, onError, snapshot.revision])
  const exportTrustBundle = useCallback(async (): Promise<void> => {
    setBusy('trust-export')
    onError('')
    try {
      const result = await window.agentDesk.exportWorkflowDeliveryIdentityTrustBundle()
      if (!result.canceled) onMessage(`${result.fileName} · ${result.identityCount ?? 0} 个身份`)
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }, [onError, onMessage])
  const importTrustBundle = useCallback(async (): Promise<void> => {
    setBusy('trust-import')
    onError('')
    try {
      const result = await window.agentDesk.importWorkflowDeliveryIdentityTrustBundle(snapshot.revision)
      if (!result.canceled) {
        onChange(result.snapshot)
        onMessage(`信任包已合并 · 新增 ${result.importedCount} · 更新 ${result.updatedCount} · 未变 ${result.unchangedCount}`)
      }
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }, [onChange, onError, onMessage, snapshot.revision])
  const backupIdentity = useCallback(async (): Promise<void> => {
    if (passphrase.length < 12) return
    setBusy('backup')
    onError('')
    try {
      const result = await window.agentDesk.exportWorkflowDeliveryIdentityBackup({ passphrase })
      if (!result.canceled) {
        onMessage(`${result.fileName} · ${shortDigest(result.identityFingerprint)}`)
        setPassphrase('')
      }
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }, [onError, onMessage, passphrase])
  const restoreIdentity = useCallback(async (): Promise<void> => {
    if (passphrase.length < 12) return
    setBusy('restore')
    onError('')
    try {
      const result = await window.agentDesk.restoreWorkflowDeliveryIdentityBackup({ passphrase })
      if (!result.canceled) {
        onChange(result.snapshot)
        onMessage(result.disposition === 'reinstalled' ? '交付身份已重新安装' : '交付身份已恢复，原身份已撤销')
        setPassphrase('')
      }
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }, [onChange, onError, onMessage, passphrase])
  const rotateIdentity = useCallback(async (): Promise<void> => {
    setBusy('rotate')
    onError('')
    try {
      const result = await window.agentDesk.rotateWorkflowDeliveryIdentity({
        ...(snapshot.localIdentity ? { expectedFingerprint: snapshot.localIdentity.fingerprint } : {})
      })
      onChange(result.snapshot)
      onMessage('新的交付签名身份已启用，原身份已撤销')
      setConfirmingRotation(false)
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }, [onChange, onError, onMessage, snapshot.localIdentity])
  return (
    <section className="pws-delivery-identities" aria-labelledby="delivery-trusted-identities">
      <div className="pws-delivery-identities-head">
        <div>
          <strong id="delivery-trusted-identities">交付身份</strong>
          <span>{snapshot.identities.filter((item) => item.status === 'trusted').length} 个可信 · rev {snapshot.revision}</span>
        </div>
        <div className="pws-delivery-identity-toolbar">
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => void importTrustBundle()} disabled={Boolean(busy)} title="导入交付身份信任包">
            <Upload size={12} aria-hidden="true" />{busy === 'trust-import' ? '导入中...' : '导入信任'}
          </button>
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => void exportTrustBundle()} disabled={Boolean(busy)} title="导出交付身份信任包">
            <Download size={12} aria-hidden="true" />{busy === 'trust-export' ? '导出中...' : '导出信任'}
          </button>
        </div>
      </div>
      <div className="pws-delivery-trust-policy" role="group" aria-label="组织交付信任策略">
        {(['audit_only', 'require_valid_signature', 'require_trusted_identity'] as const).map((mode) => (
          <button
            type="button"
            key={mode}
            aria-pressed={snapshot.policy.mode === mode}
            onClick={() => void updatePolicy(mode)}
            disabled={Boolean(busy)}
          >
            {deliveryTrustPolicyLabel(mode)}
          </button>
        ))}
      </div>
      {snapshot.localIdentity && (
        <div className="pws-delivery-local-identity">
          <div>
            <KeyRound size={13} aria-hidden="true" />
            <strong>本机签名身份</strong>
            <code>{shortDigest(snapshot.localIdentity.fingerprint)}</code>
            <span>{snapshot.localIdentity.retiredIdentities.length} 个历史身份</span>
          </div>
          {!confirmingRotation ? (
            <button type="button" className="btn btn-ghost btn-xs" onClick={() => setConfirmingRotation(true)} disabled={Boolean(busy)} title="轮换本机交付签名身份">
              <RotateCw size={12} aria-hidden="true" />轮换
            </button>
          ) : (
            <div className="pws-delivery-rotation-confirm">
              <button type="button" className="btn btn-danger btn-xs" onClick={() => void rotateIdentity()} disabled={Boolean(busy)}>
                <RotateCw size={12} aria-hidden="true" />{busy === 'rotate' ? '轮换中...' : '确认轮换'}
              </button>
              <button type="button" className="btn btn-ghost btn-xs" onClick={() => setConfirmingRotation(false)} disabled={Boolean(busy)} title="取消轮换">
                <X size={12} aria-hidden="true" />取消
              </button>
            </div>
          )}
        </div>
      )}
      <div className="pws-delivery-identity-backup">
        <input
          type="password"
          value={passphrase}
          minLength={12}
          maxLength={1024}
          onChange={(event) => setPassphrase(event.target.value)}
          placeholder="身份备份密码（至少 12 位）"
          aria-label="交付身份备份密码"
          autoComplete="new-password"
        />
        <button type="button" className="btn btn-ghost btn-xs" onClick={() => void backupIdentity()} disabled={Boolean(busy) || passphrase.length < 12}>
          <Save size={12} aria-hidden="true" />{busy === 'backup' ? '备份中...' : '备份身份'}
        </button>
        <button type="button" className="btn btn-ghost btn-xs" onClick={() => void restoreIdentity()} disabled={Boolean(busy) || passphrase.length < 12}>
          <Upload size={12} aria-hidden="true" />{busy === 'restore' ? '恢复中...' : '恢复身份'}
        </button>
      </div>
      <div className="pws-delivery-identities-list">
        {snapshot.identities.length === 0 && <span className="pws-delivery-empty">暂无合作方身份</span>}
        {snapshot.identities.map((identity) => (
          <div className="pws-delivery-identity" data-status={identity.status} key={identity.fingerprint}>
            <div>
              <strong>{identity.label}</strong>
              <code>{shortDigest(identity.fingerprint)}</code>
              <span>{identity.status === 'trusted' ? '可信' : '已撤销'}{identity.lastProjectId ? ` · ${identity.lastProjectId}` : ''}</span>
            </div>
            {identity.status === 'trusted' && (
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={() => void revoke(identity.fingerprint)}
                disabled={Boolean(revoking)}
                title="撤销交付身份信任"
              >
                <ShieldOff size={12} aria-hidden="true" />
                {revoking === identity.fingerprint ? '撤销中...' : '撤销'}
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

function deliveryIdentityTrustLabel(
  report: Exclude<WorkflowProjectDeliveryPackageVerificationResult, { canceled: true }>
): string {
  if (report.identityTrust === 'local_identity') return '本机 CaoGen'
  if (report.identityTrust === 'trusted_identity') return report.signingIdentityLabel || '已信任'
  if (report.identityTrust === 'revoked_identity') return `${report.signingIdentityLabel || '已知身份'}（已撤销）`
  if (report.identityTrust === 'unknown_identity') return '未知公钥'
  return '未提供'
}

function deliveryTrustPolicyLabel(
  mode: WorkflowDeliveryIdentityTrustSnapshot['policy']['mode']
): string {
  if (mode === 'require_valid_signature') return '必须签名'
  if (mode === 'require_trusted_identity') return '必须信任身份'
  return '仅审计'
}

function ProjectDeliveryAudit({ report }: { report: WorkflowProjectDeliveryIntegrityReport }): React.JSX.Element {
  return (
    <div className={`pws-project-delivery-audit is-${report.verdict}`} role="status">
      <div>
        <strong>{report.verdict === 'ready' ? 'Project 当前产物全部可交付' : `${report.summary.blockedArtifactCount} 个当前产物有阻塞`}</strong>
        <span>{report.summary.readyArtifactCount}/{report.summary.currentArtifactCount} 可交付 · 已核对 {formatBytes(report.summary.verifiedBytes)}</span>
      </div>
      {report.summary.blockerCounts.length > 0 && (
        <div className="pws-project-delivery-blockers">
          {report.summary.blockerCounts.map((item) => <span key={item.code}>{projectBlockerLabel(item.code)} · {item.count}</span>)}
        </div>
      )}
    </div>
  )
}

function projectBlockerLabel(code: WorkflowProjectDeliveryIntegrityReport['summary']['blockerCounts'][number]['code']): string {
  const labels: Record<typeof code, string> = {
    HISTORICAL_VERSION: '历史版本',
    LOCAL_LOCATION_UNVERIFIED: '文件未校验',
    EVIDENCE_MISSING: '缺 Evidence',
    ACCEPTANCE_MISSING: '缺 Acceptance',
    ACCEPTANCE_PENDING: '等待验收',
    ACCEPTANCE_FAILED: '验收失败'
  }
  return labels[code]
}

function DeliverySummary({ projection }: { projection: WorkflowProjectDeliveryWorkbench }): React.JSX.Element {
  const { summary } = projection
  return (
    <div className="pws-delivery-summary" data-delivery-summary>
      <span><strong>{summary.availableArtifactCount}</strong> 可用产物</span>
      <span><strong>{summary.evidenceCount}</strong> Evidence</span>
      <span><strong>{summary.passedAcceptanceCount}</strong> 通过</span>
      <span><strong>{summary.pendingAcceptanceCount}</strong> 待验收</span>
      <span><strong>{summary.failedAcceptanceCount}</strong> 失败</span>
      <span><strong>{summary.unlinkedEvidenceCount}</strong> 未绑定 Evidence</span>
    </div>
  )
}

function ArtifactDeliveryList({
  artifacts,
  evidence,
  evidenceById,
  projectId,
  onOpenFile,
  onOpenPreview,
  onOpenBrowser,
  onRefresh
}: {
  artifacts: WorkflowProjectDeliveryArtifact[]
  evidence: WorkflowProjectDeliveryWorkbench['evidence']
  evidenceById: ReadonlyMap<string, WorkflowProjectDeliveryWorkbench['evidence'][number]>
  projectId: string
  onOpenFile: (path: string) => Promise<void>
  onOpenPreview: (path?: string) => Promise<void>
  onOpenBrowser: (url?: string) => Promise<void>
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const artifactById = new Map(artifacts.map((item) => [item.artifact.id, item]))
  return (
    <section className="pws-delivery-subsection" aria-labelledby="delivery-artifacts">
      <h3 id="delivery-artifacts">交付物 ({artifacts.length})</h3>
      {artifacts.length === 0 ? <p className="pws-delivery-empty">暂无 Artifact</p> : artifacts.map((item) => (
        <article className={`pws-delivery-artifact ${item.isCurrent ? '' : 'is-superseded'}`} key={item.artifact.id}>
          <div className="pws-delivery-artifact-head">
            <strong>{item.artifact.title}</strong>
            <span>v{item.artifact.version} · {item.artifact.kind}</span>
          </div>
          <div className="pws-delivery-artifact-meta">
            <span>{item.available ? '可用位置' : '缺少可用位置'} · {item.locations.length} 个位置</span>
            <span>{item.evidenceIds.length} Evidence · {item.acceptanceIds.length} Acceptance</span>
          </div>
          <ArtifactLineage artifact={item} artifactById={artifactById} />
          <ArtifactComparer artifact={item} artifactById={artifactById} />
          <ArtifactIntegrity artifact={item} />
          <ArtifactExporter artifact={item} />
          {item.acceptanceIds.length === 0 && (
            <ArtifactAcceptanceCreator artifact={item} onRefresh={onRefresh} />
          )}
          {item.locations.length > 0 && <div className="pws-delivery-locations">{item.locations.map((location) => (
            <div className="pws-delivery-location" key={location.id}>
              <code>{location.path || location.uri || location.kind} · {location.availability}</code>
              {location.path && location.availability === 'available' && (
                <>
                  <button type="button" className="btn btn-ghost btn-xs" onClick={() => void onOpenFile(location.path!)}>打开文件</button>
                  <button type="button" className="btn btn-ghost btn-xs" onClick={() => void onOpenPreview(location.path)}>预览</button>
                </>
              )}
              {location.uri && /^https?:\/\//i.test(location.uri) && (
                <button type="button" className="btn btn-ghost btn-xs" onClick={() => void onOpenBrowser(location.uri)}>打开链接</button>
              )}
            </div>
          ))}</div>}
          {item.evidenceIds.length > 0 && <div className="pws-delivery-evidence-chips">{item.evidenceIds.map((id) => <span key={id}>{evidenceById.get(id)?.title || id}</span>)}</div>}
          <ArtifactEvidenceBinder
            artifact={item}
            evidence={evidence}
            projectId={projectId}
            onRefresh={onRefresh}
          />
        </article>
      ))}
    </section>
  )
}

function ArtifactLineage({
  artifact,
  artifactById
}: {
  artifact: WorkflowProjectDeliveryArtifact
  artifactById: ReadonlyMap<string, WorkflowProjectDeliveryArtifact>
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const versions = artifact.lineageArtifactIds
    .map((id) => artifactById.get(id))
    .filter((item): item is WorkflowProjectDeliveryArtifact => Boolean(item))
  const hasHistory = versions.length > 1
  const currentVersions = artifact.currentArtifactIds
    .map((id) => artifactById.get(id))
    .filter((item): item is WorkflowProjectDeliveryArtifact => Boolean(item))
  return (
    <div className="pws-artifact-lineage">
      <div className="pws-artifact-lineage-summary">
        <code title={artifact.artifact.digest}>{shortDigest(artifact.artifact.digest)}</code>
        <span>{artifact.isCurrent ? '当前版本' : '历史版本'}</span>
        {artifact.predecessorArtifactId && <span>替代 v{artifactById.get(artifact.predecessorArtifactId)?.artifact.version ?? '?'}</span>}
        {artifact.successorArtifactIds.length > 0 && <span>{artifact.successorArtifactIds.length} 个后继</span>}
        {hasHistory && (
          <button
            type="button"
            className="btn btn-ghost btn-icon-sm"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-label={expanded ? '收起版本历史' : '展开版本历史'}
            title={expanded ? '收起版本历史' : '展开版本历史'}
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        )}
      </div>
      {!artifact.isCurrent && currentVersions.length > 0 && (
        <div className="pws-artifact-current-leaves">
          当前可交付：{currentVersions.map((item) => `v${item.artifact.version} ${shortDigest(item.artifact.digest)}`).join(' · ')}
        </div>
      )}
      {expanded && (
        <ol className="pws-artifact-lineage-versions">
          {versions.map((item) => (
            <li className={item.isCurrent ? 'is-current' : ''} key={item.artifact.id}>
              <span>v{item.artifact.version}</span>
              <strong>{item.artifact.title}</strong>
              <code title={item.artifact.digest}>{shortDigest(item.artifact.digest)}</code>
              <span>{item.isCurrent ? '当前' : '历史'}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function shortDigest(value: string): string {
  const normalized = value.replace(/^sha256:/i, '')
  return normalized.length > 16 ? `${normalized.slice(0, 8)}...${normalized.slice(-8)}` : normalized
}

function ArtifactComparer({
  artifact,
  artifactById
}: {
  artifact: WorkflowProjectDeliveryArtifact
  artifactById: ReadonlyMap<string, WorkflowProjectDeliveryArtifact>
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<WorkflowArtifactCompareResult>()
  const [error, setError] = useState('')
  const baseArtifactId = artifact.predecessorArtifactId ?? artifact.artifact.id
  const targetArtifactId = artifact.predecessorArtifactId
    ? artifact.artifact.id
    : artifact.successorArtifactIds[0]
  if (!targetArtifactId || !artifactById.has(baseArtifactId) || !artifactById.has(targetArtifactId)) return null
  const compare = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      setResult(await window.agentDesk.compareWorkflowArtifacts({ baseArtifactId, targetArtifactId }))
    } catch (cause) {
      setResult(undefined)
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="pws-artifact-compare">
      <button type="button" className="btn btn-ghost btn-xs" onClick={() => void compare()} disabled={busy}>
        <GitCompareArrows size={12} aria-hidden="true" />
        {busy ? '比较中...' : artifact.predecessorArtifactId ? '对比前一版' : '对比后一版'}
      </button>
      {result && <ArtifactCompareResult result={result} />}
      {error && <span className="pws-delivery-inline-error" role="alert">{error}</span>}
    </div>
  )
}

function ArtifactCompareResult({ result }: { result: WorkflowArtifactCompareResult }): React.JSX.Element {
  return (
    <div className="pws-artifact-compare-result" role="status">
      <div className="pws-artifact-compare-summary">
        <strong>v{result.base.version} → v{result.target.version}</strong>
        <span>{result.comparison === 'identical' ? '内容相同' : result.comparison === 'binary' ? '二进制差异' : `+${result.addedLines} / -${result.removedLines} 行`}</span>
        <span>{signedBytes(result.sizeDeltaBytes)}</span>
        {result.truncated && <span>结果已截断</span>}
      </div>
      <div className="pws-artifact-compare-digests">
        <code title={result.base.digest}>{shortDigest(result.base.digest)}</code>
        <span>→</span>
        <code title={result.target.digest}>{shortDigest(result.target.digest)}</code>
      </div>
      {result.changes.length > 0 && (
        <pre className="pws-artifact-compare-lines" aria-label="Artifact 文本版本差异">
          {result.changes.map((change, index) => (
            <span className={`is-${change.kind}`} key={`${index}:${change.kind}`}>
              {change.kind === 'added' ? '+' : change.kind === 'removed' ? '-' : ' '}{change.text}{'\n'}
            </span>
          ))}
        </pre>
      )}
    </div>
  )
}

function signedBytes(value: number): string {
  if (value === 0) return '大小不变'
  return `${value > 0 ? '+' : '-'}${formatBytes(Math.abs(value))}`
}

function ArtifactExporter({ artifact }: { artifact: WorkflowProjectDeliveryArtifact }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const hasLocalLocation = artifact.locations.some((location) =>
    location.availability === 'available' && Boolean(location.path || location.uri?.toLowerCase().startsWith('file:'))
  )
  const exportArtifact = async (): Promise<void> => {
    setBusy(true)
    setMessage('')
    setError('')
    try {
      const result = await window.agentDesk.exportWorkflowArtifact({ artifactId: artifact.artifact.id })
      if (!result.canceled) {
        setMessage(`${result.fileName} · ${formatBytes(result.sizeBytes)} · ${result.digest.slice(0, 20)}`)
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="pws-delivery-artifact-export">
      <button
        type="button"
        className="btn btn-ghost btn-xs"
        onClick={() => void exportArtifact()}
        disabled={busy || !hasLocalLocation}
        title={hasLocalLocation ? '导出并校验交付物' : '没有可导出的本地文件'}
      >
        <Download size={12} aria-hidden="true" />
        {busy ? '导出中...' : '导出'}
      </button>
      {message && <span className="pws-delivery-inline-success" role="status">{message}</span>}
      {error && <span className="pws-delivery-inline-error" role="alert">{error}</span>}
    </div>
  )
}

function ArtifactIntegrity({ artifact }: { artifact: WorkflowProjectDeliveryArtifact }): React.JSX.Element {
  const [busy, setBusy] = useState<'verify' | 'manifest' | ''>('')
  const [report, setReport] = useState<WorkflowArtifactIntegrityReport>()
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const verify = async (): Promise<void> => {
    setBusy('verify')
    setMessage('')
    setError('')
    try {
      setReport(await window.agentDesk.verifyWorkflowArtifactIntegrity({ artifactId: artifact.artifact.id }))
    } catch (cause) {
      setReport(undefined)
      setError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }
  const exportManifest = async (): Promise<void> => {
    setBusy('manifest')
    setMessage('')
    setError('')
    try {
      const result = await window.agentDesk.exportWorkflowArtifactManifest({ artifactId: artifact.artifact.id })
      if (!result.canceled) {
        setMessage(`${result.fileName} · ${result.verdict === 'ready' ? '可交付' : '含阻塞项'} · ${shortDigest(result.manifestDigest)}`)
        setReport(await window.agentDesk.verifyWorkflowArtifactIntegrity({ artifactId: artifact.artifact.id }))
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }
  return (
    <div className="pws-artifact-integrity">
      <div className="pws-artifact-integrity-actions">
        <button type="button" className="btn btn-ghost btn-xs" onClick={() => void verify()} disabled={Boolean(busy)}>
          <ShieldCheck size={12} aria-hidden="true" />
          {busy === 'verify' ? '校验中...' : '完整性校验'}
        </button>
        <button type="button" className="btn btn-ghost btn-xs" onClick={() => void exportManifest()} disabled={Boolean(busy)}>
          <FileJson size={12} aria-hidden="true" />
          {busy === 'manifest' ? '导出中...' : '交付清单'}
        </button>
      </div>
      {report && <ArtifactIntegrityResult report={report} />}
      {message && <span className="pws-delivery-inline-success" role="status">{message}</span>}
      {error && <span className="pws-delivery-inline-error" role="alert">{error}</span>}
    </div>
  )
}

function ArtifactIntegrityResult({ report }: { report: WorkflowArtifactIntegrityReport }): React.JSX.Element {
  return (
    <div className={`pws-artifact-integrity-result is-${report.verdict}`} role="status">
      <div className="pws-artifact-integrity-verdict">
        <strong>{report.verdict === 'ready' ? '可交付' : `${report.blockers.length} 个阻塞项`}</strong>
        <span>{report.locations.byteVerified ? '字节已校验' : '字节未校验'} · {report.evidence.length} Evidence · {report.acceptances.length} Acceptance</span>
      </div>
      <div className="pws-artifact-integrity-checks">
        {report.checks.map((check) => (
          <span className={`is-${check.status}`} key={check.kind} title={check.message}>
            {check.status === 'passed' ? '通过' : '阻塞'} · {integrityCheckLabel(check.kind)}
          </span>
        ))}
      </div>
      {report.blockers.length > 0 && (
        <ul className="pws-artifact-integrity-blockers">
          {report.blockers.map((blocker) => <li key={blocker.code}>{blocker.message}</li>)}
        </ul>
      )}
    </div>
  )
}

function integrityCheckLabel(kind: WorkflowArtifactIntegrityReport['checks'][number]['kind']): string {
  const labels: Record<typeof kind, string> = {
    canonical_ownership: 'Project 归属',
    artifact_graph: 'Artifact Graph',
    current_version: '当前版本',
    local_location: '本地位置',
    content_identity: '文件身份',
    evidence_binding: 'Evidence',
    acceptance_status: 'Acceptance'
  }
  return labels[kind]
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

function ArtifactAcceptanceCreator({
  artifact,
  onRefresh
}: {
  artifact: WorkflowProjectDeliveryArtifact
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const createAcceptance = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await window.agentDesk.createWorkflowArtifactAcceptance({ artifactId: artifact.artifact.id })
      await onRefresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="pws-delivery-evidence-binder">
      <button
        type="button"
        className="btn btn-primary btn-xs"
        onClick={() => void createAcceptance()}
        disabled={busy}
      >
        {busy ? '创建中...' : '创建验收'}
      </button>
      {error && <p className="pws-delivery-inline-error" role="alert">{error}</p>}
    </div>
  )
}

function ArtifactEvidenceBinder({
  artifact,
  evidence,
  projectId,
  onRefresh
}: {
  artifact: WorkflowProjectDeliveryArtifact
  evidence: WorkflowProjectDeliveryWorkbench['evidence']
  projectId: string
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const [selectedEvidenceId, setSelectedEvidenceId] = useState('')
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [kind, setKind] = useState<WorkflowEvidenceKind>('delivery_check')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const attachExisting = async (): Promise<void> => {
    if (!selectedEvidenceId) return
    setBusy(true)
    setError('')
    try {
      await window.agentDesk.createWorkflowEvidenceLink({
        id: newWorkflowId('evidence-link'),
        evidenceId: selectedEvidenceId,
        projectId,
        artifactId: artifact.artifact.id,
        relation: 'verifies'
      })
      setSelectedEvidenceId('')
      await onRefresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  const createAndAttach = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const trimmedTitle = title.trim()
    if (!trimmedTitle) {
      setError('Evidence 标题不能为空')
      return
    }
    setBusy(true)
    setError('')
    try {
      const evidenceId = newWorkflowId('evidence')
      await window.agentDesk.createWorkflowEvidence({
        evidenceId,
        projectId,
        artifactId: artifact.artifact.id,
        kind,
        title: trimmedTitle,
        ...(summary.trim() ? { summary: summary.trim() } : {}),
        contentDigest: await sha256(`${trimmedTitle}\n${summary.trim()}\n${artifact.artifact.id}`)
      })
      await window.agentDesk.createWorkflowEvidenceLink({
        id: newWorkflowId('evidence-link'),
        evidenceId,
        projectId,
        artifactId: artifact.artifact.id,
        relation: 'verifies'
      })
      setTitle('')
      setSummary('')
      await onRefresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  const availableEvidence = evidence.filter((record) => !artifact.evidenceIds.includes(record.evidenceId))
  return (
    <div className="pws-delivery-evidence-binder">
      <div className="pws-delivery-binder-row">
        <select className="select" value={selectedEvidenceId} onChange={(event) => setSelectedEvidenceId(event.target.value)} disabled={busy} aria-label="选择已有 Evidence">
          <option value="">选择已有 Evidence</option>
          {availableEvidence.map((record) => <option key={record.evidenceId} value={record.evidenceId}>{record.title}</option>)}
        </select>
        <button type="button" className="btn btn-ghost btn-xs" onClick={() => void attachExisting()} disabled={busy || !selectedEvidenceId}>绑定 Evidence</button>
      </div>
      <form className="pws-delivery-new-evidence" onSubmit={(event) => void createAndAttach(event)}>
        <input className="input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="新 Evidence 标题" disabled={busy} />
        <select className="select" value={kind} onChange={(event) => setKind(event.target.value as WorkflowEvidenceKind)} disabled={busy} aria-label="Evidence 类型">
          {EVIDENCE_KINDS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
        <input className="input" value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="摘要（可选）" disabled={busy} />
        <button type="submit" className="btn btn-ghost btn-xs" disabled={busy || !title.trim()}>新建并绑定</button>
      </form>
      {error && <p className="pws-delivery-inline-error" role="alert">{error}</p>}
    </div>
  )
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const result = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function downloadDeliveryExport(projectId: string, json: string): void {
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${projectId.replace(/[^a-z0-9_-]+/gi, '-') || 'project'}-delivery-export.json`
  link.click()
  URL.revokeObjectURL(url)
}
