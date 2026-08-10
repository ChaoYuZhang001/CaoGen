#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const puppeteer = require('puppeteer-core')
const appExecutable = path.resolve(repoRoot, argValue('--app') || 'dist/win-unpacked/CaoGen.exe')
const appEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path')
)
appEnv.Path = [path.dirname(appExecutable), process.env.Path ?? process.env.PATH]
  .filter(Boolean)
  .join(path.delimiter)
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'windows-unpacked-renderer-smoke', runId)
const userDataDir = mkdtempSync(path.join(tmpdir(), 'caogen-unpacked-renderer-smoke-'))
const report = {
  status: 'failed',
  evidenceClass: 'development_diagnostic',
  closesInstalledPackageFindings: false,
  runId,
  reportDir: path.relative(repoRoot, reportDir),
  appExecutable: path.relative(repoRoot, appExecutable),
  git: readGitState(),
  launches: [],
  failure: null,
  cleanup: { status: 'pending', failure: null }
}

mkdirSync(reportDir, { recursive: true })

try {
  if (process.platform !== 'win32') throw new Error(`Windows diagnostic must run on win32, got ${process.platform}`)
  if (process.arch !== 'x64') throw new Error(`Windows diagnostic must run on x64, got ${process.arch}`)
  if (!existsSync(appExecutable)) throw new Error(`unpacked app is missing: ${report.appExecutable}`)

  report.launches.push(await runLaunch('first-launch'))
  report.launches.push(await runLaunch('restart'))
  report.status = 'passed'
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  try {
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 })
    report.cleanup.status = 'passed'
  } catch (error) {
    report.cleanup.status = 'failed'
    report.cleanup.failure = error instanceof Error ? error.message : String(error)
    report.status = 'failed'
    process.exitCode = 1
  }
  report.finishedAt = new Date().toISOString()
  writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  const latestPath = path.join(repoRoot, 'test-results', 'windows-unpacked-renderer-smoke', 'latest.json')
  writeFileSync(latestPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(report, null, 2))
}

async function runLaunch(label) {
  const port = await availablePort()
  const startedAt = Date.now()
  let stderr = ''
  let browser
  const child = spawn(appExecutable, [
    `--remote-debugging-port=${port}`,
    '--in-process-gpu',
    '--enable-logging=stderr'
  ], {
    cwd: repoRoot,
    env: {
      ...appEnv,
      CAOGEN_USER_DATA_DIR: userDataDir,
      ELECTRON_ENABLE_LOGGING: '1'
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-64 * 1024) })

  try {
    await waitForDebugPort(child, port, 20_000)
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${port}`,
      defaultViewport: null
    })
    const page = await waitForRendererPage(browser, child, 20_000)
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))

    const observation = await page.evaluate(async () => {
      const settings = await window.agentDesk.getSettings()
      return {
        documentTitle: document.title,
        documentLanguage: document.documentElement.lang,
        settingsLanguage: settings.language,
        rootChildCount: document.querySelector('#root')?.children.length ?? 0,
        bodyTextLength: document.body.innerText.trim().length,
        preloadReady: typeof window.agentDesk === 'object',
        modeSwitcherPresent: document.querySelector('[data-experience-mode-switcher]') != null,
        welcomeComposerPresent: document.querySelector('.welcome-composer-input') != null
      }
    })
    const screenshot = path.join(reportDir, `${label}.png`)
    await page.screenshot({ path: screenshot, fullPage: false })

    if (pageErrors.length > 0) throw new Error(`renderer page error: ${pageErrors.join(' | ')}`)
    if (/Uncaught Exception|Cannot find module|NODE_MODULE_VERSION/i.test(stderr)) {
      throw new Error('unpacked app emitted a main-process module loading error')
    }
    return {
      label,
      status: 'passed',
      timeToInteractiveMs: Date.now() - startedAt,
      screenshot: path.relative(repoRoot, screenshot),
      ...observation
    }
  } finally {
    if (browser) {
      const pages = await browser.pages().catch(() => [])
      await Promise.all(pages.map((page) => page.close({ runBeforeUnload: true }).catch(() => undefined)))
    }
    if (browser) await browser.disconnect().catch(() => undefined)
    await stopChild(child)
  }
}

async function waitForDebugPort(child, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`unpacked app exited before exposing DevTools: ${child.exitCode ?? child.signalCode}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1_000)
      })
      if (response.ok) return
    } catch {
      // Electron has not finished initializing yet.
    }
    await delay(200)
  }
  throw new Error(`unpacked app did not expose DevTools within ${timeoutMs}ms`)
}

async function waitForRendererPage(browser, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`unpacked app exited before creating a renderer: ${child.exitCode ?? child.signalCode}`)
    }
    for (const page of await browser.pages()) {
      try {
        if (!/\/out\/renderer\/index\.html(?:[?#].*)?$/.test(page.url())) continue
        const ready = await page.evaluate(() => {
          const root = document.querySelector('#root')
          return document.title === 'CaoGen' &&
            root != null &&
            root.children.length > 0 &&
            document.body.innerText.trim().length > 0 &&
            typeof window.agentDesk === 'object' &&
            document.querySelector('[data-experience-mode-switcher]') != null &&
            document.querySelector('.welcome-composer-input') != null
        })
        if (ready) return page
      } catch {
        // Electron can replace the initial renderer frame while the window boots.
      }
    }
    await delay(200)
  }
  throw new Error(`unpacked app did not create a renderer within ${timeoutMs}ms`)
}

async function availablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve) => server.close(resolve))
  if (!port) throw new Error('unable to reserve a local debugging port')
  return port
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
    stdio: 'ignore',
    windowsHide: true
  })
  const deadline = Date.now() + 5_000
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(100)
}

function readGitState() {
  const commit = gitOutput(['rev-parse', 'HEAD'])
  const status = gitOutput(['status', '--porcelain=v1', '--untracked-files=all'])
  return {
    commit,
    worktreeClean: status.length === 0,
    statusEntryCount: status ? status.split(/\r?\n/).filter(Boolean).length : 0
  }
}

function gitOutput(args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch {
    return ''
  }
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  const prefix = `${name}=`
  const inline = process.argv.find((item) => item.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : undefined
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
