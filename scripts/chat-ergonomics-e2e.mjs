#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')
if (!existsSync(mainEntry)) throw new Error('Built Electron main entry not found. Run npm run build first.')

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-chat-ergonomics-e2e-'))
const statePath = path.join(tempRoot, 'state.json')
const runner = path.join(repoRoot, 'scripts', 'chat-ergonomics-runner.cjs')
const electron = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'chat-ergonomics-e2e', runId)

try {
  mkdirSync(reportDir, { recursive: true })
  execFileSync(electron, [runner], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      CAOGEN_CHAT_ERGONOMICS_ROOT: tempRoot,
      CAOGEN_CHAT_ERGONOMICS_STATE: statePath,
      CAOGEN_CHAT_ERGONOMICS_SCREENSHOT_DIR: reportDir
    }
  })
  const report = JSON.parse(readFileSync(statePath, 'utf8'))
  if (!report.ok || report.pass !== report.total || report.total < 12) {
    throw new Error(`chat ergonomics E2E incomplete: ${JSON.stringify({ pass: report.pass, total: report.total })}`)
  }
  console.log(`chat ergonomics E2E ok: ${reportDir}`)
  console.log(`${report.pass}/${report.total} checks passed`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
