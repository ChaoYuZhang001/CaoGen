#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const puppeteer = require('puppeteer-core')
const appExecutable = path.resolve(repoRoot, argValue('--app') || 'dist/win-unpacked/CaoGen.exe')
const userDataDir = mkdtempSync(path.join(tmpdir(), 'caogen-provider-catalog-'))
const outputDir = path.join(repoRoot, 'test-results', 'provider-preset-catalog-e2e')
const screenshotPath = path.join(outputDir, 'latest.png')

if (!existsSync(appExecutable)) throw new Error(`unpacked app is missing: ${appExecutable}`)
mkdirSync(outputDir, { recursive: true })

const port = await availablePort()
const child = spawn(appExecutable, [`--remote-debugging-port=${port}`, '--in-process-gpu'], {
  cwd: repoRoot,
  env: { ...process.env, CAOGEN_USER_DATA_DIR: userDataDir },
  stdio: 'ignore',
  windowsHide: true
})
let browser

try {
  await waitForDebugPort(port)
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null })
  const page = await waitForRendererPage(browser)
  await page.click('.sidebar-footer .sidebar-nav-item')
  await page.waitForSelector('[data-settings-tab="providers"]', { visible: true })
  await page.click('[data-settings-tab="providers"]')
  await page.waitForSelector('.provider-profile-actions button:last-child', { visible: true })
  await page.click('.provider-profile-actions button:last-child')
  await page.waitForSelector('[data-provider-quick-setup] [data-provider-preset-catalog]', { visible: true })

  const initialCardCount = await page.$$eval('.provider-preset-card', (items) => items.length)
  assert(initialCardCount >= 15, `expected at least 15 quick presets, got ${initialCardCount}`)
  await page.type('.provider-preset-search', 'OpenRouter')
  await page.waitForFunction(() => document.querySelectorAll('.provider-preset-card').length === 1)
  const matchedText = await page.$eval('.provider-preset-card', (element) => element.textContent ?? '')
  assert(matchedText.includes('OpenRouter'), 'search must isolate the OpenRouter preset')
  await page.click('.provider-preset-card .btn-primary')

  const applied = await page.evaluate(() => ({
    baseUrl: document.querySelector('[data-provider-quick-field="base-url"]')?.value,
    name: document.querySelector('[data-provider-quick-field="name"]')?.value,
    protocol: document.querySelector('.provider-quick-protocol')?.textContent ?? '',
    bodyWidth: document.body.scrollWidth,
    viewportWidth: document.documentElement.clientWidth
  }))
  assert(applied.baseUrl === 'https://openrouter.ai/api/v1', `unexpected OpenRouter Base URL: ${applied.baseUrl}`)
  assert(String(applied.name).includes('OpenRouter'), 'applying the preset must update the Provider name')
  assert(applied.protocol.includes('Chat'), 'OpenRouter must use Chat Completions')
  assert(applied.bodyWidth <= applied.viewportWidth + 1, 'Provider catalog must not cause horizontal page overflow')

  await page.screenshot({ path: screenshotPath, fullPage: false })
  console.log(JSON.stringify({
    status: 'passed',
    appExecutable: path.relative(repoRoot, appExecutable),
    initialCardCount,
    screenshot: path.relative(repoRoot, screenshotPath),
    selectedPreset: 'openrouter'
  }, null, 2))
} finally {
  if (browser) await browser.disconnect().catch(() => undefined)
  stopChild(child.pid)
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function waitForRendererPage(connectedBrowser) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    for (const page of await connectedBrowser.pages()) {
      if (!/\/out\/renderer\/index\.html/.test(page.url())) continue
      const ready = await page.evaluate(() => document.querySelector('.welcome-composer-input') != null).catch(() => false)
      if (ready) return page
    }
    await delay(150)
  }
  throw new Error('renderer did not become interactive')
}

async function waitForDebugPort(debugPort) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(800) })
      if (response.ok) return
    } catch {
      // Electron is still starting.
    }
    await delay(150)
  }
  throw new Error('debug endpoint did not become available')
}

async function availablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const portValue = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve) => server.close(resolve))
  return portValue
}

function stopChild(pid) {
  if (!pid) return
  spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
