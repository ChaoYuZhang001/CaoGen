import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const runnerRoot = mkdtempSync(path.join(tmpdir(), 'caogen-completion-gap-runner-'))
const resultsRoot = path.join(repoRoot, 'test-results', 'completion-gap')
mkdirSync(resultsRoot, { recursive: true })

const electron = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const script = path.join(repoRoot, 'scripts', 'completion-gap-electron.cjs')
const outMain = path.join(repoRoot, 'out', 'main', 'index.js')

if (!existsSync(outMain)) {
  throw new Error('缺少 out/main/index.js;请先运行 npm run build')
}

const phases = ['write', 'restore']
const phaseReports = []

try {
  for (const phase of phases) {
    execFileSync(electron, ['electron', script], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        CAOGEN_COMPLETION_GAP_ROOT: runnerRoot,
        CAOGEN_COMPLETION_GAP_PHASE: phase
      }
    })
    const reportPath = path.join(runnerRoot, 'reports', `${phase}.json`)
    phaseReports.push(JSON.parse(readFileSync(reportPath, 'utf8')))
  }

  const ok = phaseReports.every((report) => report.ok)
  const report = {
    ok,
    root: runnerRoot,
    generatedAt: new Date().toISOString(),
    phases: phaseReports
  }
  const latest = path.join(resultsRoot, 'latest.json')
  writeFileSync(latest, JSON.stringify(report, null, 2))
  console.log(`completion-gap-runner ${ok ? 'ok' : 'failed'}: ${latest}`)
  if (!ok) process.exit(1)
} catch (error) {
  const report = {
    ok: false,
    root: runnerRoot,
    generatedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
    phases: phaseReports
  }
  writeFileSync(path.join(resultsRoot, 'latest.json'), JSON.stringify(report, null, 2))
  throw error
} finally {
  if (process.env.CAOGEN_KEEP_COMPLETION_GAP_ROOT !== '1') {
    rmSync(runnerRoot, { recursive: true, force: true })
  }
}
