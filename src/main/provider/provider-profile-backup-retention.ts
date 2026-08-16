import { readdirSync } from 'node:fs'
import { join } from 'node:path'

interface BackupJournalEntry {
  phase: string
  safetyBackupId: string
  sourceBackupId?: string
}

export interface ProviderProfileBackupRetentionOptions<T> {
  maxCount: number
  maxAgeMs: number
  readBackup: (filePath: string) => T
  backupId: (backup: T) => string
  createdAt: (backup: T) => string
  removeFile: (filePath: string) => void
}

export function protectedProviderProfileBackupIds(
  pendingBackups: Iterable<{ backupId: string }>,
  entries: readonly BackupJournalEntry[]
): Set<string> {
  const protectedIds = new Set<string>()
  for (const pending of pendingBackups) protectedIds.add(pending.backupId)
  for (const entry of entries) {
    if (entry.phase !== 'prepared' && entry.phase !== 'waiting_reconciliation') continue
    protectedIds.add(entry.safetyBackupId)
    if (entry.sourceBackupId) protectedIds.add(entry.sourceBackupId)
  }
  return protectedIds
}

export function pruneProviderProfileBackups<T>(
  root: string,
  protectedIds: ReadonlySet<string>,
  options: ProviderProfileBackupRetentionOptions<T>
): void {
  const valid = readdirSync(root)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      const filePath = join(root, name)
      try {
        const backup = options.readBackup(filePath)
        const createdAt = Date.parse(options.createdAt(backup))
        return Number.isFinite(createdAt)
          ? [{ id: options.backupId(backup), filePath, createdAt }]
          : []
      } catch {
        return []
      }
    })
    .sort((left, right) => right.createdAt - left.createdAt)
  const now = Date.now()
  for (let index = 0; index < valid.length; index += 1) {
    const backup = valid[index]
    if (protectedIds.has(backup.id)) continue
    if (index >= options.maxCount || now - backup.createdAt >= options.maxAgeMs) {
      options.removeFile(backup.filePath)
    }
  }
}
