import { useState } from 'react'

export interface SkillDraft {
  name: string
  description: string
  trigger: string
  tags: string
  body: string
}

export interface SkillCreateModalProps {
  open: boolean
  onClose: () => void
  onSubmit: (draft: SkillDraft) => void
}

export default function SkillCreateModal({ open, onClose, onSubmit }: SkillCreateModalProps): React.JSX.Element | null {
  const [draft, setDraft] = useState<SkillDraft>({
    name: '',
    description: '',
    trigger: '',
    tags: '',
    body: '# 执行步骤\n1. \n\n# 验证\n1. '
  })
  if (!open) return null
  return (
    <div className="modal-backdrop">
      <section className="modal skill-create-modal">
        <header className="modal-header">
          <h2>创建 Skill</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>关闭</button>
        </header>
        <input className="input" value={draft.name} placeholder="名称" onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        <input className="input" value={draft.description} placeholder="描述" onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
        <input className="input" value={draft.trigger} placeholder="触发词" onChange={(event) => setDraft({ ...draft, trigger: event.target.value })} />
        <input className="input" value={draft.tags} placeholder="标签，逗号分隔" onChange={(event) => setDraft({ ...draft, tags: event.target.value })} />
        <textarea className="input skill-create-body" value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} />
        <button className="btn btn-primary" disabled={!draft.name.trim()} onClick={() => onSubmit(draft)}>保存</button>
      </section>
    </div>
  )
}
