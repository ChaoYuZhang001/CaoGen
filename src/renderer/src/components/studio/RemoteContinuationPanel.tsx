import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link2, LockKeyhole, RefreshCw, ShieldCheck, Unplug } from 'lucide-react'
import type { RemoteContinuationSnapshot, RemoteDeviceCapability, RemoteResultProjection } from '../../../../shared/types'

const DEFAULT_CAPABILITIES: RemoteDeviceCapability[] = ['view_results', 'resume_work_item', 'approve_effect']

export function RemoteContinuationPanel({ active, projectId }: { active: boolean; projectId?: string }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<RemoteContinuationSnapshot | null>(null)
  const [projection, setProjection] = useState<RemoteResultProjection | null>(null)
  const [label, setLabel] = useState('我的移动设备')
  const [userId, setUserId] = useState('local-user')
  const [publicKey, setPublicKey] = useState('')
  const [editingCapabilities, setEditingCapabilities] = useState<Record<string, RemoteDeviceCapability[]>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pairing, setPairing] = useState<{ url: string; expiresAt: number } | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setError('')
    try {
      const next = await window.agentDesk.getRemoteContinuation()
      setSnapshot(next)
      if (projectId) setProjection(await window.agentDesk.getRemoteResultProjection(projectId))
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }, [projectId])

  useEffect(() => {
    if (active) void refresh()
  }, [active, refresh])

  const run = async (operation: () => Promise<unknown>): Promise<void> => {
    if (busy) return
    setBusy(true); setError('')
    try { await operation(); await refresh() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }

  const activeDevices = useMemo(() => snapshot?.devices.filter((device) => device.status === 'active') ?? [], [snapshot])
  const toggleCapability = (deviceId: string, capability: RemoteDeviceCapability): void => {
    setEditingCapabilities((current) => {
      const selected = current[deviceId] ?? snapshot?.devices.find((device) => device.id === deviceId)?.capabilities ?? []
      const next = selected.includes(capability) ? selected.filter((item) => item !== capability) : [...selected, capability]
      return { ...current, [deviceId]: next }
    })
  }
  const createPairing = async (): Promise<void> => {
    setError('')
    try {
      const next = await window.agentDesk.createRemotePairingSession({ ttlMs: 5 * 60_000, projectId })
      setPairing(next)
      try { await navigator.clipboard.writeText(next.url) } catch { /* clipboard permission is optional */ }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  return (
    <section className="remote-continuation-panel" aria-labelledby="remote-continuation-title">
      <header className="remote-continuation-header">
        <div>
          <h2 id="remote-continuation-title"><Link2 size={16} aria-hidden="true" />远程接续</h2>
          <p>只同步任务状态、审批和交付摘要；本地凭据与原文不会离开桌面端。</p>
        </div>
        <button type="button" className="btn btn-ghost btn-icon-sm" aria-label="刷新远程状态" title="刷新远程状态" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} className={busy ? 'remote-spin' : undefined} aria-hidden="true" /></button>
      </header>
      {error && <p className="remote-continuation-error" role="alert">{error}</p>}
      <div className="remote-continuation-toolbar">
        <span className={`remote-connectivity remote-connectivity-${snapshot?.connectivity ?? 'offline'}`}><span aria-hidden="true" />{snapshot?.connectivity === 'online' ? '控制通道在线' : '桌面离线，命令仅排队'}</span>
        <span className="remote-webhook-status" title="本机 Webhook 接收状态">{snapshot?.webhook?.running ? `Webhook ${snapshot.webhook.host}:${snapshot.webhook.port}` : 'Webhook 未监听'}</span>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !snapshot} onClick={() => void run(() => window.agentDesk.setRemoteConnectivity(snapshot?.connectivity === 'online' ? 'offline' : 'online'))}>{snapshot?.connectivity === 'online' ? '模拟离线' : '恢复连接'}</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy || snapshot?.connectivity !== 'online'} onClick={() => void run(() => window.agentDesk.reconcileRemoteQueue())}>对账队列</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !snapshot?.webhook?.running} onClick={() => void createPairing()}><Link2 size={13} aria-hidden="true" />生成移动配对链接</button>
      </div>
      {pairing && <div className="remote-pairing-card"><strong>配对链接已复制</strong><a href={pairing.url} target="_blank" rel="noreferrer">{pairing.url}</a><small>有效期至 {new Date(pairing.expiresAt).toLocaleTimeString()}</small></div>}
      <div className="remote-continuation-bind">
        <strong><ShieldCheck size={14} aria-hidden="true" />绑定设备公钥</strong>
        <div className="remote-continuation-fields">
          <input className="input" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="设备名称" aria-label="设备名称" />
          <input className="input" value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="用户标识" aria-label="用户标识" />
          <input className="input remote-public-key" value={publicKey} onChange={(event) => setPublicKey(event.target.value)} placeholder="Ed25519 SPKI DER Base64" aria-label="设备公钥" />
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !label.trim() || !userId.trim() || !publicKey.trim()} onClick={() => void run(async () => { await window.agentDesk.registerRemoteDevice({ label, userId, publicKey, capabilities: DEFAULT_CAPABILITIES }); setPublicKey('') })}>绑定</button>
        </div>
      </div>
      <div className="remote-device-list">
        {activeDevices.length === 0 ? <span className="remote-muted">暂无绑定设备</span> : activeDevices.map((device) => (
          <div key={device.id} className="remote-device-row">
            <span><LockKeyhole size={14} aria-hidden="true" /><strong>{device.label}</strong><small>{device.publicKeyFingerprint.slice(0, 24)}...</small></span>
            <div className="remote-device-actions">
              <details className="remote-capability-editor">
                <summary>权限</summary>
                <div className="remote-capability-options">
                  {(['view_results', 'resume_work_item', 'approve_effect', 'trigger_routine', 'remote_runner'] as RemoteDeviceCapability[]).map((capability) => {
                    const selected = editingCapabilities[device.id] ?? device.capabilities
                    return <label key={capability}><input type="checkbox" checked={selected.includes(capability)} onChange={() => toggleCapability(device.id, capability)} />{capability}</label>
                  })}
                  <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => void run(() => window.agentDesk.updateRemoteDeviceCapabilities(device.id, editingCapabilities[device.id] ?? device.capabilities))}>保存权限</button>
                </div>
              </details>
              <button type="button" className="btn btn-ghost btn-icon-sm" aria-label={`解绑 ${device.label}`} title={`解绑 ${device.label}`} disabled={busy} onClick={() => void run(() => window.agentDesk.unbindRemoteDevice(device.id))}><Unplug size={14} aria-hidden="true" /></button>
            </div>
          </div>
        ))}
      </div>
      {snapshot && <div className="remote-queue-summary"><span>命令 {snapshot.commands.length}</span><span>待审批 {snapshot.approvals.filter((item) => item.status === 'pending').length}</span><span>租约 {snapshot.leases.filter((item) => item.status === 'active').length}</span><span>审计 {snapshot.audit.length}</span></div>}
      {snapshot && snapshot.commands.length > 0 && <div className="remote-state-list" aria-label="远程命令状态">
        <strong>最近命令</strong>
        {snapshot.commands.slice(-8).reverse().map((command) => (
          <div className="remote-state-row" key={command.envelope.commandId}>
            <span className="remote-state-kind">{command.envelope.kind}</span>
            <span>{command.status}</span>
            <span>{command.execution?.status ?? 'queued'}</span>
            <code>{command.envelope.commandId.slice(0, 8)}</code>
          </div>
        ))}
      </div>}
      {snapshot && snapshot.approvals.length > 0 && <div className="remote-state-list" aria-label="远程审批状态">
        <strong>最近审批</strong>
        {snapshot.approvals.slice(-8).reverse().map((approval) => (
          <div className="remote-state-row" key={approval.id}>
            <span className="remote-state-kind">{approval.action}</span>
            <span>{approval.status}</span>
            <span>{approval.applicationStatus}</span>
            <code title={approval.targetDigest}>目标 {approval.targetDigest.slice(0, 10)}</code>
          </div>
        ))}
      </div>}
      {projection && <div className="remote-result-projection"><strong>结果摘要 · {projection.projectName}</strong><span>{projection.activeWorkItemCount} 个未完成 WorkItem</span><span>{projection.availableArtifactCount}/{projection.artifactCount} 个可用 Artifact</span><span>{projection.passedAcceptanceCount}/{projection.acceptanceCount} 个验收通过</span><code>{projection.projectionDigest.slice(0, 20)}...</code></div>}
    </section>
  )
}
