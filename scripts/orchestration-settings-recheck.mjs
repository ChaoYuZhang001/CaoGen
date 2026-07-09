import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const reportPath = path.join(repoRoot, 'test-results', 'orchestration-settings-recheck', 'latest.json')
const outMain = path.join(repoRoot, 'out', 'main', 'index.js')

const checks = [
  { name: 'drive_smoke', command: process.execPath, args: ['scripts/drive-smoke.mjs'], timeoutMs: 60_000 },
  { name: 'control_center_smoke', command: process.execPath, args: ['scripts/control-center-smoke.mjs'], timeoutMs: 60_000 },
  { name: 'orchestration_mock_e2e', command: process.execPath, args: ['scripts/orchestration-mock-e2e.mjs'], timeoutMs: 240_000 }
]

if (!existsSync(outMain)) {
  throw new Error('缺少 out/main/index.js;请先运行 npm run build')
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
console.log(`\norchestration-settings-recheck: ${results.filter((item) => item.ok).length}/${results.length} 通过`)
console.log(`orchestration settings report: ${reportPath}`)
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
