import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const reportPath = path.join(repoRoot, 'test-results', 'quickbar-attachment-recheck', 'latest.json')
const results = []

function check(name, fn) {
  try {
    const detail = fn()
    results.push({ name, ok: true, detail: detail || '' })
    console.log(`[PASS] ${name}${detail ? ` — ${String(detail).slice(0, 180)}` : ''}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    results.push({ name, ok: false, detail: message })
    console.log(`[FAIL] ${name} — ${message}`)
  }
}

function runNodeScript(script) {
  execFileSync(process.execPath, [path.join(repoRoot, script)], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env
  })
}

function source(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

check('quickbar smoke surface passes', () => {
  runNodeScript('scripts/quickbar-smoke.mjs')
})

check('attachment operations smoke passes', () => {
  runNodeScript('scripts/attachment-ops-smoke.mjs')
})

check('desktopCapturer NativeImage access is null-safe', () => {
  const text = source('src/main/gui/gui-controller.ts')
  for (const marker of [
    'function nativeImageIsEmpty',
    'nativeImageIsEmpty(source.appIcon)',
    'nativeImageIsEmpty(source.thumbnail)',
    'nativeImageIsEmpty(image)'
  ]) {
    if (!text.includes(marker)) throw new Error(`missing ${marker}`)
  }
})

check('browser capturePage empty check is null-safe', () => {
  const text = source('src/main/browserView.ts')
  if (!text.includes('if (!image || image.isEmpty()) return undefined')) {
    throw new Error('browser capturePage result must guard null before isEmpty()')
  }
})

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
console.log(`\nquickbar-attachment-recheck: ${results.filter((item) => item.ok).length}/${results.length} 通过`)
console.log(`quickbar attachment report: ${reportPath}`)
if (!ok) process.exitCode = 1
