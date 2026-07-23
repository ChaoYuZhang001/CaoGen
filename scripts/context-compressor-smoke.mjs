import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(import.meta.dirname, '..')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` - ${detail}` : ''}`)
}

function loadTsModule(relativePath) {
  const filename = path.join(repoRoot, relativePath)
  const source = readFileSync(filename, 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: filename
  }).outputText
  const module = { exports: {} }
  const dirname = path.dirname(filename)
  const localRequire = (specifier) => {
    if (specifier.startsWith('.')) {
      const target = path.resolve(dirname, specifier)
      return loadTsModule(path.relative(repoRoot, `${target}.ts`))
    }
    return require(specifier)
  }
  new Function('exports', 'require', 'module', '__filename', '__dirname', compiled)(
    module.exports,
    localRequire,
    module,
    filename,
    dirname
  )
  return module.exports
}

const compressor = loadTsModule('src/main/agent/context-compressor.ts')
const toolOutput = loadTsModule('src/main/agent/tool-output.ts')
const view = loadTsModule('src/main/agent/tools/view.ts')

const chatViewSource = readFileSync(path.join(repoRoot, 'src/renderer/src/components/ChatView.tsx'), 'utf8')
const chatStatusBarSource = readFileSync(
  path.join(repoRoot, 'src/renderer/src/components/experience/ChatStatusBar.tsx'),
  'utf8'
)
const storeSource = readFileSync(path.join(repoRoot, 'src/renderer/src/store.ts'), 'utf8')
const agentSessionSource = readFileSync(path.join(repoRoot, 'src/main/agentSession.ts'), 'utf8')
check(
  'UI 状态栏显示 contextTokens',
  chatViewSource.includes('<ChatStatusBar') &&
    chatStatusBarSource.includes('meta.contextTokens') &&
    chatStatusBarSource.includes("t('statusContext')")
)

check(
  'UI timeline keeps context warning/compressed notices',
  storeSource.includes("ev.event !== 'context-warning'") &&
    storeSource.includes("ev.event !== 'context-compressed'") &&
    storeSource.includes('text: ev.detail ?? ev.event')
)

check(
  'Claude AgentSession records context pressure warnings',
  agentSessionSource.includes('evaluateContextUsage') &&
    agentSessionSource.includes("event: 'context-warning'") &&
    agentSessionSource.includes('contextRemainingTokens')
)

const warning = compressor.evaluateContextUsage({
  usedTokens: 48_000,
  model: 'mock-chat',
  contextWindowTokens: 60_000
})
check('80% 上下文进入 warning', warning.pressure === 'warning' && warning.shouldWarn && !warning.shouldCompress)

const critical = compressor.evaluateContextUsage({
  usedTokens: 54_000,
  model: 'mock-chat',
  contextWindowTokens: 60_000
})
check('90% 上下文进入自动压缩阈值', critical.pressure === 'critical' && critical.shouldCompress)

const boundary = compressor.planCompressionBoundary(
  [
    { role: 'user', content: 'old-a' },
    { role: 'assistant', content: 'old-b' },
    { role: 'user', content: 'recent-a' },
    { role: 'assistant', content: 'recent-b' }
  ],
  2
)
check('压缩切点落在 user 轮边界', boundary.canCompress && boundary.keepFrom === 2)

const fallbackBoundary = compressor.planCompressionBoundary(
  [
    { role: 'user', content: 'old-a' },
    { role: 'assistant', content: 'old-b' },
    { role: 'tool', content: 'tool-b' },
    { role: 'assistant', content: 'recent-b' }
  ],
  1
)
check('找不到后续 user 时回退到最近 user 边界', fallbackBoundary.canCompress === false && fallbackBoundary.keepFrom === 0)

const noUserBoundary = compressor.planCompressionBoundary(
  [
    { role: 'assistant', content: 'old-b' },
    { role: 'tool', content: 'tool-b' },
    { role: 'assistant', content: 'recent-b' }
  ],
  1
)
check('没有 user 边界时禁止压缩', noUserBoundary.canCompress === false && noUserBoundary.keepFrom === 0)

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-context-smoke-'))
try {
  const filePath = path.join(tempRoot, 'long.txt')
  writeFileSync(filePath, Array.from({ length: 250 }, (_, index) => `line-${index + 1}`).join('\n'), 'utf8')
  const viewed = await view.runView(tempRoot, { file_path: 'long.txt' })
  check('view 默认读取 200 行', viewed.ok && viewed.startLine === 1 && viewed.endLine === 200)
  check('view 分块提示下一段 start_line', viewed.ok && viewed.truncated && viewed.content.includes('start_line=201'))
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

const longOutput = Array.from({ length: 1205 }, (_, index) => `L${index + 1}`).join('\n')
const clipped = toolOutput.clipToolOutput(longOutput)
const clippedLines = clipped.split(/\r?\n/)
check('工具输出超过 1000 行首尾截断', clipped.includes('L1') && clipped.includes('L1205') && !clipped.includes('L650'))
check('工具输出截断保留约 1000 行', clippedLines.length === 1001)

const failed = results.filter((result) => !result.ok)
console.log(`\ncontext-compressor smoke: ${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) process.exit(1)
