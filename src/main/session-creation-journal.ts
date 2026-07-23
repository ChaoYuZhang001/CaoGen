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
import { join } from 'node:path'
import { app } from 'electron'
import type { CreateSessionOptions, SessionMeta } from '../shared/types'
import type { SessionCreationDraft } from './session-create-lifecycle'

interface PendingSessionCreationRecord {
  schemaVersion: 1
  sessionId: string
  draft: SessionCreationDraft
  createdAt: number
  updatedAt: number
}

export function savePendingSessionCreation(draft: SessionCreationDraft): void {
  const records = readJournal()
  const now = Date.now()
  const index = records.findIndex((record) => record.sessionId === draft.baseMeta.id)
  const record: PendingSessionCreationRecord = {
    schemaVersion: 1,
    sessionId: draft.baseMeta.id,
    draft: cloneDraft(draft),
    createdAt: index >= 0 ? records[index].createdAt : now,
    updatedAt: now
  }
  if (index >= 0) records[index] = record
  else records.push(record)
  writeJournal(records)
}

export function deletePendingSessionCreation(sessionId: string): void {
  const records = readJournal()
  const next = records.filter((record) => record.sessionId !== sessionId)
  if (next.length === records.length) return
  writeJournal(next)
}

export function listPendingSessionCreations(): SessionCreationDraft[] {
  return readJournal().map((record) => cloneDraft(record.draft))
}

function journalFile(): string {
  return join(app.getPath('userData'), 'session-creation-journal.json')
}

function readJournal(): PendingSessionCreationRecord[] {
  const file = journalFile()
  if (!existsSync(file)) return []
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
  if (!Array.isArray(parsed) || !parsed.every(isPendingRecord)) {
    throw new Error('session creation journal 已损坏，拒绝继续 managed session lifecycle')
  }
  const seen = new Set<string>()
  for (const record of parsed) {
    if (seen.has(record.sessionId)) throw new Error(`session creation journal 含重复 id: ${record.sessionId}`)
    seen.add(record.sessionId)
  }
  return parsed.map(cloneRecord)
}

function writeJournal(records: PendingSessionCreationRecord[]): void {
  const file = journalFile()
  const root = app.getPath('userData')
  mkdirSync(root, { recursive: true })
  const temp = join(root, `.session-creation-journal.${process.pid}.${randomUUID()}.tmp`)
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

function fsyncDirectory(root: string): void {
  if (process.platform === 'win32') return
  const descriptor = openSync(root, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function isPendingRecord(value: unknown): value is PendingSessionCreationRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<PendingSessionCreationRecord>
  return record.schemaVersion === 1 &&
    typeof record.sessionId === 'string' &&
    isDraft(record.draft) &&
    record.draft.baseMeta.id === record.sessionId &&
    typeof record.createdAt === 'number' &&
    typeof record.updatedAt === 'number'
}

function isDraft(value: unknown): value is SessionCreationDraft {
  if (!value || typeof value !== 'object') return false
  const draft = value as { opts?: Partial<CreateSessionOptions>; baseMeta?: Partial<SessionMeta> }
  return typeof draft.opts?.cwd === 'string' &&
    typeof draft.baseMeta?.id === 'string' &&
    typeof draft.baseMeta.title === 'string' &&
    typeof draft.baseMeta.cwd === 'string' &&
    typeof draft.baseMeta.providerId === 'string' &&
    typeof draft.baseMeta.model === 'string' &&
    typeof draft.baseMeta.engine === 'string' &&
    typeof draft.baseMeta.permissionMode === 'string' &&
    typeof draft.baseMeta.status === 'string' &&
    typeof draft.baseMeta.costUsd === 'number' &&
    typeof draft.baseMeta.contextTokens === 'number' &&
    typeof draft.baseMeta.createdAt === 'number' &&
    isUsage(draft.baseMeta.usage)
}

function cloneRecord(record: PendingSessionCreationRecord): PendingSessionCreationRecord {
  return { ...record, draft: cloneDraft(record.draft) }
}

function cloneDraft(draft: SessionCreationDraft): SessionCreationDraft {
  const { initialPrompt: _initialPrompt, ...opts } = draft.opts
  return {
    opts,
    baseMeta: { ...draft.baseMeta, usage: { ...draft.baseMeta.usage } }
  }
}

function isUsage(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const usage = value as Record<string, unknown>
  return typeof usage.input === 'number' &&
    typeof usage.output === 'number' &&
    typeof usage.cacheRead === 'number' &&
    typeof usage.cacheCreation === 'number'
}
