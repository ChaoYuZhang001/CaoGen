import { useState } from 'react'
import type { DigitalWorkerMemoryDraftInput } from '../../../../shared/types'

interface WorkerMemoryFormProps {
  busy: boolean
  onSubmit: (input: DigitalWorkerMemoryDraftInput) => Promise<boolean>
}

export function WorkerMemoryForm({ busy, onSubmit }: WorkerMemoryFormProps): React.JSX.Element {
  const [memoryKind, setMemoryKind] = useState('working-preference')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [reason, setReason] = useState('')
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (await onSubmit({
      memoryKind: memoryKind.trim(),
      title: title.trim(),
      body: body.trim(),
      reason: reason.trim(),
      confidence: 1
    })) {
      setTitle('')
      setBody('')
      setReason('')
    }
  }
  return (
    <form className="dws-memory-form" onSubmit={(event) => void submit(event)} data-dws-form="worker-memory">
      <label className="dws-field"><span>类型</span><input value={memoryKind} onChange={(event) => setMemoryKind(event.target.value)} required maxLength={128} /></label>
      <label className="dws-field"><span>标题</span><input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={512} /></label>
      <label className="dws-field dws-field-wide"><span>记忆内容</span><textarea value={body} onChange={(event) => setBody(event.target.value)} required maxLength={100000} rows={3} /></label>
      <label className="dws-field dws-field-wide"><span>保留原因</span><input value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={2000} /></label>
      <button type="submit" className="dws-button dws-button-primary" disabled={busy || !title.trim() || !body.trim() || !reason.trim()}>{busy ? '提交中...' : '提交审核'}</button>
    </form>
  )
}
