#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const puppeteer = require('puppeteer-core')
const appExecutable = path.resolve(repoRoot, argValue('--app') || 'dist/win-unpacked/CaoGen.exe')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'typescript-language-server-packaged', runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-packaged-typescript-lsp-'))
const userDataDir = path.join(tempRoot, 'userData')
const projectDir = path.join(tempRoot, 'project')
const unpackedModules = path.join(path.dirname(appExecutable), 'resources', 'app.asar.unpacked', 'node_modules')
const serverCli = path.join(unpackedModules, 'typescript-language-server', 'lib', 'cli.mjs')
const tsserver = path.join(unpackedModules, 'typescript', 'lib', 'tsserver.js')
const appAsar = path.join(path.dirname(appExecutable), 'resources', 'app.asar')
const report = {
  status: 'failed',
  evidenceClass: 'packaged_runtime',
  runId,
  appExecutable: path.relative(repoRoot, appExecutable),
  appAsarSha256: existsSync(appAsar) ? sha256(appAsar) : null,
  runtime: {
    serverCliPresent: existsSync(serverCli),
    tsserverPresent: existsSync(tsserver),
    isolatedPath: true,
    externalIdeRequired: false
  },
  checks: [],
  failure: null,
  cleanup: 'pending',
  cleanupFailure: null
}

mkdirSync(reportDir, { recursive: true })
mkdirSync(path.join(projectDir, 'src'), { recursive: true })
const util = 'export function greet(name: string): string { return `Hello ${name}` }\n'
const consumer = "import { greet } from './util'\nconst result: number = greet('x')\ngre\n"
writeFileSync(path.join(projectDir, 'tsconfig.json'), JSON.stringify({
  compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' },
  include: ['src/**/*.ts']
}))
writeFileSync(path.join(projectDir, 'src', 'util.ts'), util)
writeFileSync(path.join(projectDir, 'src', 'consumer.ts'), consumer)

let child
let browser
try {
  check('packaged language-server CLI exists', report.runtime.serverCliPresent)
  check('packaged TypeScript tsserver exists', report.runtime.tsserverPresent)
  const port = await availablePort()
  const cleanPath = [
    path.dirname(appExecutable),
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
    process.env.SystemRoot || 'C:\\Windows'
  ].join(path.delimiter)
  const env = { ...process.env, Path: cleanPath, PATH: cleanPath, CAOGEN_USER_DATA_DIR: userDataDir }
  delete env.NODE_PATH
  delete env.ELECTRON_RUN_AS_NODE
  let stderr = ''
  child = spawn(appExecutable, [`--remote-debugging-port=${port}`, '--in-process-gpu', '--enable-logging=stderr'], {
    cwd: tempRoot,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-64 * 1024) })
  await waitForDebugPort(child, port, 30_000)
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null })
  const page = await waitForRendererPage(browser, child, 30_000)
  const result = await page.evaluate(async ({ projectDir, util, consumer }) => {
    const api = window.agentDesk
    const provider = await api.createProvider({
      name: 'Packaged Language Runtime',
      baseUrl: 'http://127.0.0.1:9',
      token: 'test-only',
      models: ['packaged-lsp'],
      engine: 'openai',
      openaiProtocol: 'responses'
    })
    const session = await api.createSession({
      cwd: projectDir,
      engine: 'openai',
      providerId: provider.id,
      model: 'packaged-lsp',
      routingScope: 'fixed',
      taskStrategy: 'execute',
      isolated: false,
      title: 'Packaged language runtime'
    })
    const completion = await api.getTypeScriptCompletions(session.id, {
      path: 'src/consumer.ts', content: consumer, line: 3, column: 4
    })
    const hover = await api.getTypeScriptHover(session.id, {
      path: 'src/util.ts', content: util, line: 1, column: 19
    })
    const definition = await api.getTypeScriptDefinitions(session.id, {
      path: 'src/consumer.ts', content: consumer, line: 2, column: 26
    })
    const diagnostics = await api.getTypeScriptDiagnostics(session.id, {
      path: 'src/consumer.ts', content: consumer, line: 2, column: 26
    })
    return {
      engines: [completion.engine, hover.engine, definition.engine, diagnostics.engine],
      completionOk: completion.ok && completion.items.some((item) => item.label === 'greet'),
      hoverOk: hover.ok && /greet.*string/is.test(hover.markdown),
      definitionOk: definition.ok && definition.locations.some((item) => item.path === 'src/util.ts' && item.line === 1),
      diagnosticsOk: diagnostics.ok && diagnostics.diagnostics.some((item) => item.code === '2322' && item.severity === 'error')
    }
  }, { projectDir, util, consumer })
  check('packaged IPC returns TypeScript LSP completion', result.completionOk)
  check('packaged IPC returns TypeScript LSP hover', result.hoverOk)
  check('packaged IPC returns cross-file source definition', result.definitionOk)
  check('packaged IPC returns semantic TS2322 diagnostic', result.diagnosticsOk)
  check('all packaged semantic calls report the bundled engine', result.engines.every((engine) => engine === 'typescript-lsp'))
  check('packaged app has no module-loading failure', !/Cannot find module|Uncaught Exception|NODE_MODULE_VERSION/i.test(stderr))
  await page.screenshot({ path: path.join(reportDir, 'packaged-language-runtime.png') })
  report.status = 'passed'
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  if (browser) await browser.disconnect().catch(() => undefined)
  await stopChild(child)
  try {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    report.cleanup = 'passed'
  } catch (error) {
    report.cleanup = 'failed'
    report.cleanupFailure = error instanceof Error ? error.message : String(error)
    report.status = 'failed'
    process.exitCode = 1
  }
  report.finishedAt = new Date().toISOString()
  writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`packaged TypeScript language runtime ${report.status}: ${report.checks.filter((item) => item.ok).length}/${report.checks.length}`)
  console.log(path.relative(repoRoot, reportDir))
}

function check(name, value) {
  const ok = Boolean(value)
  report.checks.push({ name, ok })
  if (!ok) throw new Error(name)
}

async function availablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  await new Promise((resolve) => server.close(resolve))
  if (!address || typeof address === 'string') throw new Error('unable to reserve DevTools port')
  return address.port
}

async function waitForDebugPort(process, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`packaged app exited early (${process.exitCode})`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
    } catch { /* app is still starting */ }
    await delay(200)
  }
  throw new Error('packaged app did not expose DevTools')
}

async function waitForRendererPage(browserValue, process, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`packaged app exited early (${process.exitCode})`)
    for (const page of await browserValue.pages()) {
      try {
        if (await page.evaluate(() => document.title === 'CaoGen' && typeof window.agentDesk === 'object')) return page
      } catch { /* renderer is still replacing its initial frame */ }
    }
    await delay(200)
  }
  throw new Error('packaged renderer did not become interactive')
}

async function stopChild(process) {
  if (!process || process.exitCode !== null) return
  spawnSync('taskkill', ['/pid', String(process.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
  const deadline = Date.now() + 5_000
  while (process.exitCode === null && Date.now() < deadline) await delay(100)
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}
