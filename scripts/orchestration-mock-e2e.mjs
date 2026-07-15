#!/usr/bin/env node
import http from 'node:http'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const { PNG } = require('pngjs')
const outDir = path.join(repoRoot, 'test-results', 'orchestration-mock-e2e')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const runDir = path.join(outDir, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-orchestration-mock-'))
const userDataDir = path.join(tempRoot, 'userData')
const projectDir = path.join(tempRoot, 'project')
const approvalFileName = 'office-approval-required.txt'
const officeFailureMessage = 'office deterministic validation fault'
const OFFICE_OVERVIEW_CAMERA = {
  position: [0.28, 4.5, 9.55],
  target: [0.02, 0.82, -1.18],
  fov: 44
}
const OFFICE_FACILITIES_CAMERA = {
  position: [-1.6, 5.5, 14.6],
  target: [-1.6, 0.82, 4.2],
  fov: 44
}
const electronBin =
  process.platform === 'win32'
    ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const sourceOutDir = path.join(repoRoot, 'out')
const sourceMainEntry = path.join(sourceOutDir, 'main', 'index.js')
const sourceRendererEntry = path.join(sourceOutDir, 'renderer', 'index.html')
const isolatedOutDir = path.join(runDir, 'app', 'out')
const mainEntry = path.join(isolatedOutDir, 'main', 'index.js')

if (!existsSync(electronBin)) fail('Electron binary not found. Run npm install first.')
if (!existsSync(sourceMainEntry)) fail('Built Electron main entry not found. Run npm run build first.')
if (!existsSync(sourceRendererEntry)) fail('Built Electron renderer entry not found. Run npm run build first.')

mkdirSync(runDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
mkdirSync(projectDir, { recursive: true })
copyBuiltApp(isolatedOutDir)
writeFileSync(path.join(projectDir, 'README.md'), '# CaoGen orchestration mock e2e\n')

const report = {
  runId,
  runDir,
  projectDir,
  userDataDir,
  checks: [],
  screenshots: [],
  warnings: [],
  requests: []
}

const mock = await startOpenAiMock()
writeMockUserData(mock.port)
const remotePort = await findFreePort(9820)
const app = spawn(electronBin, [`--remote-debugging-port=${remotePort}`, mainEntry], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CAOGEN_USER_DATA_DIR: userDataDir,
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: '',
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '',
    CLAUDE_CODE_HOST_CREDS_FILE: '',
    CLAUDE_CODE_HOST_AUTH_ENV_VAR: '',
    CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '',
    CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH: ''
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
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${remotePort}`, defaultViewport: null })
  const pages = await browser.pages()
  const page = pages.find((item) => !item.url().startsWith('devtools://')) || pages[0]
  if (!page) throw new Error('Electron page target not found')
  focusSession = await page.target().createCDPSession()
  await focusSession.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      const loc = msg.location()
      const suffix = loc.url ? ` @ ${loc.url}:${loc.lineNumber}:${loc.columnNumber}` : ''
      report.warnings.push(`console ${msg.type()}: ${msg.text()}${suffix}`)
    }
  })
  page.on('pageerror', (error) => report.warnings.push(`pageerror: ${error.stack || error.message}`))

  await page.waitForSelector('.app', { timeout: 20_000 })
  await waitForAgentDesk(page)
  await page.evaluate(() => {
    window.__orchestrationEvents = []
    window.agentDesk.onSessionEvent((sessionId, event, seq) => {
      window.__orchestrationEvents.push({ sessionId, event, seq })
    })
  })

  let parent
  let dispatch
  await check('parent session and child sessions dispatch through real preload IPC', async () => {
    parent = await page.evaluate((cwd) => {
      return window.agentDesk.createSession({
        cwd,
        engine: 'openai',
        providerId: 'mock-qwen',
        model: 'qwen-plus',
        isolated: false,
        title: 'A3 orchestration parent'
      })
    }, projectDir)
    dispatch = await page.evaluate((parentId) => {
      return window.agentDesk.dispatchSubagents(parentId, {
        isolated: false,
        tasks: [
          {
            id: 'api',
            role: 'backend',
            title: 'API child',
            prompt: 'A3 child api: return a short backend result.'
          },
          {
            id: 'ui',
            role: 'frontend',
            title: 'UI child',
            prompt: 'A3 child ui: return a short frontend result.'
          }
        ]
      })
    }, parent.id)
    assert(parent.id, 'parent id missing')
    assert(dispatch.children.length === 2, `expected 2 child sessions, got ${dispatch.children.length}`)
    assert(dispatch.children.every((child) => child.meta.parentSessionId === parent.id), 'child parentSessionId mismatch')
  })

  await check('child turn-results are reflected as parent subagent results and summary injection', async () => {
    const state = await waitForValue(
      () =>
        page.evaluate(async (parentId) => {
          const entries = await window.agentDesk.getTranscript(parentId)
          const liveEvents = Array.isArray(window.__orchestrationEvents) ? window.__orchestrationEvents : []
          const summaryIndex = entries.findIndex(
            (entry) =>
              entry.event?.kind === 'user-message' &&
              typeof entry.event.text === 'string' &&
              entry.event.text.includes('[子代理编排完成]')
          )
          const childResults = liveEvents.filter(
            (entry) => entry.sessionId === parentId && entry.event?.kind === 'subagent-result'
          )
          const parentReply =
            summaryIndex >= 0 &&
            entries.slice(summaryIndex + 1).some((entry) => entry.event?.kind === 'turn-result' && !entry.event.isError)
          const metas = await window.agentDesk.listSessions()
          return {
            summaryIndex,
            childResultCount: childResults.length,
            parentReply,
            children: metas.filter((meta) => meta.parentSessionId === parentId)
          }
        }, parent.id),
      (value) => value.summaryIndex >= 0 && value.childResultCount === 2 && value.parentReply && value.children.length === 2,
      30_000,
      'waiting for orchestration result fan-in'
    )
    assert(state.children.every((child) => child.orchestrationId === dispatch.orchestrationId), 'child orchestrationId mismatch')
  })
  await screenshot(page, '01-orchestration-complete')

  await check('mock requests prove child prompts and parent summary ran through the model path', async () => {
    assert(mock.requests.length >= 3, `expected at least 3 model requests, got ${mock.requests.length}`)
    const bodies = mock.requests.map((request) => JSON.stringify(request.body))
    assert(bodies.some((body) => body.includes('A3 child api')), 'api child prompt missing from mock requests')
    assert(bodies.some((body) => body.includes('A3 child ui')), 'ui child prompt missing from mock requests')
    assert(bodies.some((body) => body.includes('子代理编排完成')), 'parent summary prompt missing from mock requests')
    report.requests = mock.requests
  })

  let approval
  await check('approval session exposes a real pending permission for the 3D approval station', async () => {
    approval = await page.evaluate((cwd) => {
      return window.agentDesk.createSession({
        cwd,
        engine: 'openai',
        providerId: 'mock-deepseek',
        model: 'deepseek-reasoner',
        isolated: false,
        title: 'Approval gate'
      })
    }, projectDir)
    await page.evaluate((sessionId, run) => {
      return window.agentDesk.sendMessage(sessionId, `office approval e2e ${run}`)
    }, approval.id, runId)
    const pending = await waitForValue(
      () => page.evaluate((sessionId) => window.agentDesk.listPendingPermissions(sessionId), approval.id),
      (value) => Array.isArray(value) && value.some((request) => request.toolName === 'write_file'),
      15_000,
      'waiting for office approval pending permission'
    )
    assert(pending.some((request) => JSON.stringify(request.input).includes(approvalFileName)), 'approval permission target missing')
  })

  let failure
  await check('failed session exposes a real error state for the 3D office fault beacon', async () => {
    failure = await page.evaluate((cwd) => {
      return window.agentDesk.createSession({
        cwd,
        engine: 'openai',
        providerId: 'mock-deepseek',
        model: 'deepseek-reasoner',
        isolated: false,
        title: 'Faulted Agent'
      })
    }, projectDir)
    await page.evaluate((sessionId, run) => {
      return window.agentDesk.sendMessage(sessionId, `office failure e2e ${run}`)
    }, failure.id, runId)
    const failedTurn = await waitForValue(
      () =>
        page.evaluate(async (sessionId) => {
          const entries = await window.agentDesk.getTranscript(sessionId)
          const metas = await window.agentDesk.listSessions()
          const meta = metas.find((item) => item.id === sessionId)
          const turn = [...entries].reverse().find((entry) => entry.event?.kind === 'turn-result')
          return {
            status: meta?.status ?? '',
            isError: turn?.event?.isError === true,
            resultText: turn?.event?.resultText ?? ''
          }
        }, failure.id),
      (value) => value.status === 'error' && value.isError && String(value.resultText).includes(officeFailureMessage),
      15_000,
      'waiting for failed office session'
    )
    report.officeFailureSession = { id: failure.id, status: failedTurn.status, resultText: failedTurn.resultText }
  })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app', { timeout: 20_000 })
  await waitForAgentDesk(page)
  await page.waitForFunction(() => document.body.innerText.includes('A3 orchestration parent'), { timeout: 15_000 })
  await page.click('.sidebar-office')
  await page.waitForSelector('.office canvas', { timeout: 20_000 })

  await check('3D office model exposes parent-child Subagent packets', async () => {
    const attrs = await waitForValue(
      () =>
        page.evaluate(() => {
          const wrap = document.querySelector('.office-canvas-wrap')
          const readTargets = (name) => {
            try {
              return JSON.parse(wrap?.getAttribute(name) || '[]')
            } catch {
              return []
            }
          }
          const workstationHitTargets = readTargets('data-office-workstation-hit-targets')
          const walkerHitTargets = readTargets('data-office-walker-hit-targets')
          const facilityHitTargets = readTargets('data-office-facility-hit-targets')
          const faultHitTargets = readTargets('data-office-fault-hit-targets')
          let incidentCamera = null
          try {
            incidentCamera = JSON.parse(wrap?.getAttribute('data-office-incident-camera') || 'null')
          } catch {
            incidentCamera = null
          }
          return {
            sessions: Number(wrap?.getAttribute('data-office-sessions') ?? 0),
            idleSessions: Number(wrap?.getAttribute('data-office-idle-sessions') ?? 0),
            runningSessions: Number(wrap?.getAttribute('data-office-running-sessions') ?? 0),
            waitingApprovalSessions: Number(wrap?.getAttribute('data-office-waiting-approval-sessions') ?? 0),
            completedSessions: Number(wrap?.getAttribute('data-office-completed-sessions') ?? 0),
            failedSessions: Number(wrap?.getAttribute('data-office-failed-sessions') ?? 0),
            packets: Number(wrap?.getAttribute('data-office-packets') ?? 0),
            subagentPackets: Number(wrap?.getAttribute('data-office-subagent-packets') ?? 0),
            walkers: Number(wrap?.getAttribute('data-office-walkers') ?? 0),
            awaySessions: Number(wrap?.getAttribute('data-office-away-sessions') ?? 0),
            deskRobots: Number(wrap?.getAttribute('data-office-desk-robots') ?? 0),
            visibleRobots: Number(wrap?.getAttribute('data-office-visible-robots') ?? 0),
            oneRobotPerAgent: Number(wrap?.getAttribute('data-office-one-robot-per-agent') ?? 0),
            teaWalkers: Number(wrap?.getAttribute('data-office-tea-walkers') ?? 0),
            approvalWalkers: Number(wrap?.getAttribute('data-office-approval-walkers') ?? 0),
            restroomWalkers: Number(wrap?.getAttribute('data-office-restroom-walkers') ?? 0),
            diningWalkers: Number(wrap?.getAttribute('data-office-dining-walkers') ?? 0),
            facilityWalkers: Number(wrap?.getAttribute('data-office-facility-walkers') ?? 0),
            approvalStations: Number(wrap?.getAttribute('data-office-approval-stations') ?? 0),
            hydrationStations: Number(wrap?.getAttribute('data-office-hydration-stations') ?? 0),
            restroomStations: Number(wrap?.getAttribute('data-office-restroom-stations') ?? 0),
            diningStations: Number(wrap?.getAttribute('data-office-dining-stations') ?? 0),
            facilityFixtures: Number(wrap?.getAttribute('data-office-facility-fixtures') ?? 0),
            serviceWayfinding: Number(wrap?.getAttribute('data-office-service-wayfinding') ?? 0),
            amenityPortals: Number(wrap?.getAttribute('data-office-amenity-portals') ?? 0),
            facilitySignals: Number(wrap?.getAttribute('data-office-facility-signals') ?? 0),
            clickableFacilities: Number(wrap?.getAttribute('data-office-clickable-facilities') ?? 0),
            selectedFacility: wrap?.getAttribute('data-office-selected-facility') ?? '',
            facilityHitTargets: facilityHitTargets.length,
            facilityPanel: document.querySelector('.office-facility-panel')?.getAttribute('data-office-facility-panel') ?? '',
            sideGlass: Number(wrap?.getAttribute('data-office-side-glass') ?? 0),
            architecturalLights: Number(wrap?.getAttribute('data-office-architectural-lights') ?? 0),
            workZoneGlass: Number(wrap?.getAttribute('data-office-work-zone-glass') ?? 0),
            vendorEmblems: Number(wrap?.getAttribute('data-office-vendor-emblems') ?? 0),
            deskFacingScreens: Number(wrap?.getAttribute('data-office-desk-facing-screens') ?? 0),
            operatorContactLinks: Number(wrap?.getAttribute('data-office-operator-contact-links') ?? 0),
            screenFocusLinks: Number(wrap?.getAttribute('data-office-screen-focus-links') ?? 0),
            deskStatusPlaques: Number(wrap?.getAttribute('data-office-desk-status-plaques') ?? 0),
            walkerFloorBadges: Number(wrap?.getAttribute('data-office-walker-floor-badges') ?? 0),
            workInputs: Number(wrap?.getAttribute('data-office-work-inputs') ?? 0),
            operatorInputArrays: Number(wrap?.getAttribute('data-office-operator-input-arrays') ?? 0),
            serviceForegroundOccluders: Number(wrap?.getAttribute('data-office-service-foreground-occluders') ?? -1),
            screenPanels: Number(wrap?.getAttribute('data-office-screen-panels') ?? 0),
            walkerRoutes: Number(wrap?.getAttribute('data-office-walker-routes') ?? 0),
            sightlineSafe: Number(wrap?.getAttribute('data-office-sightline-safe') ?? 0),
            cutawayWalls: Number(wrap?.getAttribute('data-office-cutaway-walls') ?? 0),
            overheadFixturesHidden: Number(wrap?.getAttribute('data-office-overhead-fixtures-hidden') ?? 0),
            sideGlassCutaway: Number(wrap?.getAttribute('data-office-side-glass-cutaway') ?? 0),
            wallOccluders: Number(wrap?.getAttribute('data-office-wall-occluders') ?? -1),
            longLightOccluders: Number(wrap?.getAttribute('data-office-long-light-occluders') ?? -1),
            presentationBackdrop: Number(wrap?.getAttribute('data-office-presentation-backdrop') ?? 0),
            industrialRobots: Number(wrap?.getAttribute('data-office-industrial-robots') ?? 0),
            humanoidRobotSilhouettes: Number(wrap?.getAttribute('data-office-humanoid-robot-silhouettes') ?? 0),
            humanoidFaceVisors: Number(wrap?.getAttribute('data-office-humanoid-face-visors') ?? 0),
            humanoidShellPanels: Number(wrap?.getAttribute('data-office-humanoid-shell-panels') ?? 0),
            humanoidArticulatedJoints: Number(wrap?.getAttribute('data-office-humanoid-articulated-joints') ?? 0),
            humanoidBackShells: Number(wrap?.getAttribute('data-office-humanoid-back-shells') ?? 0),
            humanoidNeutralShells: Number(wrap?.getAttribute('data-office-humanoid-neutral-shells') ?? 0),
            faultBeacons: Number(wrap?.getAttribute('data-office-fault-beacons') ?? 0),
            maintenanceUnits: Number(wrap?.getAttribute('data-office-maintenance-units') ?? 0),
            diagnosticBeams: Number(wrap?.getAttribute('data-office-diagnostic-beams') ?? 0),
            faultResponseRigs: Number(wrap?.getAttribute('data-office-fault-response-rigs') ?? 0),
            faultHitTargets: faultHitTargets.length,
            incidentCameraAvailable: Number(wrap?.getAttribute('data-office-incident-camera-available') ?? 0),
            incidentCameraValid: Array.isArray(incidentCamera?.position) && Array.isArray(incidentCamera?.target) ? 1 : 0,
            providerSkinPanels: Number(wrap?.getAttribute('data-office-provider-skin-panels') ?? 0),
            realProviderLogoSkins: Number(wrap?.getAttribute('data-office-real-provider-logo-skins') ?? 0),
            realProviderLogoAssets: Number(wrap?.getAttribute('data-office-real-provider-logo-assets') ?? 0),
            realProviderLogoWordmarks: Number(wrap?.getAttribute('data-office-real-provider-logo-wordmarks') ?? 0),
            cnProviderLogoSkins: Number(wrap?.getAttribute('data-office-cn-provider-logo-skins') ?? 0),
            cnProviderLogoAssets: Number(wrap?.getAttribute('data-office-cn-provider-logo-assets') ?? 0),
            cnProviderLogoWordmarks: Number(wrap?.getAttribute('data-office-cn-provider-logo-wordmarks') ?? 0),
            detectedCnSessions: Number(wrap?.getAttribute('data-office-detected-cn-sessions') ?? 0),
            qwenLogoSkins: Number(wrap?.getAttribute('data-office-qwen-logo-skins') ?? 0),
            qwenSessions: Number(wrap?.getAttribute('data-office-qwen-sessions') ?? 0),
            deepseekLogoSkins: Number(wrap?.getAttribute('data-office-deepseek-logo-skins') ?? 0),
            deepseekSessions: Number(wrap?.getAttribute('data-office-deepseek-sessions') ?? 0),
            abstractLogoSkins: Number(wrap?.getAttribute('data-office-abstract-logo-skins') ?? 0),
            providerLogoBadges: Number(wrap?.getAttribute('data-office-provider-logo-badges') ?? 0),
            providerLogoTextureBadges: Number(wrap?.getAttribute('data-office-provider-logo-texture-badges') ?? 0),
            providerLogoWordmarkBadges: Number(wrap?.getAttribute('data-office-provider-logo-wordmark-badges') ?? 0),
            clickableWorkstations: Number(wrap?.getAttribute('data-office-clickable-workstations') ?? 0),
            clickableWalkers: Number(wrap?.getAttribute('data-office-clickable-walkers') ?? 0),
            selectedSession: wrap?.getAttribute('data-office-selected-session') ?? '',
            selectedWorkstations: Number(wrap?.getAttribute('data-office-selected-workstations') ?? 0),
            cameraPresets: Number(wrap?.getAttribute('data-office-camera-presets') ?? 0),
            activeCameraPreset: wrap?.getAttribute('data-office-active-camera-preset') ?? '',
            cameraPresetControls: Number(document.querySelector('.office-camera-strip')?.getAttribute('data-office-camera-preset-controls') ?? 0),
            selectionPanelSession: document.querySelector('.office-selection-panel')?.getAttribute('data-office-selection-panel') ?? '',
            workstationHitTargets: workstationHitTargets.length,
            walkerHitTargets: walkerHitTargets.length,
            opsBackplane: Number(wrap?.getAttribute('data-office-ops-backplane') ?? 0),
            dataTrunks: Number(wrap?.getAttribute('data-office-data-trunks') ?? 0),
            workstationBranches: Number(wrap?.getAttribute('data-office-workstation-branches') ?? 0),
            subjectFraming: Number(wrap?.getAttribute('data-office-subject-framing') ?? 0),
            office3dOptimizationComplete: Number(wrap?.getAttribute('data-office-3d-optimization-complete') ?? 0),
            vendorEmblemNodes: document.querySelectorAll('.office-vendor-emblem').length,
            sessionCalloutNodes: document.querySelectorAll('.office-session-callout').length,
            walkerFloorBadgeDomNodes: document.querySelectorAll('.office-walker-floor-badge').length
          }
        }),
      (value) =>
        value.sessions >= 5 &&
        value.completedSessions >= 3 &&
        value.waitingApprovalSessions >= 1 &&
        value.failedSessions >= 1 &&
        value.idleSessions + value.runningSessions + value.waitingApprovalSessions + value.completedSessions + value.failedSessions === value.sessions &&
        value.subagentPackets === 2 &&
        value.packets >= 3 &&
        value.walkers >= value.waitingApprovalSessions &&
        value.awaySessions >= value.waitingApprovalSessions &&
        value.deskRobots >= 1 &&
        value.deskRobots + value.awaySessions === value.sessions &&
        value.visibleRobots === value.sessions &&
        value.oneRobotPerAgent === 1 &&
        value.teaWalkers >= Math.min(value.idleSessions, 1) &&
        value.approvalWalkers >= Math.min(value.waitingApprovalSessions, 1) &&
        value.diningWalkers >= Math.min(value.completedSessions, 1) &&
        value.restroomWalkers >= Math.min(Math.max(value.completedSessions - 1, 0), 1) &&
        value.facilityWalkers === value.teaWalkers + value.restroomWalkers + value.diningWalkers &&
        value.walkers === value.approvalWalkers + value.facilityWalkers &&
        value.approvalStations === 1 &&
        value.hydrationStations === 1 &&
        value.restroomStations === 1 &&
        value.diningStations === 1 &&
        value.facilityFixtures >= 3 &&
        value.serviceWayfinding === 1 &&
        value.amenityPortals === 2 &&
        value.facilitySignals >= 4 &&
        value.clickableFacilities === 3 &&
        value.selectedFacility === '' &&
        value.facilityHitTargets === 3 &&
        value.facilityPanel === '' &&
        value.sideGlass === 1 &&
        value.architecturalLights === 1 &&
        value.workZoneGlass === 1 &&
        value.vendorEmblems === 1 &&
        value.deskFacingScreens === value.deskRobots &&
        value.operatorContactLinks === value.deskRobots * 2 &&
        value.screenFocusLinks === value.deskRobots * 2 &&
        value.deskStatusPlaques === value.deskRobots &&
        value.walkerFloorBadges === value.walkers &&
        value.workInputs === value.deskRobots &&
        value.operatorInputArrays === value.deskRobots &&
        value.serviceForegroundOccluders === 0 &&
        value.screenPanels >= value.sessions * 2 &&
        value.walkerRoutes === value.walkers &&
        value.sightlineSafe === 1 &&
        value.cutawayWalls === 1 &&
        value.overheadFixturesHidden === 1 &&
        value.sideGlassCutaway === 1 &&
        value.wallOccluders === 0 &&
        value.longLightOccluders === 0 &&
        value.presentationBackdrop === 1 &&
        value.industrialRobots === value.deskRobots + value.walkers &&
        value.humanoidRobotSilhouettes === value.sessions &&
        value.humanoidFaceVisors === value.sessions &&
        value.humanoidShellPanels >= value.sessions * 10 &&
        value.humanoidArticulatedJoints >= value.sessions * 8 &&
        value.humanoidBackShells === value.sessions &&
        value.humanoidNeutralShells === value.sessions &&
        value.faultBeacons === value.failedSessions &&
        value.maintenanceUnits === value.failedSessions &&
        value.diagnosticBeams === value.failedSessions * 2 &&
        value.faultResponseRigs === value.failedSessions &&
        value.faultHitTargets === value.failedSessions &&
        value.incidentCameraAvailable === 1 &&
        value.incidentCameraValid === 1 &&
        value.providerSkinPanels >= value.sessions &&
        value.realProviderLogoSkins >= value.sessions &&
        value.realProviderLogoAssets >= value.sessions &&
        value.realProviderLogoWordmarks >= value.sessions &&
        value.cnProviderLogoSkins >= value.detectedCnSessions &&
        value.cnProviderLogoAssets >= value.detectedCnSessions &&
        value.cnProviderLogoWordmarks >= value.detectedCnSessions &&
        value.detectedCnSessions >= value.sessions &&
        value.qwenLogoSkins >= value.qwenSessions &&
        value.qwenSessions >= 2 &&
        value.deepseekLogoSkins >= value.deepseekSessions &&
        value.deepseekSessions >= 1 &&
        value.abstractLogoSkins === 0 &&
        value.providerLogoBadges >= value.deskRobots * 3 + value.walkers * 2 &&
        value.providerLogoTextureBadges >= value.deskRobots * 3 + value.walkers * 2 &&
        value.providerLogoWordmarkBadges >= value.deskRobots * 2 + value.walkers &&
        value.clickableWorkstations === value.sessions &&
        value.clickableWalkers === value.walkers &&
        value.selectedSession.length > 0 &&
        value.selectedWorkstations === 1 &&
        value.cameraPresets === 4 &&
        value.activeCameraPreset === 'overview' &&
        value.cameraPresetControls === 4 &&
        value.selectionPanelSession === value.selectedSession &&
        value.workstationHitTargets === value.sessions &&
        value.walkerHitTargets === value.walkers &&
        value.opsBackplane === 1 &&
        value.dataTrunks === 1 &&
        value.workstationBranches >= value.sessions &&
        value.subjectFraming === 1 &&
        value.office3dOptimizationComplete === 1 &&
        value.vendorEmblemNodes === 0 &&
        value.sessionCalloutNodes === 0 &&
        value.walkerFloorBadgeDomNodes === 0,
      15_000,
      'waiting for office subagent packets'
    )
    report.officeSemanticAttrs = attrs
    assert(attrs.subagentPackets === 2, `wrong subagent packet count: ${JSON.stringify(attrs)}`)
    assert(
      attrs.sessions >= 5 &&
        attrs.completedSessions >= 3 &&
        attrs.waitingApprovalSessions >= 1 &&
        attrs.failedSessions >= 1 &&
        attrs.idleSessions + attrs.runningSessions + attrs.waitingApprovalSessions + attrs.completedSessions + attrs.failedSessions === attrs.sessions &&
        attrs.walkers >= attrs.waitingApprovalSessions &&
        attrs.awaySessions >= attrs.waitingApprovalSessions &&
        attrs.deskRobots >= 1 &&
        attrs.deskRobots + attrs.awaySessions === attrs.sessions &&
        attrs.visibleRobots === attrs.sessions &&
        attrs.oneRobotPerAgent === 1 &&
        attrs.teaWalkers >= Math.min(attrs.idleSessions, 1) &&
        attrs.approvalWalkers >= Math.min(attrs.waitingApprovalSessions, 1) &&
        attrs.diningWalkers >= Math.min(attrs.completedSessions, 1) &&
        attrs.restroomWalkers >= Math.min(Math.max(attrs.completedSessions - 1, 0), 1) &&
        attrs.facilityWalkers === attrs.teaWalkers + attrs.restroomWalkers + attrs.diningWalkers &&
        attrs.walkers === attrs.approvalWalkers + attrs.facilityWalkers &&
        attrs.approvalStations === 1 &&
        attrs.hydrationStations === 1 &&
        attrs.restroomStations === 1 &&
        attrs.diningStations === 1 &&
        attrs.facilityFixtures >= 3 &&
        attrs.serviceWayfinding === 1 &&
        attrs.amenityPortals === 2 &&
        attrs.facilitySignals >= 4 &&
        attrs.clickableFacilities === 3 &&
        attrs.selectedFacility === '' &&
        attrs.facilityHitTargets === 3 &&
        attrs.facilityPanel === '' &&
        attrs.sideGlass === 1 &&
        attrs.architecturalLights === 1 &&
        attrs.workZoneGlass === 1 &&
        attrs.vendorEmblems === 1 &&
        attrs.deskFacingScreens === attrs.deskRobots &&
        attrs.operatorContactLinks === attrs.deskRobots * 2 &&
        attrs.screenFocusLinks === attrs.deskRobots * 2 &&
        attrs.deskStatusPlaques === attrs.deskRobots &&
        attrs.walkerFloorBadges === attrs.walkers &&
        attrs.workInputs === attrs.deskRobots &&
        attrs.operatorInputArrays === attrs.deskRobots &&
        attrs.serviceForegroundOccluders === 0 &&
        attrs.screenPanels >= attrs.sessions * 2 &&
        attrs.walkerRoutes === attrs.walkers &&
        attrs.sightlineSafe === 1 &&
        attrs.cutawayWalls === 1 &&
        attrs.overheadFixturesHidden === 1 &&
        attrs.sideGlassCutaway === 1 &&
        attrs.wallOccluders === 0 &&
        attrs.longLightOccluders === 0 &&
        attrs.presentationBackdrop === 1 &&
        attrs.industrialRobots === attrs.deskRobots + attrs.walkers &&
        attrs.humanoidRobotSilhouettes === attrs.sessions &&
        attrs.humanoidFaceVisors === attrs.sessions &&
        attrs.humanoidShellPanels >= attrs.sessions * 10 &&
        attrs.humanoidArticulatedJoints >= attrs.sessions * 8 &&
        attrs.humanoidBackShells === attrs.sessions &&
        attrs.humanoidNeutralShells === attrs.sessions &&
        attrs.faultBeacons === attrs.failedSessions &&
        attrs.maintenanceUnits === attrs.failedSessions &&
        attrs.diagnosticBeams === attrs.failedSessions * 2 &&
        attrs.faultResponseRigs === attrs.failedSessions &&
        attrs.faultHitTargets === attrs.failedSessions &&
        attrs.incidentCameraAvailable === 1 &&
        attrs.incidentCameraValid === 1 &&
        attrs.providerSkinPanels >= attrs.sessions &&
        attrs.realProviderLogoSkins >= attrs.sessions &&
        attrs.realProviderLogoAssets >= attrs.sessions &&
        attrs.realProviderLogoWordmarks >= attrs.sessions &&
        attrs.cnProviderLogoSkins >= attrs.detectedCnSessions &&
        attrs.cnProviderLogoAssets >= attrs.detectedCnSessions &&
        attrs.cnProviderLogoWordmarks >= attrs.detectedCnSessions &&
        attrs.detectedCnSessions >= attrs.sessions &&
        attrs.qwenLogoSkins >= attrs.qwenSessions &&
        attrs.qwenSessions >= 2 &&
        attrs.deepseekLogoSkins >= attrs.deepseekSessions &&
        attrs.deepseekSessions >= 1 &&
        attrs.abstractLogoSkins === 0 &&
        attrs.providerLogoBadges >= attrs.deskRobots * 3 + attrs.walkers * 2 &&
        attrs.providerLogoTextureBadges >= attrs.deskRobots * 3 + attrs.walkers * 2 &&
        attrs.providerLogoWordmarkBadges >= attrs.deskRobots * 2 + attrs.walkers &&
        attrs.clickableWorkstations === attrs.sessions &&
        attrs.clickableWalkers === attrs.walkers &&
        attrs.selectedSession.length > 0 &&
        attrs.selectedWorkstations === 1 &&
        attrs.cameraPresets === 4 &&
        attrs.activeCameraPreset === 'overview' &&
        attrs.cameraPresetControls === 4 &&
        attrs.selectionPanelSession === attrs.selectedSession &&
        attrs.workstationHitTargets === attrs.sessions &&
        attrs.walkerHitTargets === attrs.walkers &&
        attrs.opsBackplane === 1 &&
        attrs.dataTrunks === 1 &&
        attrs.workstationBranches >= attrs.sessions &&
        attrs.subjectFraming === 1 &&
        attrs.office3dOptimizationComplete === 1 &&
        attrs.vendorEmblemNodes === 0 &&
        attrs.sessionCalloutNodes === 0 &&
        attrs.walkerFloorBadgeDomNodes === 0,
      `office semantic walkers missing: ${JSON.stringify(attrs)}`
    )
  })

  await check('3D office walking gait advances through distance-locked phases', async () => {
    await page.click('.office-camera-button:nth-child(1)')
    await waitForValue(
      () => page.evaluate(() => document.querySelector('.office-canvas-wrap')?.getAttribute('data-office-active-camera-preset') ?? ''),
      (value) => value === 'overview',
      5_000,
      'waiting for overview before walking gait frames'
    )
    await sleep(650)
    const frames = []
    for (let index = 0; index < 3; index += 1) {
      frames.push(await screenshot(page, `02-office-walking-phase-${index + 1}`))
      if (index < 2) await sleep(260)
    }
    const transitions = [comparePngFrames(frames[0], frames[1]), comparePngFrames(frames[1], frames[2])]
    assert(
      transitions.every((transition) => transition.changedRatio > 0.0004 && transition.changedRatio < 0.32),
      `walking frames must show controlled phase changes without a camera jump: ${JSON.stringify(transitions)}`
    )
    report.officeWalkingFrames = { frames, transitions }
  })

  await check('3D office camera presets switch without leaving the control room', async () => {
    await page.click('.office-camera-button:nth-child(3)')
    const facilities = await waitForValue(
      () => page.evaluate(() => document.querySelector('.office-canvas-wrap')?.getAttribute('data-office-active-camera-preset') ?? ''),
      (value) => value === 'facilities',
      5_000,
      'waiting for facilities camera preset'
    )
    await page.click('.office-camera-button:nth-child(4)')
    const incidents = await waitForValue(
      () =>
        page.evaluate(() => {
          const wrap = document.querySelector('.office-canvas-wrap')
          let faultTarget = null
          try {
            faultTarget = JSON.parse(wrap?.getAttribute('data-office-fault-hit-targets') || '[]')[0] || null
          } catch {
            faultTarget = null
          }
          return {
            preset: wrap?.getAttribute('data-office-active-camera-preset') ?? '',
            selected: wrap?.getAttribute('data-office-selected-session') ?? '',
            faultId: faultTarget?.id ?? '',
            available: Number(wrap?.getAttribute('data-office-incident-camera-available') ?? 0)
          }
        }),
      (value) => value.preset === 'incidents' && value.available === 1 && value.faultId && value.selected === value.faultId,
      5_000,
      'waiting for incidents camera preset'
    )
    await page.click('.office-camera-button:nth-child(2)')
    const agent = await waitForValue(
      () => page.evaluate(() => document.querySelector('.office-canvas-wrap')?.getAttribute('data-office-active-camera-preset') ?? ''),
      (value) => value === 'agent',
      5_000,
      'waiting for agent camera preset'
    )
    await page.click('.office-camera-button:nth-child(1)')
    const overview = await waitForValue(
      () => page.evaluate(() => document.querySelector('.office-canvas-wrap')?.getAttribute('data-office-active-camera-preset') ?? ''),
      (value) => value === 'overview',
      5_000,
      'waiting for overview camera preset'
    )
    report.officeCameraPresetSmoke = { facilities, incidents, agent, overview }
  })

  await check('3D office facilities can be selected from the canvas', async () => {
    await page.click('.office-camera-button:nth-child(3)')
    await waitForValue(
      () => page.evaluate(() => document.querySelector('.office-canvas-wrap')?.getAttribute('data-office-active-camera-preset') ?? ''),
      (value) => value === 'facilities',
      5_000,
      'waiting for facilities before facility object click'
    )
    await sleep(900)
    const facilityTarget = await page.evaluate(() => {
      const wrap = document.querySelector('.office-canvas-wrap')
      try {
        const targets = JSON.parse(wrap?.getAttribute('data-office-facility-hit-targets') || '[]')
        return targets.find((target) => target.id === 'dining') || targets[0] || null
      } catch {
        return null
      }
    })
    assert(facilityTarget?.id === 'dining', `missing dining facility target: ${JSON.stringify(facilityTarget)}`)
    const facilityClick = await clickProjectedOfficeTarget(page, facilityTarget, OFFICE_FACILITIES_CAMERA)
    const selectedFacility = await waitForValue(
      () =>
        page.evaluate((expected) => {
          const wrap = document.querySelector('.office-canvas-wrap')
          return {
            officeStillOpen: Boolean(wrap),
            selected: wrap?.getAttribute('data-office-selected-facility') ?? '',
            panel: document.querySelector('.office-facility-panel')?.getAttribute('data-office-facility-panel') ?? '',
            preset: wrap?.getAttribute('data-office-active-camera-preset') ?? '',
            expected
          }
        }, facilityTarget.id),
      (value) => value.officeStillOpen && value.selected === value.expected && value.panel === value.expected && value.preset === 'facilities',
      6_000,
      'waiting for real facility object click selection'
    )
    report.officeFacilityObjectClickSmoke = {
      id: facilityTarget.id,
      click: facilityClick,
      selected: selectedFacility.selected
    }
  })

  await check('3D office facility cameras show hydration, restroom, and dining zones', async () => {
    const screenshots = {}
    // Let staggered facility walkers clear the shared aisle before capturing acceptance evidence.
    await sleep(5_500)
    for (const key of ['hydration', 'restroom', 'dining']) {
      await page.click('.office-camera-button:nth-child(1)')
      await waitForValue(
        () => page.evaluate(() => document.querySelector('.office-canvas-wrap')?.getAttribute('data-office-active-camera-preset') ?? ''),
        (value) => value === 'overview',
        5_000,
        `waiting for overview before ${key} facility camera`
      )
      await page.click('.office-camera-button:nth-child(3)')
      await waitForValue(
        () => page.evaluate(() => document.querySelector('.office-canvas-wrap')?.getAttribute('data-office-active-camera-preset') ?? ''),
        (value) => value === 'facilities',
        5_000,
        `waiting for facilities camera before ${key}`
      )
      await sleep(900)
      const target = await page.evaluate((expected) => {
        const wrap = document.querySelector('.office-canvas-wrap')
        try {
          return JSON.parse(wrap?.getAttribute('data-office-facility-hit-targets') || '[]').find((item) => item.id === expected) || null
        } catch {
          return null
        }
      }, key)
      assert(target?.id === key, `missing ${key} facility target: ${JSON.stringify(target)}`)
      await clickProjectedOfficeTarget(page, target, OFFICE_FACILITIES_CAMERA)
      await waitForValue(
        () =>
          page.evaluate((expected) => {
            const wrap = document.querySelector('.office-canvas-wrap')
            return {
              selected: wrap?.getAttribute('data-office-selected-facility') ?? '',
              panel: document.querySelector('.office-facility-panel')?.getAttribute('data-office-facility-panel') ?? ''
            }
          }, key),
        (value) => value.selected === key && value.panel === key,
        6_000,
        `waiting for ${key} facility selection`
      )
      await sleep(1_200)
      screenshots[key] = await screenshot(page, `02-office-facility-${key}`)
    }
    report.officeFacilityScreenshots = screenshots
  })

  await check('3D office canvas objects select agents without leaving the control room', async () => {
    await page.click('.office-camera-button:nth-child(1)')
    await waitForValue(
      () => page.evaluate(() => document.querySelector('.office-canvas-wrap')?.getAttribute('data-office-active-camera-preset') ?? ''),
      (value) => value === 'overview',
      5_000,
      'waiting for overview before workstation object click'
    )
    await sleep(900)
    const clickPlan = await page.evaluate(() => {
      const wrap = document.querySelector('.office-canvas-wrap')
      const readTargets = (name) => {
        try {
          return JSON.parse(wrap?.getAttribute(name) || '[]')
        } catch {
          return []
        }
      }
      const selected = wrap?.getAttribute('data-office-selected-session') ?? ''
      const workstations = readTargets('data-office-workstation-hit-targets')
      const walkers = readTargets('data-office-walker-hit-targets')
      const walker = walkers[0] || null
      const facilityWalker =
        walkers.find((target) => target.reason === 'dining') ||
        walkers.find((target) => target.reason === 'restroom') ||
        walkers.find((target) => target.reason === 'tea') ||
        null
      const walkerSessionIds = new Set(walkers.map((target) => target.id))
      const workstationCandidates = workstations
        .filter((target) => target.id !== selected && !walkerSessionIds.has(target.id))
        .sort((a, b) => {
          const aScore = (a.x > 0 ? 10 : 0) + (a.z < -1 ? 6 : 0) + a.x * 0.1 - a.z * 0.02
          const bScore = (b.x > 0 ? 10 : 0) + (b.z < -1 ? 6 : 0) + b.x * 0.1 - b.z * 0.02
          return bScore - aScore
        })
      const workstation = workstationCandidates[0] || workstations.find((target) => target.id !== selected) || workstations[0] || null
      return {
        selected,
        workstation,
        walker,
        facilityWalker,
        workstationCount: workstations.length,
        walkerCount: walkers.length,
        facilityWalkerCount: walkers.filter((target) => target.reason !== 'approval').length
      }
    })
    assert(clickPlan.workstationCount >= 2, `expected multiple workstation hit targets: ${JSON.stringify(clickPlan)}`)
    assert(clickPlan.workstation?.id, `missing workstation click target: ${JSON.stringify(clickPlan)}`)
    assert(clickPlan.workstation.id !== clickPlan.selected, `workstation target did not change selection: ${JSON.stringify(clickPlan)}`)
    const workstationClick = await clickProjectedOfficeTarget(page, clickPlan.workstation, OFFICE_OVERVIEW_CAMERA)
    const selectedWorkstation = await waitForValue(
      () =>
        page.evaluate((expected) => {
          const wrap = document.querySelector('.office-canvas-wrap')
          return {
            officeStillOpen: Boolean(wrap),
            selected: wrap?.getAttribute('data-office-selected-session') ?? '',
            panel: document.querySelector('.office-selection-panel')?.getAttribute('data-office-selection-panel') ?? '',
            preset: wrap?.getAttribute('data-office-active-camera-preset') ?? '',
            expected
          }
        }, clickPlan.workstation.id),
      (value) => value.officeStillOpen && value.selected === value.expected && value.panel === value.expected && value.preset === 'agent',
      6_000,
      'waiting for real workstation object click selection'
    )
    await sleep(1_400)
    const focusedWorkstationScreenshot = await screenshot(page, '02-office-focused-workstation')
    report.officeFocusedWorkstation = {
      id: clickPlan.workstation.id,
      screenshot: focusedWorkstationScreenshot
    }

    assert(clickPlan.walkerCount >= 1, `expected walker hit target: ${JSON.stringify(clickPlan)}`)
    assert(clickPlan.walker?.id, `missing walker click target: ${JSON.stringify(clickPlan)}`)
    assert(clickPlan.walker.id !== clickPlan.workstation.id, `walker target should differ from workstation target: ${JSON.stringify(clickPlan)}`)
    await page.click('.office-camera-button:nth-child(3)')
    await waitForValue(
      () => page.evaluate(() => document.querySelector('.office-canvas-wrap')?.getAttribute('data-office-active-camera-preset') ?? ''),
      (value) => value === 'facilities',
      5_000,
      'waiting for facilities before walker object click'
    )
    await sleep(900)
    const walkerClick = await clickProjectedOfficeTarget(page, clickPlan.walker, OFFICE_FACILITIES_CAMERA)
    const selectedWalker = await waitForValue(
      () =>
        page.evaluate((expected) => {
          const wrap = document.querySelector('.office-canvas-wrap')
          return {
            officeStillOpen: Boolean(wrap),
            selected: wrap?.getAttribute('data-office-selected-session') ?? '',
            panel: document.querySelector('.office-selection-panel')?.getAttribute('data-office-selection-panel') ?? '',
            preset: wrap?.getAttribute('data-office-active-camera-preset') ?? '',
            expected
          }
        }, clickPlan.walker.id),
      (value) => value.officeStillOpen && value.selected === value.expected && value.panel === value.expected && value.preset === 'agent',
      6_000,
      'waiting for real walker object click selection'
    )

    assert(clickPlan.facilityWalkerCount >= 1, `expected non-approval facility walker: ${JSON.stringify(clickPlan)}`)
    assert(clickPlan.facilityWalker?.id, `missing facility walker click target: ${JSON.stringify(clickPlan)}`)
    assert(clickPlan.facilityWalker.reason !== 'approval', `facility walker should not be approval-only: ${JSON.stringify(clickPlan)}`)
    await page.click('.office-camera-button:nth-child(3)')
    await waitForValue(
      () => page.evaluate(() => document.querySelector('.office-canvas-wrap')?.getAttribute('data-office-active-camera-preset') ?? ''),
      (value) => value === 'facilities',
      5_000,
      'waiting for facilities before non-approval facility walker object click'
    )
    await sleep(900)
    const facilityWalkerClick = await clickProjectedOfficeTarget(page, clickPlan.facilityWalker, OFFICE_FACILITIES_CAMERA)
    const selectedFacilityWalker = await waitForValue(
      () =>
        page.evaluate((expected) => {
          const wrap = document.querySelector('.office-canvas-wrap')
          return {
            officeStillOpen: Boolean(wrap),
            selected: wrap?.getAttribute('data-office-selected-session') ?? '',
            panel: document.querySelector('.office-selection-panel')?.getAttribute('data-office-selection-panel') ?? '',
            preset: wrap?.getAttribute('data-office-active-camera-preset') ?? '',
            expected
          }
        }, clickPlan.facilityWalker.id),
      (value) => value.officeStillOpen && value.selected === value.expected && value.panel === value.expected && value.preset === 'agent',
      6_000,
      'waiting for real non-approval facility walker object click selection'
    )

    report.officeCanvasObjectClickSmoke = {
      before: clickPlan.selected,
      workstation: { id: clickPlan.workstation.id, click: workstationClick, selected: selectedWorkstation.selected },
      walker: { id: clickPlan.walker.id, reason: clickPlan.walker.reason, click: walkerClick, selected: selectedWalker.selected },
      facilityWalker: {
        id: clickPlan.facilityWalker.id,
        reason: clickPlan.facilityWalker.reason,
        click: facilityWalkerClick,
        selected: selectedFacilityWalker.selected
      }
    }
  })

  await check('3D office canvas renders nonblank with parent and child workstations', async () => {
    const stats = await waitForCanvasPixels(page)
    report.officeCanvas = stats
  })
  await check('3D office screenshot keeps robots visible without wall or light obstruction', async () => {
    await page.click('.office-camera-button:nth-child(1)')
    await waitForValue(
      () => page.evaluate(() => document.querySelector('.office-canvas-wrap')?.getAttribute('data-office-active-camera-preset') ?? ''),
      (value) => value === 'overview',
      5_000,
      'waiting for overview before office visibility screenshot'
    )
    await sleep(1_200)
    const file = await screenshot(page, '02-office-subagent-packets')
    const stats = analyzeOfficeScreenshot(file)
    report.officeScreenshot = stats
    assert(stats.width >= 1000 && stats.height >= 600, `office screenshot too small: ${JSON.stringify(stats)}`)
    assert(stats.scene.nonDarkRatio > 0.2, `office scene is too dark or blocked: ${JSON.stringify(stats.scene)}`)
    assert(stats.scene.brightRatio > 0.005, `office scene lacks visible highlights: ${JSON.stringify(stats.scene)}`)
    assert(stats.scene.coloredRatio > 0.009, `office scene lacks visible agents/zones: ${JSON.stringify(stats.scene)}`)
    assert(
      stats.leftSightline.darkRatio < 0.82 &&
        stats.leftSightline.uniqueColorBuckets >= 70 &&
        stats.leftSightline.coloredRatio > 0.004,
      `left sightline still looks wall-obstructed: ${JSON.stringify(stats.leftSightline)}`
    )
    assert(
      stats.centralWorkArea.nonDarkRatio > 0.18 && stats.centralWorkArea.coloredRatio > 0.008,
      `central office work area is not readable: ${JSON.stringify(stats.centralWorkArea)}`
    )
    assert(
      stats.robotWorkArea.nonDarkRatio > 0.35 &&
        stats.robotWorkArea.brightRatio > 0.015 &&
        stats.robotWorkArea.coloredRatio > 0.01,
      `robots and desk operator lights are not readable: ${JSON.stringify(stats.robotWorkArea)}`
    )
    assert(
      stats.nonErrorWorkArea.nonDarkRatio > 0.35 &&
        stats.nonErrorWorkArea.brightRatio > 0.015 &&
        stats.nonErrorWorkArea.coloredRatio > 0.009 &&
        stats.nonErrorWorkArea.redRatio < 0.02 &&
        stats.nonErrorWorkArea.cyanRatio < 0.35,
      `non-error office must stay readable and varied without red or cyan flooding: ${JSON.stringify(stats.nonErrorWorkArea)}`
    )
  })
  await check('3D office selected-agent control opens the matching session', async () => {
    const before = await page.evaluate(() => {
      const wrap = document.querySelector('.office-canvas-wrap')
      return {
        selected: wrap?.getAttribute('data-office-selected-session') ?? '',
        panel: document.querySelector('.office-selection-panel')?.getAttribute('data-office-selection-panel') ?? ''
      }
    })
    assert(before.selected && before.selected === before.panel, `selected panel mismatch before open: ${JSON.stringify(before)}`)
    await page.click('.office-selection-panel .btn-primary')
    const opened = await waitForValue(
      () =>
        page.evaluate((expected) => {
          return {
            officeGone: !document.querySelector('.office-canvas-wrap'),
            activeId: window.agentDesk ? null : null,
            body: document.body.innerText,
            expected
          }
        }, before.selected),
      (value) => value.officeGone && value.body.includes('A3 orchestration parent'),
      8_000,
      'waiting for selected office session to open'
    )
    report.officeSelectedSessionOpenSmoke = { selected: before.selected, officeGone: opened.officeGone }
  })
  await check('3D office light theme keeps silver robots readable', async () => {
    await page.evaluate(async () => {
      await window.agentDesk.updateSettings({ theme: 'light' })
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForAgentDesk(page)
    await waitForValue(
      () => page.evaluate(() => document.documentElement.getAttribute('data-theme') ?? ''),
      (value) => value === 'light',
      8_000,
      'waiting for light theme after reload'
    )
    await page.click('.sidebar-office')
    await page.waitForSelector('.office canvas', { timeout: 20_000 })
    await sleep(1_800)
    const file = await screenshot(page, '03-office-light-overview')
    const stats = analyzeOfficeScreenshot(file)
    report.officeLightScreenshot = stats
    assert(stats.width >= 1000 && stats.height >= 600, `light office screenshot too small: ${JSON.stringify(stats)}`)
    assert(stats.scene.nonDarkRatio > 0.55, `light office scene is too dark: ${JSON.stringify(stats.scene)}`)
    assert(stats.robotWorkArea.uniqueColorBuckets >= 80, `light office robots lack visual separation: ${JSON.stringify(stats.robotWorkArea)}`)
  })
} catch (error) {
  report.error = error instanceof Error ? error.stack || error.message : String(error)
  if (!report.checks.some((item) => item.status === 'fail')) {
    report.checks.push({
      name: 'orchestration mock e2e runtime',
      status: 'fail',
      durationMs: 0,
      error: error instanceof Error ? error.message : String(error)
    })
  }
  process.exitCode = 1
} finally {
  if (focusSession) await focusSession.detach().catch(() => undefined)
  if (browser) await browser.disconnect().catch(() => undefined)
  const exited = await terminate(app)
  await closeServer(mock.server)
  report.requests = mock.requests
  report.warnings.push(...summarizeProcessOutput(stdout, stderr, exited))
  writeFileSync(path.join(runDir, 'orchestration-mock-e2e.json'), JSON.stringify(report, null, 2))
  cleanupTempRoot(tempRoot)
}

const failed = report.checks.filter((item) => item.status === 'fail')
if (failed.length > 0) {
  console.error(`orchestration mock e2e failed: ${failed.map((item) => item.name).join(', ')}`)
  process.exitCode = 1
} else {
  console.log(`orchestration mock e2e ok: ${runDir}`)
}

async function check(name, fn) {
  const startedAt = Date.now()
  try {
    await fn()
    report.checks.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
  } catch (error) {
    report.checks.push({
      name,
      status: 'fail',
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}

async function screenshot(page, name) {
  const file = path.join(runDir, `${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  report.screenshots.push(file)
  return file
}

function comparePngFrames(firstFile, secondFile) {
  const first = PNG.sync.read(readFileSync(firstFile))
  const second = PNG.sync.read(readFileSync(secondFile))
  assert(first.width === second.width && first.height === second.height, 'walking gait frame dimensions must match')
  const x0 = Math.floor(first.width * 0.16)
  const x1 = Math.floor(first.width * 0.86)
  const y0 = Math.floor(first.height * 0.2)
  const y1 = Math.floor(first.height * 0.94)
  let total = 0
  let changed = 0
  let differenceSum = 0
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const offset = (y * first.width + x) * 4
      const difference =
        Math.abs(first.data[offset] - second.data[offset]) +
        Math.abs(first.data[offset + 1] - second.data[offset + 1]) +
        Math.abs(first.data[offset + 2] - second.data[offset + 2])
      total += 1
      differenceSum += difference
      if (difference > 24) changed += 1
    }
  }
  return {
    changedRatio: total > 0 ? changed / total : 0,
    meanChannelDifference: total > 0 ? differenceSum / (total * 3) : 0
  }
}

function analyzeOfficeScreenshot(file) {
  const png = PNG.sync.read(readFileSync(file))
  const width = png.width
  const height = png.height
  return {
    width,
    height,
    scene: analyzePngRegion(png, Math.floor(width * 0.2), Math.floor(height * 0.11), width, height),
    centralWorkArea: analyzePngRegion(
      png,
      Math.floor(width * 0.25),
      Math.floor(height * 0.18),
      Math.floor(width * 0.82),
      Math.floor(height * 0.94)
    ),
    robotWorkArea: analyzePngRegion(
      png,
      Math.floor(width * 0.25),
      Math.floor(height * 0.32),
      Math.floor(width * 0.73),
      Math.floor(height * 0.82)
    ),
    nonErrorWorkArea: analyzePngRegion(
      png,
      Math.floor(width * 0.25),
      Math.floor(height * 0.32),
      Math.floor(width * 0.7),
      Math.floor(height * 0.82)
    ),
    leftSightline: analyzePngRegion(
      png,
      0,
      Math.floor(height * 0.18),
      Math.floor(width * 0.36),
      Math.floor(height * 0.66)
    )
  }
}

function analyzePngRegion(png, x0, y0, x1, y1) {
  let total = 0
  let nonDarkPixels = 0
  let darkPixels = 0
  let brightPixels = 0
  let coloredPixels = 0
  let cyanPixels = 0
  let neutralPixels = 0
  let redPixels = 0
  let otherPalettePixels = 0
  const buckets = new Set()
  for (let y = Math.max(0, y0); y < Math.min(png.height, y1); y += 2) {
    for (let x = Math.max(0, x0); x < Math.min(png.width, x1); x += 2) {
      const i = (y * png.width + x) * 4
      const r = png.data[i]
      const g = png.data[i + 1]
      const b = png.data[i + 2]
      const a = png.data[i + 3]
      if (a < 20) continue
      const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722
      const channelSpread = Math.max(r, g, b) - Math.min(r, g, b)
      total += 1
      if (luminance > 24) nonDarkPixels += 1
      else darkPixels += 1
      if (luminance > 115) brightPixels += 1
      if (channelSpread > 28 && luminance > 35) coloredPixels += 1
      if (luminance > 24) {
        const isRed = r > 110 && r - g > 35 && r - b > 40
        const isCyan = b > 70 && g > 65 && b - r > 18 && g - r > 10
        if (isRed) redPixels += 1
        else if (isCyan) cyanPixels += 1
        else if (channelSpread <= 18) neutralPixels += 1
        else otherPalettePixels += 1
      }
      buckets.add(`${r >> 4},${g >> 4},${b >> 4}`)
    }
  }
  return {
    total,
    nonDarkPixels,
    darkPixels,
    brightPixels,
    coloredPixels,
    cyanPixels,
    neutralPixels,
    redPixels,
    otherPalettePixels,
    uniqueColorBuckets: buckets.size,
    nonDarkRatio: total > 0 ? nonDarkPixels / total : 0,
    darkRatio: total > 0 ? darkPixels / total : 1,
    brightRatio: total > 0 ? brightPixels / total : 0,
    coloredRatio: total > 0 ? coloredPixels / total : 0,
    cyanRatio: nonDarkPixels > 0 ? cyanPixels / nonDarkPixels : 0,
    neutralRatio: nonDarkPixels > 0 ? neutralPixels / nonDarkPixels : 0,
    redRatio: nonDarkPixels > 0 ? redPixels / nonDarkPixels : 1,
    cyanNeutralRatio: nonDarkPixels > 0 ? (cyanPixels + neutralPixels) / nonDarkPixels : 0
  }
}

async function startOpenAiMock() {
  const requests = []
  const server = http.createServer(async (req, res) => {
    if (req.url !== '/v1/responses' || req.method !== 'POST') {
      res.writeHead(404)
      res.end('not found')
      return
    }
    const body = await readJson(req)
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization || '', body })
    const text = JSON.stringify(body)
    if (text.includes('office approval e2e')) {
      writeFunctionCallResponse(res, {
        responseId: 'resp_office_approval_1',
        callId: 'call_office_approval',
        path: approvalFileName,
        content: `approval required ${runId}`
      })
      return
    }
    if (text.includes('office failure e2e')) {
      writeNonSwitchableError(res, officeFailureMessage)
      return
    }
    const reply = text.includes('子代理编排完成')
      ? 'Parent summary acknowledged both subagent results.'
      : text.includes('A3 child api')
        ? 'API child result: backend route implemented.'
        : text.includes('A3 child ui')
          ? 'UI child result: frontend panel implemented.'
          : 'Mock orchestration response.'
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    for (const piece of reply.match(/.{1,12}/g) || []) {
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: piece })}\n\n`)
      await sleep(15)
    }
    res.write(
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: `resp_orchestration_${Date.now()}`,
          output_text: reply,
          usage: {
            input_tokens: 41,
            output_tokens: 13,
            input_tokens_details: { cached_tokens: 3 }
          }
        }
      })}\n\n`
    )
    res.write('data: [DONE]\n\n')
    res.end()
  })
  const port = await findFreePort(8840)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return { server, port, requests }
}

function writeFunctionCallResponse(res, { responseId, callId, path: targetPath, content }) {
  const item = {
    type: 'function_call',
    call_id: callId,
    name: 'write_file',
    arguments: JSON.stringify({ path: targetPath, content })
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  res.write(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item })}\n\n`)
  res.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\n`)
  res.write(
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: responseId,
        usage: {
          input_tokens: 29,
          output_tokens: 6,
          input_tokens_details: { cached_tokens: 0 }
        }
      }
    })}\n\n`
  )
  res.write('data: [DONE]\n\n')
  res.end()
}

function writeNonSwitchableError(res, message) {
  const error = { message, type: 'office_mock_fault', code: 'office_mock_fault' }
  // The office fault-beacon fixture needs a deterministic product error state.
  // A 400 response is intentionally non-switchable, so provider failover cannot
  // turn this session back into a successful idle session.
  res.writeHead(400, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error }))
}

function writeMockUserData(port) {
  writeFileSync(
    path.join(userDataDir, 'providers.json'),
    JSON.stringify(
      [
        {
          id: 'mock-qwen',
          name: 'Qwen DashScope Mock',
          baseUrl: `http://127.0.0.1:${port}`,
          encryptedToken: `b64:${Buffer.from('mock-key').toString('base64')}`,
          models: ['qwen-plus'],
          openaiProtocol: 'responses',
          note: 'Local Qwen/DashScope office logo e2e provider; no real API key required.',
          createdAt: Date.now()
        },
        {
          id: 'mock-deepseek',
          name: 'DeepSeek Mock',
          baseUrl: `http://127.0.0.1:${port}`,
          encryptedToken: `b64:${Buffer.from('mock-key').toString('base64')}`,
          models: ['deepseek-reasoner'],
          openaiProtocol: 'responses',
          note: 'Local DeepSeek office logo e2e provider; no real API key required.',
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
        defaultModel: 'qwen-plus',
        defaultPermissionMode: 'default',
        defaultProviderId: 'mock-qwen',
        schedulerStrategy: 'balanced',
        budgetUsdPerSession: 0,
        failoverEnabled: true,
        language: 'zh',
        theme: 'dark',
        persona: '',
        allowedTools: '',
        disallowedTools: '',
        office: { showBadges: true, liveliness: 0.6, catEars: false }
      },
      null,
      2
    )
  )
}

async function clickProjectedOfficeTarget(page, target, camera) {
  const rect = await page.evaluate(() => {
    const canvas = document.querySelector('.office canvas')
    if (!canvas) return null
    const box = canvas.getBoundingClientRect()
    return {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height
    }
  })
  assert(rect && rect.width >= 300 && rect.height >= 200, `office canvas rect unavailable: ${JSON.stringify(rect)}`)
  const projected = projectOfficePoint(target, rect, camera)
  assert(
    projected.x >= rect.left &&
      projected.x <= rect.left + rect.width &&
      projected.y >= rect.top &&
      projected.y <= rect.top + rect.height,
    `projected office click outside canvas: ${JSON.stringify({ target, rect, projected })}`
  )
  const hit = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y)
    return {
      tag: element?.tagName ?? '',
      className: typeof element?.className === 'string' ? element.className : '',
      isCanvas: element?.tagName === 'CANVAS'
    }
  }, projected)
  assert(hit.isCanvas, `projected office click is covered before reaching canvas: ${JSON.stringify({ target, projected, hit })}`)
  await page.mouse.click(Math.round(projected.x), Math.round(projected.y))
  return {
    x: Math.round(projected.x),
    y: Math.round(projected.y),
    ndcX: Number(projected.ndcX.toFixed(3)),
    ndcY: Number(projected.ndcY.toFixed(3))
  }
}

function projectOfficePoint(target, rect, camera) {
  const position = camera.position
  const lookAt = camera.target
  const forward = normalize(subtract(lookAt, position))
  const worldUp = [0, 1, 0]
  const right = normalize(cross(forward, worldUp))
  const up = normalize(cross(right, forward))
  const relative = subtract([target.x, target.y, target.z], position)
  const depth = dot(relative, forward)
  assert(depth > 0.1, `office target is behind camera: ${JSON.stringify({ target, depth, camera })}`)
  const aspect = rect.width / rect.height
  const halfHeight = Math.tan((camera.fov * Math.PI) / 360) * depth
  const halfWidth = halfHeight * aspect
  const ndcX = dot(relative, right) / halfWidth
  const ndcY = dot(relative, up) / halfHeight
  return {
    x: rect.left + ((ndcX + 1) / 2) * rect.width,
    y: rect.top + ((1 - ndcY) / 2) * rect.height,
    ndcX,
    ndcY
  }
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}

async function waitForCanvasPixels(page, timeout = 15_000) {
  let lastStats = null
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    lastStats = await page.evaluate(() => {
      const canvas = document.querySelector('.office canvas')
      if (!canvas) return { canvas: false }
      const width = canvas.width
      const height = canvas.height
      const rect = canvas.getBoundingClientRect()
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
      if (!gl || width < 100 || height < 100 || rect.width < 300 || rect.height < 200) {
        return { canvas: true, gl: Boolean(gl), width, height, rectWidth: rect.width, rectHeight: rect.height, colorSum: 0, dataUrlLength: canvas.toDataURL('image/png').length }
      }
      const xs = [0.18, 0.33, 0.5, 0.67, 0.82]
      const ys = [0.2, 0.38, 0.55, 0.72, 0.88]
      const pixel = new Uint8Array(4)
      let colorSum = 0
      let alphaSum = 0
      let samples = 0
      for (const xRatio of xs) {
        for (const yRatio of ys) {
          const x = Math.max(0, Math.min(width - 1, Math.floor(width * xRatio)))
          const y = Math.max(0, Math.min(height - 1, Math.floor(height * yRatio)))
          gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
          colorSum += pixel[0] + pixel[1] + pixel[2]
          alphaSum += pixel[3]
          samples += 1
        }
      }
      return { canvas: true, gl: true, width, height, rectWidth: rect.width, rectHeight: rect.height, colorSum, alphaSum, samples, dataUrlLength: canvas.toDataURL('image/png').length }
    })
    if (
      lastStats?.canvas &&
      lastStats.gl &&
      lastStats.width >= 100 &&
      lastStats.height >= 100 &&
      lastStats.rectWidth >= 300 &&
      lastStats.rectHeight >= 200 &&
      ((lastStats.colorSum ?? 0) > 500 || (lastStats.dataUrlLength ?? 0) > 10_000)
    ) {
      return lastStats
    }
    await sleep(300)
  }
  throw new Error(`3D office canvas did not become visibly nonblank: ${JSON.stringify(lastStats)}`)
}

async function waitForAgentDesk(page) {
  await page.waitForFunction(() => typeof window.agentDesk?.createSession === 'function', { timeout: 15_000 })
}

async function waitForValue(producer, predicate, timeout, label) {
  const startedAt = Date.now()
  let last
  while (Date.now() - startedAt < timeout) {
    last = await producer()
    if (predicate(last)) return last
    await sleep(250)
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`)
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

async function waitForDebugPort(port, timeoutMs) {
  const startedAt = Date.now()
  let lastError
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return
      lastError = new Error(`HTTP ${res.status}`)
    } catch (error) {
      lastError = error
    }
    await sleep(200)
  }
  throw new Error(`Timed out waiting for CDP port ${port}: ${lastError?.message || lastError}`)
}

async function findFreePort(start) {
  for (let port = start; port < start + 200; port += 1) {
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

async function terminate(child) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode }
  child.kill('SIGTERM')
  const result = await Promise.race([
    new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
    sleep(3000).then(() => {
      child.kill('SIGKILL')
      return { code: child.exitCode, signal: child.signalCode ?? 'SIGKILL' }
    })
  ])
  return result
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve))
}

function summarizeProcessOutput(out, err, exited) {
  const warnings = []
  const stderrText = err.trim()
  if (stderrText) warnings.push(`[stderr tail]\n${stderrText.slice(-2000)}`)
  if (out.trim()) warnings.push(`[stdout tail]\n${out.trim().slice(-1000)}`)
  if (exited.signal) warnings.push(`Electron exited by signal ${exited.signal}`)
  return warnings
}

function cleanupTempRoot(root) {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // best effort
  }
}

function copyBuiltApp(targetOutDir) {
  rmSync(targetOutDir, { recursive: true, force: true })
  mkdirSync(targetOutDir, { recursive: true })
  for (const dirName of ['main', 'preload', 'renderer']) {
    cpSync(path.join(sourceOutDir, dirName), path.join(targetOutDir, dirName), { recursive: true })
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
