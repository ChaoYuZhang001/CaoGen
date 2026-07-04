import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-checkpoint-restore-plan-'))
const outDir = path.join(tempRoot, 'compiled')

try {
  execFileSync(
    'npx',
    [
      'tsc',
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

  const compiledPath = [
    path.join(outDir, 'checkpointRestorePlan.js'),
    path.join(outDir, 'main', 'checkpointRestorePlan.js'),
    path.join(outDir, 'src', 'main', 'checkpointRestorePlan.js')
  ].find((candidate) => existsSync(candidate))
  assert(compiledPath, 'compiled checkpointRestorePlan.js should exist')
  const restorePlan = await import(pathToFileURL(compiledPath).href)

  const transcript = [
    user(1, 'local-1', 'first prompt'),
    checkpoint(2, 'cp-1', 'local-1'),
    assistant(3, 'first answer'),
    result(4),
    user(5, 'local-2', 'second prompt'),
    assistant(6, 'second answer'),
    checkpoint(7, 'cp-2', 'local-2'),
    result(8)
  ]

  const turns = restorePlan.listCheckpointTurns(transcript)
  assertEqual(turns.length, 2)
  assertEqual(turns[1].checkpointId, 'cp-2')
  assertEqual(turns[1].userSeq, 5)

  const chatPlan = restorePlan.planTranscriptRestore(transcript, 'cp-2')
  assert(chatPlan.ok, chatPlan.reason)
  assertEqual(chatPlan.keepThroughSeq, 4)
  assertEqual(chatPlan.removeFromSeq, 5)
  assertEqual(chatPlan.keptEntries, 4)
  assertEqual(chatPlan.removedEntries, 4)
  assertEqual(chatPlan.userMessageId, 'local-2')
  assert(chatPlan.removedKinds.includes('user-message'), 'removed kinds should include user-message')
  assert(chatPlan.removedKinds.includes('checkpoint'), 'removed kinds should include checkpoint')

  const kept = restorePlan.applyTranscriptRestorePlan(transcript, chatPlan)
  assertEqual(kept.map((entry) => entry.seq).join(','), '1,2,3,4')

  const bothPlan = restorePlan.buildCheckpointRestorePlan(transcript, 'cp-2', 'both')
  assert(bothPlan.ok, bothPlan.reason)
  assert(bothPlan.canRestoreCode, 'both mode should require code rewind')
  assert(bothPlan.canRestoreChat, 'both mode should include chat restore')
  assert(bothPlan.requiresFileRewind, 'both mode should mark file rewind dependency')

  const codeOnly = restorePlan.buildCheckpointRestorePlan([], 'cp-outside-transcript', 'code')
  assert(codeOnly.ok, codeOnly.reason)
  assert(codeOnly.canRestoreCode, 'code mode can be planned without transcript trim')
  assert(!codeOnly.canRestoreChat, 'code mode should not claim chat restore')

  const missing = restorePlan.buildCheckpointRestorePlan(transcript, 'cp-missing', 'chat')
  assert(!missing.ok, 'missing checkpoint should not produce chat plan')
  assertEqual(missing.canRestoreChat, false)

  const legacyTranscript = [
    user(10, 'legacy-1', 'legacy first'),
    assistant(11, 'legacy answer'),
    checkpoint(12, 'legacy-cp-1'),
    user(13, 'legacy-2', 'legacy second'),
    checkpoint(14, 'legacy-cp-2')
  ]
  const legacyTurns = restorePlan.listCheckpointTurns(legacyTranscript)
  assertEqual(legacyTurns.length, 2)
  assertEqual(legacyTurns[0].userMessageId, 'legacy-1')
  assertEqual(legacyTurns[1].userMessageId, 'legacy-2')
  assertEqual(restorePlan.planTranscriptRestore(legacyTranscript, 'legacy-cp-2').removeFromSeq, 13)

  console.log('checkpointRestorePlan smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function user(seq, messageId, text) {
  return { seq, event: { kind: 'user-message', messageId, text } }
}

function checkpoint(seq, messageId, userMessageId) {
  return { seq, event: { kind: 'checkpoint', messageId, userMessageId } }
}

function assistant(seq, text) {
  return { seq, event: { kind: 'assistant-message', blocks: [{ type: 'text', text }] } }
}

function result(seq) {
  return { seq, event: { kind: 'turn-result', subtype: 'success', isError: false } }
}

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) {
    throw new Error(message)
  }
}
