import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const reportPath = path.join(repoRoot, 'test-results', 'terminal-packaged-recheck', 'latest.json')
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

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function source(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

check('AttachConsole node-pty diagnostic is classified as benign', () => {
  const terminal = source('src/main/terminal.ts')
  for (const marker of [
    'export function isBenignNodePtyDiagnostic',
    "normalized.includes('attachconsole')",
    "normalized.includes('access is denied')",
    "normalized.includes('failed')"
  ]) {
    assert(terminal.includes(marker), `missing ${marker}`)
  }
  assert(terminal.includes('if (!isBenignNodePtyDiagnostic(rawPtyError))'), 'real pty errors must remain visible')
  assert(terminal.includes('if (notifyPtyError && ptyError)'), 'benign diagnostics must not emit terminal error')
})

check('terminal started fallbackReason is not rendered as an error notice', () => {
  const store = source('src/renderer/src/store.ts')
  assert(store.includes('terminalError: undefined'), 'started event must clear terminalError')
  assert(!store.includes('terminalError: event.terminal.fallbackReason'), 'fallbackReason must not be treated as terminalError')
})

check('TerminalPanel keeps fallbackReason as informational notice', () => {
  const panel = source('src/renderer/src/components/workbench/TerminalPanel.tsx')
  assert(panel.includes('terminal?.fallbackReason'), 'fallbackReason info notice should remain visible')
  assert(panel.includes('notice notice-info terminal-notice'), 'fallbackReason should use info styling')
})

check('packaging config still unpacks node-pty native module', () => {
  const pkg = source('package.json')
  assert(pkg.includes('**/node_modules/node-pty/**'), 'node-pty must remain asarUnpack for packaged terminal')
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
console.log(`\nterminal-packaged-recheck: ${results.filter((item) => item.ok).length}/${results.length} 通过`)
console.log(`terminal packaged report: ${reportPath}`)
if (!ok) process.exitCode = 1
