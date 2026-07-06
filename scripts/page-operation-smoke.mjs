#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const outDir = path.join(repoRoot, 'test-results', 'caogen-deep')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const runDir = path.join(outDir, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-page-smoke-'))
const userDataDir = path.join(tempRoot, 'userData')
const projectDir = path.join(tempRoot, 'project')
const port = await findFreePort(9400)
const electronBin = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')

if (!existsSync(electronBin)) fail('Electron binary not found. Run npm install first.')
if (!existsSync(mainEntry)) fail('Built Electron main entry not found. Run npm run build first.')

mkdirSync(runDir, { recursive: true })
mkdirSync(projectDir, { recursive: true })
writeFileSync(path.join(projectDir, 'README.md'), '# Page smoke project\n')
writeFileSync(
  path.join(projectDir, 'browser-fixture.html'),
  [
    '<!doctype html>',
    '<html>',
    '<head><meta charset="utf-8"><title>CaoGen Browser Annotation Fixture</title></head>',
    '<body>',
    '<main id="fixture"><h1>Browser annotation target</h1><button class="cta">Fix spacing</button></main>',
    '</body>',
    '</html>'
  ].join('\n')
)
writeFileSync(path.join(projectDir, 'sample.json'), '{"ok":true}\n')
writeFileSync(
  path.join(projectDir, 'logo.png'),
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    'base64'
  )
)
writeFileSync(
  path.join(projectDir, 'report.pdf'),
  [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] /Contents 4 0 R >> endobj',
    '4 0 obj << /Length 44 >> stream',
    'BT /F1 12 Tf 20 70 Td (CaoGen PDF preview) Tj ET',
    'endstream endobj',
    'xref',
    '0 5',
    '0000000000 65535 f ',
    '0000000009 00000 n ',
    '0000000058 00000 n ',
    '0000000115 00000 n ',
    '0000000200 00000 n ',
    'trailer << /Root 1 0 R /Size 5 >>',
    'startxref',
    '294',
    '%%EOF'
  ].join('\n')
)
initGitProject(projectDir)

const app = spawn(electronBin, [`--remote-debugging-port=${port}`, mainEntry], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CAOGEN_USER_DATA_DIR: userDataDir,
    OPENAI_API_KEY: ''
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

const report = {
  runId,
  projectDir,
  userDataDir,
  remoteDebuggingPort: port,
  checks: [],
  screenshots: [],
  warnings: []
}

try {
  const target = await waitForTarget(port, 20_000)
  const appTargetId = target.id
  const cdp = await connectCdp(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await sleep(1200)

  await check(cdp, 'welcome screen renders CaoGen brand', async () => {
    const text = await visibleText(cdp)
    assert(text.includes('CaoGen'), 'CaoGen brand missing')
  })
  await screenshot(cdp, '01-welcome')

  await check(cdp, 'settings modal opens and plugin/migration tabs are reachable', async () => {
    await clickByText(cdp, '设置')
    await waitForText(cdp, '设置')
    await clickByText(cdp, '插件')
    await waitForText(cdp, '插件')
    await clickByText(cdp, '迁移')
    await waitForText(cdp, '迁移')
    await clickByText(cdp, '取消')
  })
  await screenshot(cdp, '02-after-settings')

  await check(cdp, 'new session can be created without external model call', async () => {
    await clickByText(cdp, '+ 新建会话')
    await waitForText(cdp, '新建会话')
    await setInputByPlaceholder(cdp, '/path/to/project', projectDir)
    await chooseSelectOptionByText(cdp, 'OpenAI 协议(Responses / Chat Completions)')
    await clickByText(cdp, '创建')
    await waitForAriaLabel(cdp, '⎇ Worktree', 10_000) // 工具栏图标化后按 aria-label 断言
    await waitForText(cdp, 'OpenAI 引擎缺少 API Key', 10_000)
  })
  await screenshot(cdp, '03-session')

  let worktreeRecord = null
  await check(cdp, 'managed worktree registry is created for git projects', async () => {
    worktreeRecord = await waitForWorktreeRecord(userDataDir)
    assert(worktreeRecord.sourceCwd === projectDir, `wrong source cwd: ${JSON.stringify(worktreeRecord)}`)
    writeFileSync(path.join(worktreeRecord.cwd, 'merge-ui.txt'), 'worktree merge ui smoke\n')
  })

  await check(cdp, 'worktree merge UI inspects an applyable patch', async () => {
    await clickByAriaLabel(cdp, '⎇ Worktree') // 图标按钮
    await waitForText(cdp, '隔离工作区', 10_000)
    await waitForText(cdp, '改动\n1', 10_000)
    await clickByText(cdp, '检查合并')
    await waitForText(cdp, '合并检查通过，可应用到主工作区', 10_000)
    await waitForText(cdp, 'merge-ui.txt', 10_000)
    await waitForText(cdp, 'Patch 预览', 10_000)
    await waitForText(cdp, 'git apply --check passed.', 10_000)
  })
  await screenshot(cdp, '04-worktree-merge')

  await check(cdp, 'workbench panels open from chat toolbar', async () => {
    // 常显图标(按 aria-label 点击):文件 / 终端
    await clickByAriaLabel(cdp, '▣ 文件')
    await waitForText(cdp, 'README.md', 10_000)
    await clickByAriaLabel(cdp, '❯ 终端')
    await waitForText(cdp, '终端', 10_000)
    // 低频项在 '⋯ 更多' 下拉里:先展开菜单,菜单项按文本点击
    const overflow = [
      ['插件', '插件生态'],
      ['Routines', 'Routines'],
      ['记忆', '项目记忆'],
      ['子 Agent', '子代理编排']
    ]
    for (const [item, marker] of overflow) {
      await clickByAriaLabel(cdp, '更多操作') // 打开 ⋯ 更多下拉
      await clickByText(cdp, item)
      await waitForText(cdp, marker, 10_000)
    }
  })
  await screenshot(cdp, '05-workbench-panels')

  await check(cdp, 'browser native view is removed when switching panels', async () => {
    await clickByAriaLabel(cdp, '◉ 浏览器')
    await waitForText(cdp, '内置浏览器', 10_000)
    await waitForBrowserViewTargets(port, appTargetId, 1, 10_000)
    await setInputByPlaceholder(cdp, '输入 URL 或域名', pathToFileURL(path.join(projectDir, 'browser-fixture.html')).href)
    await press(cdp, 'Enter')
    await waitForText(cdp, 'CaoGen Browser Annotation Fixture', 10_000)
    await setInputByPlaceholder(cdp, '批注说明。先在网页中选中文本或区域附近内容。', '批注: CTA spacing needs a fix')
    await clickByText(cdp, '保存批注')
    await waitForText(cdp, '已保存网页批注', 10_000)
    await waitForText(cdp, '批注: CTA spacing needs a fix', 10_000)
    await clickByText(cdp, '发给 Agent')
    await waitForText(cdp, '请基于这个 CaoGen 网页批注定位并修复问题。', 10_000)
    await waitForText(cdp, 'CTA spacing needs a fix', 10_000)
    await clickByAriaLabel(cdp, '▣ 文件')
    await waitForText(cdp, 'README.md', 10_000)
    await waitForBrowserViewTargets(port, appTargetId, 0, 10_000)
  })
  await screenshot(cdp, '06-browser-switch')

  await check(cdp, 'image and PDF previews render from project files', async () => {
    await clickByAriaLabel(cdp, '▣ 文件')
    await waitForText(cdp, 'logo.png', 10_000)
    await clickFilePreview(cdp, 'logo.png')
    await waitForText(cdp, 'IMAGE Preview', 10_000)
    const image = await waitForImagePreview(cdp)
    assert(image.src.startsWith('data:image/png;base64,'), `image preview did not use data URL: ${image.src.slice(0, 60)}`)
    assert(image.naturalWidth > 0 && image.naturalHeight > 0, `image preview did not decode: ${JSON.stringify(image)}`)

    await clickByAriaLabel(cdp, '▣ 文件')
    await waitForText(cdp, 'report.pdf', 10_000)
    await clickFilePreview(cdp, 'report.pdf')
    await waitForText(cdp, 'PDF Preview', 10_000)
    const pdf = await evalValue(
      cdp,
      `(() => {
        const object = document.querySelector('object[type="application/pdf"]');
        const placeholder = document.body.innerText.includes('PDF preview placeholder');
        return { ok: Boolean(object), data: object?.getAttribute('data') || '', placeholder };
      })()`
    )
    assert(pdf.ok, 'PDF object preview not found')
    assert(pdf.data.startsWith('data:application/pdf;base64,'), `PDF preview did not use data URL: ${pdf.data.slice(0, 80)}`)
    assert(!pdf.placeholder, 'old PDF placeholder is still visible')
  })
  await screenshot(cdp, '07-preview-assets')

  await check(cdp, 'slash command popup exposes key workbench commands', async () => {
    await focusComposer(cdp)
    await typeText(cdp, '/pl')
    await waitForText(cdp, '/plugins')
    await press(cdp, 'Escape')
  })
  await screenshot(cdp, '08-slash-popup')

  await check(cdp, 'office view loads without blank first screen', async () => {
    await clickByText(cdp, '3D 办公区')
    await waitForText(cdp, '办公区', 10_000)
    const canvasStats = await waitForCanvasPixels(cdp)
    report.officeCanvas = canvasStats
  })
  await screenshot(cdp, '09-office')

  await cdp.close()
} finally {
  const exited = await terminate(app)
  report.warnings.push(...summarizeProcessOutput(stdout, stderr, exited))
  const cspWarning = report.warnings.find((warning) => /ERR_BLOCKED_BY_CSP|Content Security Policy/i.test(warning))
  if (cspWarning) {
    report.checks.push({
      name: 'runtime does not block previews by CSP',
      status: 'fail',
      durationMs: 0,
      error: cspWarning
    })
  }
  writeFileSync(path.join(runDir, 'page-operation-smoke.json'), JSON.stringify(report, null, 2))
  rmSync(tempRoot, { recursive: true, force: true })
}

const failed = report.checks.filter((item) => item.status === 'fail')
if (failed.length > 0) {
  console.error(`page operation smoke failed: ${failed.map((f) => f.name).join(', ')}`)
  process.exitCode = 1
} else {
  console.log(`page operation smoke ok: ${runDir}`)
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
      error: error instanceof Error ? error.message : String(error)
    })
    try {
      await screenshot(cdp, `fail-${report.checks.length}`)
    } catch {
      // keep original assertion as the useful error
    }
    throw error
  }
}

async function screenshot(cdp, name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const file = path.join(runDir, `${name}.png`)
  writeFileSync(file, Buffer.from(shot.data, 'base64'))
  report.screenshots.push(file)
}

async function clickByAriaLabel(cdp, label) {
  const result = await evalValue(
    cdp,
    `(() => {
      const el = document.querySelector('[aria-label=${JSON.stringify(label)}]');
      if (!el) return { ok: false };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return { ok: true };
    })()`
  )
  assert(result?.ok, `aria-label button not found: ${label}`)
  await sleep(250)
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

async function clickFilePreview(cdp, filePath) {
  const result = await evalValue(
    cdp,
    `(() => {
      const needle = ${JSON.stringify(filePath)};
      const rows = [...document.querySelectorAll('.file-row-wrap')];
      const row = rows.find((candidate) => candidate.querySelector('.file-row-path')?.textContent?.trim() === needle);
      const button = row?.querySelector('.file-row-preview');
      if (!button) return { ok: false, text: document.body.innerText.slice(0, 2000) };
      button.scrollIntoView({ block: 'center', inline: 'center' });
      button.click();
      return { ok: true };
    })()`
  )
  assert(result?.ok, `file preview button not found for ${filePath}\n${result?.text ?? ''}`)
  await sleep(250)
}

async function waitForImagePreview(cdp, timeout = 5000) {
  const start = Date.now()
  let last = null
  while (Date.now() - start < timeout) {
    last = await evalValue(
      cdp,
      `(() => {
        const img = document.querySelector('.preview-renderer img');
        return {
          ok: Boolean(img),
          src: img?.getAttribute('src') || '',
          complete: Boolean(img?.complete),
          naturalWidth: img?.naturalWidth || 0,
          naturalHeight: img?.naturalHeight || 0
        };
      })()`
    )
    if (last?.ok && last.complete && last.naturalWidth > 0 && last.naturalHeight > 0) return last
    await sleep(150)
  }
  throw new Error(`image preview did not decode: ${JSON.stringify(last)}`)
}

function initGitProject(cwd) {
  git(cwd, ['init', '-q', '-b', 'main'])
  git(cwd, ['config', 'user.email', 'smoke@example.test'])
  git(cwd, ['config', 'user.name', 'CaoGen Page Smoke'])
  git(cwd, ['add', '.'])
  git(cwd, ['commit', '-q', '-m', 'initial smoke fixture'])
}

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

async function waitForWorktreeRecord(userDataDir, timeout = 10_000) {
  const registry = path.join(userDataDir, 'worktrees', 'index.json')
  const start = Date.now()
  let last = null
  while (Date.now() - start < timeout) {
    if (existsSync(registry)) {
      const raw = JSON.parse(readFileSync(registry, 'utf8'))
      const records = Array.isArray(raw) ? raw : Array.isArray(raw?.records) ? raw.records : []
      last = records.find((record) => record?.state === 'active') ?? records[0] ?? null
      if (last?.worktreePath && existsSync(last.worktreePath)) return last
    }
    await sleep(150)
  }
  throw new Error(`active worktree record not found: ${JSON.stringify(last)}`)
}

async function waitForBrowserViewTargets(remotePort, appTargetId, expectedCount, timeout = 5000) {
  const start = Date.now()
  let last = []
  while (Date.now() - start < timeout) {
    last = await browserViewTargets(remotePort, appTargetId)
    if (last.length === expectedCount) return last
    await sleep(200)
  }
  throw new Error(
    `expected ${expectedCount} browser native target(s), got ${last.length}: ${JSON.stringify(last.map((item) => ({ id: item.id, type: item.type, url: item.url, title: item.title })))} `
  )
}

async function browserViewTargets(remotePort, appTargetId) {
  const targets = await fetchJson(`http://127.0.0.1:${remotePort}/json/list`)
  return targets.filter((item) => {
    if (!item.webSocketDebuggerUrl || item.id === appTargetId) return false
    const url = typeof item.url === 'string' ? item.url : ''
    return url === 'about:blank' || url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file:')
  })
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

async function waitForText(cdp, text, timeout = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const body = await visibleText(cdp)
    if (body.includes(text)) return
    await sleep(150)
  }
  const body = await visibleText(cdp)
  throw new Error(`text not found: ${text}\nVisible text:\n${body.slice(0, 2000)}`)
}

async function waitForAriaLabel(cdp, label, timeout = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const found = await evalValue(
      cdp,
      `!!document.querySelector('[aria-label=${JSON.stringify(label)}]')`
    )
    if (found) return
    await sleep(150)
  }
  throw new Error(`aria-label not found: ${label}`)
}

async function waitForCanvasPixels(cdp, timeout = 10_000) {
  const start = Date.now()
  let lastStats = null
  while (Date.now() - start < timeout) {
    lastStats = await evalValue(
      cdp,
      `(() => {
        const canvas = document.querySelector('canvas');
        if (!canvas) return { canvas: false };
        const width = canvas.width;
        const height = canvas.height;
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (!gl || width < 100 || height < 100) {
          return { canvas: true, gl: Boolean(gl), width, height, colorSum: 0, alphaSum: 0, dataUrlLength: canvas.toDataURL('image/png').length };
        }
        const xs = [0.18, 0.33, 0.5, 0.67, 0.82];
        const ys = [0.2, 0.38, 0.55, 0.72, 0.88];
        const pixel = new Uint8Array(4);
        let colorSum = 0;
        let alphaSum = 0;
        let samples = 0;
        for (const xRatio of xs) {
          for (const yRatio of ys) {
            const x = Math.max(0, Math.min(width - 1, Math.floor(width * xRatio)));
            const y = Math.max(0, Math.min(height - 1, Math.floor(height * yRatio)));
            gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
            colorSum += pixel[0] + pixel[1] + pixel[2];
            alphaSum += pixel[3];
            samples += 1;
          }
        }
        return { canvas: true, gl: true, width, height, colorSum, alphaSum, samples, dataUrlLength: canvas.toDataURL('image/png').length };
      })()`
    )
    if (lastStats?.canvas && lastStats.width >= 100 && lastStats.height >= 100) {
      if ((lastStats.colorSum ?? 0) > 500 || (lastStats.dataUrlLength ?? 0) > 10_000) return lastStats
    }
    await sleep(300)
  }
  throw new Error(`3D office canvas did not become visibly nonblank: ${JSON.stringify(lastStats)}`)
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
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: child.exitCode, signal: 'SIGKILL' })
    }, 3000)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
  return result
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
    ws.addEventListener('open', () => {
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
    }, { once: true })
    ws.addEventListener('error', () => reject(new Error('DevTools WebSocket connection failed')), { once: true })
  })
}
