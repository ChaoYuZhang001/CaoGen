#!/usr/bin/env node
import http from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const outDir = path.join(repoRoot, 'test-results', 'openai-mock-e2e')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const runDir = path.join(outDir, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-openai-e2e-'))
const userDataDir = path.join(tempRoot, 'userData')
const projectDir = path.join(tempRoot, 'project')
const projectContextNeedle = `P0_OPENAI_RESPONSES_CONTEXT_${runId}`
const denyFileName = 'permission-deny.txt'
const allowFileName = 'permission-allow.txt'
const electronBin =
  process.platform === 'win32'
    ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')
const preloadEntry = path.join(repoRoot, 'out', 'preload', 'index.js')
const rendererEntry = path.join(repoRoot, 'out', 'renderer', 'index.html')

if (!existsSync(electronBin)) fail('Electron binary not found. Run npm install first.')
if (!existsSync(mainEntry)) fail('Built Electron main entry not found. Run npm run build first.')
if (!existsSync(preloadEntry)) fail('Built Electron preload entry not found. Run npm run build first.')
if (!existsSync(rendererEntry)) fail('Built renderer entry not found. Run npm run build first.')

mkdirSync(runDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
mkdirSync(projectDir, { recursive: true })
writeFileSync(path.join(projectDir, 'README.md'), '# OpenAI mock e2e\n')
writeFileSync(
  path.join(projectDir, 'caogen.md'),
  ['# 项目概述', projectContextNeedle, '# 代码规范', '- OpenAI Responses 必须注入项目永久上下文', ''].join('\n'),
  'utf8'
)
const isolatedOutDir = path.join(runDir, 'app', 'out')
copyBuiltApp(isolatedOutDir)
validateRendererAssets(path.join(isolatedOutDir, 'renderer'))
const isolatedMainEntry = path.join(isolatedOutDir, 'main', 'index.js')

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

const electronArgs = [`--remote-debugging-port=${remotePort}`, isolatedMainEntry]
const app = spawn(electronSpawnCommand(), electronSpawnArgs(electronArgs), {
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
    await assertIsolatedRenderer(cdp)
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
    await clickCreateSession(cdp, projectDir)
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
    assert(String(request.body?.instructions ?? '').includes(projectContextNeedle), 'caogen.md context missing from Responses instructions')
    report.requests = mock.requests
  })

  await check(cdp, 'default permission can deny OpenAI write_file tool call', async () => {
    await focusComposer(cdp)
    await typeText(cdp, `permission deny e2e ${runId}`)
    await press(cdp, 'Enter')
    await waitForPermissionCard(cdp, 'write_file', 15_000)
    await clickPermissionAction(cdp, 'deny')
    await waitForText(cdp, 'Permission deny handled', 15_000)
    assert(!existsSync(path.join(projectDir, denyFileName)), 'denied write_file should not create file')
    await waitForAuditRecord((record) =>
      record.toolName === 'write_file' &&
      record.action === 'deny' &&
      record.source === 'user' &&
      String(record.inputSummary ?? '').includes(denyFileName)
    )
    assert(
      mock.requests.some((request) => request.kind === 'permission-deny-output'),
      'deny path should send function_call_output back to Responses'
    )
  })

  await check(cdp, 'default permission can allow OpenAI write_file tool call', async () => {
    await focusComposer(cdp)
    await typeText(cdp, `permission allow e2e ${runId}`)
    await press(cdp, 'Enter')
    await waitForPermissionCard(cdp, 'write_file', 15_000)
    await clickPermissionAction(cdp, 'allow')
    await waitForText(cdp, 'Permission allow handled', 15_000)
    await waitForFileContent(path.join(projectDir, allowFileName), `allowed ${runId}`, 10_000)
    await waitForAuditRecord((record) =>
      record.toolName === 'write_file' &&
      record.action === 'allow' &&
      record.source === 'user' &&
      String(record.inputSummary ?? '').includes(allowFileName)
    )
    await waitForAuditRecord((record) =>
      record.toolName === 'write_file' &&
      record.action === 'execute' &&
      record.source === 'sandbox' &&
      record.ok === true &&
      String(record.inputSummary ?? '').includes(allowFileName)
    )
    assert(
      mock.requests.some((request) => request.kind === 'permission-allow-output'),
      'allow path should send function_call_output back to Responses'
    )
  })

  report.requests = mock.requests
  await screenshot(cdp, '02-openai-response-complete')
  await cdp.close()
} finally {
  const exited = await terminate(app)
  await closeServer(mock.server)
  report.warnings.push(...summarizeProcessOutput(stdout, stderr, exited))
  report.e2eErrors = []
  writeFileSync(path.join(runDir, 'openai-mock-e2e.json'), JSON.stringify(report, null, 2))
  cleanupTempRoot(tempRoot)
}

const failed = report.checks.filter((item) => item.status === 'fail')
if (failed.length > 0) {
  console.error(`openai mock e2e failed: ${failed.map((item) => item.name).join(', ')}`)
  process.exit(1)
} else {
  console.log(`openai mock e2e ok: ${runDir}`)
  process.exit(0)
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
          // mock server 只实现 /v1/responses;非 api.openai.com 端点的智能默认
          // 是 chat,故显式声明 responses(与真实用户在 UI 里选协议一致)
          openaiProtocol: 'responses',
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
    const kind = classifyMockRequest(body, prompt)
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization || '',
      body,
      kind
    })
    if (kind === 'permission-deny-call') {
      writeFunctionCallResponse(res, {
        responseId: 'resp_permission_deny_1',
        callId: 'call_permission_deny',
        path: denyFileName,
        content: `denied ${runId}`
      })
      return
    }
    if (kind === 'permission-allow-call') {
      writeFunctionCallResponse(res, {
        responseId: 'resp_permission_allow_1',
        callId: 'call_permission_allow',
        path: allowFileName,
        content: `allowed ${runId}`
      })
      return
    }
    const reply =
      kind === 'permission-deny-output'
        ? 'Permission deny handled'
        : kind === 'permission-allow-output'
          ? 'Permission allow handled'
          : `Mock Responses OK: ${prompt}`
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
          id: `resp_mock_caogen_${requests.length}`,
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

function classifyMockRequest(body, prompt) {
  const rawInput = JSON.stringify(body?.input ?? '')
  if (rawInput.includes('function_call_output') && rawInput.includes('call_permission_deny')) return 'permission-deny-output'
  if (rawInput.includes('function_call_output') && rawInput.includes('call_permission_allow')) return 'permission-allow-output'
  if (prompt.includes('permission deny e2e')) return 'permission-deny-call'
  if (prompt.includes('permission allow e2e')) return 'permission-allow-call'
  return 'text'
}

function writeFunctionCallResponse(res, { responseId, callId, path: targetPath, content }) {
  const item = {
    type: 'function_call',
    call_id: callId,
    name: 'write_file',
    arguments: JSON.stringify({ path: targetPath, content })
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  res.write(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item })}\n\n`)
  res.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\n`)
  res.write(
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: responseId,
        usage: {
          input_tokens: 21,
          output_tokens: 7,
          input_tokens_details: { cached_tokens: 0 }
        }
      }
    })}\n\n`
  )
  res.write('data: [DONE]\n\n')
  res.end()
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

async function clickCreateSession(cdp, expectedProjectDir) {
  const result = await evalValue(
    cdp,
    `(() => {
      const bodyText = document.body.innerText || '';
      if (bodyText.includes(${JSON.stringify(expectedProjectDir)})) return { ok: true, alreadyCreated: true };
      const modal = document.querySelector('.modal');
      const el = modal?.querySelector('.modal-actions .btn-primary:not([disabled])');
      if (!el) return { ok: false, text: document.body.innerText.slice(0, 2000) };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return { ok: true };
    })()`
  )
  if (result?.ok) {
    await sleep(250)
    return
  }
  await clickByText(cdp, '创建')
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

async function waitForPermissionCard(cdp, toolName, timeout = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const found = await evalValue(
      cdp,
      `(() => [...document.querySelectorAll('.permission-card')].some((card) => (card.innerText || '').includes(${JSON.stringify(toolName)})))()`
    )
    if (found === true) return
    await sleep(150)
  }
  const body = await visibleText(cdp)
  throw new Error(`permission card not found for ${toolName}\nVisible text:\n${body.slice(0, 2200)}`)
}

async function clickPermissionAction(cdp, action) {
  const result = await evalValue(
    cdp,
    `(() => {
      const card = [...document.querySelectorAll('.permission-card')].find((item) => (item.innerText || '').includes('write_file'));
      if (!card) return { ok: false, reason: 'missing permission card', text: document.body.innerText.slice(0, 1200) };
      const buttons = [...card.querySelectorAll('button')];
      const button = ${JSON.stringify(action)} === 'allow'
        ? buttons.find((item) => item.classList.contains('btn-primary')) || buttons[0]
        : buttons[buttons.length - 1];
      if (!button) return { ok: false, reason: 'missing permission button', text: card.innerText };
      button.scrollIntoView({ block: 'center', inline: 'center' });
      button.click();
      return { ok: true };
    })()`
  )
  assert(result?.ok, `permission ${action} button not found: ${result?.reason ?? ''}\n${result?.text ?? ''}`)
  await sleep(500)
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

async function waitForFileContent(filePath, expected, timeout = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (existsSync(filePath) && readFileSync(filePath, 'utf8') === expected) return
    await sleep(150)
  }
  const actual = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '(missing)'
  throw new Error(`file content mismatch for ${filePath}: ${JSON.stringify(actual)}`)
}

async function waitForAuditRecord(predicate, timeout = 5000) {
  const auditPath = path.join(projectDir, '.caogen', 'audit.log')
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const records = readAuditRecords(auditPath)
    if (records.some(predicate)) return
    await sleep(150)
  }
  throw new Error(`audit record not found in ${auditPath}`)
}

function readAuditRecords(auditPath) {
  if (!existsSync(auditPath)) return []
  return readFileSync(auditPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return { malformed: line }
      }
    })
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
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: child.exitCode, signal: 'SIGKILL' })
    }, 3_000)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
    if (process.platform === 'win32' && child.pid) {
      try {
        execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
      } catch {
        child.kill('SIGTERM')
      }
    } else {
      child.kill('SIGTERM')
    }
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

function copyBuiltApp(targetOutDir) {
  rmSync(targetOutDir, { recursive: true, force: true })
  mkdirSync(targetOutDir, { recursive: true })
  for (const dirName of ['main', 'preload', 'renderer']) {
    cpSync(path.join(repoRoot, 'out', dirName), path.join(targetOutDir, dirName), { recursive: true })
  }
}

function validateRendererAssets(rendererDir) {
  const htmlPath = path.join(rendererDir, 'index.html')
  const html = readFileSync(htmlPath, 'utf8')
  const entryRefs = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((match) => match[1])
  for (const ref of entryRefs) {
    const assetPath = path.join(rendererDir, ref)
    if (!existsSync(assetPath)) fail(`renderer asset missing in isolated e2e app: ${ref}`)
    if (!ref.endsWith('.js')) continue
    const js = readFileSync(assetPath, 'utf8')
    for (const chunk of js.matchAll(/import\("\.\/([^"]+\.js)"\)/g)) {
      const chunkPath = path.join(path.dirname(assetPath), chunk[1])
      if (!existsSync(chunkPath)) fail(`renderer dynamic chunk missing in isolated e2e app: ${chunk[1]}`)
    }
  }
}

async function assertIsolatedRenderer(cdp) {
  const info = await debugPage(cdp)
  const normalizedHref = String(info.href || '').replace(/\\/g, '/')
  const expectedSuffix = `${runId}/app/out/renderer/index.html`.replace(/\\/g, '/')
  assert(normalizedHref.includes(expectedSuffix), `renderer did not load isolated app output: ${info.href}`)
}

function cleanupTempRoot(target) {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch (error) {
    console.warn(`temporary cleanup skipped: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function electronSpawnCommand() {
  return electronBin
}

function electronSpawnArgs(args) {
  return args
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
