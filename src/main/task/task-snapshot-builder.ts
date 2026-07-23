import type {
  AgentEvent,
  SessionMeta,
  SessionStatus,
  TaskDagExecutionView,
  TaskDagRuntimeSnapshot,
  TaskSnapshotExecutionPosition,
  TaskSnapshotReason,
  TaskSnapshotRecord,
  TaskSnapshotReplayCandidate,
  TaskRunRecord,
  TaskSnapshotSubtaskState,
  TaskSnapshotWorktreeInfo,
  TranscriptEntry
} from '../../shared/types'
import {
  isSubtaskState,
  isTaskDagExecutionView,
  isTaskDagRuntimeSnapshot,
  isTranscriptEntry
} from './task-snapshot-validation'

export interface BuildTaskSnapshotInput {
  meta: SessionMeta
  transcript: TranscriptEntry[]
  lastSeq: number
  lastEventId?: string
  lastEventKind?: AgentEvent['kind']
  eventCount: number
  reason: TaskSnapshotReason
  run?: TaskRunRecord
  subtasks?: TaskSnapshotSubtaskState[]
  dagExecutions?: TaskDagExecutionView[]
  dagRuntimes?: TaskDagRuntimeSnapshot[]
  now?: number
}

export function buildTaskSnapshot(input: BuildTaskSnapshotInput): TaskSnapshotRecord {
  const now = input.now ?? Date.now()
  const transcript = input.transcript.filter(isTranscriptEntry)
  const ids = latestTranscriptIds(transcript)
  const execution: TaskSnapshotExecutionPosition = {
    status: input.meta.status,
    lastSeq: input.lastSeq,
    cursor: { seq: input.lastSeq, eventId: input.lastEventId },
    lastEventId: input.lastEventId,
    lastEventKind: input.lastEventKind,
    lastEventAt: now,
    sdkSessionId: input.meta.sdkSessionId,
    resumeSessionAt: input.meta.resumeSessionAt,
    lastCheckpointMessageId: ids.lastCheckpointMessageId,
    lastUserMessageId: ids.lastUserMessageId
  }
  const worktree = worktreeFromMeta(input.meta)
  const projectPath = input.meta.sourceCwd ?? input.meta.cwd
  const replayCandidate = replayCandidateFromTranscript(transcript, input.meta.status, now)
  return {
    id: input.meta.id,
    taskId: input.meta.childTaskId ?? input.meta.id,
    sessionId: input.meta.id,
    title: input.meta.title,
    projectPath,
    engine: input.meta.engine,
    model: input.meta.model,
    providerId: input.meta.providerId,
    createdAt: input.meta.createdAt,
    updatedAt: now,
    eventCount: Math.max(0, Math.floor(input.eventCount)),
    reason: input.reason,
    meta: { ...input.meta },
    execution,
    ...(input.run ? { run: { ...input.run } } : {}),
    ...(replayCandidate ? { replayCandidate } : {}),
    ...(worktree ? { worktree } : {}),
    transcript,
    subtasks: (input.subtasks ?? []).filter(isSubtaskState),
    dagExecutions: (input.dagExecutions ?? []).filter(isTaskDagExecutionView),
    dagRuntimes: (input.dagRuntimes ?? []).filter(isTaskDagRuntimeSnapshot)
  }
}

function worktreeFromMeta(meta: SessionMeta): TaskSnapshotWorktreeInfo | undefined {
  const worktree: TaskSnapshotWorktreeInfo = {
    isolated: meta.isolated,
    sourceCwd: meta.sourceCwd,
    repoRoot: meta.repoRoot,
    worktreePath: meta.worktreePath,
    branch: meta.branch,
    baseBranch: meta.baseBranch,
    baseSha: meta.baseSha,
    state: meta.worktreeState
  }
  return Object.values(worktree).some((value) => value !== undefined) ? worktree : undefined
}

function latestTranscriptIds(transcript: TranscriptEntry[]): {
  lastCheckpointMessageId?: string
  lastUserMessageId?: string
} {
  let lastCheckpointMessageId: string | undefined
  let lastUserMessageId: string | undefined
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const event = transcript[index].event
    if (!lastCheckpointMessageId && event.kind === 'checkpoint') {
      lastCheckpointMessageId = event.messageId
    }
    if (!lastUserMessageId && event.kind === 'user-message') {
      lastUserMessageId = event.messageId
    }
    if (lastCheckpointMessageId && lastUserMessageId) break
  }
  return { lastCheckpointMessageId, lastUserMessageId }
}

function replayCandidateFromTranscript(
  transcript: TranscriptEntry[],
  status: SessionStatus,
  now: number
): TaskSnapshotReplayCandidate | undefined {
  if (status !== 'starting' && status !== 'running' && status !== 'error') return undefined
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index]
    const event = entry.event
    if (event.kind !== 'user-message') continue
    const text = event.text.trim()
    const messageId = event.messageId?.trim()
    if (!text || !messageId) return undefined
    const completedAfterUser = transcript
      .slice(index + 1)
      .some((next) => next.event.kind === 'turn-result' && next.event.isError === false)
    if (completedAfterUser) return undefined
    return {
      messageId,
      text,
      seq: entry.seq,
      capturedAt: now,
      reason: 'running-user-message'
    }
  }
  return undefined
}
