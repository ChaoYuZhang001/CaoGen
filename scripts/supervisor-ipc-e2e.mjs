#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'

const repoRoot = process.cwd()
const startedAt = new Date().toISOString()
const runId = startedAt.replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'supervisor-ipc-e2e')
const reportDir = path.join(reportRoot, runId)
const reportPath = path.join(reportDir, 'report.json')
const latestPath = path.join(reportRoot, 'latest.json')
const require = createRequire(path.join(repoRoot, 'package.json'))
const electronBin = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules/electron/dist/electron.exe')
  : path.join(repoRoot, 'node_modules/.bin/electron')
const mainEntry = path.join(repoRoot, 'out/main/index.js')
const rendererEntry = path.join(repoRoot, 'out/renderer/index.html')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-supervisor-ipc-'))
const userData = path.join(tempRoot, 'user-data')
const memoryDir = path.join(tempRoot, 'memory')

let child
let browser
let puppeteer
let result
let failure
try {
  puppeteer = require('puppeteer-core')
  assert(existsSync(electronBin), 'Electron binary is missing; run npm run build first')
  assert(existsSync(mainEntry) && existsSync(rendererEntry), 'built app is missing; run npm run build first')
  const port = await findFreePort(9970)
  child = spawn(electronBin, [`--remote-debugging-port=${port}`, mainEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAOGEN_USER_DATA_DIR: userData,
      CAOGEN_MEMORY_DIR: memoryDir,
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: ''
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  })
  const stderr = []
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()))
  await waitFor(() => fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.ok).catch(() => false), 20_000)
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null })
  const page = await waitFor(async () => (await browser.pages()).find((candidate) => !candidate.url().startsWith('devtools://')), 20_000)
  await page.waitForFunction(() => typeof window.agentDesk?.createSupervisorRun === 'function', { timeout: 20_000 })

  const ipc = await page.evaluate(async () => {
    const api = window.agentDesk
    const created = await api.createSupervisorRun({
      id: 'ipc-run', projectId: 'ipc-project', goalId: 'ipc-goal', workItemId: 'ipc-work', maxRetries: 2
    })
    const lease = await api.acquireSupervisorLease('ipc-run', {
      ownerId: 'ipc-worker', expectedRevision: created.revision, ttlMs: 30_000
    })
    const running = await api.startSupervisorRun('ipc-run', {
      ownerId: 'ipc-worker', leaseId: lease.lease.id, fencingToken: lease.lease.fencingToken, expectedRevision: lease.revision
    })
    const waiting = await api.requestSupervisorApproval('ipc-run', { id: 'ipc-approval', reason: 'IPC gate' }, {
      ownerId: 'ipc-worker', leaseId: running.lease.id, fencingToken: running.lease.fencingToken, expectedRevision: running.revision
    })
    const paused = await api.resolveSupervisorApproval('ipc-run', {
      approvalId: 'ipc-approval', approved: true, expectedRevision: waiting.revision
    })
    const nextLease = await api.acquireSupervisorLease('ipc-run', {
      ownerId: 'ipc-worker-2', expectedRevision: paused.revision, ttlMs: 30_000
    })
    const resumed = await api.resumeSupervisorRun('ipc-run', {
      ownerId: 'ipc-worker-2', leaseId: nextLease.lease.id, fencingToken: nextLease.lease.fencingToken, expectedRevision: nextLease.revision
    })
    const completed = await api.completeSupervisorRun('ipc-run', {
      ownerId: 'ipc-worker-2', leaseId: resumed.lease.id, fencingToken: resumed.lease.fencingToken, expectedRevision: resumed.revision
    })
    let forgedError = ''
    try {
      await api.createSupervisorRun({ id: 'forged', projectId: 'ipc-project', workItemId: 'ipc-work' }, { actorId: 'forged-user' })
    } catch (error) {
      forgedError = error instanceof Error ? error.message : String(error)
    }
    const events = await api.listSupervisorEvents('ipc-run')
    return { status: completed.status, fencingToken: completed.fencingToken, eventCount: events.length, forgedError }
  })
  assert.equal(ipc.status, 'completed')
  assert.equal(ipc.fencingToken, 2)
  assert(ipc.eventCount >= 8)
  assert.match(ipc.forgedError, /unknown field|contains unknown/i)

  await closeRuntime()
  child = undefined
  browser = undefined

  const restart = await launchAgain()
  assert.equal(restart.status, 'completed')
  assert(restart.eventCount >= 8)
  await closeRuntime()
  result = { status: 'PASS', ipc, restart }
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  failure = serializeError(error)
  throw error
} finally {
  await closeRuntime()
  rmSync(tempRoot, { recursive: true, force: true })
  writeReport({
    schemaVersion: 1,
    status: result ? 'passed' : 'failed',
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    gate: 'test:supervisor-ipc',
    result: result ?? null,
    error: failure,
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version
    }
  })
}

function writeReport(report) {
  try {
    mkdirSync(reportDir, { recursive: true })
    const body = `${JSON.stringify({
      ...report,
      reportDir: path.relative(repoRoot, reportDir),
      reportPath: path.relative(repoRoot, reportPath)
    }, null, 2)}\n`
    writeFileSync(reportPath, body, 'utf8')
    writeFileSync(latestPath, body, 'utf8')
  } catch (error) {
    console.error(`Supervisor IPC report could not be written: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    code: error && typeof error === 'object' && 'code' in error ? error.code : undefined
  }
}

async function launchAgain() {
  const port = await findFreePort(9970)
  child = spawn(electronBin, [`--remote-debugging-port=${port}`, mainEntry], {
    cwd: repoRoot,
    env: { ...process.env, CAOGEN_USER_DATA_DIR: userData, CAOGEN_MEMORY_DIR: memoryDir, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  })
  await waitFor(() => fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.ok).catch(() => false), 20_000)
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null })
  const page = await waitFor(async () => (await browser.pages()).find((candidate) => !candidate.url().startsWith('devtools://')), 20_000)
  await page.waitForFunction(() => typeof window.agentDesk?.listSupervisorRuns === 'function', { timeout: 20_000 })
  return page.evaluate(async () => {
    const runs = await window.agentDesk.listSupervisorRuns({ projectId: 'ipc-project' })
    const events = await window.agentDesk.listSupervisorEvents('ipc-run')
    return { status: runs.find((run) => run.id === 'ipc-run')?.status, eventCount: events.length }
  })
}

async function closeRuntime() {
  if (browser) {
    await Promise.race([browser.close().catch(() => undefined), sleep(3_000)])
    browser = undefined
  }
  if (!child || child.exitCode !== null) return
  signalChild('SIGTERM')
  await Promise.race([onceExit(child), sleep(3_000)])
  if (child.exitCode === null) signalChild('SIGKILL')
  child = undefined
}

function signalChild(signal) {
  if (!child || child.exitCode !== null) return
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    child.kill(signal)
  }
}

function onceExit(process) {
  return new Promise((resolve) => process.once('exit', resolve))
}

async function waitFor(producer, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await producer()
    if (value) return value
    await sleep(100)
  }
  throw new Error('timed out waiting for Electron')
}

async function findFreePort(start) {
  for (let port = start; port < start + 100; port += 1) {
    if (await canListen(port)) return port
  }
  throw new Error(`no free port from ${start}`)
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
