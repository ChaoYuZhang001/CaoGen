import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-conversation-ledger-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
const sdkSessionId = 'sdk-conversation-ledger'

try {
  compileSources()
  installElectronStub()

  const transcript = await importCompiled('transcript.js')
  const archive = await importCompiled('conversation-ledger-archive.js')
  const store = await importCompiled('conversation-ledger-store.js')
  const snapshots = await importCompiled('task-snapshot.js')
  const replay = await importCompiled('conversation-ledger-replay.js')

  const writer = new transcript.TranscriptWriter()
  writer.next({ kind: 'init', sdkSessionId })
  writer.next({
    kind: 'user-message',
    messageId: 'message-1',
    text: 'Inspect the persisted workspace state.',
    attachments: [{
      id: 'a'.repeat(64),
      hash: 'a'.repeat(64),
      mime: 'image/png',
      bytes: 128
    }]
  })
  writer.next({ kind: 'checkpoint', messageId: 'checkpoint-1', userMessageId: 'message-1' })
  writer.next({
    kind: 'assistant-message',
    blocks: [
      { type: 'text', text: 'I inspected the durable state.' },
      { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'STATUS.md' } }
    ]
  })
  writer.next({ kind: 'tool-result', toolUseId: 'tool-1', content: 'status evidence', isError: false })
  writer.next({ kind: 'turn-result', subtype: 'success', isError: false })

  const identity = {
    sdkSessionId,
    currentSessionId: 'session-openai-source',
    projectId: 'project-ledger',
    workspaceId: 'workspace-ledger',
    goalId: 'goal-ledger',
    workItemId: 'work-item-ledger',
    sourceCwd: repoRoot,
    providerId: 'provider-openai',
    model: 'gpt-fixture',
    engine: 'openai',
    createdAt: 100,
    updatedAt: 200
  }

  const initial = await archive.archiveConversationLedgerFromJsonl(identity, {
    rootDir: userData,
    reason: 'initial'
  })
  assert(initial, 'initial archive result is required')
  assertEqual(initial.generation, 1, 'initial generation')
  assertEqual(initial.rewritten, false, 'initial archive must not be a rewrite')

  writer.next({ kind: 'user-message', messageId: 'message-2', text: 'Prepare a second answer.' })
  writer.next({ kind: 'checkpoint', messageId: 'checkpoint-2', userMessageId: 'message-2' })
  writer.next({ kind: 'assistant-message', blocks: [{ type: 'text', text: 'Second answer.' }] })
  writer.next({ kind: 'turn-result', subtype: 'success', isError: false })

  const appended = await archive.archiveConversationLedgerFromJsonl(
    { ...identity, updatedAt: 300 },
    { rootDir: userData, reason: 'append' }
  )
  assert(appended, 'append archive result is required')
  assertEqual(appended.generation, 1, 'append must stay in the current generation')
  assertEqual(appended.appended, 4, 'append must persist only the new suffix')
  assertEqual(appended.rewritten, false, 'append must not rewrite history')

  const beforeRewrite = writer.readAll()
  const eventIds = beforeRewrite.map((entry) => entry.eventId)
  assert(eventIds.every(Boolean), 'every durable event must have an event id')
  assertEqual(new Set(eventIds).size, eventIds.length, 'event ids must be unique')
  assert(beforeRewrite.every((entry) => Number.isFinite(entry.occurredAt)), 'events need stable timestamps')

  const portable = replay.buildPortableConversationReplay(beforeRewrite)
  assert(portable, 'portable replay must be generated')
  assert(portable.text.includes('[assistant tool_call id=tool-1 name=read_file]'), 'tool call must be replayed')
  assert(portable.text.includes('[tool_result id=tool-1 error=false content_omitted=true'), 'tool result must be paired in replay')
  assert(
    portable.text.indexOf('[assistant tool_call id=tool-1') < portable.text.indexOf('[tool_result id=tool-1'),
    'tool result must follow its matching call'
  )
  assert(
    portable.text.includes('Do not repeat side effects solely because they appear below.'),
    'portable replay must explicitly forbid side-effect replay'
  )

  const confirmedTurnWriter = new transcript.TranscriptWriter()
  confirmedTurnWriter.next({
    kind: 'user-message',
    messageId: 'confirmed-turn',
    text: 'Create the release document.'
  })
  confirmedTurnWriter.next({
    kind: 'assistant-message',
    blocks: [{
      type: 'tool_use',
      id: 'create-document-original',
      name: 'create_document',
      input: { path: 'release.docx', title: 'Release evidence' }
    }]
  })
  confirmedTurnWriter.next({
    kind: 'tool-result',
    toolUseId: 'create-document-original',
    content: 'Created release.docx',
    isError: false,
    effectStatus: 'confirmed'
  })
  confirmedTurnWriter.next({
    kind: 'assistant-message',
    blocks: [{
      type: 'tool_use',
      id: 'failed-document',
      name: 'create_document',
      input: { path: 'failed.docx' }
    }]
  })
  confirmedTurnWriter.next({
    kind: 'tool-result',
    toolUseId: 'failed-document',
    content: 'failed',
    isError: true,
    effectStatus: 'waiting_reconciliation'
  })
  const confirmedIndex = replay.buildConfirmedToolReplayIndex(
    confirmedTurnWriter.readAll(),
    'confirmed-turn',
    new Map([['create-document-original', 'release-document-target']])
  )
  const confirmedResult = replay.findConfirmedToolReplay(
    confirmedIndex,
    'create_document',
    'release-document-target'
  )
  assert(confirmedResult, 'confirmed result must bind to its durable effect target')
  assertEqual(
    confirmedResult.resultDigest.length,
    64,
    'confirmed replay must expose only a fixed-size result digest'
  )
  assertEqual(
    replay.findConfirmedToolReplay(confirmedIndex, 'create_document', 'changed-document-target'),
    undefined,
    'changed tool input must not reuse a prior side effect'
  )
  assertEqual(
    replay.findConfirmedToolReplay(confirmedIndex, 'create_document', 'failed-document-target'),
    undefined,
    'failed or unresolved effects must never be replayed as success'
  )
  const immediateIndex = replay.recordConfirmedToolReplay(new Map(), {
    toolUseId: 'create-document-immediate',
    toolName: 'create_document',
    targetDigest: 'immediate-document-target',
    resultContent: 'Created immediate.docx'
  })
  const immediateResult = replay.findConfirmedToolReplay(
    immediateIndex,
    'create_document',
    'immediate-document-target'
  )
  assert(immediateResult, 'confirmed side effects must enter the active turn index immediately')
  assertEqual(immediateResult.resultDigest.length, 64, 'immediate replay result must expose a SHA-256 digest')
  confirmedTurnWriter.next({ kind: 'user-message', messageId: 'next-turn', text: 'Create another document.' })
  assertEqual(
    replay.buildConfirmedToolReplayIndex(confirmedTurnWriter.readAll(), 'next-turn').size,
    0,
    'confirmed replay must be isolated to the current user turn'
  )

  const restored = writer.restore('checkpoint-2', {
    kind: 'checkpoint-restore',
    messageId: 'checkpoint-2',
    mode: 'chat',
    filesChanged: []
  })
  assert(restored.plan.ok, restored.plan.reason ?? 'checkpoint restore should be valid')
  assert(
    restored.entries.some((entry) => entry.event.kind === 'checkpoint-restore'),
    'rewrite must retain a checkpoint-restore audit event'
  )
  assert(
    !restored.entries.some((entry) => entry.event.kind === 'user-message' && entry.event.messageId === 'message-2'),
    'checkpoint rewrite must remove the restored turn'
  )

  const rewritten = await archive.archiveConversationLedgerFromJsonl(
    { ...identity, updatedAt: 400 },
    { rootDir: userData, reason: 'checkpoint_restore' }
  )
  assert(rewritten, 'rewrite archive result is required')
  assertEqual(rewritten.generation, 2, 'checkpoint restore must create a new generation')
  assertEqual(rewritten.rewritten, true, 'checkpoint restore must be recorded as a rewrite')

  const verified = await snapshots.readTaskSnapshotDatabase(userData, (db) =>
    store.verifyConversationLedgerArchive(db))
  assertEqual(verified.valid, true, 'archive verification')
  assertEqual(verified.streams, 1, 'archive stream count')
  assertEqual(verified.generations, 2, 'old generation must be retained')
  assert(verified.events > verified.currentEvents, 'old generation events must remain queryable')

  const generationState = await snapshots.readTaskSnapshotDatabase(userData, (db) => ({
    generations: rows(db, `
      SELECT generation, entry_count, supersedes_generation, rewrite_reason
      FROM conversation_ledger_generations
      WHERE sdk_session_id = ?
      ORDER BY generation
    `, [sdkSessionId]),
    current: rows(db, `
      SELECT current_generation, origin_session_id, current_session_id,
             project_id, workspace_id, goal_id, work_item_id
      FROM conversation_ledger_streams
      WHERE sdk_session_id = ?
    `, [sdkSessionId])
  }))
  assertEqual(generationState.generations.length, 2, 'generation row count')
  assertEqual(generationState.generations[1].supersedes_generation, 1, 'rewrite ancestry')
  assertEqual(generationState.generations[1].rewrite_reason, 'checkpoint_restore', 'rewrite reason')
  assertEqual(generationState.current[0].current_generation, 2, 'current generation pointer')
  assertEqual(generationState.current[0].goal_id, 'goal-ledger', 'goal ownership')
  assertEqual(generationState.current[0].work_item_id, 'work-item-ledger', 'work item ownership')

  const appendFailureSdkSessionId = 'sdk-ledger-append-failure'
  const appendFailureWriter = new transcript.TranscriptWriter()
  appendFailureWriter.next({ kind: 'init', sdkSessionId: appendFailureSdkSessionId })
  const appendFailurePath = transcript.transcriptFile(appendFailureSdkSessionId)
  unlinkSync(appendFailurePath)
  mkdirSync(appendFailurePath)
  expectThrow(
    () => appendFailureWriter.next({
      kind: 'user-message',
      messageId: 'message-write-failure',
      text: 'This event must not be reported as durable.'
    }),
    '写入转录失败',
    'JSONL append failure must propagate to the engine caller'
  )
  rmSync(appendFailurePath, { recursive: true, force: true })

  const appendFsyncSdkSessionId = 'sdk-ledger-append-fsync-failure'
  const appendFsyncHarness = createDurabilityHarness(transcript)
  const appendFsyncWriter = new transcript.TranscriptWriter(
    undefined,
    0,
    undefined,
    appendFsyncHarness.operations
  )
  appendFsyncWriter.next({ kind: 'init', sdkSessionId: appendFsyncSdkSessionId })
  const appendFsyncPath = transcript.transcriptFile(appendFsyncSdkSessionId)
  appendFsyncHarness.arm('transcript append file fsync', (event) =>
    event.operation === 'fsync' && event.kind === 'file' && event.target === appendFsyncPath)
  expectThrow(
    () => appendFsyncWriter.next({
      kind: 'user-message',
      messageId: 'message-append-fsync-failure',
      text: 'The caller must not observe success before the transcript fsync barrier.'
    }),
    '写入转录失败',
    'transcript fsync failure must propagate after the append write'
  )
  const appendFsyncEntries = transcript.readTranscriptEntriesStrict(appendFsyncSdkSessionId)
  assertEqual(
    transcript.verifyConversationLedgerEntries(appendFsyncEntries).valid,
    true,
    'fsync-faulted transcript must remain structurally valid while visible'
  )
  assertUniqueEventIds(appendFsyncWriter.readAll(), 'fsync-faulted writer must not expose duplicate buffered entries')
  const appendFsyncBytes = readFileSync(appendFsyncPath)
  expectThrow(
    () => appendFsyncWriter.next({
      kind: 'user-message',
      messageId: 'message-after-append-fsync-failure',
      text: 'A quarantined writer must not advance an uncertain hash chain.'
    }),
    '此前写入失败',
    'a transcript fsync failure must quarantine later appends in the same writer'
  )
  assertBufferEqual(
    readFileSync(appendFsyncPath),
    appendFsyncBytes,
    'quarantined append must not mutate the transcript again'
  )
  assertFaultFollowedByClose(appendFsyncHarness, 'transcript fsync failure must close its file descriptor')
  const appendFsyncResumed = new transcript.TranscriptWriter(appendFsyncSdkSessionId)
  const appendFsyncResumeEntry = appendFsyncResumed.nextEntry({ kind: 'status', status: 'running' })
  assert(
    appendFsyncResumeEntry.seq > Math.max(...appendFsyncEntries.map((entry) => entry.seq)),
    'restart after transcript fsync uncertainty must advance past every visible durable entry'
  )
  assertUniqueEventIds(
    transcript.readTranscriptEntriesStrict(appendFsyncSdkSessionId),
    'restart after transcript fsync uncertainty must retain unique event ids'
  )

  const receiptFsyncSdkSessionId = 'sdk-ledger-receipt-fsync-failure'
  const receiptFsyncHarness = createDurabilityHarness(transcript)
  const receiptFsyncWriter = new transcript.TranscriptWriter(
    undefined,
    0,
    undefined,
    receiptFsyncHarness.operations
  )
  receiptFsyncWriter.next({ kind: 'init', sdkSessionId: receiptFsyncSdkSessionId })
  const receiptFsyncPath = transcript.eventReceiptsFile(receiptFsyncSdkSessionId)
  receiptFsyncHarness.arm('event receipt file fsync', (event) =>
    event.operation === 'fsync' && event.kind === 'file' && event.target === receiptFsyncPath)
  const receiptProjectionErrors = []
  const originalConsoleError = console.error
  let receiptFsyncSeq
  try {
    console.error = (...values) => receiptProjectionErrors.push(values.map(String).join(' '))
    receiptFsyncSeq = receiptFsyncWriter.next({
      kind: 'user-message',
      messageId: 'message-receipt-fsync-failure',
      text: 'The Conversation Ledger remains canonical if its receipt fsync fails.'
    })
  } finally {
    console.error = originalConsoleError
  }
  assert(
    receiptProjectionErrors.some((message) =>
      message.includes('写入事件回执投影失败') && message.includes('injected event receipt file fsync failure')),
    'receipt fsync failure must be recorded as a projection failure'
  )
  const receiptFsyncEntries = transcript.readTranscriptEntriesStrict(receiptFsyncSdkSessionId)
  assertEqual(
    transcript.verifyConversationLedgerEntries(receiptFsyncEntries).valid,
    true,
    'receipt fsync failure must not corrupt the canonical transcript'
  )
  const receiptFsyncEvent = receiptFsyncEntries.find((entry) =>
    entry.event.kind === 'user-message' && entry.event.messageId === 'message-receipt-fsync-failure')
  assert(receiptFsyncEvent, 'the canonical transcript write must precede its receipt barrier')
  assertEqual(
    receiptFsyncEvent.seq,
    receiptFsyncSeq,
    'receipt projection failure must not report a committed canonical event as uncommitted'
  )
  assertUniqueEventIds(
    transcript.readEventReceipts(receiptFsyncSdkSessionId),
    'receipt fsync uncertainty must never expose duplicate receipt identities'
  )
  assertFaultFollowedByClose(receiptFsyncHarness, 'receipt fsync failure must close its file descriptor')
  const receiptFsyncResumed = new transcript.TranscriptWriter(receiptFsyncSdkSessionId)
  const receiptFsyncResumeEntry = receiptFsyncResumed.nextEntry({ kind: 'status', status: 'running' })
  assert(
    receiptFsyncResumeEntry.seq > receiptFsyncEvent.seq,
    'restart cursor must advance from the canonical transcript even if receipt durability was uncertain'
  )

  if (process.platform !== 'win32') {
    const newFileDirFsyncSdkSessionId = 'sdk-ledger-new-file-directory-fsync-failure'
    const transcriptsDirectory = path.join(userData, 'transcripts')
    mkdirSync(transcriptsDirectory, { recursive: true })
    mkdirSync(path.join(userData, 'event-receipts'), { recursive: true })
    const newFileDirFsyncHarness = createDurabilityHarness(transcript)
    const newFileDirFsyncWriter = new transcript.TranscriptWriter(
      undefined,
      0,
      undefined,
      newFileDirFsyncHarness.operations
    )
    newFileDirFsyncHarness.arm('new transcript directory fsync', (event) =>
      event.operation === 'fsync' && event.kind === 'directory' && event.target === transcriptsDirectory)
    expectThrow(
      () => newFileDirFsyncWriter.next({ kind: 'init', sdkSessionId: newFileDirFsyncSdkSessionId }),
      '写入转录失败',
      'new transcript publication must not return success before directory fsync'
    )
    const newFileDirFsyncEntries = transcript.readTranscriptEntriesStrict(newFileDirFsyncSdkSessionId)
    assertEqual(newFileDirFsyncEntries.length, 1, 'directory-fsync fault must leave one complete visible init entry')
    assertEqual(
      transcript.verifyConversationLedgerEntries(newFileDirFsyncEntries).valid,
      true,
      'directory-fsync fault must leave a complete old-or-new ledger'
    )
    assertFaultFollowedByClose(
      newFileDirFsyncHarness,
      'directory fsync failure must close its directory descriptor'
    )
  }

  const candidateFsyncSdkSessionId = 'sdk-ledger-candidate-fsync-failure'
  const candidateFsyncHarness = createDurabilityHarness(transcript)
  const candidateFsyncWriter = new transcript.TranscriptWriter(
    undefined,
    0,
    undefined,
    candidateFsyncHarness.operations
  )
  seedCheckpointRestoreFixture(candidateFsyncWriter, candidateFsyncSdkSessionId, 'candidate-fsync')
  const candidateFsyncTarget = transcript.transcriptFile(candidateFsyncSdkSessionId)
  const beforeCandidateFsync = readFileSync(candidateFsyncTarget)
  const receiptsBeforeCandidateFsync = transcript.readEventReceipts(candidateFsyncSdkSessionId).length
  candidateFsyncHarness.arm('replacement candidate file fsync', (event) =>
    event.operation === 'fsync' &&
    event.kind === 'file' &&
    event.target.startsWith(`${candidateFsyncTarget}.`) &&
    event.target.endsWith('.tmp'))
  expectThrow(
    () => candidateFsyncWriter.restore('checkpoint-candidate-fsync', checkpointRestoreEvent('checkpoint-candidate-fsync')),
    '替换转录失败',
    'replacement candidate fsync failure must propagate before rename'
  )
  assertBufferEqual(
    readFileSync(candidateFsyncTarget),
    beforeCandidateFsync,
    'candidate fsync failure must preserve the original target bytes'
  )
  assertEqual(
    transcript.readEventReceipts(candidateFsyncSdkSessionId).length,
    receiptsBeforeCandidateFsync,
    'candidate fsync failure must not commit a checkpoint-restore receipt'
  )
  assertFaultFollowedByClose(candidateFsyncHarness, 'candidate fsync failure must close the temporary file')
  assert(
    !candidateFsyncHarness.events.some((event) => event.operation === 'rename' && event.target === candidateFsyncTarget),
    'candidate fsync failure must prevent rename publication'
  )
  assertNoLedgerTemps(candidateFsyncSdkSessionId, 'candidate fsync failure must clean its temporary file')

  const renameFailureSdkSessionId = 'sdk-ledger-rename-failure'
  const renameFailureHarness = createDurabilityHarness(transcript)
  const renameFailureWriter = new transcript.TranscriptWriter(
    undefined,
    0,
    undefined,
    renameFailureHarness.operations
  )
  renameFailureWriter.next({ kind: 'init', sdkSessionId: renameFailureSdkSessionId })
  renameFailureWriter.next({
    kind: 'user-message',
    messageId: 'message-rename-anchor',
    text: 'Anchor turn.'
  })
  renameFailureWriter.next({
    kind: 'checkpoint',
    messageId: 'checkpoint-rename-failure',
    userMessageId: 'message-rename-anchor'
  })
  renameFailureWriter.next({
    kind: 'user-message',
    messageId: 'message-must-survive-rename-failure',
    text: 'The original ledger must survive a failed atomic replacement.'
  })
  const beforeRenameFailure = renameFailureWriter.readAll().map((entry) => entry.eventId).join(',')
  const receiptsBeforeRenameFailure = transcript.readEventReceipts(renameFailureSdkSessionId).length
  const renameFailureTarget = transcript.transcriptFile(renameFailureSdkSessionId)
  renameFailureHarness.arm('replacement rename', (event) =>
    event.operation === 'rename' && event.target === renameFailureTarget)
  expectThrow(
    () => renameFailureWriter.restore('checkpoint-rename-failure', {
      kind: 'checkpoint-restore',
      messageId: 'checkpoint-rename-failure',
      mode: 'chat',
      filesChanged: []
    }),
    '替换转录失败',
    'checkpoint rename failure must propagate instead of returning applied'
  )
  assertEqual(
    renameFailureWriter.readAll().map((entry) => entry.eventId).join(','),
    beforeRenameFailure,
    'failed atomic replacement must preserve the original Conversation Ledger'
  )
  assertEqual(
    transcript.readEventReceipts(renameFailureSdkSessionId).length,
    receiptsBeforeRenameFailure,
    'failed atomic replacement must not commit a checkpoint-restore receipt'
  )
  assertNoLedgerTemps(renameFailureSdkSessionId, 'rename failure must clean its temporary file')

  if (process.platform !== 'win32') {
    const directoryFsyncSdkSessionId = 'sdk-ledger-replace-directory-fsync-failure'
    const directoryFsyncHarness = createDurabilityHarness(transcript)
    const directoryFsyncWriter = new transcript.TranscriptWriter(
      undefined,
      0,
      undefined,
      directoryFsyncHarness.operations
    )
    seedCheckpointRestoreFixture(directoryFsyncWriter, directoryFsyncSdkSessionId, 'directory-fsync')
    const directoryFsyncTarget = transcript.transcriptFile(directoryFsyncSdkSessionId)
    const directoryFsyncOriginalIds = transcript.readTranscriptEntriesStrict(directoryFsyncSdkSessionId)
      .map((entry) => entry.eventId)
      .join(',')
    const receiptsBeforeDirectoryFsync = transcript.readEventReceipts(directoryFsyncSdkSessionId).length
    directoryFsyncHarness.arm('replacement directory fsync', (event) =>
      event.operation === 'fsync' &&
      event.kind === 'directory' &&
      event.target === path.dirname(directoryFsyncTarget))
    expectThrow(
      () => directoryFsyncWriter.restore(
        'checkpoint-directory-fsync',
        checkpointRestoreEvent('checkpoint-directory-fsync')
      ),
      '替换转录失败',
      'post-rename directory fsync failure must propagate instead of returning applied'
    )
    const directoryFsyncEntries = transcript.readTranscriptEntriesStrict(directoryFsyncSdkSessionId)
    const directoryFsyncIds = directoryFsyncEntries.map((entry) => entry.eventId).join(',')
    const preservedOld = directoryFsyncIds === directoryFsyncOriginalIds
    const publishedNew = directoryFsyncEntries.some((entry) => entry.event.kind === 'checkpoint-restore') &&
      !directoryFsyncEntries.some((entry) =>
        entry.event.kind === 'user-message' && entry.event.messageId === 'message-after-directory-fsync')
    assert(preservedOld || publishedNew, 'post-rename fsync failure must leave a complete old-or-new ledger')
    assertEqual(
      transcript.verifyConversationLedgerEntries(directoryFsyncEntries).valid,
      true,
      'post-rename fsync failure must never leave a mixed or corrupt digest chain'
    )
    assertEqual(
      transcript.readEventReceipts(directoryFsyncSdkSessionId).length,
      receiptsBeforeDirectoryFsync,
      'post-rename directory fsync failure must not commit a checkpoint-restore receipt'
    )
    assertRenamePrecedesDirectoryFault(directoryFsyncHarness, directoryFsyncTarget)
    assertFaultFollowedByClose(
      directoryFsyncHarness,
      'post-rename directory fsync failure must close its directory descriptor'
    )
    assertNoLedgerTemps(directoryFsyncSdkSessionId, 'post-rename fsync failure must not leave temporary files')
    const directoryFsyncResumed = new transcript.TranscriptWriter(directoryFsyncSdkSessionId)
    directoryFsyncResumed.next({ kind: 'status', status: 'running' })
    assertEqual(
      transcript.verifyConversationLedgerEntries(
        transcript.readTranscriptEntriesStrict(directoryFsyncSdkSessionId)
      ).valid,
      true,
      'a fresh writer must resume the complete old-or-new ledger after directory fsync uncertainty'
    )
  }

  const invalidArchiveRoot = path.join(tempRoot, 'archive-root-is-a-file')
  writeFileSync(invalidArchiveRoot, 'not a directory')
  await expectReject(
    archive.archiveConversationLedgerFromJsonl(identity, {
      rootDir: invalidArchiveRoot,
      reason: 'checkpoint_restore'
    }),
    /(?:eexist|directory)/i,
    'Conversation Ledger DB archive failure must propagate to the caller'
  )

  const transcriptPath = transcript.transcriptFile(sdkSessionId)
  const expectedJsonl = readFileSync(transcriptPath, 'utf8')
  unlinkSync(transcriptPath)
  const recovered = await archive.restoreConversationLedgerJsonlFromArchive(sdkSessionId, userData)
  assertEqual(recovered, true, 'missing JSONL must be restored from the current DB generation')
  const recoveredEntries = transcript.readTranscriptEntriesStrict(sdkSessionId)
  assertEqual(
    recoveredEntries.map((entry) => entry.eventId).join(','),
    restored.entries.map((entry) => entry.eventId).join(','),
    'DB recovery must preserve event identity'
  )

  const corrupt = expectedJsonl.replace('Inspect the persisted workspace state.', 'tampered workspace state')
  writeFileSync(transcriptPath, corrupt)
  await expectReject(
    archive.restoreConversationLedgerJsonlFromArchive(sdkSessionId, userData),
    'digest mismatch',
    'corrupt existing JSONL must fail closed instead of being replaced'
  )
  writeFileSync(transcriptPath, expectedJsonl)

  await snapshots.mutateTaskSnapshotDatabase(userData, (db) => {
    db.run(
      `UPDATE conversation_ledger_events
       SET payload = replace(payload, 'Inspect the persisted workspace state.', 'tampered archive state')
       WHERE sdk_session_id = ? AND generation = 2 AND kind = 'user-message'`,
      [sdkSessionId]
    )
  })
  await expectReject(
    snapshots.readTaskSnapshotDatabase(userData, (db) =>
      store.selectCurrentConversationLedgerEntries(db, sdkSessionId)),
    'invalid',
    'tampered DB archive must fail closed'
  )

  console.log(JSON.stringify({
    ok: true,
    stream: sdkSessionId,
    generations: verified.generations,
    events: verified.events,
    currentEvents: verified.currentEvents,
    restoredEntries: recoveredEntries.length,
    invariants: [
      'stable-event-identity',
      'attachment-reference',
      'tool-call-result-pair',
      'incremental-append',
      'checkpoint-generation-rewrite',
      'missing-jsonl-db-restore',
      'jsonl-tamper-fail-closed',
      'archive-tamper-fail-closed',
      'portable-replay-no-side-effects',
      'jsonl-write-failure-propagates',
      'append-fsync-failure-quarantines-writer',
      'receipt-fsync-failure-does-not-reject-canonical-event',
      'new-file-directory-fsync-failure-propagates-posix',
      'replacement-candidate-fsync-preserves-original',
      'checkpoint-rename-failure-preserves-original',
      'post-rename-directory-fsync-leaves-complete-ledger-posix',
      'archive-write-failure-propagates'
    ]
  }, null, 2))
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function createDurabilityHarness(transcript) {
  const events = []
  let fault

  function checkpoint(event) {
    events.push(event)
    if (!fault || !fault.matches(event)) return
    const label = fault.label
    fault = undefined
    event.fault = true
    throw new Error(`injected ${label} failure`)
  }

  const operations = transcript.createConversationLedgerFileOperations({
    open(filePath, flags, mode) {
      checkpoint({ operation: 'open', target: filePath, flags })
      return openSync(filePath, flags, mode)
    },
    append(descriptor, data, target) {
      checkpoint({ operation: 'append', target, descriptor })
      appendFileSync(descriptor, data, 'utf8')
    },
    write(descriptor, data, target) {
      checkpoint({ operation: 'write', target, descriptor })
      writeFileSync(descriptor, data)
    },
    fsync(descriptor, target, kind) {
      checkpoint({ operation: 'fsync', target, descriptor, kind })
      fsyncSync(descriptor)
    },
    close(descriptor, target) {
      checkpoint({ operation: 'close', target, descriptor })
      closeSync(descriptor)
    },
    rename(source, target) {
      checkpoint({ operation: 'rename', source, target })
      renameSync(source, target)
    }
  })

  return {
    operations,
    events,
    arm(label, matches) {
      assert(!fault, `durability fault already armed before ${label}`)
      fault = { label, matches }
    }
  }
}

function seedCheckpointRestoreFixture(writer, sdkSessionId, suffix) {
  const anchorId = `message-${suffix}-anchor`
  const checkpointId = `checkpoint-${suffix}`
  writer.next({ kind: 'init', sdkSessionId })
  writer.next({ kind: 'user-message', messageId: anchorId, text: `Anchor for ${suffix}.` })
  writer.next({ kind: 'checkpoint', messageId: checkpointId, userMessageId: anchorId })
  writer.next({
    kind: 'user-message',
    messageId: `message-after-${suffix}`,
    text: `This turn is removed only after a complete ${suffix} replacement.`
  })
}

function checkpointRestoreEvent(messageId) {
  return { kind: 'checkpoint-restore', messageId, mode: 'chat', filesChanged: [] }
}

function assertUniqueEventIds(entries, message) {
  const eventIds = entries.map((entry) => entry.eventId)
  assert(eventIds.every(Boolean), `${message}: every entry must carry an event id`)
  assertEqual(new Set(eventIds).size, eventIds.length, message)
}

function assertBufferEqual(actual, expected, message) {
  assert(Buffer.compare(actual, expected) === 0, message)
}

function assertFaultFollowedByClose(harness, message) {
  const faultIndex = harness.events.findIndex((event) => event.fault)
  assert(faultIndex >= 0, `${message}: injected fault was not reached`)
  const fault = harness.events[faultIndex]
  assert(
    harness.events.slice(faultIndex + 1).some((event) =>
      event.operation === 'close' && event.target === fault.target && event.descriptor === fault.descriptor),
    message
  )
}

function assertRenamePrecedesDirectoryFault(harness, target) {
  const renameIndex = harness.events.findIndex((event) =>
    event.operation === 'rename' && event.target === target)
  const faultIndex = harness.events.findIndex((event) =>
    event.fault && event.operation === 'fsync' && event.kind === 'directory')
  assert(renameIndex >= 0, 'replacement directory fault must occur after rename publication')
  assert(faultIndex > renameIndex, 'directory fsync barrier must execute after rename publication')
}

function assertNoLedgerTemps(sdkSessionId, message) {
  const prefix = `${sdkSessionId}.jsonl.`
  const names = readdirSync(path.join(userData, 'transcripts'))
  assert(!names.some((name) => name.startsWith(prefix) && name.endsWith('.tmp')), message)
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/transcript.ts',
    'src/main/conversation-ledger-replay.ts',
    'src/main/task/conversation-ledger-archive.ts',
    'src/main/task/conversation-ledger-store.ts',
    'src/main/task/task-snapshot.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), `export const app = { getPath: () => ${JSON.stringify(userData)} }\n`)
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
}

async function importCompiled(name) {
  return import(pathToFileURL(findCompiledModule(outDir, name)).href)
}

function findCompiledModule(root, name) {
  for (const entry of require('node:fs').readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModule(fullPath, name)
      if (found) return found
    } else if (entry.isFile() && entry.name === name) {
      return fullPath
    }
  }
  if (root === outDir) throw new Error(`compiled ${name} not found under ${root}`)
  return null
}

function rows(db, sql, values = []) {
  const statement = db.prepare(sql)
  const result = []
  try {
    statement.bind(values)
    while (statement.step()) result.push(statement.getAsObject())
  } finally {
    statement.free()
  }
  return result
}

async function expectReject(promise, expectedMessage, label) {
  try {
    await promise
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const matches = typeof expectedMessage === 'string'
      ? message.toLowerCase().includes(expectedMessage.toLowerCase())
      : expectedMessage.test(message)
    assert(matches, `${label}: ${message}`)
    return
  }
  throw new Error(`${label}: operation unexpectedly succeeded`)
}

function expectThrow(action, messageFragment, label) {
  try {
    action()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    assert(message.toLowerCase().includes(messageFragment.toLowerCase()), `${label}: ${message}`)
    return
  }
  throw new Error(`${label}: operation unexpectedly succeeded`)
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
