import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { DigitalWorker, WorkItem, WorkItemOwner } from '../../../../shared/types'
import { TEXT } from './projectWorkspaceStudioModel'

export function WorkItemTransferForm({
  item,
  onCancel,
  onSubmit
}: {
  item: WorkItem
  onCancel: () => void
  onSubmit: (item: WorkItem, target: WorkItemOwner, reason: string, requestId: string) => Promise<void>
}): React.JSX.Element {
  const [targetType, setTargetType] = useState<WorkItemOwner['type']>('human')
  const [humanId, setHumanId] = useState('')
  const [humanName, setHumanName] = useState('')
  const [workerId, setWorkerId] = useState('')
  const [workers, setWorkers] = useState<DigitalWorker[]>([])
  const [workersLoading, setWorkersLoading] = useState(true)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const retry = useRef<{ key: string; requestId: string } | null>(null)

  useEffect(() => {
    let current = true
    setWorkersLoading(true)
    void window.agentDesk.listDigitalWorkers().then((allWorkers) => {
      if (!current) return
      const available = allWorkers.filter((worker) => worker.projectId === item.projectId && worker.status === 'active')
      setWorkers(available)
      setWorkerId((existing) => available.some((worker) => worker.id === existing) ? existing : available[0]?.id ?? '')
    }).catch((cause) => {
      if (current) setError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => {
      if (current) setWorkersLoading(false)
    })
    return () => { current = false }
  }, [item.projectId])

  const selectedWorker = workers.find((worker) => worker.id === workerId)
  const targetId = targetType === 'human' ? humanId.trim() : workerId
  const targetName = targetType === 'human' ? humanName.trim() : selectedWorker?.displayName ?? ''
  const canSubmit = Boolean(targetId && reason.trim()) && !busy
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!canSubmit) return
    const normalizedReason = reason.trim()
    const key = [item.id, item.revision, targetType, targetId, targetName, normalizedReason].join('\0')
    if (retry.current?.key !== key) retry.current = { key, requestId: newTransferRequestId() }
    setBusy(true)
    setError('')
    try {
      await onSubmit(item, {
        type: targetType,
        id: targetId,
        ...(targetName ? { displayName: targetName } : {})
      }, normalizedReason, retry.current.requestId)
      retry.current = null
      onCancel()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="pws-transfer-form" onSubmit={(event) => void submit(event)} data-work-item-transfer-form={item.id}>
      <div className="pws-transfer-heading">
        <strong>{TEXT.transferWorkItemTitle}</strong>
        <span>{item.title}</span>
      </div>
      <label>
        <span>{TEXT.transferTargetType}</span>
        <select value={targetType} disabled={busy} onChange={(event) => setTargetType(event.target.value as WorkItemOwner['type'])} data-work-item-transfer-target-type>
          <option value="human">{TEXT.ownerHuman}</option>
          <option value="digital_worker">{TEXT.ownerDigitalWorker}</option>
        </select>
      </label>
      {targetType === 'human' ? (
        <>
          <label><span>{TEXT.transferTargetId}</span><input value={humanId} maxLength={512} disabled={busy} onChange={(event) => setHumanId(event.target.value)} data-work-item-transfer-target-id /></label>
          <label><span>{TEXT.transferTargetName}</span><input value={humanName} maxLength={2_048} disabled={busy} onChange={(event) => setHumanName(event.target.value)} data-work-item-transfer-target-name /></label>
        </>
      ) : (
        <label>
          <span>{TEXT.ownerDigitalWorker}</span>
          <select value={workerId} disabled={busy || workersLoading || workers.length === 0} onChange={(event) => setWorkerId(event.target.value)} data-work-item-transfer-worker>
            {workers.length === 0 && <option value="">{workersLoading ? TEXT.transferWorkerLoading : TEXT.transferNoWorkers}</option>}
            {workers.map((worker) => <option key={worker.id} value={worker.id}>{worker.displayName}</option>)}
          </select>
        </label>
      )}
      <label className="pws-transfer-reason">
        <span>{TEXT.transferReason}</span>
        <input value={reason} maxLength={8_192} placeholder={TEXT.transferReasonPlaceholder} disabled={busy} onChange={(event) => setReason(event.target.value)} data-work-item-transfer-reason />
      </label>
      <div className="pws-transfer-actions">
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onCancel}>{TEXT.cancel}</button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={!canSubmit} data-work-item-transfer-submit>{busy ? TEXT.transferring : TEXT.transferSubmit}</button>
      </div>
      {error && <span className="pws-work-item-control-error" role="alert" data-work-item-transfer-error>{TEXT.transferFailed}: {error}</span>}
    </form>
  )
}

function newTransferRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `work-item-transfer-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
