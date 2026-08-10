#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'

const require = createRequire(import.meta.url)
const puppeteer = require('puppeteer-core')
const appExecutable = path.resolve(process.env.CAOGEN_INSTALLED_EXE || 'D:/app/CaoGen/CaoGen.exe')
const userDataDir = process.env.CAOGEN_USER_DATA_DIR || 'C:/Users/zhang/AppData/Roaming/CaoGen'
const reportDir = path.resolve(process.env.CAOGEN_FIRST_TASK_EVIDENCE_DIR || 'test-results/fix-000-first-task')
const projectStateDir = process.env.CAOGEN_PROJECT_STATE_DIR || ''
const prompt = '请只读列出当前项目根目录文件，并阅读 README 后用中文总结；不要修改、创建、删除或重命名任何文件。'
const startedAt = new Date()
const report = {
  schemaVersion: 1,
  evidenceClass: 'fix_000_installed_first_task_diagnostic',
  status: 'failed',
  appExecutable: 'D:/app/CaoGen/CaoGen.exe',
  appExecutableSha256: null,
  promptClass: 'read_only_project_listing_and_readme_summary',
  initial: null,
  modelDiscovery: null,
  session: null,
  events: [],
  final: null,
  projectMutation: null,
  failure: null,
  privacy: 'No credential, Provider URL, project path, or task text is emitted.'
}

mkdirSync(reportDir, { recursive: true })

try {
  if (!existsSync(appExecutable)) throw new Error('installed CaoGen executable is missing')
  report.appExecutableSha256 = sha256File(appExecutable)
  const initial = readRedactedState()
  report.initial = initial

  const port = await availablePort()
  const child = spawn(appExecutable, [`--remote-debugging-port=${port}`, '--enable-logging=stderr'], {
    cwd: path.dirname(appExecutable),
    env: { ...process.env, CAOGEN_USER_DATA_DIR: userDataDir, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-64 * 1024) })
  let browser
  try {
    await waitForDebugPort(child, port, 30_000)
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null })
    const page = await waitForRendererPage(browser, child, 30_000)
    const setup = await page.evaluate(async () => {
      const desk = window.agentDesk
      const settings = await desk.getSettings()
      const providers = await desk.listProviders()
      const projects = await desk.listProjects()
      const metas = await desk.listSessions()
      const provider = providers.find((item) => item.id === settings.defaultProviderId)
      if (!provider) throw new Error('the saved default Provider is unavailable')
      const discovery = await desk.fetchProviderModels({
        baseUrl: provider.baseUrl,
        providerId: provider.id,
        openaiProtocol: provider.openaiProtocol
      })
      const project = projects[0]
      if (!project?.path) throw new Error('no persisted project is available for the first-task diagnostic')
      return {
        settings: {
          defaultProviderPresent: Boolean(settings.defaultProviderId),
          defaultModelConcrete: typeof settings.defaultModel === 'string' && settings.defaultModel !== 'auto'
        },
        discovery: {
          ok: discovery.ok,
          modelCount: discovery.models.length,
          errorKind: discovery.error?.kind ?? null,
          httpStatus: discovery.error?.status ?? null,
          credentialHeaderNames: provider.credentialHeaderNames ?? []
        },
        projectCount: projects.length,
        previousSessionCount: metas.length,
        projectSelected: true,
        projectPath: project.path
      }
    })
    report.modelDiscovery = {
      ok: setup.discovery.ok,
      modelCount: setup.discovery.modelCount,
      errorKind: setup.discovery.errorKind,
      httpStatus: setup.discovery.httpStatus,
      managedCredentialHeaderCount: setup.discovery.credentialHeaderNames.length,
      authorizationHeaderDefaulted: setup.discovery.credentialHeaderNames
        .some((name) => name.toLowerCase() === 'authorization' || name.toLowerCase() === 'x-api-key')
    }
    if (!report.modelDiscovery.ok) {
      throw new Error(`default Provider model discovery failed: ${report.modelDiscovery.errorKind || 'unknown'} (${report.modelDiscovery.httpStatus || 'no-status'})`)
    }
    const projectGitBefore = gitUserStatus(setup.projectPath)
    const task = await page.evaluate(async ({ projectPath, taskPrompt }) => {
      const desk = window.agentDesk
      const meta = await desk.createSession({ cwd: projectPath, title: 'FIX-000 read-only first task' })
      await desk.sendMessage(meta.id, taskPrompt)
      return { sessionId: meta.id }
    }, { projectPath: setup.projectPath, taskPrompt: prompt })
    report.session = {
      created: true,
      sessionIdPresent: Boolean(task.sessionId),
      projectSelected: setup.projectSelected,
      defaultProviderPresent: setup.settings.defaultProviderPresent,
      defaultModelConcrete: setup.settings.defaultModelConcrete,
      previousSessionCount: setup.previousSessionCount,
      projectCount: setup.projectCount
    }
    const sessionId = task.sessionId
    const deadline = Date.now() + 120_000
    let lastTranscriptLength = 0
    while (Date.now() < deadline) {
      const metas = await page.evaluate(() => window.agentDesk.listSessions())
      const meta = metas.find((item) => item.id === sessionId)
      const transcript = await page.evaluate((id) => window.agentDesk.getTranscript(id), sessionId)
      lastTranscriptLength = transcript.length
      const compactEvents = transcript.map((entry) => ({
        kind: entry.kind,
        isError: entry.kind === 'tool-result' ? entry.isError : entry.kind === 'turn-result' ? entry.isError : undefined,
        toolName: entry.kind === 'tool-start' ? entry.name : undefined
      }))
      report.events = compactEvents.slice(-80)
      const terminalTurn = transcript.findLast((entry) => entry.event?.kind === 'turn-result')?.event
      if (meta && (meta.status === 'error' || meta.status === 'closed' || (meta.status === 'idle' && terminalTurn))) {
        report.final = {
          status: meta.status,
          model: meta.model,
          providerIdPresent: Boolean(meta.providerId),
          routingScope: meta.routingScope,
          engine: meta.engine,
          transcriptLength: transcript.length,
          lastErrorPresent: Boolean(meta.lastError),
          turnResult: terminalTurn
            ? { subtype: terminalTurn.subtype, isError: terminalTurn.isError }
            : null
        }
        break
      }
      await delay(1_000)
    }
    if (!report.final) throw new Error(`first-task did not reach a terminal state; transcriptLength=${lastTranscriptLength}`)
    const after = readRedactedState()
    report.projectMutation = compareGitState(projectGitBefore, gitUserStatus(setup.projectPath), after)
    if (report.final.status !== 'idle' || report.final.turnResult?.isError) {
      throw new Error(`first-task terminal status was ${report.final.status}`)
    }
    if (!report.projectMutation.zeroMutation) throw new Error('project state changed during read-only first task')
    if (stderr && /Uncaught Exception|Cannot find module|NODE_MODULE_VERSION/i.test(stderr)) throw new Error('packaged app emitted a main-process loading error')
    report.status = 'passed'
  } finally {
    if (browser) {
      for (const page of await browser.pages().catch(() => [])) await page.close({ runBeforeUnload: true }).catch(() => undefined)
      await browser.disconnect().catch(() => undefined)
    }
    stopChild(child)
  }
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error)
  report.final ??= { status: 'unknown' }
} finally {
  report.finishedAt = new Date().toISOString()
  writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({
    status: report.status,
    appExecutableSha256: report.appExecutableSha256,
    modelDiscovery: report.modelDiscovery,
    session: report.session,
    final: report.final,
    projectMutation: report.projectMutation,
    failure: report.failure
  }, null, 2))
  if (report.status !== 'passed') process.exitCode = 1
}

function readRedactedState() {
  const names = ['providers.json', 'settings.json', 'projects.json', 'sessions.json', 'active-sessions.json']
  const files = {}
  for (const name of names) {
    const file = path.join(userDataDir, name)
    const bytes = readFileSync(file)
    files[name] = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }
  const providers = JSON.parse(readFileSync(path.join(userDataDir, 'providers.json'), 'utf8'))
  const settings = JSON.parse(readFileSync(path.join(userDataDir, 'settings.json'), 'utf8'))
  const credentialEnvelopes = providers.flatMap((item) => [item.encryptedToken, ...(item.apiKeys || []).map((key) => key.encryptedToken)]).filter(Boolean)
  return {
    files,
    providerCount: providers.length,
    credentialCount: credentialEnvelopes.length,
    credentialEnvelopeAllEncrypted: credentialEnvelopes.every((value) => value.startsWith('enc:')),
    defaultProviderPresent: Boolean(settings.defaultProviderId),
    defaultModelConcrete: typeof settings.defaultModel === 'string' && settings.defaultModel !== 'auto'
  }
}

function compareGitState(before, after, redactedState) {
  return {
    available: before.available && after.available,
    beforeUserEntryCount: before.userEntryCount,
    afterUserEntryCount: after.userEntryCount,
    zeroMutation: before.available && after.available && before.fingerprint === after.fingerprint,
    credentialEnvelopeStillEncrypted: redactedState.credentialEnvelopeAllEncrypted
  }
}

function gitUserStatus(cwd) {
  try {
    const output = execFileSync('git', [
      '-c', `safe.directory=${cwd}`, '-C', cwd,
      'status', '--porcelain=v1', '-z', '--untracked-files=all'
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const userEntries = output.split('\0').filter(Boolean)
      .filter((entry) => !entry.slice(3).replaceAll('\\', '/').startsWith('.caogen/'))
      .sort()
    return {
      available: true,
      userEntryCount: userEntries.length,
      fingerprint: createHash('sha256').update(userEntries.join('\0')).digest('hex')
    }
  } catch {
    return { available: false, userEntryCount: null, fingerprint: null }
  }
}

function sha256File(file) { return createHash('sha256').update(readFileSync(file)).digest('hex') }
async function availablePort() { const server = createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port }
async function waitForDebugPort(child, port, timeoutMs) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (child.exitCode !== null) throw new Error(`app exited before DevTools: ${child.exitCode}`); try { const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) }); if (response.ok) return } catch {} await delay(200) } throw new Error('installed app did not expose DevTools') }
async function waitForRendererPage(browser, child, timeoutMs) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (child.exitCode !== null) throw new Error(`app exited before renderer: ${child.exitCode}`); for (const page of await browser.pages()) { try { if (!/\/out\/renderer\/index\.html/.test(page.url())) continue; const ready = await page.evaluate(() => document.querySelector('#root')?.children.length && document.body.innerText.trim().length && typeof window.agentDesk === 'object'); if (ready) return page } catch {} } await delay(200) } throw new Error('installed app did not create a usable renderer') }
function stopChild(child) { if (!child || child.exitCode !== null) return; spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }) }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
