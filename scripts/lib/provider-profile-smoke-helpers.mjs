import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export function provider(id, name, baseUrl, models) {
  return {
    id,
    name,
    baseUrl,
    models,
    authMode: 'api-key',
    ready: true,
    engine: 'openai',
    openaiProtocol: 'chat',
    budgetUsd: 0,
    createdAt: 1,
    hasToken: true,
    credentialStorage: 'encrypted'
  }
}

export function verifyOperationJournalFileGuards(journalApi, root, assert) {
  verifyMalformedOperationJournal(journalApi, path.join(root, 'journal-malformed'), assert)
  verifyTamperedOperationJournal(journalApi, path.join(root, 'journal-tampered'), assert)
  if (process.platform !== 'win32') verifySymlinkOperationJournal(journalApi, path.join(root, 'journal-symlink'), assert)
  verifyOversizedOperationJournal(journalApi, path.join(root, 'journal-oversized'), assert)
}

function verifyMalformedOperationJournal(journalApi, userDataDir, assert) {
  const journal = new journalApi.ProviderProfileOperationJournal(userDataDir)
  writePrivateJournal(journal, '{not-json')
  assertJournalCorrupt(() => journal.list(), 'operation journal must reject malformed JSON', assert)
}

function verifyTamperedOperationJournal(journalApi, userDataDir, assert) {
  const journal = new journalApi.ProviderProfileOperationJournal(userDataDir)
  const digest = createHash('sha256').update('provider-profile-journal-fixture').digest('hex')
  journal.prepare({
    operationId: 'journal-integrity-fixture',
    operation: 'import',
    beforeSnapshotDigest: digest,
    desiredSnapshotDigest: digest,
    safetyBackupId: 'journal-safety-backup',
    safetyBackupDigest: digest
  })
  const document = JSON.parse(readFileSync(journal.filePath, 'utf8'))
  document.revision += 1
  writeFileSync(journal.filePath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
  assertJournalCorrupt(() => journal.list(), 'operation journal must reject an integrity mismatch', assert)
}

function verifySymlinkOperationJournal(journalApi, userDataDir, assert) {
  const journal = new journalApi.ProviderProfileOperationJournal(userDataDir)
  mkdirSync(journal.directoryPath, { recursive: true, mode: 0o700 })
  chmodSync(journal.directoryPath, 0o700)
  const target = path.join(userDataDir, 'journal-target.json')
  writeFileSync(target, '{}', { mode: 0o600 })
  symlinkSync(target, journal.filePath)
  assertJournalCorrupt(() => journal.list(), 'operation journal must reject symbolic links', assert)
}

function verifyOversizedOperationJournal(journalApi, userDataDir, assert) {
  const journal = new journalApi.ProviderProfileOperationJournal(userDataDir)
  writePrivateJournal(journal, Buffer.alloc(512 * 1024 + 1, 0x20))
  assertJournalCorrupt(() => journal.list(), 'operation journal must reject files above its bounded read limit', assert)
}

function writePrivateJournal(journal, content) {
  mkdirSync(journal.directoryPath, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(journal.directoryPath, 0o700)
  writeFileSync(journal.filePath, content, { mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(journal.filePath, 0o600)
}

function assertJournalCorrupt(action, message, assert) {
  let error = null
  try { action() } catch (caught) { error = caught }
  assert(error?.code === 'JOURNAL_CORRUPT', message)
}
