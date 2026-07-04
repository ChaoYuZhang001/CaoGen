import type {
  AgentEvent,
  CheckpointRestoreMode,
  TranscriptEntry,
  TranscriptRestorePlanView
} from '../shared/types'

export type { CheckpointRestoreMode } from '../shared/types'

export interface CheckpointTurn {
  checkpointId: string
  checkpointSeq: number
  userSeq: number
  userMessageId?: string
  userText?: string
}

export type TranscriptRestorePlan = TranscriptRestorePlanView

export interface CheckpointRestorePlan {
  ok: boolean
  mode: CheckpointRestoreMode
  checkpointId: string
  canRestoreCode: boolean
  canRestoreChat: boolean
  requiresFileRewind: boolean
  chat?: TranscriptRestorePlan
  reason?: string
}

interface UserTurn {
  seq: number
  messageId?: string
  text?: string
}

export function listCheckpointTurns(entries: readonly TranscriptEntry[]): CheckpointTurn[] {
  const ordered = orderedEntries(entries)
  const users: UserTurn[] = []
  const claimedUsers = new Set<string>()
  const turns: CheckpointTurn[] = []
  const seenCheckpoints = new Set<string>()

  for (const entry of ordered) {
    const event = entry.event
    if (event.kind === 'user-message') {
      users.push({ seq: entry.seq, messageId: event.messageId, text: event.text })
      continue
    }

    if (event.kind !== 'checkpoint' || seenCheckpoints.has(event.messageId)) continue
    const user = findCheckpointUser(users, claimedUsers, event.userMessageId)
    if (!user) continue

    claimedUsers.add(userKey(user))
    seenCheckpoints.add(event.messageId)
    turns.push({
      checkpointId: event.messageId,
      checkpointSeq: entry.seq,
      userSeq: user.seq,
      userMessageId: user.messageId,
      userText: user.text
    })
  }

  return turns
}

export function planTranscriptRestore(
  entries: readonly TranscriptEntry[],
  checkpointId: string
): TranscriptRestorePlan {
  const ordered = orderedEntries(entries)
  const id = checkpointId.trim()
  if (!id) {
    return emptyTranscriptPlan(id, '缺少 checkpoint id')
  }

  const turn = listCheckpointTurns(ordered).find((item) => item.checkpointId === id)
  if (!turn) {
    return {
      ...emptyTranscriptPlan(id, '转录里找不到对应 checkpoint'),
      checkpointFound: ordered.some(
        (entry) => entry.event.kind === 'checkpoint' && entry.event.messageId === id
      )
    }
  }

  const kept = ordered.filter((entry) => entry.seq < turn.userSeq)
  const removed = ordered.filter((entry) => entry.seq >= turn.userSeq)
  return {
    ok: true,
    checkpointId: id,
    checkpointFound: true,
    checkpointSeq: turn.checkpointSeq,
    userSeq: turn.userSeq,
    userMessageId: turn.userMessageId,
    userText: turn.userText,
    keepThroughSeq: kept.length > 0 ? kept[kept.length - 1].seq : 0,
    removeFromSeq: turn.userSeq,
    keptEntries: kept.length,
    removedEntries: removed.length,
    removedKinds: [...new Set(removed.map((entry) => entry.event.kind))]
  }
}

export function buildCheckpointRestorePlan(
  entries: readonly TranscriptEntry[],
  checkpointId: string,
  mode: CheckpointRestoreMode
): CheckpointRestorePlan {
  const id = checkpointId.trim()
  const wantsCode = mode === 'code' || mode === 'both'
  const wantsChat = mode === 'chat' || mode === 'both'
  const chat = wantsChat ? planTranscriptRestore(entries, id) : undefined
  const canRestoreCode = wantsCode && id.length > 0
  const canRestoreChat = wantsChat && chat?.ok === true
  const ok = (!wantsCode || canRestoreCode) && (!wantsChat || canRestoreChat)
  const reason = ok ? undefined : !id ? '缺少 checkpoint id' : chat?.reason

  return {
    ok,
    mode,
    checkpointId: id,
    canRestoreCode,
    canRestoreChat,
    requiresFileRewind: wantsCode,
    chat,
    reason
  }
}

export function applyTranscriptRestorePlan(
  entries: readonly TranscriptEntry[],
  plan: TranscriptRestorePlan
): TranscriptEntry[] {
  const removeFromSeq = plan.removeFromSeq
  if (!plan.ok || removeFromSeq === undefined) return [...entries]
  return orderedEntries(entries).filter((entry) => entry.seq < removeFromSeq)
}

function orderedEntries(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  return [...entries]
    .filter((entry) => Number.isFinite(entry.seq) && entry.event)
    .sort((a, b) => a.seq - b.seq)
}

function findCheckpointUser(
  users: readonly UserTurn[],
  claimedUsers: ReadonlySet<string>,
  userMessageId?: string
): UserTurn | undefined {
  if (userMessageId) {
    const byId = users.find((user) => user.messageId === userMessageId)
    if (byId) return byId
  }

  for (let i = users.length - 1; i >= 0; i--) {
    const user = users[i]
    if (!claimedUsers.has(userKey(user))) return user
  }
  return undefined
}

function userKey(user: UserTurn): string {
  return user.messageId ? `id:${user.messageId}` : `seq:${user.seq}`
}

function emptyTranscriptPlan(checkpointId: string, reason: string): TranscriptRestorePlan {
  return {
    ok: false,
    checkpointId,
    checkpointFound: false,
    keepThroughSeq: 0,
    keptEntries: 0,
    removedEntries: 0,
    removedKinds: [],
    reason
  }
}
