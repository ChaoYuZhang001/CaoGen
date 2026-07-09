import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const reportPath = path.join(repoRoot, 'test-results', 'full-workflow-surface', 'latest.json')
const outMain = path.join(repoRoot, 'out', 'main', 'index.js')
const outRenderer = path.join(repoRoot, 'out', 'renderer', 'index.html')

const checks = [
  { name: 'office_status_recheck', command: process.execPath, args: ['scripts/office-status-recheck.mjs'], timeoutMs: 60_000 },
  { name: 'gui_tool_status_recheck', command: process.execPath, args: ['scripts/gui-tool-status-recheck.mjs'], timeoutMs: 90_000 },
  { name: 'page_operation_smoke', command: process.execPath, args: ['scripts/page-operation-smoke.mjs'], timeoutMs: 180_000 }
]

if (!existsSync(outMain) || !existsSync(outRenderer)) {
  throw new Error('缺少 out/main 或 out/renderer;请先运行 npm run build')
}

const results = checks.map(runCheck)
const ok = results.every((item) => item.ok)
mkdirSync(path.dirname(reportPath), { recursive: true })
writeFileSync(
  reportPath,
  JSON.stringify(
    {
      ok,
      generatedAt: new Date().toISOString(),
      pass: results.filter((item) => item.ok).length,
      total: results.length,
      results
    },
    null,
    2
  )
)
console.log(`\nfull-workflow-surface-runner: ${results.filter((item) => item.ok).length}/${results.length} 通过`)
console.log(`full workflow surface report: ${reportPath}`)
if (!ok) process.exitCode = 1

function runCheck(check) {
  console.log(`\n[RUN] ${check.name}: ${check.command} ${check.args.join(' ')}`)
  const startedAt = Date.now()
  const result = spawnSync(check.command, check.args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
    timeout: check.timeoutMs
  })
  return {
    name: check.name,
    ok: result.status === 0 && !result.error,
    status: result.status,
    signal: result.signal,
    durationMs: Date.now() - startedAt,
    error: result.error ? result.error.message : undefined
  }
}
