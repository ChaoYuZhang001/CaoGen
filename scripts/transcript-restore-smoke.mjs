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
    'npx',
    [
      'tsc',
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
  const { TranscriptWriter } = await import(pathToFileURL(compiledPath).href)

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
  assertEqual(preview.removeFromSeq, 10)
  assertEqual(preview.removedEntries, 4)

  const restored = writer.restore('cp-2', {
    kind: 'checkpoint-restore',
    messageId: 'cp-2',
    mode: 'chat',
    filesChanged: [],
    chatRemovedEntries: preview.removedEntries
  })
  assert(restored.plan.ok, restored.plan.reason)
  assertEqual(restored.entries.map((entry) => entry.seq).join(','), '5,6,7,8,14')
  assertEqual(restored.entries[restored.entries.length - 1].event.kind, 'checkpoint-restore')

  writer.next(user('u-3', 'third prompt'))
  const entries = writer.readAll()
  assertEqual(entries.map((entry) => entry.seq).join(','), '5,6,7,8,14,15')

  const transcriptFile = path.join(userData, 'transcripts', 'sdk-restore.jsonl')
  const lines = readFileSync(transcriptFile, 'utf8').trim().split('\n')
  assertEqual(lines.length, 6)
  assert(lines.every((line) => JSON.parse(line).seq), 'transcript file should contain valid JSONL')

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

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
