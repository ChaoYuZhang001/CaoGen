import { Check, CircleMinus, Link2, Save } from 'lucide-react'
import type { MediaAsset, VideoProduction, VideoShot } from '../../../../shared/types'

export type BibleDraft = { name: string; summary: string; appearanceRules: string; voiceRules: string; behaviorRules: string }
export type LockDraft = { label: string; role: 'character' | 'costume' | 'scene' | 'prop' | 'voice'; bibleId: string }

export default function VideoContinuitySection({
  busy,
  production,
  shots,
  selectedAssetAvailable,
  bibleDraft,
  lockDraft,
  onBibleDraftChange,
  onLockDraftChange,
  onSaveBible,
  onDeleteBible,
  onSaveContinuityLock,
  onDeleteContinuityLock,
  onCheckContinuity
}: {
  busy: boolean
  production: VideoProduction
  shots: VideoShot[]
  selectedAssetAvailable: boolean
  bibleDraft: BibleDraft
  lockDraft: LockDraft
  onBibleDraftChange: (value: BibleDraft) => void
  onLockDraftChange: (value: LockDraft) => void
  onSaveBible: () => void
  onDeleteBible: (id: string) => void
  onSaveContinuityLock: () => void
  onDeleteContinuityLock: (id: string) => void
  onCheckContinuity: () => void
}): React.JSX.Element {
  return <details className="video-studio-advanced-section" data-video-advanced-section="continuity">
    <summary><strong>角色与连续性</strong><span>{production.characterBibles.length} Bible · {production.continuityLocks.length} 锁 · 按需展开</span></summary>
    <section className="video-studio-continuity" aria-label="角色与连续性">
      <div className="video-studio-section-title"><strong>角色与连续性</strong><span>{production.characterBibles.length} Bible · {production.continuityLocks.length} 锁</span></div>
      <div className="video-studio-continuity-grid">
        <div>
          <div className="video-studio-subheading"><strong>角色 Bible</strong><span>参考当前选中素材</span></div>
          <input className="input" value={bibleDraft.name} onChange={(event) => onBibleDraftChange({ ...bibleDraft, name: event.target.value })} placeholder="角色名称" aria-label="角色 Bible 名称" />
          <textarea className="input" value={bibleDraft.summary} onChange={(event) => onBibleDraftChange({ ...bibleDraft, summary: event.target.value })} placeholder="角色摘要" aria-label="角色 Bible 摘要" rows={2} />
          <textarea className="input" value={bibleDraft.appearanceRules} onChange={(event) => onBibleDraftChange({ ...bibleDraft, appearanceRules: event.target.value })} placeholder="外观规则，每行一条" aria-label="外观规则" rows={2} />
          <textarea className="input" value={bibleDraft.voiceRules} onChange={(event) => onBibleDraftChange({ ...bibleDraft, voiceRules: event.target.value })} placeholder="声音规则，每行一条" aria-label="声音规则" rows={2} />
          <textarea className="input" value={bibleDraft.behaviorRules} onChange={(event) => onBibleDraftChange({ ...bibleDraft, behaviorRules: event.target.value })} placeholder="行为规则，每行一条" aria-label="行为规则" rows={2} />
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !bibleDraft.name.trim() || !bibleDraft.summary.trim()} onClick={onSaveBible}><Save size={13} />保存 Bible</button>
          <div className="video-studio-bible-list">{production.characterBibles.map((bible) => <div key={bible.id}><strong>{bible.name}</strong><span>v{bible.revision} · {bible.referenceAssetIds.length} 参考</span><button type="button" className="btn btn-ghost btn-icon-sm" onClick={() => onDeleteBible(bible.id)} disabled={busy} aria-label={`删除 ${bible.name}`} title="删除 Bible"><CircleMinus size={13} /></button></div>)}</div>
        </div>
        <div>
          <div className="video-studio-subheading"><strong>连续性锁</strong><span>锁定素材明确版本</span></div>
          <input className="input" value={lockDraft.label} onChange={(event) => onLockDraftChange({ ...lockDraft, label: event.target.value })} placeholder="锁名称" aria-label="连续性锁名称" />
          <select className="input" value={lockDraft.role} onChange={(event) => onLockDraftChange({ ...lockDraft, role: event.target.value as LockDraft['role'] })} aria-label="连续性职责"><option value="character">角色</option><option value="costume">服装</option><option value="scene">场景</option><option value="prop">道具</option><option value="voice">声线</option></select>
          <select className="input" value={lockDraft.bibleId} onChange={(event) => onLockDraftChange({ ...lockDraft, bibleId: event.target.value })} aria-label="关联角色 Bible"><option value="">不关联 Bible</option>{production.characterBibles.map((bible) => <option key={bible.id} value={bible.id}>{bible.name}</option>)}</select>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !selectedAssetAvailable || shots.length === 0} onClick={onSaveContinuityLock}><Link2 size={13} />锁定选中素材到全部镜头</button>
          <div className="video-studio-lock-list">{production.continuityLocks.map((lock) => <div key={lock.id}><strong>{lock.label}</strong><span>{lock.role} · v{lock.assetVersion} · {lock.targetShotIds.length} 镜头</span><button type="button" className="btn btn-ghost btn-icon-sm" onClick={() => onDeleteContinuityLock(lock.id)} disabled={busy} aria-label={`删除 ${lock.label}`} title="删除连续性锁"><CircleMinus size={13} /></button></div>)}</div>
          <div className="video-studio-continuity-result"><button type="button" className="btn btn-primary btn-sm" disabled={busy || production.continuityLocks.length === 0} onClick={onCheckContinuity}><Check size={13} />检查连续性</button><span data-passed={production.latestContinuityCheck?.passed}>{production.latestContinuityCheck ? `${production.latestContinuityCheck.passed ? '通过' : '需修复'} · ${production.latestContinuityCheck.findingCount} 项 · ${production.latestContinuityCheck.digest.slice(7, 19)}` : '尚未检查'}</span></div>
        </div>
      </div>
    </section>
  </details>
}
