#!/usr/bin/env node
import http from 'node:http'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const outDir = path.join(repoRoot, 'test-results', 'orchestration-mock-e2e')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const runDir = path.join(outDir, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-orchestration-mock-'))
const userDataDir = path.join(tempRoot, 'userData')
const projectDir = path.join(tempRoot, 'project')
const electronBin =
  process.platform === 'win32'
    ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const sourceOutDir = path.join(repoRoot, 'out')
const sourceMainEntry = path.join(sourceOutDir, 'main', 'index.js')
const sourceRendererEntry = path.join(sourceOutDir, 'renderer', 'index.html')
const isolatedOutDir = path.join(runDir, 'app', 'out')
const mainEntry = path.join(isolatedOutDir, 'main', 'index.js')

if (!existsSync(electronBin)) fail('Electron binary not found. Run npm install first.')
if (!existsSync(sourceMainEntry)) fail('Built Electron main entry not found. Run npm run build first.')
if (!existsSync(sourceRendererEntry)) fail('Built Electron renderer entry not found. Run npm run build first.')

mkdirSync(runDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
mkdirSync(projectDir, { recursive: true })
copyBuiltApp(isolatedOutDir)
writeFileSync(path.join(projectDir, 'README.md'), '# CaoGen orchestration mock e2e\n')

const report = {
  runId,
  runDir,
  projectDir,
  userDataDir,
  checks: [],
  screenshots: [],
  warnings: [],
  requests: []
}

const mock = await startOpenAiMock()
writeMockUserData(mock.port)
const remotePort = await findFreePort(9820)
const app = spawn(electronBin, [`--remote-debugging-port=${remotePort}`, mainEntry], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CAOGEN_USER_DATA_DIR: userDataDir,
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: '',
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '',
    CLAUDE_CODE_HOST_CREDS_FILE: '',
    CLAUDE_CODE_HOST_AUTH_ENV_VAR: '',
    CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '',
    CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

let stdout = ''
let stderr = ''
app.stdout.on('data', (chunk) => {
  stdout += chunk.toString()
})
app.stderr.on('data', (chunk) => {
  stderr += chunk.toString()
})

let browser
try {
  await waitForDebugPort(remotePort, 20_000)
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${remotePort}`, defaultViewport: null })
  const pages = await browser.pages()
  const page = pages.find((item) => !item.url().startsWith('devtools://')) || pages[0]
  if (!page) throw new Error('Electron page target not found')
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') report.warnings.push(`console ${msg.type()}: ${msg.text()}`)
  })
  page.on('pageerror', (error) => report.warnings.push(`pageerror: ${error.message}`))

  await page.waitForSelector('.app', { timeout: 20_000 })
  await waitForAgentDesk(page)
  await page.evaluate(() => {
    window.__orchestrationEvents = []
    window.agentDesk.onSessionEvent((sessionId, event, seq) => {
      window.__orchestrationEvents.push({ sessionId, event, seq })
    })
  })

  let parent
  let dispatch
  await check('parent session and child sessions dispatch through real preload IPC', async () => {
    parent = await page.evaluate((cwd) => {
      return window.agentDesk.createSession({
        cwd,
        engine: 'openai',
        providerId: 'mock-openai',
        model: 'mock-responses',
        isolated: false,
        title: 'A3 orchestration parent'
      })
    }, projectDir)
    dispatch = await page.evaluate((parentId) => {
      return window.agentDesk.dispatchSubagents(parentId, {
        isolated: false,
        tasks: [
          {
            id: 'api',
            role: 'backend',
            title: 'API child',
            prompt: 'A3 child api: return a short backend result.'
          },
          {
            id: 'ui',
            role: 'frontend',
            title: 'UI child',
            prompt: 'A3 child ui: return a short frontend result.'
          }
        ]
      })
    }, parent.id)
    assert(parent.id, 'parent id missing')
    assert(dispatch.children.length === 2, `expected 2 child sessions, got ${dispatch.children.length}`)
    assert(dispatch.children.every((child) => child.meta.parentSessionId === parent.id), 'child parentSessionId mismatch')
  })

  await check('child turn-results are reflected as parent subagent results and summary injection', async () => {
    const state = await waitForValue(
      () =>
        page.evaluate(async (parentId) => {
          const entries = await window.agentDesk.getTranscript(parentId)
          const liveEvents = Array.isArray(window.__orchestrationEvents) ? window.__orchestrationEvents : []
          const summaryIndex = entries.findIndex(
            (entry) =>
              entry.event?.kind === 'user-message' &&
              typeof entry.event.text === 'string' &&
              entry.event.text.includes('[子代理编排完成]')
          )
          const childResults = liveEvents.filter(
            (entry) => entry.sessionId === parentId && entry.event?.kind === 'subagent-result'
          )
          const parentReply =
            summaryIndex >= 0 &&
            entries.slice(summaryIndex + 1).some((entry) => entry.event?.kind === 'turn-result' && !entry.event.isError)
          const metas = await window.agentDesk.listSessions()
          return {
            summaryIndex,
            childResultCount: childResults.length,
            parentReply,
            children: metas.filter((meta) => meta.parentSessionId === parentId)
          }
        }, parent.id),
      (value) => value.summaryIndex >= 0 && value.childResultCount === 2 && value.parentReply && value.children.length === 2,
      30_000,
      'waiting for orchestration result fan-in'
    )
    assert(state.children.every((child) => child.orchestrationId === dispatch.orchestrationId), 'child orchestrationId mismatch')
  })
  await screenshot(page, '01-orchestration-complete')

  await check('mock requests prove child prompts and parent summary ran through the model path', async () => {
    assert(mock.requests.length >= 3, `expected at least 3 model requests, got ${mock.requests.length}`)
    const bodies = mock.requests.map((request) => JSON.stringify(request.body))
    assert(bodies.some((body) => body.includes('A3 child api')), 'api child prompt missing from mock requests')
    assert(bodies.some((body) => body.includes('A3 child ui')), 'ui child prompt missing from mock requests')
    assert(bodies.some((body) => body.includes('子代理编排完成')), 'parent summary prompt missing from mock requests')
    report.requests = mock.requests
  })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app', { timeout: 20_000 })
  await waitForAgentDesk(page)
  await page.waitForFunction(() => document.body.innerText.includes('A3 orchestration parent'), { timeout: 15_000 })
  await page.click('.sidebar-office')
  await page.waitForSelector('.office canvas', { timeout: 20_000 })

  await check('3D office model exposes parent-child Subagent packets', async () => {
    const attrs = await waitForValue(
      () =>
        page.evaluate(() => {
          const wrap = document.querySelector('.office-canvas-wrap')
          return {
            packets: Number(wrap?.getAttribute('data-office-packets') ?? 0),
            subagentPackets: Number(wrap?.getAttribute('data-office-subagent-packets') ?? 0)
          }
        }),
      (value) => value.subagentPackets === 2 && value.packets >= 2,
      15_000,
      'waiting for office subagent packets'
    )
    assert(attrs.subagentPackets === 2, `wrong subagent packet count: ${JSON.stringify(attrs)}`)
  })

  await check('3D office canvas renders nonblank with parent and child workstations', async () => {
    const stats = await waitForCanvasPixels(page)
    report.officeCanvas = stats
  })
  await screenshot(page, '02-office-subagent-packets')
} catch (error) {
  report.error = error instanceof Error ? error.stack || error.message : String(error)
  if (!report.checks.some((item) => item.status === 'fail')) {
    report.checks.push({
      name: 'orchestration mock e2e runtime',
      status: 'fail',
      durationMs: 0,
      error: error instanceof Error ? error.message : String(error)
    })
  }
  process.exitCode = 1
} finally {
  if (browser) await browser.disconnect().catch(() => undefined)
  const exited = await terminate(app)
  await closeServer(mock.server)
  report.requests = mock.requests
  report.warnings.push(...summarizeProcessOutput(stdout, stderr, exited))
  writeFileSync(path.join(runDir, 'orchestration-mock-e2e.json'), JSON.stringify(report, null, 2))
  cleanupTempRoot(tempRoot)
}

const failed = report.checks.filter((item) => item.status === 'fail')
if (failed.length > 0) {
  console.error(`orchestration mock e2e failed: ${failed.map((item) => item.name).join(', ')}`)
  process.exitCode = 1
} else {
  console.log(`orchestration mock e2e ok: ${runDir}`)
}

async function check(name, fn) {
  const startedAt = Date.now()
  try {
    await fn()
    report.checks.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
  } catch (error) {
    report.checks.push({
      name,
      status: 'fail',
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}

async function screenshot(page, name) {
  const file = path.join(runDir, `${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  report.screenshots.push(file)
}

async function startOpenAiMock() {
  const requests = []
  const server = http.createServer(async (req, res) => {
    if (req.url !== '/v1/responses' || req.method !== 'POST') {
      res.writeHead(404)
      res.end('not found')
      return
    }
    const body = await readJson(req)
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization || '', body })
    const text = JSON.stringify(body)
    const reply = text.includes('子代理编排完成')
      ? 'Parent summary acknowledged both subagent results.'
      : text.includes('A3 child api')
        ? 'API child result: backend route implemented.'
        : text.includes('A3 child ui')
          ? 'UI child result: frontend panel implemented.'
          : 'Mock orchestration response.'
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    for (const piece of reply.match(/.{1,12}/g) || []) {
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: piece })}\n\n`)
      await sleep(15)
    }
    res.write(
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: `resp_orchestration_${Date.now()}`,
          output_text: reply,
          usage: {
            input_tokens: 41,
            output_tokens: 13,
            input_tokens_details: { cached_tokens: 3 }
          }
        }
      })}\n\n`
    )
    res.write('data: [DONE]\n\n')
    res.end()
  })
  const port = await findFreePort(8840)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return { server, port, requests }
}

function writeMockUserData(port) {
  writeFileSync(
    path.join(userDataDir, 'providers.json'),
    JSON.stringify(
      [
        {
          id: 'mock-openai',
          name: 'CaoGen Orchestration Mock',
          baseUrl: `http://127.0.0.1:${port}`,
          encryptedToken: `b64:${Buffer.from('mock-key').toString('base64')}`,
          models: ['mock-responses'],
          openaiProtocol: 'responses',
          note: 'Local orchestration e2e provider; no real API key required.',
          createdAt: Date.now()
        }
      ],
      null,
      2
    )
  )
  writeFileSync(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify(
      {
        defaultModel: 'mock-responses',
        defaultPermissionMode: 'default',
        defaultProviderId: 'mock-openai',
        schedulerStrategy: 'balanced',
        budgetUsdPerSession: 0,
        failoverEnabled: true,
        language: 'zh',
        theme: 'dark',
        persona: '',
        allowedTools: '',
        disallowedTools: '',
        office: { showBadges: true, liveliness: 1, catEars: false }
      },
      null,
      2
    )
  )
}

async function waitForCanvasPixels(page, timeout = 15_000) {
  let lastStats = null
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    lastStats = await page.evaluate(() => {
      const canvas = document.querySelector('.office canvas')
      if (!canvas) return { canvas: false }
      const width = canvas.width
      const height = canvas.height
      const rect = canvas.getBoundingClientRect()
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
      if (!gl || width < 100 || height < 100 || rect.width < 300 || rect.height < 200) {
        return { canvas: true, gl: Boolean(gl), width, height, rectWidth: rect.width, rectHeight: rect.height, colorSum: 0, dataUrlLength: canvas.toDataURL('image/png').length }
      }
      const xs = [0.18, 0.33, 0.5, 0.67, 0.82]
      const ys = [0.2, 0.38, 0.55, 0.72, 0.88]
      const pixel = new Uint8Array(4)
      let colorSum = 0
      let alphaSum = 0
      let samples = 0
      for (const xRatio of xs) {
        for (const yRatio of ys) {
          const x = Math.max(0, Math.min(width - 1, Math.floor(width * xRatio)))
          const y = Math.max(0, Math.min(height - 1, Math.floor(height * yRatio)))
          gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
          colorSum += pixel[0] + pixel[1] + pixel[2]
          alphaSum += pixel[3]
          samples += 1
        }
      }
      return { canvas: true, gl: true, width, height, rectWidth: rect.width, rectHeight: rect.height, colorSum, alphaSum, samples, dataUrlLength: canvas.toDataURL('image/png').length }
    })
    if (
      lastStats?.canvas &&
      lastStats.gl &&
      lastStats.width >= 100 &&
      lastStats.height >= 100 &&
      lastStats.rectWidth >= 300 &&
      lastStats.rectHeight >= 200 &&
      ((lastStats.colorSum ?? 0) > 500 || (lastStats.dataUrlLength ?? 0) > 10_000)
    ) {
      return lastStats
    }
    await sleep(300)
  }
  throw new Error(`3D office canvas did not become visibly nonblank: ${JSON.stringify(lastStats)}`)
}

async function waitForAgentDesk(page) {
  await page.waitForFunction(() => typeof window.agentDesk?.createSession === 'function', { timeout: 15_000 })
}

async function waitForValue(producer, predicate, timeout, label) {
  const startedAt = Date.now()
  let last
  while (Date.now() - startedAt < timeout) {
    last = await producer()
    if (predicate(last)) return last
    await sleep(250)
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`)
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

async function waitForDebugPort(port, timeoutMs) {
  const startedAt = Date.now()
  let lastError
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return
      lastError = new Error(`HTTP ${res.status}`)
    } catch (error) {
      lastError = error
    }
    await sleep(200)
  }
  throw new Error(`Timed out waiting for CDP port ${port}: ${lastError?.message || lastError}`)
}

async function findFreePort(start) {
  for (let port = start; port < start + 200; port += 1) {
    if (await canListen(port)) return port
  }
  throw new Error(`no free port from ${start}`)
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function terminate(child) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode }
  child.kill('SIGTERM')
  const result = await Promise.race([
    new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
    sleep(3000).then(() => {
      child.kill('SIGKILL')
      return { code: child.exitCode, signal: child.signalCode ?? 'SIGKILL' }
    })
  ])
  return result
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve))
}

function summarizeProcessOutput(out, err, exited) {
  const warnings = []
  const stderrText = err.trim()
  if (stderrText) warnings.push(`[stderr tail]\n${stderrText.slice(-2000)}`)
  if (out.trim()) warnings.push(`[stdout tail]\n${out.trim().slice(-1000)}`)
  if (exited.signal) warnings.push(`Electron exited by signal ${exited.signal}`)
  return warnings
}

function cleanupTempRoot(root) {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // best effort
  }
}

function copyBuiltApp(targetOutDir) {
  rmSync(targetOutDir, { recursive: true, force: true })
  mkdirSync(targetOutDir, { recursive: true })
  for (const dirName of ['main', 'preload', 'renderer']) {
    cpSync(path.join(sourceOutDir, dirName), path.join(targetOutDir, dirName), { recursive: true })
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
