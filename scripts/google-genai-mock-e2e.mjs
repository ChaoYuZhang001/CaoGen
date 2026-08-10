#!/usr/bin/env node
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const electronBin = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const runDir = path.join(repoRoot, 'test-results', 'google-genai-mock-e2e', runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-google-genai-e2e-'))
const userDataDir = path.join(tempRoot, 'user-data')
const isolatedOut = path.join(runDir, 'app', 'out')
const report = { runId, checks: [], screenshots: [], requests: [], warnings: [] }

if (!existsSync(electronBin) || !existsSync(mainEntry)) {
  throw new Error('Built Electron app is required. Run npm.cmd run build first.')
}

mkdirSync(runDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
copyBuiltApp(isolatedOut)

const mock = await startGoogleMock()
writeFixtureUserData(mock.port)
let app
let cdp

try {
  ;({ app, cdp } = await launch())
  const session = await evaluate(`window.agentDesk.createSession(${JSON.stringify({
    cwd: '', unassigned: true, providerId: 'gemini-mock', model: 'gemini-e2e',
    routingScope: 'fixed', taskStrategy: 'execute', title: 'Gemini mock E2E'
  })})`)

  await check('Gemini Provider creates an isolated native-engine session', async () => {
    assert.equal(session.engine, 'gemini')
    assert.equal(session.providerId, 'gemini-mock')
    assert.equal(session.model, 'gemini-e2e')
  })

  await check('real Electron session streams Gemini text with a leased Google credential', async () => {
    const accepted = await evaluate(`window.agentDesk.sendMessage(${JSON.stringify(session.id)}, 'gemini text ${runId}')`)
    assert.equal(accepted, true)
    await waitForTranscript(session.id, (entries) => entries.some((entry) =>
      entry.event?.kind === 'turn-result' && entry.event?.isError === false && entry.event?.resultText === 'Gemini text stream OK'))
    const request = mock.requests.find((item) => item.kind === 'text')
    assert(request, 'missing Gemini text request')
    assert.equal(request.googleKeyHeader, true, 'x-goog-api-key was not leased into the request')
    assert.equal(request.authorizationPresent, false, 'Google request must not inject an Authorization header')
    assert.equal(request.body?.generationConfig?.thinkingConfig?.includeThoughts, true)
    assert.equal(request.body?.generationConfig?.thinkingConfig?.thinkingLevel, 'HIGH')
  })

  await check('image input and function-call roundtrip stay on the Google wire protocol', async () => {
    const image = await evaluate(`window.agentDesk.saveImageAttachmentBytes(${JSON.stringify(session.id)}, {
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+M+1O8QAAAABJRU5ErkJggg==',
      mime: 'image/png'
    })`)
    assert.equal(image.ok, true)
    const accepted = await evaluate(`window.agentDesk.sendMessage(${JSON.stringify(session.id)}, ${JSON.stringify({
      text: `gemini image tool ${runId}`,
      images: [image]
    })})`)
    assert.equal(accepted, true)
    await waitForTranscript(session.id, (entries) => entries.some((entry) =>
      entry.event?.kind === 'turn-result' && entry.event?.isError === false && entry.event?.resultText === 'Gemini image and tool OK'))
    const imageRequest = mock.requests.find((item) => item.kind === 'image-tool')
    const toolResultRequest = mock.requests.find((item) => item.kind === 'tool-result')
    assert(imageRequest?.hasInlineImage, 'image attachment did not reach Google inlineData')
    assert(toolResultRequest?.hasFunctionResponse, 'tool result did not return through functionResponse')
    assert(toolResultRequest?.hasFunctionSignature, 'function thought signature was not replayed')
  })

  await check('usage and configured model pricing are recorded without exposing credentials', async () => {
    const usage = await evaluate('window.agentDesk.queryProviderUsage()')
    assert(usage.requests >= 3, `expected tool loop Attempts in usage: ${JSON.stringify(usage)}`)
    assert(usage.inputTokens > 0 && usage.outputTokens > 0, 'Gemini token usage was not recorded')
    assert(usage.pricedRequests > 0 && usage.costUsd > 0, 'configured Gemini pricing was not applied')
    assert(!JSON.stringify(usage).includes('gemini-e2e-secret'), 'usage API exposed the mock credential')
  })

  await check('compact real session UI stays within 760x700', async () => {
    await setViewport(760, 700)
    await sleep(300)
    const layout = await evaluate(`(() => ({
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      bodyWidth: document.body.getBoundingClientRect().width,
      viewport: window.innerWidth,
      height: window.innerHeight
    }))()`)
    assert.equal(layout.overflow, false, JSON.stringify(layout))
    assert.equal(layout.viewport, 760, JSON.stringify(layout))
    assert.equal(layout.height, 700, JSON.stringify(layout))
    await screenshot('gemini-session-compact')
    await clearViewport()
  })

  await stopApp(app, cdp)
  app = undefined
  cdp = undefined
  ;({ app, cdp } = await launch())

  await check('Gemini session transcript and signed tool history survive an Electron restart', async () => {
    let sessions = []
    await waitFor(async () => {
      sessions = await evaluate('window.agentDesk.listSessions()')
      return sessions.some((item) => item.id === session.id && item.engine === 'gemini')
    }, 20_000).catch((error) => {
      const restored = sessions.map((item) => ({ id: item.id, engine: item.engine, status: item.status }))
      throw new Error(`${error instanceof Error ? error.message : String(error)}; restored=${JSON.stringify(restored)}`)
    })
    const transcript = await evaluate(`window.agentDesk.getTranscript(${JSON.stringify(session.id)})`)
    assert(transcript.some((entry) => entry.event?.kind === 'assistant-message'), 'assistant history did not restore')
    assert(transcript.some((entry) => entry.event?.kind === 'tool-result'), 'tool history did not restore')
    await screenshot('gemini-session-restarted')
  })

  report.requests = mock.requests.map(({ body, ...request }) => ({
    ...request,
    model: body?.contents ? 'gemini-e2e' : undefined,
    hasGenerationConfig: Boolean(body?.generationConfig)
  }))
  writeFileSync(path.join(runDir, 'report.json'), `${JSON.stringify({ ...report, ok: true }, null, 2)}\n`)
  console.log(`google Gemini Electron mock E2E ok: ${runDir}`)
  console.log(`${report.checks.length}/${report.checks.length} checks passed`)
} catch (error) {
  report.requests = mock.requests.map(({ body, ...request }) => ({ ...request, hasBody: Boolean(body) }))
  report.error = error instanceof Error ? error.message : String(error)
  writeFileSync(path.join(runDir, 'report.json'), `${JSON.stringify({ ...report, ok: false }, null, 2)}\n`)
  throw error
} finally {
  if (app && cdp) await stopApp(app, cdp).catch(() => {})
  await closeServer(mock.server)
  rmSync(tempRoot, { recursive: true, force: true })
}

async function check(name, run) {
  const startedAt = Date.now()
  await run()
  report.checks.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
  console.log(`[PASS] ${name}`)
}

function writeFixtureUserData(port) {
  writeFileSync(path.join(userDataDir, 'providers.json'), JSON.stringify([{
    id: 'gemini-mock', name: 'Gemini native mock', baseUrl: `http://127.0.0.1:${port}/v1beta`,
    engine: 'gemini', authMode: 'api-key',
    encryptedToken: `b64:${Buffer.from('gemini-e2e-secret').toString('base64')}`,
    apiKeys: [{ id: 'gemini-key', label: 'e2e', encryptedToken: `b64:${Buffer.from('gemini-e2e-secret').toString('base64')}`, createdAt: Date.now() }],
    activeKeyId: 'gemini-key', credentialHeaderNames: ['x-goog-api-key'], models: ['gemini-e2e'],
    advancedConfig: {
      schemaVersion: 1,
      modelProfiles: [{ model: 'gemini-e2e', pricing: { currency: 'USD', inputPerMillion: 1, outputPerMillion: 2, source: 'user' } }],
      runtime: { gemini: { topK: 32, thinking: { includeThoughts: true, level: 'high' } } }
    },
    createdAt: Date.now()
  }], null, 2))
  writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify({
    defaultProviderId: 'gemini-mock', defaultModel: 'gemini-e2e', defaultPermissionMode: 'default',
    schedulerStrategy: 'balanced', budgetUsdPerSession: 0, failoverEnabled: false, language: 'en', theme: 'dark',
    persona: '', allowedTools: '', disallowedTools: '', office: { showBadges: true, liveliness: 1, catEars: false }
  }, null, 2))
}

async function startGoogleMock() {
  const requests = []
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !/^\/v1beta\/models\/gemini-e2e:streamGenerateContent(?:\?alt=sse)?$/.test(req.url ?? '')) {
      res.writeHead(404).end()
      return
    }
    const body = await readJson(req)
    const hasInlineImage = JSON.stringify(body?.contents ?? []).includes('inlineData')
    const hasFunctionResponse = JSON.stringify(body?.contents ?? []).includes('functionResponse')
    const hasFunctionSignature = JSON.stringify(body?.contents ?? []).includes('function-signature')
    const kind = hasFunctionResponse ? 'tool-result' : hasInlineImage ? 'image-tool' : 'text'
    requests.push({ kind, googleKeyHeader: req.headers['x-goog-api-key'] === 'gemini-e2e-secret', authorizationPresent: Boolean(req.headers.authorization), hasInlineImage, hasFunctionResponse, hasFunctionSignature, body })
    if (kind === 'image-tool') {
      writeSse(res, [{
        responseId: 'google-tool-1',
        candidates: [{ content: { role: 'model', parts: [{
          functionCall: { id: 'google-call-1', name: 'list_dir', args: { path: '.' } },
          thoughtSignature: 'function-signature'
        }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 1 }
      }])
      return
    }
    const text = kind === 'tool-result' ? 'Gemini image and tool OK' : 'Gemini text stream OK'
    writeSse(res, [
      { responseId: `google-${kind}-1`, candidates: [{ content: { role: 'model', parts: [{ text: text.slice(0, 10) }] } }] },
      { responseId: `google-${kind}-1`, candidates: [{ content: { role: 'model', parts: [{ text: text.slice(10) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 6, cachedContentTokenCount: 1 } }
    ])
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address && typeof address !== 'string')
  return { server, port: address.port, requests }
}

function writeSse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.end()
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
}

async function launch() {
  const port = await findFreePort(9970)
  const app = spawn(electronBin, [`--remote-debugging-port=${port}`, path.join(isolatedOut, 'main', 'index.js')], {
    cwd: repoRoot, env: { ...process.env, CAOGEN_USER_DATA_DIR: userDataDir, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }, stdio: 'ignore'
  })
  const target = await waitForTarget(port, 25_000)
  const cdp = await connectCdp(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await waitFor(() => evaluateWith(cdp, 'Boolean(window.agentDesk)'), 20_000)
  return { app, cdp }
}

function evaluate(expression) { return evaluateWith(cdp, expression) }

async function evaluateWith(connection, expression) {
  const result = await connection.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'renderer evaluation failed')
  return result.result?.value
}

async function waitForTranscript(sessionId, predicate) {
  let latest = []
  try {
    await waitFor(async () => {
      latest = await evaluate(`window.agentDesk.getTranscript(${JSON.stringify(sessionId)})`)
      return predicate(latest)
    }, 20_000)
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; transcript=${JSON.stringify(latest)}`)
  }
}

async function waitFor(predicate, timeout) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    if (await predicate()) return
    await sleep(150)
  }
  throw new Error('timed out waiting for Electron state')
}

async function setViewport(width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: width,
    screenHeight: height
  })
}

async function clearViewport() {
  await cdp.send('Emulation.clearDeviceMetricsOverride')
}

async function screenshot(name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const target = path.join(runDir, `${name}.png`)
  writeFileSync(target, Buffer.from(shot.data, 'base64'))
  report.screenshots.push(target)
}

async function waitForTarget(port, timeout) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const target = (await response.json()).find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (target) return target
    } catch {}
    await sleep(250)
  }
  throw new Error('Electron DevTools target did not start')
}

async function findFreePort(start) {
  for (let port = start; port < start + 200; port += 1) {
    const free = await new Promise((resolve) => {
      import('node:net').then(({ createServer }) => {
        const server = createServer()
        server.once('error', () => resolve(false))
        server.once('listening', () => server.close(() => resolve(true)))
        server.listen(port, '127.0.0.1')
      })
    })
    if (free) return port
  }
  throw new Error('no free DevTools port')
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let nextId = 1
    const pending = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const task = pending.get(message.id)
      if (!task) return
      pending.delete(message.id)
      message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result ?? {})
    })
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const id = nextId++
        ws.send(JSON.stringify({ id, method, params }))
        return new Promise((resolveSend, rejectSend) => {
          pending.set(id, { resolve: resolveSend, reject: rejectSend })
          setTimeout(() => pending.has(id) && (pending.delete(id), rejectSend(new Error(`CDP timeout: ${method}`))), 15_000)
        })
      },
      close() { ws.close() }
    }), { once: true })
    ws.addEventListener('error', () => reject(new Error('DevTools WebSocket connection failed')), { once: true })
  })
}

async function stopApp(child, connection) {
  connection.close()
  if (child.exitCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }) } catch {}
  } else child.kill('SIGTERM')
  await new Promise((resolve) => child.once('exit', resolve))
}

function closeServer(server) { return new Promise((resolve) => server.close(resolve)) }

function copyBuiltApp(target) {
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  for (const name of ['main', 'preload', 'renderer']) cpSync(path.join(repoRoot, 'out', name), path.join(target, name), { recursive: true })
  const index = path.join(target, 'renderer', 'index.html')
  if (!existsSync(index) || !readFileSync(index, 'utf8').includes('<div id="root">')) throw new Error('isolated renderer is incomplete')
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
