#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const electronBin = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-diagnostic-'))
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'provider-generation-diagnostic-e2e', runId)
const privateKey = 'e2e-secret-key'
const privateModel = 'e2e-private-model'
const privateResponse = 'private upstream response body'

assert(existsSync(mainEntry), 'Built Electron main entry not found. Run npm run build first.')
assert(existsSync(electronBin), 'Electron binary not found. Run npm install first.')
mkdirSync(reportDir, { recursive: true })

let requestEvidence
const upstream = createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => { body += chunk.toString() })
  request.on('end', () => {
    requestEvidence = {
      method: request.method,
      path: request.url,
      hasBearerCredential: request.headers.authorization === `Bearer ${privateKey}`,
      hasModel: body.includes(privateModel)
    }
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: privateResponse } }))
  })
})
const upstreamPort = await listen(upstream)
const baseUrl = `http://127.0.0.1:${upstreamPort}/gateway/v1`
const remotePort = await freePort()
const electron = spawn(electronBin, [`--remote-debugging-port=${remotePort}`, mainEntry], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CAOGEN_USER_DATA_DIR: path.join(tempRoot, 'user-data'),
    CAOGEN_MEMORY_DIR: path.join(tempRoot, 'memory'),
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: ''
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
})
let browser
let stderr = ''
electron.stderr.on('data', (chunk) => { stderr += chunk.toString() })
const checks = []

try {
  await waitForDebugPort(remotePort)
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${remotePort}`, defaultViewport: null })
  const page = await waitForRendererPage(browser)
  await page.setViewport({ width: 760, height: 700, deviceScaleFactor: 1 })
  await page.click('.sidebar-footer .sidebar-nav-item')
  await page.waitForSelector('[data-settings-tab="providers"]', { visible: true })
  await page.click('[data-settings-tab="providers"]')
  await page.waitForSelector('.provider-profile-actions button:last-child', { visible: true })
  await page.click('.provider-profile-actions button:last-child')
  await page.waitForSelector('[data-provider-quick-setup]', { visible: true })

  await replaceInput(page, '[data-provider-quick-field="base-url"]', baseUrl)
  await replaceInput(page, '[data-provider-quick-field="api-key"]', privateKey)
  await replaceInput(page, '[data-provider-quick-field="models"]', privateModel)
  await page.click('[data-provider-generation-action="run"]')
  await page.waitForSelector('[data-provider-generation-probe]', { visible: true, timeout: 20_000 })

  check('generation preflight sends the configured task request', requestEvidence?.method === 'POST'
    && requestEvidence.path === '/gateway/v1/chat/completions'
    && requestEvidence.hasBearerCredential === true
    && requestEvidence.hasModel === true)
  const diagnosis = await page.$eval('[data-provider-generation-probe]', (element) => element.textContent ?? '')
  check('401 diagnostic shows the actual safe task path', diagnosis.includes('/gateway/v1/chat/completions'))
  check('401 diagnostic explains that status alone does not prove the key is wrong', diagnosis.includes('不能单独证明 Key 填错'))
  check('diagnostic excludes provider origin, credential, model, and response body',
    !diagnosis.includes(`127.0.0.1:${upstreamPort}`)
    && !diagnosis.includes(privateKey)
    && !diagnosis.includes(privateModel)
    && !diagnosis.includes(privateResponse))
  check('401 diagnostic offers key, Base URL, and protocol recovery',
    await page.$$eval('[data-provider-generation-actions] button', (items) => items.map((item) => item.getAttribute('data-provider-generation-action')).join(','))
      === 'review_credentials,review_base_url_and_credentials,review_protocol')
  const layout = await page.$eval('[data-provider-generation-probe]', (panel) => {
    const panelRect = panel.getBoundingClientRect()
    const actions = [...panel.querySelectorAll('[data-provider-generation-action]')]
    return {
      pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      panelContained: panelRect.left >= 0 && panelRect.right <= document.documentElement.clientWidth + 1,
      actionsContained: actions.every((action) => {
        const rect = action.getBoundingClientRect()
        return rect.left >= panelRect.left - 1 && rect.right <= panelRect.right + 1
      })
    }
  })
  check('760x700 diagnostic and recovery actions remain contained',
    !layout.pageOverflow && layout.panelContained && layout.actionsContained)

  const screenshot = 'provider-401-diagnostic.png'
  await page.$eval('[data-provider-generation-probe]', (panel) => panel.scrollIntoView({ block: 'center' }))
  await page.screenshot({ path: path.join(reportDir, screenshot), fullPage: false })

  await page.click('[data-provider-generation-action="review_credentials"]')
  check('credential recovery focuses the API key field', await focusedField(page) === 'api-key')
  await page.click('[data-provider-generation-action="review_base_url_and_credentials"]')
  check('Base URL recovery focuses the Base URL field', await focusedField(page) === 'base-url')
  await page.click('[data-provider-generation-action="review_protocol"]')
  await page.waitForSelector('[data-provider-editor="form"] [data-provider-field="openai-protocol"]', { visible: true })
  check('protocol recovery opens advanced protocol configuration', Boolean(await page.$('[data-provider-field="openai-protocol"]')))

  writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    requirement: 'M2-T2 Provider 401 diagnosis and recovery',
    status: checks.every((item) => item.ok) ? 'passed' : 'failed',
    pass: checks.filter((item) => item.ok).length,
    total: checks.length,
    checks,
    screenshot
  }, null, 2)}\n`, 'utf8')
} finally {
  if (browser) await browser.disconnect().catch(() => undefined)
  await closeServer(upstream)
  stopChild(electron.pid)
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 })
}

const pass = checks.filter((item) => item.ok).length
if (pass !== checks.length) throw new Error(`Provider generation diagnostic E2E failed: ${pass}/${checks.length}`)
console.log(`Provider generation diagnostic E2E: ${pass}/${checks.length} checks passed`)
console.log(`Report: ${reportDir}`)

function check(name, ok) {
  checks.push({ name, ok: Boolean(ok) })
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}`)
}

async function replaceInput(page, selector, value) {
  await page.focus(selector)
  await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control')
  await page.keyboard.press('A')
  await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control')
  await page.keyboard.type(value)
}

function focusedField(page) {
  return page.evaluate(() => document.activeElement?.getAttribute('data-provider-quick-field'))
}

async function waitForRendererPage(connectedBrowser) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    for (const page of await connectedBrowser.pages()) {
      if (!/\/out\/renderer\/index\.html/.test(page.url())) continue
      if (await page.evaluate(() => document.querySelector('.welcome-composer-input') != null).catch(() => false)) return page
    }
    await delay(150)
  }
  throw new Error(`Renderer did not become interactive: ${stderr.split(/\r?\n/).slice(-4).join(' | ')}`)
}

async function waitForDebugPort(port) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) })
      if (response.ok) return
    } catch {}
    await delay(150)
  }
  throw new Error('Electron debug endpoint did not become available')
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function freePort() {
  const server = net.createServer()
  const port = await listen(server)
  await closeServer(server)
  return port
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

function stopChild(pid) {
  if (!pid) return
  spawnSync(process.platform === 'win32' ? 'taskkill' : 'kill', process.platform === 'win32'
    ? ['/pid', String(pid), '/t', '/f']
    : ['-TERM', String(pid)], { stdio: 'ignore', windowsHide: true })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
