import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-transcript-restore-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'userData')

try {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/transcript.ts',
      'src/main/checkpointRestorePlan.ts',
      '--outDir',
      outDir,
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--types',
      'node',
      '--skipLibCheck'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )

  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), `export const app = { getPath: () => ${JSON.stringify(userData)} }\n`)
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')

  const compiledPath = [
    path.join(outDir, 'transcript.js'),
    path.join(outDir, 'main', 'transcript.js'),
    path.join(outDir, 'src', 'main', 'transcript.js')
  ].find((candidate) => existsSync(candidate))
  assert(compiledPath, 'compiled transcript.js should exist')
  const { TranscriptWriter, eventReceiptsFile } = await import(pathToFileURL(compiledPath).href)

  const writer = new TranscriptWriter()
  writer.next(user('u-1', 'first prompt'))
  writer.next(checkpoint('cp-1', 'u-1'))
  writer.next(assistant('first answer'))
  writer.next(result())
  writer.next({ kind: 'init', sdkSessionId: 'sdk-restore' })
  writer.next(user('u-2', 'second prompt'))
  writer.next(assistant('second answer'))
  writer.next(checkpoint('cp-2', 'u-2'))
  writer.next(result())

  const preview = writer.planRestore('cp-2')
  assert(preview.ok, preview.reason)
  assertEqual(preview.removeFromSeq, 6)
  assertEqual(preview.removedEntries, 4)

  const restored = writer.restore('cp-2', {
    kind: 'checkpoint-restore',
    messageId: 'cp-2',
    mode: 'chat',
    filesChanged: [],
    chatRemovedEntries: preview.removedEntries
  })
  assert(restored.plan.ok, restored.plan.reason)
  assertEqual(restored.entries.map((entry) => entry.seq).join(','), '1,2,3,4,10')
  assertEqual(restored.entries[restored.entries.length - 1].event.kind, 'checkpoint-restore')

  writer.next(user('u-3', 'third prompt'))
  const entries = writer.readAll()
  assertEqual(entries.map((entry) => entry.seq).join(','), '1,2,3,4,10,11')
  assert(entries.every((entry) => entry.eventId), 'new transcript entries must carry eventId')
  assertEqual(new Set(entries.map((entry) => entry.eventId)).size, entries.length)
  assertEqual(new Set(entries.map((entry) => entry.streamId)).size, 1)

  const transcriptFile = path.join(userData, 'transcripts', 'sdk-restore.jsonl')
  const lines = readFileSync(transcriptFile, 'utf8').trim().split('\n')
  assertEqual(lines.length, 6)
  assert(lines.every((line) => JSON.parse(line).seq), 'transcript file should contain valid JSONL')
  assert(lines.every((line) => JSON.parse(line).eventId), 'transcript JSONL should persist event identity')

  const receipts = readFileSync(eventReceiptsFile('sdk-restore'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assertEqual(receipts.length, 11)
  assertEqual(new Set(receipts.map((receipt) => receipt.eventId)).size, receipts.length)
  assert(receipts.every((receipt) => receipt.streamId === entries[0].streamId), 'receipt stream lineage should stay stable')

  const resumed = new TranscriptWriter('sdk-restore', 25)
  const resumedEntry = resumed.nextEntry({ kind: 'status', status: 'idle' })
  assertEqual(resumedEntry.seq, 26)
  assertEqual(resumedEntry.streamId, entries[0].streamId)

  const redacted = new TranscriptWriter()
  redacted.next({ kind: 'init', sdkSessionId: 'sdk-redacted-receipt' })
  redacted.next({
    kind: 'permission-request',
    request: {
      requestId: 'permission-secret',
      toolUseId: 'tool-secret',
      toolName: 'bash',
      input: { command: 'echo SHOULD_NOT_PERSIST' }
    }
  })
  const redactedReceipt = readFileSync(eventReceiptsFile('sdk-redacted-receipt'), 'utf8')
  assert(redactedReceipt.includes('permission-secret'), 'receipt should retain correlation ids')
  assert(!redactedReceipt.includes('SHOULD_NOT_PERSIST'), 'receipt must not persist raw tool input')

  const childWriter = new TranscriptWriter()
  childWriter.next({ kind: 'init', sdkSessionId: 'sdk-subagent-result' })
  childWriter.next(subagentResult())
  const childTranscriptFile = path.join(userData, 'transcripts', 'sdk-subagent-result.jsonl')
  const childEntries = readFileSync(childTranscriptFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assertEqual(childEntries.length, 1)
  assertEqual(childEntries[0].event.kind, 'subagent-result')
  assertEqual(childEntries[0].event.childTaskId, 'child-1')

  console.log('transcriptRestore smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function user(messageId, text) {
  return { kind: 'user-message', messageId, text }
}

function checkpoint(messageId, userMessageId) {
  return { kind: 'checkpoint', messageId, userMessageId }
}

function assistant(text) {
  return { kind: 'assistant-message', blocks: [{ type: 'text', text }] }
}

function result() {
  return { kind: 'turn-result', subtype: 'success', isError: false }
}

function subagentResult() {
  return {
    kind: 'subagent-result',
    orchestrationId: 'dag-1',
    childTaskId: 'child-1',
    childSessionId: 'session-child-1',
    childRole: 'backend',
    status: 'done',
    resultText: 'child done',
    costUsd: 0.01,
    durationMs: 1234
  }
}

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
