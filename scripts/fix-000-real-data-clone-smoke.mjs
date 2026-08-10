#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
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
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const puppeteer = require('puppeteer-core')
const appExecutable = path.resolve(repoRoot, argValue('--app') || 'dist/win-unpacked/CaoGen.exe')
const sourceUserData = path.resolve(argValue('--source-user-data') || path.join(process.env.APPDATA || '', 'CaoGen'))
const sourceDatabase = path.join(sourceUserData, 'task-snapshots.db')
const sourceMigrationRoot = path.join(sourceUserData, 'backups', 'workflow-ledger')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'fix-000-real-data-clone-smoke', runId)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-fix000-ledger-clone-'))
const cloneUserData = path.join(tempRoot, 'userData')
const cloneDatabase = path.join(cloneUserData, 'task-snapshots.db')
const cloneMigrationRoot = path.join(cloneUserData, 'backups', 'workflow-ledger')

const preservedTables = [
  'task_runs',
  'task_snapshots',
  'workflow_acceptances',
  'workflow_artifact_edges',
  'workflow_artifact_locations',
  'workflow_artifacts',
  'workflow_events',
  'workflow_evidence_links',
  'workflow_goals',
  'workflow_recovery_sessions',
  'workflow_runs',
  'workflow_work_items'
]
const conversationTables = [
  'conversation_ledger_streams',
  'conversation_ledger_generations',
  'conversation_ledger_events'
]

const report = {
  status: 'failed',
  evidenceClass: 'fix_000_real_data_clone_diagnostic',
  mutatesSourceUserData: false,
  runId,
  artifact: { executableSha256: null },
  privacy: {
    providerCredentialsCopied: false,
    providerUrlsCopied: false,
    projectRecordsCopied: false,
    sessionRecordsCopied: false,
    sourcePathReported: false
  },
  source: { fingerprintBefore: null, fingerprintAfter: null, unchanged: false },
  clone: {
    sourceFilesCopied: 0,
    journalReboundForClone: false,
    preMigrationVersion: null,
    postMigrationVersion: null,
    conversationTablesAdded: false,
    existingTableCountsPreserved: false
  },
  renderer: {
    status: 'not_run',
    taskSnapshotListSucceeded: false,
    modelAttemptReconciliationListSucceeded: false,
    migrationRegressionAbsent: false
  },
  cleanup: { status: 'pending' },
  failure: null
}

mkdirSync(reportDir, { recursive: true })

try {
  requireCondition(process.platform === 'win32' && process.arch === 'x64', 'Windows x64 is required')
  requireCondition(existsSync(appExecutable), 'unpacked CaoGen executable is missing')
  requireCondition(existsSync(sourceDatabase), 'source task database is missing')
  requireCondition(existsSync(sourceMigrationRoot), 'source workflow migration evidence is missing')

  report.artifact.executableSha256 = sha256File(appExecutable)
  report.source.fingerprintBefore = fingerprintSource()

  mkdirSync(cloneUserData, { recursive: true })
  cpSync(sourceDatabase, cloneDatabase, { errorOnExist: true })
  cpSync(sourceMigrationRoot, cloneMigrationRoot, { recursive: true, errorOnExist: true })
  report.clone.sourceFilesCopied = 1 + listFiles(sourceMigrationRoot).length
  rebindMigrationJournalClone()
  report.clone.journalReboundForClone = true

  for (const privateFile of ['providers.json', 'provider-health.json', 'projects.json', 'project-workspace.json',
    'sessions.json', 'active-sessions.json', 'session-creation-journal.json', 'Local State']) {
    requireCondition(!existsSync(path.join(cloneUserData, privateFile)), `private file entered the clone: ${privateFile}`)
  }

  const preMigration = inspectDatabase(cloneDatabase)
  report.clone.preMigrationVersion = preMigration.userVersion
  requireCondition(preMigration.userVersion === 8, 'source clone is not the expected committed v8 state')
  requireCondition(conversationTables.some((table) => !preMigration.tables.has(table)),
    'source clone does not reproduce the additive Conversation Ledger gap')

  const renderer = await launchClone()
  Object.assign(report.renderer, renderer)

  const postMigration = inspectDatabase(cloneDatabase)
  report.clone.postMigrationVersion = postMigration.userVersion
  report.clone.conversationTablesAdded = conversationTables.every((table) => postMigration.tables.has(table))
  report.clone.existingTableCountsPreserved = [...preMigration.counts.entries()]
    .every(([table, count]) => postMigration.counts.get(table) === count)

  requireCondition(postMigration.userVersion === 9, 'clone did not reach workflow store version 9')
  requireCondition(report.clone.conversationTablesAdded, 'clone did not add all Conversation Ledger tables')
  requireCondition(report.clone.existingTableCountsPreserved, 'clone migration changed an existing table row count')
  requireCondition(report.renderer.taskSnapshotListSucceeded, 'task snapshot IPC did not recover')
  requireCondition(report.renderer.modelAttemptReconciliationListSucceeded,
    'model attempt reconciliation IPC did not recover')
  requireCondition(report.renderer.migrationRegressionAbsent,
    'the durable history regression remained visible after clone migration')

  report.source.fingerprintAfter = fingerprintSource()
  report.source.unchanged = report.source.fingerprintAfter === report.source.fingerprintBefore
  requireCondition(report.source.unchanged, 'source workflow files changed during the clone diagnostic')
  report.status = 'passed'
} catch (error) {
  report.failure = sanitizedError(error)
  process.exitCode = 1
} finally {
  try {
    const resolvedTemp = path.resolve(tempRoot)
    requireCondition(resolvedTemp.startsWith(path.resolve(tmpdir()) + path.sep), 'temporary clone escaped the OS temp root')
    rmSync(resolvedTemp, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 })
    report.cleanup.status = 'passed'
  } catch {
    report.cleanup.status = 'failed'
    report.status = 'failed'
    process.exitCode = 1
  }
  report.finishedAt = new Date().toISOString()
  writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(path.join(repoRoot, 'test-results', 'fix-000-real-data-clone-smoke', 'latest.json'),
    `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(report, null, 2))
}

async function launchClone() {
  const port = await availablePort()
  let browser
  let stderr = ''
  const child = spawn(appExecutable, [
    `--remote-debugging-port=${port}`,
    '--disable-gpu',
    '--enable-logging=stderr'
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAOGEN_USER_DATA_DIR: cloneUserData,
      CAOGEN_MEMORY_DIR: path.join(cloneUserData, 'memory'),
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      ELECTRON_ENABLE_LOGGING: '1'
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-64 * 1024) })

  try {
    await waitForDebugPort(child, port, 30_000)
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null })
    const page = await waitForRendererPage(browser, child, 30_000)
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0 &&
      typeof window.agentDesk === 'object', { timeout: 30_000 })

    const observation = await page.evaluate(async () => {
      const taskSnapshots = await window.agentDesk.listTaskSnapshots()
      const reconciliations = await window.agentDesk.listModelAttemptReconciliations()
      const visibleText = document.body.innerText
      return {
        status: 'passed',
        taskSnapshotListSucceeded: Array.isArray(taskSnapshots),
        modelAttemptReconciliationListSucceeded: Array.isArray(reconciliations),
        migrationRegressionAbsent: !visibleText.includes('Committed migration target durable history regressed') &&
          !visibleText.includes('WorkflowLedgerMigrationError')
      }
    })
    requireCondition(!/Committed migration target durable history regressed|WorkflowLedgerMigrationError/.test(stderr),
      'main process emitted the migration regression')
    return observation
  } finally {
    if (browser) await browser.disconnect().catch(() => undefined)
    stopChild(child)
  }
}

function inspectDatabase(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const userVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0)
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map((row) => String(row.name)))
    const counts = new Map()
    for (const table of preservedTables) {
      if (tables.has(table)) counts.set(table, Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count || 0))
    }
    return { userVersion, tables, counts }
  } finally {
    db.close()
  }
}

function fingerprintSource() {
  const entries = [sourceDatabase, ...listFiles(sourceMigrationRoot)]
    .map((file) => ({
      relative: path.relative(sourceUserData, file).replaceAll('\\', '/'),
      size: statSync(file).size,
      sha256: sha256File(file)
    }))
    .sort((left, right) => left.relative.localeCompare(right.relative, 'en'))
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

function rebindMigrationJournalClone() {
  const journalFiles = listFiles(cloneMigrationRoot).filter((file) => path.basename(file) === 'journal.json')
  requireCondition(journalFiles.length === 1, 'clone must contain exactly one migration journal')
  const oldJournalPath = journalFiles[0]
  const oldDirectory = path.dirname(oldJournalPath)
  const journal = JSON.parse(readFileSync(oldJournalPath, 'utf8'))
  requireCondition(journal?.state === 'committed' && journal?.toVersion === 8,
    'clone journal is not the expected committed v8 anchor')
  requireCondition(/^[a-f0-9]{8}$/.test(String(journal.migrationId || '').slice(-8)),
    'clone journal migration id has an invalid suffix')

  const suffix = String(journal.migrationId).slice(-8)
  const identity = `${cloneDatabase}\0${cloneDatabase}\0${journal.sourceKind}\0${journal.source.sha256}`
  const identityDigest = createHash('sha256').update(Buffer.from(identity)).digest('hex').slice(0, 20)
  const migrationId = `${journal.migrationKind}-v${journal.migrationVersion}-${identityDigest}-${suffix}`
  const directory = path.join(cloneMigrationRoot, migrationId)
  renameSync(oldDirectory, directory)

  journal.migrationId = migrationId
  journal.sourcePath = cloneDatabase
  journal.targetPath = cloneDatabase
  journal.source.path = cloneDatabase
  journal.backup.path = path.join(directory, `source-${path.basename(cloneDatabase)}`)
  if (journal.candidate) journal.candidate.path = path.join(directory, 'candidate.sqlite')
  if (journal.migrated) journal.migrated.path = cloneDatabase
  if (journal.readiness) {
    journal.readiness.sourcePath = cloneDatabase
    const { reportDigest: _reportDigest, ...withoutDigest } = journal.readiness
    journal.readiness.reportDigest = digest(withoutDigest)
  }
  writeFileSync(path.join(directory, 'journal.json'), `${canonicalJson(journal)}\n`, 'utf8')
}

function listFiles(root, prefix = '') {
  const result = []
  for (const entry of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name)
    if (entry.isDirectory()) result.push(...listFiles(root, relative))
    else if (entry.isFile()) result.push(path.join(root, relative))
  }
  return result
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function canonicalJson(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`
}

async function waitForDebugPort(child, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    requireCondition(child.exitCode === null && child.signalCode === null,
      'unpacked app exited before exposing DevTools')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1_000)
      })
      if (response.ok) return
    } catch {
      // Electron has not finished initializing yet.
    }
    await delay(200)
  }
  throw new Error('unpacked app did not expose DevTools before timeout')
}

async function waitForRendererPage(browser, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    requireCondition(child.exitCode === null && child.signalCode === null,
      'unpacked app exited before creating a renderer')
    const page = (await browser.pages()).find((candidate) => /out\/renderer\/index\.html$/.test(candidate.url()))
    if (page) return page
    await delay(200)
  }
  throw new Error('unpacked app did not create a renderer before timeout')
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
  requireCondition(port > 0, 'unable to reserve a local debugging port')
  return port
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  const prefix = `${name}=`
  const inline = process.argv.find((item) => item.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : undefined
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message)
}

function sanitizedError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replaceAll(sourceUserData, '<source-user-data>').replaceAll(tempRoot, '<temporary-clone>')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
