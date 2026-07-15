#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
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
const qualityModes = parseQualityModes(readArg('--qualities') ?? 'auto,high,balanced,low')
const fixedQualityAgentCount = Math.max(...scenarioCounts)
const sampleFrames = readPositiveInteger('--sample-frames', 180)
const warmupFrames = readPositiveInteger('--warmup-frames', 60)
if (
  required &&
  (scenarioCounts.length !== 3 ||
    ![1, 6, 12].every((count) => scenarioCounts.includes(count)) ||
    qualityModes.length !== 4 ||
    !['auto', 'high', 'balanced', 'low'].every((mode) => qualityModes.includes(mode)) ||
    sampleFrames < 180 ||
    warmupFrames < 60)
) {
  fail('required mode mandates --scenarios 1,6,12, all four quality modes, at least 180 samples, and 60 warmups')
}
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
const fixedQualityTargets = {
  high: { firstNonblankMsMaximum: 7_000, medianFrameMsMaximum: 34, p95FrameMsMaximum: 50 },
  balanced: { firstNonblankMsMaximum: 7_000, medianFrameMsMaximum: 40, p95FrameMsMaximum: 60 },
  low: { firstNonblankMsMaximum: 7_000, medianFrameMsMaximum: 45, p95FrameMsMaximum: 70 }
}
const fixedQualityRegressionBudgets = {
  high: { firstNonblankMsMaximum: 12_000, medianFrameMsMaximum: 125, p95FrameMsMaximum: 150 },
  balanced: { firstNonblankMsMaximum: 12_000, medianFrameMsMaximum: 110, p95FrameMsMaximum: 135 },
  low: { firstNonblankMsMaximum: 12_000, medianFrameMsMaximum: 95, p95FrameMsMaximum: 120 }
}
const artifactTargets = {
  officeChunkBytesMaximum: 1_800_000,
  robotGlbBytesMaximum: 8_000_000
}
const artifactRegressionBudgets = {
  officeChunkBytesMaximum: 2_200_000,
  robotGlbBytesMaximum: 12_700_000
}
const cardCTargets = {
  officeChunkBytesMaximum: 1_800_000,
  robotGlbBytesMaximum: 8_000_000,
  twelveAgentMedianDrawCallsMaximum: 3_269,
  twelveAgentBaselineMedianDrawCalls: 4_671,
  twelveAgentDrawCallReductionMinimumPercent: 30
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
  source: sourceState(),
  environment: hostEnvironment(),
  config: { scenarioCounts, qualityModes, fixedQualityAgentCount, sampleFrames, warmupFrames },
  targets,
  regressionBudgets,
  fixedQualityTargets,
  fixedQualityRegressionBudgets,
  artifactTargets,
  artifactRegressionBudgets,
  cardCTargets,
  artifacts: artifactMetrics(),
  scenarios: [],
  settingsUi: null,
  autoAdaptation: null,
  renderPause: null,
  unmount: null,
  lodUpgrade: null,
  cardCContract: null,
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
        ? required
          ? 'fail'
          : 'warn'
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
let focusSession
try {
  await waitForDebugPort(remotePort, 20_000)
  browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${remotePort}`,
    defaultViewport: null
  })
  const pages = await browser.pages()
  const page = pages.find((item) => !item.url().startsWith('devtools://')) || pages[0]
  if (!page) throw new Error('Electron page target not found')
  focusSession = await page.target().createCDPSession()
  await focusSession.send('Emulation.setFocusEmulationEnabled', { enabled: true })

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
  report.settingsUi = await verifyQualitySettingsUi(page)
  report.checks.push({ name: '3D Office quality settings UI and persistence', status: 'pass', ...report.settingsUi })

  let createdSessions = 0
  let scenarioIndex = 0
  for (const count of scenarioCounts) {
    const addCount = count - createdSessions
    if (addCount > 0) {
      await createIdleSessions(page, addCount, createdSessions, projectDir)
      createdSessions = count
    }

    const scenarioQualities = qualityModes.filter((mode) => mode === 'auto' || count === fixedQualityAgentCount)
    for (const qualityMode of scenarioQualities) {
      await page.bringToFront()
      const persistedQuality = await page.evaluate(async (mode) => {
        const settings = await window.agentDesk.updateSettings({ office: { qualityMode: mode } })
        return settings.office.qualityMode
      }, qualityMode)
      if (persistedQuality !== qualityMode) {
        throw new Error(`quality setting did not persist: requested=${qualityMode}, persisted=${persistedQuality}`)
      }

      await page.reload({ waitUntil: 'domcontentloaded' })
      await waitForApp(page)
      await page.bringToFront()

      const openedAt = Date.now()
      await page.click('.sidebar-office')
      await page.waitForSelector('.office canvas', { timeout: 20_000 })
      await page.waitForFunction(
        ({ expectedAgents, expectedQuality }) => {
          const office = document.querySelector('.office-canvas-wrap')
          return (
            Number(office?.getAttribute('data-office-sessions') ?? 0) === expectedAgents &&
            office?.getAttribute('data-office-quality-requested') === expectedQuality
          )
        },
        { timeout: 20_000 },
        { expectedAgents: count, expectedQuality: qualityMode }
      )
      await page.waitForFunction(
        () => typeof window.__caogenOfficePerformance?.snapshot === 'function',
        { timeout: 20_000 }
      )

      const canvas = await waitForNonblankCanvas(page, 15_000)
      const firstNonblankMs = Date.now() - openedAt
      const measurement = await collectFrameMetrics(page, warmupFrames, sampleFrames)
      const controls = await verifyOfficeControls(page)
      const semantics = await readOfficeSemantics(page)
      if (report.renderPause === null) {
        report.renderPause = await verifyRenderPause(page)
        report.checks.push({ name: '3D Office hidden and unfocused render pause', status: 'pass', ...report.renderPause })
      }
      const screenshot = path.join(runDir, `office-${count}-agents-${qualityMode}.png`)
      await page.screenshot({ path: screenshot, fullPage: false })

      const scenario = {
        agents: count,
        qualityMode,
        effectiveQuality: measurement.renderer.quality.effective,
        loadKind: scenarioIndex === 0 ? 'cold' : 'warm-remount',
        firstNonblankMs,
        canvas,
        controls,
        semantics,
        ...measurement,
        screenshot,
        target: qualityMode === 'auto' ? (targets[count] ?? null) : fixedQualityTargets[qualityMode],
        regressionBudget:
          qualityMode === 'auto' ? (regressionBudgets[count] ?? null) : fixedQualityRegressionBudgets[qualityMode],
        lodViolations: [],
        targetViolations: [],
        regressionViolations: []
      }
      scenario.lodViolations = evaluateLodScenario(scenario)
      scenario.targetViolations = evaluateScenario(scenario, scenario.target, 'target')
      scenario.regressionViolations = evaluateScenario(
        scenario,
        scenario.regressionBudget,
        'regression budget'
      )
      report.scenarios.push(scenario)
      report.checks.push({
        name: `${count}-agent ${qualityMode} office performance`,
        status:
          scenario.lodViolations.length > 0 || scenario.regressionViolations.length > 0
            ? required
              ? 'fail'
              : 'warn'
            : scenario.targetViolations.length > 0
              ? 'warn'
              : 'pass',
        targetViolations: scenario.targetViolations,
        regressionViolations: scenario.regressionViolations,
        violations: scenario.lodViolations
      })
      if (
        report.lodUpgrade === null &&
        fixedQualityAgentCount > 1 &&
        count === fixedQualityAgentCount &&
        qualityMode === 'auto'
      ) {
        report.lodUpgrade = await verifyLowLodUpgrade(page)
        report.checks.push({ name: '3D Office low LOD selection upgrade', status: 'pass', ...report.lodUpgrade })
      }
      if (report.autoAdaptation === null && qualityMode === 'auto') {
        report.autoAdaptation = await verifyAutoPressureDowngrade(page)
        report.checks.push({ name: '3D Office Auto pressure downgrade', status: 'pass', ...report.autoAdaptation })
      }
      scenarioIndex += 1

      await page.click('.office-actions .btn-primary')
      await page.waitForFunction(() => !document.querySelector('.office-canvas-wrap'), { timeout: 10_000 })
      if (report.unmount === null) {
        report.unmount = await verifyOfficeUnmount(page)
        report.checks.push({ name: '3D Office unmount cleanup', status: 'pass', ...report.unmount })
      }
    }
  }
  report.checks.push(evaluateQualityMatrix(report.scenarios, fixedQualityAgentCount))
} catch (error) {
  report.error = error instanceof Error ? error.stack || error.message : String(error)
  report.checks.push({
    name: 'office performance runtime',
    status: 'fail',
    violations: [error instanceof Error ? error.message : String(error)]
  })
} finally {
  if (focusSession) await focusSession.detach().catch(() => undefined)
  if (browser) await browser.disconnect().catch(() => undefined)
  const exited = await terminate(app)
  report.warnings.push(...summarizeProcessOutput(stdout, stderr, exited))
  if (process.env.CAOGEN_KEEP_TEST_TMP !== '1') rmSync(tempRoot, { recursive: true, force: true })
}

report.cardCContract = evaluateCardCContract(report)
report.checks.push(report.cardCContract)

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

async function verifyQualitySettingsUi(page) {
  const originalViewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    deviceScaleFactor: window.devicePixelRatio
  }))
  await page.click('.sidebar-footer button')
  await page.waitForSelector('.settings-page', { timeout: 10_000 })
  await page.click('[data-settings-tab="office"]')
  await page.waitForFunction(
    () => document.querySelectorAll('[data-office-quality-option]').length === 4,
    { timeout: 5_000 }
  )
  const layout = await page.evaluate(() =>
    [...document.querySelectorAll('[data-office-quality-option]')].map((button) => {
      const rect = button.getBoundingClientRect()
      return {
        mode: button.getAttribute('data-office-quality-option'),
        pressed: button.getAttribute('aria-pressed'),
        width: rect.width,
        height: rect.height,
        scrollWidth: button.scrollWidth,
        clientWidth: button.clientWidth
      }
    })
  )
  if (layout.find((item) => item.mode === 'auto')?.pressed !== 'true') {
    throw new Error(`legacy settings did not normalize to auto in the UI: ${JSON.stringify(layout)}`)
  }
  if (layout.some((item) => item.width < 44 || item.height < 28 || item.scrollWidth > item.clientWidth)) {
    throw new Error(`quality settings controls overflow or collapse: ${JSON.stringify(layout)}`)
  }
  const settingsPath = path.join(userDataDir, 'settings.json')
  const settingsBackupPath = path.join(userDataDir, 'settings.performance-backup.json')
  renameSync(settingsPath, settingsBackupPath)
  mkdirSync(settingsPath)
  let cachedAfterFailedWrite = ''
  try {
    await page.click('[data-office-quality-option="low"]')
    await page.click('.settings-page-actions .btn-primary')
    await page.waitForSelector('[data-settings-save-error]', { timeout: 5_000 })
    cachedAfterFailedWrite = await page.evaluate(async () => (await window.agentDesk.getSettings()).office.qualityMode)
  } finally {
    rmSync(settingsPath, { recursive: true, force: true })
    renameSync(settingsBackupPath, settingsPath)
  }
  if (cachedAfterFailedWrite !== 'auto') {
    throw new Error(`failed settings write changed the cache to ${cachedAfterFailedWrite}`)
  }
  const screenshot = path.join(runDir, 'office-quality-settings.png')
  await page.screenshot({ path: screenshot, fullPage: false })
  await page.click('.settings-page-actions .btn-primary')
  await page.waitForFunction(() => !document.querySelector('.settings-page'), { timeout: 10_000 })
  const cached = await page.evaluate(async () => (await window.agentDesk.getSettings()).office.qualityMode)
  const persisted = JSON.parse(readFileSync(path.join(userDataDir, 'settings.json'), 'utf8')).office?.qualityMode
  if (cached !== 'low' || persisted !== 'low') {
    throw new Error(`settings UI did not persist low quality: cache=${cached}, disk=${persisted}`)
  }
  await page.evaluate(async () => {
    await window.agentDesk.updateSettings({ language: 'en', office: { qualityMode: 'auto' } })
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForApp(page)
  await page.setViewport({ width: 360, height: 520, deviceScaleFactor: 1 })
  await page.evaluate(() => document.querySelector('.sidebar-footer button')?.click())
  await page.waitForSelector('.settings-page', { timeout: 10_000 })
  await page.click('[data-settings-tab="office"]')
  const compactLayout = await page.evaluate(() =>
    [...document.querySelectorAll('[data-office-quality-option]')].map((button) => ({
      mode: button.getAttribute('data-office-quality-option'),
      label: (button.textContent ?? '').trim(),
      scrollWidth: button.scrollWidth,
      clientWidth: button.clientWidth,
      width: button.getBoundingClientRect().width
    }))
  )
  if (
    compactLayout.map((item) => item.label).join(',') !== 'Auto,High,Balanced,Low' ||
    compactLayout.some((item) => item.width < 44 || item.scrollWidth > item.clientWidth)
  ) {
    throw new Error(`compact English quality controls overflow: ${JSON.stringify(compactLayout)}`)
  }
  await page.focus('[data-office-quality-option="high"]')
  await page.keyboard.press('Space')
  await page.waitForFunction(
    () => document.querySelector('[data-office-quality-option="high"]')?.getAttribute('aria-pressed') === 'true',
    { timeout: 5_000 }
  )
  const compactScreenshot = path.join(runDir, 'office-quality-settings-compact-en.png')
  await page.screenshot({ path: compactScreenshot, fullPage: false })
  await page.evaluate(async () => {
    await window.agentDesk.updateSettings({ language: 'zh', office: { qualityMode: 'auto' } })
  })
  await page.click('.settings-page-back')
  await page.setViewport(originalViewport)
  return {
    options: layout.map((item) => item.mode),
    cached,
    persisted,
    cachedAfterFailedWrite,
    screenshot,
    compactLayout,
    compactScreenshot,
    keyboardSelection: 'high'
  }
}

async function collectFrameMetrics(page, warmupCount, sampleCount) {
  return page.evaluate(
    async ({ warmupCount: warmups, sampleCount: samples }) => {
      const diagnostics = window.__caogenOfficePerformance
      if (!diagnostics) throw new Error('Office performance diagnostics unavailable')

      const nextFrame = () => new Promise((resolve) => window.requestAnimationFrame(resolve))
      const nextRenderedFrame = async (previousFrame, deadline) => {
        while (performance.now() < deadline) {
          await nextFrame()
          const render = diagnostics.readFrame()
          if (render.frame !== previousFrame) return { at: performance.now(), render }
        }
        throw new Error(`timed out waiting for WebGL frame after ${previousFrame}`)
      }
      let previousRenderFrame = diagnostics.readFrame().frame
      const deadline = performance.now() + 120_000
      for (let index = 0; index < warmups; index += 1) {
        const rendered = await nextRenderedFrame(previousRenderFrame, deadline)
        previousRenderFrame = rendered.render.frame
      }

      const heapStart = performance.memory?.usedJSHeapSize ?? null
      const deltas = []
      const renderFrames = []
      let previous = performance.now()
      for (let index = 0; index < samples; index += 1) {
        const rendered = await nextRenderedFrame(previousRenderFrame, deadline)
        deltas.push(rendered.at - previous)
        previous = rendered.at
        previousRenderFrame = rendered.render.frame
        renderFrames.push(rendered.render)
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
      const renderFrameSpan =
        renderFrames.length > 1 ? renderFrames.at(-1).frame - renderFrames[0].frame : 0
      return {
        samples: deltas.length,
        renderFrameSpan,
        rendererRendersPerSample: renderFrameSpan / Math.max(1, deltas.length - 1),
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

async function readOfficeSemantics(page) {
  return page.evaluate(() => {
    const office = document.querySelector('.office-canvas-wrap')
    if (!office) throw new Error('Office semantic surface unavailable')
    const number = (name) => Number(office.getAttribute(name) ?? 0)
    return {
      sessions: number('data-office-sessions'),
      walkers: number('data-office-walkers'),
      clickableWorkstations: number('data-office-clickable-workstations'),
      clickableWalkers: number('data-office-clickable-walkers'),
      clickableFacilities: number('data-office-clickable-facilities'),
      cameraPresets: number('data-office-camera-presets'),
      activeCameraPreset: office.getAttribute('data-office-active-camera-preset') ?? '',
      oneRobotPerAgent: number('data-office-one-robot-per-agent'),
      visibleRobots: number('data-office-visible-robots'),
      workstationHitTargets: office.getAttribute('data-office-workstation-hit-targets') ?? '',
      walkerHitTargets: office.getAttribute('data-office-walker-hit-targets') ?? '',
      facilityHitTargets: office.getAttribute('data-office-facility-hit-targets') ?? ''
    }
  })
}

async function verifyLowLodUpgrade(page) {
  const readState = () =>
    page.evaluate(() => {
      const office = document.querySelector('.office-canvas-wrap')
      const diagnostics = window.__caogenOfficePerformance
      if (!office || !diagnostics) throw new Error('Office LOD diagnostics unavailable')
      const parseTargets = (name) => {
        try {
          return JSON.parse(office.getAttribute(name) || '[]')
        } catch {
          return []
        }
      }
      const selected = office.getAttribute('data-office-selected-session') ?? ''
      const walkers = parseTargets('data-office-walker-hit-targets')
      const walkerIds = new Set(walkers.map((target) => target.id))
      const targets = parseTargets('data-office-workstation-hit-targets')
      const candidates = targets
        .filter((candidate) => candidate.id !== selected && !walkerIds.has(candidate.id))
        .sort((left, right) => right.z - left.z || Math.abs(left.x) - Math.abs(right.x))
      const target =
        candidates[0] ??
        targets.find((candidate) => candidate.id !== selected) ??
        null
      return {
        selected,
        visibleRobots: Number(office.getAttribute('data-office-visible-robots') ?? 0),
        target,
        lod: diagnostics.snapshot().lod
      }
    })

  const validateState = (state, label) => {
    if (!state?.lod) throw new Error(`${label} LOD snapshot missing`)
    const { fullRobots, lowRobots } = state.lod
    if (!Number.isInteger(fullRobots) || !Number.isInteger(lowRobots) || fullRobots < 0 || lowRobots < 0) {
      throw new Error(`${label} LOD counts are invalid: ${JSON.stringify(state.lod)}`)
    }
    if (fullRobots + lowRobots !== state.visibleRobots) {
      throw new Error(
        `${label} full + low LOD ${fullRobots + lowRobots} does not match ${state.visibleRobots} visible robots`
      )
    }
    if (!Array.isArray(state.lod.robots) || state.lod.robots.length !== state.visibleRobots) {
      throw new Error(
        `${label} robot evidence ${state.lod.robots?.length ?? 'missing'} does not match ${state.visibleRobots} visible robots`
      )
    }
    const sessionIds = new Set()
    for (const robot of state.lod.robots) {
      if (!robot.sessionId || !robot.modelUrl || robot.assetLod !== robot.lod) {
        throw new Error(`${label} robot asset evidence is invalid: ${JSON.stringify(robot)}`)
      }
      sessionIds.add(robot.sessionId)
    }
    if (sessionIds.size !== state.visibleRobots) {
      throw new Error(`${label} robot sessions are not one-to-one: ${JSON.stringify(state.lod.robots)}`)
    }
  }

  await page.waitForFunction(
    () => document.querySelector('.office-canvas-wrap')?.getAttribute('data-office-active-camera-preset') === 'overview',
    { timeout: 5_000 }
  )
  const before = await readState()
  validateState(before, 'before selection')
  if (before.lod.lowRobots < 1) {
    throw new Error(`selection upgrade requires a low LOD robot: ${JSON.stringify(before.lod)}`)
  }
  if (!before.target?.id || before.target.id === before.selected) {
    throw new Error(`selection upgrade target unavailable: ${JSON.stringify(before)}`)
  }

  const projected = await page.evaluate(({ x, y, z }) => {
    const diagnostics = window.__caogenOfficePerformance
    if (!diagnostics) throw new Error('Office projection diagnostics unavailable')
    return diagnostics.projectWorldPoint([x, y, z])
  }, before.target)
  if (!projected.visible || !Number.isFinite(projected.x) || !Number.isFinite(projected.y)) {
    throw new Error(`low LOD workstation target is outside the live camera: ${JSON.stringify({ target: before.target, projected })}`)
  }
  const hit = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y)
    return { tag: element?.tagName ?? '', isCanvas: element?.tagName === 'CANVAS' }
  }, projected)
  if (!hit.isCanvas) {
    throw new Error(`low LOD workstation click is covered: ${JSON.stringify({ target: before.target, projected, hit })}`)
  }

  await page.mouse.click(Math.round(projected.x), Math.round(projected.y))
  await page.waitForFunction(
    (expected) => {
      const office = document.querySelector('.office-canvas-wrap')
      const diagnostics = window.__caogenOfficePerformance
      if (!office || !diagnostics) return false
      const lod = diagnostics.snapshot().lod
      const visibleRobots = Number(office.getAttribute('data-office-visible-robots') ?? 0)
      return (
        office.getAttribute('data-office-selected-session') === expected &&
        office.getAttribute('data-office-active-camera-preset') === 'agent' &&
        lod.fullRobots + lod.lowRobots === visibleRobots &&
        lod.robots.some(
          (robot) => robot.sessionId === expected && robot.lod === 'full' && robot.assetLod === 'full'
        )
      )
    },
    { timeout: 8_000 },
    before.target.id
  )
  const after = await readState()
  validateState(after, 'after selection')
  const targetBefore = before.lod.robots.find((robot) => robot.sessionId === before.target.id)
  const targetAfter = after.lod.robots.find((robot) => robot.sessionId === before.target.id)
  const previousSelectionBefore = before.lod.robots.find((robot) => robot.sessionId === before.selected)
  const previousSelectionAfter = after.lod.robots.find((robot) => robot.sessionId === before.selected)
  const robotRootsChanged =
    JSON.stringify(before.lod.fullRobotRootIds) !== JSON.stringify(after.lod.fullRobotRootIds) &&
    JSON.stringify(before.lod.lowRobotRootIds) !== JSON.stringify(after.lod.lowRobotRootIds)
  const workstationRootsChanged =
    JSON.stringify(before.lod.fullWorkstationRootIds) !== JSON.stringify(after.lod.fullWorkstationRootIds) &&
    JSON.stringify(before.lod.compactWorkstationRootIds) !== JSON.stringify(after.lod.compactWorkstationRootIds)
  const targetSessionUpgraded = targetBefore?.lod === 'low' && targetAfter?.lod === 'full'
  const previousSelectionDowngraded =
    previousSelectionBefore?.lod === 'full' && previousSelectionAfter?.lod === 'low'
  if (
    after.selected !== before.target.id ||
    !targetSessionUpgraded ||
    !previousSelectionDowngraded ||
    !robotRootsChanged ||
    !workstationRootsChanged
  ) {
    throw new Error(
      `low LOD workstation did not upgrade to a full rig: ${JSON.stringify({ before, after, targetSessionUpgraded, previousSelectionDowngraded, robotRootsChanged, workstationRootsChanged })}`
    )
  }
  return {
    targetSession: before.target.id,
    projected: {
      x: Math.round(projected.x),
      y: Math.round(projected.y),
      ndcX: Number(projected.ndcX.toFixed(3)),
      ndcY: Number(projected.ndcY.toFixed(3))
    },
    before: { selected: before.selected, visibleRobots: before.visibleRobots, lod: before.lod },
    after: { selected: after.selected, visibleRobots: after.visibleRobots, lod: after.lod },
    targetSessionUpgraded,
    previousSelectionDowngraded,
    robotRootsChanged,
    workstationRootsChanged
  }
}

async function verifyOfficeControls(page) {
  const exercisePreset = (selector) =>
    page.evaluate(async (buttonSelector) => {
      const diagnostics = window.__caogenOfficePerformance
      const button = document.querySelector(buttonSelector)
      if (!diagnostics || !(button instanceof HTMLElement)) {
        throw new Error(`Office camera control unavailable: ${buttonSelector}`)
      }
      let previousFrame = diagnostics.readFrame().frame
      const rendererPassDeltas = []
      button.click()
      for (let index = 0; index < 6; index += 1) {
        await new Promise((resolve) => window.requestAnimationFrame(resolve))
        const currentFrame = diagnostics.readFrame().frame
        rendererPassDeltas.push(currentFrame - previousFrame)
        previousFrame = currentFrame
      }
      return rendererPassDeltas
    }, selector)

  const facilitiesPasses = await exercisePreset('.office-camera-button:nth-child(3)')
  await page.waitForFunction(
    () => document.querySelector('.office-canvas-wrap')?.getAttribute('data-office-active-camera-preset') === 'facilities',
    { timeout: 5_000 }
  )
  const overviewPasses = await exercisePreset('.office-camera-button:nth-child(1)')
  await page.waitForFunction(
    () => document.querySelector('.office-canvas-wrap')?.getAttribute('data-office-active-camera-preset') === 'overview',
    { timeout: 5_000 }
  )
  const effectiveQuality = await page.$eval(
    '.office-canvas-wrap',
    (office) => office.getAttribute('data-office-quality-effective') ?? ''
  )
  const observedMaximum = Math.max(0, ...facilitiesPasses, ...overviewPasses)
  const expectedMaximum = effectiveQuality === 'high' ? 6 : 1
  if (observedMaximum > expectedMaximum) {
    throw new Error(
      `quality ${effectiveQuality} rerendered ${observedMaximum} renderer passes after camera controls; expected <= ${expectedMaximum}`
    )
  }
  return {
    exercised: ['facilities', 'overview'],
    finalPreset: 'overview',
    effectiveQuality,
    rendererPassDeltas: { facilities: facilitiesPasses, overview: overviewPasses },
    observedMaximum,
    expectedMaximum
  }
}

async function verifyRenderPause(page) {
  const readSemantics = () =>
    page.evaluate(() => {
      const office = document.querySelector('.office-canvas-wrap')
      return {
        awaySessions: office?.getAttribute('data-office-away-sessions') ?? '',
        cameraPreset: office?.getAttribute('data-office-active-camera-preset') ?? '',
        selectedSession: office?.getAttribute('data-office-selected-session') ?? '',
        oneRobotPerAgent: office?.getAttribute('data-office-one-robot-per-agent') ?? ''
      }
    })
  const semanticsBefore = await readSemantics()
  const assertPaused = async (label) => {
    await page.waitForFunction(
      () => document.querySelector('.office-canvas-wrap')?.getAttribute('data-office-render-paused') === '1',
      { timeout: 5_000 }
    )
    await sleep(250)
    const atFrame = await page.evaluate(() => window.__caogenOfficePerformance?.readFrame().frame ?? -1)
    await sleep(600)
    const afterFrame = await page.evaluate(() => window.__caogenOfficePerformance?.readFrame().frame ?? -1)
    if (afterFrame !== atFrame) {
      throw new Error(`WebGL advanced while Office was ${label}: ${atFrame} -> ${afterFrame}`)
    }
    return { atFrame, afterFrame }
  }

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  const hidden = await assertPaused('hidden')
  await page.evaluate(() => {
    delete document.hidden
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForFunction(
    () => document.querySelector('.office-canvas-wrap')?.getAttribute('data-office-render-active') === '1',
    { timeout: 5_000 }
  )
  await page.waitForFunction(
    (pausedFrame) => (window.__caogenOfficePerformance?.readFrame().frame ?? -1) > pausedFrame,
    { timeout: 5_000 },
    hidden.afterFrame
  )
  const semanticsAfterHidden = await readSemantics()

  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  const unfocused = await assertPaused('unfocused')

  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForFunction(
    () => document.querySelector('.office-canvas-wrap')?.getAttribute('data-office-render-active') === '1',
    { timeout: 5_000 }
  )
  await page.waitForFunction(
    (pausedFrame) => (window.__caogenOfficePerformance?.readFrame().frame ?? -1) > pausedFrame,
    { timeout: 5_000 },
    unfocused.afterFrame
  )
  const resumedAtFrame = await page.evaluate(() => window.__caogenOfficePerformance?.readFrame().frame ?? -1)
  const semanticsAfterFocus = await readSemantics()
  if (
    JSON.stringify(semanticsAfterHidden) !== JSON.stringify(semanticsBefore) ||
    JSON.stringify(semanticsAfterFocus) !== JSON.stringify(semanticsBefore)
  ) {
    throw new Error(
      `Office semantics changed across render pause: ${JSON.stringify({ semanticsBefore, semanticsAfterHidden, semanticsAfterFocus })}`
    )
  }
  return { hidden, unfocused, resumedAtFrame, semanticsBefore, semanticsAfterHidden, semanticsAfterFocus }
}

async function verifyAutoPressureDowngrade(page) {
  const before = await page.evaluate(() => {
    const office = document.querySelector('.office-canvas-wrap')
    return {
      effective: office?.getAttribute('data-office-quality-effective') ?? '',
      transitions: Number(office?.getAttribute('data-office-quality-auto-transitions') ?? 0)
    }
  })
  if (before.effective === 'low' && before.transitions > 0) {
    return { before, after: before, pressure: null, trigger: 'measured-runtime-pressure' }
  }
  if (before.effective !== 'balanced' && before.effective !== 'high') {
    throw new Error(`Auto pressure fixture must start High/Balanced or already prove Low, got ${JSON.stringify(before)}`)
  }
  const pressure = await page.evaluate(async () => {
    const startedAt = performance.now()
    const maximumFrames = 240
    let frames = 0
    for (; frames < maximumFrames; frames += 1) {
      await new Promise((resolve) => window.requestAnimationFrame(resolve))
      const until = performance.now() + 55
      while (performance.now() < until) {
        // Deliberate main-thread pressure for the opt-in Auto quality contract.
      }
      if (document.querySelector('.office-canvas-wrap')?.getAttribute('data-office-quality-effective') === 'low') {
        frames += 1
        break
      }
    }
    return { frames, maximumFrames, durationMs: performance.now() - startedAt }
  })
  await page.waitForFunction(
    () => document.querySelector('.office-canvas-wrap')?.getAttribute('data-office-quality-effective') === 'low',
    { timeout: 10_000 }
  )
  const after = await page.evaluate(() => {
    const office = document.querySelector('.office-canvas-wrap')
    return {
      effective: office?.getAttribute('data-office-quality-effective') ?? '',
      transitions: Number(office?.getAttribute('data-office-quality-auto-transitions') ?? 0)
    }
  })
  if (after.transitions <= before.transitions) {
    throw new Error(`Auto tier changed without transition evidence: ${JSON.stringify({ before, after })}`)
  }
  return { before, after, pressure, trigger: 'injected-main-thread-pressure' }
}

async function verifyOfficeUnmount(page) {
  await page.waitForFunction(() => typeof window.__caogenOfficePerformance === 'undefined', { timeout: 5_000 })
  const state = await page.evaluate(() => ({
    canvas: Boolean(document.querySelector('.office canvas')),
    office: Boolean(document.querySelector('.office-canvas-wrap')),
    diagnostics: typeof window.__caogenOfficePerformance
  }))
  if (state.canvas || state.office || state.diagnostics !== 'undefined') {
    throw new Error(`Office resources survived unmount: ${JSON.stringify(state)}`)
  }
  return state
}

function evaluateQualityMatrix(scenarios, agents) {
  const fixed = new Map(
    scenarios
      .filter((scenario) => scenario.agents === agents && scenario.qualityMode !== 'auto')
      .map((scenario) => [scenario.qualityMode, scenario])
  )
  const violations = []
  for (const mode of qualityModes.filter((item) => item !== 'auto')) {
    if (!fixed.has(mode)) violations.push(`missing ${mode} quality scenario at ${agents} agents`)
  }

  const baseline = fixed.get('high') ?? fixed.values().next().value
  if (baseline) {
    for (const scenario of fixed.values()) {
      if (JSON.stringify(scenario.semantics) !== JSON.stringify(baseline.semantics)) {
        violations.push(`${scenario.qualityMode} changed session, click-target, robot, or camera semantics`)
      }
    }
  }

  const high = fixed.get('high')
  const balanced = fixed.get('balanced')
  const low = fixed.get('low')
  if (high && low) {
    const highPixels = high.renderer.canvas.width * high.renderer.canvas.height
    const lowPixels = low.renderer.canvas.width * low.renderer.canvas.height
    if (low.renderer.canvas.pixelRatio > high.renderer.canvas.pixelRatio * 0.8) {
      violations.push(
        `low DPR ${low.renderer.canvas.pixelRatio} is not materially below high ${high.renderer.canvas.pixelRatio}`
      )
    }
    if (lowPixels > highPixels * 0.7) {
      violations.push(`low canvas pixel load ${lowPixels} is not materially below high ${highPixels}`)
    }
    if (low.rendererRendersPerSample > high.rendererRendersPerSample * 0.5) {
      violations.push(
        `low renderer passes/frame ${low.rendererRendersPerSample.toFixed(2)} are not materially below high ${high.rendererRendersPerSample.toFixed(2)}`
      )
    }
    if (low.frameDurationMs.median > high.frameDurationMs.median * 0.9) {
      violations.push(
        `low median frame ${low.frameDurationMs.median.toFixed(2)}ms is not materially below high ${high.frameDurationMs.median.toFixed(2)}ms`
      )
    }
    if (high.renderer.quality.shadows !== true || high.renderer.quality.contactShadows !== 'dynamic') {
      violations.push('high mode must keep realtime shadows and dynamic contact shadows')
    }
    if (low.renderer.quality.shadows !== false || low.renderer.quality.contactShadows !== 'off') {
      violations.push('low mode must disable realtime and contact shadows')
    }
  }
  if (balanced) {
    if (balanced.renderer.quality.shadows !== false || balanced.renderer.quality.contactShadows !== 'static') {
      violations.push('balanced mode must use static contact shadows without realtime shadow maps')
    }
  }

  return {
    name: '3D Office quality matrix load reduction and semantic parity',
    status: violations.length > 0 ? 'fail' : 'pass',
    violations
  }
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
  if (scenario.renderFrameSpan < scenario.samples - 1) {
    violations.push(`WebGL frame span ${scenario.renderFrameSpan} is below ${scenario.samples - 1} sample intervals`)
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
  if (scenario.renderer.quality.requested !== scenario.qualityMode) {
    violations.push(
      `runtime requested quality ${scenario.renderer.quality.requested} does not match ${scenario.qualityMode}`
    )
  }
  if (scenario.qualityMode !== 'auto' && scenario.renderer.quality.effective !== scenario.qualityMode) {
    violations.push(
      `fixed quality ${scenario.qualityMode} resolved to ${scenario.renderer.quality.effective}`
    )
  }
  if (!['high', 'balanced', 'low'].includes(scenario.renderer.quality.effective)) {
    violations.push(`invalid effective quality ${scenario.renderer.quality.effective}`)
  }
  const expectedProfile = {
    high: { dprMaximum: 1.5, shadows: true, contactShadows: 'dynamic' },
    balanced: { dprMaximum: 1, shadows: false, contactShadows: 'static' },
    low: { dprMaximum: 0.8, shadows: false, contactShadows: 'off' }
  }[scenario.renderer.quality.effective]
  if (
    expectedProfile &&
    (scenario.renderer.quality.dprMaximum !== expectedProfile.dprMaximum ||
      scenario.renderer.quality.shadows !== expectedProfile.shadows ||
      scenario.renderer.quality.contactShadows !== expectedProfile.contactShadows)
  ) {
    violations.push(
      `effective quality profile mismatch: ${JSON.stringify({ expectedProfile, actual: scenario.renderer.quality })}`
    )
  }
  if (!scenario.renderer.quality.renderActive || scenario.renderer.quality.frameLoop !== 'manual') {
    violations.push('Office renderer was not active with the manual continuous clock during measurement')
  }
  return violations
}

function evaluateLodScenario(scenario) {
  const violations = []
  const lod = scenario.renderer?.lod
  if (!lod) return ['renderer did not report Office robot LOD counts']
  for (const field of ['fullRobots', 'lowRobots']) {
    if (!Number.isInteger(lod[field]) || lod[field] < 0) {
      violations.push(`renderer reported invalid ${field} count ${lod[field]}`)
    }
  }
  const visibleRobots = scenario.semantics.visibleRobots
  if (lod.fullRobots + lod.lowRobots !== visibleRobots) {
    violations.push(
      `full + low LOD ${lod.fullRobots + lod.lowRobots} does not match ${visibleRobots} visible robots`
    )
  }
  if (visibleRobots > 0 && lod.fullRobots < 1) {
    violations.push('Office has visible robots but no full LOD rig')
  }
  if (visibleRobots > 1 && lod.lowRobots < 1) {
    violations.push('multi-agent Office has no low LOD robot')
  }
  if (!Array.isArray(lod.robots) || lod.robots.length !== visibleRobots) {
    violations.push(`robot asset evidence ${lod.robots?.length ?? 'missing'} does not match ${visibleRobots} visible robots`)
  } else {
    const sessionIds = new Set()
    for (const robot of lod.robots) {
      if (!robot.sessionId) violations.push(`robot ${robot.rootId} is missing its session id`)
      if (!robot.modelUrl) violations.push(`robot ${robot.rootId} is missing its model URL`)
      if (robot.assetLod !== robot.lod) {
        violations.push(
          `robot ${robot.sessionId || robot.rootId} is labeled ${robot.lod} but loaded ${robot.assetLod}`
        )
      }
      sessionIds.add(robot.sessionId)
    }
    if (sessionIds.size !== visibleRobots) {
      violations.push(`robot session evidence covers ${sessionIds.size}/${visibleRobots} visible robots`)
    }
  }
  return violations
}

function evaluateCardCContract(value) {
  const violations = []
  if (value.artifacts.officeChunkBytes > cardCTargets.officeChunkBytesMaximum) {
    violations.push(
      `officeChunkBytes ${value.artifacts.officeChunkBytes} exceeds ${cardCTargets.officeChunkBytesMaximum}`
    )
  }
  if (value.artifacts.robotGlbBytes > cardCTargets.robotGlbBytesMaximum) {
    violations.push(`robotGlbBytes ${value.artifacts.robotGlbBytes} exceeds ${cardCTargets.robotGlbBytesMaximum}`)
  }

  const twelveAgentScenarios = value.scenarios.filter((scenario) => scenario.agents === 12)
  const drawCallsByMode = Object.fromEntries(
    twelveAgentScenarios.map((scenario) => [scenario.qualityMode, scenario.render.calls.median])
  )
  const expectedModes = value.required ? ['auto', 'high', 'balanced', 'low'] : value.config.qualityModes
  if (value.required) {
    for (const mode of expectedModes) {
      if (!Object.hasOwn(drawCallsByMode, mode)) violations.push(`missing 12-agent ${mode} draw-call sample`)
    }
  }
  const medianDrawCalls = Object.values(drawCallsByMode)
  const maximumMedianDrawCalls = medianDrawCalls.length > 0 ? Math.max(...medianDrawCalls) : null
  const drawCallReductionPercent =
    maximumMedianDrawCalls === null
      ? null
      : ((cardCTargets.twelveAgentBaselineMedianDrawCalls - maximumMedianDrawCalls) /
          cardCTargets.twelveAgentBaselineMedianDrawCalls) *
        100
  if (maximumMedianDrawCalls === null) {
    violations.push('missing 12-agent median draw-call measurement')
  } else {
    if (maximumMedianDrawCalls > cardCTargets.twelveAgentMedianDrawCallsMaximum) {
      violations.push(
        `12-agent maximum median draw calls ${maximumMedianDrawCalls} exceeds ${cardCTargets.twelveAgentMedianDrawCallsMaximum}`
      )
    }
    if (drawCallReductionPercent < cardCTargets.twelveAgentDrawCallReductionMinimumPercent) {
      violations.push(
        `12-agent draw-call reduction ${drawCallReductionPercent.toFixed(2)}% is below ${cardCTargets.twelveAgentDrawCallReductionMinimumPercent}% from baseline ${cardCTargets.twelveAgentBaselineMedianDrawCalls}`
      )
    }
  }

  for (const scenario of value.scenarios) {
    for (const violation of scenario.lodViolations ?? []) {
      violations.push(`${scenario.agents}-agent ${scenario.qualityMode}: ${violation}`)
    }
  }
  if (value.required && !value.lodUpgrade) {
    violations.push('missing low LOD workstation selection upgrade evidence')
  }

  return {
    name: '3D Office Card C assets, LOD, and draw-call contract',
    status: violations.length > 0 ? (value.required ? 'fail' : 'warn') : 'pass',
    metrics: {
      officeChunkBytes: value.artifacts.officeChunkBytes,
      robotGlbBytes: value.artifacts.robotGlbBytes,
      twelveAgentMedianDrawCallsByMode: drawCallsByMode,
      twelveAgentMaximumMedianDrawCalls: maximumMedianDrawCalls,
      twelveAgentDrawCallReductionPercent:
        drawCallReductionPercent === null ? null : Number(drawCallReductionPercent.toFixed(2)),
      lodUpgradeVerified: Boolean(value.lodUpgrade)
    },
    targets: cardCTargets,
    violations
  }
}

function writeReports(value) {
  const json = `${JSON.stringify(value, null, 2)}\n`
  const markdown = renderMarkdown(value)
  writeFileSync(path.join(runDir, 'report.json'), json)
  writeFileSync(path.join(runDir, 'report.md'), markdown)
  writeFileSync(path.join(reportRoot, 'latest.json'), json)
  writeFileSync(path.join(reportRoot, 'latest.md'), markdown)
  if (value.required) {
    writeFileSync(path.join(reportRoot, 'latest-required.json'), json)
    writeFileSync(path.join(reportRoot, 'latest-required.md'), markdown)
  }
}

function renderMarkdown(value) {
  const rows = value.scenarios.map((scenario) => {
    const regression = scenario.regressionViolations.length > 0 ? scenario.regressionViolations.join('; ') : 'none'
    const target = scenario.targetViolations.length > 0 ? scenario.targetViolations.join('; ') : 'met'
    return `| ${scenario.agents} | ${scenario.qualityMode} | ${scenario.effectiveQuality} | ${scenario.renderer.lod?.fullRobots ?? 0} | ${scenario.renderer.lod?.lowRobots ?? 0} | ${scenario.renderer.canvas.pixelRatio.toFixed(2)} | ${scenario.renderer.quality.shadows ? 'on' : 'off'} | ${scenario.renderer.quality.contactShadows} | ${scenario.rendererRendersPerSample.toFixed(2)} | ${scenario.firstNonblankMs} | ${scenario.frameDurationMs.median.toFixed(2)} | ${scenario.frameDurationMs.p95.toFixed(2)} | ${scenario.medianFps.toFixed(1)} | ${scenario.render.calls.median.toFixed(0)} | ${scenario.render.triangles.median.toFixed(0)} | ${regression} | ${target} |`
  })
  const pause = value.renderPause
    ? `hidden ${value.renderPause.hidden.atFrame} -> ${value.renderPause.hidden.afterFrame}; unfocused ${value.renderPause.unfocused.atFrame} -> ${value.renderPause.unfocused.afterFrame}; resumed ${value.renderPause.resumedAtFrame}`
    : 'not measured'
  const checks = value.checks.map((check) => {
    const detail = [
      ...(check.regressionViolations ?? []),
      ...(check.targetViolations ?? []),
      ...(check.violations ?? [])
    ].join('; ')
    return `| ${check.status} | ${check.name} | ${detail || 'none'} |`
  })
  const cardC = value.cardCContract?.metrics
  return `# 3D Office Performance\n\n- Run: ${value.runId}\n- Status: ${value.status}\n- Required: ${value.required}\n- Source: ${value.source.head}${value.source.dirty ? ' (dirty)' : ' (clean)'}\n- Platform: ${value.environment.platform} ${value.environment.arch}\n- CPU: ${value.environment.cpu}\n- GPU: ${value.scenarios[0]?.renderer.webgl.renderer ?? 'unknown'}\n- Coverage: Auto ${value.config.scenarioCounts.join('/')} agents; fixed ${value.config.qualityModes.filter((mode) => mode !== 'auto').join('/')} at ${value.config.fixedQualityAgentCount} agents; ${value.config.sampleFrames} samples + ${value.config.warmupFrames} warmups\n- Office chunk: ${value.artifacts.officeChunkBytes} bytes\n- Robot GLB: ${value.artifacts.robotGlbBytes} bytes\n- Card C draw calls: ${cardC?.twelveAgentMaximumMedianDrawCalls ?? 'not measured'} maximum median; ${cardC?.twelveAgentDrawCallReductionPercent ?? 'not measured'}% reduction from ${value.cardCTargets.twelveAgentBaselineMedianDrawCalls}\n- LOD selection upgrade: ${value.lodUpgrade ? `${value.lodUpgrade.before.lod.fullRobots}/${value.lodUpgrade.before.lod.lowRobots} full/low before; ${value.lodUpgrade.after.lod.fullRobots}/${value.lodUpgrade.after.lod.lowRobots} after` : 'not measured'}\n- Auto pressure: ${value.autoAdaptation ? JSON.stringify(value.autoAdaptation) : 'not measured'}\n- Hidden/unfocused render pause: ${pause}\n- Unmount cleanup: ${value.unmount ? JSON.stringify(value.unmount) : 'not measured'}\n\n| Agents | Requested | Effective | Full LOD | Low LOD | DPR | Shadows | Contact shadows | Renderer passes/frame | First nonblank ms | Median frame ms | P95 frame ms | Median FPS | Median calls | Median triangles | Regression violations | Target status |\n|---:|---|---|---:|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|\n${rows.join('\n')}\n\n## Checks\n\n| Status | Check | Details |\n|---|---|---|\n${checks.join('\n')}\n`
}

function sourceState() {
  try {
    return {
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--short', '--untracked-files=all'], {
        cwd: repoRoot,
        encoding: 'utf8'
      }).trim().length > 0
    }
  } catch {
    return { head: 'unknown', dirty: true }
  }
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

function parseQualityModes(raw) {
  const allowed = new Set(['auto', 'high', 'balanced', 'low'])
  const values = [...new Set(raw.split(',').map((item) => item.trim()))].filter(Boolean)
  if (values.length === 0 || values.some((value) => !allowed.has(value))) {
    fail('--qualities must be a comma-separated subset of auto,high,balanced,low')
  }
  return values
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
