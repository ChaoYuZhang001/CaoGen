import type { TaskSnapshotRecord } from '../../shared/types'
import { mergeTaskRunRecords } from './task-run'

export function mergeTaskSnapshots(
  current: TaskSnapshotRecord,
  incoming: TaskSnapshotRecord
): TaskSnapshotRecord {
  const preferred = compareSnapshotFreshness(current, incoming) >= 0 ? current : incoming
  const other = preferred === current ? incoming : current
  const run = preferred.run && other.run
    ? preferred.run.id === other.run.id
      ? mergeTaskRunRecords(preferred.run, other.run)
      : preferred.run
    : preferred.run ?? other.run
  return {
    ...preferred,
    createdAt: current.createdAt,
    updatedAt: Math.max(current.updatedAt, incoming.updatedAt, run?.updatedAt ?? 0),
    ...(run ? { run } : {})
  }
}

function compareSnapshotFreshness(left: TaskSnapshotRecord, right: TaskSnapshotRecord): number {
  const leftCursor = left.execution.cursor?.seq ?? left.execution.lastSeq
  const rightCursor = right.execution.cursor?.seq ?? right.execution.lastSeq
  if (leftCursor !== rightCursor) return leftCursor - rightCursor
  const leftRevision = left.run?.revision ?? 0
  const rightRevision = right.run?.revision ?? 0
  if (leftRevision !== rightRevision) return leftRevision - rightRevision
  return left.updatedAt - right.updatedAt
}
