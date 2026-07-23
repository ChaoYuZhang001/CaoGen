#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const puppeteer = require('puppeteer-core')
const packageJson = require(path.join(repoRoot, 'package.json'))
const electronPackage = require('electron/package.json')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const outputRoot = path.join(repoRoot, 'test-results', 'project-workspace-lifecycle-ui')
const runDir = path.join(outputRoot, runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-project-lifecycle-ui-'))
const userDataDir = path.join(tempRoot, 'userData')
const directoryRoot = path.join(tempRoot, 'directory-resource')
const fileSetRoot = path.join(tempRoot, 'file-set-resource')
const repositoryRoot = path.join(tempRoot, 'repository-resource')
const sourceSentinel = path.join(repositoryRoot, 'source-must-survive.txt')
const sourceOutDir = path.join(repoRoot, 'out')
const isolatedOutDir = path.join(runDir, 'app', 'out')
const mainEntry = path.join(isolatedOutDir, 'main', 'index.js')
const electronBin = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')

const state = {
  projectId: '',
  projectName: 'Lifecycle Project Edited',
  goalId: '',
  workItemId: ''
}
const report = {
  schemaVersion: 1,
  runId,
  runDir,
  requirement: 'required',
  requirements: ['PROJ-001', 'PROJ-002', 'PROJ-004', 'WORK-004'],
  packageVersion: packageJson.version,
  gitCommit: '',
  worktreeClean: false,
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  electronVersion: electronPackage.version,
  checks: [],
  phases: [],
  screenshots: [],
  warnings: [],
  coverage: {
    verified: [
      'directory-free managed ProjectWorkspace creation through Studio UI',
      'directory, file_set, repository, and connector resource lifecycle',
      'project edit, archive, restore, export, soft delete, and permanent delete',
      'manifest digest and subordinate Goal/WorkItem inclusion',
      'WorkItem transition controls, owner-bound lease controls, and restart persistence',
      'source preservation and persistence across five Electron launches'
    ],
    explicitlyNotVerified: [
      'Artifact Graph and Evidence package completeness',
      'external connector deletion or remote repository mutation'
    ]
  }
}

prepareFixture()
assertBuildInputs()
copyBuiltApp()

let activeRuntime
try {
  await runPhase('create-edit-archive', async (page) => {
    await check('empty Studio exposes an accessible directory-free create flow', async () => {
      await page.waitForSelector('.pws-project-empty', { visible: true, timeout: 10_000 })
      await page.click('[data-studio-action="create-project"]')
      await page.waitForSelector('[data-studio-form="project"]', { visible: true, timeout: 5_000 })
      await page.type('[data-studio-form="project"] [name="projectName"]', 'Directory Free Lifecycle Project')
      await page.select('[data-studio-form="project"] [name="projectKind"]', 'research')
      await page.click('[data-studio-form="project"] button[type="submit"]')
      const project = await waitForProject(page, (candidate) => candidate.name === 'Directory Free Lifecycle Project')
      state.projectId = project.id
      assert(project.resources.length === 0, `new project unexpectedly has resources: ${project.resources.length}`)
      await waitForProjectStatus(page, 'active')
    })

    await check('resource form supports Escape without mutation', async () => {
      await page.click('[data-project-action="add-resource"]')
      await page.waitForSelector('[data-project-form="resource"]', { visible: true, timeout: 5_000 })
      await page.keyboard.press('Escape')
      await page.waitForSelector('[data-project-form="resource"]', { hidden: true, timeout: 5_000 })
      const project = await readProject(page, state.projectId)
      assert(project.resources.length === 0, 'Escape from resource form mutated project')
    })

    await check('all four Resource kinds persist with repository as a first-class kind', async () => {
      await addResource(page, 'directory', 'Working directory', directoryRoot, 1)
      await addResource(page, 'file_set', 'Design file set', fileSetRoot, 2)
      await addResource(page, 'repository', 'Source repository', repositoryRoot, 3)
      await addResource(page, 'connector', 'Issue connector', 'mock-connector://account/project', 4)
      const project = await readProject(page, state.projectId)
      assertProjectResource(project, 'directory', directoryRoot)
      assertProjectResource(project, 'file_set', fileSetRoot)
      assertProjectResource(project, 'repository', repositoryRoot)
      assertProjectResource(project, 'connector', 'mock-connector://account/project')
      assert(
        project.resources.find((resource) => resource.path === repositoryRoot)?.kind === 'repository',
        'repository was downgraded to a directory resource'
      )
    })

    await check('resource removal uses keyboard activation and preserves its source', async () => {
      const row = '[data-project-resource-kind="file_set"] [data-resource-action="remove"]'
      await page.focus(row)
      await page.keyboard.press('Enter')
      const project = await waitForProject(page, (candidate) => candidate.resources.length === 3)
      assert(!project.resources.some((resource) => resource.kind === 'file_set'), 'file_set resource still linked')
      assert(existsSync(fileSetRoot), 'removing a resource deleted its source directory')
    })
  })

  await runPhase('edit-controls-archive', async (page) => {
    await check('project edit and subordinate records persist before archive', async () => {
      await waitForEnabled(page, '[data-project-action="edit"]')
      await page.click('[data-project-action="edit"]')
      await page.waitForSelector('[data-project-form="edit"]', { visible: true, timeout: 5_000 })
      await replaceInput(page, '[data-project-form="edit"] [name="projectName"]', state.projectName)
      await page.select('[data-project-form="edit"] [name="projectKind"]', 'software')
      await page.type('[data-project-form="edit"] [name="projectOwnerId"]', 'owner-ui-e2e')
      await page.type('[data-project-form="edit"] [name="projectRulesRef"]', 'rules/project-ui.md')
      await page.click('[data-project-form="edit"] button[type="submit"]')
      const edited = await waitForProject(page, (candidate) => candidate.name === state.projectName)
      assert(edited.kind === 'software', `project kind did not update: ${edited.kind}`)
      assert(edited.ownerId === 'owner-ui-e2e', `owner did not update: ${edited.ownerId}`)
      assert(edited.rulesRef === 'rules/project-ui.md', `rulesRef did not update: ${edited.rulesRef}`)
      const subordinate = await page.evaluate(async (projectId) => {
        const goal = await window.agentDesk.createProjectGoal({
          projectId,
          title: 'Lifecycle goal',
          objective: 'Prove subordinate lifecycle retention'
        })
        const workItem = await window.agentDesk.createProjectWorkItem({
          projectId,
          goalId: goal.id,
          title: 'Lifecycle work item',
          type: 'testing',
          owner: { type: 'human', id: 'lifecycle-owner', displayName: 'Lifecycle Owner' }
        })
        return { goalId: goal.id, workItemId: workItem.id }
      }, state.projectId)
      state.goalId = subordinate.goalId
      state.workItemId = subordinate.workItemId
      await waitForEnabled(page, '[data-studio-action="refresh"]')
      await page.click('[data-studio-action="refresh"]')
      await page.waitForFunction(
        () => document.querySelector('[data-project-workspace-studio]')?.textContent?.includes('Lifecycle goal'),
        { timeout: 10_000 }
      )
    })

    await check('WorkItem controls enforce the state graph and owner-bound lease lifecycle', async () => {
      const row = `[data-work-item-id="${state.workItemId}"]`
      const controls = `${row} [data-work-item-controls]`
      await waitForEnabled(page, `${controls} [data-work-item-transition="ready"]`)
      await page.click(`${controls} [data-work-item-transition="ready"]`)
      await waitForWorkItemStatus(page, state.workItemId, 'ready')

      await waitForEnabled(page, `${controls} [data-work-item-lease="acquire"]`)
      await page.click(`${controls} [data-work-item-lease="acquire"]`)
      await waitForWorkItemLease(page, state.workItemId, true)
      await waitForEnabled(page, `${controls} [data-work-item-lease="renew"]`)
      await page.click(`${controls} [data-work-item-lease="renew"]`)
      await waitForWorkItemLease(page, state.workItemId, true)

      await waitForEnabled(page, `${controls} [data-work-item-transition="running"]`)
      await page.click(`${controls} [data-work-item-transition="running"]`)
      await waitForWorkItemStatus(page, state.workItemId, 'running')
      await waitForEnabled(page, `${controls} [data-work-item-transition="blocked"]`)
      await page.click(`${controls} [data-work-item-transition="blocked"]`)
      await waitForWorkItemStatus(page, state.workItemId, 'blocked')
      await waitForEnabled(page, `${controls} [data-work-item-transition="ready"]`)
      await page.click(`${controls} [data-work-item-transition="ready"]`)
      await waitForWorkItemStatus(page, state.workItemId, 'ready')

      await waitForEnabled(page, `${controls} [data-work-item-lease="release"]`)
      await page.click(`${controls} [data-work-item-lease="release"]`)
      await waitForWorkItemLease(page, state.workItemId, false)
      await waitForEnabled(page, `${controls} [data-work-item-transition="cancelled"]`)
      await page.click(`${controls} [data-work-item-transition="cancelled"]`)
      await waitForWorkItemStatus(page, state.workItemId, 'cancelled')
      const persisted = await page.evaluate((id) => window.agentDesk.getProjectWorkItem(id), state.workItemId)
      assert(persisted?.status === 'cancelled', `WorkItem control status did not persist: ${persisted?.status}`)
      assert(!persisted?.lease, 'terminal WorkItem retained an active lease')
      await screenshot(page, '02-work-item-controls')
    })

    await check('archive is visible and durable before first restart', async () => {
      await waitForEnabled(page, '[data-project-action="archive"]')
      await page.click('[data-project-action="archive"]')
      await waitForProjectStatus(page, 'archived')
      const project = await readProject(page, state.projectId)
      assert(project.status === 'archived', `archive status mismatch: ${project.status}`)
      await screenshot(page, '01-archived')
    })
  })

  await runPhase('restore-export-soft-delete', async (page) => {
    await check('archived project and formal repository kind survive restart', async () => {
      await waitForProjectStatus(page, 'archived')
      const project = await readProject(page, state.projectId)
      assert(project.name === state.projectName, `edited name lost after restart: ${project.name}`)
      assert(project.resources.some((resource) => resource.kind === 'repository'), 'repository kind lost after restart')
      assert(project.resources.length === 3, `resource count after restart: ${project.resources.length}`)
      const workItem = await page.evaluate((id) => window.agentDesk.getProjectWorkItem(id), state.workItemId)
      assert(workItem?.status === 'cancelled', `controlled WorkItem status lost after restart: ${workItem?.status}`)
      assert(!workItem?.lease, 'controlled WorkItem lease reappeared after restart')
    })

    await check('restore returns project contents to the active UI', async () => {
      await waitForEnabled(page, '[data-project-action="restore"]')
      await page.click('[data-project-action="restore"]')
      await waitForProjectStatus(page, 'active')
      await page.waitForFunction(
        () => document.querySelector('[data-project-workspace-studio]')?.textContent?.includes('Lifecycle goal'),
        { timeout: 10_000 }
      )
      const project = await readProject(page, state.projectId)
      assert(project.status === 'active', `restore status mismatch: ${project.status}`)
    })

    await check('manifest UI exposes a verified digest and subordinate aggregate', async () => {
      await waitForEnabled(page, '[data-project-action="export"]')
      await page.click('[data-project-action="export"]')
      await page.waitForSelector('[data-project-manifest]', { visible: true, timeout: 10_000 })
      const rendered = await page.evaluate(() => ({
        ariaModal: document.querySelector('[data-project-manifest]')?.getAttribute('aria-modal'),
        digest: document.querySelector('[data-manifest-digest]')?.textContent?.trim() || '',
        json: document.querySelector('[data-manifest-json]')?.value || ''
      }))
      assert(rendered.ariaModal === 'true', 'manifest dialog is missing aria-modal')
      assert(/^[a-f0-9]{64}$/.test(rendered.digest), `invalid rendered digest: ${rendered.digest}`)
      const manifest = JSON.parse(rendered.json)
      assert(manifest.digest === rendered.digest, 'rendered digest and JSON digest differ')
      assert(manifest.goals.some((goal) => goal.id === state.goalId), 'manifest omitted subordinate Goal')
      assert(manifest.workItems.some((item) => item.id === state.workItemId), 'manifest omitted subordinate WorkItem')
      assert(verifyManifestDigest(manifest), 'manifest SHA-256 digest verification failed')
      report.manifestDigest = rendered.digest
      await screenshot(page, '02-manifest-dialog')
      await page.keyboard.press('Escape')
      await page.waitForSelector('[data-project-manifest]', { hidden: true, timeout: 5_000 })
    })

    await check('soft-delete confirmation is keyboard dismissible and preserves sources', async () => {
      await waitForEnabled(page, '[data-project-action="soft-delete"]')
      await page.click('[data-project-action="soft-delete"]')
      await page.waitForSelector('[data-project-delete-dialog="soft"]', { visible: true, timeout: 5_000 })
      const warning = await page.$eval('[data-project-delete-dialog="soft"]', (dialog) => dialog.textContent || '')
      assert(warning.includes('不会被删除'), `source preservation warning missing: ${warning}`)
      await screenshot(page, '03-soft-delete-dialog')
      await page.keyboard.press('Escape')
      await page.waitForSelector('[data-project-delete-dialog="soft"]', { hidden: true, timeout: 5_000 })
      await waitForProjectStatus(page, 'active')
      await waitForEnabled(page, '[data-project-action="soft-delete"]')
      await confirmProjectDelete(page, 'soft', state.projectName)
      await waitForProjectStatus(page, 'deleted')
      assert(readFileSync(sourceSentinel, 'utf8') === 'preserve me\n', 'soft delete changed repository source')
      await screenshot(page, '04-soft-deleted')
    })
  })

  await runPhase('permanent-delete', async (page) => {
    await check('soft-deleted aggregate and sources survive restart', async () => {
      await waitForProjectStatus(page, 'deleted')
      const project = await readProject(page, state.projectId)
      assert(project.status === 'deleted', `deleted status lost: ${project.status}`)
      assert(project.resources.some((resource) => resource.kind === 'repository'), 'deleted aggregate lost repository')
      const subordinate = await page.evaluate(async ({ goalId, workItemId }) => ({
        goal: await window.agentDesk.getProjectGoal(goalId),
        workItem: await window.agentDesk.getProjectWorkItem(workItemId)
      }), state)
      assert(subordinate.goal?.id === state.goalId, 'soft delete removed Goal instead of retaining it')
      assert(subordinate.workItem?.id === state.workItemId, 'soft delete removed WorkItem instead of retaining it')
      assert(existsSync(directoryRoot) && existsSync(repositoryRoot), 'soft delete removed linked source paths')
    })

    await check('permanent delete requires exact project-name confirmation and cascades metadata only', async () => {
      await waitForEnabled(page, '[data-project-action="purge"]')
      await page.click('[data-project-action="purge"]')
      await page.waitForSelector('[data-project-delete-dialog="permanent"]', { visible: true, timeout: 5_000 })
      const disabled = await page.$eval('[data-project-delete-confirm]', (button) => button.disabled)
      assert(disabled === true, 'permanent delete confirmation started enabled')
      await screenshot(page, '05-permanent-delete-dialog')
      await replaceInput(page, '[name="projectDeleteConfirmation"]', state.projectName)
      await page.click('[data-project-delete-confirm]')
      await page.waitForSelector('.pws-project-empty', { visible: true, timeout: 10_000 })
      const removed = await page.evaluate(async ({ projectId, goalId, workItemId }) => ({
        project: await window.agentDesk.getProjectWorkspace(projectId),
        goal: await window.agentDesk.getProjectGoal(goalId),
        workItem: await window.agentDesk.getProjectWorkItem(workItemId),
        projects: await window.agentDesk.listProjectWorkspaces({ includeArchived: true, includeDeleted: true })
      }), state)
      assert(!removed.project && !removed.goal && !removed.workItem, 'permanent delete left subordinate metadata')
      assert(removed.projects.length === 0, `permanent delete left ${removed.projects.length} projects`)
      assert(readFileSync(sourceSentinel, 'utf8') === 'preserve me\n', 'permanent delete changed repository source')
      await screenshot(page, '06-permanently-deleted')
    })
  })

  await runPhase('post-delete-restart', async (page) => {
    await check('permanent deletion and source preservation survive final restart', async () => {
      await page.waitForSelector('.pws-project-empty', { visible: true, timeout: 10_000 })
      const projects = await page.evaluate(() => window.agentDesk.listProjectWorkspaces({ includeArchived: true, includeDeleted: true }))
      assert(projects.length === 0, `purged project reappeared after restart: ${projects.length}`)
      assert(existsSync(directoryRoot), 'directory resource source was deleted')
      assert(existsSync(fileSetRoot), 'removed file_set source was deleted')
      assert(existsSync(repositoryRoot), 'repository source was deleted')
      assert(readFileSync(sourceSentinel, 'utf8') === 'preserve me\n', 'final restart source sentinel mismatch')
      const persisted = JSON.parse(readFileSync(path.join(userDataDir, 'project-workspace.json'), 'utf8'))
      assert(!persisted.workspaces.some((workspace) => workspace.id === state.projectId),
        'purged Workspace entity remains in durable ProjectWorkspace state')
      assert(!persisted.goals.some((goal) => goal.projectId === state.projectId || goal.id === state.goalId),
        'purged Goal entity remains in durable ProjectWorkspace state')
      assert(!persisted.workItems.some((item) => item.projectId === state.projectId || item.id === state.workItemId),
        'purged WorkItem entity remains in durable ProjectWorkspace state')
      const tombstones = persisted.events.filter((event) => event.projectId === state.projectId)
      assert(
        tombstones.length === 1 &&
          tombstones[0].entityType === 'workspace' &&
          tombstones[0].entityId === state.projectId &&
          tombstones[0].kind === 'workspace.purged' &&
          tombstones[0].payload?.status === 'purged',
        `purge must retain exactly one durable Workspace identity tombstone: ${JSON.stringify(tombstones)}`
      )
      await screenshot(page, '07-empty-after-restart')
    })
  })
} catch (error) {
  report.error = error instanceof Error ? error.stack || error.message : String(error)
  process.exitCode = 1
  if (activeRuntime?.page) await screenshot(activeRuntime.page, 'failure').catch(() => undefined)
} finally {
  if (activeRuntime) await stopRuntime(activeRuntime)
  const git = readGitState()
  report.gitCommit = git.commit
  report.worktreeClean = git.worktreeClean
  report.releaseBinding = {
    requirement: report.requirement,
    packageVersion: report.packageVersion,
    git,
    platform: report.platform,
    arch: report.arch,
    nodeVersion: report.nodeVersion,
    electronVersion: report.electronVersion
  }
  report.status = report.checks.every((item) => item.status === 'pass') && !report.error ? 'pass' : 'fail'
  const body = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(runDir, 'report.json'), body)
  writeFileSync(path.join(outputRoot, 'latest.json'), body)
  cleanupTempRoot()
}

if (report.status === 'pass') {
  console.log(`project lifecycle UI E2E ok: ${runDir}`)
  console.log(`${report.checks.length}/${report.checks.length} checks passed across ${report.phases.length} Electron launches`)
} else {
  console.error(`project lifecycle UI E2E failed: ${report.error || 'check failure'}`)
}
process.exit(report.status === 'pass' ? 0 : 1)

async function runPhase(name, execute) {
  const startedAt = Date.now()
  activeRuntime = await launchRuntime(name)
  try {
    await enterStudio(activeRuntime.page)
    await execute(activeRuntime.page)
    report.phases.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
  } catch (error) {
    await screenshot(activeRuntime.page, `failure-${name}`).catch(() => undefined)
    report.phases.push({
      name,
      status: 'fail',
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  } finally {
    await stopRuntime(activeRuntime)
    activeRuntime = null
  }
}

async function launchRuntime(phase) {
  const port = await findFreePort(9940)
  const child = spawn(electronBin, [`--remote-debugging-port=${port}`, mainEntry], {
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
  const output = { stdout: '', stderr: '' }
  child.stdout.on('data', (chunk) => { output.stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => { output.stderr += chunk.toString() })
  try {
    await waitForDebugPort(port, 20_000)
    const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null })
    const page = await waitForElectronPage(browser, 20_000)
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        report.warnings.push(`${phase} console ${message.type()}: ${message.text()}`)
      }
    })
    page.on('pageerror', (error) => report.warnings.push(`${phase} pageerror: ${error.message}`))
    await page.setViewport({ width: 1320, height: 860, deviceScaleFactor: 1 })
    return { browser, child, output, page, phase }
  } catch (error) {
    await terminate(child)
    throw error
  }
}

async function stopRuntime(runtime) {
  const browserClosed = runtime.browser
    ? await Promise.race([
        runtime.browser.close().then(() => true).catch(() => false),
        sleep(3000).then(() => false)
      ])
    : false
  const cleanExit = browserClosed ? await waitForChildExit(runtime.child, 2500) : null
  const exited = cleanExit ?? await terminate(runtime.child)
  report.warnings.push(...summarizeProcessOutput(runtime.phase, runtime.output, exited))
}

async function enterStudio(page) {
  await page.waitForSelector('.app', { timeout: 20_000 })
  await page.waitForFunction(() => typeof window.agentDesk?.listProjectWorkspaces === 'function', { timeout: 15_000 })
  await page.click('[data-experience-mode-option="studio"]')
  await page.waitForSelector('[data-project-workspace-studio]', { visible: true, timeout: 15_000 })
  await page.waitForFunction(() => document.querySelector('[data-project-workspace-studio]')?.getAttribute('aria-busy') === 'false', { timeout: 15_000 })
}

async function check(name, execute) {
  const startedAt = Date.now()
  try {
    await execute()
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

async function addResource(page, kind, label, location, expectedCount) {
  await waitForEnabled(page, '[data-project-action="add-resource"]')
  await page.click('[data-project-action="add-resource"]')
  await page.waitForSelector('[data-project-form="resource"]', { visible: true, timeout: 5_000 })
  await page.select('[data-project-form="resource"] [name="resourceKind"]', kind)
  await page.type('[data-project-form="resource"] [name="resourceLabel"]', label)
  await page.type('[data-project-form="resource"] [name="resourceLocation"]', location)
  await page.click('[data-project-form="resource"] button[type="submit"]')
  await waitForProject(page, (project) => project.resources.length === expectedCount)
  await page.waitForSelector('[data-project-form="resource"]', { hidden: true, timeout: 5_000 })
}

async function confirmProjectDelete(page, mode, name) {
  if (!await page.$(`[data-project-delete-dialog="${mode}"]`)) {
    const action = mode === 'permanent' ? 'purge' : 'soft-delete'
    await page.click(`[data-project-action="${action}"]`)
  }
  await page.waitForSelector(`[data-project-delete-dialog="${mode}"]`, { visible: true, timeout: 5_000 })
  await replaceInput(page, '[name="projectDeleteConfirmation"]', name)
  await page.click('[data-project-delete-confirm]')
}

async function replaceInput(page, selector, value) {
  await page.$eval(selector, (input) => {
    input.focus()
    input.select()
  })
  await page.keyboard.type(value)
}

async function waitForProject(page, predicate) {
  return waitForValue(
    async () => {
      const candidates = state.projectId
        ? [await readProject(page, state.projectId)]
        : await page.evaluate(() => window.agentDesk.listProjectWorkspaces({ includeArchived: true, includeDeleted: true }))
      return candidates.find((project) => project && predicate(project))
    },
    Boolean,
    10_000,
    'waiting for ProjectWorkspace mutation'
  )
}

async function readProject(page, projectId) {
  return page.evaluate((id) => window.agentDesk.getProjectWorkspace(id), projectId)
}

async function waitForProjectStatus(page, status) {
  await page.waitForFunction(
    (expected) => document.querySelector('[data-project-lifecycle]')?.getAttribute('data-project-status') === expected,
    { timeout: 10_000 },
    status
  )
}

async function waitForWorkItemStatus(page, id, status) {
  await page.waitForFunction(
    ({ id: expectedId, status: expectedStatus }) => {
      const row = document.querySelector(`[data-work-item-id="${expectedId}"]`)
      return row?.getAttribute('data-status') === expectedStatus
    },
    { timeout: 10_000 },
    { id, status }
  )
}

async function waitForWorkItemLease(page, id, expected) {
  await page.waitForFunction(
    ({ id: expectedId, expected: expectedLease }) => {
      const row = document.querySelector(`[data-work-item-id="${expectedId}"]`)
      return Boolean(row?.querySelector('[data-work-item-lease-state="active"]')) === expectedLease
    },
    { timeout: 10_000 },
    { id, expected }
  )
}

async function waitForEnabled(page, selector) {
  await page.waitForFunction(
    (candidate) => {
      const element = document.querySelector(candidate)
      return element instanceof HTMLButtonElement && !element.disabled
    },
    { timeout: 10_000 },
    selector
  )
}

function assertProjectResource(project, kind, location) {
  const resource = project.resources.find((candidate) => candidate.kind === kind)
  assert(resource, `missing ${kind} resource`)
  assert((resource.path ?? resource.uri) === location, `${kind} location mismatch: ${resource.path ?? resource.uri}`)
}

function verifyManifestDigest(manifest) {
  const { digest, ...body } = manifest
  const actual = createHash('sha256').update(JSON.stringify(stableValue(body))).digest('hex')
  return actual === digest
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)])
    )
  }
  return value
}

async function screenshot(page, name) {
  const file = path.join(runDir, `${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  report.screenshots.push(file)
}

function prepareFixture() {
  mkdirSync(runDir, { recursive: true })
  mkdirSync(userDataDir, { recursive: true })
  for (const source of [directoryRoot, fileSetRoot, repositoryRoot]) mkdirSync(source, { recursive: true })
  writeFileSync(path.join(directoryRoot, 'directory.txt'), 'directory source\n')
  writeFileSync(path.join(fileSetRoot, 'files.txt'), 'file set source\n')
  writeFileSync(sourceSentinel, 'preserve me\n')
}

function assertBuildInputs() {
  assert(existsSync(electronBin), 'Electron binary not found. Run npm install first.')
  for (const entry of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
    assert(existsSync(path.join(sourceOutDir, entry)), `Built app entry missing: out/${entry}. Run npm run build first.`)
  }
}

function copyBuiltApp() {
  rmSync(isolatedOutDir, { recursive: true, force: true })
  mkdirSync(isolatedOutDir, { recursive: true })
  for (const directory of ['main', 'preload', 'renderer']) {
    cpSync(path.join(sourceOutDir, directory), path.join(isolatedOutDir, directory), { recursive: true })
  }
}

async function waitForElectronPage(browser, timeoutMs) {
  return waitForValue(
    async () => (await browser.pages()).find((candidate) => !candidate.url().startsWith('devtools://')),
    Boolean,
    timeoutMs,
    'waiting for Electron renderer page'
  )
}

async function waitForDebugPort(port, timeoutMs) {
  await waitForValue(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      return response.ok
    } catch {
      return false
    }
  }, Boolean, timeoutMs, `waiting for Electron debug port ${port}`)
}

async function waitForValue(producer, predicate, timeoutMs, label) {
  const startedAt = Date.now()
  let lastValue
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await producer()
    if (predicate(lastValue)) return lastValue
    await sleep(150)
  }
  throw new Error(`${label}: ${JSON.stringify(lastValue)}`)
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

async function terminate(child) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode }
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  child.kill('SIGTERM')
  const graceful = await Promise.race([exited, sleep(3000).then(() => null)])
  if (graceful) return graceful
  child.kill('SIGKILL')
  return Promise.race([
    exited,
    sleep(3000).then(() => ({ code: child.exitCode, signal: child.signalCode ?? 'SIGKILL' }))
  ])
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode }
  return Promise.race([
    new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
    sleep(timeoutMs).then(() => null)
  ])
}

function summarizeProcessOutput(phase, output, exited) {
  const warnings = []
  if (output.stderr.trim()) warnings.push(`${phase} [stderr tail]\n${output.stderr.trim().slice(-1200)}`)
  if (output.stdout.trim()) warnings.push(`${phase} [stdout tail]\n${output.stdout.trim().slice(-600)}`)
  if (exited.signal) warnings.push(`${phase} Electron exited by signal ${exited.signal}`)
  return warnings
}

function readGitState() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  return {
    commit,
    worktreeClean: status.length === 0,
    statusEntryCount: status ? status.split(/\r?\n/).length : 0
  }
}

function cleanupTempRoot() {
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup must not hide the test result.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
