#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const userDataDir = process.env.CAOGEN_USER_DATA_DIR || 'C:/Users/zhang/AppData/Roaming/CaoGen'
const evidenceDir = path.resolve(process.env.CAOGEN_FIRST_TASK_EVIDENCE_DIR || 'test-results/fix-000-first-task')
const requestedId = process.env.CAOGEN_FIRST_TASK_SESSION_ID || ''
const report = {
  schemaVersion: 1,
  evidenceClass: 'fix_000_installed_first_task_reconciliation',
  status: 'failed',
  session: null,
  transcript: null,
  routing: null,
  git: null,
  credentialEnvelopeAllEncrypted: null,
  failure: null,
  privacy: 'No credential, Provider URL, project path, or task text is emitted.'
}

try {
  const sessionsFile = JSON.parse(readFileSync(path.join(userDataDir, 'sessions.json'), 'utf8'))
  const entries = Array.isArray(sessionsFile.entries) ? sessionsFile.entries : []
  const session = requestedId ? entries.find((item) => item.id === requestedId) : entries.find((item) => item.title === 'FIX-000 read-only first task')
  if (!session) throw new Error('diagnostic session record not found')
  const transcriptPath = path.join(userDataDir, 'transcripts', `${session.sdkSessionId}.jsonl`)
  if (!existsSync(transcriptPath)) throw new Error('diagnostic transcript is missing')
  const transcript = readFileSync(transcriptPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
  const events = transcript.map((entry) => entry.event).filter(Boolean)
  const toolStarts = events.filter((event) => event.kind === 'tool-start')
  const toolResults = events.filter((event) => event.kind === 'tool-result')
  const turnResults = events.filter((event) => event.kind === 'turn-result')
  const lastTurn = turnResults.at(-1)
  report.session = { status: sessionStatus(session), modelConcrete: session.model !== 'auto', providerIdPresent: Boolean(session.providerId), routingScope: session.routingScope, engine: session.engine }
  report.routing = { fixed: session.routingScope === 'fixed', concreteModel: session.model !== 'auto', engine: session.engine }
  report.transcript = {
    eventCount: events.length,
    toolNames: toolStarts.map((event) => event.name),
    toolResultCount: toolResults.length,
    toolErrors: toolResults.filter((event) => event.isError).length,
    turnResultCount: turnResults.length,
    lastTurnSubtype: lastTurn?.subtype,
    lastTurnIsError: lastTurn?.isError ?? null,
    finalStatusEvent: events.findLast((event) => event.kind === 'status')?.status
  }
  const providerRecords = JSON.parse(readFileSync(path.join(userDataDir, 'providers.json'), 'utf8'))
  const envelopes = providerRecords.flatMap((item) => [item.encryptedToken, ...(item.apiKeys || []).map((key) => key.encryptedToken)]).filter(Boolean)
  report.credentialEnvelopeAllEncrypted = envelopes.length > 0 && envelopes.every((value) => value.startsWith('enc:'))
  const source = session.sourceCwd || session.repoRoot
  const worktree = session.worktreePath || session.cwd
  const sourceStatus = gitStatus(source)
  const worktreeStatus = gitStatus(worktree)
  report.git = {
    source: sourceStatus,
    worktree: worktreeStatus,
    zeroMutation: sourceStatus.clean && worktreeStatus.userEntryCount === 0
  }
  if (report.session.status !== 'idle' || report.transcript.lastTurnIsError !== false || report.transcript.toolErrors !== 0 || !report.routing.fixed || !report.routing.concreteModel || !report.git.zeroMutation) {
    throw new Error('installed first-task reconciliation did not satisfy all gates')
  }
  report.status = 'passed'
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error)
}

mkdirSync(evidenceDir, { recursive: true })
writeFileSync(path.join(evidenceDir, 'fix-000-installed-first-task-reconciliation.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ status: report.status, session: report.session, routing: report.routing, transcript: report.transcript, git: report.git, credentialEnvelopeAllEncrypted: report.credentialEnvelopeAllEncrypted, failure: report.failure }, null, 2))
if (report.status !== 'passed') process.exitCode = 1

function sessionStatus(session) { return session.status || 'idle' }
function gitStatus(cwd) {
  try {
    const output = execFileSync('git', ['-c', `safe.directory=${cwd}`, '-C', cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const entries = output.split('\0').filter(Boolean)
    const metadataEntries = entries.filter((entry) => entry.slice(3).replaceAll('\\', '/').startsWith('.caogen/'))
    return {
      available: true,
      clean: entries.length === 0,
      entryCount: entries.length,
      metadataEntryCount: metadataEntries.length,
      userEntryCount: entries.length - metadataEntries.length
    }
  } catch {
    return { available: false, clean: false, entryCount: null, metadataEntryCount: null, userEntryCount: null }
  }
}
