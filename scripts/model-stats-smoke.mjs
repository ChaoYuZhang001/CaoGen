/**
 * modelStats 冒烟:独立编译 + 临时目录验证记账/EMA/可靠性评分/持久化。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const buildDir = mkdtempSync(path.join(tmpdir(), 'caogen-modelstats-build-'))
execFileSync('npx', ['tsc', 'src/main/modelStats.ts', '--outDir', buildDir, '--target', 'ES2022', '--module', 'commonjs', '--esModuleInterop', '--skipLibCheck'], { cwd: repoRoot, stdio: 'inherit' })
const m = await import(path.join(buildDir, 'modelStats.js'))

function assert(c, msg) { if (!c) { console.error('ASSERT FAIL:', msg); process.exit(1) } }

const dataDir = mkdtempSync(path.join(tmpdir(), 'caogen-modelstats-data-'))
m.configureModelStatsDir(dataDir)

// 无样本:0.5
assert(m.reliabilityScore('unknown-model') === 0.5, 'no-sample → 0.5')

// 记 6 成功:可靠性→1
for (let i = 0; i < 6; i++) m.recordModelSuccess('good-model', 1000)
assert(m.reliabilityScore('good-model') === 1, `all-success → 1, got ${m.reliabilityScore('good-model')}`)
const good = m.getModelStat('good-model')
assert(good.successes === 6 && good.latencyEmaMs > 0, 'success + latency EMA recorded')

// 记 5 成功 5 失败:可靠性 0.5
for (let i = 0; i < 5; i++) { m.recordModelSuccess('mixed', 500); m.recordModelFailure('mixed') }
const mixed = m.reliabilityScore('mixed')
assert(Math.abs(mixed - 0.5) < 0.01, `5/5 → ~0.5, got ${mixed}`)

// 全失败模型:可靠性明显 < 好模型(路由降权依据)
for (let i = 0; i < 6; i++) m.recordModelFailure('bad-model')
assert(m.reliabilityScore('bad-model') < m.reliabilityScore('good-model'), 'bad < good')

// 持久化:落盘 + 重载缓存后仍在
assert(existsSync(path.join(dataDir, 'model-stats.json')), 'stats file persisted')
m._resetCacheForTest()
assert(m.getModelStat('good-model').successes === 6, 'reloaded from disk')

// EMA 平滑:新样本拉动但不突变
m.configureModelStatsDir(mkdtempSync(path.join(tmpdir(), 'caogen-ema-')))
m.recordModelSuccess('ema', 1000)
m.recordModelSuccess('ema', 2000)
const ema = m.getModelStat('ema').latencyEmaMs
assert(ema > 1000 && ema < 2000, `EMA between samples, got ${ema}`)

rmSync(dataDir, { recursive: true, force: true }); rmSync(buildDir, { recursive: true, force: true })
console.log('modelStats smoke ok')
