import { BrowserWindow, dialog, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { basename } from 'node:path'
import { createProductionProjectAggregateService } from '../project-aggregate'
import { writeDurableFile } from '../task/workflow-ledger-migration-storage'
import { sessionManager } from '../sessionManager'
import { listHistory } from '../history'
import { buildStudioResultExport, buildStudioResultSnapshot } from '../studio-result/studio-result-service'
import {
  buildFailedStudioAuditTimeline,
  buildStudioAuditTimelinePage,
  buildUnboundStudioAuditTimeline
} from '../studio-result/studio-audit-timeline'
import { queryPersistedModelAttempts } from '../task/model-attempt-api'
import type { ModelAttemptRecord } from '../../shared/model-attempt-types'
import type { StudioAuditTimelineQuery } from '../../shared/studio-result-types'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

type StudioResultAction = 'get' | 'audit' | 'export' | 'save'

export async function handleStudioResultIpc(
  event: IpcMainInvokeEvent,
  rawAction: unknown,
  rawSessionId: unknown,
  rawQuery?: unknown
) {
  assertTrustedWorkflowLedgerSender(event)
  const action = normalizeAction(rawAction)
  const sessionId = requiredSessionId(rawSessionId)
  if (action === 'get') return studioResultSnapshotForSession(sessionId)
  if (action === 'audit') return studioAuditTimelineForSession(sessionId, auditQuery(rawQuery))
  const exported = buildStudioResultExport(await studioResultSnapshotForSession(sessionId))
  if (action === 'export') return exported
  return saveStudioResult(event.sender, exported.json, exported.exportDigest, exported.bundle.snapshot)
}

async function studioAuditTimelineForSession(sessionId: string, query: StudioAuditTimelineQuery) {
  const session = sessionManager.list().find((candidate) => candidate.id === sessionId)
  if (!session) throw new Error(`Studio audit timeline Session was not found: ${sessionId}`)
  if (!session.workspaceId) return buildUnboundStudioAuditTimeline(session)
  let aggregate
  try {
    aggregate = await createProductionProjectAggregateService().verifyLiveProject(session.workspaceId)
  } catch {
    return buildFailedStudioAuditTimeline(session, 'PROJECT_INTEGRITY')
  }
  let attempts: ModelAttemptRecord[]
  try {
    attempts = await queryAllProjectModelAttempts(session.workspaceId)
  } catch {
    return buildFailedStudioAuditTimeline(session, 'MODEL_ATTEMPT_INTEGRITY')
  }
  return buildStudioAuditTimelinePage({
    session,
    aggregate,
    attempts,
    sessionCosts: [...listHistory(), ...sessionManager.list()],
    query
  })
}

async function queryAllProjectModelAttempts(projectId: string): Promise<ModelAttemptRecord[]> {
  const attempts: ModelAttemptRecord[] = []
  let cursor: string | undefined
  do {
    const page = await queryPersistedModelAttempts({ projectId, limit: 500, ...(cursor ? { cursor } : {}) })
    attempts.push(...page.attempts)
    cursor = page.nextCursor
  } while (cursor)
  return attempts
}

export async function studioResultSnapshotForSession(sessionId: string) {
  const session = sessionManager.list().find((candidate) => candidate.id === sessionId)
  if (!session) throw new Error(`Studio result Session was not found: ${sessionId}`)
  const aggregate = session.workspaceId
    ? await createProductionProjectAggregateService().verifyLiveProject(session.workspaceId)
    : undefined
  const costs = [...listHistory(), ...sessionManager.list()]
  return buildStudioResultSnapshot(session, aggregate, costs)
}

async function saveStudioResult(
  sender: WebContents,
  json: string,
  exportDigest: string,
  snapshot: Awaited<ReturnType<typeof studioResultSnapshotForSession>>
) {
  const win = BrowserWindow.fromWebContents(sender) ?? BrowserWindow.getAllWindows()[0]
  const title = snapshot.workItems[0]?.title ?? snapshot.goal?.title ?? snapshot.workspace?.name ?? 'delivery'
  const result = await dialog.showSaveDialog(win, {
    title: '导出 CaoGen 结果与交付报告',
    defaultPath: `caogen-result-${safeFileStem(title)}-${new Date(snapshot.generatedAt).toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  await writeDurableFile(result.filePath, Buffer.from(json, 'utf8'), { replace: true })
  return { canceled: false, filePath: result.filePath, exportDigest }
}

function normalizeAction(value: unknown): StudioResultAction {
  if (value === 'get' || value === 'audit' || value === 'export' || value === 'save') return value
  throw new Error('Studio result action is invalid')
}

function auditQuery(value: unknown): StudioAuditTimelineQuery {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Studio audit timeline query is invalid')
  }
  const record = value as Record<string, unknown>
  const unexpected = Object.keys(record).filter((key) => !['runId', 'limit', 'cursor'].includes(key))
  if (unexpected.length > 0) throw new Error('Studio audit timeline query contains unsupported fields')
  if (record.runId !== undefined && typeof record.runId !== 'string') throw new Error('Studio audit timeline Run ID is invalid')
  if (record.limit !== undefined && typeof record.limit !== 'number') throw new Error('Studio audit timeline limit is invalid')
  if (record.cursor !== undefined && typeof record.cursor !== 'string') throw new Error('Studio audit timeline cursor is invalid')
  return {
    ...(record.runId === undefined ? {} : { runId: record.runId }),
    ...(record.limit === undefined ? {} : { limit: record.limit }),
    ...(record.cursor === undefined ? {} : { cursor: record.cursor })
  }
}

function requiredSessionId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error('Studio result Session ID is required')
  }
  return value.trim()
}

function safeFileStem(value: string): string {
  const stem = basename(value).replace(/[^a-z0-9\u4e00-\u9fff._-]+/gi, '-').replace(/^-+|-+$/g, '')
  return stem.slice(0, 64) || 'delivery'
}
