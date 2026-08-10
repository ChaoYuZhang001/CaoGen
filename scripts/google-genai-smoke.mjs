#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-google-genai-'))
const outDir = path.join(tempRoot, 'out')
const checks = []

try {
  compile()
  const wire = await import(pathToFileURL(path.join(outDir, 'main', 'googleGenAiAdapter.js')).href)
  const requestRuntime = await import(pathToFileURL(path.join(outDir, 'main', 'googleGenAiRequest.js')).href)
  const protocol = await import(pathToFileURL(
    path.join(outDir, 'main', 'protocol-adapters', 'google-generative-language.js')
  ).href)

  await check('request maps system, sampling, image, tools, and tool history', () => verifyRequest(wire))
  await check('typed Gemini runtime maps Thinking and sampling without Anthropic fields', () => verifyRuntime(wire, requestRuntime))
  await check('SSE maps thought signatures, text, tools, finish reason, and usage', () => verifySse(wire))
  await check('JSON responses use the same strict projection', () => verifyJson(wire))
  await check('invalid and unsafe response envelopes fail closed', () => verifyFailures(wire))
  await check('abort, malformed SSE, and bounded HTTP errors fail closed', () => verifyTransportFailures(wire))
  await check('native protocol adapter emits provider-neutral signals', () => verifyProtocol(protocol))
  console.log(JSON.stringify({ status: 'pass', pass: checks.length, total: checks.length, checks }, null, 2))
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function verifyRequest(wire) {
  const request = fixtureRequest()
  const body = wire.buildGoogleGenerateContentRequest(request)
  assert.deepEqual(body.systemInstruction, { role: 'user', parts: [{ text: 'System rules' }] })
  assert.deepEqual(body.generationConfig, {
    maxOutputTokens: 4096, temperature: 0.4, topP: 0.8, topK: 32
  })
  assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'image/png')
  assert.equal(body.contents[1].parts[0].functionCall.id, 'call-1')
  assert.equal(body.contents[1].parts[0].thoughtSignature, 'tool-replay-signature')
  assert.deepEqual(body.contents[2].parts[0].functionResponse, {
    id: 'call-1', name: 'read_file', response: { output: 'file contents' }
  })
  assert.equal(body.tools[0].functionDeclarations[0].parametersJsonSchema.type, 'object')
  assert.equal(body.contents[0].parts.some((part) => 'apiKey' in part), false)
}

function verifyRuntime(wire, requestRuntime) {
  const request = requestRuntime.applyGoogleRuntimeToRequest(fixtureRequest(), {
    temperature: 0.7,
    topP: 0.91,
    maxOutputTokens: 12288,
    anthropic: { topK: 999 },
    gemini: {
      topK: 48,
      thinking: { includeThoughts: true, level: 'high' }
    }
  })
  const body = wire.buildGoogleGenerateContentRequest(request)
  assert.deepEqual(body.generationConfig, {
    thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' },
    maxOutputTokens: 12288,
    temperature: 0.7,
    topP: 0.91,
    topK: 48
  })
  assert.equal(JSON.stringify(body).includes('anthropic'), false)
}

async function verifySse(wire) {
  const seen = []
  const chunks = [
    googleResponse({
      responseId: 'response-1',
      parts: [{ text: 'reason', thought: true }],
      usageMetadata: {
        promptTokenCount: 11, candidatesTokenCount: 5,
        thoughtsTokenCount: 7, cachedContentTokenCount: 3
      }
    }),
    googleResponse({
      responseId: 'response-1',
      parts: [
        { text: 'ing', thought: true },
        { thoughtSignature: 'opaque-signature' },
        { text: 'answer' },
        {
          functionCall: { id: 'call-2', name: 'list_dir', args: { path: '.' } },
          thoughtSignature: 'function-signature'
        }
      ],
      finishReason: 'STOP'
    })
  ]
  const result = await wire.streamGoogleGenAiMessage({
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-smoke:streamGenerateContent?alt=sse',
    headers: { 'content-type': 'application/json' },
    request: fixtureRequest(),
    signal: new AbortController().signal,
    onThinking: (text) => seen.push(`thinking:${text}`),
    onText: (text) => seen.push(`text:${text}`),
    fetch: async () => sseResponse(chunks, [1, 2, 7, 3, 19])
  })
  assert.deepEqual(seen, ['thinking:reason', 'thinking:ing', 'text:answer'])
  assert.equal(result.id, 'response-1')
  assert.equal(result.stopReason, 'tool_use')
  assert.equal(result.contentBlocks[0].signature, 'opaque-signature')
  assert.deepEqual(result.toolUses[0], {
    type: 'tool_use', id: 'call-2', name: 'list_dir', input: { path: '.' },
    signature: 'function-signature'
  })
  assert.deepEqual(result.usage, { input: 11, output: 12, cacheRead: 3, cacheCreation: 0 })
}

async function verifyJson(wire) {
  const result = await wire.streamGoogleGenAiMessage({
    endpoint: 'https://example.invalid',
    headers: {},
    request: fixtureRequest(),
    signal: new AbortController().signal,
    fetch: async () => new Response(JSON.stringify(googleResponse({
      responseId: 'json-1',
      parts: [{ text: 'complete' }],
      finishReason: 'STOP',
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 }
    })), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  assert.equal(result.text, 'complete')
  assert.equal(result.stopReason, 'end_turn')
  assert.deepEqual(result.usage, { input: 2, output: 1, cacheRead: 0, cacheCreation: 0 })
}

async function verifyFailures(wire) {
  await assert.rejects(
    () => wire.streamGoogleGenAiMessage({
      endpoint: 'https://example.invalid', headers: {}, request: fixtureRequest(),
      signal: new AbortController().signal,
      fetch: async () => new Response(JSON.stringify({ candidates: [] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    }),
    /no candidate/
  )
  await assert.rejects(
    () => wire.streamGoogleGenAiMessage({
      endpoint: 'https://example.invalid', headers: {}, request: fixtureRequest(),
      signal: new AbortController().signal,
      fetch: async () => new Response(JSON.stringify(googleResponse({
        parts: [{ text: 'blocked' }], finishReason: 'SAFETY'
      })), { status: 200, headers: { 'content-type': 'application/json' } })
    }),
    /stopped with SAFETY/
  )
  await assert.rejects(
    () => wire.streamGoogleGenAiMessage({
      endpoint: 'https://example.invalid', headers: {}, request: fixtureRequest(),
      signal: new AbortController().signal,
      fetch: async () => new Response(JSON.stringify(googleResponse({
        parts: [{ text: 'unsigned thought', thought: true }], finishReason: 'STOP'
      })), { status: 200, headers: { 'content-type': 'application/json' } })
    }),
    /missing its replay signature/
  )
}

async function verifyTransportFailures(wire) {
  await assert.rejects(
    () => wire.streamGoogleGenAiMessage({
      endpoint: 'https://example.invalid', headers: {}, request: fixtureRequest(),
      signal: new AbortController().signal,
      fetch: async () => new Response('data: {bad-json}\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' }
      })
    }),
    /invalid JSON/
  )
  await assert.rejects(
    () => wire.streamGoogleGenAiMessage({
      endpoint: 'https://example.invalid', headers: {}, request: fixtureRequest(),
      signal: new AbortController().signal,
      fetch: async () => new Response(JSON.stringify({ error: { message: 'denied', detail: 'secret-must-not-surface' } }), {
        status: 401, statusText: 'Unauthorized', headers: { 'content-type': 'application/json' }
      })
    }),
    (error) => error.status === 401 && /denied/.test(error.message) && !/secret-must-not-surface/.test(error.message)
  )
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => wire.streamGoogleGenAiMessage({
      endpoint: 'https://example.invalid', headers: {}, request: fixtureRequest(),
      signal: controller.signal,
      fetch: async (_url, init) => {
        if (init.signal.aborted) throw init.signal.reason
        throw new Error('abort signal was not forwarded')
      }
    })
  )
}

function verifyProtocol(runtime) {
  const adapter = runtime.GOOGLE_GENERATIVE_LANGUAGE_PROTOCOL_ADAPTER
  assert.equal(adapter.engineKind, 'gemini')
  assert.equal(adapter.protocol, 'google.generative-language')
  assert.deepEqual(adapter.normalizeUsage({
    promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 2, cachedContentTokenCount: 3
  }), { input: 10, output: 6, cacheRead: 3, cacheCreation: 0 })
  const signals = adapter.decodeStreamChunk(googleResponse({
    parts: [{ text: 'visible' }, { text: 'hidden', thought: true }], finishReason: 'STOP'
  }))
  assert.deepEqual(signals.slice(0, 3), [
    { kind: 'text', text: 'visible' },
    { kind: 'thinking', text: 'hidden' },
    { kind: 'done', stopReason: 'STOP' }
  ])
}

function fixtureRequest() {
  return {
    model: 'gemini-smoke',
    maxTokens: 4096,
    system: 'System rules',
    temperature: 0.4,
    topP: 0.8,
    topK: 32,
    messages: [
      { role: 'user', content: [
        { type: 'text', text: 'Inspect image' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } }
      ] },
      { role: 'assistant', content: [
        {
          type: 'tool_use', id: 'call-1', name: 'read_file',
          input: { path: 'README.md' }, signature: 'tool-replay-signature'
        }
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call-1', content: 'file contents' }
      ] }
    ],
    tools: [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object' } }]
  }
}

function googleResponse({ responseId, parts, finishReason, usageMetadata }) {
  return {
    ...(responseId ? { responseId } : {}),
    candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }],
    ...(usageMetadata ? { usageMetadata } : {})
  }
}

function sseResponse(chunks, chunkSizes = []) {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')
  const bytes = new TextEncoder().encode(body)
  let offset = 0
  const pieces = []
  for (const size of chunkSizes) {
    if (offset >= bytes.length) break
    pieces.push(bytes.slice(offset, Math.min(bytes.length, offset + size)))
    offset += size
  }
  if (offset < bytes.length) pieces.push(bytes.slice(offset))
  return new Response(new ReadableStream({
    start(controller) {
      for (const piece of pieces.length > 0 ? pieces : [bytes]) controller.enqueue(piece)
      controller.close()
    }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function compile() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/googleGenAiAdapter.ts',
    'src/main/googleGenAiRequest.ts',
    'src/main/protocol-adapters/google-generative-language.ts',
    '--outDir', outDir,
    '--rootDir', 'src',
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

async function check(name, run) {
  await run()
  checks.push({ name, status: 'pass' })
  console.log(`[PASS] ${name}`)
}
