#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const Module = require('node:module').Module
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-anthropic-tool-loop-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
const checks = []
const imageRestartOnly = process.argv.includes('--image-restart-only')

process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter)
Module._initPaths()

let runtime
let previousSettings
try {
  compileRuntime()
  runtime = loadRuntime()
  previousSettings = { ...runtime.settings.getSettings() }
  runtime.settings.updateSettings({
    sandboxMode: 'restrictedLocal',
    permissionAllowlist: '',
    permissionDenylist: '',
    permissionTemporaryAllowlist: ''
  })

  if (!imageRestartOnly) {
    await check('tool declarations derive from OPENAI_CODING_TOOLS', verifyToolDeclarations)
    await check('multi-request loop executes native reads and a durable write Effect', verifyNativeToolLoop)
    await check('plan mode denial is returned to the model without an Effect', verifyPlanDenial)
    await check('interrupt and dispose reject pending native approvals', verifyPendingApprovalTermination)
    await check('Anthropic prepared approval Effects abandon during stopped-process recovery', verifyPreparedRecovery)
    await check('unknown Effect stops remaining tools and provider continuation', verifyUnknownEffectStopsTurn)
    await check('the fortieth tool response is bounded without executing tools', verifyRequestLimit)
    await check('non-completion stop reasons fail closed', verifyStopReasonsFailClosed)
    await check('failed tool half-turns never enter live or resumed history', verifyFailedHalfTurn)
  }
  await check('content-addressed image turns survive snapshot restart and corrupt refs fail closed', verifyAttachmentRecovery)

  console.log(JSON.stringify({ status: 'pass', checks }, null, 2))
} finally {
  runtime?.registry.taskRuntimeRegistry.clear()
  if (runtime && previousSettings) runtime.settings.updateSettings(previousSettings)
  rmSync(tempRoot, { recursive: true, force: true })
}

function verifyToolDeclarations() {
  const expected = runtime.tools.OPENAI_CODING_TOOLS.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters
  }))
  assert.deepEqual(runtime.engine.ANTHROPIC_CODING_TOOLS, expected)
  assert(expected.length > 0, 'Anthropic must expose the shared native coding tools')
  assert(expected.some((tool) => tool.name === 'read_file'))
  assert(expected.some((tool) => tool.name === 'write_file'))
}

async function verifyNativeToolLoop() {
  const project = projectDirectory('native-loop')
  writeFileSync(path.join(project, 'source.txt'), 'native read payload\n')
  const secret = 'anthropic-secret-for-smoke-native-loop'
  const requests = []
  const responses = [
    messageResult('native-1', [
      { type: 'thinking', thinking: 'Inspect both reads.', signature: 'signed-native-thinking' },
      { type: 'redacted_thinking', data: 'opaque-redacted-native' },
      { type: 'text', text: 'Reading inputs. ' },
      toolUse('native-read-1', 'read_file', { path: 'source.txt' }),
      toolUse('native-read-2', 'read_file', { path: 'source.txt' })
    ], usage(3, 2, 1, 1)),
    messageResult('native-2', [
      { type: 'text', text: 'Writing output. ' },
      toolUse('native-write', 'write_file', { path: 'written.txt', content: 'written by Anthropic\n' })
    ], usage(4, 3)),
    messageResult('native-3', [{ type: 'text', text: 'Done.' }], usage(5, 4)),
    messageResult('native-4', [{ type: 'text', text: 'Follow-up complete.' }], usage(2, 1))
  ]
  const harness = await createHarness({
    id: 'anthropic-native-loop',
    project,
    permissionMode: 'bypassPermissions',
    messageIds: ['native-user', 'native-followup'],
    secret,
    streamMessage: scriptedStream(responses, requests)
  })

  try {
    harness.engine.send({ text: 'read twice, then write', images: [], messageId: 'native-user' })
    await waitForTurn(harness, 1, 'native tool loop')

    assert.equal(requests.length, 3)
    assert.deepEqual(requests[0].tools, runtime.engine.ANTHROPIC_CODING_TOOLS)
    const secondMessages = requests[1].messages
    assert.equal(secondMessages.length, 3)
    assert.deepEqual(secondMessages[1], {
      role: 'assistant',
      content: responses[0].contentBlocks
    })
    assert.equal(secondMessages[2].role, 'user')
    assert(Array.isArray(secondMessages[2].content))
    assert.equal(secondMessages[2].content.length, 2)
    assert.deepEqual(
      secondMessages[2].content.map((block) => block.tool_use_id),
      ['native-read-1', 'native-read-2']
    )
    for (const block of secondMessages[2].content) {
      assert.equal(block.type, 'tool_result')
      assert.equal(block.is_error, false)
      assert.match(String(block.content), /native read payload/)
    }

    assert.equal(readFileSync(path.join(project, 'written.txt'), 'utf8'), 'written by Anthropic\n')
    const writeEffect = currentRun(harness).effects.find((effect) => effect.toolUseId === 'native-write')
    assert(writeEffect, 'write_file must create a durable Effect')
    assert.equal(writeEffect.status, 'confirmed')

    assertNativeLoopEventOrder(harness.events)

    const firstResult = turnResults(harness.events)[0]
    assert.equal(firstResult.isError, false)
    assert.deepEqual(firstResult.usage, usage(12, 9, 1, 1))
    assert.deepEqual(harness.meta.usage, usage(12, 9, 1, 1))
    assert.equal(harness.attempts.calls.start.length, 3)
    assert.equal(new Set(harness.attempts.calls.start.map((call) => call.input.requestId)).size, 3)
    assert.deepEqual(
      harness.attempts.calls.start.map((call) => call.input.requestId.split(':').at(-1)),
      ['1', '2', '3']
    )

    const firstTurnHistory = structuredClone(harness.engine.history)
    harness.engine.send({ text: 'follow up', images: [], messageId: 'native-followup' })
    await waitForTurn(harness, 2, 'native follow-up')
    assert.equal(requests.length, 4)
    assert.deepEqual(requests[3].messages.slice(0, -1), firstTurnHistory)

    const liveHistory = structuredClone(harness.engine.history)
    const sdkSessionId = harness.meta.sdkSessionId
    assert(sdkSessionId)
    const lastSeq = Math.max(...harness.events.map(({ seq }) => seq))
    await harness.engine.dispose()
    const resumed = new runtime.engine.AnthropicEngine(
      metaFixture(harness.meta.id, project, 'bypassPermissions'),
      () => undefined,
      sdkSessionId,
      lastSeq,
      harness.dependencies
    )
    assert.deepEqual(resumed.history, liveHistory)
    const resumedFirstAssistant = resumed.history[1]
    assert.equal(resumedFirstAssistant.role, 'assistant')
    assert.deepEqual(resumedFirstAssistant.content, responses[0].contentBlocks)
    assert.equal(resumedFirstAssistant.content[1].type, 'redacted_thinking')
    assert.equal(resumed.history[2].role, 'user')
    assert.equal(resumed.history[2].content.length, 2)
    await resumed.dispose()

    assert.equal(JSON.stringify({
      requests,
      events: harness.events,
      attempts: harness.attempts.calls
    }).includes(secret), false, 'credentials must not enter request bodies, events, or Attempt records')
  } finally {
    await disposeHarness(harness)
  }
}

function assertNativeLoopEventOrder(events) {
  const toolStarts = eventIndexes(events, 'tool-start')
  const assistantWithBothReads = events.findIndex(({ event }) =>
    event.kind === 'assistant-message' &&
    event.blocks.filter((block) => block.type === 'tool_use').length === 2
  )
  const firstReadResult = events.findIndex(({ event }) =>
    event.kind === 'tool-result' && event.toolUseId === 'native-read-1'
  )
  assert(toolStarts[0] < assistantWithBothReads && assistantWithBothReads < firstReadResult)
  assert.equal(
    events.filter(({ event }) => event.kind === 'assistant-message' &&
      event.blocks.some((block) => block.type === 'text' && block.text === 'Reading inputs. ')).length,
    1,
    'intermediate assistant text must be emitted exactly once'
  )
}

async function verifyPlanDenial() {
  const project = projectDirectory('plan-denial')
  const requests = []
  const harness = await createHarness({
    id: 'anthropic-plan-denial',
    project,
    permissionMode: 'plan',
    messageIds: ['plan-user'],
    streamMessage: scriptedStream([
      messageResult('plan-1', [
        { type: 'thinking', thinking: 'Unsigned gateway thinking must not replay.' },
        toolUse('plan-write', 'write_file', { path: 'denied.txt', content: 'must not exist\n' })
      ]),
      messageResult('plan-2', [{ type: 'text', text: 'Write was denied.' }])
    ], requests)
  })

  try {
    harness.engine.send({ text: 'attempt a write in plan mode', images: [], messageId: 'plan-user' })
    await waitForTurn(harness, 1, 'plan denial')
    assert.equal(requests.length, 2)
    const feedback = requests[1].messages.at(-1)
    assert.equal(feedback.role, 'user')
    assert.equal(feedback.content[0].type, 'tool_result')
    assert.equal(feedback.content[0].is_error, true)
    assert.match(String(feedback.content[0].content), /规划模式/)
    const replayedAssistant = requests[1].messages.at(-2)
    assert.equal(replayedAssistant.role, 'assistant')
    assert.deepEqual(replayedAssistant.content, [
      toolUse('plan-write', 'write_file', { path: 'denied.txt', content: 'must not exist\n' })
    ])
    assert.equal(existsSync(path.join(project, 'denied.txt')), false)
    assert.equal(currentRun(harness).effects.length, 0)
    assert.equal(harness.events.some(({ event }) => event.kind === 'permission-request'), false)
    assert.equal(turnResults(harness.events)[0].isError, false)
  } finally {
    await disposeHarness(harness)
  }
}

async function verifyPendingApprovalTermination() {
  for (const action of ['interrupt', 'dispose']) {
    const project = projectDirectory(`approval-${action}`)
    const harness = await createHarness({
      id: `anthropic-approval-${action}`,
      project,
      permissionMode: 'default',
      messageIds: [`approval-${action}-user`],
      streamMessage: scriptedStream([
        messageResult(`approval-${action}-1`, [
          toolUse(`approval-${action}-write`, 'write_file', {
            path: `${action}.txt`, content: 'must not be written\n'
          }),
          toolUse(`approval-${action}-skipped`, 'write_file', {
            path: `${action}-skipped.txt`, content: 'must also remain absent\n'
          })
        ])
      ], [])
    })

    try {
      harness.engine.send({
        text: `wait for ${action}`,
        images: [],
        messageId: `approval-${action}-user`
      })
      await eventually(() => harness.engine.pendingPermissions().length === 1, `${action} permission request`)
      if (action === 'interrupt') await harness.engine.interrupt()
      else await harness.engine.dispose()
      await eventually(() => harness.engine.activeTurn === null, `${action} active turn cleanup`)

      assert.deepEqual(harness.engine.pendingPermissions(), [])
      assert.equal(existsSync(path.join(project, `${action}.txt`)), false)
      assert.equal(existsSync(path.join(project, `${action}-skipped.txt`)), false)
      assert(harness.events.some(({ event }) =>
        event.kind === 'permission-resolved' && event.behavior === 'deny'
      ))
      const effect = currentRun(harness).effects.find((candidate) =>
        candidate.toolUseId === `approval-${action}-write`
      )
      assert(effect)
      assert.equal(effect.status, 'abandoned')
      const skipped = harness.events.find(({ event }) =>
        event.kind === 'tool-result' && event.toolUseId === `approval-${action}-skipped`
      )?.event
      assert(skipped && skipped.kind === 'tool-result')
      assert.equal(skipped.isError, true)
      assert.match(skipped.content, /未执行:本轮已中断/)
      if (action === 'interrupt') {
        const result = turnResults(harness.events)[0]
        assert.equal(result.isError, true)
        assert.equal(result.subtype, 'interrupted')
      } else {
        assert.equal(harness.meta.status, 'closed')
      }
    } finally {
      await disposeHarness(harness)
    }
  }
}

async function verifyUnknownEffectStopsTurn() {
  const project = projectDirectory('unknown-effect')
  const requests = []
  const harness = await createHarness({
    id: 'anthropic-unknown-effect',
    project,
    permissionMode: 'bypassPermissions',
    messageIds: ['unknown-effect-user'],
    streamMessage: scriptedStream([
      messageResult('unknown-effect-1', [
        toolUse('unknown-bash', 'bash', { command: 'exit 7' }),
        toolUse('must-not-run-write', 'write_file', {
          path: 'must-not-run.txt', content: 'unreachable\n'
        })
      ]),
      messageResult('unknown-effect-2', [{ type: 'text', text: 'must not be requested' }])
    ], requests)
  })

  try {
    harness.engine.send({ text: 'run an opaque failing command', images: [], messageId: 'unknown-effect-user' })
    await waitForTurn(harness, 1, 'unknown Effect termination')
    assert.equal(requests.length, 1)
    assert.equal(existsSync(path.join(project, 'must-not-run.txt')), false)
    assert.deepEqual(
      harness.events.filter(({ event }) => event.kind === 'tool-start').map(({ event }) => event.toolUseId),
      ['unknown-bash']
    )
    const toolResult = harness.events.find(({ event }) =>
      event.kind === 'tool-result' && event.toolUseId === 'unknown-bash'
    )?.event
    assert.equal(toolResult.effectStatus, 'waiting_reconciliation')
    const skipped = harness.events.find(({ event }) =>
      event.kind === 'tool-result' && event.toolUseId === 'must-not-run-write'
    )?.event
    assert(skipped && skipped.kind === 'tool-result')
    assert.equal(skipped.isError, true)
    assert.match(skipped.content, /前序工具效果状态未知/)
    const turnResult = turnResults(harness.events)[0]
    assert.equal(turnResult.isError, true)
    assert.equal(turnResult.subtype, 'effect-unknown')
    assert.equal(harness.engine.history.length, 0)
    assert.equal(currentRun(harness).effects[0].status, 'waiting_reconciliation')
  } finally {
    await disposeHarness(harness)
  }
}

async function verifyPreparedRecovery() {
  const project = projectDirectory('prepared-crash')
  const harness = await createHarness({
    id: 'anthropic-prepared-crash',
    project,
    permissionMode: 'default',
    messageIds: ['prepared-crash-user'],
    streamMessage: scriptedStream([
      messageResult('prepared-crash-1', [toolUse('prepared-crash-write', 'write_file', {
        path: 'prepared-crash.txt', content: 'must not be written\n'
      })])
    ], [])
  })

  try {
    harness.engine.send({
      text: 'crash while waiting for write approval',
      images: [],
      messageId: 'prepared-crash-user'
    })
    await eventually(() => harness.engine.pendingPermissions().length === 1, 'prepared crash permission')
    const snapshot = await runtime.snapshot.getTaskSnapshot(harness.meta.id, userData)
    assert(snapshot?.run)
    assert.equal(snapshot.run.effects[0].status, 'prepared')
    assert.equal(
      runtime.idempotency.stableValueDigest(snapshot.run.effects[0].target),
      snapshot.run.effects[0].targetDigest,
      `persisted prepared target drifted:${JSON.stringify(snapshot.run.effects[0].target)}`
    )
    const recovered = await runtime.effectRuntime.reconcileTaskSnapshotEffects(
      { ...snapshot, engine: 'anthropic', meta: { ...snapshot.meta, engine: 'anthropic' } },
      { processStopped: true }
    )
    assert.equal(recovered.run.effects[0].status, 'abandoned')
    assert.equal(existsSync(path.join(project, 'prepared-crash.txt')), false)
  } finally {
    await disposeHarness(harness)
  }
}

async function verifyRequestLimit() {
  const project = projectDirectory('request-limit')
  writeFileSync(path.join(project, 'source.txt'), 'bounded read\n')
  const requests = []
  let responseIndex = 0
  const harness = await createHarness({
    id: 'anthropic-request-limit',
    project,
    permissionMode: 'bypassPermissions',
    messageIds: ['limit-user'],
    streamMessage: async (input) => {
      const index = ++responseIndex
      requests.push(structuredClone(input.request))
      return messageResult(`limit-${index}`, [
        toolUse(`limit-read-${index}`, 'read_file', { path: 'source.txt' })
      ], usage(1, 1))
    }
  })

  try {
    harness.engine.send({ text: 'keep reading forever', images: [], messageId: 'limit-user' })
    await waitForTurn(harness, 1, 'fortieth request limit', 20_000)
    assert.equal(requests.length, 40)
    assert.equal(harness.attempts.calls.start.length, 40)
    assert.equal(harness.events.filter(({ event }) => event.kind === 'tool-result').length, 40)
    assert.equal(harness.events.some(({ event }) =>
      event.kind === 'tool-start' && event.toolUseId === 'limit-read-40'
    ), false)
    const skipped = harness.events.find(({ event }) =>
      event.kind === 'tool-result' && event.toolUseId === 'limit-read-40'
    )?.event
    assert(skipped && skipped.kind === 'tool-result')
    assert.equal(skipped.isError, true)
    assert.match(skipped.content, /请求已达上限/)
    const result = turnResults(harness.events)[0]
    assert.equal(result.isError, true)
    assert.equal(result.subtype, 'tool-loop-limit')
    assert.deepEqual(result.usage, usage(40, 40))
    assert.equal(harness.engine.history.length, 0)
  } finally {
    await disposeHarness(harness)
  }
}

async function verifyStopReasonsFailClosed() {
  const reasons = [
    ['max_tokens', 'max-tokens'],
    ['refusal', 'refusal'],
    ['model_context_window_exceeded', 'context-window'],
    ['pause_turn', 'pause-turn'],
    ['stop_sequence', 'stop-sequence']
  ]
  const project = projectDirectory('stop-reasons')
  const messageIds = reasons.map(([reason]) => `stop-${reason}`)
  const responses = reasons.map(([reason], index) => ({
    ...messageResult(`stop-reason-${index + 1}`, [{ type: 'text', text: `partial ${reason}` }]),
    stopReason: reason
  }))
  const harness = await createHarness({
    id: 'anthropic-stop-reasons',
    project,
    permissionMode: 'bypassPermissions',
    messageIds,
    streamMessage: scriptedStream(responses, [])
  })

  try {
    for (let index = 0; index < reasons.length; index += 1) {
      const [reason, subtype] = reasons[index]
      harness.engine.send({ text: `trigger ${reason}`, images: [], messageId: messageIds[index] })
      await waitForTurn(harness, index + 1, `${reason} stop reason`)
      const result = turnResults(harness.events)[index]
      assert.equal(result.isError, true)
      assert.equal(result.subtype, subtype)
      assert.equal(harness.engine.history.length, 0)
    }
  } finally {
    await disposeHarness(harness)
  }
}

async function verifyFailedHalfTurn() {
  const project = projectDirectory('failed-half-turn')
  writeFileSync(path.join(project, 'source.txt'), 'partial read\n')
  const secret = 'anthropic-secret-for-smoke-failed-half'
  const requests = []
  let requestIndex = 0
  const harness = await createHarness({
    id: 'anthropic-failed-half-turn',
    project,
    permissionMode: 'bypassPermissions',
    messageIds: ['failed-half-user'],
    secret,
    streamMessage: async (input) => {
      requestIndex += 1
      requests.push(structuredClone(input.request))
      if (requestIndex === 1) {
        return messageResult('failed-half-1', [
          { type: 'text', text: 'Partial. ' },
          toolUse('failed-half-read', 'read_file', { path: 'source.txt' })
        ])
      }
      throw new Error(`provider echoed ${secret}`)
    }
  })

  try {
    harness.engine.send({ text: 'fail after a tool', images: [], messageId: 'failed-half-user' })
    await waitForTurn(harness, 1, 'failed half-turn')
    const result = turnResults(harness.events)[0]
    assert.equal(result.isError, true)
    assert.match(result.resultText, /\[REDACTED\]/)
    assert.equal(JSON.stringify(harness.events).includes(secret), false)
    assert.equal(harness.engine.history.length, 0)

    const sdkSessionId = harness.meta.sdkSessionId
    const lastSeq = Math.max(...harness.events.map(({ seq }) => seq))
    await harness.engine.dispose()
    const resumed = new runtime.engine.AnthropicEngine(
      metaFixture(harness.meta.id, project, 'bypassPermissions'),
      () => undefined,
      sdkSessionId,
      lastSeq,
      harness.dependencies
    )
    assert.deepEqual(resumed.history, [])
    await resumed.dispose()
  } finally {
    await disposeHarness(harness)
  }
}

async function verifyAttachmentRecovery() {
  await verifySuccessfulAttachmentRestart()
  await verifyCorruptAttachmentHistory()
}

async function verifySuccessfulAttachmentRestart() {
  for (const mode of ['image-only', 'image-and-text']) {
    const project = projectDirectory(`attachment-${mode}`)
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const hash = createHash('sha256').update(imageBytes).digest('hex')
    const attachmentRoot = path.join(userData, 'attachments', `anthropic-attachment-${mode}`)
    const imagePath = path.join(attachmentRoot, `${hash}.png`)
    mkdirSync(attachmentRoot, { recursive: true })
    writeFileSync(imagePath, imageBytes)
    const ignoredPayloadPath = path.join(project, 'untrusted-payload-path.png')
    writeFileSync(ignoredPayloadPath, Buffer.concat([imageBytes, Buffer.from('not the stored object')]))
    const secret = 'anthropic-secret-for-smoke-attachment-restart'
    const requests = []
    const harness = await createHarness({
      id: `anthropic-attachment-${mode}`,
      project,
      permissionMode: 'bypassPermissions',
      messageIds: [`attachment-${mode}-user`, `attachment-${mode}-followup`],
      secret,
      streamMessage: scriptedStream([
        messageResult(`attachment-${mode}-1`, [{ type: 'text', text: 'Image accepted.' }]),
        messageResult(`attachment-${mode}-2`, [{ type: 'text', text: 'Fresh text accepted.' }])
      ], requests)
    })

    try {
      harness.engine.send({
        text: mode === 'image-and-text' ? 'describe this image' : '',
        images: [{
          id: hash,
          hash,
          path: ignoredPayloadPath,
          mime: 'image/png',
          bytes: imageBytes.length,
          createdAt: '2026-07-21T00:00:00.000Z'
        }],
        messageId: `attachment-${mode}-user`
      })
      await waitForTurn(harness, 1, `${mode} first turn`)
      assert(harness.engine.history.length > 0)
      const firstImageBlock = requests[0].messages[0].content.find((block) => block.type === 'image')
      assert(firstImageBlock)
      assert.equal(firstImageBlock.source.media_type, 'image/png')
      assert.equal(firstImageBlock.source.data, imageBytes.toString('base64'))

      const transcript = harness.engine.getTranscript()
      const serializedTranscript = JSON.stringify(transcript)
      assert(serializedTranscript.includes(hash))
      assert.equal(serializedTranscript.includes(ignoredPayloadPath), false)
      assert.equal(serializedTranscript.includes(imagePath), false)
      assert.equal(serializedTranscript.includes(imageBytes.toString('base64')), false)
      assert.equal(serializedTranscript.includes(secret), false)
      const snapshot = await saveHarnessSnapshot(harness)
      assert.equal(JSON.stringify(snapshot.transcript).includes(imageBytes.toString('base64')), false)

      const sdkSessionId = harness.meta.sdkSessionId
      const lastSeq = Math.max(...harness.events.map(({ seq }) => seq))
      await harness.engine.dispose()
      unlinkSync(path.join(userData, 'transcripts', `${sdkSessionId}.jsonl`))
      runtime.transcript.restoreTranscriptIfMissing(sdkSessionId, snapshot.transcript)
      const resumedEvents = []
      const resumed = new runtime.engine.AnthropicEngine(
        metaFixture(harness.meta.id, project, 'bypassPermissions'),
        (event, seq) => resumedEvents.push({ event, seq }),
        sdkSessionId,
        lastSeq,
        harness.dependencies
      )
      assert(resumed.history.some((message) =>
        Array.isArray(message.content) && message.content.some((block) => block.type === 'image')
      ))
      resumed.send({
        text: 'fresh text after restart',
        images: [],
        messageId: `attachment-${mode}-followup`
      })
      await waitForTurn({ engine: resumed, events: resumedEvents }, 1, `${mode} resumed text`)
      assert.equal(requests.length, 2)
      const recoveredImageBlock = requests[1].messages[0].content.find((block) => block.type === 'image')
      assert.deepEqual(recoveredImageBlock, firstImageBlock)
      assert.equal(requests[1].messages.at(-1).content[0].text, 'fresh text after restart')
      await resumed.dispose()
    } finally {
      await disposeHarness(harness)
    }
  }
}

async function verifyCorruptAttachmentHistory() {
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const hash = createHash('sha256').update(imageBytes).digest('hex')
  const variants = [
    { name: 'legacy', attachment: { id: hash, mime: 'image/png', bytes: imageBytes.length } },
    { name: 'missing', attachment: imageReference('f'.repeat(64), imageBytes.length, 'image/png') },
    { name: 'bytes', attachment: imageReference(hash, imageBytes.length + 1, 'image/png'), object: imageBytes },
    { name: 'mime', attachment: imageReference(hash, imageBytes.length, 'image/jpeg'), object: imageBytes },
    { name: 'tampered', attachment: imageReference(hash, imageBytes.length + 1, 'image/png'), object: Buffer.concat([imageBytes, Buffer.from([0])]) },
    { name: 'budget', attachments: Array.from({ length: 33 }, () => imageReference(hash, imageBytes.length, 'image/png')) },
    { name: 'symlink-root', attachment: imageReference(hash, imageBytes.length, 'image/png'), object: imageBytes, symlinkRoot: true },
    { name: 'symlink-object', attachment: imageReference(hash, imageBytes.length, 'image/png'), object: imageBytes, symlinkObject: true }
  ]
  for (const variant of variants) await verifyCorruptAttachmentVariant(variant, hash, imageBytes)
}

async function verifyCorruptAttachmentVariant(variant, hash, canonicalBytes) {
  const sessionId = `anthropic-corrupt-${variant.name}`
  const sdkSessionId = `sdk-${sessionId}`
  prepareCorruptAttachmentObject(sessionId, variant, hash, canonicalBytes)
  writeTranscriptFixture(sdkSessionId, corruptThenValidEvents(variant.attachments ?? [variant.attachment]))
  const resumed = new runtime.engine.AnthropicEngine(
    metaFixture(sessionId, projectDirectory(sessionId), 'bypassPermissions'),
    () => undefined,
    sdkSessionId,
    6,
    { resolveTarget: () => targetFixture(), streamMessage: async () => messageResult('unused', []) }
  )
  assert.deepEqual(resumed.history, [
    { role: 'user', content: [{ type: 'text', text: 'valid text after corrupt image' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'valid reply' }] }
  ], `${variant.name} must drop the entire corrupt image turn without orphaning its assistant`)
  await resumed.dispose()
}

function prepareCorruptAttachmentObject(sessionId, variant, hash, canonicalBytes) {
  const root = path.join(userData, 'attachments', sessionId)
  if (variant.symlinkRoot) {
    const external = path.join(tempRoot, `${sessionId}-external`)
    mkdirSync(external, { recursive: true })
    writeFileSync(path.join(external, `${hash}.png`), canonicalBytes)
    mkdirSync(path.dirname(root), { recursive: true })
    symlinkSync(external, root)
    return
  }
  mkdirSync(root, { recursive: true })
  if (!variant.object) return
  const extension = variant.attachment?.mime === 'image/jpeg' ? 'jpg' : 'png'
  const target = path.join(root, `${hash}.${extension}`)
  if (variant.symlinkObject) {
    const external = path.join(tempRoot, `${sessionId}-object.png`)
    writeFileSync(external, variant.object)
    symlinkSync(external, target)
  } else {
    writeFileSync(target, variant.object)
  }
}

function imageReference(hash, bytes, mime) {
  return { id: hash, hash, mime, bytes }
}

function corruptThenValidEvents(attachments) {
  return [
    { kind: 'user-message', text: 'corrupt image turn', attachments, messageId: 'corrupt-user' },
    { kind: 'assistant-message', blocks: [{ type: 'text', text: 'must be dropped' }] },
    { kind: 'turn-result', subtype: 'success', isError: false },
    { kind: 'user-message', text: 'valid text after corrupt image', messageId: 'valid-user' },
    { kind: 'assistant-message', blocks: [{ type: 'text', text: 'valid reply' }] },
    { kind: 'turn-result', subtype: 'success', isError: false }
  ]
}

function writeTranscriptFixture(sdkSessionId, events) {
  const root = path.join(userData, 'transcripts')
  mkdirSync(root, { recursive: true })
  writeFileSync(
    path.join(root, `${sdkSessionId}.jsonl`),
    `${events.map((event, index) => JSON.stringify({ seq: index + 1, event })).join('\n')}\n`
  )
}

async function saveHarnessSnapshot(harness) {
  return runtime.snapshot.saveTaskSnapshot(runtime.snapshot.buildTaskSnapshot({
    meta: harness.meta,
    transcript: harness.engine.getTranscript(),
    lastSeq: harness.events.at(-1)?.seq ?? 0,
    lastEventKind: harness.events.at(-1)?.event.kind,
    eventCount: harness.events.length,
    reason: 'important-event',
    run: currentRun(harness)
  }), userData)
}

async function createHarness(options) {
  const meta = metaFixture(options.id, options.project, options.permissionMode)
  const run = runFixture(options.id, options.messageIds)
  runtime.registry.taskRuntimeRegistry.set(meta.id, run)
  const attempts = fakeAttemptDependencies()
  const target = targetFixture(options.secret)
  const dependencies = {
    resolveTarget: () => target,
    getRun: () => runtime.registry.taskRuntimeRegistry.get(meta.id),
    modelAttempts: new runtime.attempt.AnthropicModelAttemptTracker(attempts),
    streamMessage: options.streamMessage
  }
  const events = []
  const engine = new runtime.engine.AnthropicEngine(
    meta,
    (event, seq, identity) => events.push({ event, seq, identity }),
    undefined,
    0,
    dependencies
  )
  await engine.start()
  const persisted = await runtime.snapshot.saveTaskSnapshot(runtime.snapshot.buildTaskSnapshot({
    meta,
    transcript: engine.getTranscript(),
    lastSeq: events.at(-1)?.seq ?? 0,
    lastEventKind: events.at(-1)?.event.kind,
    eventCount: events.length,
    reason: 'important-event',
    run
  }), userData)
  runtime.registry.taskRuntimeRegistry.set(meta.id, persisted.run ?? run)
  return { meta, engine, events, attempts, dependencies }
}

async function disposeHarness(harness) {
  if (!harness) return
  await harness.engine.dispose().catch(() => undefined)
  runtime.registry.taskRuntimeRegistry.delete(harness.meta.id)
}

function currentRun(harness) {
  const run = runtime.registry.taskRuntimeRegistry.get(harness.meta.id)
  assert(run, `missing TaskRun for ${harness.meta.id}`)
  return run
}

function scriptedStream(responses, requests) {
  let index = 0
  return async (input) => {
    requests.push(structuredClone(input.request))
    const response = responses[index++]
    if (!response) throw new Error(`unexpected Anthropic request ${index}`)
    if (response instanceof Error) throw response
    for (const block of response.contentBlocks) {
      if (block.type === 'thinking') input.onThinking?.(block.thinking)
      if (block.type === 'text') input.onText?.(block.text)
    }
    return structuredClone(response)
  }
}

function messageResult(id, contentBlocks, requestUsage = usage(1, 1)) {
  const toolUses = contentBlocks.filter((block) => block.type === 'tool_use')
  return {
    id,
    text: contentBlocks.filter((block) => block.type === 'text').map((block) => block.text).join(''),
    thinking: contentBlocks
      .filter((block) => block.type === 'thinking')
      .map((block) => block.thinking)
      .join(''),
    contentBlocks,
    toolUses,
    stopReason: toolUses.length > 0 ? 'tool_use' : 'end_turn',
    usage: requestUsage
  }
}

function toolUse(id, name, input) {
  return { type: 'tool_use', id, name, input }
}

function usage(input, output, cacheRead = 0, cacheCreation = 0) {
  return { input, output, cacheRead, cacheCreation }
}

function targetFixture(secret = 'anthropic-secret-for-smoke-tool-loop') {
  return {
    providerId: 'provider-anthropic-tool-loop',
    providerName: 'Anthropic tool loop fixture',
    baseUrl: 'https://provider.invalid',
    endpoint: 'https://provider.invalid/v1/messages',
    model: 'claude-tool-loop',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': secret
    },
    token: secret,
    keyId: 'key-tool-loop',
    keyLabel: 'primary'
  }
}

function metaFixture(id, project, permissionMode) {
  return {
    id,
    title: 'Anthropic tool loop smoke',
    cwd: project,
    model: 'claude-tool-loop',
    providerId: 'provider-anthropic-tool-loop',
    engine: 'anthropic',
    permissionMode,
    status: 'idle',
    costUsd: 0,
    usage: usage(0, 0),
    contextTokens: 0,
    createdAt: Date.now(),
    isolated: false,
    unassigned: true,
    digitalWorkerBinding: { kind: 'unscoped' }
  }
}

function runFixture(sessionId, messageIds) {
  const run = runtime.taskRun.createTaskRun({
    id: `run-${sessionId}`,
    sessionId,
    taskId: sessionId,
    digitalWorkerBinding: { kind: 'unscoped' }
  })
  return {
    ...run,
    status: 'executing',
    steps: messageIds.map((messageId, index) => ({
      id: `step-${sessionId}-${index + 1}`,
      runId: run.id,
      sessionId,
      sequence: index + 1,
      status: 'executing',
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      messageId
    }))
  }
}

function fakeAttemptDependencies() {
  const calls = { start: [], complete: [], getRetryAuthorization: [] }
  let sequence = 0
  return {
    calls,
    now: () => 1_000 + sequence,
    randomId: () => `attempt-${++sequence}`,
    getRetryAuthorization: async (query, rootDir) => {
      calls.getRetryAuthorization.push({ query, rootDir })
      return null
    },
    start: async (input, rootDir) => {
      calls.start.push({ input, rootDir })
      return startedAttempt(input, calls.start.length)
    },
    complete: async (attemptId, input, rootDir) => {
      calls.complete.push({ attemptId, input, rootDir })
      const start = calls.start.find((call) => call.input.id === attemptId)
      assert(start, `missing Attempt start for ${attemptId}`)
      return {
        ...startedAttempt(start.input, calls.start.indexOf(start) + 1),
        ...input,
        id: attemptId,
        revision: 2
      }
    }
  }
}

function startedAttempt(input, ordinal) {
  return {
    schemaVersion: 1,
    ...input,
    workItemId: 'work-item-anthropic-tool-loop',
    ordinal,
    status: 'started',
    revision: 1,
    startCommandId: input.commandId,
    startPayloadDigest: 'a'.repeat(64),
    recordDigest: 'b'.repeat(64)
  }
}

function eventIndexes(events, kind) {
  return events.flatMap(({ event }, index) => event.kind === kind ? [index] : [])
}

function turnResults(events) {
  return events.filter(({ event }) => event.kind === 'turn-result').map(({ event }) => event)
}

async function waitForTurn(harness, count, label, timeoutMs = 10_000) {
  await eventually(() => turnResults(harness.events).length >= count, label, timeoutMs)
  await eventually(() => harness.engine.abort === null, `${label} cleanup`, timeoutMs)
}

async function eventually(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function check(name, fn) {
  const startedAt = Date.now()
  await fn()
  checks.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
}

function projectDirectory(name) {
  const project = path.join(tempRoot, name)
  execFileSync('mkdir', ['-p', project])
  return project
}

function compileRuntime() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/anthropicEngine.ts',
    'src/main/task/task-run.ts',
    'src/main/task/task-snapshot.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--types', 'node',
    '--lib', 'ES2022,DOM,DOM.Iterable',
    '--strict',
    '--skipLibCheck',
    '--esModuleInterop',
    '--resolveJsonModule'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function loadRuntime() {
  const originalLoad = Module._load
  try {
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'electron') return electronStub()
      return originalLoad.call(this, request, parent, isMain)
    }
    return {
      attempt: require(findCompiled(outDir, 'anthropic-model-attempt-runtime.js')),
      engine: require(findCompiled(outDir, 'anthropicEngine.js')),
      effectRuntime: require(findCompiled(outDir, 'effect-runtime.js')),
      idempotency: require(findCompiled(outDir, 'tool-idempotency.js')),
      registry: require(findCompiled(outDir, 'task-runtime-registry.js')),
      settings: require(findCompiled(outDir, 'settings.js')),
      snapshot: require(findCompiled(outDir, 'task-snapshot.js')),
      taskRun: require(findCompiled(outDir, 'task-run.js')),
      transcript: require(findCompiled(outDir, 'transcript.js')),
      tools: require(findCompiled(outDir, 'openaiTools.js'))
    }
  } finally {
    Module._load = originalLoad
  }
}

function electronStub() {
  class BrowserWindow {
    static getAllWindows() { return [] }
    static getFocusedWindow() { return null }
  }
  return {
    app: {
      getPath: () => userData,
      getAppPath: () => repoRoot,
      getVersion: () => '1.0.0-smoke',
      isPackaged: false,
      focus() {}
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => ''
    },
    BrowserWindow,
    clipboard: { readText: () => '', writeText() {} },
    desktopCapturer: { getSources: async () => [] },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    screen: { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 } }) },
    shell: { openExternal: async () => undefined, openPath: async () => '' },
    systemPreferences: { isTrustedAccessibilityClient: () => false }
  }
}

function findCompiled(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledOptional(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  throw new Error(`compiled file not found: ${fileName}`)
}

function findCompiledOptional(root, fileName) {
  try {
    return findCompiled(root, fileName)
  } catch {
    return null
  }
}
