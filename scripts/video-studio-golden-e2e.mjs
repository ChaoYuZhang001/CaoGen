#!/usr/bin/env node

import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnElectronTestProcess, terminateElectronTestProcess } from './lib/electron-test-process.mjs'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const { PNG } = require('pngjs')
const packageJson = require(path.join(repoRoot, 'package.json'))
const electronPackage = require('electron/package.json')
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
const outputRoot = path.join(repoRoot, 'test-results', 'video-studio-golden')
const runDir = path.join(outputRoot, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-video-studio-golden-'))
const userDataDir = path.join(tempRoot, 'userData')
const sourceOutDir = path.join(repoRoot, 'out')
const isolatedOutDir = path.join(runDir, 'app', 'out')
const mainEntry = path.join(isolatedOutDir, 'main', 'index.js')
const electronBin = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const projectName = `Video Golden ${runId}`
const initialScript = 'Scene one: a camera moves from the city morning into the workbench.\nScene two: the product completes a clear demonstration.'
const revisedScript = `${initialScript}\nScene three: the ending shows a clear call to action.`
const gitCommit = readGit(['rev-parse', 'HEAD'])
const worktreeStatus = readGit(['status', '--porcelain=v1']).split('\n').filter(Boolean)

assert(existsSync(electronBin), 'Electron binary not found. Run npm install first.')
for (const entry of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
  assert(existsSync(path.join(sourceOutDir, entry)), `Built app entry missing: out/${entry}. Run npm run build first.`)
}

mkdirSync(runDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
copyBuiltApp()

const report = {
  schemaVersion: 1,
  runId,
  runDir,
  requirement: 'VID-MVP-001',
  gate: 'test:video-studio-golden',
  packageVersion: packageJson.version,
  gitCommit,
  worktree: {
    clean: worktreeStatus.length === 0,
    changedPathCount: worktreeStatus.length
  },
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  electronVersion: electronPackage.version,
  environment: {
    userData: 'isolated temporary directory',
    provider: 'built-in local Mock Provider',
    preview: 'local FFmpeg',
    externalCredentials: 'disabled'
  },
  evidenceScope: {
    classification: 'local_targeted_not_release',
    requiredChecks: [
      'script to storyboard structure',
      'local decodable non-black preview',
      'traceable export Artifact/Evidence/Acceptance',
      'revision produces a new local preview',
      'failure cancellation and unknown-result states',
      'restart preserves states without duplicate Effect or Evidence'
    ],
    optionalChecks: [
      'commercial Provider quality or parity',
      'real remote Provider billing latency and reconciliation'
    ]
  },
  checks: [],
  screenshots: [],
  warnings: [],
  explicitlyNotVerified: [
    'commercial Provider generation quality or parity with external products',
    'real remote Provider billing and latency'
  ]
}

let stdout = ''
let stderr = ''
let activeStderr = ''
let electron = startElectronProcess()
let browser
let page

try {
  await connectElectron()

  await check('empty Video Studio starts with one title/script action', async () => {
    await page.click('[data-experience-mode-option="video"]')
    await page.waitForSelector('[data-video-studio-view]', { visible: true, timeout: 15_000 })
    await page.waitForSelector('[data-video-quick-start]', { visible: true, timeout: 15_000 })
    const surface = await page.evaluate(() => ({
      projects: document.querySelectorAll('[data-video-quick-start] input').length,
      textareas: document.querySelectorAll('[data-video-quick-start] textarea').length,
      actions: document.querySelectorAll('[data-video-quick-start] button').length
    }))
    assert.deepEqual(surface, { projects: 1, textareas: 1, actions: 1 }, `quick-start surface drifted: ${JSON.stringify(surface)}`)
  })

  await check('script creates Project, Production and automatic structure', async () => {
    await setInputValue(page, '[data-video-quick-start] input[aria-label="视频标题"]', projectName)
    await setInputValue(page, '[data-video-quick-start] textarea[aria-label="视频脚本"]', initialScript)
    report.enteredValues = await page.evaluate(() => ({
      title: document.querySelector('[data-video-quick-start] input[aria-label="视频标题"]')?.value || '',
      script: document.querySelector('[data-video-quick-start] textarea[aria-label="视频脚本"]')?.value || ''
    }))
    assert.equal(report.enteredValues.title, projectName, 'quick-start title did not reach the DOM')
    assert.equal(report.enteredValues.script, initialScript, 'quick-start script did not reach the DOM')
    await new Promise((resolve) => setTimeout(resolve, 100))
    await page.click('[data-video-quick-start] button[type="submit"]')
    await page.waitForSelector('[data-video-preview-flow]', { visible: true, timeout: 30_000 })
    const seeded = await waitForValue(
      () => page.evaluate(async (name) => {
        const project = (await window.agentDesk.listProjectWorkspaces()).find((item) => item.name === name)
        if (!project) return null
        const studio = await window.agentDesk.getMediaStudio(project.id)
        return { project, studio }
      }, projectName),
      (value) => Boolean(value?.project && value.studio.productions.length === 1 && value.studio.productions[0].scenes.length > 0),
      30_000,
      'waiting for automatic Video structure'
    )
    assert.equal(seeded.studio.productions[0].shots.length > 0, true, 'automatic structure did not create Shots')
    report.projectId = seeded.project.id
    report.productionId = seeded.studio.productions[0].id
    await page.waitForSelector(`[data-sidebar-video-production-id="${report.productionId}"]`, { visible: true, timeout: 15_000 })
    const advanced = await page.$$eval('[data-video-advanced-section]', (nodes) => nodes.map((node) => node.hasAttribute('open')))
    assert.deepEqual(advanced, [false, false, false], `advanced Video sections are visible by default: ${JSON.stringify(advanced)}`)
    await screenshot(page, '01-created')
  })

  await check('one primary action produces a playable local preview', async () => {
    report.ffmpeg = await page.evaluate(() => window.agentDesk.getMediaFfmpegInfo())
    assert.equal(report.ffmpeg?.available, true, `local FFmpeg is unavailable: ${JSON.stringify(report.ffmpeg)}`)
    await page.waitForSelector('[data-video-compose-preview]', { visible: true, timeout: 15_000 })
    await page.click('[data-video-compose-preview]')
    const composed = await waitForValue(
      () => page.evaluate(async (projectId) => {
        const studio = await window.agentDesk.getMediaStudio(projectId)
        const assets = studio.productions.flatMap((production) => production.assets)
        const asset = assets.filter((item) => item.kind === 'video' && item.authorization?.source === 'local_composition')
          .sort((left, right) => right.version - left.version)[0]
        return asset ? {
          assetId: asset.id,
          artifactId: asset.artifactId,
          status: asset.contentStatus,
          mediaType: asset.mediaType,
          sizeBytes: asset.sizeBytes,
          previewUrl: asset.previewUrl
        } : null
      }, report.projectId),
      (value) => value?.status === 'available' && value.mediaType === 'video/mp4' && Number(value.sizeBytes) > 0 && Boolean(value.previewUrl),
      60_000,
      'waiting for local playable composition'
    )
    assert.equal(composed.mediaType, 'video/mp4')
    assert(composed.artifactId, 'composition did not expose a canonical Artifact identity')
    const trace = await page.evaluate(async ({ projectId, artifactId }) => {
      const ledger = await window.agentDesk.listWorkflowLedger({ artifactId, limit: 100 })
      const evidence = await window.agentDesk.queryWorkflowEvidence({ artifactId, limit: 100 })
      return {
        artifact: ledger.artifacts.items.find((item) => item.id === artifactId) ?? null,
        evidence: evidence.items.filter((item) => item.artifactId === artifactId),
        acceptances: ledger.acceptances.items.filter((item) => item.evidenceRefs.some((evidenceId) =>
          evidence.items.some((item) => item.evidenceId === evidenceId && item.artifactId === artifactId)
        )),
        projectId
      }
    }, { projectId: report.projectId, artifactId: composed.artifactId })
    assert(trace.artifact, 'composition Artifact was not readable from the canonical ledger')
    assert(trace.evidence.length > 0, 'composition Evidence was not readable from the canonical ledger')
    assert(trace.acceptances.some((item) => item.status === 'passed'), 'composition Acceptance was not passed in the canonical ledger')
    const adopted = await page.evaluate(async (projectId) => {
      const studio = await window.agentDesk.getMediaStudio(projectId)
      const production = studio.productions[0]
      const asset = production?.assets
        .filter((item) => item.authorization?.source === 'local_composition')
        .sort((left, right) => right.version - left.version)[0]
      if (!asset) return null
      await window.agentDesk.setMediaAdoption({ productionId: production.id, assetId: asset.id, adopted: true })
      const refreshed = await window.agentDesk.getMediaStudio(projectId)
      const next = refreshed.productions.find((item) => item.id === production.id)
      return {
        finalAssetId: next?.finalAssetId,
        adopted: next?.assets.find((item) => item.id === asset.id)?.adopted === true
      }
    }, report.projectId)
    assert.deepEqual(adopted, { finalAssetId: composed.assetId, adopted: true }, 'adopted video did not retain the canonical final asset identity')
    const exportPath = path.join(tempRoot, 'exports', 'video-final.mp4')
    const exported = await page.evaluate(async ({ projectId, productionId, assetId, destinationPath }) =>
      window.agentDesk.exportMediaProduction({ projectId, productionId, assetId, destinationPath }), {
      projectId: report.projectId,
      productionId: report.productionId,
      assetId: composed.assetId,
      destinationPath: exportPath
    })
    assert.equal(exported.canceled, false, 'video export was unexpectedly canceled')
    assert.equal(exported.filePath, exportPath, 'video export returned the wrong destination')
    assert(exported.artifactId && exported.evidenceId && exported.acceptanceId, 'video export did not return canonical identities')
    assert(existsSync(exportPath), 'video export file was not created')
    const exportedBytes = readFileSync(exportPath)
    assert.equal(exportedBytes.byteLength, Number(exported.sizeBytes), 'exported byte count differs from the canonical record')
    const exportedDigest = `sha256:${createHash('sha256').update(exportedBytes).digest('hex')}`
    assert.equal(exportedDigest, exported.digest, 'exported bytes do not match the returned digest')
    const exportTrace = await page.evaluate(async ({ artifactId, evidenceId, acceptanceId, sourceArtifactId }) => {
      const ledger = await window.agentDesk.listWorkflowLedger({ artifactId, limit: 100 })
      const evidence = await window.agentDesk.queryWorkflowEvidence({ evidenceId, artifactId, limit: 100 })
      const locations = await window.agentDesk.listWorkflowArtifactLocations({ artifactId, limit: 100 })
      const graph = await window.agentDesk.queryWorkflowArtifactGraph(artifactId)
      return {
        artifact: ledger.artifacts.items.find((item) => item.id === artifactId) ?? null,
        evidence: evidence.items.find((item) => item.evidenceId === evidenceId) ?? null,
        acceptance: ledger.acceptances.items.find((item) => item.id === acceptanceId) ?? null,
        location: locations.items.find((item) => item.artifactId === artifactId && item.uri?.startsWith('file:')) ?? null,
        sourceEdge: graph.outbound.find((item) => item.relation === 'derived_from') ?? null
      }
    }, { artifactId: exported.artifactId, evidenceId: exported.evidenceId, acceptanceId: exported.acceptanceId, sourceArtifactId: exported.sourceArtifactId })
    assert(exportTrace.artifact, 'export Artifact was not readable from the canonical ledger')
    assert(exportTrace.evidence, 'export Evidence was not readable from the canonical ledger')
    assert.equal(exportTrace.acceptance?.status, 'passed', 'export Acceptance was not passed')
    assert(exportTrace.location?.uri?.startsWith('file:'), 'export location was not recorded as a file URI')
    assert.equal(exportTrace.sourceEdge?.toArtifactId, exported.sourceArtifactId, 'export source-version lineage points to the wrong Artifact')
    const repeatedExport = await page.evaluate(async ({ projectId, productionId, assetId, destinationPath }) =>
      window.agentDesk.exportMediaProduction({ projectId, productionId, assetId, destinationPath }), {
      projectId: report.projectId,
      productionId: report.productionId,
      assetId: composed.assetId,
      destinationPath: exportPath
    })
    assert.deepEqual(
      { artifactId: repeatedExport.artifactId, evidenceId: repeatedExport.evidenceId, acceptanceId: repeatedExport.acceptanceId, digest: repeatedExport.digest },
      { artifactId: exported.artifactId, evidenceId: exported.evidenceId, acceptanceId: exported.acceptanceId, digest: exported.digest },
      'repeated export did not reuse the canonical output identities'
    )
    const repeatedLedger = await page.evaluate(async ({ artifactId, evidenceId, acceptanceId }) => {
      const ledger = await window.agentDesk.listWorkflowLedger({ artifactId, limit: 100 })
      const evidence = await window.agentDesk.queryWorkflowEvidence({ artifactId, evidenceId, limit: 100 })
      return {
        artifacts: ledger.artifacts.items.filter((item) => item.id === artifactId),
        evidence: evidence.items.filter((item) => item.evidenceId === evidenceId),
        acceptances: ledger.acceptances.items.filter((item) => item.id === acceptanceId)
      }
    }, { artifactId: exported.artifactId, evidenceId: exported.evidenceId, acceptanceId: exported.acceptanceId })
    assert.equal(repeatedLedger.artifacts.length, 1, 'repeated export created a second Artifact')
    assert.equal(repeatedLedger.evidence.length, 1, 'repeated export created duplicate Evidence')
    assert.equal(repeatedLedger.acceptances.length, 1, 'repeated export created duplicate Acceptance')
    await page.waitForSelector('[data-video-preview]', { visible: true, timeout: 15_000 })
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-video-preview]')
      return node instanceof HTMLVideoElement && node.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && node.videoWidth > 0
    }, { timeout: 15_000 })
    const media = await page.$eval('[data-video-preview]', (node) => ({
      tag: node.tagName,
      src: node.getAttribute('src') || '',
      readyState: node instanceof HTMLVideoElement ? node.readyState : 0,
      width: node instanceof HTMLVideoElement ? node.videoWidth : 0
    }))
    assert.equal(media.tag, 'VIDEO', 'preview is not rendered as a video element')
    assert(media.src.length > 0, 'preview video has no source')
    assert(media.readyState >= 2 && media.width > 0, `preview video did not decode: ${JSON.stringify(media)}`)
    const previewScreenshot = await page.$('[data-video-preview]')
    assert(previewScreenshot, 'preview video element disappeared before visual capture')
    await page.$eval('[data-video-preview]', async (node) => {
      if (!(node instanceof HTMLVideoElement)) return
      node.muted = true
      await node.play().catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 150))
      node.pause()
    })
    await page.$eval('[data-video-preview]', (node) => { if (node instanceof HTMLVideoElement) node.removeAttribute('controls') })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const png = PNG.sync.read(await previewScreenshot.screenshot())
    let nonBlack = 0
    for (let index = 0; index < png.data.length; index += 4) {
      if (png.data[index] + png.data[index + 1] + png.data[index + 2] > 36) nonBlack += 1
    }
    const nonBlackRatio = nonBlack / Math.max(1, png.width * png.height)
    assert(nonBlackRatio > 0.05, `preview frame is effectively black: ${JSON.stringify({ ...media, nonBlackRatio })}`)
    await screenshot(page, '02-preview')
  })

  await check('revision stays in the same production and can be previewed again', async () => {
    const before = await page.evaluate((projectId) => window.agentDesk.getMediaStudio(projectId), report.projectId)
    const beforeProduction = before.productions.find((item) => item.id === report.productionId)
    assert(beforeProduction, 'Production disappeared before revision')
    await page.$eval('[aria-label="制作剧本"]', (element) => {
      element.focus()
      element.select()
    })
    await setInputValue(page, '[aria-label="制作剧本"]', revisedScript)
    await page.click('[data-video-revise]')
    await waitForValue(
      () => page.evaluate((projectId) => window.agentDesk.getMediaStudio(projectId), report.projectId),
      (studio) => {
        const production = studio.productions.find((item) => item.id === report.productionId)
        return Boolean(production && production.revision > beforeProduction.revision && production.structureRevisions.length > beforeProduction.structureRevisions.length && production.scenes.length >= 3)
      },
      30_000,
      'waiting for Video structure revision'
    )
    await page.waitForFunction(() => {
      const compose = document.querySelector('[data-video-compose-preview]')
      return compose instanceof HTMLButtonElement && !compose.disabled &&
        document.querySelectorAll('.video-studio-shot').length >= 3
    }, { timeout: 15_000 })
    await page.click('[data-video-compose-preview]')
    const after = await waitForValue(
      () => page.evaluate((projectId) => window.agentDesk.getMediaStudio(projectId), report.projectId),
      (studio) => {
        const production = studio.productions.find((item) => item.id === report.productionId)
        return production && production.assets.filter((item) => item.kind === 'video' && item.authorization?.source === 'local_composition').length > 1
      },
      60_000,
      'waiting for revised local preview'
    )
    assert(after, 'revised preview did not create a new local composition asset')
    await screenshot(page, '03-revised-preview')
  })

  await check('Video Mock jobs expose failure, cancellation and unknown-result states', async () => {
    const recovery = await page.evaluate(async ({ projectId, productionId }) => {
      const submit = (idempotencyKey, mockScenario) => window.agentDesk.submitMediaJob({
        projectId,
        productionId,
        capability: 'video',
        operation: 'video.text-to-video',
        idempotencyKey,
        prompt: `Recovery fixture ${mockScenario}`,
        mockScenario
      })
      const failure = await submit('video-recovery-failure', 'failure')
      const failureRunning = await window.agentDesk.advanceMediaJob(failure.id)
      const failed = await window.agentDesk.advanceMediaJob(failureRunning.id)
      const cancel = await submit('video-recovery-cancel', 'success')
      const cancelled = await window.agentDesk.cancelMediaJob(cancel.id)
      const unknown = await submit('video-recovery-unknown', 'unknown_result')
      const unknownRunning = await window.agentDesk.advanceMediaJob(unknown.id)
      const waiting = await window.agentDesk.advanceMediaJob(unknownRunning.id)
      const studio = await window.agentDesk.getMediaStudio(projectId)
      const persisted = studio.jobs
        .filter((job) => ['video-recovery-failure', 'video-recovery-cancel', 'video-recovery-unknown'].includes(job.idempotencyKey))
      const terminalEvidence = await Promise.all(persisted
        .filter((job) => ['failed', 'cancelled'].includes(job.status))
        .map(async (job) => ({
          idempotencyKey: job.idempotencyKey,
          status: job.status,
          goalId: job.goalId,
          workItemId: job.workItemId,
          runId: job.runId,
          evidence: (await window.agentDesk.queryWorkflowEvidence({ runId: job.runId, limit: 10 })).items
            .filter((item) => item.kind === 'observation' && item.metadata?.mediaJobId === job.id)
            .map((item) => ({
              evidenceId: item.evidenceId,
              status: item.metadata?.status,
              projectId: item.projectId,
              goalId: item.goalId,
              workItemId: item.workItemId,
              runId: item.runId,
              source: item.source
            }))
        })))
      return {
        failure: { status: failed.status, history: failed.statusHistory.map((item) => item.status) },
        cancel: { status: cancelled.status, history: cancelled.statusHistory.map((item) => item.status) },
        unknown: { status: waiting.status, history: waiting.statusHistory.map((item) => item.status) },
        persisted: persisted.map((job) => ({ idempotencyKey: job.idempotencyKey, status: job.status, history: job.statusHistory.map((item) => item.status) })),
        terminalEvidence
      }
    }, { projectId: report.projectId, productionId: report.productionId })
    assert.deepEqual(recovery.failure, {
      status: 'failed',
      history: ['requested', 'submitting', 'running', 'failed']
    }, `failure state drifted: ${JSON.stringify(recovery.failure)}`)
    assert.deepEqual(recovery.cancel, {
      status: 'cancelled',
      history: ['requested', 'submitting', 'cancelled']
    }, `cancel state drifted: ${JSON.stringify(recovery.cancel)}`)
    assert.deepEqual(recovery.unknown, {
      status: 'waiting_reconciliation',
      history: ['requested', 'submitting', 'running', 'waiting_reconciliation']
    }, `unknown-result state drifted: ${JSON.stringify(recovery.unknown)}`)
    assert.equal(recovery.persisted.length, 3, 'recovery fixtures were not readable from the canonical Media store')
    assert.equal(recovery.terminalEvidence.length, 2, `terminal failure/cancel Evidence is incomplete: ${JSON.stringify(recovery.terminalEvidence)}`)
    for (const item of recovery.terminalEvidence) {
      assert.equal(item.evidence.length, 1, `terminal MediaJob Evidence is not unique: ${JSON.stringify(item)}`)
      const [evidence] = item.evidence
      assert.deepEqual({
        status: evidence.status,
        projectId: evidence.projectId,
        goalId: evidence.goalId,
        workItemId: evidence.workItemId,
        runId: evidence.runId,
        source: evidence.source
      }, {
        status: item.status,
        projectId: report.projectId,
        goalId: item.goalId,
        workItemId: item.workItemId,
        runId: item.runId,
        source: 'runtime'
      }, `terminal MediaJob Evidence differs from the canonical Job: ${JSON.stringify(item)}`)
    }
  })

  await check('Video job states survive an Electron restart without replay', async () => {
    await restartElectron()
    const afterRestart = await page.evaluate(async (projectId) => {
      const studio = await window.agentDesk.getMediaStudio(projectId)
      const jobs = studio.jobs
        .filter((job) => ['video-recovery-failure', 'video-recovery-cancel', 'video-recovery-unknown'].includes(job.idempotencyKey))
      return Promise.all(jobs.map(async (job) => ({
          idempotencyKey: job.idempotencyKey,
          status: job.status,
          operationRunIds: job.operationRunIds,
          effectIds: job.effectIds,
          history: job.statusHistory.map((item) => item.status),
          terminalEvidenceIds: (await window.agentDesk.queryWorkflowEvidence({ runId: job.runId, limit: 10 })).items
            .filter((item) => item.kind === 'observation' && item.metadata?.mediaJobId === job.id)
            .map((item) => item.evidenceId)
            .sort()
        }))).then((items) => items.sort((left, right) => left.idempotencyKey.localeCompare(right.idempotencyKey)))
    }, report.projectId)
    assert.deepEqual(afterRestart.map((job) => ({ idempotencyKey: job.idempotencyKey, status: job.status, history: job.history })), [
      { idempotencyKey: 'video-recovery-cancel', status: 'cancelled', history: ['requested', 'submitting', 'cancelled'] },
      { idempotencyKey: 'video-recovery-failure', status: 'failed', history: ['requested', 'submitting', 'running', 'failed'] },
      { idempotencyKey: 'video-recovery-unknown', status: 'waiting_reconciliation', history: ['requested', 'submitting', 'running', 'waiting_reconciliation'] }
    ], `Video job states changed after restart: ${JSON.stringify(afterRestart)}`)
    for (const job of afterRestart) {
      assert(job.operationRunIds.length === job.history.length - 1, `restart duplicated operation runs for ${job.idempotencyKey}`)
      assert(job.effectIds.length === job.history.length - 1, `restart duplicated Effects for ${job.idempotencyKey}`)
      assert.equal(job.terminalEvidenceIds.length, job.status === 'waiting_reconciliation' ? 0 : 1, `restart changed terminal Evidence cardinality for ${job.idempotencyKey}`)
    }
  })

  report.status = 'passed'
  writeReport()
  console.log(`video studio golden E2E: passed (${report.checks.length}/${report.checks.length})`)
  console.log(reportPath())
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.stack || error.message : String(error)
  report.process = { stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) }
  writeReport()
  throw error
} finally {
  if (browser) await browser.disconnect().catch(() => undefined)
  await terminateElectronTestProcess(electron)
  rmSync(tempRoot, { recursive: true, force: true })
}

function reportPath() { return path.join(runDir, 'report.json') }
function writeReport() { writeFileSync(reportPath(), `${JSON.stringify(report, null, 2)}\n`, 'utf8') }
function readGit(args) { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim() }
function startElectronProcess() {
  activeStderr = ''
  const child = spawnElectronTestProcess(electronBin, [
    ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    '--remote-debugging-port=0',
    mainEntry
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAOGEN_USER_DATA_DIR: userDataDir,
      CAOGEN_MEMORY_DIR: path.join(tempRoot, 'memory'),
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => {
    const value = chunk.toString()
    stderr += value
    activeStderr += value
  })
  return child
}
async function connectElectron() {
  const remotePort = await waitForDevToolsPort(electron, 20_000, () => activeStderr)
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${remotePort}`, defaultViewport: null })
  page = await waitForElectronPage(browser, 20_000)
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') report.warnings.push(`console ${message.type()}: ${message.text()}`)
  })
  page.on('pageerror', (error) => report.warnings.push(`pageerror: ${error.message}`))
  await page.setViewport({ width: 1320, height: 860, deviceScaleFactor: 1 })
  await waitForApp(page)
}
async function restartElectron() {
  if (browser) {
    await browser.disconnect().catch(() => undefined)
    browser = undefined
  }
  await terminateElectronTestProcess(electron)
  electron = startElectronProcess()
  await connectElectron()
}
function copyBuiltApp() {
  rmSync(isolatedOutDir, { recursive: true, force: true })
  mkdirSync(isolatedOutDir, { recursive: true })
  for (const directory of ['main', 'preload', 'renderer']) {
    cpSync(path.join(sourceOutDir, directory), path.join(isolatedOutDir, directory), { recursive: true })
  }
}
async function waitForApp(targetPage) {
  await targetPage.waitForSelector('.app', { timeout: 20_000 })
  await targetPage.waitForFunction(() => typeof window.agentDesk?.createProjectWorkspace === 'function' && typeof window.agentDesk?.getMediaStudio === 'function', { timeout: 15_000 })
  await targetPage.waitForSelector('[data-experience-mode-switcher]', { visible: true, timeout: 15_000 })
}
async function waitForElectronPage(connectedBrowser, timeoutMs) {
  const pages = await waitForValue(
    () => connectedBrowser.pages(),
    (candidates) => candidates.some((candidate) => candidate.url().startsWith('file://')),
    timeoutMs,
    'waiting for Electron renderer page'
  )
  return pages.find((candidate) => candidate.url().startsWith('file://'))
}
function waitForDevToolsPort(child, timeoutMs, readBufferedStderr = () => '') {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    let settled = false
    let bufferedStderr = readBufferedStderr()
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stderr?.off('data', onStderr)
      child.off('exit', onExit)
      callback(value)
    }
    const onStderr = (chunk) => {
      bufferedStderr += chunk.toString()
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(bufferedStderr)
      if (match) finish(resolve, Number(match[1]))
    }
    const onExit = (code, signal) => finish(reject, new Error(`Electron exited before DevTools opened (code=${code}, signal=${signal})`))
    const timer = setTimeout(() => finish(reject, new Error(`Electron DevTools did not open within ${timeoutMs}ms (elapsed=${Date.now() - startedAt}ms)`)), timeoutMs)
    child.stderr?.on('data', onStderr)
    child.once('exit', onExit)
    const bufferedMatch = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(bufferedStderr)
    if (bufferedMatch) finish(resolve, Number(bufferedMatch[1]))
  })
}
async function waitForValue(read, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await read()
    if (predicate(last)) return last
    await sleep(100)
  }
  throw new Error(`${label}; last=${JSON.stringify(last)}`)
}
async function check(name, execute) {
  const startedAt = Date.now()
  try {
    await execute()
    report.checks.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
  } catch (error) {
    report.checks.push({ name, status: 'fail', durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}
async function screenshot(targetPage, name) {
  const file = path.join(runDir, `${name}.png`)
  await targetPage.screenshot({ path: file, fullPage: false })
  report.screenshots.push(file)
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
async function setInputValue(targetPage, selector, value) {
  await targetPage.focus(selector)
  await targetPage.keyboard.type(value)
}
