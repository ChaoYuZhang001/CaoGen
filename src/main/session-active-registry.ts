import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { AgentEvent, AgentEventIdentity, SessionMeta } from '../shared/types'
import type { Engine } from './engine'
import { createEngine } from './engine'
import { touchProject } from './projects'
import { sessionMetaForRecovery } from './session-create-lifecycle'
import {
  bindLegacyUnscopedSessionForRecovery,
  resolveDigitalWorkerSessionScope
} from './digital-worker/session-binding'

export interface ActiveSessionRecoveryPlan {
  restorable: SessionMeta[]
  registryReconciled: boolean
  skippedErrors: string[]
}

export function restoreActiveSessionRegistry(
  snapshotSessionIds: ReadonlySet<string>,
  sessions: Map<string, Engine>,
  snapshotCounts: Map<string, { total: number; sinceSave: number; lastSeq: number; lastEventId?: string }>,
  emit: (sessionId: string, event: AgentEvent, seq: number, identity?: AgentEventIdentity) => void
): boolean {
  const plan = planActiveSessionRecovery(snapshotSessionIds, new Set(sessions.keys()))
  for (const error of plan.skippedErrors) console.error('[caogen] 跳过不可恢复 active session:', error)
  let restored = 0
  let bindingRejected = false
  for (const record of plan.restorable) {
    let meta = restoredSessionMeta(record)
    if (!meta.unassigned && !meta.projectId) meta.projectId = touchProject(meta.sourceCwd ?? meta.cwd).id
    try {
      meta = bindLegacyUnscopedSessionForRecovery(meta)
      resolveDigitalWorkerSessionScope(meta, app.getPath('userData'))
      snapshotCounts.set(meta.id, { total: 0, sinceSave: 0, lastSeq: 0 })
      const session = createEngine(
        meta.engine,
        meta,
        (event, seq, identity) => emit(meta.id, event, seq, identity),
        record.sdkSessionId
      )
      sessions.set(meta.id, session)
      void session.start()
      restored += 1
    } catch (error) {
      bindingRejected = true
      console.error('[caogen] 恢复 active session 失败:', error)
    }
  }
  return restored > 0 || plan.registryReconciled || bindingRejected
}

export function planActiveSessionRecovery(
  snapshotSessionIds: ReadonlySet<string>,
  activeSessionIds: ReadonlySet<string>
): ActiveSessionRecoveryPlan {
  const restorable: SessionMeta[] = []
  const skippedErrors: string[] = []
  let registryReconciled = false
  for (const record of readActiveSessionRegistry()) {
    if (!record.id) continue
    let reconciled: SessionMeta
    try {
      reconciled = sessionMetaForRecovery(record)
    } catch (error) {
      registryReconciled = true
      skippedErrors.push(error instanceof Error ? error.message : String(error))
      continue
    }
    registryReconciled ||= !sameSessionPlacement(record, reconciled)
    if (activeSessionIds.has(record.id) || snapshotSessionIds.has(record.id) || !record.sdkSessionId) continue
    restorable.push(reconciled)
  }
  return { restorable, registryReconciled, skippedErrors }
}

export function writeActiveSessionRegistry(records: SessionMeta[], strict = false): void {
  try {
    writeRegistry(records)
  } catch (error) {
    if (strict) throw error
    console.error('[caogen] 写入 active session registry 失败:', error)
  }
}

export function updateActiveSessionRegistryWorktreeState(
  sessionId: string,
  state: SessionMeta['worktreeState']
): void {
  const records = readActiveSessionRegistry()
  const index = records.findIndex((record) => record.id === sessionId)
  if (index < 0 || records[index].worktreeState === state) return
  records[index] = { ...records[index], worktreeState: state }
  writeActiveSessionRegistry(records)
}

function sameSessionPlacement(left: SessionMeta, right: SessionMeta): boolean {
  return left.cwd === right.cwd &&
    left.isolated === right.isolated &&
    left.sourceCwd === right.sourceCwd &&
    left.repoRoot === right.repoRoot &&
    left.worktreePath === right.worktreePath &&
    left.branch === right.branch &&
    left.baseBranch === right.baseBranch &&
    left.baseSha === right.baseSha &&
    left.worktreeState === right.worktreeState
}

function restoredSessionMeta(record: SessionMeta): SessionMeta {
  return {
    ...record,
    status: 'starting',
    lastError: record.status === 'running' || record.status === 'starting'
      ? '应用上次退出时该任务尚未完成；会话已恢复，请确认当前文件状态后继续。'
      : record.lastError
  }
}

function readActiveSessionRegistry(): SessionMeta[] {
  const file = activeSessionsFile()
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isSessionMetaRecord) as SessionMeta[]
  } catch (error) {
    console.error('[caogen] 读取 active session registry 失败:', error)
    return []
  }
}

function writeRegistry(records: SessionMeta[]): void {
  const file = activeSessionsFile()
  const root = dirname(file)
  mkdirSync(root, { recursive: true })
  const temp = join(root, `.active-sessions.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(temp, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(records, null, 2)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temp, file)
    fsyncDirectory(root)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (existsSync(temp)) unlinkSync(temp)
  }
}

function activeSessionsFile(): string {
  return join(app.getPath('userData'), 'active-sessions.json')
}

function fsyncDirectory(root: string): void {
  if (process.platform === 'win32') return
  const descriptor = openSync(root, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function isSessionMetaRecord(value: unknown): value is SessionMeta {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' &&
    typeof record.title === 'string' &&
    typeof record.cwd === 'string' &&
    typeof record.model === 'string' &&
    typeof record.providerId === 'string' &&
    typeof record.permissionMode === 'string' &&
    typeof record.status === 'string' &&
    typeof record.costUsd === 'number' &&
    typeof record.createdAt === 'number'
}
