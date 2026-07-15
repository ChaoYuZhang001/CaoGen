#!/usr/bin/env node

import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { cpus, freemem, platform, release, tmpdir, totalmem } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const { PNG } = require('pngjs')
const required = process.argv.includes('--required')
const scenarioCounts = parseScenarioCounts(readArg('--scenarios') ?? '1,6,12')
const sampleFrames = readPositiveInteger('--sample-frames', 180)
const warmupFrames = readPositiveInteger('--warmup-frames', 60)
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'office-performance')
const runDir = path.join(reportRoot, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-office-performance-'))
const userDataDir = path.join(tempRoot, 'userData')
const projectDir = path.join(tempRoot, 'project')
const electronBin =
  process.platform === 'win32'
    ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')
const rendererEntry = path.join(repoRoot, 'out', 'renderer', 'index.html')

const targets = {
  1: {
    firstNonblankMsMaximum: 5_000,
    medianFrameMsMaximum: 22,
    p95FrameMsMaximum: 34
  },
  6: {
    firstNonblankMsMaximum: 5_000,
    medianFrameMsMaximum: 25,
    p95FrameMsMaximum: 40
  },
  12: {
    firstNonblankMsMaximum: 7_000,
    medianFrameMsMaximum: 34,
    p95FrameMsMaximum: 50
  }
}
const regressionBudgets = {
  1: {
    firstNonblankMsMaximum: 5_000,
    medianFrameMsMaximum: 50,
    p95FrameMsMaximum: 60
  },
  6: {
    firstNonblankMsMaximum: 9_000,
    medianFrameMsMaximum: 85,
    p95FrameMsMaximum: 105
  },
  12: {
    firstNonblankMsMaximum: 12_000,
    medianFrameMsMaximum: 125,
    p95FrameMsMaximum: 150
  }
}
const artifactTargets = {
  officeChunkBytesMaximum: 1_800_000,
  robotGlbBytesMaximum: 8_000_000
}
const artifactRegressionBudgets = {
  officeChunkBytesMaximum: 2_200_000,
  robotGlbBytesMaximum: 12_700_000
}

if (!existsSync(electronBin)) fail('Electron binary not found. Run npm install first.')
if (!existsSync(mainEntry) || !existsSync(rendererEntry)) {
  fail('Built Electron app not found. Run npm run build first.')
}

mkdirSync(runDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
mkdirSync(projectDir, { recursive: true })
writeFileSync(path.join(projectDir, 'README.md'), '# CaoGen 3D Office performance fixture\n')
writeFixtureUserData()

const report = {
  runId,
  required,
  status: 'running',
  repoRoot,
  runDir,
  environment: hostEnvironment(),
  config: { scenarioCounts, sampleFrames, warmupFrames },
  targets,
  regressionBudgets,
  artifactTargets,
  artifactRegressionBudgets,
  artifacts: artifactMetrics(),
  scenarios: [],
  checks: [],
  warnings: []
}
report.checks.push({
  name: '3D Office artifact budgets',
  status:
    report.artifacts.regressionViolations.length > 0
      ? required
        ? 'fail'
        : 'warn'
      : report.artifacts.targetViolations.length > 0
        ? 'warn'
        : 'pass',
  targetViolations: report.artifacts.targetViolations,
  regressionViolations: report.artifacts.regressionViolations
})

const remotePort = await findFreePort(9860)
const app = spawn(electronBin, [`--remote-debugging-port=${remotePort}`, mainEntry], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CAOGEN_USER_DATA_DIR: userDataDir,
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: ''
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

let browser
try {
  await waitForDebugPort(remotePort, 20_000)
  browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${remotePort}`,
    defaultViewport: null
  })
  const pages = await browser.pages()
  const page = pages.find((item) => !item.url().startsWith('devtools://')) || pages[0]
  if (!page) throw new Error('Electron page target not found')

  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      report.warnings.push(`console ${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => {
    report.warnings.push(`pageerror: ${error.stack || error.message}`)
  })

  await waitForApp(page)
  await page.evaluate(() => {
    window.sessionStorage.setItem('caogen.office.performance', '1')
  })

  let createdSessions = 0
  for (const count of scenarioCounts) {
    const addCount = count - createdSessions
    if (addCount > 0) {
      await createIdleSessions(page, addCount, createdSessions, projectDir)
      createdSessions = count
    }

    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForApp(page)

    const openedAt = Date.now()
    await page.click('.sidebar-office')
    await page.waitForSelector('.office canvas', { timeout: 20_000 })
    await page.waitForFunction(
      (expected) =>
        Number(document.querySelector('.office-canvas-wrap')?.getAttribute('data-office-sessions') ?? 0) === expected,
      { timeout: 20_000 },
      count
    )
    await page.waitForFunction(
      () => typeof window.__caogenOfficePerformance?.snapshot === 'function',
      { timeout: 20_000 }
    )

    const canvas = await waitForNonblankCanvas(page, 15_000)
    const firstNonblankMs = Date.now() - openedAt
    const measurement = await collectFrameMetrics(page, warmupFrames, sampleFrames)
    const screenshot = path.join(runDir, `office-${count}-agents.png`)
    await page.screenshot({ path: screenshot, fullPage: false })

    const scenario = {
      agents: count,
      loadKind: count === scenarioCounts[0] ? 'cold' : 'warm-remount',
      firstNonblankMs,
      canvas,
      ...measurement,
      screenshot,
      target: targets[count] ?? null,
      regressionBudget: regressionBudgets[count] ?? null,
      targetViolations: [],
      regressionViolations: []
    }
    scenario.targetViolations = evaluateScenario(scenario, scenario.target, 'target')
    scenario.regressionViolations = evaluateScenario(
      scenario,
      scenario.regressionBudget,
      'regression budget'
    )
    report.scenarios.push(scenario)
    report.checks.push({
      name: `${count}-agent office performance`,
      status:
        scenario.regressionViolations.length > 0
          ? required
            ? 'fail'
            : 'warn'
          : scenario.targetViolations.length > 0
            ? 'warn'
            : 'pass',
      targetViolations: scenario.targetViolations,
      regressionViolations: scenario.regressionViolations
    })

    await page.click('.office-actions .btn-primary')
    await page.waitForFunction(() => !document.querySelector('.office-canvas-wrap'), { timeout: 10_000 })
  }
} catch (error) {
  report.error = error instanceof Error ? error.stack || error.message : String(error)
  report.checks.push({
    name: 'office performance runtime',
    status: 'fail',
    violations: [error instanceof Error ? error.message : String(error)]
  })
} finally {
  if (browser) await browser.disconnect().catch(() => undefined)
  const exited = await terminate(app)
  report.warnings.push(...summarizeProcessOutput(stdout, stderr, exited))
  if (process.env.CAOGEN_KEEP_TEST_TMP !== '1') rmSync(tempRoot, { recursive: true, force: true })
}

const failures = report.checks.filter((item) => item.status === 'fail')
const warnings = report.checks.filter((item) => item.status === 'warn')
report.status = failures.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass'
report.summary = {
  pass: report.checks.filter((item) => item.status === 'pass').length,
  warn: warnings.length,
  fail: failures.length
}
writeReports(report)

if (failures.length > 0) {
  console.error(`office performance gate failed: ${path.join(reportRoot, 'latest.json')}`)
  process.exitCode = 1
} else {
  console.log(`office performance ${report.status}: ${path.join(reportRoot, 'latest.json')}`)
}

async function createIdleSessions(page, count, offset, cwd) {
  await page.evaluate(
    async ({ count: amount, offset: start, cwd: projectPath }) => {
      for (let index = 0; index < amount; index += 1) {
        const number = start + index + 1
        await window.agentDesk.createSession({
          cwd: projectPath,
          engine: 'openai',
          providerId: 'office-perf-provider',
          model: 'office-perf-model',
          isolated: false,
          title: `Performance Agent ${number}`
        })
      }
    },
    { count, offset, cwd }
  )
}

async function collectFrameMetrics(page, warmupCount, sampleCount) {
  return page.evaluate(
    async ({ warmupCount: warmups, sampleCount: samples }) => {
      const diagnostics = window.__caogenOfficePerformance
      if (!diagnostics) throw new Error('Office performance diagnostics unavailable')

      const nextFrame = () => new Promise((resolve) => window.requestAnimationFrame(resolve))
      for (let index = 0; index < warmups; index += 1) await nextFrame()

      const heapStart = performance.memory?.usedJSHeapSize ?? null
      const deltas = []
      const renderFrames = []
      let previous = performance.now()
      for (let index = 0; index < samples; index += 1) {
        await nextFrame()
        const now = performance.now()
        deltas.push(now - previous)
        previous = now
        renderFrames.push(diagnostics.readFrame())
      }
      const heapEnd = performance.memory?.usedJSHeapSize ?? null
      const snapshot = diagnostics.snapshot()

      const summarize = (values) => {
        const sorted = [...values].sort((a, b) => a - b)
        const percentile = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0
        const mean = sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length)
        return {
          minimum: sorted[0] ?? 0,
          median: percentile(0.5),
          p95: percentile(0.95),
          maximum: sorted.at(-1) ?? 0,
          mean
        }
      }
      const frameDurationMs = summarize(deltas)
      const calls = summarize(renderFrames.map((frame) => frame.calls))
      const triangles = summarize(renderFrames.map((frame) => frame.triangles))
      return {
        samples: deltas.length,
        frameDurationMs,
        medianFps: frameDurationMs.median > 0 ? 1000 / frameDurationMs.median : 0,
        render: { calls, triangles },
        renderer: snapshot,
        heap: {
          startBytes: heapStart,
          endBytes: heapEnd,
          deltaBytes: heapStart === null || heapEnd === null ? null : heapEnd - heapStart
        }
      }
    },
    { warmupCount, sampleCount }
  )
}

async function waitForNonblankCanvas(page, timeout) {
  const startedAt = Date.now()
  let last = null
  while (Date.now() - startedAt < timeout) {
    const rect = await page.evaluate(() => {
      const canvas = document.querySelector('.office canvas')
      if (!canvas) return null
      const box = canvas.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height }
    })
    if (rect && rect.width >= 300 && rect.height >= 200) {
      const image = await page.screenshot({
        clip: {
          x: Math.max(0, rect.x),
          y: Math.max(0, rect.y),
          width: Math.floor(rect.width),
          height: Math.floor(rect.height)
        }
      })
      const renderer = await page.evaluate(() => window.__caogenOfficePerformance?.readFrame() ?? null)
      last = { ...inspectCanvasImage(image), renderer }
      if (
        last.uniqueColorBuckets >= 12 &&
        last.nonTransparentRatio >= 0.99 &&
        (renderer?.calls ?? 0) > 0 &&
        (renderer?.triangles ?? 0) > 0
      ) {
        return last
      }
    }
    await sleep(200)
  }
  throw new Error(`3D Office canvas did not become visibly nonblank: ${JSON.stringify(last)}`)
}

function inspectCanvasImage(buffer) {
  const image = PNG.sync.read(buffer)
  const buckets = new Set()
  let transparent = 0
  let luminance = 0
  let samples = 0
  const stepX = Math.max(1, Math.floor(image.width / 24))
  const stepY = Math.max(1, Math.floor(image.height / 16))
  for (let y = 0; y < image.height; y += stepY) {
    for (let x = 0; x < image.width; x += stepX) {
      const offset = (y * image.width + x) * 4
      const red = image.data[offset]
      const green = image.data[offset + 1]
      const blue = image.data[offset + 2]
      const alpha = image.data[offset + 3]
      if (alpha < 250) transparent += 1
      luminance += red * 0.2126 + green * 0.7152 + blue * 0.0722
      buckets.add(`${red >> 4}:${green >> 4}:${blue >> 4}`)
      samples += 1
    }
  }
  return {
    width: image.width,
    height: image.height,
    samples,
    uniqueColorBuckets: buckets.size,
    meanLuminance: luminance / Math.max(1, samples),
    nonTransparentRatio: 1 - transparent / Math.max(1, samples)
  }
}

function evaluateScenario(scenario, budget, label) {
  const violations = []
  if (!budget) {
    violations.push(`missing ${label} for ${scenario.agents} agents`)
    return violations
  }
  if (scenario.samples < sampleFrames) {
    violations.push(`captured ${scenario.samples}/${sampleFrames} requested frames`)
  }
  if (scenario.firstNonblankMs > budget.firstNonblankMsMaximum) {
    violations.push(
      `first nonblank ${scenario.firstNonblankMs}ms exceeds ${budget.firstNonblankMsMaximum}ms`
    )
  }
  if (scenario.frameDurationMs.median > budget.medianFrameMsMaximum) {
    violations.push(
      `median frame ${scenario.frameDurationMs.median.toFixed(2)}ms exceeds ${budget.medianFrameMsMaximum}ms`
    )
  }
  if (scenario.frameDurationMs.p95 > budget.p95FrameMsMaximum) {
    violations.push(
      `p95 frame ${scenario.frameDurationMs.p95.toFixed(2)}ms exceeds ${budget.p95FrameMsMaximum}ms`
    )
  }
  if (scenario.renderer.render.calls <= 0 || scenario.renderer.render.triangles <= 0) {
    violations.push('renderer reported no draw calls or triangles')
  }
  if (scenario.renderer.scene.meshes <= 0 || scenario.renderer.memory.geometries <= 0) {
    violations.push('renderer reported no scene meshes or geometries')
  }
  return violations
}

function writeReports(value) {
  const json = `${JSON.stringify(value, null, 2)}\n`
  const markdown = renderMarkdown(value)
  writeFileSync(path.join(runDir, 'report.json'), json)
  writeFileSync(path.join(runDir, 'report.md'), markdown)
  writeFileSync(path.join(reportRoot, 'latest.json'), json)
  writeFileSync(path.join(reportRoot, 'latest.md'), markdown)
}

function renderMarkdown(value) {
  const rows = value.scenarios.map((scenario) => {
    const regression = scenario.regressionViolations.length > 0 ? scenario.regressionViolations.join('; ') : 'none'
    const target = scenario.targetViolations.length > 0 ? scenario.targetViolations.join('; ') : 'met'
    return `| ${scenario.agents} | ${scenario.loadKind} | ${scenario.firstNonblankMs} | ${scenario.frameDurationMs.median.toFixed(2)} | ${scenario.frameDurationMs.p95.toFixed(2)} | ${scenario.medianFps.toFixed(1)} | ${scenario.render.calls.median.toFixed(0)} | ${scenario.render.triangles.median.toFixed(0)} | ${scenario.renderer.scene.objects} | ${regression} | ${target} |`
  })
  return `# 3D Office Performance\n\n- Run: ${value.runId}\n- Status: ${value.status}\n- Required: ${value.required}\n- Platform: ${value.environment.platform} ${value.environment.arch}\n- CPU: ${value.environment.cpu}\n- Office chunk: ${value.artifacts.officeChunkBytes} bytes\n- Robot GLB: ${value.artifacts.robotGlbBytes} bytes\n\n| Agents | Load | First nonblank ms | Median frame ms | P95 frame ms | Median FPS | Draw calls | Triangles | Scene objects | Regression violations | Target status |\n|---:|---|---:|---:|---:|---:|---:|---:|---:|---|---|\n${rows.join('\n')}\n`
}

function artifactMetrics() {
  const rendererAssets = path.join(repoRoot, 'out', 'renderer', 'assets')
  const officeChunk = readdirSync(rendererAssets).find(
    (name) => name.startsWith('OfficeView-') && name.endsWith('.js')
  )
  if (!officeChunk) fail('Built OfficeView chunk not found')
  const officeChunkPath = path.join(rendererAssets, officeChunk)
  const robotGlbPath = path.join(
    repoRoot,
    'src',
    'renderer',
    'src',
    'assets',
    'robots',
    'reference-office-robot.glb'
  )
  const artifacts = {
    officeChunk,
    officeChunkBytes: statSync(officeChunkPath).size,
    robotGlbPath: path.relative(repoRoot, robotGlbPath),
    robotGlbBytes: statSync(robotGlbPath).size
  }
  const regressionViolations = []
  const targetViolations = []
  for (const [field, maximum] of [
    ['officeChunkBytes', artifactRegressionBudgets.officeChunkBytesMaximum],
    ['robotGlbBytes', artifactRegressionBudgets.robotGlbBytesMaximum]
  ]) {
    if (artifacts[field] > maximum) {
      regressionViolations.push(`${field} ${artifacts[field]} exceeds ${maximum}`)
    }
  }
  for (const [field, maximum] of [
    ['officeChunkBytes', artifactTargets.officeChunkBytesMaximum],
    ['robotGlbBytes', artifactTargets.robotGlbBytesMaximum]
  ]) {
    if (artifacts[field] > maximum) {
      targetViolations.push(`${field} ${artifacts[field]} exceeds ${maximum}`)
    }
  }
  return { ...artifacts, regressionViolations, targetViolations }
}

function writeFixtureUserData() {
  writeFileSync(
    path.join(userDataDir, 'providers.json'),
    JSON.stringify(
      [
        {
          id: 'office-perf-provider',
          name: 'Office Performance Provider',
          baseUrl: 'http://127.0.0.1:9',
          encryptedToken: `b64:${Buffer.from('performance-fixture').toString('base64')}`,
          models: ['office-perf-model'],
          openaiProtocol: 'responses',
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
        defaultModel: 'office-perf-model',
        defaultProviderId: 'office-perf-provider',
        defaultPermissionMode: 'default',
        language: 'zh',
        theme: 'dark',
        office: { showBadges: true, liveliness: 0.6, catEars: false }
      },
      null,
      2
    )
  )
}

function hostEnvironment() {
  return {
    platform: platform(),
    release: release(),
    arch: process.arch,
    node: process.version,
    cpu: cpus()[0]?.model ?? 'unknown',
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtStart: freemem()
  }
}

async function waitForApp(page) {
  await page.waitForSelector('.app', { timeout: 20_000 })
  await page.waitForFunction(() => typeof window.agentDesk?.createSession === 'function', {
    timeout: 15_000
  })
}

async function waitForDebugPort(port, timeout) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1')
        socket.once('connect', () => {
          socket.destroy()
          resolve()
        })
        socket.once('error', reject)
      })
      return
    } catch {
      await sleep(100)
    }
  }
  throw new Error(`Electron debug port ${port} did not open`)
}

async function findFreePort(start) {
  for (let port = start; port < start + 100; port += 1) {
    const available = await new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
    })
    if (available) return port
  }
  throw new Error(`No free port found from ${start}`)
}

async function terminate(processHandle) {
  if (processHandle.exitCode !== null) return processHandle.exitCode
  processHandle.kill('SIGTERM')
  const exitCode = await Promise.race([
    new Promise((resolve) => processHandle.once('exit', (code) => resolve(code))),
    sleep(3_000).then(() => null)
  ])
  if (processHandle.exitCode === null) processHandle.kill('SIGKILL')
  return exitCode
}

function summarizeProcessOutput(stdoutText, stderrText, exitCode) {
  const warnings = []
  if (exitCode !== 0 && exitCode !== null) warnings.push(`Electron exited with code ${exitCode}`)
  const stderrTail = stderrText.trim().split('\n').slice(-8).join('\n')
  const stdoutTail = stdoutText.trim().split('\n').slice(-8).join('\n')
  if (stderrTail) warnings.push(`[stderr tail]\n${stderrTail}`)
  if (stdoutTail) warnings.push(`[stdout tail]\n${stdoutTail}`)
  return warnings
}

function readArg(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  const prefix = `${name}=`
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length)
}

function readPositiveInteger(name, fallback) {
  const raw = readArg(name)
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) fail(`${name} must be a positive integer`)
  return value
}

function parseScenarioCounts(raw) {
  const values = [...new Set(raw.split(',').map((item) => Number(item.trim())))]
  if (values.length === 0 || values.some((value) => !Number.isInteger(value) || value <= 0)) {
    fail('--scenarios must be a comma-separated list of positive integers')
  }
  return values.sort((left, right) => left - right)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
