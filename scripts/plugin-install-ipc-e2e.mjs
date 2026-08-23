#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-plugin-ipc-'))
const fixtureHome = path.join(tempRoot, 'home')
const userDataDir = path.join(tempRoot, 'user-data')
const sourcePath = path.join(tempRoot, 'PLUGIN_IPC_SOURCE_PATH_SENSITIVE')
const sourceContent = 'PLUGIN_IPC_SOURCE_CONTENT_SENSITIVE'
const pluginName = 'ipc-effect-plugin'
const pluginRoot = path.join(fixtureHome, '.caogen', 'plugins')
const activePath = path.join(pluginRoot, pluginName)
const electronBin = process.platform === 'darwin'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  : process.platform === 'win32'
    ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron')
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')
const port = await freePort()

assert(existsSync(electronBin), 'Electron binary is missing')
assert(existsSync(mainEntry), 'built main entry is missing; run npm run build first')
mkdirSync(fixtureHome, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
mkdirSync(sourcePath, { recursive: true })
writeFileSync(path.join(sourcePath, 'plugin.json'), JSON.stringify({ name: pluginName, version: '1.0.0' }))
writeFileSync(path.join(sourcePath, 'SKILL.md'), sourceContent)

const child = spawn(electronBin, [`--remote-debugging-port=${port}`, mainEntry], {
  cwd: repoRoot,
  env: {
    ...process.env,
    HOME: fixtureHome,
    USERPROFILE: fixtureHome,
    HOMEDRIVE: '',
    HOMEPATH: fixtureHome,
    XDG_CONFIG_HOME: path.join(fixtureHome, '.config'),
    CAOGEN_USER_DATA_DIR: userDataDir,
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

let stderr = ''
child.stderr.on('data', (chunk) => { stderr += chunk })
let browser
try {
  browser = await connectBrowser(port, 25_000)
  const page = await applicationPage(browser)
  await page.waitForFunction(
    () => typeof window.agentDesk?.installLocalPlugin === 'function' &&
      typeof window.agentDesk?.uninstallPlugin === 'function' &&
      typeof window.agentDesk?.listTaskSnapshots === 'function',
    { timeout: 20_000 }
  )

  const installed = await page.evaluate(
    (source) => window.agentDesk.installLocalPlugin(source, false),
    sourcePath
  )
  assert(installed.ok, `Electron install failed: ${JSON.stringify(installed)}`)
  assertEqual(installed.effectStatus, 'confirmed')
  assertEqual(realpathSync(installed.installedPath), realpathSync(activePath))
  assertEqual(readFileSync(path.join(activePath, 'SKILL.md'), 'utf8'), sourceContent)
  assertEqual((await page.evaluate(() => window.agentDesk.listTaskSnapshots())).length, 0,
    'confirmed install must not retain a recovery snapshot')

  const uninstalled = await page.evaluate(
    (target) => window.agentDesk.uninstallPlugin(target),
    activePath
  )
  assert(uninstalled.ok, `Electron uninstall failed: ${JSON.stringify(uninstalled)}`)
  assertEqual(uninstalled.effectStatus, 'confirmed')
  assert(!existsSync(activePath), 'active plugin path survived uninstall')
  const trash = path.join(pluginRoot, '.trash')
  assert(existsSync(trash) && readdirSync(trash).length === 1, 'uninstall did not retain one recoverable plugin')
  assertEqual((await page.evaluate(() => window.agentDesk.listTaskSnapshots())).length, 0,
    'confirmed uninstall must not retain a recovery snapshot')

  const database = readFileSync(path.join(userDataDir, 'task-snapshots.db'))
  for (const canary of [path.basename(sourcePath), sourceContent]) {
    assert(!database.includes(Buffer.from(canary)), `Electron Effect ledger leaked source input: ${canary}`)
  }
  console.log('plugin install IPC electron e2e: PASS')
} finally {
  if (browser) {
    await Promise.race([browser.close().catch(() => undefined), delay(3_000)])
  }
  await stopChild(child)
  rmSync(tempRoot, { recursive: true, force: true })
}

async function connectBrowser(debugPort, timeoutMs) {
  const started = Date.now()
  let lastError
  while (Date.now() - started < timeoutMs) {
    try {
      return await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}` })
    } catch (error) {
      lastError = error
      if (child.exitCode !== null) throw new Error(`Electron exited early (${child.exitCode}): ${stderr}`)
      await delay(100)
    }
  }
  throw new Error(`Electron debugger did not start: ${String(lastError)}\n${stderr}`)
}

async function applicationPage(targetBrowser) {
  const started = Date.now()
  while (Date.now() - started < 20_000) {
    const pages = await targetBrowser.pages()
    const page = pages.find((candidate) => !candidate.url().startsWith('devtools://'))
    if (page) return page
    await delay(100)
  }
  throw new Error('Electron renderer page did not appear')
}

function stopChild(target) {
  return new Promise((resolve) => {
    if (target.exitCode !== null || target.signalCode !== null) return resolve()
    const timer = setTimeout(() => target.kill('SIGKILL'), 5_000)
    target.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    target.kill('SIGTERM')
  })
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const selected = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolve(selected))
    })
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assertEqual(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(`${message ? `${message}: ` : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
