#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const startedAt = new Date().toISOString()
const reportDir = path.join(repoRoot, 'test-results', 'ide-heavy-workflow')
const runId = startedAt.replace(/[:.]/g, '-')
const reportPath = path.join(reportDir, `${runId}.json`)
const commands = [
  ['indexer-large-repo', 'scripts/indexer-large-repo-smoke.mjs'],
  ['network-watcher', 'scripts/indexer-network-watcher-smoke.mjs'],
  ['file-editor', 'scripts/file-editor-tabs-e2e.mjs'],
  ['tests', 'scripts/project-test-panel-e2e.mjs'],
  ['debugger', 'scripts/project-debug-panel-e2e.mjs'],
  ['refactor', 'scripts/project-refactor-panel-e2e.mjs'],
  ['keyboard', 'scripts/workbench-keyboard-accessibility-e2e.mjs']
]
const report = {
  schemaVersion: 1,
  requirement: 'IDE-001/IDE-002 built-in heavy coding workflow',
  startedAt,
  gitCommit: gitCommit(),
  platform: process.platform,
  arch: process.arch,
  externalIdeBefore: externalIdeProcesses(),
  commands: []
}

try {
  for (const [name, script] of commands) {
    const started = Date.now()
    const result = runNodeScript(script)
    const durationMs = Date.now() - started
    const output = `${result.stdout}\n${result.stderr}`
    const entry = {
      name,
      script,
      status: result.status === 0 ? 'pass' : 'fail',
      exitCode: result.status,
      durationMs,
      outputTail: output.trim().split(/\r?\n/).slice(-12)
    }
    report.commands.push(entry)
    console.log(`[${entry.status.toUpperCase()}] ${name} (${durationMs}ms)`)
    if (result.status !== 0) throw new Error(`${name} failed with exit code ${result.status}`)
  }
  report.externalIdeAfter = externalIdeProcesses()
  const unexpected = report.externalIdeAfter.filter((item) => !report.externalIdeBefore.some((before) => before.pid === item.pid))
  report.externalIdeStarted = unexpected
  if (unexpected.length > 0) throw new Error(`external IDE process started during CaoGen gate: ${unexpected.map((item) => item.name).join(', ')}`)
  report.status = 'pass'
  report.completedAt = new Date().toISOString()
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`IDE heavy workflow required gate passed: ${reportPath}`)
} catch (error) {
  report.status = 'fail'
  report.error = error instanceof Error ? error.message : String(error)
  report.completedAt = new Date().toISOString()
  report.externalIdeAfter = externalIdeProcesses()
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.error(`IDE heavy workflow required gate failed: ${reportPath}`)
  console.error(report.error)
  process.exitCode = 1
}

function runNodeScript(script) {
  try {
    const stdout = execFileSync(process.execPath, [script], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 600_000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return {
      status: typeof error?.status === 'number' ? error.status : 1,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? error?.message ?? '')
    }
  }
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function externalIdeProcesses() {
  if (process.platform !== 'win32') return []
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-Process | Where-Object { $_.ProcessName -match '^(Code|code|idea|pycharm|webstorm|rider|clion|devenv)$' } | Select-Object Id,ProcessName | ConvertTo-Json -Compress"],
    { encoding: 'utf8', timeout: 10_000 }).trim()
    if (!output) return []
    const parsed = JSON.parse(output)
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows.map((row) => ({ pid: Number(row.Id), name: String(row.ProcessName) }))
  } catch {
    return []
  }
}
