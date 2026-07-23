#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'packaged-app-smoke')
const reportDir = path.join(reportRoot, runId)
const appExecutable = path.join(repoRoot, 'dist', 'mac', 'CaoGen.app', 'Contents', 'MacOS', 'CaoGen')
const userDataDir = mkdtempSync(path.join(tmpdir(), 'caogen-packaged-app-smoke-'))
const git = readGitState()
let child
let stderr = ''
let target
let failure
let cleanupFailure

try {
  if (process.platform !== 'darwin') throw new Error('packaged macOS app smoke requires macOS')
  if (!existsSync(appExecutable)) throw new Error(`packaged app executable is missing: ${path.relative(repoRoot, appExecutable)}`)

  const port = await availablePort()
  child = spawn(appExecutable, [`--remote-debugging-port=${port}`, '--enable-logging=stderr'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAOGEN_USER_DATA_DIR: userDataDir,
      ELECTRON_ENABLE_LOGGING: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-64 * 1024)
  })

  target = await waitForRenderer(child, port, 30_000)
  if (/Uncaught Exception|Cannot find module/i.test(stderr)) {
    throw new Error('packaged app emitted a main-process module loading error')
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error)
} finally {
  await stopChild(child)
  try {
    await removeDirectoryWhenQuiescent(userDataDir, 15_000)
  } catch (error) {
    cleanupFailure = error instanceof Error ? error.message : String(error)
  }
}

if (!failure && cleanupFailure) failure = `temporary user-data cleanup failed: ${cleanupFailure}`

const report = {
  status: failure ? 'failed' : 'passed',
  runId,
  reportDir,
  packageVersion: packageJson.version,
  appExecutable: path.relative(repoRoot, appExecutable),
  git,
  target,
  failure,
  cleanup: {
    status: cleanupFailure ? 'failed' : 'passed',
    failure: cleanupFailure
  }
}
mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log(JSON.stringify(report, null, 2))
if (failure) process.exitCode = 1

async function waitForRenderer(processHandle, port, timeoutMs) {
  let exit
  processHandle.once('exit', (code, signal) => {
    exit = { code, signal }
  })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (exit) throw new Error(`packaged app exited before creating a renderer: ${JSON.stringify(exit)}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2_000)
      })
      if (response.ok) {
        const targets = await response.json()
        const page = Array.isArray(targets)
          ? targets.find((item) => item?.type === 'page' && item?.title === 'CaoGen' && /out\/renderer\/index\.html$/.test(item?.url || ''))
          : undefined
        if (page) return { type: page.type, title: page.title, url: page.url }
      }
    } catch {
      // The debugging endpoint is unavailable while Electron initializes.
    }
    await delay(250)
  }
  throw new Error('packaged app did not create the CaoGen renderer within 30 seconds')
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

async function stopChild(processHandle) {
  if (!processHandle || processHandle.exitCode !== null || processHandle.signalCode !== null) return
  processHandle.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise((resolve) => processHandle.once('exit', () => resolve(true))),
    delay(5_000).then(() => false)
  ])
  if (!exited) processHandle.kill('SIGKILL')
}

async function removeDirectoryWhenQuiescent(targetPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      rmSync(targetPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      if (!existsSync(targetPath)) return
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }
  if (lastError) throw lastError
  throw new Error(`temporary directory still exists after ${timeoutMs}ms: ${targetPath}`)
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
