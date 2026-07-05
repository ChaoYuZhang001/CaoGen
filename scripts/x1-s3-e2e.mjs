#!/usr/bin/env node
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const outDir = path.join(repoRoot, 'test-results', 'x1-s3-e2e')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const runDir = path.join(outDir, runId)
const electronBin = path.join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron'
)
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')

if (!existsSync(electronBin)) fail('Electron binary not found. Run npm install first.')
if (!existsSync(mainEntry)) fail('Built Electron main entry not found. Run npm run build first.')

mkdirSync(runDir, { recursive: true })

const report = {
  runId,
  runDir,
  checks: [],
  screenshots: [],
  warnings: []
}

try {
  await runX1Scenario()
  await runS3Scenario()
} finally {
  writeFileSync(path.join(runDir, 'x1-s3-e2e.json'), JSON.stringify(report, null, 2))
}

const failed = report.checks.filter((item) => item.status === 'fail')
if (failed.length > 0) {
  console.error(`x1/s3 e2e failed: ${failed.map((item) => item.name).join(', ')}`)
  process.exitCode = 1
} else {
  console.log(`x1/s3 e2e ok: ${runDir}`)
}

async function runX1Scenario() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-x1-e2e-'))
  const userDataDir = path.join(tempRoot, 'userData')
  const projectDir = path.join(tempRoot, 'project-x1')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(path.join(projectDir, 'README.md'), '# X1 E2E\n')

  const app = await startElectron(userDataDir, 9700)
  try {
    await withCdp(app, async (cdp) => {
      await waitForText(cdp, 'CaoGen', 20_000)
      await screenshot(cdp, 'x1-01-welcome')

      await check(cdp, 'X1 first launch creates blank DeepSeek provider and defaults', async () => {
        const providersFile = path.join(userDataDir, 'providers.json')
        await waitForFile(providersFile, 5_000)
        const providers = JSON.parse(readFileSync(providersFile, 'utf8'))
        assert(Array.isArray(providers), 'providers.json should contain an array')
        const deepSeek = providers.find((item) => item.id === 'deepseek-official')
        assert(deepSeek, `DeepSeek provider missing: ${JSON.stringify(providers)}`)
        assert(deepSeek.baseUrl === 'https://api.deepseek.com/anthropic', `wrong baseUrl: ${deepSeek.baseUrl}`)
        assert(deepSeek.encryptedToken === '', 'DeepSeek provider must not include a built-in API key')
        assert(deepSeek.models?.includes('deepseek-chat'), 'deepseek-chat missing')
        assert(deepSeek.models?.includes('deepseek-reasoner'), 'deepseek-reasoner missing')
      })

      await check(cdp, 'X1 new session modal selects DeepSeek and deepseek-chat by default', async () => {
        await clickByText(cdp, '+ 新建会话')
        await waitForText(cdp, '新建会话')
        await setInputByPlaceholder(cdp, '/path/to/project', projectDir)
        const selected = await selectedNewSessionValues(cdp)
        assert(selected.providerValue === 'deepseek-official', `wrong provider value: ${JSON.stringify(selected)}`)
        assert(selected.providerText.includes('DeepSeek'), `provider label missing DeepSeek: ${JSON.stringify(selected)}`)
        assert(selected.providerText.includes('未配置密钥'), `provider should show no-key label: ${JSON.stringify(selected)}`)
        assert(selected.modelValue === 'deepseek-chat', `wrong model value: ${JSON.stringify(selected)}`)
      })

      await check(cdp, 'X1 DeepSeek without key shows explicit settings prompt on send', async () => {
        await clickByText(cdp, '创建')
        await waitForText(cdp, projectDir, 15_000)
        await focusComposer(cdp)
        await typeText(cdp, 'ping without key')
        await press(cdp, 'Enter')
        await waitForText(cdp, '请在设置里填写 DeepSeek(官方直连) API key 后再开始对话', 10_000)
      })
      await screenshot(cdp, 'x1-02-no-key-error')
    })
  } finally {
    await stopElectron(app)
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function runS3Scenario() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-s3-e2e-'))
  const userDataDir = path.join(tempRoot, 'userData')
  const alphaDir = path.join(tempRoot, 'alpha-project')
  const betaDir = path.join(tempRoot, 'beta-project')
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(alphaDir, { recursive: true })
  mkdirSync(betaDir, { recursive: true })
  writeFileSync(path.join(alphaDir, 'README.md'), '# Alpha\n')
  writeFileSync(path.join(betaDir, 'README.md'), '# Beta\n')

  const now = Date.now()
  const history = [
    historyEntry('hist-alpha', 'Alpha Keep Current', alphaDir, 'sdk-alpha', now - 1_000),
    historyEntry('hist-beta', 'Beta Pin Candidate', betaDir, 'sdk-beta', now - 2_000),
    historyEntry('hist-gamma', 'Gamma Archive Candidate', alphaDir, 'sdk-gamma', now - 3_000),
    historyEntry('hist-delete', 'Delete Target', betaDir, 'sdk-delete', now - 4_000)
  ]
  writeFileSync(path.join(userDataDir, 'sessions.json'), JSON.stringify(history, null, 2))
  writeFileSync(
    path.join(userDataDir, 'projects.json'),
    JSON.stringify(
      [
        { id: 'project-alpha', name: 'Alpha Project', path: alphaDir, lastUsedAt: now - 1_000 },
        { id: 'project-beta', name: 'Beta Project', path: betaDir, lastUsedAt: now - 2_000 }
      ],
      null,
      2
    )
  )

  const app = await startElectron(userDataDir, 9800)
  try {
    await withCdp(app, async (cdp) => {
      await waitForText(cdp, 'Alpha Keep Current', 20_000)
      await evalValue(cdp, 'window.confirm = () => true')
      await screenshot(cdp, 's3-01-history')

      await check(cdp, 'S3 recent sessions are grouped by project', async () => {
        const groups = await sidebarGroups(cdp)
        const alpha = groups.find((group) => group.title === 'Alpha Project')
        const beta = groups.find((group) => group.title === 'Beta Project')
        assert(alpha?.cards.includes('Alpha Keep Current'), `Alpha group wrong: ${JSON.stringify(groups)}`)
        assert(alpha?.cards.includes('Gamma Archive Candidate'), `Alpha group missing gamma: ${JSON.stringify(groups)}`)
        assert(beta?.cards.includes('Beta Pin Candidate'), `Beta group wrong: ${JSON.stringify(groups)}`)
        assert(beta?.cards.includes('Delete Target'), `Beta group missing delete target: ${JSON.stringify(groups)}`)
      })

      await check(cdp, 'S3 search filters by title/project/path', async () => {
        await setInputByPlaceholder(cdp, '搜索标题、项目或路径', 'Beta')
        await waitForText(cdp, 'Beta Pin Candidate')
        await waitForText(cdp, 'Delete Target')
        await waitForNoText(cdp, 'Alpha Keep Current')
        await waitForNoText(cdp, 'Gamma Archive Candidate')
        await setInputByPlaceholder(cdp, '搜索标题、项目或路径', '')
        await waitForText(cdp, 'Alpha Keep Current')
      })

      await check(cdp, 'S3 pin moves session into pinned section and persists', async () => {
        await openMoreForCard(cdp, 'Beta Pin Candidate')
        await clickMenuItem(cdp, '置顶')
        await waitForSectionCard(cdp, '置顶', 'Beta Pin Candidate')
        const after = readHistory(userDataDir)
        assert(after.find((entry) => entry.id === 'hist-beta')?.pinned === true, 'pinned flag not persisted')
      })

      await check(cdp, 'S3 archive hides from recent, expands archive section, and persists', async () => {
        await openMoreForCard(cdp, 'Gamma Archive Candidate')
        await clickMenuItem(cdp, '归档')
        await waitForNoSectionCard(cdp, '最近会话', 'Gamma Archive Candidate')
        await clickArchiveToggle(cdp)
        await waitForSectionCard(cdp, '归档', 'Gamma Archive Candidate')
        const after = readHistory(userDataDir)
        assert(after.find((entry) => entry.id === 'hist-gamma')?.archived === true, 'archived flag not persisted')
      })

      await check(cdp, 'S3 delete removes history entry from UI and disk after confirm', async () => {
        await openMoreForCard(cdp, 'Delete Target')
        await clickMenuItem(cdp, '删除')
        await waitForNoText(cdp, 'Delete Target')
        const after = readHistory(userDataDir)
        assert(!after.some((entry) => entry.id === 'hist-delete'), 'deleted history entry still persisted')
      })
      await screenshot(cdp, 's3-02-final')
    })
  } finally {
    await stopElectron(app)
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

function historyEntry(id, title, cwd, sdkSessionId, updatedAt) {
  return {
    id,
    title,
    cwd,
    model: 'deepseek-chat',
    providerId: 'deepseek-official',
    permissionMode: 'default',
    sdkSessionId,
    createdAt: updatedAt - 10_000,
    updatedAt,
    costUsd: 0
  }
}

function readHistory(userDataDir) {
  return JSON.parse(readFileSync(path.join(userDataDir, 'sessions.json'), 'utf8'))
}

async function startElectron(userDataDir, portStart) {
  mkdirSync(userDataDir, { recursive: true })
  const port = await findFreePort(portStart)
  const child = spawn(electronBin, [`--remote-debugging-port=${port}`, mainEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAOGEN_USER_DATA_DIR: userDataDir,
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
  const app = { child, port, stdout: '', stderr: '' }
  child.stdout.on('data', (chunk) => {
    app.stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    app.stderr += chunk.toString()
  })
  return app
}

async function withCdp(app, fn) {
  const target = await waitForTarget(app.port, 20_000)
  const cdp = await connectCdp(target.webSocketDebuggerUrl)
  try {
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await cdp.send('Log.enable').catch(() => undefined)
    await sleep(1200)
    await installErrorCapture(cdp)
    await fn(cdp)
  } finally {
    cdp.close()
  }
}

async function stopElectron(app) {
  const exited = await terminate(app.child)
  report.warnings.push(...summarizeProcessOutput(app.stdout, app.stderr, exited))
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
      bodyText: document.body?.innerText?.slice(0, 2000) || '',
      bodyHtml: document.body?.innerHTML?.slice(0, 2000) || '',
      rootHtml: document.querySelector('#root')?.innerHTML?.slice(0, 2000) || '',
      e2eErrors: globalThis.__caogenE2eErrors || [],
      title: document.title
    }))()`
  )
}

async function installErrorCapture(cdp) {
  await evalValue(
    cdp,
    `(() => {
      globalThis.__caogenE2eErrors = [];
      window.addEventListener('error', (event) => {
        globalThis.__caogenE2eErrors.push({
          type: 'error',
          message: event.message,
          stack: event.error?.stack || '',
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno
        });
      });
      window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        globalThis.__caogenE2eErrors.push({
          type: 'unhandledrejection',
          message: reason?.message || String(reason),
          stack: reason?.stack || ''
        });
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

async function selectedNewSessionValues(cdp) {
  return evalValue(
    cdp,
    `(() => {
      const modalSelects = [...document.querySelectorAll('.modal select')];
      const selects = modalSelects.length > 0 ? modalSelects : [...document.querySelectorAll('select')];
      const provider = selects.find((select) => [...select.options].some((option) => option.value === 'deepseek-official'));
      const model = selects.find((select) => [...select.options].some((option) => option.value === 'deepseek-chat'));
      return {
        providerValue: provider?.value || '',
        providerText: provider?.selectedOptions?.[0]?.textContent || '',
        modelValue: model?.value || '',
        modelText: model?.selectedOptions?.[0]?.textContent || ''
      };
    })()`
  )
}

async function sidebarGroups(cdp) {
  return evalValue(
    cdp,
    `(() => [...document.querySelectorAll('.sidebar-project-group')].map((group) => ({
      title: group.querySelector('.sidebar-group-title')?.textContent?.trim() || '',
      cards: [...group.querySelectorAll('.session-card-title')].map((item) => item.textContent.trim())
    })))()`
  )
}

async function openMoreForCard(cdp, title) {
  const result = await evalValue(
    cdp,
    `(() => {
      const title = ${JSON.stringify(title)};
      const cards = [...document.querySelectorAll('.session-card')];
      const card = cards.find((item) => item.innerText.includes(title));
      const more = card?.querySelector('.session-card-more');
      if (!more) return { ok: false, text: document.body.innerText.slice(0, 2000) };
      more.scrollIntoView({ block: 'center', inline: 'center' });
      more.click();
      return { ok: true };
    })()`
  )
  assert(result?.ok, `more menu not found for ${title}\n${result?.text ?? ''}`)
  await waitForText(cdp, '复制路径')
}

async function clickArchiveToggle(cdp) {
  const result = await evalValue(
    cdp,
    `(() => {
      const buttons = [...document.querySelectorAll('.sidebar-section-toggle')];
      const button = buttons.find((item) => item.innerText.includes('归档'));
      if (!button) return false;
      button.click();
      return true;
    })()`
  )
  assert(result === true, 'archive toggle not found')
  await sleep(250)
}

async function clickMenuItem(cdp, label) {
  const result = await evalValue(
    cdp,
    `(() => {
      const label = ${JSON.stringify(label)};
      const items = [...document.querySelectorAll('.ctx-menu [role="menuitem"]')];
      const item = items.find((candidate) => (candidate.innerText || candidate.textContent || '').trim().includes(label));
      if (!item) return { ok: false, text: document.body.innerText.slice(0, 2000) };
      item.click();
      return { ok: true };
    })()`
  )
  assert(result?.ok, `menu item not found: ${label}\n${result?.text ?? ''}`)
  await sleep(300)
}

async function waitForSectionCard(cdp, sectionLabel, cardTitle, timeout = 5_000) {
  const start = Date.now()
  let last = []
  while (Date.now() - start < timeout) {
    last = await sidebarSections(cdp)
    const section = last.find((item) => item.label.includes(sectionLabel))
    if (section?.cards.some((card) => card.includes(cardTitle))) return
    await sleep(150)
  }
  throw new Error(`card ${cardTitle} not found in section ${sectionLabel}: ${JSON.stringify(last)}`)
}

async function waitForNoSectionCard(cdp, sectionLabel, cardTitle, timeout = 5_000) {
  const start = Date.now()
  let last = []
  while (Date.now() - start < timeout) {
    last = await sidebarSections(cdp)
    const section = last.find((item) => item.label.includes(sectionLabel))
    if (!section || !section.cards.some((card) => card.includes(cardTitle))) return
    await sleep(150)
  }
  throw new Error(`card ${cardTitle} still visible in section ${sectionLabel}: ${JSON.stringify(last)}`)
}

async function sidebarSections(cdp) {
  return evalValue(
    cdp,
    `(() => [...document.querySelectorAll('.sidebar-section')].map((section) => ({
      label: (section.querySelector('.sidebar-section-title')?.textContent || section.querySelector('.sidebar-section-toggle')?.textContent || '').trim(),
      cards: [...section.querySelectorAll('.session-card-title')].map((item) => item.textContent.trim())
    })))()`
  )
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
  for (const char of text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: char })
  }
  await sleep(250)
}

async function press(cdp, key) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key })
  await sleep(250)
}

async function waitForText(cdp, text, timeout = 5_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const body = await visibleText(cdp)
    if (body.includes(text)) return
    await sleep(150)
  }
  const body = await visibleText(cdp)
  throw new Error(`text not found: ${text}\nVisible text:\n${body.slice(0, 2000)}`)
}

async function waitForNoText(cdp, text, timeout = 5_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const body = await visibleText(cdp)
    if (!body.includes(text)) return
    await sleep(150)
  }
  const body = await visibleText(cdp)
  throw new Error(`text still visible: ${text}\nVisible text:\n${body.slice(0, 2000)}`)
}

async function visibleText(cdp) {
  return evalValue(cdp, 'document.body.innerText')
}

async function evalValue(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text || 'Runtime.evaluate failed')
  }
  return response.result?.value
}

async function waitForFile(file, timeout = 5_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (existsSync(file)) return
    await sleep(100)
  }
  throw new Error(`file not found: ${file}`)
}

async function waitForTarget(remotePort, timeout) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${remotePort}/json/list`)
      const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (target) return target
    } catch {
      // Electron may still be booting.
    }
    await sleep(250)
  }
  throw new Error(`remote debugging target not available on port ${remotePort}`)
}

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} returned ${res.status}`)
  return res.json()
}

async function findFreePort(start) {
  for (let port = start; port < start + 200; port++) {
    if (await isPortFree(port)) return port
  }
  throw new Error(`no free remote debugging port from ${start}`)
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

function summarizeProcessOutput(out, err, exit) {
  const warnings = []
  if (exit.signal && exit.signal !== 'SIGTERM') warnings.push(`electron exited via ${exit.signal}`)
  const cleanErr = err.trim()
  if (cleanErr) warnings.push(cleanErr.split('\n').slice(-8).join('\n'))
  const cleanOut = out.trim()
  if (cleanOut) warnings.push(cleanOut.split('\n').slice(-8).join('\n'))
  return warnings
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
