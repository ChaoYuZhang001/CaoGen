#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnElectronTestProcess, terminateElectronTestProcess } from './lib/electron-test-process.mjs'
import { bindSourceEvidence, readSourceEvidenceState } from './lib/source-evidence-binding.mjs'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const electronBin = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const sourceOutDir = path.join(repoRoot, 'out')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'assistant-search-golden', runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-assistant-search-golden-'))
const userDataDir = path.join(tempRoot, 'userData')
const workspaceDir = path.join(tempRoot, 'workspace')
const isolatedOutDir = path.join(reportDir, 'app', 'out')
const mainEntry = path.join(isolatedOutDir, 'main', 'index.js')
const networkGuardPath = path.join(tempRoot, 'network-guard.cjs')
const sourceFixtureUrl = 'https://search-golden.invalid/source'
const sourceFixtureBody = '<html><title>Search Golden Source</title><body>Deterministic source material for Assistant evidence.</body></html>'
const sourceFixtureSummary = 'Search Golden Source Deterministic source material for Assistant evidence.'
const sourceFixtureSha256 = createHash('sha256').update(sourceFixtureBody).digest('hex')
const sourceFixtureCitation = `[${sourceFixtureUrl}] (sha256:${sourceFixtureSha256})`
const successOperationId = 'assistant-search-golden-success'
const projectFailureOperationId = 'assistant-search-golden-project-failure'
const projectFailureProjectId = 'assistant-search-golden-failure-project'
const projectFailureGoalId = 'assistant-search-golden-failure-goal'
const projectFailureWorkItemId = 'assistant-search-golden-failure-work-item'
const longProjectName = `Assistant project ${'long-name-'.repeat(24)}`
const longProviderName = `Assistant provider ${'long-provider-'.repeat(18)}`
const longModelName = `assistant-model-${'long-model-'.repeat(22)}`
const checks = []
const modelRequests = []
const searchRequests = []
const interactionEvidence = {
  followUp: false,
  copiedExactToolResult: false,
  exportedExactToolResult: false,
  boundedPickers: [],
  viewports: []
}
const failureEvidence = {}
const sourceEvidenceStart = readSourceEvidenceState(repoRoot)

for (const entry of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
  assert(existsSync(path.join(sourceOutDir, entry)), `Built app entry missing: out/${entry}. Run npm run build first.`)
}
mkdirSync(reportDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
mkdirSync(workspaceDir, { recursive: true })
writeFileSync(path.join(workspaceDir, 'README.md'), '# Assistant search golden workspace\n', 'utf8')
writeFileSync(networkGuardPath, networkGuardSource(sourceFixtureUrl, sourceFixtureBody), 'utf8')
copyBuiltApp()

const server = http.createServer(handleFixtureRequest)

async function handleFixtureRequest(request, response) {
  const body = await readBody(request)
  if (request.method === 'POST' && request.url === '/v1/responses') {
    return handleModelFixture(response, parseJson(body))
  }
  if (request.method === 'POST' && request.url === '/search') {
    return handleSearchFixture(response, parseJson(body))
  }
  response.writeHead(404).end('not found')
}

function handleModelFixture(response, payload) {
  modelRequests.push(payload)
  const prompt = responseInputText(payload?.input)
  if (hasFunctionCallOutput(payload?.input)) {
    return writeTextResponse(response, '联网研究结果已返回，可继续追问或导出。')
  }
  if (!prompt.includes('search golden')) return writeTextResponse(response, 'Assistant 首任务响应已完成。')
  const projectFailure = prompt.includes('search golden project-owned failure')
  const matchedFailure = /search failure (no_results|timeout|no_credentials|egress_denied|provider_failure|unknown_result)/.exec(prompt)?.[1]
  const failure = projectFailure ? 'provider_failure' : matchedFailure
  return writeFunctionCallResponse(response, `search-call-${modelRequests.length}`, 'web_search', {
    query: failure ? `search failure ${failure}` : 'search golden success',
    mode: failure === 'no_credentials' ? 'byok_search_adapter' : 'model_native',
    operationId: searchFixtureOperationId(projectFailure, failure),
    limit: 1
  })
}

function searchFixtureOperationId(projectFailure, failure) {
  if (projectFailure) return projectFailureOperationId
  return failure ? `assistant-search-golden-failure-${failure}` : successOperationId
}

function handleSearchFixture(response, payload) {
  const query = typeof payload?.query === 'string' ? payload.query : ''
  searchRequests.push({ query, mode: payload?.mode, operationId: payload?.operationId })
  const failure = query.match(/^search failure (no_results|timeout|no_credentials|egress_denied|provider_failure|unknown_result)$/)?.[1]
  if (failure) return writeSearchFailureFixture(response, failure)
  return json(response, 200, {
    status: 'success',
    results: [{ url: sourceFixtureUrl, title: 'Search Golden Fixture', summary: 'fixture snippet is advisory only' }]
  })
}

function writeSearchFailureFixture(response, failure) {
  if (failure === 'no_results') return json(response, 200, { status: 'success', results: [] })
  if (failure === 'timeout') return json(response, 200, { status: 'timeout', results: [], message: 'fixture timeout' })
  if (failure === 'egress_denied') {
    return json(response, 200, {
      status: 'success',
      results: [{ url: 'https://127.0.0.1/private', title: 'Blocked private source' }]
    })
  }
  if (failure === 'provider_failure') return json(response, 503, { error: 'fixture provider failure' })
  if (failure === 'unknown_result') return json(response, 200, { status: 'success' })
  return json(response, 500, { error: `unexpected adapter call for ${failure}` })
}

let serverBase = ''
let electron
let browser
let page
let assistantSearchContent = ''
let assistantSearchResult
let canonicalSearchFacts
let replaySearchResult
let replaySessionId = ''
let projectFailureSessionId = ''
let electronStdout = ''
let electronStderr = ''
try {
  await listen(server)
  serverBase = `http://127.0.0.1:${server.address().port}`
  writeFileSync(path.join(userDataDir, 'providers.json'), JSON.stringify([
    {
      id: 'assistant-search-golden', name: longProviderName, baseUrl: serverBase,
      encryptedToken: `b64:${Buffer.from('search-golden-token').toString('base64')}`,
      models: ['search-golden-model', longModelName], openaiProtocol: 'responses',
      credentialHeaderNames: ['Authorization'], createdAt: Date.now()
    },
    {
      id: 'assistant-search-disabled', name: `Unavailable ${longProviderName}`, baseUrl: serverBase,
      models: ['disabled-search-model'], openaiProtocol: 'responses',
      credentialHeaderNames: ['Authorization'], createdAt: Date.now() - 1
    }
  ], null, 2))
  writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify({
    defaultModel: 'search-golden-model', defaultProviderId: 'assistant-search-golden',
    language: 'zh', theme: 'dark', failoverEnabled: false, budgetUsdPerSession: 0
  }, null, 2))
  writeFileSync(path.join(userDataDir, 'projects.json'), JSON.stringify({
    schemaVersion: 1,
    projects: [
      { id: 'assistant-long-project', name: longProjectName, path: workspaceDir, lastUsedAt: Date.now() },
      { id: 'assistant-short-project', name: 'Short Assistant Project', path: path.join(tempRoot, 'short-project'), lastUsedAt: Date.now() - 1 }
    ]
  }, null, 2))
  ;({ electron, browser, page } = await launchElectronApp())
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
  // Session registry recovery runs during renderer bootstrap; wait for it before creating the fixture.
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  writeFileSync(path.join(reportDir, 'sessions-before-create.json'), JSON.stringify(await page.evaluate(() => window.agentDesk.listSessions()), null, 2))

  await check('Assistant Project picker stays inside both supported desktop viewports', async () => {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 960, height: 640 }]) {
      await page.setViewport({ ...viewport, deviceScaleFactor: 1 })
      const projectSelectorVisible = await page.$eval('.welcome-project-bar', (node) => !node.hidden)
      if (!projectSelectorVisible) await page.click('[data-welcome-project-trigger]')
      await assertBoundedMenu(page, '.welcome-bounded-select-project', viewport, 'Project')
      await page.screenshot({ path: path.join(reportDir, `bounded-project-${viewport.width}x${viewport.height}.png`) })
      await exerciseBoundedMenuKeyboard(page, '.welcome-bounded-select-project')
    }
    interactionEvidence.boundedPickers.push('project')
    interactionEvidence.viewports.push('1280x800', '960x640')
    await page.click('.welcome-bounded-select-project [data-bounded-select-trigger]')
    await page.keyboard.press('Home')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.welcome-project-bar', { hidden: true, timeout: 10_000 })
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
  })

  await page.waitForSelector('.welcome-composer-input', { visible: true, timeout: 15_000 })
  await page.type('.welcome-composer-input', 'search golden success')
  await page.click('.welcome-send')
  await page.waitForSelector('.composer-input', { visible: true, timeout: 20_000 })
  const session = await waitForValue(
    () => page.evaluate(() => window.agentDesk.listSessions().then((items) => items.find((item) => item.title === 'search golden success' || item.title === 'search golden success'.slice(0, 40)))),
    (item) => Boolean(item?.id),
    15_000,
    'waiting for Assistant search golden Session'
  )
  assert(session?.id, 'search golden Session was not created')

  await check('assistant_first_task_without_project', async () => {
    const transcript = await waitForValue(
      () => page.evaluate((id) => window.agentDesk.getTranscript(id), session.id),
      (entries) => entries.some((entry) => entry.event?.kind === 'turn-result'),
      30_000,
      'waiting for successful search turn'
    )
    const toolResult = transcript.find((entry) => entry.event?.kind === 'tool-result' && entry.event?.toolUseId?.startsWith('search-call-'))
    assert(toolResult, 'successful web_search tool result is missing')
    assistantSearchContent = toolResult.event.content
    try { assistantSearchResult = JSON.parse(assistantSearchContent) } catch { throw new Error(`web_search returned non-JSON content: ${String(assistantSearchContent).slice(0, 500)}`) }
    if (!assistantSearchResult.ok) throw new Error(`web_search success fixture failed: ${JSON.stringify(assistantSearchResult)}`)
    assertSearchSuccessContract(assistantSearchResult, { replay: false })
    assert.equal(assistantSearchResult.projectId, null)
    assert.equal(assistantSearchResult.goalId, null)
    assert.equal(assistantSearchResult.workItemId, null)
    assert.equal(assistantSearchResult.runId, null)
    assert.equal(assistantSearchResult.operationId, successOperationId)
    assert(assistantSearchResult.personalWorkspaceId, 'managed personal Workspace binding is missing')
    assert(assistantSearchResult.artifactId, 'personal search Artifact ID is missing')
    assert(assistantSearchResult.canonicalRunId, 'personal search canonical Run ID is missing')
    assert(assistantSearchResult.acceptanceId, 'personal search Acceptance ID is missing')
    assert.equal(session.unassigned, true)
    assert.equal(session.workspaceId, undefined)
    assert.equal(session.personalWorkspaceId, assistantSearchResult.personalWorkspaceId)
  })

  await check('search_broker_success_citation', async () => {
    await page.click('.tool-card .tool-header')
    await page.screenshot({ path: path.join(reportDir, 'search-success-debug.png') })
    writeFileSync(path.join(reportDir, 'search-success-debug.json'), JSON.stringify(await page.evaluate(() => ({
      active: [...document.querySelectorAll('[data-session-id]')].filter((node) => node.classList.contains('active') || node.getAttribute('aria-current') === 'true').map((node) => node.getAttribute('data-session-id')),
      sessionNodes: [...document.querySelectorAll('[data-session-id]')].map((node) => ({ id: node.getAttribute('data-session-id'), className: node.className, text: node.textContent?.slice(0, 120) })),
      cards: [...document.querySelectorAll('[data-search-result-status]')].map((node) => node.getAttribute('data-search-result-status')),
      body: document.body.innerText.slice(-2000)
    })), null, 2))
    await page.waitForSelector('.tool-search-result[data-search-result-status="success"]', { visible: true, timeout: 15_000 })
    const view = await page.$eval('.tool-search-result[data-search-result-status="success"]', (node) => ({
      text: node.textContent ?? '', copy: Boolean(node.querySelector('[data-search-result-copy]')),
      export: Boolean(node.querySelector('[data-search-result-export]')), raw: Boolean(node.querySelector('.tool-search-raw')),
      href: node.querySelector('.tool-search-citations a')?.href ?? '',
      fetchedAt: node.querySelector('.tool-search-citations time')?.getAttribute('datetime') ?? '',
      summary: node.querySelector('.tool-search-citations li > span')?.textContent ?? ''
    }))
    assert(view.text.includes('已找到已验证来源'), `success status missing: ${view.text}`)
    assert(view.text.includes('Evidence'), `Evidence label missing: ${view.text}`)
    assert(view.text.includes('sha256:'), `digest label missing: ${view.text}`)
    assert.equal(view.href, sourceFixtureUrl)
    assert.equal(view.summary, sourceFixtureSummary)
    assert.equal(view.fetchedAt, new Date(assistantSearchResult.fetchedAt).toISOString())
    assert(view.copy && view.export && view.raw, `result actions missing: ${JSON.stringify(view)}`)
  })

  await check('UX-GOLDEN-001 follow-up, copy and export use the visible Assistant result', async () => {
    await page.evaluate(() => {
      window.__assistantSearchCopied = ''
      window.__assistantSearchExportText = ''
      window.__assistantSearchExportName = ''
      let exportBlob
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (value) => { window.__assistantSearchCopied = value } }
      })
      URL.createObjectURL = (blob) => {
        exportBlob = blob
        return 'blob:assistant-search-golden'
      }
      URL.revokeObjectURL = () => undefined
      HTMLAnchorElement.prototype.click = function () {
        window.__assistantSearchExportName = this.download
        void exportBlob?.text().then((value) => { window.__assistantSearchExportText = value })
      }
    })
    await page.click('[data-search-result-copy]')
    await page.waitForFunction(() => document.querySelector('[data-search-result-copy]')?.textContent?.includes('已复制'))
    assert.equal(await page.evaluate(() => window.__assistantSearchCopied), assistantSearchContent)
    interactionEvidence.copiedExactToolResult = true

    await page.click('[data-search-result-export]')
    await page.waitForFunction(() => Boolean(window.__assistantSearchExportText))
    const exported = await page.evaluate(() => ({
      content: window.__assistantSearchExportText,
      name: window.__assistantSearchExportName
    }))
    assert.equal(exported.content, assistantSearchContent)
    assert.match(exported.name, /^caogen-search-.*\.json$/)
    interactionEvidence.exportedExactToolResult = true

    const before = await page.evaluate((id) => window.agentDesk.getTranscript(id).then((entries) => ({
      turns: entries.filter((entry) => entry.event?.kind === 'turn-result').length,
      users: entries.filter((entry) => entry.event?.kind === 'user-message').length
    })), session.id)
    await page.waitForSelector('.composer-input', { visible: true, timeout: 15_000 })
    await page.type('.composer-input', 'search golden follow up revision')
    await page.click('.composer-send')
    const after = await waitForValue(
      () => page.evaluate((id) => window.agentDesk.getTranscript(id).then((entries) => ({
        entries,
        turns: entries.filter((entry) => entry.event?.kind === 'turn-result').length,
        users: entries.filter((entry) => entry.event?.kind === 'user-message').length
      })), session.id),
      (value) => value.turns === before.turns + 1 && value.users === before.users + 1,
      30_000,
      'waiting for Assistant search follow-up'
    )
    assert(JSON.stringify(after.entries).includes('search golden follow up revision'), 'follow-up text is missing from the transcript')
    assert(JSON.stringify(after.entries).includes('可继续追问或导出'), 'follow-up result is missing from the transcript')
    interactionEvidence.followUp = true
  })

  await check('search_broker_artifact_evidence_binding', async () => {
    canonicalSearchFacts = await readCanonicalSearchFacts(page, assistantSearchResult)
    const { acceptance, artifact, evidence, goal, graph, run, workItem } = canonicalSearchFacts
    assert(run, 'personal search canonical Run cannot be read back')
    assert(artifact, 'personal search Artifact cannot be read back')
    assert(evidence, 'personal search Evidence cannot be read back')
    assert(acceptance, 'personal search Acceptance cannot be read back')
    assert(goal, 'personal search Goal cannot be read back')
    assert(workItem, 'personal search WorkItem cannot be read back')

    assert.equal(run.id, assistantSearchResult.canonicalRunId)
    assert.equal(run.projectId, assistantSearchResult.personalWorkspaceId)
    assert.equal(run.status, 'completed')
    assert.equal(artifact.id, assistantSearchResult.artifactId)
    assert.equal(artifact.projectId, assistantSearchResult.personalWorkspaceId)
    assert.equal(artifact.goalId, run.goalId)
    assert.equal(artifact.workItemId, run.workItemId)
    assert.equal(artifact.runId, assistantSearchResult.canonicalRunId)
    assert.equal(artifact.digest, expectedSearchArtifactDigest(assistantSearchResult))
    assert.equal(artifact.mediaType, 'application/json')
    assert.equal(artifact.metadata?.producer, 'caogen-search-broker')
    assert.equal(artifact.metadata?.operationId, successOperationId)
    assert.equal(graph.artifact.id, assistantSearchResult.artifactId)
    assert.equal(graph.artifact.digest, artifact.digest)
    assert(graph.locations.some((location) =>
      location.artifactId === artifact.id && location.kind === 'blob' &&
      location.availability === 'available' && location.checksum === artifact.digest),
    'personal search Artifact blob location is missing or has the wrong digest')

    const citation = assistantSearchResult.results[0]
    assert.equal(evidence.evidenceId, citation.evidenceId)
    assert.equal(evidence.artifactId, artifact.id)
    assert.equal(evidence.projectId, assistantSearchResult.personalWorkspaceId)
    assert.equal(evidence.goalId, run.goalId)
    assert.equal(evidence.workItemId, run.workItemId)
    assert.equal(evidence.runId, run.id)
    assert.equal(evidence.uri, citation.url)
    assert.equal(evidence.summary, citation.summary)
    assert.equal(evidence.observedAt, citation.fetchedAt)
    assert.equal(evidence.mediaType, 'text/plain')
    assert.equal(evidence.contentDigest, citation.contentSha256)
    assert.equal(evidence.metadata?.mode, assistantSearchResult.mode)
    assert.equal(evidence.metadata?.fetchedAt, citation.fetchedAt)
    assert.equal(evidence.metadata?.contentSha256, citation.contentSha256)
    assert.equal(evidence.metadata?.citation, citation.citation)

    assert.equal(acceptance.id, assistantSearchResult.acceptanceId)
    assert.equal(acceptance.projectId, assistantSearchResult.personalWorkspaceId)
    assert.equal(acceptance.goalId, run.goalId)
    assert.equal(acceptance.workItemId, run.workItemId)
    assert.equal(acceptance.status, 'passed')
    assert(acceptance.evidenceRefs.includes(citation.evidenceId), 'Acceptance does not reference the search Evidence')
    assert.equal(goal.id, run.goalId)
    assert.equal(goal.projectId, assistantSearchResult.personalWorkspaceId)
    assert.equal(goal.status, 'completed')
    assert.equal(goal.acceptanceResult?.status, 'passed')
    assert(goal.acceptanceResult?.evidenceRefs.includes(citation.evidenceId), 'Goal Acceptance lost the search Evidence')
    assert.equal(workItem.id, run.workItemId)
    assert.equal(workItem.projectId, assistantSearchResult.personalWorkspaceId)
    assert.equal(workItem.goalId, run.goalId)
    assert.equal(workItem.status, 'done')
    assert(workItem.runRefs.includes(run.id), 'canonical WorkItem does not reference the search Run')
    assert.equal(workItem.acceptance?.status, 'passed')
    assert(workItem.acceptance?.evidenceRefs.includes(citation.evidenceId), 'WorkItem Acceptance lost the search Evidence')
  })

  await check('search_broker_restart_duplicate_recovery', async () => {
    const requestsBeforeRestart = searchRequests.length
    browser.disconnect()
    browser = undefined
    await terminateElectronTestProcess(electron)
    electron = undefined
    page = undefined
    ;({ electron, browser, page } = await launchElectronApp())
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
    await new Promise((resolve) => setTimeout(resolve, 1_500))

    const recovered = await waitForValue(async () => {
      const [sessions, assistantTranscript, facts] = await Promise.all([
        page.evaluate(() => window.agentDesk.listSessions()),
        page.evaluate((id) => window.agentDesk.getTranscript(id), session.id),
        readCanonicalSearchFacts(page, assistantSearchResult)
      ])
      return {
        assistant: sessions.find((item) => item.id === session.id),
        assistantToolResults: assistantTranscript.filter((entry) => entry.event?.kind === 'tool-result'),
        ...facts
      }
    },
    (value) => Boolean(value.assistant && value.artifact && value.evidence && value.acceptance && value.goal && value.workItem),
    30_000,
    'waiting for Assistant search restart recovery')
    assert.equal(recovered.assistant.unassigned, true)
    assert.equal(recovered.assistant.personalWorkspaceId, assistantSearchResult.personalWorkspaceId)
    assert.equal(recovered.assistantToolResults.filter((entry) => String(entry.event?.content ?? '').includes(successOperationId)).length, 1)
    assert.equal(recovered.run.id, assistantSearchResult.canonicalRunId)
    assert.equal(recovered.artifact.id, assistantSearchResult.artifactId)
    assert.equal(recovered.artifact.digest, expectedSearchArtifactDigest(assistantSearchResult))
    assert.equal(recovered.evidence.evidenceId, assistantSearchResult.evidenceId)
    assert.equal(recovered.evidence.artifactId, assistantSearchResult.artifactId)
    assert.equal(recovered.evidence.metadata?.contentSha256, sourceFixtureSha256)
    assert.equal(recovered.acceptance.id, assistantSearchResult.acceptanceId)
    assert.equal(recovered.acceptance.status, 'passed')
    assert.equal(searchRequests.length, requestsBeforeRestart, 'Electron restart repeated a completed search request')

    const sessionIdsBeforeReplay = await page.evaluate(() => window.agentDesk.listSessions().then((items) => items.map((item) => item.id)))
    await page.click('.sidebar-new')
    await page.waitForSelector('.welcome-composer-input', { visible: true, timeout: 15_000 })
    await page.type('.welcome-composer-input', 'search golden replay')
    await page.click('.welcome-send')
    await page.waitForSelector('.composer-input', { visible: true, timeout: 20_000 })
    const replaySession = await waitForValue(async () => {
      const items = await page.evaluate(() => window.agentDesk.listSessions())
      return items.find((item) => !sessionIdsBeforeReplay.includes(item.id))
    }, (item) => Boolean(item?.id), 15_000, 'waiting for active replay Session')
    replaySessionId = replaySession.id
    const replayTranscript = await waitForValue(
      () => page.evaluate((id) => window.agentDesk.getTranscript(id), replaySession.id),
      (entries) => entries.some((entry) =>
        entry.event?.kind === 'tool-result' && String(entry.event?.content ?? '').includes(successOperationId)),
      30_000,
      'waiting for active idempotent search replay'
    )
    const replayToolResult = replayTranscript.find((entry) =>
      entry.event?.kind === 'tool-result' && String(entry.event?.content ?? '').includes(successOperationId))
    assert(replayToolResult, 'active replay tool result is missing')
    replaySearchResult = JSON.parse(replayToolResult.event.content)
    assertSearchSuccessContract(replaySearchResult, { replay: true })
    assert.equal(replaySession.unassigned, true)
    assert.equal(replaySearchResult.artifactId, assistantSearchResult.artifactId)
    assert.equal(replaySearchResult.canonicalRunId, assistantSearchResult.canonicalRunId)
    assert.equal(replaySearchResult.acceptanceId, assistantSearchResult.acceptanceId)
    assert.equal(replaySearchResult.evidenceId, assistantSearchResult.evidenceId)
    assert.equal(replaySearchResult.fetchedAt, assistantSearchResult.fetchedAt)
    assert.equal(searchRequests.length, requestsBeforeRestart, 'active idempotent replay issued a new search request')
    const replayFacts = await readCanonicalSearchFacts(page, replaySearchResult)
    assert.deepEqual(canonicalFactCounts(replayFacts), canonicalFactCounts(canonicalSearchFacts))
  })

  const failureStates = ['no_results', 'timeout', 'no_credentials', 'egress_denied', 'provider_failure', 'unknown_result']
  const renderedFailureStates = []
  const failureCardText = {}
  const failureSessionIds = []
  const personalFactsBeforeFailures = canonicalFactCounts(await readCanonicalSearchFacts(page, assistantSearchResult))
  for (const state of failureStates) {
    const sessionIdsBeforeCreate = await page.evaluate(() => window.agentDesk.listSessions().then((items) => items.map((item) => item.id)))
    await page.click('.sidebar-new')
    await page.waitForSelector('.welcome-composer-input', { visible: true, timeout: 15_000 })
    const prompt = `search golden search failure ${state}`
    await page.type('.welcome-composer-input', prompt)
    await page.click('.welcome-send')
    await page.waitForSelector('.composer-input', { visible: true, timeout: 20_000 })
    const failureSession = await waitForValue(
      async () => {
        const activeId = await page.$eval('.session-card.active', (node) => node.getAttribute('data-session-id')).catch(() => null)
        const items = await page.evaluate(() => window.agentDesk.listSessions())
        const created = items.find((item) => !sessionIdsBeforeCreate.includes(item.id))
        return created?.id === activeId ? created : created ?? (activeId ? items.find((item) => item.id === activeId) : undefined)
      },
      (item) => Boolean(item?.id),
      15_000,
      `waiting for failure Session ${state}`
    )
    failureSessionIds.push(failureSession.id)
    const transcript = await waitForValue(
      () => page.evaluate((id) => window.agentDesk.getTranscript(id), failureSession.id),
      (entries) => entries.some((entry) =>
        entry.event?.kind === 'tool-result' && String(entry.event?.content ?? '').includes(`assistant-search-golden-failure-${state}`)),
      30_000,
      `waiting for search failure ${state}`
    )
    const toolResult = transcript.find((entry) =>
      entry.event?.kind === 'tool-result' && String(entry.event?.content ?? '').includes(`assistant-search-golden-failure-${state}`))
    assert(toolResult, `search failure tool result is missing: ${state}`)
    const result = JSON.parse(toolResult.event.content)
    assertSearchFailureContract(result, state)
    await page.click('.tool-card .tool-header')
    const failureNode = await page.waitForSelector(`.tool-search-result[data-search-result-status="${state}"]`, { visible: true, timeout: 15_000 })
    failureCardText[state] = await failureNode.evaluate((element) => element.textContent ?? '')
    failureEvidence[state] = {
      sessionId: failureSession.id,
      result,
      visibleText: failureCardText[state]
    }
    renderedFailureStates.push(state)
  }
  await check('search_broker_explicit_failure_states', async () => {
    await waitForValue(
      () => renderedFailureStates,
      (statuses) => failureStates.every((status) => statuses.includes(status)),
      45_000,
      'waiting for six search failure cards'
    )
    const labels = {
      no_results: '没有找到来源',
      timeout: '搜索超时',
      no_credentials: '没有可用的搜索凭据',
      egress_denied: '外发请求被安全策略拒绝',
      provider_failure: '搜索服务失败',
      unknown_result: '搜索结果无法确认'
    }
    for (const status of failureStates) {
      const text = failureCardText[status]
      assert(text, `${status} result card missing`)
      assert(!text.includes('联网搜索完成'), `${status} was rendered as success`)
      assert(text.includes(labels[status]), `${status} visible failure label is missing: ${text}`)
      for (const [otherStatus, otherLabel] of Object.entries(labels)) {
        if (otherStatus !== status) assert(!text.includes(otherLabel), `${status} reused the ${otherStatus} failure label`)
      }
    }
    const personalFactsAfterFailures = canonicalFactCounts(await readCanonicalSearchFacts(page, assistantSearchResult))
    assert.deepEqual(personalFactsAfterFailures, personalFactsBeforeFailures,
      'failed Assistant searches created canonical Run/Artifact/Evidence/Acceptance facts')
  })

  await check('Project-owned failed search does not expose a dangling automatic Artifact ID', async () => {
    const projectSession = await page.evaluate(async ({ cwd, projectId, goalId, workItemId }) => {
      const project = await window.agentDesk.createProjectWorkspace({
        id: projectId,
        name: 'Assistant Search Failure Workspace',
        kind: 'research'
      })
      const goal = await window.agentDesk.createProjectGoal({
        id: goalId,
        projectId: project.id,
        title: 'Reject dangling search Artifact identity',
        objective: 'A failed Project-owned search must not claim a nonexistent Artifact',
        status: 'planned'
      })
      const workItem = await window.agentDesk.createProjectWorkItem({
        id: workItemId,
        projectId: project.id,
        goalId: goal.id,
        title: 'Exercise failed Project-owned search',
        type: 'research',
        status: 'ready'
      })
      return window.agentDesk.createSession({
        cwd,
        workspaceId: project.id,
        goalId: goal.id,
        workItemId: workItem.id,
        engine: 'openai',
        providerId: 'assistant-search-golden',
        model: 'search-golden-model',
        routingScope: 'fixed',
        permissionMode: 'default',
        isolated: false,
        title: 'Assistant Search Project Failure'
      })
    }, {
      cwd: workspaceDir,
      projectId: projectFailureProjectId,
      goalId: projectFailureGoalId,
      workItemId: projectFailureWorkItemId
    })
    assert(projectSession?.id, 'Project-owned failure Session was not created')
    projectFailureSessionId = projectSession.id
    await waitForValue(
      () => page.evaluate((id) => window.agentDesk.listSessions().then((items) => items.find((item) => item.id === id)), projectSession.id),
      (meta) => Boolean(meta?.sdkSessionId && meta.status === 'idle'),
      20_000,
      'waiting for Project-owned failure Session initialization'
    )
    const before = await readProjectFactCounts(page, projectFailureProjectId)
    const accepted = await page.evaluate((id) => window.agentDesk.sendMessage(id, {
      text: 'search golden project-owned failure',
      messageId: 'assistant-search-project-failure-message'
    }), projectSession.id)
    assert.equal(accepted, true, 'Project-owned failure search was not accepted')
    const transcript = await waitForValue(
      () => page.evaluate((id) => window.agentDesk.getTranscript(id), projectSession.id),
      (entries) => entries.some((entry) =>
        entry.event?.kind === 'tool-result' && String(entry.event?.content ?? '').includes(projectFailureOperationId)),
      30_000,
      'waiting for Project-owned failed search result'
    )
    const toolResult = transcript.find((entry) =>
      entry.event?.kind === 'tool-result' && String(entry.event?.content ?? '').includes(projectFailureOperationId))
    assert(toolResult, 'Project-owned failed search tool result is missing')
    const result = JSON.parse(toolResult.event.content)
    assertSearchFailureContract(result, 'provider_failure', { projectId: projectFailureProjectId })
    assert.equal(result.operationId, projectFailureOperationId)
    assert.equal(result.goalId, projectFailureGoalId)
    assert.equal(result.workItemId, projectFailureWorkItemId)
    assert(result.runId, 'Project-owned failure result lost its real Run')
    const after = await readProjectFactCounts(page, projectFailureProjectId)
    assert.equal(after.artifacts, before.artifacts, 'failed Project search created an Artifact')
    assert.equal(after.evidence, before.evidence, 'failed Project search created Evidence')
    assert.equal(after.acceptances, before.acceptances, 'failed Project search created a passed Acceptance')
  })

  await check('Search replay preserves one successful source fetch and canonical failure results', async () => {
    const resultCount = await page.evaluate(async ({ firstId, replayId, failureIds, projectFailureId }) => {
      const ids = [firstId, replayId, ...failureIds, projectFailureId]
      const transcripts = await Promise.all(ids.map((id) => window.agentDesk.getTranscript(id)))
      return transcripts.reduce((count, transcript) => count + transcript.filter((entry) => entry.event?.kind === 'tool-result' && entry.event?.toolUseId?.startsWith('search-call-')).length, 0)
    }, { firstId: session.id, replayId: replaySessionId, failureIds: failureSessionIds, projectFailureId: projectFailureSessionId })
    assert.equal(resultCount, 9, `expected 9 search tool results, got ${resultCount}`)
    assert.equal(searchRequests.filter((item) => item.query === 'search golden success').length, 1)
    // Successful searches require a continuation request; failure states may be
    // rendered as terminal tool results, so the fixture must not assume two
    // model calls for every scenario.
    assert(modelRequests.length >= 9, `model did not receive all nine search turns (${modelRequests.length})`)
  })

  const requiredGateIds = [
    'assistant_first_task_without_project',
    'search_broker_success_citation',
    'search_broker_explicit_failure_states',
    'search_broker_restart_duplicate_recovery',
    'search_broker_artifact_evidence_binding'
  ]
  const requiredGates = Object.fromEntries(requiredGateIds.map((gate) => {
    const evidence = checks.find((item) => item.name === gate)
    assert.equal(evidence?.status, 'pass', `SEARCH-001 required gate is not passed: ${gate}`)
    return [gate, { status: 'passed', check: evidence.name }]
  }))
  const report = {
    schemaVersion: 1, runId, gate: 'test:assistant-search-golden', status: 'passed',
    requirement: 'UX-GOLDEN-001 / SEARCH-001', classification: 'local_targeted_not_release',
    worktreeStatusCount: gitStatusCount(),
    checks, requiredGates, searchRequests, modelRequestCount: modelRequests.length,
    interactionEvidence,
    canonicalBinding: {
      personalWorkspaceId: assistantSearchResult.personalWorkspaceId,
      canonicalRunId: assistantSearchResult.canonicalRunId,
      artifactId: assistantSearchResult.artifactId,
      artifactDigest: canonicalSearchFacts.artifact.digest,
      evidenceId: assistantSearchResult.evidenceId,
      acceptanceId: assistantSearchResult.acceptanceId,
      activeReplay: replaySearchResult.idempotentReplay,
      activeReplayNetworkDelta: 0
    },
    failureEvidence,
    networkPolicy: 'loopback_and_in_process_source_fixture_only',
    explicitlyNotVerified: ['five-user timed acceptance', 'clean release SHA binding', 'commercial search account parity']
  }
  bindSourceEvidence(report, sourceEvidenceStart, readSourceEvidenceState(repoRoot), 'Assistant Search Electron Golden')
  assert.equal(report.provenance.status, 'pass', report.error)
  writeReport(report)
  console.log(`assistant search golden e2e: passed (${checks.length}/${checks.length})`)
  console.log(path.join(reportDir, 'report.json'))
} catch (error) {
  const report = { schemaVersion: 1, runId, gate: 'test:assistant-search-golden', status: 'failed', worktreeStatusCount: gitStatusCount(), checks, error: error instanceof Error ? error.message : String(error), tempRoot, electronStdout: electronStdout.slice(-8000), electronStderr: electronStderr.slice(-16000) }
  bindSourceEvidence(report, sourceEvidenceStart, readSourceEvidenceState(repoRoot), 'Assistant Search Electron Golden')
  writeReport(report)
  throw error
} finally {
  if (browser) browser.disconnect()
  if (electron) await terminateElectronTestProcess(electron)
  await close(server)
  if (process.env.CAOGEN_KEEP_ASSISTANT_SEARCH_FIXTURE !== '1') rmSync(tempRoot, { recursive: true, force: true })
}

async function check(name, fn) {
  const started = Date.now()
  try {
    await fn()
    checks.push({ name, status: 'pass', durationMs: Date.now() - started })
  } catch (error) {
    checks.push({ name, status: 'fail', error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started })
    throw error
  }
}

function assertSearchSuccessContract(result, { replay }) {
  assert.equal(result.ok, true)
  assert.equal(result.status, 'success')
  assert.equal(result.mode, 'model_native')
  assert.equal(result.operationId, successOperationId)
  assert.equal(result.idempotentReplay, replay)
  assert.equal(result.results.length, 1)
  assert.deepEqual(result.citations, result.results)
  const citation = result.results[0]
  assert.equal(citation.url, sourceFixtureUrl)
  assert.equal(citation.fetchedAt, result.fetchedAt)
  assert.equal(citation.summary, sourceFixtureSummary)
  assert.equal(citation.contentSha256, sourceFixtureSha256)
  assert.equal(citation.citation, sourceFixtureCitation)
  assert.equal(citation.evidenceId, result.evidenceId)
  assert.equal(citation.projectId, null)
  assert.equal(citation.goalId, null)
  assert.equal(citation.workItemId, null)
  assert.equal(citation.runId, null)
  assert(Number.isFinite(citation.fetchedAt) && citation.fetchedAt > 0, 'citation fetchedAt is invalid')
  assert(citation.evidenceId, 'citation Evidence ID is missing')
  assert.equal(result.url, citation.url)
  assert.equal(result.summary, citation.summary)
  assert.equal(result.contentSha256, citation.contentSha256)
  assert.equal(result.citation, citation.citation)
}

function assertSearchFailureContract(result, status, options = {}) {
  assert.equal(result.ok, false)
  assert.equal(result.status, status)
  assert.equal(result.mode, status === 'no_credentials' ? 'byok_search_adapter' : 'model_native')
  assert.equal(result.idempotentReplay, false)
  assert.deepEqual(result.results, [])
  assert.deepEqual(result.citations, [])
  assert.equal(result.projectId, options.projectId ?? null)
  if (!options.projectId) {
    assert.equal(result.goalId, null)
    assert.equal(result.workItemId, null)
    assert.equal(result.runId, null)
    assert(result.personalWorkspaceId, `${status} personal Workspace identity is missing`)
  }
  for (const key of ['artifactId', 'canonicalRunId', 'acceptanceId', 'url', 'fetchedAt', 'summary', 'contentSha256', 'citation', 'evidenceId']) {
    assert.equal(Object.prototype.hasOwnProperty.call(result, key), false, `${status} exposed success-only field ${key}`)
  }
}

function expectedSearchArtifactDigest(result) {
  const bytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    operationId: result.operationId,
    citations: result.results
  }, null, 2))
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function readCanonicalSearchFacts(targetPage, result) {
  return targetPage.evaluate(async ({ projectId, runId, artifactId, evidenceId, acceptanceId }) => {
    const [ledger, evidencePage, graph] = await Promise.all([
      window.agentDesk.listWorkflowLedger({ projectId, limit: 500 }),
      window.agentDesk.queryWorkflowEvidence({ projectId, limit: 500 }),
      window.agentDesk.queryWorkflowArtifactGraph(artifactId)
    ])
    const run = ledger.runs.items.find((item) => item.id === runId)
    const [goal, workItem] = await Promise.all([
      run?.goalId ? window.agentDesk.getProjectGoal(run.goalId) : Promise.resolve(undefined),
      run?.workItemId ? window.agentDesk.getProjectWorkItem(run.workItemId) : Promise.resolve(undefined)
    ])
    return {
      ledger,
      evidencePage,
      graph,
      run,
      goal,
      workItem,
      artifact: ledger.artifacts.items.find((item) => item.id === artifactId),
      evidence: evidencePage.items.find((item) => item.evidenceId === evidenceId),
      acceptance: ledger.acceptances.items.find((item) => item.id === acceptanceId)
    }
  }, {
    projectId: result.personalWorkspaceId,
    runId: result.canonicalRunId,
    artifactId: result.artifactId,
    evidenceId: result.evidenceId,
    acceptanceId: result.acceptanceId
  })
}

function canonicalFactCounts(facts) {
  return {
    goals: facts.ledger.goals.total,
    workItems: facts.ledger.workItems.total,
    runs: facts.ledger.runs.total,
    artifacts: facts.ledger.artifacts.total,
    evidence: facts.evidencePage.total,
    acceptances: facts.ledger.acceptances.total,
    passedAcceptances: facts.ledger.acceptances.items.filter((item) => item.status === 'passed').length
  }
}

async function readProjectFactCounts(targetPage, projectId) {
  return targetPage.evaluate(async (id) => {
    const [ledger, evidence] = await Promise.all([
      window.agentDesk.listWorkflowLedger({ projectId: id, limit: 500 }),
      window.agentDesk.queryWorkflowEvidence({ projectId: id, limit: 500 })
    ])
    return {
      artifacts: ledger.artifacts.total,
      evidence: evidence.total,
      acceptances: ledger.acceptances.total,
      passedAcceptances: ledger.acceptances.items.filter((item) => item.status === 'passed').length
    }
  }, projectId)
}

function writeReport(report) {
  mkdirSync(reportDir, { recursive: true })
  const output = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(reportDir, 'report.json'), output)
  writeFileSync(path.join(repoRoot, 'test-results', 'assistant-search-golden', 'latest.json'), output)
}

function copyBuiltApp() {
  rmSync(isolatedOutDir, { recursive: true, force: true })
  mkdirSync(isolatedOutDir, { recursive: true })
  for (const directory of ['main', 'preload', 'renderer']) cpSync(path.join(sourceOutDir, directory), path.join(isolatedOutDir, directory), { recursive: true })
}

function gitOutput(args) {
  try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim() } catch { return '' }
}

function gitStatusCount() {
  return gitOutput(['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean).length
}

function parseJson(body) {
  try { return JSON.parse(body.toString('utf8')) } catch { return null }
}

function hasFunctionCallOutput(input) {
  return Array.isArray(input) && input.some((item) => item && typeof item === 'object' && item.type === 'function_call_output')
}

function responseInputText(input) {
  if (!Array.isArray(input)) return typeof input === 'string' ? input : ''
  return input.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    if (typeof item.text === 'string') return [item.text]
    if (!Array.isArray(item.content)) return []
    return item.content.flatMap((part) => part && typeof part === 'object' && typeof part.text === 'string' ? [part.text] : [])
  }).join('\n')
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function writeTextResponse(response, text) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`)
  response.write(`data: ${JSON.stringify({ type: 'response.completed', response: { id: `search-response-${Date.now()}`, output_text: text, usage: { input_tokens: 12, output_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}\n\n`)
  response.end('data: [DONE]\n\n')
}

function writeFunctionCallResponse(response, callId, name, args) {
  const item = { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  response.write(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item })}\n\n`)
  response.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\n`)
  response.write(`data: ${JSON.stringify({ type: 'response.completed', response: { id: `search-tool-response-${Date.now()}`, usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 0 } } } })}\n\n`)
  response.end('data: [DONE]\n\n')
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

async function launchElectronApp() {
  const remotePort = await findFreePort(9960)
  const electronProcess = spawnElectronTestProcess(electronBin, [
    ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    `--remote-debugging-port=${remotePort}`,
    mainEntry
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAOGEN_USER_DATA_DIR: userDataDir,
      CAOGEN_MEMORY_DIR: path.join(tempRoot, 'memory'),
      CAOGEN_SEARCH_MODEL_NATIVE_URL: `${serverBase}/search`,
      CAOGEN_SEARCH_MODEL_NATIVE_API_KEY: '',
      CAOGEN_SEARCH_BYOK_URL: '',
      CAOGEN_SEARCH_BYOK_API_KEY: '',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      NODE_OPTIONS: nodeOptionsWithRequire(networkGuardPath)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  electronProcess.stdout?.on('data', (chunk) => { electronStdout += chunk.toString() })
  electronProcess.stderr?.on('data', (chunk) => { electronStderr += chunk.toString() })
  await waitForDebugPort(remotePort, 20_000)
  const connectedBrowser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${remotePort}`, defaultViewport: null })
  const rendererPage = await waitForElectronPage(connectedBrowser, 20_000)
  await rendererPage.waitForSelector('.app', { timeout: 20_000 })
  await rendererPage.waitForSelector('[data-experience-mode-switcher]', { visible: true, timeout: 15_000 })
  return { electron: electronProcess, browser: connectedBrowser, page: rendererPage }
}

async function assertBoundedMenu(targetPage, rootSelector, viewport, label) {
  const trigger = `${rootSelector} [data-bounded-select-trigger]`
  const menu = '[data-bounded-select-menu]'
  await targetPage.waitForSelector(trigger, { visible: true, timeout: 15_000 })
  await targetPage.click(trigger)
  await targetPage.waitForSelector(menu, { visible: true, timeout: 10_000 })
  const measurement = await targetPage.evaluate(({ triggerSelector, menuSelector }) => {
    const triggerNode = document.querySelector(triggerSelector)
    const menuNode = document.querySelector(menuSelector)
    if (!triggerNode || !menuNode) throw new Error('bounded select trigger/menu is missing')
    if (triggerNode.getAttribute('aria-controls') !== menuNode.id) {
      throw new Error('bounded select trigger is not associated with the visible listbox')
    }
    const rect = menuNode.getBoundingClientRect()
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
      options: menuNode.querySelectorAll('[data-bounded-select-option]').length,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    }
  }, { triggerSelector: trigger, menuSelector: menu })
  assert(measurement.options >= 2, `${label} bounded menu has too few options: ${JSON.stringify(measurement)}`)
  assert(measurement.left >= 11, `${label} menu crossed the left viewport edge: ${JSON.stringify(measurement)}`)
  assert(measurement.right <= viewport.width - 11, `${label} menu crossed the right viewport edge: ${JSON.stringify(measurement)}`)
  assert(measurement.top >= 11, `${label} menu crossed the top viewport edge: ${JSON.stringify(measurement)}`)
  assert(measurement.bottom <= viewport.height - 11, `${label} menu crossed the bottom viewport edge: ${JSON.stringify(measurement)}`)
  assert(measurement.documentWidth <= viewport.width + 1, `${label} menu caused document overflow: ${JSON.stringify(measurement)}`)
  assert.equal(measurement.viewportWidth, viewport.width)
  assert.equal(measurement.viewportHeight, viewport.height)
}

async function exerciseBoundedMenuKeyboard(targetPage, rootSelector) {
  const trigger = `${rootSelector} [data-bounded-select-trigger]`
  const menu = '[data-bounded-select-menu]'
  await targetPage.keyboard.press('End')
  await targetPage.keyboard.press('Home')
  const activeAfterHome = await targetPage.evaluate(() => ({
    disabled: document.activeElement?.getAttribute('aria-disabled'),
    option: document.activeElement?.getAttribute('data-bounded-select-option')
  }))
  assert(activeAfterHome.option, `Home did not focus an enabled option for ${rootSelector}`)
  assert.notEqual(activeAfterHome.disabled, 'true', `Home focused a disabled option for ${rootSelector}`)
  await targetPage.keyboard.press('ArrowDown')
  await targetPage.keyboard.press('Enter')
  await targetPage.waitForSelector(menu, { hidden: true, timeout: 10_000 })

  await targetPage.click(trigger)
  await targetPage.waitForSelector(menu, { visible: true, timeout: 10_000 })
  await targetPage.keyboard.press('ArrowDown')
  await targetPage.keyboard.press('Escape')
  await targetPage.waitForSelector(menu, { hidden: true, timeout: 10_000 })
  assert.equal(await targetPage.evaluate(() => document.activeElement?.hasAttribute('data-bounded-select-trigger')), true,
    `Escape did not restore trigger focus for ${rootSelector}`)

  await targetPage.click(trigger)
  await targetPage.waitForSelector(menu, { visible: true, timeout: 10_000 })
  await targetPage.click('.welcome-ask')
  await targetPage.waitForSelector(menu, { hidden: true, timeout: 10_000 })
}

async function waitForElectronPage(connectedBrowser, timeoutMs) {
  return waitForValue(async () => (await connectedBrowser.pages()).find((candidate) => candidate.url().startsWith('file:')), Boolean, timeoutMs, 'waiting for Electron renderer page')
}

async function waitForDebugPort(port, timeoutMs) {
  await waitForValue(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok } catch { return false }
  }, Boolean, timeoutMs, `waiting for Electron debug port ${port}`)
}

async function waitForValue(producer, predicate, timeoutMs, label) {
  const started = Date.now()
  let value
  while (Date.now() - started < timeoutMs) {
    value = await producer()
    if (predicate(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${label}: ${JSON.stringify(value)}`)
}

async function findFreePort(start) {
  for (let port = start; port < start + 200; port += 1) {
    try {
      const probe = http.createServer()
      await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve) })
      await new Promise((resolve) => probe.close(resolve))
      return port
    } catch { /* try next port */ }
  }
  throw new Error('no free Electron debug port')
}

function nodeOptionsWithRequire(preloadPath) {
  return `--require=${JSON.stringify(preloadPath)}`
}

function networkGuardSource(fixtureUrl, fixtureBody) {
  return `
const dnsPromises = require('node:dns/promises')
const originalLookup = dnsPromises.lookup.bind(dnsPromises)
const originalFetch = globalThis.fetch.bind(globalThis)
const fixture = ${JSON.stringify(fixtureUrl)}
const fixtureBody = ${JSON.stringify(fixtureBody)}
dnsPromises.lookup = async (hostname, options) => {
  if (hostname === 'search-golden.invalid') {
    const answer = { address: '93.184.216.34', family: 4 }
    return options && typeof options === 'object' && options.all ? [answer] : answer
  }
  return originalLookup(hostname, options)
}
globalThis.fetch = async (input, init) => {
  const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url)
  if (url.toString() === fixture) {
    return new Response(fixtureBody, {
      status: 200,
      headers: { 'content-type': 'text/html' }
    })
  }
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1') {
    return originalFetch(input, init)
  }
  throw new Error('Assistant Search Golden blocked non-fixture outbound request')
}
`
}
