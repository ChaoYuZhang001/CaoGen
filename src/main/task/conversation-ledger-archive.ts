import type { TranscriptEntry } from '../../shared/types'
import {
  readTranscriptEntriesStrict,
  restoreTranscriptIfMissing
} from '../transcript'
import {
  mutateTaskSnapshotDatabase,
  readTaskSnapshotDatabase
} from './task-snapshot'
import {
  archiveConversationLedgerEntries,
  countConversationLedgerSessionResiduals,
  purgeConversationLedgerSession,
  selectCurrentConversationLedgerEntries,
  type ConversationLedgerArchiveIdentity,
  type ConversationLedgerArchiveReason,
  type ConversationLedgerArchiveResult
} from './conversation-ledger-store'

export interface ConversationLedgerBackfillReport {
  discovered: number
  archived: number
  events: number
  failures: Array<{ sdkSessionId: string; error: string }>
}

export async function archiveConversationLedgerFromJsonl(
  identity: ConversationLedgerArchiveIdentity,
  options: { rootDir?: string; reason?: ConversationLedgerArchiveReason } = {}
): Promise<ConversationLedgerArchiveResult | null> {
  const entries = readTranscriptEntriesStrict(identity.sdkSessionId)
  if (entries.length === 0) return null
  return mutateTaskSnapshotDatabase(options.rootDir, (db) =>
    archiveConversationLedgerEntries(db, identity, entries, options.reason ?? 'append'))
}

export async function backfillConversationLedgerArchives(
  identities: readonly ConversationLedgerArchiveIdentity[],
  rootDir?: string
): Promise<ConversationLedgerBackfillReport> {
  const latest = new Map<string, ConversationLedgerArchiveIdentity>()
  for (const identity of identities) {
    const sdkSessionId = identity.sdkSessionId.trim()
    if (!sdkSessionId) continue
    const previous = latest.get(sdkSessionId)
    if (!previous || (identity.updatedAt ?? identity.createdAt) >= (previous.updatedAt ?? previous.createdAt)) {
      latest.set(sdkSessionId, { ...identity, sdkSessionId })
    }
  }

  const sources: Array<{ identity: ConversationLedgerArchiveIdentity; entries: TranscriptEntry[] }> = []
  const failures: ConversationLedgerBackfillReport['failures'] = []
  for (const identity of latest.values()) {
    try {
      const entries = readTranscriptEntriesStrict(identity.sdkSessionId)
      if (entries.length > 0) sources.push({ identity, entries })
    } catch (error) {
      failures.push({ sdkSessionId: identity.sdkSessionId, error: safeError(error) })
    }
  }

  if (sources.length > 0) {
    await mutateTaskSnapshotDatabase(rootDir, (db) => {
      for (const source of sources) {
        try {
          archiveConversationLedgerEntries(db, source.identity, source.entries, 'backfill')
        } catch (error) {
          failures.push({ sdkSessionId: source.identity.sdkSessionId, error: safeError(error) })
        }
      }
    })
  }
  return {
    discovered: latest.size,
    archived: sources.length - failures.filter((failure) =>
      sources.some((source) => source.identity.sdkSessionId === failure.sdkSessionId)).length,
    events: sources.reduce((total, source) => total + source.entries.length, 0),
    failures
  }
}

/** Restore only a missing/empty JSONL. A corrupt existing file is surfaced and never overwritten. */
export async function restoreConversationLedgerJsonlFromArchive(
  sdkSessionIdInput: string | undefined,
  rootDir?: string
): Promise<boolean> {
  const sdkSessionId = sdkSessionIdInput?.trim()
  if (!sdkSessionId) return false
  const existing = readTranscriptEntriesStrict(sdkSessionId)
  if (existing.length > 0) return false
  const archived = await readTaskSnapshotDatabase(rootDir, (db) =>
    selectCurrentConversationLedgerEntries(db, sdkSessionId))
  if (archived.length === 0) return false
  restoreTranscriptIfMissing(sdkSessionId, archived)
  return true
}

export async function purgeConversationLedgerArchiveForSession(
  sdkSessionId: string,
  rootDir?: string
): Promise<{ streams: number; generations: number; events: number }> {
  return mutateTaskSnapshotDatabase(rootDir, (db) =>
    purgeConversationLedgerSession(db, sdkSessionId))
}

export async function countConversationLedgerArchiveResidualsForSession(
  sdkSessionId: string,
  rootDir?: string
): Promise<{ streams: number; generations: number; events: number }> {
  return readTaskSnapshotDatabase(rootDir, (db) =>
    countConversationLedgerSessionResiduals(db, sdkSessionId))
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
