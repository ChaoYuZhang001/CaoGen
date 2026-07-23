#!/usr/bin/env node
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const outDir = path.join(repoRoot, 'test-results', 'start-suggestions-e2e')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const runDir = path.join(outDir, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-start-suggestions-e2e-'))
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
prepareProject()

const report = {
  runId,
  runDir,
  projectDir,
  userDataDir,
  checks: [],
  screenshots: [],
  warnings: [],
  requests: [],
  apiSuggestions: []
}

const mock = await startOpenAiMock()
writeMockUserData(mock.port)
writeSeedHistory()
const remotePort = await findFreePort(9840)
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
let session
let suggestions = []
try {
  await waitForDebugPort(remotePort, 20_000)
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${remotePort}`, defaultViewport: null })
  const page = await waitForElectronPage(browser, 20_000)
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      report.warnings.push(`console ${msg.type()}: ${msg.text()}`)
    }
  })
  page.on('pageerror', (error) => report.warnings.push(`pageerror: ${error.message}`))

  await page.waitForSelector('.app', { timeout: 20_000 })
  await waitForAgentDesk(page)

  await check('seed session, scoped memory, and routines through preload IPC', async () => {
    session = await page.evaluate((cwd) => {
      return window.agentDesk.createSession({
        cwd,
        engine: 'openai',
        providerId: 'mock-openai',
        model: 'mock-responses',
        isolated: true,
        title: 'A4 start suggestions'
      })
    }, projectDir)
    assert(session?.id, 'session id missing')
    assert(session.isolated === true, `expected isolated session, got ${JSON.stringify(session)}`)

    const seeded = await page.evaluate(async (sessionId, cwd) => {
      const draft = await window.agentDesk.proposeMemoryDraft(sessionId, {
        kind: 'failure',
        title: 'Last run failed',
        body: 'blocked by runtime error in A4 branch',
        source: 'a4-e2e',
        reason: 'failure smoke'
      })
      const memory = await window.agentDesk.acceptMemoryDraft(sessionId, draft.id)
      const unrelatedRoutine = await window.agentDesk.createRoutine({
        id: 'routine-unrelated-failed',
        name: 'Unrelated failed routine marker',
        prompt: 'failed unrelated routine marker must stay out of this project',
        projectCwd: `${cwd}-unrelated`,
        schedule: '@daily',
        enabled: true,
        providerId: 'unrelated-provider',
        model: 'unrelated-model',
        engine: 'openai'
      })
      const routine = await window.agentDesk.createRoutine({
        id: 'routine-a4-failed',
        name: 'Failed nightly routine',
        prompt: 'failed validation needs repair before continuing',
        projectCwd: cwd,
        schedule: '@daily',
        enabled: true,
        providerId: 'mock-openai',
        model: 'mock-responses',
        engine: 'openai'
      })
      return { memory, routine, unrelatedRoutine }
    }, session.id, projectDir)
    assert(seeded.memory?.id, 'accepted memory entry missing')
    assert(seeded.routine?.id === 'routine-a4-failed', 'routine seed mismatch')
    assert(seeded.unrelatedRoutine?.id === 'routine-unrelated-failed', 'unrelated routine seed mismatch')
  })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app', { timeout: 20_000 })
  await waitForAgentDesk(page)
  await page.waitForFunction(() => document.body.innerText.includes('A4 start suggestions'), { timeout: 15_000 })

  await check('session activation does not render start suggestions by default', async () => {
    await sleep(750)
    const rendered = await readRenderedSuggestions(page)
    assert(rendered.panel === false, `start suggestions opened automatically: ${JSON.stringify(rendered)}`)
    assert(rendered.status === '', `start suggestions started loading automatically: ${JSON.stringify(rendered)}`)
    report.renderedBeforeOpen = rendered
  })
  await screenshot(page, '01-session-default-no-suggestions')

  await check('manual menu action loads and renders scoped start suggestions', async () => {
    await page.click('.header-more > button')
    await page.waitForSelector('[data-header-action="start-suggestions"]', { visible: true, timeout: 5_000 })
    await page.click('[data-header-action="start-suggestions"]')
    const rendered = await waitForValue(
      () => readRenderedSuggestions(page),
      (value) => value.panel && value.visible > 0 && value.items.length > 0,
      15_000,
      'waiting for start suggestions panel'
    )
    assert(rendered.items.length > 0, `no rendered suggestion items: ${JSON.stringify(rendered)}`)
    assert(
      rendered.items.some((item) => item.source === 'memory' || item.source === 'routine' || item.source === 'git-status'),
      `visible source mapping missing expected sources: ${JSON.stringify(rendered.items)}`
    )
    report.renderedInitial = rendered
  })
  await screenshot(page, '02-start-suggestions-panel')

  await check('start suggestion IPC maps memory, routine, history, worktree, git, and package sources', async () => {
    const result = await page.evaluate(async (sessionId) => {
      const started = performance.now()
      const suggestions = await window.agentDesk.getStartSuggestions(sessionId)
      return {
        durationMs: Math.round(performance.now() - started),
        suggestions
      }
    }, session.id)
    suggestions = result.suggestions
    report.apiDurationMs = result.durationMs
    report.apiSuggestions = suggestions
    assert(result.durationMs < 3000, `startSuggestions:get took too long: ${result.durationMs}ms`)
    assertHasSuggestion(suggestions, 'memory-failure', 'memory')
    assertHasSuggestion(suggestions, 'routine-failure', 'routine')
    assertHasSuggestion(suggestions, 'recent-failure', 'recent-failure')
    assertHasSuggestion(suggestions, 'history-continue', 'history')
    assertHasSuggestion(suggestions, 'worktree-review', 'worktree')
    assertHasSuggestion(suggestions, 'git-dirty', 'git-status')
    assert(
      suggestions.some((item) => item.id === 'package-verify' && item.source === 'package-json'),
      `missing package-json verification suggestion: ${describeSuggestions(suggestions)}`
    )
    const scopedSignals = ['recent-failure', 'routine-failure', 'history-continue']
      .map((suggestionId) => suggestions.find((item) => item.id === suggestionId)?.body || '')
      .join('\n')
    assert(
      !/unrelated (provider|routine|history)/i.test(scopedSignals),
      `unrelated project/provider signals leaked into suggestions: ${scopedSignals}`
    )
    assert(
      scopedSignals.includes('current provider failure marker'),
      `current provider failure was not retained: ${scopedSignals}`
    )
  })

  await check('ignore action removes one rendered suggestion without leaving the panel blank', async () => {
    const before = await readRenderedSuggestions(page)
    const target = before.items[0]
    assert(target?.id, `no item to ignore: ${JSON.stringify(before)}`)
    await page.click(`[data-start-suggestion-id="${target.id}"] [data-start-suggestion-action="ignore"]`)
    const after = await waitForValue(
      () => readRenderedSuggestions(page),
      (value) => value.items.every((item) => item.id !== target.id) && value.items.length > 0,
      8_000,
      `waiting for ignored suggestion ${target.id} to disappear`
    )
    report.ignoredSuggestionId = target.id
    report.renderedAfterIgnore = after
  })

  await check('send action posts suggestion prompt to the active session transcript', async () => {
    const ready = await waitForValue(
      () => readRenderedSuggestions(page),
      (value) => value.items.length > 0 && value.sendButtonDisabled === false,
      10_000,
      'waiting for send button to be enabled'
    )
    const target = ready.items[0]
    const apiSuggestion = suggestions.find((item) => item.id === target.id)
    assert(apiSuggestion?.prompt, `missing API prompt for rendered suggestion ${target.id}`)
    await page.click(`[data-start-suggestion-id="${target.id}"] [data-start-suggestion-action="send"]`)
    const transcript = await waitForValue(
      () =>
        page.evaluate(async (sessionId) => {
          const entries = await window.agentDesk.getTranscript(sessionId)
          return entries
            .filter((entry) => entry.event?.kind === 'user-message')
            .map((entry) => entry.event.text)
        }, session.id),
      (messages) => messages.some((text) => typeof text === 'string' && text.includes(apiSuggestion.prompt.slice(0, 60))),
      15_000,
      `waiting for sent suggestion prompt ${target.id}`
    )
    const after = await waitForValue(
      () => readRenderedSuggestions(page),
      (value) => value.items.every((item) => item.id !== target.id),
      8_000,
      `waiting for sent suggestion ${target.id} to be ignored locally`
    )
    await waitForValue(
      () => mock.requests.length,
      (requestCount) => requestCount >= 1,
      15_000,
      'waiting for mock OpenAI server to receive the sent suggestion turn'
    )
    report.sentSuggestionId = target.id
    report.sentPrompt = apiSuggestion.prompt
    report.userMessages = transcript
    report.renderedAfterSend = after
  })
  await screenshot(page, '03-start-suggestion-sent')
} catch (error) {
  report.error = error instanceof Error ? error.stack || error.message : String(error)
  if (!report.checks.some((item) => item.status === 'fail')) {
    report.checks.push({
      name: 'start suggestions e2e runtime',
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
  writeFileSync(path.join(runDir, 'start-suggestions-e2e.json'), JSON.stringify(report, null, 2))
  cleanupTempRoot(tempRoot)
}

const failed = report.checks.filter((item) => item.status === 'fail')
if (failed.length > 0) {
  console.error(`start suggestions e2e failed: ${failed.map((item) => item.name).join(', ')}`)
  process.exitCode = 1
} else {
  console.log(`start suggestions e2e ok: ${runDir}`)
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

async function readRenderedSuggestions(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-start-suggestions-panel="true"]')
    const items = Array.from(document.querySelectorAll('[data-start-suggestion-id]')).map((item) => ({
      id: item.getAttribute('data-start-suggestion-id') || '',
      source: item.getAttribute('data-start-suggestion-source') || '',
      priority: item.getAttribute('data-priority') || '',
      title: item.querySelector('.start-suggestions-item-title')?.textContent?.trim() || ''
    }))
    const sendButton = document.querySelector('[data-start-suggestion-action="send"]')
    const status = document.querySelector('[data-start-suggestions-status]')
    return {
      panel: Boolean(panel),
      visible: Number(panel?.getAttribute('data-start-suggestions-visible') || 0),
      total: Number(panel?.getAttribute('data-start-suggestions-total') || 0),
      items,
      status: status?.getAttribute('data-start-suggestions-status') || '',
      sendButtonDisabled: sendButton ? sendButton.disabled === true : true,
      bodyText: document.body.innerText.slice(0, 800)
    }
  })
}

async function screenshot(page, name) {
  const file = path.join(runDir, `${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  report.screenshots.push(file)
}

function prepareProject() {
  writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify(
      {
        name: 'a4-start-suggestions-project',
        scripts: {
          typecheck: 'tsc --noEmit',
          build: 'vite build'
        }
      },
      null,
      2
    ),
    'utf8'
  )
  writeFileSync(path.join(projectDir, 'README.md'), '# A4 start suggestions\n\nTODO: finish baseline.\n', 'utf8')
  writeFileSync(path.join(projectDir, 'package-lock.json'), '{"lockfileVersion":3}\n', 'utf8')
  git(projectDir, ['init'])
  git(projectDir, ['config', 'user.email', 'a4@example.test'])
  git(projectDir, ['config', 'user.name', 'A4 Start Suggestions E2E'])
  git(projectDir, ['add', 'package.json', 'README.md', 'package-lock.json'])
  git(projectDir, ['commit', '-m', 'initial'])
  writeFileSync(
    path.join(projectDir, 'README.md'),
    '# A4 start suggestions\n\nTODO: failed validation branch must be repaired.\n',
    'utf8'
  )
}

function writeSeedHistory() {
  writeFileSync(
    path.join(userDataDir, 'sessions.json'),
    JSON.stringify(
      [
        {
          id: 'hist-unrelated-start-suggestions',
          title: 'Continue unrelated history marker',
          cwd: `${projectDir}-unrelated`,
          model: 'unrelated-model',
          providerId: 'unrelated-provider',
          permissionMode: 'default',
          sdkSessionId: 'hist-sdk-unrelated-start-suggestions',
          createdAt: Date.now() - 40_000,
          updatedAt: Date.now() - 20_000,
          costUsd: 0
        },
        {
          id: 'hist-a4-start-suggestions',
          title: 'Continue unfinished validation branch',
          cwd: projectDir,
          model: 'mock-responses',
          providerId: 'mock-openai',
          permissionMode: 'default',
          sdkSessionId: 'hist-sdk-a4-start-suggestions',
          createdAt: Date.now() - 60_000,
          updatedAt: Date.now() - 30_000,
          costUsd: 0
        }
      ],
      null,
      2
    )
  )
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
    const reply = 'Mock A4 start suggestion accepted.'
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
          id: `resp_start_suggestions_${Date.now()}`,
          output_text: reply,
          usage: {
            input_tokens: 37,
            output_tokens: 8,
            input_tokens_details: { cached_tokens: 2 }
          }
        }
      })}\n\n`
    )
    res.write('data: [DONE]\n\n')
    res.end()
  })
  const port = await findFreePort(8860)
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
          name: 'CaoGen A4 Mock',
          baseUrl: `http://127.0.0.1:${port}`,
          encryptedToken: `b64:${Buffer.from('mock-key').toString('base64')}`,
          models: ['mock-responses'],
          openaiProtocol: 'responses',
          note: 'Local start suggestions e2e provider; no real API key required.',
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
        autoSkillLearningEnabled: false,
        office: { showBadges: true, liveliness: 1, catEars: false }
      },
      null,
      2
    )
  )
  writeFileSync(
    path.join(userDataDir, 'provider-health.json'),
    JSON.stringify(
      {
        version: 1,
        providers: {
          'unrelated-provider': {
            providerId: 'unrelated-provider',
            failures: 1,
            consecutiveFailures: 1,
            lastError: 'unrelated provider failure marker',
            lastFailureAt: Date.now() - 1_000,
            lastUsedAt: Date.now() - 1_000,
            recentFailures: [],
            healthy: true
          },
          'mock-openai': {
            providerId: 'mock-openai',
            failures: 1,
            consecutiveFailures: 1,
            lastError: 'current provider failure marker',
            lastFailureAt: Date.now() - 2_000,
            lastUsedAt: Date.now() - 2_000,
            recentFailures: [],
            healthy: true
          }
        }
      },
      null,
      2
    )
  )
}

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const output = result.stderr.trim() || result.stdout.trim()
    throw new Error(`git ${args.join(' ')} failed: ${output}`)
  }
  return result.stdout.trim()
}

function assertHasSuggestion(items, id, source) {
  assert(
    items.some((item) => item.id === id && item.source === source),
    `missing ${id}/${source}: ${describeSuggestions(items)}`
  )
}

function describeSuggestions(items) {
  return items.map((item) => `${item.id}:${item.source}:${item.priority}`).join(', ')
}

async function waitForAgentDesk(page) {
  await page.waitForFunction(() => typeof window.agentDesk?.createSession === 'function', { timeout: 15_000 })
}

async function waitForElectronPage(browser, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const pages = await browser.pages()
    const page = pages.find((item) => !item.url().startsWith('devtools://'))
    if (page) return page
    await sleep(100)
  }
  throw new Error('Electron page target not found before timeout')
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
