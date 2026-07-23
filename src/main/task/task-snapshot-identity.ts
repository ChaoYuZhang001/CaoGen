import type { TaskRunRecord } from '../../shared/types'

export function hasConsistentTaskSnapshotIdentity(
  record: Record<string, unknown>,
  isSessionMeta: (value: unknown) => boolean,
  isTaskRunRecord: (value: unknown) => boolean
): boolean {
  const meta = objectRecord(record.meta)
  if (!meta || !isSessionMeta(record.meta)) return false
  if (record.id !== record.sessionId || meta.id !== record.sessionId) return false
  if (record.run === undefined) return true
  const run = objectRecord(record.run)
  return Boolean(
    run &&
    isTaskRunRecord(record.run) &&
    run.sessionId === record.sessionId &&
    taskSnapshotTaskIdMatchesRun(record.taskId, record.run as TaskRunRecord)
  )
}

export function taskSnapshotTaskIdMatchesRun(snapshotTaskId: unknown, run: TaskRunRecord): boolean {
  if (typeof snapshotTaskId !== 'string') return false
  if (!run.operation) return run.taskId === snapshotTaskId
  return run.taskId === run.operation.operationId && snapshotTaskId === run.sessionId
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
}
