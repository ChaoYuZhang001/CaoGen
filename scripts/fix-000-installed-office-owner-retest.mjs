#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const puppeteer = require('puppeteer-core')
const JSZip = require('jszip')

const appExecutable = requiredPath('CAOGEN_INSTALLED_EXE')
const userDataDir = requiredPath('CAOGEN_USER_DATA_DIR')
const evidenceDir = requiredPath('CAOGEN_OWNER_EVIDENCE_DIR')
const workspaceName = process.env.CAOGEN_OFFICE_WORKSPACE_NAME || 'FIX-000 Office retest workspace'
const startedAt = new Date()
const runId = `${startedAt.toISOString().replace(/[:.]/g, '-')}-${process.pid}`
const outputRelativePath = `deliverables/fix-000-owner-${runId}.docx`
const report = {
  schemaVersion: 1,
  evidenceClass: 'fix_000_installed_office_owner_retest',
  status: 'failed',
  runId,
  startedAt: startedAt.toISOString(),
  appExecutableSha256: null,
  provider: null,
  canonical: null,
  session: null,
  office: null,
  aggregate: null,
  failure: null,
  privacy: 'No credential, Provider identity or URL, project path, Office path, prompt text, or user identity is emitted.'
}

mkdirSync(evidenceDir, { recursive: true })

let browser
let child
try {
  if (!existsSync(appExecutable)) throw new Error('installed CaoGen executable is missing')
  report.appExecutableSha256 = sha256File(appExecutable)

  const port = await availablePort()
  child = spawn(appExecutable, [`--remote-debugging-port=${port}`, '--enable-logging=stderr'], {
    cwd: path.dirname(appExecutable),
    env: { ...process.env, CAOGEN_USER_DATA_DIR: userDataDir, ELECTRON_ENABLE_LOGGING: '1' },
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.unref()

  await waitForDebugPort(child, port, 30_000)
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null })
  const page = await waitForRendererPage(browser, child, 30_000)

  const prepared = await page.evaluate(async ({ workspaceName, outputRelativePath, runId }) => {
    const desk = window.agentDesk
    const [settings, providers, projects, workspaces, workers] = await Promise.all([
      desk.getSettings(),
      desk.listProviders(),
      desk.listProjects(),
      desk.listProjectWorkspaces(),
      desk.listDigitalWorkers()
    ])
    const provider = providers.find((item) => item.id === settings.defaultProviderId)
    if (!provider) throw new Error('saved default Provider is unavailable')
    if (typeof settings.defaultModel !== 'string' || settings.defaultModel === 'auto') {
      throw new Error('saved default model is not concrete')
    }

    const discovery = await desk.fetchProviderModels({
      baseUrl: provider.baseUrl,
      providerId: provider.id,
      openaiProtocol: provider.openaiProtocol
    })
    if (!discovery.ok) throw new Error(`model discovery failed:${discovery.error?.kind || 'unknown'}`)

    const matching = workspaces.filter((item) => item.name === workspaceName && item.status === 'active')
    if (matching.length !== 1) throw new Error(`expected one active Office retest workspace, found ${matching.length}`)
    const workspace = matching[0]
    const directoryResources = workspace.resources.filter((item) => item.kind === 'directory')
    if (directoryResources.length !== 1) throw new Error('Office retest workspace must expose one directory resource')
    const projectPath = directoryResources[0].path
    const legacyProject = projects.find((item) => item.path === projectPath)
    if (!legacyProject) throw new Error('canonical workspace directory is not registered as a local Project')

    const goal = await desk.createProjectGoal({
      projectId: workspace.id,
      title: `FIX-000 installed Office verification ${runId}`,
      objective: 'Verify installed DOCX delivery and canonical ownership propagation.',
      successCriteria: ['DOCX artifact delivered', 'Run ownership preserved'],
      riskLevel: 'medium',
      forbiddenActions: ['Do not modify files other than the requested DOCX output.'],
      status: 'planned'
    })
    const workItem = await desk.createProjectWorkItem({
      projectId: workspace.id,
      goalId: goal.id,
      type: 'delivery',
      title: `FIX-000 installed DOCX delivery ${runId}`,
      description: 'Generate one structurally valid DOCX from the synthetic Owner retest source.',
      status: 'ready',
      acceptanceSpec: [
        { id: `${runId}-docx`, criterion: 'A structurally valid DOCX is delivered.', required: true },
        { id: `${runId}-ownership`, criterion: 'The Run retains canonical Project, Goal, and WorkItem ownership.', required: true }
      ]
    })
    const assignments = await desk.listDigitalWorkerAssignments({
      projectId: workspace.id,
      workItemId: workItem.id,
      includeHistory: true
    })
    if (assignments.length !== 0) throw new Error('fresh Office WorkItem unexpectedly inherited a Worker assignment')

    const prompt = [
      'Use the create_document tool exactly once.',
      `Create a real DOCX at ${outputRelativePath}.`,
      'Base it on README.md and include a title, a concise project summary, and three verification bullets.',
      'Do not create, edit, rename, or delete any other file.',
      'After the tool succeeds, respond with a short completion statement.'
    ].join(' ')
    const meta = await desk.createSession({
      cwd: projectPath,
      projectId: legacyProject.id,
      workspaceId: workspace.id,
      goalId: goal.id,
      workItemId: workItem.id,
      isolated: true,
      providerId: provider.id,
      model: settings.defaultModel,
      routingScope: 'fixed',
      initialPrompt: prompt,
      title: `FIX-000 installed Office owner retest ${runId}`
    })
    await desk.sendMessage(meta.id, prompt)
    return {
      provider: {
        modelCount: discovery.models.length,
        defaultModelConcrete: true,
        managedCredentialHeaderCount: Array.isArray(provider.credentialHeaderNames)
          ? provider.credentialHeaderNames.length
          : 0
      },
      workerCount: workers.length,
      workspaceId: workspace.id,
      goalId: goal.id,
      workItemId: workItem.id,
      sessionId: meta.id,
      sessionCwd: meta.cwd,
      ownership: {
        workspaceId: meta.workspaceId,
        goalId: meta.goalId,
        workItemId: meta.workItemId,
        isolated: meta.isolated === true
      }
    }
  }, { workspaceName, outputRelativePath, runId })

  report.provider = prepared.provider
  report.canonical = {
    workspaceCreated: false,
    goalCreated: Boolean(prepared.goalId),
    workItemCreated: Boolean(prepared.workItemId),
    freshWorkItemAssignmentCount: 0,
    retainedWorkerCount: prepared.workerCount
  }
  report.session = {
    created: Boolean(prepared.sessionId),
    isolated: prepared.ownership.isolated,
    workspaceOwnershipBound: prepared.ownership.workspaceId === prepared.workspaceId,
    goalOwnershipBound: prepared.ownership.goalId === prepared.goalId,
    workItemOwnershipBound: prepared.ownership.workItemId === prepared.workItemId,
    terminalStatus: null,
    turnResult: null,
    toolNames: [],
    toolErrorCount: null
  }

  const deadline = Date.now() + 180_000
  let terminal
  while (Date.now() < deadline) {
    terminal = await page.evaluate(async (sessionId) => {
      const desk = window.agentDesk
      const [metas, transcript] = await Promise.all([
        desk.listSessions(),
        desk.getTranscript(sessionId)
      ])
      const meta = metas.find((item) => item.id === sessionId)
      const events = transcript.map((entry) => entry.event ?? entry).filter(Boolean)
      const turnResult = events.findLast((event) => event.kind === 'turn-result')
      const toolNames = events.filter((event) => event.kind === 'tool-start').map((event) => event.name)
      const toolErrorCount = events.filter((event) => event.kind === 'tool-result' && event.isError === true).length
      return {
        status: meta?.status ?? 'missing',
        turnResult: turnResult ? { subtype: turnResult.subtype, isError: turnResult.isError === true } : null,
        toolNames,
        toolErrorCount,
        terminal: Boolean(meta && turnResult && (meta.status === 'idle' || meta.status === 'error' || meta.status === 'closed'))
      }
    }, prepared.sessionId)
    if (terminal.terminal) break
    await delay(1_000)
  }
  if (!terminal?.terminal) throw new Error('Office session did not reach a terminal turn within 180 seconds')
  report.session.terminalStatus = terminal.status
  report.session.turnResult = terminal.turnResult
  report.session.toolNames = terminal.toolNames
  report.session.toolErrorCount = terminal.toolErrorCount
  if (terminal.status !== 'idle' || terminal.turnResult?.isError) throw new Error('Office session did not finish successfully')
  if (terminal.toolNames.filter((name) => name === 'create_document').length !== 1) {
    throw new Error('Office session did not invoke create_document exactly once')
  }
  if (terminal.toolErrorCount !== 0) throw new Error('Office session reported a tool error')

  const outputPath = path.resolve(prepared.sessionCwd, outputRelativePath)
  if (!existsSync(outputPath)) throw new Error('Office DOCX output is missing')
  const outputBytes = readFileSync(outputPath)
  const archive = await JSZip.loadAsync(outputBytes, { checkCRC32: true })
  const requiredParts = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']
  const requiredPartsPresent = requiredParts.every((name) => archive.file(name) !== null)
  if (!requiredPartsPresent) throw new Error('Office DOCX is missing required OOXML parts')
  const documentXml = await archive.file('word/document.xml').async('string')
  if (!/<w:document\b/.test(documentXml) || !/<w:body\b/.test(documentXml)) {
    throw new Error('Office document.xml is not structurally valid')
  }
  report.office = {
    exists: true,
    size: statSync(outputPath).size,
    sha256: createHash('sha256').update(outputBytes).digest('hex'),
    zipEntryCount: Object.keys(archive.files).length,
    requiredPartsPresent,
    documentXmlValid: true
  }

  const aggregate = await page.evaluate(async ({ workspaceId, goalId, workItemId, sessionId }) => {
    const desk = window.agentDesk
    const [workItem, exported] = await Promise.all([
      desk.getProjectWorkItem(workItemId),
      desk.exportProjectWorkspaceData(workspaceId)
    ])
    const snapshot = exported.bundle.aggregate
    const runs = snapshot.workflow.runs.filter((item) => item.sessionId === sessionId)
    const run = runs.find((item) => item.workItemId === workItemId)
    const artifacts = snapshot.workflow.artifacts.filter((item) => item.workItemId === workItemId)
    const acceptances = snapshot.workflow.acceptances.filter((item) => item.workItemId === workItemId)
    const workflowEvidence = snapshot.workflow.workflowEvidence.filter((item) => item.workItemId === workItemId)
    const assignments = snapshot.assignments.filter((item) => item.workItemId === workItemId)
    return {
      aggregateExported: true,
      workItemRunRefCount: workItem?.runRefs?.length ?? 0,
      workItemArtifactRefCount: workItem?.artifactRefs?.length ?? 0,
      matchingRunCount: runs.length,
      runOwnership: run ? {
        projectMatches: run.projectId === workspaceId,
        goalMatches: run.goalId === goalId,
        workItemMatches: run.workItemId === workItemId
      } : null,
      runStatus: run?.status ?? null,
      artifactCount: artifacts.length,
      acceptanceStatuses: acceptances.map((item) => item.status),
      workflowEvidenceCount: workflowEvidence.length,
      assignmentCount: assignments.length
    }
  }, {
    workspaceId: prepared.workspaceId,
    goalId: prepared.goalId,
    workItemId: prepared.workItemId,
    sessionId: prepared.sessionId
  })
  report.aggregate = aggregate
  if (!aggregate.aggregateExported || aggregate.matchingRunCount !== 1) throw new Error('canonical aggregate did not retain one matching Run')
  if (!aggregate.runOwnership?.projectMatches || !aggregate.runOwnership.goalMatches || !aggregate.runOwnership.workItemMatches) {
    throw new Error('canonical Run ownership does not match the fresh Goal and WorkItem')
  }
  if (aggregate.runStatus !== 'completed') throw new Error(`canonical Run status is ${aggregate.runStatus || 'missing'}`)
  if (aggregate.artifactCount < 1 || aggregate.workItemArtifactRefCount < 1) throw new Error('Office Artifact was not attached to the WorkItem')
  if (!aggregate.acceptanceStatuses.includes('passed')) throw new Error('Office Acceptance did not pass')
  if (aggregate.workflowEvidenceCount < 1) throw new Error('Office delivery Evidence is missing')
  if (aggregate.assignmentCount !== 0) throw new Error('fresh Office WorkItem acquired an unexpected Worker assignment')

  report.status = 'passed'
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error)
} finally {
  if (browser) await browser.disconnect().catch(() => undefined)
  report.finishedAt = new Date().toISOString()
  report.durationMs = new Date(report.finishedAt).getTime() - startedAt.getTime()
  writeFileSync(path.join(evidenceDir, 'fix-000-installed-office-owner-retest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({
    status: report.status,
    appExecutableSha256: report.appExecutableSha256,
    provider: report.provider,
    canonical: report.canonical,
    session: report.session,
    office: report.office,
    aggregate: report.aggregate,
    failure: report.failure
  }, null, 2))
  if (report.status !== 'passed') process.exitCode = 1
}

function requiredPath(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return path.resolve(value)
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
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
  if (!port) throw new Error('failed to allocate a local DevTools port')
  return port
}

async function waitForDebugPort(processHandle, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error(`app exited before DevTools:${processHandle.exitCode}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
    } catch {}
    await delay(200)
  }
  throw new Error('installed app did not expose DevTools')
}

async function waitForRendererPage(browserHandle, processHandle, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error(`app exited before renderer:${processHandle.exitCode}`)
    for (const page of await browserHandle.pages()) {
      try {
        if (!/\/out\/renderer\/index\.html/.test(page.url())) continue
        const ready = await page.evaluate(() =>
          Boolean(document.querySelector('#root')?.children.length) &&
          document.body.innerText.trim().length > 0 &&
          typeof window.agentDesk === 'object')
        if (ready) return page
      } catch {}
    }
    await delay(200)
  }
  throw new Error('installed app did not create a usable renderer')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
