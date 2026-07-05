#!/usr/bin/env node
import http from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const outDir = path.join(repoRoot, 'test-results', 'openai-mock-e2e')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const runDir = path.join(outDir, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-openai-e2e-'))
const userDataDir = path.join(tempRoot, 'userData')
const projectDir = path.join(tempRoot, 'project')
const electronBin = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')

if (!existsSync(electronBin)) fail('Electron binary not found. Run npm install first.')
if (!existsSync(mainEntry)) fail('Built Electron main entry not found. Run npm run build first.')

mkdirSync(runDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
mkdirSync(projectDir, { recursive: true })
writeFileSync(path.join(projectDir, 'README.md'), '# OpenAI mock e2e\n')

const report = {
  runId,
  projectDir,
  userDataDir,
  checks: [],
  screenshots: [],
  warnings: [],
  requests: []
}

const mock = await startOpenAiMock()
const remotePort = await findFreePort(9900)
writeMockUserData(mock.port)

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

try {
  const target = await waitForTarget(remotePort, 20_000)
  const cdp = await connectCdp(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await installErrorCapture(cdp)
  await sleep(1200)

  await check(cdp, 'app opens with mock OpenAI provider available', async () => {
    await waitForText(cdp, 'CaoGen', 20_000)
    await clickByText(cdp, '+ 新建会话')
    await waitForText(cdp, '新建会话')
    await setInputByPlaceholder(cdp, '/path/to/project', projectDir)
    await chooseSelectOptionByText(cdp, 'OpenAI 协议(Responses / Chat Completions)')
    await chooseSelectOptionByText(cdp, 'CaoGen OpenAI Mock')
    await chooseSelectOptionByText(cdp, 'mock-responses')
    await screenshot(cdp, '01-new-session-openai-mock')
  })

  await check(cdp, 'session can be created without real API key', async () => {
    await clickByText(cdp, '创建')
    await waitForText(cdp, projectDir, 10_000)
    await waitForText(cdp, '厂商 CaoGen OpenAI Mock', 10_000)
    await waitForText(cdp, '模型 mock-responses', 10_000)
  })

  const prompt = `openai mock e2e ${runId}`
  const expected = `Mock Responses OK: ${prompt}`
  await check(cdp, 'real UI send receives streamed OpenAI Responses reply', async () => {
    await focusComposer(cdp)
    await typeText(cdp, prompt)
    await press(cdp, 'Enter')
    await waitForText(cdp, expected, 15_000)
    await waitForText(cdp, '本轮完成', 10_000)
  })

  await check(cdp, 'usage stats and request body prove the real engine path ran', async () => {
    await waitForText(cdp, '↑37 ↓11', 10_000)
    assert(mock.requests.length === 1, `expected one OpenAI request, got ${mock.requests.length}`)
    const request = mock.requests[0]
    assert(request.url === '/v1/responses', `wrong request URL: ${request.url}`)
    assert(request.authorization === 'Bearer mock-key', `wrong auth header: ${request.authorization}`)
    assert(request.body?.model === 'mock-responses', `wrong model: ${JSON.stringify(request.body)}`)
    assert(JSON.stringify(request.body).includes(prompt), 'prompt missing from OpenAI request body')
    report.requests = mock.requests
  })

  await screenshot(cdp, '02-openai-response-complete')
  await cdp.close()
} finally {
  const exited = await terminate(app)
  await closeServer(mock.server)
  report.warnings.push(...summarizeProcessOutput(stdout, stderr, exited))
  report.e2eErrors = []
  writeFileSync(path.join(runDir, 'openai-mock-e2e.json'), JSON.stringify(report, null, 2))
  rmSync(tempRoot, { recursive: true, force: true })
}

const failed = report.checks.filter((item) => item.status === 'fail')
if (failed.length > 0) {
  console.error(`openai mock e2e failed: ${failed.map((item) => item.name).join(', ')}`)
  process.exitCode = 1
} else {
  console.log(`openai mock e2e ok: ${runDir}`)
}

function writeMockUserData(port) {
  writeFileSync(
    path.join(userDataDir, 'providers.json'),
    JSON.stringify(
      [
        {
          id: 'mock-openai',
          name: 'CaoGen OpenAI Mock',
          baseUrl: `http://127.0.0.1:${port}`,
          encryptedToken: `b64:${Buffer.from('mock-key').toString('base64')}`,
          models: ['mock-responses'],
          note: 'Local system-test provider; no real API key required.',
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

async function startOpenAiMock() {
  const requests = []
  const server = http.createServer(async (req, res) => {
    if (req.url !== '/v1/responses' || req.method !== 'POST') {
      res.writeHead(404)
      res.end('not found')
      return
    }
    const body = await readJson(req)
    const prompt = lastInputText(body)
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization || '',
      body
    })
    const reply = `Mock Responses OK: ${prompt}`
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    for (const piece of reply.match(/.{1,9}/g) || []) {
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: piece })}\n\n`)
      await sleep(20)
    }
    res.write(
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_mock_caogen',
          output_text: reply,
          usage: {
            input_tokens: 33,
            output_tokens: 11,
            input_tokens_details: { cached_tokens: 4 }
          }
        }
      })}\n\n`
    )
    res.write('data: [DONE]\n\n')
    res.end()
  })
  const port = await findFreePort(8800)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return { server, port, requests }
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

function lastInputText(body) {
  const input = Array.isArray(body?.input) ? body.input : []
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const content = Array.isArray(input[i]?.content) ? input[i].content : []
    for (let j = content.length - 1; j >= 0; j -= 1) {
      if (typeof content[j]?.text === 'string') return content[j].text
    }
  }
  return '(empty)'
}

async function check(cdp, name, fn) {
  const startedAt = Date.now()
  try {
    await fn()
    report.checks.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
  } catch (error) {
    report.checks.push({
      name,
      status: 'fail',
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      debug: await debugPage(cdp).catch((debugError) => ({ debugError: String(debugError) }))
    })
    try {
      await screenshot(cdp, `fail-${report.checks.length}`)
    } catch {
      // Preserve the original assertion as the useful error.
    }
    throw error
  }
}

async function debugPage(cdp) {
  return evalValue(
    cdp,
    `(() => ({
      href: location.href,
      readyState: document.readyState,
      bodyText: document.body?.innerText?.slice(0, 2400) || '',
      e2eErrors: globalThis.__caogenE2eErrors || []
    }))()`
  )
}

async function installErrorCapture(cdp) {
  await evalValue(
    cdp,
    `(() => {
      globalThis.__caogenE2eErrors = [];
      window.addEventListener('error', (event) => {
        globalThis.__caogenE2eErrors.push({ type: 'error', message: event.message, stack: event.error?.stack || '' });
      });
      window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        globalThis.__caogenE2eErrors.push({ type: 'unhandledrejection', message: reason?.message || String(reason), stack: reason?.stack || '' });
      });
      return true;
    })()`
  )
}

async function screenshot(cdp, name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const file = path.join(runDir, `${name}.png`)
  writeFileSync(file, Buffer.from(shot.data, 'base64'))
  report.screenshots.push(file)
}

async function clickByText(cdp, text) {
  const result = await evalValue(
    cdp,
    `(() => {
      const needle = ${JSON.stringify(text)};
      const elements = [...document.querySelectorAll('button, [role="button"], option')];
      const el = elements.find((candidate) => (candidate.innerText || candidate.textContent || '').trim().includes(needle));
      if (!el) return { ok: false, text: document.body.innerText.slice(0, 2000) };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return { ok: true };
    })()`
  )
  assert(result?.ok, `button/text not found: ${text}\n${result?.text ?? ''}`)
  await sleep(250)
}

async function setInputByPlaceholder(cdp, placeholder, value) {
  const result = await evalValue(
    cdp,
    `(() => {
      const el = [...document.querySelectorAll('input, textarea')].find((candidate) => candidate.placeholder === ${JSON.stringify(placeholder)});
      if (!el) return false;
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      setter?.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`
  )
  assert(result === true, `input not found for placeholder: ${placeholder}`)
  await sleep(250)
}

async function chooseSelectOptionByText(cdp, text) {
  const result = await evalValue(
    cdp,
    `(() => {
      const needle = ${JSON.stringify(text)};
      for (const select of document.querySelectorAll('select')) {
        const option = [...select.options].find((candidate) => candidate.textContent.includes(needle) && !candidate.disabled);
        if (!option) continue;
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return false;
    })()`
  )
  assert(result === true, `select option not found: ${text}`)
  await sleep(250)
}

async function focusComposer(cdp) {
  const ok = await evalValue(
    cdp,
    `(() => {
      const el = document.querySelector('.composer-input');
      if (!el) return false;
      el.focus();
      return true;
    })()`
  )
  assert(ok === true, 'composer input not found')
}

async function typeText(cdp, text) {
  for (const char of text) await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: char })
  await sleep(250)
}

async function press(cdp, key) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key })
  await sleep(250)
}

async function waitForText(cdp, text, timeout = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const body = await visibleText(cdp)
    if (body.includes(text)) return
    await sleep(150)
  }
  const body = await visibleText(cdp)
  throw new Error(`text not found: ${text}\nVisible text:\n${body.slice(0, 2200)}`)
}

async function visibleText(cdp) {
  return evalValue(cdp, 'document.body.innerText')
}

async function evalValue(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Runtime.evaluate failed')
  return response.result?.value
}

async function waitForTarget(port, timeout) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`)
      const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (target) return target
    } catch {
      // Electron may still be booting.
    }
    await sleep(250)
  }
  throw new Error(`remote debugging target not available on port ${port}`)
}

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} returned ${res.status}`)
  return res.json()
}

async function findFreePort(start) {
  for (let port = start; port < start + 300; port += 1) {
    if (await isPortFree(port)) return port
  }
  throw new Error(`no free port from ${start}`)
}

function isPortFree(port) {
  return new Promise((resolve) => {
    import('node:net').then(({ createServer }) => {
      const server = createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => server.close(() => resolve(true)))
      server.listen(port, '127.0.0.1')
    })
  })
}

async function terminate(child) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode }
  child.kill('SIGTERM')
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: child.exitCode, signal: 'SIGKILL' })
    }, 3_000)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve))
}

function summarizeProcessOutput(out, err, exit) {
  const warnings = []
  if (exit.signal && exit.signal !== 'SIGTERM') warnings.push(`electron exited via ${exit.signal}`)
  const cleanErr = err.trim()
  if (cleanErr) warnings.push(cleanErr.split('\n').slice(-8).join('\n'))
  const cleanOut = out.trim()
  if (cleanOut) warnings.push(cleanOut.split('\n').slice(-8).join('\n'))
  return warnings
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let nextId = 1
    const pending = new Map()
    ws.addEventListener('message', (event) => {
      const data = JSON.parse(event.data)
      if (!data.id || !pending.has(data.id)) return
      const item = pending.get(data.id)
      pending.delete(data.id)
      if (data.error) item.reject(new Error(data.error.message || JSON.stringify(data.error)))
      else item.resolve(data.result ?? {})
    })
    ws.addEventListener(
      'open',
      () => {
        resolve({
          send(method, params = {}) {
            const id = nextId++
            ws.send(JSON.stringify({ id, method, params }))
            return new Promise((resolveSend, rejectSend) => {
              pending.set(id, { resolve: resolveSend, reject: rejectSend })
              setTimeout(() => {
                if (pending.has(id)) {
                  pending.delete(id)
                  rejectSend(new Error(`CDP timeout: ${method}`))
                }
              }, 10_000)
            })
          },
          close() {
            ws.close()
          }
        })
      },
      { once: true }
    )
    ws.addEventListener('error', () => reject(new Error('DevTools WebSocket connection failed')), { once: true })
  })
}
